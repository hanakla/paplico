import type { StructuredView } from "webgpu-utils";
import type { Appearance, Filter } from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import { HK_SELECTIVE_CORRECTION_SHADER } from "./hk-selective-correction.wgsl";

export interface HKSelectiveCorrectionParams {
	blendMode: "normal" | "multiply";
	mix: number;
	featherEdges: number;
	previewMask: boolean;
	useCondition: boolean;
	targetHue: number;
	hueRange: number;
	saturationMin: number;
	saturationMax: number;
	brightnessMin: number;
	brightnessMax: number;
	hueShift: number;
	saturationScale: number;
	vibrance: number;
	brightnessScale: number;
	contrast: number;
}
export interface HKSelectiveCorrectionFilter
	extends Appearance<HKSelectiveCorrectionParams> {
	processor: "hk:selective-correction";
}

// Default condition values when useCondition is false (match all pixels)
const DEFAULT_CONDITION = {
	targetHue: 0.0,
	hueRange: 180.0,
	saturationMin: 0.0,
	saturationMax: 1.0,
	brightnessMin: 0.0,
	brightnessMax: 1.0,
};

export class HKSelectiveCorrectionHandler implements FilterHandler {
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
			label: "HK Selective Correction Filter Shader",
			code: HK_SELECTIVE_CORRECTION_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "HK Selective Correction Bind Group Layout",
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
			label: "HK Selective Correction Filter Pipeline",
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
		const f = filter as HKSelectiveCorrectionFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("HKSelectiveCorrectionHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		const blendModeInt = params.blendMode === "multiply" ? 1 : 0;

		// When useCondition is false, use default condition values that match all pixels
		const condition = params.useCondition ? params : DEFAULT_CONDITION;

		this.uniformView.set({
			resolution: [textureSize.width, textureSize.height],
			dpiScale,
			blendMode: blendModeInt,
			featherEdges: params.featherEdges,
			previewMask: params.previewMask ? 1 : 0,
			mix_amount: params.mix,
			useCondition: params.useCondition ? 1 : 0,
			targetHue: condition.targetHue,
			hueRange: condition.hueRange,
			saturationMin: condition.saturationMin,
			saturationMax: condition.saturationMax,
			brightnessMin: condition.brightnessMin,
			brightnessMax: condition.brightnessMax,
			hueShift: params.hueShift,
			// Scales are stored with neutral at 1.0, matching the shader
			saturationScale: params.saturationScale,
			// Documents saved before vibrance existed lack the key
			vibrance: params.vibrance ?? 0,
			brightnessScale: params.brightnessScale,
			// Contrast is stored as -1..1 (neutral 0); shader neutral is 1.0
			contrast: params.contrast + 1.0,
		});

		const uniformBuffer = device.createBuffer({
			label: "HK Selective Correction Uniform Buffer",
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
			label: "HK Selective Correction Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "HK Selective Correction Filter Pass",
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

	public getExpansionMargin(_filter: Filter): number {
		return 0;
	}

	public onScaleFilter(params: Filter, _scale: [number, number]): Filter {
		return params;
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKSelectiveCorrectionFilter["paramData"]["params"];
		const b = paramsB as HKSelectiveCorrectionFilter["paramData"]["params"];

		return {
			blendMode: t < 0.5 ? a.blendMode : b.blendMode,
			previewMask: t < 0.5 ? a.previewMask : b.previewMask,
			useCondition: t < 0.5 ? a.useCondition : b.useCondition,
			mix: a.mix + (b.mix - a.mix) * t,
			featherEdges: a.featherEdges + (b.featherEdges - a.featherEdges) * t,
			targetHue: a.targetHue + (b.targetHue - a.targetHue) * t,
			hueRange: a.hueRange + (b.hueRange - a.hueRange) * t,
			saturationMin: a.saturationMin + (b.saturationMin - a.saturationMin) * t,
			saturationMax: a.saturationMax + (b.saturationMax - a.saturationMax) * t,
			brightnessMin: a.brightnessMin + (b.brightnessMin - a.brightnessMin) * t,
			brightnessMax: a.brightnessMax + (b.brightnessMax - a.brightnessMax) * t,
			hueShift: a.hueShift + (b.hueShift - a.hueShift) * t,
			saturationScale:
				a.saturationScale + (b.saturationScale - a.saturationScale) * t,
			vibrance: (a.vibrance ?? 0) + ((b.vibrance ?? 0) - (a.vibrance ?? 0)) * t,
			brightnessScale:
				a.brightnessScale + (b.brightnessScale - a.brightnessScale) * t,
			contrast: a.contrast + (b.contrast - a.contrast) * t,
		};
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}
