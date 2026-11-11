import type { StructuredView } from "webgpu-utils";
import {
	type Appearance,
	type Color,
	colorToRawRGBA,
	type Filter,
	toRGBColor,
} from "../../../schema";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import {
	BlurPyramidBuilder,
	pyramidLevelVariance,
} from "../../canvas/pipeline/BlurPyramid";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import { ScratchTexturePool } from "../shared/ScratchTexturePool";
import {
	HK_KIRAKIRA_HORIZONTAL_SHADER,
	HK_KIRAKIRA_VERTICAL_SHADER,
} from "./hk-kirakira.wgsl";

/** Sigma (texels) the glow keeps on the pyramid level it is blurred at.
 *  The pyramid's own blur stays about 2% of the glow's variance, so the
 *  glow keeps its Gaussian shape, and each pass reads about 24 texels. */
const GLOW_LEVEL_SIGMA_TEXELS = 8;

export interface HKKirakiraParams {
	radius: number;
	strength: number;
	sparkle: number;
	sparkleAlpha: boolean;
	blendOpacity: number;
	makeOriginalTransparent: boolean;
	useCustomColor: boolean;
	customColor: Color;
}
export interface HKKirakiraFilter extends Appearance<HKKirakiraParams> {
	processor: "hk:kirakira";
}

export class HKKirakiraFilterHandler implements FilterHandler {
	private verticalPipeline: GPURenderPipeline | null = null;
	private horizontalPipeline: GPURenderPipeline | null = null;
	private verticalBindGroupLayout: GPUBindGroupLayout | null = null;
	private horizontalBindGroupLayout: GPUBindGroupLayout | null = null;
	private verticalUniformView: StructuredView | null = null;
	private horizontalUniformView: StructuredView | null = null;
	private blurPyramid: BlurPyramidBuilder | null = null;
	/** Pyramid levels and the vertical pass's output, reused across chains
	 *  and frames. */
	private readonly scratch = new ScratchTexturePool();
	private canvasFormat: GPUTextureFormat = "rgba8unorm";

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.canvasFormat = canvasFormat;

