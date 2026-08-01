import type { StructuredView } from "webgpu-utils";
import {
	type Appearance,
	type Color,
	colorToRawRGBA,
	type Filter,
	toRGBColor,
} from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import { HK_COLOR_REPLACEMENT_SHADER } from "./hk-color-replacement.wgsl";

export interface HKColorReplacementParams {
	sourceColor: Color;
	replacementColor: Color;
	/** OKLab distance from sourceColor where the match ends (0..1) */
	tolerance: number;
	preserveLuminance: boolean;
	mix: number;
	featherEdges: number;
	previewMask: boolean;
}
export interface HKColorReplacementFilter
	extends Appearance<HKColorReplacementParams> {
	processor: "hk:color-replacement";
}

export class HKColorReplacementHandler implements FilterHandler {
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
			label: "HK Color Replacement Filter Shader",
			code: HK_COLOR_REPLACEMENT_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "HK Color Replacement Bind Group Layout",
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
			label: "HK Color Replacement Filter Pipeline",
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
		const f = filter as HKColorReplacementFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("HKColorReplacementHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		const srcRGBA = colorToRawRGBA(params.sourceColor);
		const repRGBA = colorToRawRGBA(params.replacementColor);

		this.uniformView.set({
			resolution: [textureSize.width, textureSize.height],
			dpiScale,
			preserveLuminance: params.preserveLuminance ? 1 : 0,
			sourceR: srcRGBA.r,
			sourceG: srcRGBA.g,
			sourceB: srcRGBA.b,
			sourceA: srcRGBA.a,
			replacementR: repRGBA.r,
			replacementG: repRGBA.g,
			replacementB: repRGBA.b,
			replacementA: repRGBA.a,
			featherEdges: params.featherEdges,
			previewMask: params.previewMask ? 1 : 0,
			mix_amount: params.mix,
			// Documents saved by the old hue-window version lack the key
			tolerance: params.tolerance ?? 0.45,
		});

		const uniformBuffer = device.createBuffer({
			label: "HK Color Replacement Uniform Buffer",
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
			label: "HK Color Replacement Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "HK Color Replacement Filter Pass",
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
		const a = paramsA as HKColorReplacementParams;
		const b = paramsB as HKColorReplacementParams;

		const aSrc = colorToRawRGBA(a.sourceColor);
		const bSrc = colorToRawRGBA(b.sourceColor);
		const aRep = colorToRawRGBA(a.replacementColor);
		const bRep = colorToRawRGBA(b.replacementColor);

		return {
			sourceColor: toRGBColor({
				r: aSrc.r + (bSrc.r - aSrc.r) * t,
				g: aSrc.g + (bSrc.g - aSrc.g) * t,
				b: aSrc.b + (bSrc.b - aSrc.b) * t,
				a: aSrc.a + (bSrc.a - aSrc.a) * t,
			}),
			replacementColor: toRGBColor({
				r: aRep.r + (bRep.r - aRep.r) * t,
				g: aRep.g + (bRep.g - aRep.g) * t,
				b: aRep.b + (bRep.b - aRep.b) * t,
				a: aRep.a + (bRep.a - aRep.a) * t,
			}),
			preserveLuminance: t < 0.5 ? a.preserveLuminance : b.preserveLuminance,
			previewMask: t < 0.5 ? a.previewMask : b.previewMask,
			mix: a.mix + (b.mix - a.mix) * t,
			featherEdges: a.featherEdges + (b.featherEdges - a.featherEdges) * t,
			tolerance:
				(a.tolerance ?? 0.45) +
				((b.tolerance ?? 0.45) - (a.tolerance ?? 0.45)) * t,
		};
	}

	public onAdjustColor(
		params: unknown,
		adjustColor: (color: Color) => Color,
	): unknown {
		const p = params as HKColorReplacementFilter["paramData"]["params"];
		return {
			...p,
			sourceColor: adjustColor(p.sourceColor),
			replacementColor: adjustColor(p.replacementColor),
		};
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}
