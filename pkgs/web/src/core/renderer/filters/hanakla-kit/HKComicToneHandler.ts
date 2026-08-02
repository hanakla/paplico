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
import { HK_COMIC_TONE_SHADER } from "./hk-comic-tone.wgsl";

export interface HKComicToneParams {
	toneType: "dot" | "line" | "crosshatch";
	colorMode: "original" | "monochrome";
	size: number;
	spacing: number;
	angle: number;
	threshold: number;
	reversePattern: boolean;
	showOriginalUnderDots: boolean;
	useLuminance: boolean;
	luminanceStrength: number;
	invertDotSize: boolean;
	toneColor: Color;
}
export interface HKComicToneFilter extends Appearance<HKComicToneParams> {
	processor: "hk:comic-tone";
}

export class HKComicToneHandler implements FilterHandler {
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
			label: "HK Comic Tone Filter Shader",
			code: HK_COMIC_TONE_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "HK Comic Tone Bind Group Layout",
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
			label: "HK Comic Tone Filter Pipeline",
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
		const f = filter as HKComicToneFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("HKComicToneHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		const toneTypeMap: Record<string, number> = {
			dot: 0,
			line: 1,
			crosshatch: 2,
		};
		const colorModeMap: Record<string, number> = {
			original: 0,
			monochrome: 1,
		};

		const toneRGBA = colorToRawRGBA(params.toneColor);

		// The bake may cover only a viewport-clamped sub-rect of the element;
		// anchor the tone patterns to the full element rect (see
		// comicToneWorldPos) so their phase stays fixed while zooming or panning.
		const contentOffset = context.sourceContentOffset ?? { x: 0, y: 0 };
		const worldOrigin = context.coordinateSpace?.sourceOffset ?? { x: 0, y: 0 };

		this.uniformView.set({
			resolution: [textureSize.width, textureSize.height],
			contentOffset: [contentOffset.x, contentOffset.y],
			worldOrigin: [worldOrigin.x, worldOrigin.y],
			dpiScale,
			toneType: toneTypeMap[params.toneType] ?? 0,
			colorMode: colorModeMap[params.colorMode] ?? 0,
			size: params.size,
			spacing: params.spacing,
			angle: params.angle,
			threshold: params.threshold,
			reversePattern: params.reversePattern ? 1.0 : 0.0,
			showOriginalUnderDots: params.showOriginalUnderDots ? 1.0 : 0.0,
			useLuminance: params.useLuminance ? 1.0 : 0.0,
			luminanceStrength: params.luminanceStrength,
			invertDotSize: params.invertDotSize ? 1.0 : 0.0,
			toneColorR: toneRGBA.r,
			toneColorG: toneRGBA.g,
			toneColorB: toneRGBA.b,
			toneColorA: toneRGBA.a,
		});

		const uniformBuffer = device.createBuffer({
			label: "HK Comic Tone Uniform Buffer",
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
			label: "HK Comic Tone Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "HK Comic Tone Filter Pass",
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

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as HKComicToneFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					size: f.paramData.params.size * uniformScale,
					spacing: f.paramData.params.spacing * uniformScale,
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKComicToneParams;
		const b = paramsB as HKComicToneParams;

		const aTone = colorToRawRGBA(a.toneColor);
		const bTone = colorToRawRGBA(b.toneColor);

		return {
			toneType: t < 0.5 ? a.toneType : b.toneType,
			colorMode: t < 0.5 ? a.colorMode : b.colorMode,
			size: a.size + (b.size - a.size) * t,
			spacing: a.spacing + (b.spacing - a.spacing) * t,
			angle: a.angle + (b.angle - a.angle) * t,
			threshold: a.threshold + (b.threshold - a.threshold) * t,
			reversePattern: t < 0.5 ? a.reversePattern : b.reversePattern,
			showOriginalUnderDots:
				t < 0.5 ? a.showOriginalUnderDots : b.showOriginalUnderDots,
			useLuminance: t < 0.5 ? a.useLuminance : b.useLuminance,
			luminanceStrength:
				a.luminanceStrength + (b.luminanceStrength - a.luminanceStrength) * t,
			invertDotSize: t < 0.5 ? a.invertDotSize : b.invertDotSize,
			toneColor: toRGBColor({
				r: aTone.r + (bTone.r - aTone.r) * t,
				g: aTone.g + (bTone.g - aTone.g) * t,
				b: aTone.b + (bTone.b - aTone.b) * t,
				a: aTone.a + (bTone.a - aTone.a) * t,
			}),
		};
	}

	public onAdjustColor(
		params: unknown,
		adjustColor: (color: Color) => Color,
	): unknown {
		const p = params as HKComicToneFilter["paramData"]["params"];
		return { ...p, toneColor: adjustColor(p.toneColor) };
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}
