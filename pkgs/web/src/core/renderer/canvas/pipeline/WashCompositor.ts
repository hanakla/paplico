import type { WetEdgeConfig } from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import { WET_EDGE_SHADER } from "../../shaders/wetEdge.wgsl";
import type { TexturePool } from "./TexturePool";

/** Erosion tap cap — must match MAX_EROSION_TAPS in wetEdge.wgsl. */
const MAX_EROSION_RADIUS_PX = 48;
const UNIFORM_FLOATS = 8;

/**
 * Watercolor wet-edge post pass for wash strokes (design §9): erode the
 * coverage alpha of the isolated appearance texture (separable min filter),
 * treat `alpha - eroded` as the rim band, and darken/intensify it in place.
 * Wet-edge and the wet layer are exclusive (§H-4); callers gate on that.
 */
export class WashCompositor {
	private erodePipeline: GPURenderPipeline | null = null;
	private composePipeline: GPURenderPipeline | null = null;
	private sampler: GPUSampler | null = null;
	private bindGroupLayout: GPUBindGroupLayout | null = null;

	public constructor(
		private readonly device: GPUDevice,
		private readonly texturePool: TexturePool,
		private readonly canvasFormat: GPUTextureFormat,
	) {}

	/**
	 * Apply the wet edge to `texture` in place. `worldPerPixel` converts the
	 * config's world-space rim width into texels; `brushSize` caps it (§9).
	 * Returns the scratch textures for the caller to release after submit.
	 */
	public applyWetEdge(
		encoder: GPUCommandEncoder,
		texture: GPUTexture,
		wetEdge: WetEdgeConfig,
		worldPerPixel: number,
		brushSize: number,
	): GPUTexture[] {
		const radiusWorld = Math.min(Math.max(wetEdge.width, 0), brushSize);
		const radiusPx = Math.min(
			Math.round(radiusWorld / Math.max(worldPerPixel, 1e-6)),
			MAX_EROSION_RADIUS_PX,
		);
		if (radiusPx < 1) return [];

		this.ensurePipelines();
		const width = texture.width;
		const height = texture.height;
		const usage =
			GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
		const erodedX = this.texturePool.acquireExact(
			width,
			height,
			"r8unorm",
			1,
			usage,
			"Wash Wet Edge Erode X",
		);
		const eroded = this.texturePool.acquireExact(
			width,
			height,
			"r8unorm",
			1,
			usage,
			"Wash Wet Edge Eroded",
		);
		const composed = this.texturePool.acquireExact(
			width,
			height,
			this.canvasFormat,
			1,
			usage | GPUTextureUsage.COPY_SRC,
			"Wash Wet Edge Composed",
		);

		const sourceView = texture.createView();
		this.runPass(
			encoder,
			this.erodePipeline!,
			erodedX.createView(),
			sourceView,
			sourceView,
			[1 / width, 0, radiusPx, 0, 0, 0],
		);
		this.runPass(
			encoder,
			this.erodePipeline!,
			eroded.createView(),
			erodedX.createView(),
			erodedX.createView(),
			// The intermediate is r8unorm: coverage lives in red, not alpha.
			[0, 1 / height, radiusPx, 0, 0, 1],
		);
		this.runPass(
			encoder,
			this.composePipeline!,
			composed.createView(),
			sourceView,
			eroded.createView(),
			[0, 0, 0, wetEdge.intensity, wetEdge.darkening, 0],
		);
		encoder.copyTextureToTexture(
			{ texture: composed },
			{ texture },
			{ width, height },
		);
		return [erodedX, eroded, composed];
	}

	public destroy(): void {
		this.erodePipeline = null;
		this.composePipeline = null;
		this.sampler = null;
	}

	private runPass(
		encoder: GPUCommandEncoder,
		pipeline: GPURenderPipeline,
		target: GPUTextureView,
		source: GPUTextureView,
		eroded: GPUTextureView,
		params: [number, number, number, number, number, number],
	): void {
		const uniform = this.device.createBuffer({
			label: "Wash Wet Edge Uniforms",
			size: UNIFORM_FLOATS * 4,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		const data = new Float32Array(UNIFORM_FLOATS);
		data.set(params, 0);
		this.device.queue.writeBuffer(uniform, 0, data);

		const pass = encoder.beginRenderPass({
			label: "Wash Wet Edge Pass",
			colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store" }],
		});
		pass.setPipeline(pipeline);
		pass.setBindGroup(
			0,
			this.device.createBindGroup({
				layout: this.bindGroupLayout!,
				entries: [
					{ binding: 0, resource: source },
					{ binding: 1, resource: this.sampler! },
					{ binding: 2, resource: { buffer: uniform } },
					{ binding: 3, resource: eroded },
				],
			}),
		);
		pass.draw(3);
		pass.end();
	}

	private ensurePipelines(): void {
		if (this.erodePipeline && this.composePipeline && this.sampler) return;
		const { module } = compileShaderModule(this.device, {
			label: "Wash Wet Edge Shader",
			code: WET_EDGE_SHADER,
		});
		// Explicit layout: an "auto" layout would drop binding 3 for fs_erode
		// (which never reads the eroded texture) and reject the shared group.
		this.bindGroupLayout = this.device.createBindGroupLayout({
			label: "Wash Wet Edge Bind Group Layout",
			entries: [
				{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
				{ binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
				{ binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
				{ binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
			],
		});
		const layout = this.device.createPipelineLayout({
			label: "Wash Wet Edge Pipeline Layout",
			bindGroupLayouts: [this.bindGroupLayout],
		});
		this.sampler = this.device.createSampler({
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});
		this.erodePipeline = this.device.createRenderPipeline({
			label: "Wash Wet Edge Erode",
			layout,
			vertex: { module, entryPoint: "vs_main" },
			fragment: {
				module,
				entryPoint: "fs_erode",
				targets: [{ format: "r8unorm" }],
			},
			primitive: { topology: "triangle-list" },
		});
		this.composePipeline = this.device.createRenderPipeline({
			label: "Wash Wet Edge Compose",
			layout,
			vertex: { module, entryPoint: "vs_main" },
			fragment: {
				module,
				entryPoint: "fs_compose",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});
	}
}
