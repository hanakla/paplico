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
import { HK_VHS_INTERLACE_SHADER } from "./hk-vhs-interlace.wgsl";

export interface HKVhsInterlaceParams {
	intensity: number;
	/** Dub generation (1-5); >1 piles baseline degradation on the signal */
	generation: number;
	// Signal
	chromaBleed: number;
	colorShift: number;
	lumaSoftness: number;
	ringing: number;
	// Transport
	lineJitter: number;
	verticalJitter: number;
	trackingError: number;
	headSwitching: number;
	headSwitchingHeight: number;
	// Tape wear
	noise: number;
	noiseDistortion: number;
	chromaNoise: number;
	dropouts: number;
	dropoutLength: number;
	brightnessJitter: number;
	// Display
	scanlines: number;
	interlaceGap: number;
	combing: number;
	tilt: number;
	blackLift: number;
	desaturation: number;
	randomSeed: number;
	enableVHSColor: boolean;
	vhsColor: Color;
	applyToTransparent: boolean;
}
export interface HKVhsInterlaceFilter extends Appearance<HKVhsInterlaceParams> {
	processor: "hk:vhs-interlace";
}

export class HKVhsInterlaceHandler implements FilterHandler {
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
			label: "HK VHS Interlace Filter Shader",
			code: HK_VHS_INTERLACE_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "HK VHS Interlace Bind Group Layout",
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
			label: "HK VHS Interlace Filter Pipeline",
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
		const f = filter as HKVhsInterlaceFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
			sourceWorldSize,
			coordinateSpace,
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("HKVhsInterlaceHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		// Anchor every pattern in world px. The provided world size is exact;
		// the texel-derived fallback inherits the texture's ceil/pool
		// quantization.
		const sourceWidth = sourceWorldSize?.width ?? textureSize.width / dpiScale;
		const sourceHeight =
			sourceWorldSize?.height ?? textureSize.height / dpiScale;
		const worldWidth = coordinateSpace?.worldSize.width ?? sourceWidth;
		const worldHeight = coordinateSpace?.worldSize.height ?? sourceHeight;

		const vhsRGBA = colorToRawRGBA(params.vhsColor);

		// New params fall back to neutral values for documents saved before
		// the parameter rework.
		this.uniformView.set({
			worldSize: [worldWidth, worldHeight],
			sourceWorldSize: [sourceWidth, sourceHeight],
			sourceOffset: [
				coordinateSpace?.sourceOffset.x ?? 0,
				coordinateSpace?.sourceOffset.y ?? 0,
			],
			intensity: params.intensity,
			generation: params.generation ?? 1,
			chromaBleed: params.chromaBleed ?? 0,
			colorShift: params.colorShift,
			lumaSoftness: params.lumaSoftness ?? 0,
			ringing: params.ringing ?? 0,
			lineJitter: params.lineJitter ?? 0,
			verticalJitter: params.verticalJitter,
			trackingError: params.trackingError,
			headSwitching: params.headSwitching ?? 0,
			headSwitchingHeight: params.headSwitchingHeight ?? 8,
			noise: params.noise,
			noiseDistortion: params.noiseDistortion,
			chromaNoise: params.chromaNoise ?? 0,
			dropouts: params.dropouts ?? 0,
			dropoutLength: params.dropoutLength ?? 0.25,
			brightnessJitter: params.brightnessJitter,
			scanlines: params.scanlines,
			interlaceGap: params.interlaceGap,
			combing: params.combing ?? 0,
			tilt: params.tilt,
			blackLift: params.blackLift ?? 0,
			desaturation: params.desaturation ?? 0,
			randomSeed: params.randomSeed * 10000,
			enableVHSColor: params.enableVHSColor ? 1.0 : 0.0,
			vhsColorR: vhsRGBA.r,
			vhsColorG: vhsRGBA.g,
			vhsColorB: vhsRGBA.b,
			vhsColorA: vhsRGBA.a,
			applyToTransparent: params.applyToTransparent ? 1.0 : 0.0,
		});

		const uniformBuffer = device.createBuffer({
			label: "HK VHS Interlace Uniform Buffer",
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
			label: "HK VHS Interlace Bind Group",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: "HK VHS Interlace Filter Pass",
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
		const f = filter as HKVhsInterlaceFilter;
		const params = f.paramData.params;
		const colorShiftPadding = params.colorShift * 5;
		const verticalJitterPadding = 100 * params.verticalJitter;
		return Math.max(colorShiftPadding, verticalJitterPadding, 1);
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as HKVhsInterlaceFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					colorShift: f.paramData.params.colorShift * uniformScale,
					interlaceGap: Math.max(
						1,
						Math.round(f.paramData.params.interlaceGap * uniformScale),
					),
					trackingError: f.paramData.params.trackingError * uniformScale,
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKVhsInterlaceParams;
		const b = paramsB as HKVhsInterlaceParams;

		const aVhs = colorToRawRGBA(a.vhsColor);
		const bVhs = colorToRawRGBA(b.vhsColor);

		const lerp = (
			x: number | undefined,
			y: number | undefined,
			neutral = 0,
		) => {
			const xv = x ?? neutral;
			return xv + ((y ?? neutral) - xv) * t;
		};

		return {
			intensity: a.intensity + (b.intensity - a.intensity) * t,
			generation: lerp(a.generation, b.generation, 1),
			chromaBleed: lerp(a.chromaBleed, b.chromaBleed),
			colorShift: a.colorShift + (b.colorShift - a.colorShift) * t,
			lumaSoftness: lerp(a.lumaSoftness, b.lumaSoftness),
			ringing: lerp(a.ringing, b.ringing),
			lineJitter: lerp(a.lineJitter, b.lineJitter),
			verticalJitter:
				a.verticalJitter + (b.verticalJitter - a.verticalJitter) * t,
			trackingError: a.trackingError + (b.trackingError - a.trackingError) * t,
			headSwitching: lerp(a.headSwitching, b.headSwitching),
			headSwitchingHeight: lerp(
				a.headSwitchingHeight,
				b.headSwitchingHeight,
				8,
			),
			noise: a.noise + (b.noise - a.noise) * t,
			noiseDistortion:
				a.noiseDistortion + (b.noiseDistortion - a.noiseDistortion) * t,
			chromaNoise: lerp(a.chromaNoise, b.chromaNoise),
			dropouts: lerp(a.dropouts, b.dropouts),
			dropoutLength: lerp(a.dropoutLength, b.dropoutLength, 0.25),
			brightnessJitter:
				a.brightnessJitter + (b.brightnessJitter - a.brightnessJitter) * t,
			scanlines: a.scanlines + (b.scanlines - a.scanlines) * t,
			interlaceGap: Math.round(
				a.interlaceGap + (b.interlaceGap - a.interlaceGap) * t,
			),
			combing: lerp(a.combing, b.combing),
			tilt: a.tilt + (b.tilt - a.tilt) * t,
			blackLift: lerp(a.blackLift, b.blackLift),
			desaturation: lerp(a.desaturation, b.desaturation),
			randomSeed: a.randomSeed + (b.randomSeed - a.randomSeed) * t,
			enableVHSColor: t < 0.5 ? a.enableVHSColor : b.enableVHSColor,
			vhsColor: toRGBColor({
				r: aVhs.r + (bVhs.r - aVhs.r) * t,
				g: aVhs.g + (bVhs.g - aVhs.g) * t,
				b: aVhs.b + (bVhs.b - aVhs.b) * t,
				a: aVhs.a + (bVhs.a - aVhs.a) * t,
			}),
			applyToTransparent: t < 0.5 ? a.applyToTransparent : b.applyToTransparent,
		};
	}

	public onAdjustColor(
		params: unknown,
		adjustColor: (color: Color) => Color,
	): unknown {
		const p = params as HKVhsInterlaceFilter["paramData"]["params"];
		if (!p.enableVHSColor) return params;
		return { ...p, vhsColor: adjustColor(p.vhsColor) };
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
	}
}
