/**
 * Drop Shadow Filter Processor
 *
 * Two entry points share one set of passes:
 *
 *  • postProcess — the in-place chain: offset + morphological spread, blur,
 *    then colorize and composite the untouched element on top.
 *  • postProcessUnderlay — the self-sized chain: the same shadow built from a
 *    COVERAGE MASK alone and returned as its own texture for the caller to
 *    draw the element over. Backdrop-independent, so it is cached in the
 *    element's AppearanceCache and survives panning and zooming.
 *
 * Wide radii resolve through the shared blur pyramid instead of the direct
 * separable kernel, whose tap count grows with the radius.
 */

import type { StructuredView } from "webgpu-utils";
import {
	type Appearance,
	type Color,
	colorToRawRGBA,
	type Filter,
	toRGBColor,
} from "../../schema";
import { lerpOptionalRGBColor, lerpOptionalScalar } from "../../utils/color";
import { expandBounds } from "../../utils/geometry/bounds";
import {
	computeQuadProjectiveWeights,
	type QuadCorners,
} from "../../utils/geometry/quadProjection";
import { compileShaderModule } from "../../utils/wgpu-utils";
import { aabbOfQuad } from "../canvas/CanvasLayer.helpers";
import {
	BlurPyramidBuilder,
	type BlurTextureCtl,
	blurTextureCtl,
	requiredPyramidLevels,
	selectPyramidLevels,
} from "../canvas/pipeline/BlurPyramid";
import type {
	FilterHandler,
	FilterProcessorContext,
	UnderlayProcessorContext,
	UnderlayResult,
} from "../canvas/pipeline/FilterRenderer";
import { createBorrowedTextureRef } from "../canvas/pipeline/RenderSurface";
import {
	DROP_SHADOW_COVERAGE_PLACE_SHADER,
	DROP_SHADOW_PYRAMID_SHADER,
	DROP_SHADOW_SHADER,
	DROP_SHADOW_SPREAD_SHADER,
} from "./dropShadow.wgsl";
import { JumpFloodDistanceField } from "./JumpFloodDistanceField";

export interface DropShadowParams {
	/** Horizontal shadow offset in world pixels */
	offsetX: number; // -100.0~100.0
	/** Vertical shadow offset in world pixels */
	offsetY: number; // -100.0~100.0
	/** Blur radius for the shadow */
	blurRadius: number; // 0.0~100.0
	/** Shadow color (default: black {r:0, g:0, b:0}) */
	shadowColor?: Color;
	/** Shadow opacity (default: 0.5) */
	shadowOpacity?: number; // 0.0~1.0
	/** Spread radius: positive expands shadow, negative shrinks it (default: 0) */
	spreadRadius?: number; // -50.0~50.0
}

export interface DropShadowFilter extends Appearance<DropShadowParams> {
	processor: "drop-shadow";
}

/** Sizes the original-copy cache may hold at once (LRU-ish FIFO beyond it). */
const MAX_ORIGINAL_COPY_SIZES = 8;

/**
 * Blur radii (in texels) at or above which the shadow resolves through the
 * blur pyramid. The direct kernel costs 2·radius+1 taps per axis, so at the
 * document rasterization scales real drop shadows run at it reaches triple
 * digits; the pyramid's cost is flat in the radius. Below this the direct
 * kernel is both cheaper (no extra render targets) and exact.
 */
export const PYRAMID_BLUR_MIN_RADIUS = 8;

/** Longest allowed side of a self-sized underlay texture, in texels. */
const MAX_UNDERLAY_TEXTURE_SIDE = 4096;

/** Distinct sizes the scratch pool keeps before retiring the oldest. */
const MAX_SCRATCH_TEXTURES = 24;

export class DropShadowFilterProcessor implements FilterHandler {
	private pipeline: GPURenderPipeline | null = null;
	private bindGroupLayout: GPUBindGroupLayout | null = null;
	private uniformView: StructuredView | null = null;
	private jfa = new JumpFloodDistanceField();
	private spreadPipeline: GPURenderPipeline | null = null;
	private spreadBindGroupLayout: GPUBindGroupLayout | null = null;
	private spreadUniformView: StructuredView | null = null;
	private pyramidPipeline: GPURenderPipeline | null = null;
	private pyramidBindGroupLayout: GPUBindGroupLayout | null = null;
	private pyramidUniformView: StructuredView | null = null;
	private placePipeline: GPURenderPipeline | null = null;
	private placeBindGroupLayout: GPUBindGroupLayout | null = null;
	private placeUniformView: StructuredView | null = null;
	private blurPyramid: BlurPyramidBuilder | null = null;
	private sampler: GPUSampler | null = null;
	private originalCopyTexture: GPUTexture | null = null;
	private originalCopySize = { width: 0, height: 0 };
	/** Per-size original copies (`originalCopyTexture` points into this). */
	private originalCopyPool = new Map<string, GPUTexture>();
	/** Blur intermediates (pyramid levels, underlay ping-pong), reused across
	 *  chains and frames — see ScratchTexturePool. */
	private readonly scratch = new ScratchTexturePool();
	private canvasFormat: GPUTextureFormat = "rgba8unorm";
	private pendingDestroy: GPUTexture[] = [];

