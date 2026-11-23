/**
 * FrostGlass Filter Processor
 * Implements frosted glass effect with blur, saturation adjustment, and tint.
 *
 * Backdrop mask is applied by FilterRenderer after all filter passes.
 */

import type { StructuredView } from "webgpu-utils";
import {
	type Appearance,
	type Color,
	colorToRawRGBA,
	type Filter,
	toRGBColor,
} from "../../../schema";
import { lerpOptionalRGBColor, lerpOptionalScalar } from "../../../utils/color";
import { compileShaderModule } from "../../../utils/wgpu-utils";
import type {
	FilterHandler,
	FilterProcessorContext,
} from "../../canvas/pipeline/FilterRenderer";
import { FrameUniformPool } from "../../canvas/pipeline/FrameUniformPool";
import { TEXELS_PER_BLUR_SIGMA } from "../shared/blurDetailDensity";
import { JumpFloodDistanceField } from "../shared/JumpFloodDistanceField";
import { ScratchTexturePool } from "../shared/ScratchTexturePool";
import {
	FROST_GLASS_PYRAMID_SHADER,
	FROST_GLASS_RIM_SHADER,
	FROST_GLASS_SHADER,
} from "./frostGlass.wgsl";

/** Texel cap of the fallback blur kernel (GPU safety bound). */
const MAX_BLUR_RADIUS_TEXELS = 300;
/**
 * World px kept around the element when it has a rim. The rim finds the edge
 * from the pixels outside the shape, so the raster must hold some of them on
 * every side; 2 px keeps at least one texel down to a raster scale of 0.5.
 */
const RIM_EDGE_MARGIN = 2;

export interface FrostGlassParams {
	radius: number; // 0.0~100.0 (blur radius in pixels)
	tint?: Color; // Optional color tint overlay
	tintOpacity?: number; // 0.0~1.0 (how much the tint shows)
	saturation?: number; // 0.0~2.0 (1.0 = normal, <1 = desaturated, >1 = saturated)
	scatter?: number; // 0+ world px of random backdrop displacement (frosted grain)
	scatterGrain?: number; // world px block size of the scatter pattern
	refraction?: number; // 0+ world px the backdrop shifts inward at the edge
	bevel?: number; // 0+ world px width of the rounded rim that refracts
	aberration?: number; // 0.0~1.0 per-channel spread of the refraction
	highlight?: number; // 0.0~1.0 rim highlight strength
	distance?: number; // 0+ world px the pane sits above the backdrop (backdrop route only)
}

export interface FrostGlassFilter extends Appearance<FrostGlassParams> {
	processor: "frost-glass";
}

export class FrostGlassFilterHandler implements FilterHandler {
	private pipeline: GPURenderPipeline | null = null;
	private bindGroupLayout: GPUBindGroupLayout | null = null;
	private uniformView: StructuredView | null = null;
	private uniformPoolH: FrameUniformPool | null = null;
	private uniformPoolV: FrameUniformPool | null = null;
	// Shared-pyramid path: one pass lerping two pre-blurred batch levels.
	// Uniform buffers pool per postProcess call (several frost glass elements
	// can run inside one submit, so a shared buffer would cross-talk).
	private pyramidPipeline: GPURenderPipeline | null = null;
	private pyramidBindGroupLayout: GPUBindGroupLayout | null = null;
	private pyramidUniformView: StructuredView | null = null;
	private pyramidUniformPool: FrameUniformPool | null = null;
	// Rim pass: refraction and highlight along the element's rounded edge,
	// run on the blurred result held in a scratch texture.
	private rimPipeline: GPURenderPipeline | null = null;
	private rimBindGroupLayout: GPUBindGroupLayout | null = null;
	private rimUniformView: StructuredView | null = null;
	private rimUniformPool: FrameUniformPool | null = null;
	private readonly jfa = new JumpFloodDistanceField();
	private readonly scratch = new ScratchTexturePool();
	private canvasFormat: GPUTextureFormat = "rgba8unorm";

