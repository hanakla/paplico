import type { StructuredView } from "webgpu-utils";
import type { Appearance, Filter } from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import { HK_BLUSH_STROKE_SHADER } from "./hk-blush-stroke.wgsl";

export interface HKBlushStrokeParams {
	angle: number;
	brushSize: number;
	strokeLength: number;
	strokeDensity: number;
	randomStrength: number;
	randomSeed: number;
	blendWithOriginal: number;
}
export interface HKBlushStrokeFilter extends Appearance<HKBlushStrokeParams> {
	processor: "hk:blush-stroke";
}

export class HKBlushStrokeHandler implements FilterHandler {
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
			label: "HK Blush Stroke Filter Shader",
			code: HK_BLUSH_STROKE_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "HK Blush Stroke Bind Group Layout",
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
			label: "HK Blush Stroke Filter Pipeline",
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
		const f = filter as HKBlushStrokeFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("HKBlushStrokeHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		this.uniformView.set({
			resolution: [textureSize.width, textureSize.height],
			dpiScale,
			angle: params.angle,
			brushSize: params.brushSize,
			strokeLength: params.strokeLength,
			strokeDensity: params.strokeDensity,
			randomStrength: params.randomStrength,
			randomSeed: params.randomSeed,
			blendWithOriginal: params.blendWithOriginal,
		});

		const uniformBuffer = device.createBuffer({
			label: "HK Blush Stroke Uniform Buffer",
			size: this.uniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(uniformBuffer, 0, this.uniformView.arrayBuffer);

		const sampler = device.createSampler({
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});

		const bindGroup = device.createBindGroup({
			label: "HK Blush Stroke Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "HK Blush Stroke Filter Pass",
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
		const f = filter as HKBlushStrokeFilter;
		return (f.paramData.params.strokeLength ?? 0) / 3;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as HKBlushStrokeFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					brushSize: f.paramData.params.brushSize * uniformScale,
					strokeLength: f.paramData.params.strokeLength * uniformScale,
					strokeDensity: f.paramData.params.strokeDensity * uniformScale,
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKBlushStrokeFilter["paramData"]["params"];
		const b = paramsB as HKBlushStrokeFilter["paramData"]["params"];
		return {
			angle: a.angle + (b.angle - a.angle) * t,
			brushSize: a.brushSize + (b.brushSize - a.brushSize) * t,
			strokeLength: a.strokeLength + (b.strokeLength - a.strokeLength) * t,
			randomStrength:
				a.randomStrength + (b.randomStrength - a.randomStrength) * t,
			randomSeed: Math.round(a.randomSeed + (b.randomSeed - a.randomSeed) * t),
			strokeDensity: a.strokeDensity + (b.strokeDensity - a.strokeDensity) * t,
			blendWithOriginal:
				a.blendWithOriginal + (b.blendWithOriginal - a.blendWithOriginal) * t,
		};
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}