		// Vertical pass: standard 3-binding layout (uniform, texture, sampler)
		this.verticalBindGroupLayout = device.createBindGroupLayout({
			label: "HK Kirakira Vertical Bind Group Layout",
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

		// Horizontal pass: 4-binding layout (uniform, intermediate texture, original texture, sampler)
		this.horizontalBindGroupLayout = device.createBindGroupLayout({
			label: "HK Kirakira Horizontal Bind Group Layout",
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
					texture: { sampleType: "float" },
				},
				{
					binding: 3,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "filtering" },
				},
			],
		});

		// Vertical pipeline
		const verticalCompiled = compileShaderModule(device, {
			label: "HK Kirakira Vertical Shader",
			code: HK_KIRAKIRA_VERTICAL_SHADER,
		});
		this.verticalUniformView = verticalCompiled.uniformViews.uniforms;

		this.verticalPipeline = device.createRenderPipeline({
			label: "HK Kirakira Vertical Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.verticalBindGroupLayout],
			}),
			vertex: { module: verticalCompiled.module, entryPoint: "vertexMain" },
			fragment: {
				module: verticalCompiled.module,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});

		// Horizontal pipeline
		const horizontalCompiled = compileShaderModule(device, {
			label: "HK Kirakira Horizontal Shader",
			code: HK_KIRAKIRA_HORIZONTAL_SHADER,
		});
		this.horizontalUniformView = horizontalCompiled.uniformViews.uniforms;

		this.horizontalPipeline = device.createRenderPipeline({
			label: "HK Kirakira Horizontal Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.horizontalBindGroupLayout],
			}),
			vertex: {
				module: horizontalCompiled.module,
				entryPoint: "vertexMain",
			},
			fragment: {
				module: horizontalCompiled.module,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});

		this.blurPyramid = new BlurPyramidBuilder(device, (width, height, format) =>
			this.scratch.acquire(
				device,
				width,
				height,
				format,
				GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
				"HK Kirakira Pyramid Level",
			),
		);
	}

	public flushPendingDestroy(): void {
		this.scratch.releaseAll();
		this.scratch.flushPendingDestroy();
		this.blurPyramid?.beginFrame();
	}

	private setUniformValues(
		uniformView: StructuredView,
		params: HKKirakiraParams,
		resolution: [number, number],
		dpiScale: number,
	): void {
		const customRGBA = colorToRawRGBA(params.customColor);

		uniformView.set({
			resolution,
			dpiScale,
			radius: params.radius,
			strength: params.strength,
			sparkle: params.sparkle,
			sparkleAlpha: params.sparkleAlpha ? 1.0 : 0.0,
			blendOpacity: params.blendOpacity,
			makeOriginalTransparent: params.makeOriginalTransparent ? 1.0 : 0.0,
			useCustomColor: params.useCustomColor ? 1.0 : 0.0,
			customColor: [customRGBA.r, customRGBA.g, customRGBA.b, customRGBA.a],
		});
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const f = filter as HKKirakiraFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (
			!this.verticalPipeline ||
			!this.horizontalPipeline ||
			!this.verticalBindGroupLayout ||
			!this.horizontalBindGroupLayout ||
			!this.verticalUniformView ||
			!this.horizontalUniformView
		) {
			console.warn("HKKirakiraFilterHandler not initialized");
			return;
		}

		const params = f.paramData.params;

		const sampler = device.createSampler({
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});

		// A wide glow is blurred on a reduced pyramid level: the pyramid takes
		// a small part of the blur, and the two passes blur the rest at that
		// level's texels, where they read a fixed number of texels per pixel.
		const sigma = params.radius * dpiScale * 0.33 * params.strength;
		const level = glowPyramidLevel(sigma, textureSize);
		const reduced =
			level > 0 && this.blurPyramid
				? this.blurPyramid
						.build(
							commandEncoder,
							sourceTexture,
							textureSize.width,
							textureSize.height,
							level,
							context.profiler,
							context.timingLabel ?? "HK Kirakira Filter",
						)
						.at(-1)
				: undefined;
		const glowInput = reduced?.texture ?? sourceTexture;
		const glowSize: [number, number] = reduced
			? [reduced.usedWidth, reduced.usedHeight]
			: [textureSize.width, textureSize.height];
		// The shader derives its sigma from dpiScale; scale it so the passes
		// add what the pyramid left, in the level's texels.
		const levelSigma =
			Math.sqrt(Math.max(sigma ** 2 - pyramidLevelVariance(level), 0)) /
			2 ** level;
		const glowDpiScale = reduced ? (dpiScale * levelSigma) / sigma : dpiScale;
		const verticalTarget = this.scratch.acquire(
			device,
			glowSize[0],
			glowSize[1],
			this.canvasFormat,
			GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
			"HK Kirakira Vertical Texture",
		);

		// === Pass 1: Vertical blur (glow input -> vertical target) ===
		this.setUniformValues(
			this.verticalUniformView,
			params,
			glowSize,
			glowDpiScale,
		);

		const verticalUniformBuffer = device.createBuffer({
			label: "HK Kirakira Vertical Uniform Buffer",
			size: this.verticalUniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(
			verticalUniformBuffer,
			0,
			this.verticalUniformView.arrayBuffer,
		);

		const verticalBindGroup = device.createBindGroup({
			label: "HK Kirakira Vertical Bind Group",
			layout: this.verticalBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: verticalUniformBuffer } },
				{ binding: 1, resource: glowInput.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const verticalPass = commandEncoder.beginRenderPass({
			label: "HK Kirakira Vertical Pass",
			colorAttachments: [
				{
					view: verticalTarget.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
		});
		verticalPass.setPipeline(this.verticalPipeline);
		verticalPass.setBindGroup(0, verticalBindGroup);
		verticalPass.draw(3, 1, 0, 0);
		verticalPass.end();

		// === Pass 2: Horizontal blur + sparkle composite (vertical target + source -> target) ===
		this.setUniformValues(
			this.horizontalUniformView,
			params,
			glowSize,
			glowDpiScale,
		);

		const horizontalUniformBuffer = device.createBuffer({
			label: "HK Kirakira Horizontal Uniform Buffer",
			size: this.horizontalUniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(
			horizontalUniformBuffer,
			0,
			this.horizontalUniformView.arrayBuffer,
		);

		const horizontalBindGroup = device.createBindGroup({
			label: "HK Kirakira Horizontal Bind Group",
			layout: this.horizontalBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: horizontalUniformBuffer } },
				{ binding: 1, resource: verticalTarget.createView() },
				{ binding: 2, resource: sourceTexture.createView() },
				{ binding: 3, resource: sampler },
			],
		});

		const horizontalPass = commandEncoder.beginRenderPass({
			label: "HK Kirakira Horizontal Pass",
			colorAttachments: [
				{
					view: targetTexture.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
		});
		horizontalPass.setPipeline(this.horizontalPipeline);
		horizontalPass.setBindGroup(0, horizontalBindGroup);
		horizontalPass.draw(3, 1, 0, 0);
		horizontalPass.end();

		// The chain's passes are encoded; the next one may reuse these
		// intermediates, since passes execute in encode order.
		this.scratch.releaseAll();
	}

	public getExpansionMargin(filter: Filter): number {
		return ((filter as HKKirakiraFilter).paramData.params.radius ?? 0) / 2;
	}

	/** The separable glow reads its kernel on each axis, plus the reduced
	 *  pyramid level's own reach when the glow is wide. */
	public getBackdropFootprint(filter: Filter): number {
		const { radius, strength } = (filter as HKKirakiraFilter).paramData.params;
		const sigma = radius * 0.33 * strength;
		return Math.SQRT2 * (Math.min(radius, 3 * sigma) + 1.25 * sigma);
	}

	public getDetailDensity(): number {
		return Number.POSITIVE_INFINITY;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as HKKirakiraFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					radius: f.paramData.params.radius * uniformScale,
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as HKKirakiraParams;
		const b = paramsB as HKKirakiraParams;

		const aCustom = colorToRawRGBA(a.customColor);
		const bCustom = colorToRawRGBA(b.customColor);

		return {
			radius: Math.round(a.radius + (b.radius - a.radius) * t),
			strength: a.strength + (b.strength - a.strength) * t,
			sparkle: a.sparkle + (b.sparkle - a.sparkle) * t,
			sparkleAlpha: t < 0.5 ? a.sparkleAlpha : b.sparkleAlpha,
			blendOpacity: a.blendOpacity + (b.blendOpacity - a.blendOpacity) * t,
			makeOriginalTransparent:
				t < 0.5 ? a.makeOriginalTransparent : b.makeOriginalTransparent,
			useCustomColor: t < 0.5 ? a.useCustomColor : b.useCustomColor,
			customColor: toRGBColor({
				r: aCustom.r + (bCustom.r - aCustom.r) * t,
				g: aCustom.g + (bCustom.g - aCustom.g) * t,
				b: aCustom.b + (bCustom.b - aCustom.b) * t,
				a: aCustom.a + (bCustom.a - aCustom.a) * t,
			}),
		};
	}

	public onAdjustColor(
		params: unknown,
		adjustColor: (color: Color) => Color,
	): unknown {
		const p = params as HKKirakiraFilter["paramData"]["params"];
		if (!p.useCustomColor) return params;
		return { ...p, customColor: adjustColor(p.customColor) };
	}

	public trimUnusedTextures(): void {
		this.scratch.trimUnused();
	}

	public destroy(): void {
		this.verticalPipeline = null;
		this.horizontalPipeline = null;
		this.verticalBindGroupLayout = null;
		this.horizontalBindGroupLayout = null;
		this.verticalUniformView = null;
		this.horizontalUniformView = null;
		this.blurPyramid?.destroy();
		this.blurPyramid = null;
		this.scratch.destroy();
	}
}

/**
 * The pyramid level a glow of `sigma` texels is blurred at: the deepest one
 * that leaves it GLOW_LEVEL_SIGMA_TEXELS of its own texels, or 0 to blur at
 * full resolution. No level goes below one texel.
 */
function glowPyramidLevel(
	sigma: number,
	{ width, height }: { width: number; height: number },
): number {
	if (!(sigma > GLOW_LEVEL_SIGMA_TEXELS * 2)) return 0;
	return Math.min(
		Math.floor(Math.log2(sigma / GLOW_LEVEL_SIGMA_TEXELS)),
		Math.floor(Math.log2(Math.max(width, height))),
	);
}