	/**
	 * Frost glass runs on the element's own raster by default and rides the
	 * common Appearance.applyToBackdrop flag to blur what's behind the element
	 * instead (resolveRenderConfigure forces the backdrop route). The rim pass
	 * needs the element's outline: on the backdrop route the source holds the
	 * backdrop, so the shape comes in as ctx.maskTexture; on the element route
	 * the source's own alpha is the shape.
	 */
	public getRenderConfigure(filter: Filter): { needsMask: boolean } {
		return {
			needsMask: hasRim((filter as FrostGlassFilter).paramData.params),
		};
	}

	/** Blur sigma in capture texels, mirroring the fallback shader's kernel
	 *  (sigma = radius / 2, radius capped at 300 texels) so the shared
	 *  pyramid reproduces the same blur strength. Zero when scattering: the
	 *  grain must be displaced BEFORE the blur softens it, which the
	 *  pre-blurred pyramid cannot reproduce, so those filters keep the
	 *  self-contained blur. */
	public getBackdropBlurSigma(filter: Filter, rasterScale: number): number {
		const p = (filter as FrostGlassFilter).paramData.params;
		if ((p.scatter ?? 0) > 0) return 0;
		return Math.min(p.radius * rasterScale, MAX_BLUR_RADIUS_TEXELS) / 2;
	}

	public startFrame(): void {
		this.uniformPoolH?.beginFrame();
		this.uniformPoolV?.beginFrame();
		this.pyramidUniformPool?.beginFrame();
		this.rimUniformPool?.beginFrame();
	}

	/** Called by FilterRenderer.flushPendingDestroy once per frame, after the
	 *  previous frame's submit — in-flight passes may still reference the
	 *  retired JFA and scratch textures until then. */
	public flushPendingDestroy(): void {
		this.jfa.flushPendingDestroy();
		this.scratch.flushPendingDestroy();
	}

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.canvasFormat = canvasFormat;
		const { module, uniformViews } = compileShaderModule(device, {
			label: "FrostGlass Filter Shader",
			code: FROST_GLASS_SHADER,
		});