	public async initialize(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
	): Promise<void> {
		this.canvasFormat = canvasFormat;
		this.sampler = device.createSampler({
			label: "Drop Shadow Sampler",
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});
		const { module, uniformViews } = compileShaderModule(device, {
			label: "Drop Shadow Filter Shader",
			code: DROP_SHADOW_SHADER,
		});

		this.uniformView = uniformViews.uniforms;

		this.bindGroupLayout = device.createBindGroupLayout({
			label: "Drop Shadow Bind Group Layout",
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
					texture: { sampleType: "float" },
				},
				{
					binding: 4,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "filtering" },
				},
			],
		});

		this.pipeline = device.createRenderPipeline({
			label: "Drop Shadow Filter Pipeline",
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

		this.jfa.initialize(device);

		const spread = compileShaderModule(device, {
			label: "Drop Shadow Spread Shader",
			code: DROP_SHADOW_SPREAD_SHADER,
		});
		this.spreadUniformView = spread.uniformViews.uniforms;
		this.spreadBindGroupLayout = device.createBindGroupLayout({
			label: "Drop Shadow Spread Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "unfilterable-float" },
				},
			],
		});
		this.spreadPipeline = device.createRenderPipeline({
			label: "Drop Shadow Spread Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.spreadBindGroupLayout],
			}),
			vertex: { module: spread.module, entryPoint: "vertexMain" },
			fragment: {
				module: spread.module,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});

		const pyramid = compileShaderModule(device, {
			label: "Drop Shadow Pyramid Resolve Shader",
			code: DROP_SHADOW_PYRAMID_SHADER,
		});
		this.pyramidUniformView = pyramid.uniformViews.uniforms;
		this.pyramidBindGroupLayout = device.createBindGroupLayout({
			label: "Drop Shadow Pyramid Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "filtering" },
				},
				...[2, 3, 4].map((binding) => ({
					binding,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float" as const },
				})),
			],
		});
		this.pyramidPipeline = device.createRenderPipeline({
			label: "Drop Shadow Pyramid Resolve Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.pyramidBindGroupLayout],
			}),
			vertex: { module: pyramid.module, entryPoint: "vertexMain" },
			fragment: {
				module: pyramid.module,
				entryPoint: "fragmentMain",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: { topology: "triangle-list" },
		});

		const place = compileShaderModule(device, {
			label: "Drop Shadow Coverage Place Shader",
			code: DROP_SHADOW_COVERAGE_PLACE_SHADER,
		});
		this.placeUniformView = place.uniformViews.uniforms;
		this.placeBindGroupLayout = device.createBindGroupLayout({
			label: "Drop Shadow Coverage Place Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "filtering" },
				},
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float" },
				},
			],
		});
		this.placePipeline = device.createRenderPipeline({
			label: "Drop Shadow Coverage Place Pipeline",
			layout: device.createPipelineLayout({
				bindGroupLayouts: [this.placeBindGroupLayout],
			}),
			vertex: { module: place.module, entryPoint: "vertexMain" },
			fragment: {
				module: place.module,
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
				"Drop Shadow Pyramid Level",
			),
		);
	}

	/** Flush deferred texture destroys. Called by FilterRenderer at frame start. */
	public flushPendingDestroy(): void {
		for (const tex of this.pendingDestroy) tex.destroy();
		this.pendingDestroy.length = 0;
		// Backstop: every chain returns its own intermediates, but a chain that
		// bailed out mid-way (uninitialized pipeline, degenerate bounds) would
		// otherwise leave them checked out forever.
		this.scratch.releaseAll();
		this.scratch.flushPendingDestroy();
		this.blurPyramid?.beginFrame();
		this.jfa.flushPendingDestroy();
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		if (filter.processor !== "drop-shadow") {
			throw new Error(
				"DropShadowFilterProcessor can only process drop-shadow filters",
			);
		}

		const dsFilter = filter as DropShadowFilter;
		const {
			device,
			sourceTexture,
			targetTexture,
			commandEncoder,
			sceneInfo: { textureSize, dpiScale },
		} = context;

		if (!this.pipeline || !this.bindGroupLayout || !this.uniformView) {
			console.warn("DropShadowFilterProcessor not initialized");
			return;
		}

		const { width, height } = textureSize;

		// Ensure we have a texture to preserve the original element
		this.ensureOriginalCopyTexture(device, width, height);
		if (!this.originalCopyTexture) return;

		// Preserve original: source → originalCopy
		commandEncoder.copyTextureToTexture(
			{ texture: sourceTexture },
			{ texture: this.originalCopyTexture },
			{ width, height },
		);

		const p = dsFilter.paramData.params;
		const shadowColor = p.shadowColor
			? colorToRawRGBA(p.shadowColor)
			: { r: 0, g: 0, b: 0, a: 1 };
		const shadowOpacity = p.shadowOpacity ?? 0.5;
		const spreadRadius = (p.spreadRadius ?? 0) * dpiScale;
		const blurRadius = p.blurRadius * dpiScale;

		// Y axis flip: world Y+ is up, texture V+ is down
		const offsetXTexels = p.offsetX * dpiScale;
		const offsetYTexels = -p.offsetY * dpiScale;

		const commonUniforms = {
			resolution: [width, height] as [number, number],
			shadowR: shadowColor.r,
			shadowG: shadowColor.g,
			shadowB: shadowColor.b,
			shadowOpacity,
		};

		// === Pass 0: offset + spread — source → target ===
		this.encodeOffsetAndSpread(
			commandEncoder,
			device,
			sourceTexture,
			targetTexture,
			width,
			height,
			offsetXTexels,
			offsetYTexels,
			spreadRadius,
			commonUniforms,
			context.profiler,
			context.timingLabel,
		);

		// Copy spread result for blur input: target → source
		commandEncoder.copyTextureToTexture(
			{ texture: targetTexture },
			{ texture: sourceTexture },
			{ width, height },
		);

		if (blurRadius >= PYRAMID_BLUR_MIN_RADIUS) {
			this.encodePyramidResolve(
				commandEncoder,
				device,
				sourceTexture,
				targetTexture,
				width,
				height,
				blurRadius,
				[shadowColor.r, shadowColor.g, shadowColor.b, shadowOpacity],
				this.originalCopyTexture,
				context.profiler,
				context.timingLabel,
			);
			// The chain's passes are encoded; the next one may reuse these
			// intermediates, since passes execute in encode order.
			this.scratch.releaseAll();
			return;
		}

		// === Pass 1: Horizontal blur — source → target ===
		const hBuffer = this.createUniformBuffer(
			device,
			"Drop Shadow Uniform (Horizontal)",
			{
				...commonUniforms,
				direction: [1.0, 0.0],
				blurRadius,
				offsetX: 0.0,
				offsetY: 0.0,
				passType: 1.0,
				spreadRadius: 0,
			},
		);

		this.renderPass(
			commandEncoder,
			device,
			sourceTexture,
			this.originalCopyTexture,
			targetTexture,
			hBuffer,
			"Horizontal Blur",
			context.profiler,
			context.timingLabel,
		);

		// Copy horizontal result for vertical pass input: target → source
		commandEncoder.copyTextureToTexture(
			{ texture: targetTexture },
			{ texture: sourceTexture },
			{ width, height },
		);

		// === Pass 2: Vertical blur + composite — source + originalCopy → target ===
		const vBuffer = this.createUniformBuffer(
			device,
			"Drop Shadow Uniform (Vertical)",
			{
				...commonUniforms,
				direction: [0.0, 1.0],
				blurRadius,
				offsetX: 0.0,
				offsetY: 0.0,
				passType: 2.0,
				spreadRadius: 0,
			},
		);

		this.renderPass(
			commandEncoder,
			device,
			sourceTexture,
			this.originalCopyTexture,
			targetTexture,
			vBuffer,
			"Vertical Blur + Composite",
			context.profiler,
			context.timingLabel,
		);
	}

	/**
	 * Build the shadow from a coverage mask alone, as its own world-placed
	 * texture the caller draws the element over.
	 *
	 * Every input is backdrop-independent and viewport-independent (the mask's
	 * world quad, the document rasterization scale, the shadow params), so the
	 * result is cached in the element's AppearanceCache: panning and zooming a
	 * glass solid re-composites its live refraction but does not re-blur its
	 * shadow. The cache entry owns the returned texture, hence the borrowed
	 * "appearance-cache" ref — frame-end cleanup must leave it alone.
	 */
	public postProcessUnderlay(
		ctx: UnderlayProcessorContext,
		filter: Filter,
	): UnderlayResult | null {
		if (filter.processor !== "drop-shadow") {
			throw new Error(
				"DropShadowFilterProcessor can only process drop-shadow filters",
			);
		}
		if (!this.placePipeline || !this.placeUniformView || !this.uniformView) {
			return null;
		}

		const p = (filter as DropShadowFilter).paramData.params;
		const { device, commandEncoder, coverage, rasterScale } = ctx;
		const margin = this.getExpansionMargin(filter);
		const bounds = expandBounds(aabbOfQuad(coverage.quad), margin);
		if (!(bounds.width > 0) || !(bounds.height > 0)) return null;

		// One scale for both axes. The blur and the spread are round in world
		// space, but the shader steps them in TEXELS along each axis — so a
		// texture whose two axes carry different texel densities would blur less
		// far, in world px, along the denser one. Clamping the long side of a
		// wide solid to MAX_UNDERLAY_TEXTURE_SIDE is exactly that situation, so
		// the clamp shrinks BOTH sides and spatial params scale by what the
		// texture actually got, not by the requested rasterScale.
		const spatialScale = Math.min(
			rasterScale,
			MAX_UNDERLAY_TEXTURE_SIDE / bounds.width,
			MAX_UNDERLAY_TEXTURE_SIDE / bounds.height,
		);
		const width = Math.max(Math.ceil(bounds.width * spatialScale), 1);
		const height = Math.max(Math.ceil(bounds.height * spatialScale), 1);
		// Placement uses each axis's exact density (the ceil above rounds the
		// texture up by well under one texel, but the offset must still land on
		// the right texel).
		const texelsPerWorldX = width / bounds.width;
		const texelsPerWorldY = height / bounds.height;

		const hash = underlayHash(p, ctx.coverageHash, coverage.quad, spatialScale);
		const cached = ctx.appearanceCache?.get(filter.uid);
		if (isUnderlayEntry(cached) && cached.hash === hash) {
			return {
				texture: createBorrowedTextureRef(cached.texture, "appearance-cache"),
				bounds: cached.bounds,
				uvRect: FULL_UNDERLAY_UV_RECT,
			};
		}

		const output = device.createTexture({
			label: "Drop Shadow Underlay",
			size: { width, height },
			format: this.canvasFormat,
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC,
		});

		const shadowColor = p.shadowColor
			? colorToRawRGBA(p.shadowColor)
			: { r: 0, g: 0, b: 0, a: 1 };
		const shadowOpacity = p.shadowOpacity ?? 0.5;
		const spreadTexels = Math.round(
			Math.abs((p.spreadRadius ?? 0) * spatialScale),
		);
		const usesSpread = spreadTexels >= 1;
		const blurRadius = p.blurRadius * spatialScale;
		const offsetXTexels = p.offsetX * texelsPerWorldX;
		const offsetYTexels = -p.offsetY * texelsPerWorldY;

		// The spread pass applies the offset itself (in texels, off the flood
		// field), so the placement leaves the mask where it is in that case.
		const placed = this.scratch.acquire(
			device,
			width,
			height,
			this.canvasFormat,
			GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.COPY_DST,
			"Drop Shadow Coverage",
		);
		this.encodeCoveragePlace(
			commandEncoder,
			device,
			coverage,
			bounds,
			placed,
			width,
			height,
			usesSpread ? 0 : p.offsetX,
			usesSpread ? 0 : p.offsetY,
		);

		const commonUniforms = {
			resolution: [width, height] as [number, number],
			shadowR: shadowColor.r,
			shadowG: shadowColor.g,
			shadowB: shadowColor.b,
			shadowOpacity,
		};

		let alpha = placed;
		if (usesSpread) {
			const spreadTarget = this.scratch.acquire(
				device,
				width,
				height,
				this.canvasFormat,
				GPUTextureUsage.RENDER_ATTACHMENT |
					GPUTextureUsage.TEXTURE_BINDING |
					GPUTextureUsage.COPY_SRC |
					GPUTextureUsage.COPY_DST,
				"Drop Shadow Underlay Spread",
			);
			const encoded = this.encodeSpreadPass(
				commandEncoder,
				device,
				placed,
				spreadTarget,
				width,
				height,
				offsetXTexels,
				offsetYTexels,
				(p.spreadRadius ?? 0) * spatialScale,
				spreadTexels,
				ctx.profiler,
				ctx.timingLabel,
			);
			if (encoded) alpha = spreadTarget;
		}

		if (blurRadius >= PYRAMID_BLUR_MIN_RADIUS) {
			this.encodePyramidResolve(
				commandEncoder,
				device,
				alpha,
				output,
				width,
				height,
				blurRadius,
				[shadowColor.r, shadowColor.g, shadowColor.b, shadowOpacity],
				null,
				ctx.profiler,
				ctx.timingLabel,
			);
		} else {
			const horizontal = this.scratch.acquire(
				device,
				width,
				height,
				this.canvasFormat,
				GPUTextureUsage.RENDER_ATTACHMENT |
					GPUTextureUsage.TEXTURE_BINDING |
					GPUTextureUsage.COPY_SRC |
					GPUTextureUsage.COPY_DST,
				"Drop Shadow Underlay Blur",
			);
			this.renderPass(
				commandEncoder,
				device,
				alpha,
				alpha,
				horizontal,
				this.createUniformBuffer(device, "Drop Shadow Underlay (Horizontal)", {
					...commonUniforms,
					direction: [1.0, 0.0],
					blurRadius,
					offsetX: 0,
					offsetY: 0,
					passType: 1.0,
					spreadRadius: 0,
				}),
				"Underlay Horizontal Blur",
				ctx.profiler,
				ctx.timingLabel,
			);
			this.renderPass(
				commandEncoder,
				device,
				horizontal,
				horizontal,
				output,
				this.createUniformBuffer(device, "Drop Shadow Underlay (Vertical)", {
					...commonUniforms,
					direction: [0.0, 1.0],
					blurRadius,
					offsetX: 0,
					offsetY: 0,
					passType: 3.0,
					spreadRadius: 0,
				}),
				"Underlay Vertical Blur",
				ctx.profiler,
				ctx.timingLabel,
			);
		}
		this.scratch.releaseAll();

		const entry: UnderlayCacheEntry = {
			kind: UNDERLAY_ENTRY_KIND,
			hash,
			texture: output,
			bounds,
			destroy: () => output.destroy(),
		};
		ctx.appearanceCache?.set(filter.uid, entry);

		return {
			texture: createBorrowedTextureRef(output, "appearance-cache"),
			bounds,
			uvRect: FULL_UNDERLAY_UV_RECT,
		};
	}

	public getExpansionMargin(filter: Filter): number {
		const p = (filter as DropShadowFilter).paramData.params;
		return (
			(p.blurRadius ?? 0) * 3 +
			Math.max(Math.abs(p.offsetX ?? 0), Math.abs(p.offsetY ?? 0)) +
			Math.max(p.spreadRadius ?? 0, 0)
		);
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as DropShadowFilter;
		const p = f.paramData.params;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...p,
					offsetX: p.offsetX * scaleX,
					offsetY: p.offsetY * scaleY,
					blurRadius: p.blurRadius * uniformScale,
					spreadRadius:
						p.spreadRadius != null ? p.spreadRadius * uniformScale : undefined,
				},
			},
		};
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		return interpolateDropShadowParams(
			paramsA as DropShadowFilter["paramData"]["params"],
			paramsB as DropShadowFilter["paramData"]["params"],
			t,
		);
	}

	public onAdjustColor(
		params: unknown,
		adjustColor: (color: Color) => Color,
	): unknown {
		const p = params as DropShadowFilter["paramData"]["params"];
		if (!p.shadowColor) return params;
		return { ...p, shadowColor: adjustColor(p.shadowColor) };
	}

	public destroy(): void {
		this.pipeline = null;
		this.bindGroupLayout = null;
		this.uniformView = null;
		this.jfa.destroy();
		this.spreadPipeline = null;
		this.spreadBindGroupLayout = null;
		this.spreadUniformView = null;
		this.pyramidPipeline = null;
		this.pyramidBindGroupLayout = null;
		this.pyramidUniformView = null;
		this.placePipeline = null;
		this.placeBindGroupLayout = null;
		this.placeUniformView = null;
		this.blurPyramid?.destroy();
		this.blurPyramid = null;
		this.sampler = null;
		for (const tex of this.pendingDestroy) tex.destroy();
		this.pendingDestroy.length = 0;
		this.scratch.destroy();
		for (const tex of this.originalCopyPool.values()) tex.destroy();
		this.originalCopyPool.clear();
		this.originalCopyTexture = null;
	}

	private ensureOriginalCopyTexture(
		device: GPUDevice,
		width: number,
		height: number,
	): void {
		if (
			this.originalCopyTexture &&
			this.originalCopySize.width === width &&
			this.originalCopySize.height === height
		) {
			return;
		}

		// Keep one copy texture per recently-seen size: several drop-shadow
		// chains of different sizes run every frame, and a single-slot cache
		// recreated this texture on each switch (hundreds of MB of allocations
		// per second while panning).
		const key = `${width}x${height}`;
		let texture = this.originalCopyPool.get(key);
		if (!texture) {
			if (this.originalCopyPool.size >= MAX_ORIGINAL_COPY_SIZES) {
				for (const [oldKey, old] of this.originalCopyPool) {
					// Deferred: passes encoded this frame may still read it.
					if (old === this.originalCopyTexture) continue;
					this.originalCopyPool.delete(oldKey);
					this.pendingDestroy.push(old);
					break;
				}
			}
			texture = device.createTexture({
				label: "Drop Shadow Original Copy",
				size: { width, height },
				format: this.canvasFormat,
				usage:
					GPUTextureUsage.TEXTURE_BINDING |
					GPUTextureUsage.COPY_DST |
					GPUTextureUsage.RENDER_ATTACHMENT,
			});
			this.originalCopyPool.set(key, texture);
		}
		this.originalCopyTexture = texture;
		this.originalCopySize = { width, height };
	}

	private createUniformBuffer(
		device: GPUDevice,
		label: string,
		values: {
			resolution: [number, number];
			direction: [number, number];
			blurRadius: number;
			offsetX: number;
			offsetY: number;
			shadowR: number;
			shadowG: number;
			shadowB: number;
			shadowOpacity: number;
			passType: number;
			spreadRadius: number;
		},
	): GPUBuffer {
		if (!this.uniformView) {
			throw new Error("DropShadowFilterProcessor not initialized");
		}

		this.uniformView.set(values);

		const buffer = device.createBuffer({
			label,
			size: this.uniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});

		device.queue.writeBuffer(buffer, 0, this.uniformView.arrayBuffer);
		return buffer;
	}

	private renderPass(
		commandEncoder: GPUCommandEncoder,
		device: GPUDevice,
		inputTexture: GPUTexture,
		originalTexture: GPUTexture,
		outputTexture: GPUTexture,
		uniformBuffer: GPUBuffer,
		label: string,
		profiler: FilterProcessorContext["profiler"],
		timingLabel?: string,
	): void {
		if (!this.pipeline || !this.bindGroupLayout || !this.sampler) return;

		const bindGroup = device.createBindGroup({
			label: `Drop Shadow Bind Group (${label})`,
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: uniformBuffer } },
				{ binding: 1, resource: inputTexture.createView() },
				{ binding: 2, resource: this.sampler },
				{ binding: 3, resource: originalTexture.createView() },
				{ binding: 4, resource: this.sampler },
			],
		});

		const pass = commandEncoder.beginRenderPass({
			label: `Drop Shadow Pass (${label})`,
			timestampWrites: profiler?.timestampWrites(
				timingLabel ?? "Drop Shadow Filter",
			),
			colorAttachments: [
				{
					view: outputTexture.createView(),
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

	/**
	 * Offset the source alpha (and, with a non-zero spread, dilate or erode it
	 * through the shared jump-flood distance field — an O(9·log2 r) per-pixel
	 * cost where a per-pixel disc scan would be O(spread²)).
	 */
	private encodeOffsetAndSpread(
		commandEncoder: GPUCommandEncoder,
		device: GPUDevice,
		sourceTexture: GPUTexture,
		targetTexture: GPUTexture,
		width: number,
		height: number,
		offsetXTexels: number,
		offsetYTexels: number,
		spreadRadius: number,
		commonUniforms: {
			resolution: [number, number];
			shadowR: number;
			shadowG: number;
			shadowB: number;
			shadowOpacity: number;
		},
		profiler: FilterProcessorContext["profiler"],
		timingLabel?: string,
	): void {
		const spreadTexels = Math.round(Math.abs(spreadRadius));
		if (
			spreadTexels >= 1 &&
			this.encodeSpreadPass(
				commandEncoder,
				device,
				sourceTexture,
				targetTexture,
				width,
				height,
				offsetXTexels,
				offsetYTexels,
				spreadRadius,
				spreadTexels,
				profiler,
				timingLabel,
			)
		) {
			return;
		}

		const offsetBuffer = this.createUniformBuffer(
			device,
			"Drop Shadow Uniform (Offset)",
			{
				...commonUniforms,
				direction: [0.0, 0.0],
				blurRadius: 0,
				offsetX: offsetXTexels,
				offsetY: offsetYTexels,
				passType: 0.0,
				spreadRadius: 0,
			},
		);

		this.renderPass(
			commandEncoder,
			device,
			sourceTexture,
			// Pass 0 never reads the original; bind the input to satisfy the layout.
			sourceTexture,
			targetTexture,
			offsetBuffer,
			"Offset",
			profiler,
			timingLabel,
		);
	}

	/** Jump-flood spread + offset into `targetTexture`. False when the flood
	 *  field is unavailable (the caller then falls back to a plain offset). */
	private encodeSpreadPass(
		commandEncoder: GPUCommandEncoder,
		device: GPUDevice,
		sourceTexture: GPUTexture,
		targetTexture: GPUTexture,
		width: number,
		height: number,
		offsetXTexels: number,
		offsetYTexels: number,
		spreadRadius: number,
		spreadTexels: number,
		profiler: FilterProcessorContext["profiler"],
		timingLabel?: string,
	): boolean {
		if (
			!this.spreadPipeline ||
			!this.spreadBindGroupLayout ||
			!this.spreadUniformView
		) {
			return false;
		}
		const coordTexture = this.jfa.compute(
			device,
			commandEncoder,
			sourceTexture,
			width,
			height,
			spreadTexels + 1,
			spreadRadius > 0,
		);
		if (!coordTexture) return false;

		this.spreadUniformView.set({
			offsetX: offsetXTexels,
			offsetY: offsetYTexels,
			spreadRadius,
		});
		const spreadUniformBuffer = device.createBuffer({
			label: "Drop Shadow Spread Uniform Buffer",
			size: this.spreadUniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(
			spreadUniformBuffer,
			0,
			this.spreadUniformView.arrayBuffer,
		);

		const spreadBindGroup = device.createBindGroup({
			label: "Drop Shadow Spread Bind Group",
			layout: this.spreadBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: spreadUniformBuffer } },
				{ binding: 1, resource: coordTexture.createView() },
			],
		});
		const spreadPass = commandEncoder.beginRenderPass({
			label: "Drop Shadow Spread Pass",
			timestampWrites: profiler?.timestampWrites(
				timingLabel ?? "Drop Shadow Filter",
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
		spreadPass.setPipeline(this.spreadPipeline);
		spreadPass.setBindGroup(0, spreadBindGroup);
		spreadPass.draw(3, 1, 0, 0);
		spreadPass.end();
		return true;
	}

	/**
	 * Blur `alphaTexture` through the shared pyramid, colorize, and optionally
	 * composite `originalTexture` on top — the wide-radius replacement for the
	 * separable pair of passes.
	 */
	private encodePyramidResolve(
		commandEncoder: GPUCommandEncoder,
		device: GPUDevice,
		alphaTexture: GPUTexture,
		targetTexture: GPUTexture,
		width: number,
		height: number,
		blurRadius: number,
		shadowColor: [number, number, number, number],
		originalTexture: GPUTexture | null,
		profiler: FilterProcessorContext["profiler"],
		timingLabel?: string,
	): void {
		const { blurPyramid, pyramidPipeline, pyramidBindGroupLayout, sampler } =
			this;
		const uniformView = this.pyramidUniformView;
		if (
			!blurPyramid ||
			!pyramidPipeline ||
			!pyramidBindGroupLayout ||
			!uniformView ||
			!sampler
		) {
			return;
		}

		// Same sigma the direct kernel uses, so the two routes agree across the
		// PYRAMID_BLUR_MIN_RADIUS crossover.
		const sigma = Math.max(blurRadius / 2, 0.001);
		const levels = blurPyramid.build(
			commandEncoder,
			alphaTexture,
			width,
			height,
			requiredPyramidLevels(sigma),
			profiler,
			timingLabel ?? "Drop Shadow Filter",
		);
		const { lo, hi, mix } = selectPyramidLevels(sigma, levels.length);
		const levelTexture = (index: number): GPUTexture =>
			index === 0 ? alphaTexture : levels[index - 1].texture;
		const levelCtl = (index: number): BlurTextureCtl =>
			index === 0
				? blurTextureCtl(width, height, alphaTexture)
				: levels[index - 1].ctl;

		uniformView.set({
			shadowColor,
			control: [mix, originalTexture ? 1 : 0, 0, 0],
			loCtl: levelCtl(lo),
			hiCtl: levelCtl(hi),
		});
		const uniformBuffer = device.createBuffer({
			label: "Drop Shadow Pyramid Resolve Uniforms",
			size: uniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(uniformBuffer, 0, uniformView.arrayBuffer);

		const pass = commandEncoder.beginRenderPass({
			label: "Drop Shadow Pass (Pyramid Resolve)",
			timestampWrites: profiler?.timestampWrites(
				timingLabel ?? "Drop Shadow Filter",
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
		pass.setViewport(0, 0, width, height, 0, 1);
		pass.setPipeline(pyramidPipeline);
		pass.setBindGroup(
			0,
			device.createBindGroup({
				label: "Drop Shadow Pyramid Resolve Bind Group",
				layout: pyramidBindGroupLayout,
				entries: [
					{ binding: 0, resource: { buffer: uniformBuffer } },
					{ binding: 1, resource: sampler },
					{ binding: 2, resource: levelTexture(lo).createView() },
					{ binding: 3, resource: levelTexture(hi).createView() },
					{
						binding: 4,
						resource: (originalTexture ?? alphaTexture).createView(),
					},
				],
			}),
		);
		pass.draw(3, 1, 0, 0);
		pass.end();
	}

	/**
	 * Rasterize the coverage mask's world quad into the underlay frame. Drawing
	 * the quad as geometry (rather than remapping a full-frame pass) keeps a
	 * rotated solid's mask projective, and leaves the expansion margin around
	 * it untouched — cleared to transparent for the blur to spread into.
	 */
	private encodeCoveragePlace(
		commandEncoder: GPUCommandEncoder,
		device: GPUDevice,
		coverage: UnderlayProcessorContext["coverage"],
		bounds: { minX: number; minY: number; maxX: number; maxY: number },
		targetTexture: GPUTexture,
		width: number,
		height: number,
		offsetX: number,
		offsetY: number,
	): void {
		const { placePipeline, placeBindGroupLayout, placeUniformView, sampler } =
			this;
		if (
			!placePipeline ||
			!placeBindGroupLayout ||
			!placeUniformView ||
			!sampler
		) {
			return;
		}

		const boundsWidth = bounds.maxX - bounds.minX;
		const boundsHeight = bounds.maxY - bounds.minY;
		// World → underlay NDC. The offset moves the shadow's silhouette, not
		// the frame, so it is folded into the corner positions.
		const toNdc = (point: { x: number; y: number }): [number, number] => [
			((point.x + offsetX - bounds.minX) / boundsWidth) * 2 - 1,
			1 - ((bounds.maxY - (point.y + offsetY)) / boundsHeight) * 2,
		];
		const ndc = coverage.quad.map(toNdc);
		const q = computeQuadProjectiveWeights(coverage.quad);

		placeUniformView.set({
			cornersTlTr: [...ndc[0], ...ndc[1]],
			cornersBrBl: [...ndc[2], ...ndc[3]],
			uvRect: [
				coverage.uvRect.minU,
				coverage.uvRect.minV,
				coverage.uvRect.maxU,
				coverage.uvRect.maxV,
			],
			quadQ: q,
		});
		const uniformBuffer = device.createBuffer({
			label: "Drop Shadow Coverage Place Uniforms",
			size: placeUniformView.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(uniformBuffer, 0, placeUniformView.arrayBuffer);

		const pass = commandEncoder.beginRenderPass({
			label: "Drop Shadow Coverage Place Pass",
			colorAttachments: [
				{
					view: targetTexture.createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
		});
		pass.setViewport(0, 0, width, height, 0, 1);
		pass.setPipeline(placePipeline);
		pass.setBindGroup(
			0,
			device.createBindGroup({
				label: "Drop Shadow Coverage Place Bind Group",
				layout: placeBindGroupLayout,
				entries: [
					{ binding: 0, resource: { buffer: uniformBuffer } },
					{ binding: 1, resource: sampler },
					{ binding: 2, resource: coverage.texture.createView() },
				],
			}),
		);
		pass.draw(6, 1, 0, 0);
		pass.end();
	}
}

// Helpers

/** The underlay texture always spans its whole world bounds. */
const FULL_UNDERLAY_UV_RECT = { minU: 0, minV: 0, maxU: 1, maxV: 1 } as const;

const UNDERLAY_ENTRY_KIND = "drop-shadow-underlay";

/** Cross-frame cached underlay: the texture, the world bounds it spans, and
 *  the content hash of everything that produced it. */
interface UnderlayCacheEntry {
	kind: typeof UNDERLAY_ENTRY_KIND;
	hash: string;
	texture: GPUTexture;
	bounds: {
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
		width: number;
		height: number;
	};
	destroy(): void;
}

function isUnderlayEntry(entry: unknown): entry is UnderlayCacheEntry {
	return (
		typeof entry === "object" &&
		entry !== null &&
		(entry as { kind?: unknown }).kind === UNDERLAY_ENTRY_KIND
	);
}

/**
 * Content hash for a cached underlay. Every term is invariant to viewport pan
 * and zoom and to whatever is behind the element, so scrolling the canvas
 * around a glass solid reuses its shadow instead of re-blurring it; changing
 * the shadow params, the solid's shape or 3D projection (via `coverageHash`
 * and the world quad), or the rasterization DPI regenerates it once.
 */
function underlayHash(
	params: DropShadowParams,
	coverageHash: string,
	quad: QuadCorners,
	spatialScale: number,
): string {
	const shadowColor = params.shadowColor
		? colorToRawRGBA(params.shadowColor)
		: null;
	return [
		coverageHash,
		spatialScale.toFixed(4),
		quad.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(";"),
		params.offsetX,
		params.offsetY,
		params.blurRadius,
		params.spreadRadius ?? 0,
		params.shadowOpacity ?? 0.5,
		shadowColor
			? `${shadowColor.r},${shadowColor.g},${shadowColor.b},${shadowColor.a}`
			: "default",
	].join("|");
}

function interpolateDropShadowParams(
	a: DropShadowFilter["paramData"]["params"],
	b: DropShadowFilter["paramData"]["params"],
	t: number,
): DropShadowFilter["paramData"]["params"] {
	return {
		offsetX: a.offsetX + (b.offsetX - a.offsetX) * t,
		offsetY: a.offsetY + (b.offsetY - a.offsetY) * t,
		blurRadius: a.blurRadius + (b.blurRadius - a.blurRadius) * t,
		shadowColor: lerpOptionalRGBColor(
			a.shadowColor ? toRGBColor(colorToRawRGBA(a.shadowColor)) : undefined,
			b.shadowColor ? toRGBColor(colorToRawRGBA(b.shadowColor)) : undefined,
			t,
		),
		shadowOpacity: lerpOptionalScalar(a.shadowOpacity, b.shadowOpacity, t, 0.5),
		spreadRadius: lerpOptionalScalar(a.spreadRadius, b.spreadRadius, t, 0),
	};
}

/**
 * Size-keyed pool for the shadow's blur intermediates.
 *
 * A texture stays checked out until `releaseAll()`, so one chain never gets
 * the same texture twice (a pyramid level and its own source would otherwise
 * collide when a level's size repeats). Across chains reuse is safe: passes
 * execute in encode order, so the next chain's writes land after the previous
 * chain's reads.
 */
class ScratchTexturePool {
	private free = new Map<string, GPUTexture[]>();
	private busy: Array<{ key: string; texture: GPUTexture }> = [];
	private total = 0;
	private pendingDestroy: GPUTexture[] = [];

	public acquire(
		device: GPUDevice,
		width: number,
		height: number,
		format: GPUTextureFormat,
		usage: GPUTextureUsageFlags,
		label: string,
	): GPUTexture {
		const key = `${width}x${height}:${format}:${usage}`;
		const pooled = this.free.get(key)?.pop();
		if (pooled) {
			this.busy.push({ key, texture: pooled });
			return pooled;
		}
		if (this.total >= MAX_SCRATCH_TEXTURES) this.retireOldestFree();
		const texture = device.createTexture({
			label,
			size: { width, height },
			format,
			usage,
		});
		this.total++;
		this.busy.push({ key, texture });
		return texture;
	}

	/** Return every texture handed out since the last call. */
	public releaseAll(): void {
		for (const { key, texture } of this.busy) {
			const list = this.free.get(key);
			if (list) list.push(texture);
			else this.free.set(key, [texture]);
		}
		this.busy.length = 0;
	}

	/** Destroy textures retired on a previous frame. Called once per frame,
	 *  after the previous frame's submit completed. */
	public flushPendingDestroy(): void {
		for (const texture of this.pendingDestroy) texture.destroy();
		this.pendingDestroy.length = 0;
	}

	public destroy(): void {
		this.releaseAll();
		for (const list of this.free.values()) {
			for (const texture of list) texture.destroy();
		}
		this.free.clear();
		this.total = 0;
		this.flushPendingDestroy();
	}

	private retireOldestFree(): void {
		for (const [key, list] of this.free) {
			const texture = list.pop();
			if (!texture) continue;
			if (list.length === 0) this.free.delete(key);
			// Deferred: passes encoded this frame may still reference it.
			this.pendingDestroy.push(texture);
			this.total--;
			return;
		}
	}
}
