import type { StructuredView } from "webgpu-utils";
import type { Appearance, Filter } from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import { HK_SPRAYING_SHADER } from "./hk-spraying.wgsl";

export interface HKSprayingParams {
	strength: number;
	seed: number;
	blockSize: number;
}
export interface HKSprayingFilter extends Appearance<HKSprayingParams> {
	processor: "hk:spraying";
}

export class HKSprayingHandler implements FilterHandler {
	private pipeline: GPURenderPipeline | null = null;
	private bindGroupLayout: GPUBindGroupLayout | null = null;
	private uniformView: StructuredView | null = null;
	private canvasFormat: GPUTextureFormat = "rgba8unorm";

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.canvasFormat = canvasFormat;
		const { module, uniformViews } = compileShaderModule(device, {
			label: "HK Spraying Filter Shader",
			code: HK_SPRAYING_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "HK Spraying Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float" },
				},
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "filtering" },
				},
			],
		});

		this.pipeline = device.createRenderPipeline({
			label: "HK Spraying Filter Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.bindGroupLayout],
			}),
			vertex: { module, entryPoint: "vertexMain" },
			fragment: {
				module,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const f = filter as HKSprayingFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("HKSprayingHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		this.uniformView.set({
			resolution: [textureSize.width, textureSize.height],
			dpiScale,
			strength: params.strength,
			seed: params.seed,
			blockSize: params.blockSize,
		});

		const uniformBuffer = device.createBuffer({
			label: "HK Spraying Uniform Buffer",
			size: this.uniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(uniformBuffer, 0, this.uniformView.arrayBuffer);

		const sampler = device.createSampler({
			magFilter: "nearest",
			minFilter: "nearest",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});

		const bindGroup = device.createBindGroup({
			label: "HK Spraying Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "HK Spraying Filter Pass",
			colorAttachments: [
				{
					view: targetTexture.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
		});

		pass.setPipeline(this.pipeline);
		pass.setBindGroup(0, bindGroup);
		pass.draw(3, 1, 0, 0);
		pass.end();
	}

	public getExpansionMargin(filter: Filter): number {
		const f = filter as HKSprayingFilter;
		// The shader sums the block offset (max strength) and the per-pixel
		// offset (max strength * 0.3), so scatter reaches 1.3 * strength.
		return f.paramData.params.strength * 1.3;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as HKSprayingFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					strength: f.paramData.params.strength * uniformScale,
					blockSize: f.paramData.params.blockSize * uniformScale,
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKSprayingFilter["paramData"]["params"];
		const b = paramsB as HKSprayingFilter["paramData"]["params"];
		return {
			strength: a.strength + (b.strength - a.strength) * t,
			seed: Math.round(a.seed + (b.seed - a.seed) * t),
			blockSize: a.blockSize + (b.blockSize - a.blockSize) * t,
		};
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}