		this.uniformView = uniformViews.uniforms;
		this.uniformPoolH = new FrameUniformPool(
			device,
			"FrostGlass Uniform Buffer (Horizontal)",
		);
		this.uniformPoolV = new FrameUniformPool(
			device,
			"FrostGlass Uniform Buffer (Vertical)",
		);
		this.pyramidUniformPool = new FrameUniformPool(
			device,
			"FrostGlass Pyramid Uniform Buffer",
		);

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "FrostGlass Bind Group Layout",
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
			label: "FrostGlass Filter Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.bindGroupLayout],
			}),
			vertex: {
				module,
				entryPoint: "vertexMain",
			},
			fragment: {
				module,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: {
				topology: "triangle-list",
			},
		});

		const { module: pyramidModule, uniformViews: pyramidUniformViews } =
			compileShaderModule(device, {
				label: "FrostGlass Pyramid Shader",
				code: FROST_GLASS_PYRAMID_SHADER,
			});
		this.pyramidUniformView = pyramidUniformViews.uniforms;
		this.pyramidBindGroupLayout = device.createBindGroupLayout({
			label: "FrostGlass Pyramid Bind Group Layout",
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
		this.pyramidPipeline = device.createRenderPipeline({
			label: "FrostGlass Pyramid Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.pyramidBindGroupLayout],
			}),
			vertex: { module: pyramidModule, entryPoint: "vertexMain" },
			fragment: {
				module: pyramidModule,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});

		const rim = compileShaderModule(device, {
			label: "FrostGlass Rim Shader",
			code: FROST_GLASS_RIM_SHADER,
		});
		this.rimUniformView = rim.uniformViews.uniforms;
		this.rimUniformPool = new FrameUniformPool(
			device,
			"FrostGlass Rim Uniform Buffer",
		);
		this.rimBindGroupLayout = device.createBindGroupLayout({
			label: "FrostGlass Rim Bind Group Layout",
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
				{
					binding: 3,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "unfilterable-float" },
				},
			],
		});
		this.rimPipeline = device.createRenderPipeline({
			label: "FrostGlass Rim Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.rimBindGroupLayout],
			}),
			vertex: { module: rim.module, entryPoint: "vertexMain" },
			fragment: {
				module: rim.module,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});
		this.jfa.initialize(device);
	}

	/** Blur and tint the source, then, when the filter has a rim, refract and
	 *  light the blurred result along the element's edge. */
	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		if (filter.processor !== "frost-glass") {
			throw new Error(
				"FrostGlassFilterHandler can only process frost-glass filters",
			);
		}
		const p = (filter as FrostGlassFilter).paramData.params;
		if (!hasRim(p)) {
			this.encodeFrost(context, filter, context.targetTexture);
			return;
		}

		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;
		const bevel = (p.bevel ?? 0) * dpiScale;
		// Seeded on the pixels outside the shape, so every pixel inside gets
		// its distance and direction to the edge. Encoded before the blur,
		// which may overwrite sourceTexture.
		const coordTexture = this.jfa.compute(
			device,
			commandEncoder,
			context.maskTexture ?? sourceTexture,
			textureSize.width,
			textureSize.height,
			bevel,
			false,
		);
		if (
			!coordTexture ||
			!this.rimPipeline ||
			!this.rimBindGroupLayout ||
			!this.rimUniformView ||
			!this.rimUniformPool
		) {
			this.encodeFrost(context, filter, targetTexture);
			return;
		}

		const blurred = this.scratch.acquireLike(
			device,
			targetTexture,
			"FrostGlass Blurred",
			textureSize,
		);
		this.encodeFrost(context, filter, blurred);

		this.rimUniformView.set({
			resolution: [textureSize.width, textureSize.height],
			refraction: (p.refraction ?? 0) * dpiScale,
			bevel,
			aberration: p.aberration ?? 0,
			highlight: p.highlight ?? 0,
		});
		const bindGroup = device.createBindGroup({
			label: "FrostGlass Rim Bind Group",
			layout: this.rimBindGroupLayout,
			entries: [
				{
					binding: 0,
					resource: {
						buffer: this.rimUniformPool.write(this.rimUniformView.arrayBuffer),
					},
				},
				{ binding: 1, resource: blurred.createView() },
				{ binding: 2, resource: createLinearClampSampler(device) },
				{ binding: 3, resource: coordTexture.createView() },
			],
		});
		const pass = commandEncoder.beginRenderPass({
			label: "FrostGlass Rim Pass",
			timestampWrites: context.profiler?.timestampWrites(
				context.timingLabel ?? "FrostGlass Filter",
			),
			colorAttachments: [
				{
					view: targetTexture.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
		});
		pass.setPipeline(this.rimPipeline);
		pass.setBindGroup(0, bindGroup);
		pass.draw(3, 1, 0, 0);
		pass.end();
		// Passes run in encode order, so the next chain may reuse it.
		this.scratch.release(blurred);
	}

	/** Write the blurred, saturated and tinted source to `output`. */
	private encodeFrost(
		context: FilterProcessorContext,
		filter: Filter,
		output: GPUTexture,
	): void {
		const frostFilter = filter as FrostGlassFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (
			!this.pipeline ||
			!this.bindGroupLayout ||
			!this.uniformView ||
			!this.uniformPoolH ||
			!this.uniformPoolV
		) {
			console.warn("FrostGlassFilterHandler not initialized");
			return;
		}

		const sampler = createLinearClampSampler(device);

		// Extract filter parameters with defaults.
		// sceneInfo.dpiScale is texels per world px of the source texture. The
		// backdrop is captured at the fixed rasterization scale R, so radius
		// (world px) scales by R here and the blur is invariant to viewport zoom.
		const fp = frostFilter.paramData.params;
		const radius = fp.radius * dpiScale;
		// Scatter stays in world px; the shader converts via the dpiScale uniform
		// so the grain pattern is anchored to world-px cells.
		const scatter = fp.scatter ?? 0;
		const scatterGrain = Math.max(fp.scatterGrain ?? 1, 1);
		const sourceOffset = context.coordinateSpace?.sourceOffset ?? {
			x: 0,
			y: 0,
		};
		const saturation = fp.saturation ?? 1.0;
		const tintRGBA = fp.tint ? colorToRawRGBA(fp.tint) : null;
		const tintR = tintRGBA?.r ?? 1.0;
		const tintG = tintRGBA?.g ?? 1.0;
		const tintB = tintRGBA?.b ?? 1.0;
		const tintOpacity = fp.tintOpacity ?? 0.0;
		const { zoomCenter, zoom } = paneZoom(context, frostFilter);

		// Shared-pyramid path: the coordinator already blurred the batch
		// capture, so one pass lerps the two levels bracketing this filter's
		// sigma and applies saturation/tint. Falls through to the
		// self-contained separable blur when no pyramid is available or when
		// scatter needs the displace-before-blur order.
		const pyramidSigma = this.getBackdropBlurSigma(filter, dpiScale);
		const pyramid =
			pyramidSigma > 0 ? context.backdropBlur?.(pyramidSigma) : null;
		if (
			pyramid &&
			this.pyramidPipeline &&
			this.pyramidBindGroupLayout &&
			this.pyramidUniformView
		) {
			this.pyramidUniformView.set({
				remap: pyramid.remap,
				loCtl: pyramid.blurLoCtl,
				hiCtl: pyramid.blurHiCtl,
				blurMix: pyramid.blurMix,
				saturation,
				tintR,
				tintG,
				tintB,
				tintOpacity,
				zoomCenter,
				zoom,
			});
			const uniformBuffer = this.pyramidUniformPool!.write(
				this.pyramidUniformView.arrayBuffer,
			);

			const bindGroup = device.createBindGroup({
				label: "FrostGlass Pyramid Bind Group",
				layout: this.pyramidBindGroupLayout,
				entries: [
					{ binding: 0, resource: { buffer: uniformBuffer } },
					{ binding: 1, resource: pyramid.blurLo.createView() },
					{ binding: 2, resource: pyramid.blurHi.createView() },
					{ binding: 3, resource: sampler },
				],
			});

			const pass = commandEncoder.beginRenderPass({
				label: "FrostGlass Pyramid Pass",
				timestampWrites: context.profiler?.timestampWrites(
					context.timingLabel ?? "FrostGlass Filter",
				),
				colorAttachments: [
					{
						view: output.createView(),
						loadOp: "clear",
						storeOp: "store",
						clearValue: { r: 0, g: 0, b: 0, a: 0 },
					},
				],
			});
			pass.setPipeline(this.pyramidPipeline);
			pass.setBindGroup(0, bindGroup);
			pass.draw(3, 1, 0, 0);
			pass.end();
			return;
		}

		// Two-pass separable Gaussian blur: horizontal then vertical

		// === Pass 1: Horizontal blur (source -> target) ===
		this.uniformView.set({
			resolution: [textureSize.width, textureSize.height],
			sourceOffset: [sourceOffset.x, sourceOffset.y],
			direction: [1.0, 0.0],
			radius,
			saturation,
			tintR,
			tintG,
			tintB,
			tintOpacity,
			applyEffects: 0.0,
			scatter,
			scatterGrain,
			applyScatter: 1.0,
			dpiScale,
			zoomCenter,
			zoom,
		});

		const uniformBufferH = this.uniformPoolH.write(
			this.uniformView.arrayBuffer,
		);

		const horizontalBindGroup = device.createBindGroup({
			label: "FrostGlass Bind Group (Horizontal)",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBufferH } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const horizontalPass = commandEncoder.beginRenderPass({
			label: "FrostGlass Filter Pass (Horizontal)",
			timestampWrites: context.profiler?.timestampWrites(
				context.timingLabel ?? "FrostGlass Filter",
			),
			colorAttachments: [
				{
					view: targetTexture.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
		});

		horizontalPass.setPipeline(this.pipeline);
		horizontalPass.setBindGroup(0, horizontalBindGroup);
		horizontalPass.draw(3, 1, 0, 0);
		horizontalPass.end();

		// Copy horizontal result to source for vertical pass input
		commandEncoder.copyTextureToTexture(
			{ texture: targetTexture },
			{ texture: sourceTexture },
			{ width: textureSize.width, height: textureSize.height },
		);

		// === Pass 2: Vertical blur with saturation/tint ===
		this.uniformView.set({
			resolution: [textureSize.width, textureSize.height],
			sourceOffset: [sourceOffset.x, sourceOffset.y],
			direction: [0.0, 1.0],
			radius,
			saturation,
			tintR,
			tintG,
			tintB,
			tintOpacity,
			applyEffects: 1.0,
			scatter,
			scatterGrain,
			applyScatter: 0.0,
			dpiScale,
			zoomCenter,
			zoom: 1,
		});

		const uniformBufferV = this.uniformPoolV.write(
			this.uniformView.arrayBuffer,
		);

		const verticalBindGroup = device.createBindGroup({
			label: "FrostGlass Bind Group (Vertical)",
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBufferV } },
				{ binding: 1, resource: sourceTexture.createView() },
				{ binding: 2, resource: sampler },
			],
		});

		const verticalPass = commandEncoder.beginRenderPass({
			label: "FrostGlass Filter Pass (Vertical)",
			timestampWrites: context.profiler?.timestampWrites(
				context.timingLabel ?? "FrostGlass Filter",
			),
			colorAttachments: [
				{
					view: output.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
		});

		verticalPass.setPipeline(this.pipeline);
		verticalPass.setBindGroup(0, verticalBindGroup);
		verticalPass.draw(3, 1, 0, 0);
		verticalPass.end();
	}

	/** The blur (sigma = radius / 2) reads up to 3.5 sigmas: the shared
	 *  pyramid blends two levels, the upper one up to twice the sigma. The
	 *  scatter displaces the read by its block offset plus its per-pixel
	 *  offset, up to 1.3 * `scatter` world px, before it, and the pane's
	 *  distance moves the read up to `distance` world px outward. */
	public getBackdropFootprint(filter: Filter): number {
		const p = (filter as FrostGlassFilter).paramData.params;
		return p.radius * 1.75 + 1.3 * (p.scatter ?? 0) + (p.distance ?? 0);
	}

	/** The output is the blurred input, whose sigma is half the radius. */
	public getDetailDensity(filter: Filter): number {
		const { radius } = (filter as FrostGlassFilter).paramData.params;
		return radius > 0
			? TEXELS_PER_BLUR_SIGMA / (radius / 2)
			: Number.POSITIVE_INFINITY;
	}

	public getExpansionMargin(filter: Filter): number {
		// On the backdrop route the effect fills the element shape, so the
		// region needs no headroom beyond the rim's until the pane sits above
		// the backdrop: then its edge reads `distance` world px outside, and the
		// blur around that read reaches further still. On the element route the
		// blur and scatter spread content up to radius + scatter world px
		// outward.
		const p = (filter as FrostGlassFilter).paramData.params;
		const rimMargin = hasRim(p) ? RIM_EDGE_MARGIN : 0;
		if (filter.applyToBackdrop) {
			const distance = p.distance ?? 0;
			return distance > 0
				? Math.max(rimMargin, distance + this.getBackdropFootprint(filter))
				: rimMargin;
		}
		return Math.max(p.radius + (p.scatter ?? 0), rimMargin);
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as FrostGlassFilter;
		const p = f.paramData.params;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...p,
					radius: p.radius * uniformScale,
					...(p.scatter != null && { scatter: p.scatter * uniformScale }),
					...(p.scatterGrain != null && {
						scatterGrain: p.scatterGrain * uniformScale,
					}),
					...(p.refraction != null && {
						refraction: p.refraction * uniformScale,
					}),
					...(p.bevel != null && { bevel: p.bevel * uniformScale }),
					...(p.distance != null && { distance: p.distance * uniformScale }),
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		return interpolateFrostGlassParams(
			paramsA as FrostGlassFilter["paramData"]["params"],
			paramsB as FrostGlassFilter["paramData"]["params"],
			t,
		);
	}

	public onAdjustColor(
		params: unknown,
		adjustColor: (color: Color) => Color,
	): unknown {
		const p = params as FrostGlassFilter["paramData"]["params"];
		if (!p.tint) return params;
		return { ...p, tint: adjustColor(p.tint) };
	}

	public destroy(): void {
		this.uniformPoolH?.destroy();
		this.uniformPoolH = null;
		this.uniformPoolV?.destroy();
		this.uniformPoolV = null;
		this.pyramidUniformPool?.destroy();
		this.pyramidUniformPool = null;
		this.pyramidPipeline = null;
		this.pyramidBindGroupLayout = null;
		this.pyramidUniformView = null;
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
		this.rimUniformPool?.destroy();
		this.rimUniformPool = null;
		this.rimPipeline = null;
		this.rimBindGroupLayout = null;
		this.rimUniformView = null;
		this.jfa.destroy();
		this.scratch.destroy();
	}
}

/** The rim pass runs only when it has a band to work in and something to
 *  do there. */
function hasRim(p: FrostGlassParams): boolean {
	return (
		(p.bevel ?? 0) > 0 && ((p.refraction ?? 0) > 0 || (p.highlight ?? 0) > 0)
	);
}

/**
 * How the pane shrinks the backdrop it shows. A pane above the backdrop sees
 * a wider patch of it: the read moves outward from the pane's centre so that
 * the ends of its longer side read `distance` world px past the edge. The
 * element route has no backdrop around the element, so it reads in place.
 */
function paneZoom(
	context: FilterProcessorContext,
	filter: FrostGlassFilter,
): { zoomCenter: [number, number]; zoom: number } {
	const distance = filter.paramData.params.distance ?? 0;
	const rect = context.coordinateSpace?.elementRect;
	if (!filter.applyToBackdrop || distance <= 0 || !rect) {
		return { zoomCenter: [0.5, 0.5], zoom: 1 };
	}
	const {
		sceneInfo: { textureSize, dpiScale },
	} = context;
	const sourceOffset = context.coordinateSpace?.sourceOffset ?? { x: 0, y: 0 };
	const contentOffset = context.sourceContentOffset ?? { x: 0, y: 0 };
	const centerX =
		(rect.x + rect.width / 2 - sourceOffset.x) * dpiScale + contentOffset.x;
	const centerY =
		(rect.y + rect.height / 2 - sourceOffset.y) * dpiScale + contentOffset.y;
	return {
		zoomCenter: [centerX / textureSize.width, centerY / textureSize.height],
		zoom: 1 + distance / (Math.max(rect.width, rect.height) / 2),
	};
}

function createLinearClampSampler(device: GPUDevice): GPUSampler {
	return device.createSampler({
		magFilter: "linear",
		minFilter: "linear",
		addressModeU: "clamp-to-edge",
		addressModeV: "clamp-to-edge",
	});
}

function interpolateFrostGlassParams(
	a: FrostGlassFilter["paramData"]["params"],
	b: FrostGlassFilter["paramData"]["params"],
	t: number,
): FrostGlassFilter["paramData"]["params"] {
	return {
		radius: a.radius + (b.radius - a.radius) * t,
		tint: lerpOptionalRGBColor(
			a.tint ? toRGBColor(colorToRawRGBA(a.tint)) : undefined,
			b.tint ? toRGBColor(colorToRawRGBA(b.tint)) : undefined,
			t,
		),
		tintOpacity: lerpOptionalScalar(a.tintOpacity, b.tintOpacity, t, 0),
		saturation: lerpOptionalScalar(a.saturation, b.saturation, t, 1),
		scatter: lerpOptionalScalar(a.scatter, b.scatter, t, 0),
		scatterGrain: lerpOptionalScalar(a.scatterGrain, b.scatterGrain, t, 1),
		refraction: lerpOptionalScalar(a.refraction, b.refraction, t, 0),
		bevel: lerpOptionalScalar(a.bevel, b.bevel, t, 0),
		aberration: lerpOptionalScalar(a.aberration, b.aberration, t, 0),
		highlight: lerpOptionalScalar(a.highlight, b.highlight, t, 0),
		distance: lerpOptionalScalar(a.distance, b.distance, t, 0),
	};
}
