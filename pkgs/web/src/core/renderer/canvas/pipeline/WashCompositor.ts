import type { WetEdgeConfig } from "../../../schema";
import { BlurPyramidBuilder } from "./BlurPyramid";
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
	private rimPipeline: GPURenderPipeline | null = null;
	private composePipeline: GPURenderPipeline | null = null;
	private blurBuilder: BlurPyramidBuilder | null = null;
	/** Textures acquired for the current applyWetEdge call. */
	private scratchOut: GPUTexture[] = [];
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
		const rim = this.texturePool.acquireExact(
			width,
			height,
			"r8unorm",
			1,
			usage,
			"Wash Wet Edge Rim",
		);
		const composed = this.texturePool.acquireExact(
			width,
			height,
			this.canvasFormat,
			1,
			usage | GPUTextureUsage.COPY_SRC,
			"Wash Wet Edge Composed",
		);
		this.scratchOut = [erodedX, eroded, rim, composed];

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
			this.rimPipeline!,
			rim.createView(),
			sourceView,
			eroded.createView(),
			[0, 0, 0, 0, 0, 0],
		);

		const blurredRim = this.blurRim(encoder, rim, wetEdge, worldPerPixel);
		this.runPass(
			encoder,
			this.composePipeline!,
			composed.createView(),
			sourceView,
			blurredRim.createView(),
			[0, 0, 0, wetEdge.intensity, wetEdge.darkening, 0],
		);
		encoder.copyTextureToTexture(
			{ texture: composed },
			{ texture },
			{ width, height },
		);
		const out = this.scratchOut;
		this.scratchOut = [];
		return out;
	}

	/** Soften the rim band (§9): repeated separable gaussian passes whose
	 *  count approximates the config's world-space blur width. */
	private blurRim(
		encoder: GPUCommandEncoder,
		rim: GPUTexture,
		wetEdge: WetEdgeConfig,
		worldPerPixel: number,
	): GPUTexture {
		const blurPx = Math.min(
			wetEdge.blur / Math.max(worldPerPixel, 1e-6),
			32,
		);
		if (blurPx < 1) return rim;

		this.blurBuilder ??= new BlurPyramidBuilder(
			this.device,
			(width, height, format) => {
				const t = this.texturePool.acquireExact(
					width,
					height,
					format,
					1,
					GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
					"Wash Wet Edge Blur",
				);
				this.scratchOut.push(t);
				return t;
			},
		);
		// Each X+Y pair applies sigma 2 per axis and pairs accumulate as
		// sqrt(n); map the world blur width to roughly 2*sigma reach.
		const pairs = Math.min(
			8,
			Math.max(1, Math.round((blurPx * blurPx) / 16)),
		);
		let current = rim;
		for (let i = 0; i < pairs; i++) {
			const tempX = this.texturePool.acquireExact(
				rim.width,
				rim.height,
				"r8unorm",
				1,
				GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
				"Wash Wet Edge Blur X",
			);
			const tempY = this.texturePool.acquireExact(
				rim.width,
				rim.height,
				"r8unorm",
				1,
				GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
				"Wash Wet Edge Blur Y",
			);
			this.scratchOut.push(tempX, tempY);
			this.blurBuilder.encodeLevelPass(
				encoder,
				current,
				rim.width,
				rim.height,
				tempX,
				rim.width,
				rim.height,
				[1, 0],
			);
			this.blurBuilder.encodeLevelPass(
				encoder,
				tempX,
				rim.width,
				rim.height,
				tempY,
				rim.width,
				rim.height,
				[0, 1],
			);
			current = tempY;
		}
		return current;
	}

	public destroy(): void {
		this.blurBuilder?.destroy();
		this.blurBuilder = null;
		this.erodePipeline = null;
		this.rimPipeline = null;
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
		if (
			this.erodePipeline &&
			this.rimPipeline &&
			this.composePipeline &&
			this.sampler
		) {
			return;
		}
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
		this.rimPipeline = this.device.createRenderPipeline({
			label: "Wash Wet Edge Rim",
			layout,
			vertex: { module, entryPoint: "vs_main" },
			fragment: {
				module,
				entryPoint: "fs_rim",
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
