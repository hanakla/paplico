/**
 * DabRenderer - the dab route of the brush engine. Evaluates a stroke's curve
 * matrix into dab instances and draws them with the dab pipelines: the plain
 * painting pipeline, the wet seed pipeline with its six coefficient targets,
 * and the mixed-colors variant fed by MixStrokeRenderer.
 *
 * Committed strokes are evaluated once, cached in StampCache and drawn from
 * the resident stamp store. The live preview stroke re-uses one grow-only
 * buffer and uploads only newly committed dabs plus the volatile tail per
 * frame.
 */

import {
	resolveBrushTextureUid,
	resolveOptionalSourceUid,
	resolveScatterSourceUids,
} from "../../../../brush/brushSource";
import { PREVIEW_ELEMENT_SENTINEL_ID } from "../../../../document/constants";
import {
	type BrushSettings,
	BUILTIN_BRUSH_IDS,
	type CubicBezierSegment,
	type Path,
} from "../../../../schema";
import {
	floatBits,
	hashSegmentsWithMetadata,
} from "../../../../utils/geometry/segmentOps";
import { compileShaderModule } from "../../../../utils/wgpu-utils";
import { RENDER_SAMPLE_COUNT } from "../../CanvasLayerTypes";
import type { StampCache } from "../../caches/StampCache";
import { BoundedStampStore } from "./BoundedStampStore";
import type { BrushFrameBuffers } from "./BrushFrameBuffers";
import type { BrushDrawBindings, StrokeDrawInput } from "./BrushRenderer";
import {
	BrushTextureArrayBuilder,
	type TextureArrayResult,
} from "./BrushTextureArrayBuilder";
import type { BrushTextureManager } from "./BrushTextureManager";
import { evaluateDabs } from "./DabEvaluator";
import { DAB_INSTANCE_FLOATS } from "./DabInstanceLayout";
import { LiveDabAccumulator } from "./LiveDabAccumulator";
import {
	buildBrushDabShader,
	type DabTipMode,
	WET_SEED_TARGETS,
} from "./shaders/brushDab.wgsl";
import { uploadSingleStrokeMeta } from "./strokeMeta";
import {
	buildFalloffLutLayersData,
	FALLOFF_LUT_LAYERS,
	FALLOFF_LUT_SIZE,
} from "./TipMaskBuilder";

export interface DabRendererOptions {
	/** Cap for the resident stamp store, in stamps. Production derives the
	 *  cap from the device limits; tests inject a small value to exercise
	 *  the pooled fallback. */
	maxResidentStamps?: number;
}

interface DabRendererDeps {
	device: GPUDevice;
	canvasFormat: GPUTextureFormat;
	textureManager: BrushTextureManager;
	buffers: BrushFrameBuffers;
	/** Group(1) layout shared with the ribbon pipeline. */
	strokeMetaBindGroupLayout: GPUBindGroupLayout;
	transformsBindGroupLayout: GPUBindGroupLayout;
	maskBindGroupLayout: GPUBindGroupLayout;
	/** Resolved per use, never captured: the cache manager swaps its active
	 *  document scope between frames, so a held StampCache instance would pin
	 *  a stale scope. */
	getStampCache: () => StampCache;
	options?: DabRendererOptions;
}

/** Resolved per-dab colours of a mixing stroke, with the dab buffer they
 *  index into. */
export interface MixedDabSource {
	dabBuffer: GPUBuffer;
	colors: GPUBuffer;
	dabCount: number;
}

/** Per-stroke draw state of the mixing route, built by prepareMixed. */
interface MixedDabStrokeDrawState {
	pipeline: GPURenderPipeline;
	bindGroup0: GPUBindGroup;
	bindGroup1: GPUBindGroup;
	transformsBindGroup: GPUBindGroup | undefined;
	maskBindGroup: GPUBindGroup;
	/** Same buffers the mix pass must read to resolve each dab's brush color. */
	pathMetaBuffer: GPUBuffer;
	colorStopsBuffer: GPUBuffer;
}

/** Texture resolution for a dab stroke: the single brush texture plus
 *  (when scatter/start/end sources are set) the texture-array layout that
 *  dab evaluation packed layer indices against. Carried from resolve time
 *  to draw time so the pooled fallback binds — and, when it must regenerate,
 *  regenerates — with EXACTLY the resident path's parameters. */
interface ResolvedStampTextureSetup {
	effectiveTextureFileUid: string;
	textureArrayResult: TextureArrayResult | null;
	usesTextureArray: boolean;
	variantCount: number;
	startLayerIndex: number;
	endLayerIndex: number;
}

interface DabTipSetup {
	tipMode: DabTipMode;
	textureView: GPUTextureView;
	sampler: GPUSampler;
	textureAspectRatio: number;
	variantCount: number;
	startLayerIndex: number;
	endLayerIndex: number;
}

interface DabPipelineEntry {
	pipeline: GPURenderPipeline;
	bindGroupLayout: GPUBindGroupLayout;
}

export class DabRenderer {
	private readonly device: GPUDevice;
	private readonly canvasFormat: GPUTextureFormat;
	private readonly textureManager: BrushTextureManager;
	private readonly buffers: BrushFrameBuffers;
	private readonly strokeMetaBindGroupLayout: GPUBindGroupLayout;
	private readonly transformsBindGroupLayout: GPUBindGroupLayout;
	private readonly maskBindGroupLayout: GPUBindGroupLayout;
	private readonly getStampCache: () => StampCache;

	/** Resident dab instances keyed by StampCache entry: a cache hit draws
	 *  straight from the GPU with zero uploads. */
	private readonly dabStore: BoundedStampStore;
	/** Settings-object -> JSON fingerprint (settings are immutable). */
	private readonly fingerprintCache = new WeakMap<object, string>();

	/** Live-stroke dab residency: the preview path re-uses one grow-only
	 *  buffer and uploads only newly committed dabs and the volatile tail per
	 *  frame. Grown-out buffers wait one frame before destruction. */
	private readonly live = {
		accumulator: new LiveDabAccumulator(),
		buffer: null as GPUBuffer | null,
		capacityFloats: 0,
		uploadedCommitted: 0,
		retiredBuffers: [] as GPUBuffer[],
	};

	// Dab pipelines, keyed by tip mode / wet-seed / mixed-color variant
	private readonly dabPipelines = new Map<string, DabPipelineEntry>();
	private mixedStrokeMetaBindGroupLayout: GPUBindGroupLayout | null = null;
	private textureArrayBuilder: BrushTextureArrayBuilder | null = null;
	private readonly textureViewCache = new Map<string, GPUTextureView>();
	/** The procedural tip's falloff LUT, created on first use. */
	private falloffLut: {
		texture: GPUTexture;
		view: GPUTextureView;
		sampler: GPUSampler;
	} | null = null;
	/** The 1x1 white grain bound when a brush has no grain texture. */
	private blankGrain: { texture: GPUTexture; view: GPUTextureView } | null =
		null;
	private grainSampler: GPUSampler | null = null;

	public constructor(deps: DabRendererDeps) {
		this.device = deps.device;
		this.canvasFormat = deps.canvasFormat;
		this.textureManager = deps.textureManager;
		this.buffers = deps.buffers;
		this.strokeMetaBindGroupLayout = deps.strokeMetaBindGroupLayout;
		this.transformsBindGroupLayout = deps.transformsBindGroupLayout;
		this.maskBindGroupLayout = deps.maskBindGroupLayout;
		this.getStampCache = deps.getStampCache;
		this.dabStore = new BoundedStampStore(deps.device, {
			floatsPerStamp: DAB_INSTANCE_FLOATS,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			label: "Resident Dab Instances",
			maxCapacityStamps: deps.options?.maxResidentStamps,
		});
	}

	/** Per-frame housekeeping: return store ranges released by evicted
	 *  StampCache entries and free grown-out live buffers. Both are deferred
	 *  to this frame boundary so last frame's encoded draws kept their data. */
	public beginFrame(): void {
		this.dabStore.flushPendingReleases();
		for (const buffer of this.live.retiredBuffers) buffer.destroy();
		this.live.retiredBuffers.length = 0;
	}

	/** Draw one dab stroke into an open render pass. */
	public render(
		pass: GPURenderPassEncoder,
		input: StrokeDrawInput,
		bindings: BrushDrawBindings,
	): void {
		const { path, segments, settings } = input;
		const tip = this.resolveDabTipSetup(settings);
		if (!tip) return;
		const {
			tipMode,
			textureView,
			sampler,
			textureAspectRatio,
			variantCount,
			startLayerIndex,
			endLayerIndex,
		} = tip;

		let dabBuffer: GPUBuffer;
		let dabCount: number;
		let dabFirstInstance = 0;
		if (
			path.id === PREVIEW_ELEMENT_SENTINEL_ID &&
			// Wash previews draw into a fresh per-frame offscreen texture (the
			// per-appearance plan), so the live buffer's cross-frame delta
			// model does not apply — they take the frame-pooled path below.
			settings.paintMode !== "wash" &&
			(path.pathStart ?? 0) === 0 &&
			(path.pathEnd ?? 1) === 1 &&
			path.strokeWidths == null
		) {
			const live = this.uploadLiveDabs(segments, settings, {
				textureAspectRatio,
				variantCount,
				startLayerIndex,
			});
			if (!live) return;
			dabBuffer = live.buffer;
			dabCount = live.count;
		} else if (path.id === PREVIEW_ELEMENT_SENTINEL_ID) {
			// Wash previews: fresh evaluation into the frame pool. Caching would
			// churn StampCache (the geometry hash changes every pointermove) and
			// residency would leak lease turnover for a one-frame buffer.
			const dabs = evaluateDabs(segments, settings, {
				textureAspectRatio,
				variantCount,
				startLayerIndex,
			});
			if (dabs.count === 0) return;
			dabBuffer = this.uploadFrameDabs(dabs.data, dabs.count);
			dabCount = dabs.count;
		} else {
			// Committed strokes: cache the evaluated dab buffer so pans/zooms
			// re-upload but never re-evaluate.
			let fingerprint = this.fingerprintCache.get(settings);
			if (!fingerprint) {
				fingerprint = JSON.stringify(settings);
				this.fingerprintCache.set(settings, fingerprint);
			}
			const cacheKey = `${path.id}:v2dab:${fingerprint}:${textureAspectRatio}:${variantCount}:${startLayerIndex}:${endLayerIndex}:${hashStampInput(path, segments)}`;
			const stampCache = this.getStampCache();
			let cached = stampCache.get(cacheKey);
			let retained = true;
			if (!cached) {
				const dabs = evaluateDabs(segments, settings, {
					pathStart: path.pathStart ?? 0,
					pathEnd: path.pathEnd ?? 1,
					strokeWidths: path.strokeWidths,
					strokeWidthsBaked: path.strokeWidthsBaked,
					textureAspectRatio,
					variantCount,
					startLayerIndex,
					endLayerIndex,
				});
				cached = {
					data: dabs.data.slice(0, dabs.count * DAB_INSTANCE_FLOATS),
					count: dabs.count,
				};
				retained = stampCache.set(cacheKey, cached, path.id);
			}
			if (cached.count === 0) return;

			// Lazy GPU residency: the entry's data becomes the store's regrow
			// mirror; the cache entry owns the lease (released on eviction).
			// Only retained entries may residentize — otherwise nothing would
			// ever release the lease.
			if (
				!cached.residentDab &&
				retained &&
				this.dabStore.canFit(cached.count)
			) {
				const handle = this.dabStore.alloc(cached.data);
				if (handle) {
					cached.residentDab = { handle };
					stampCache.commitResident(cacheKey);
				}
			}

			dabCount = cached.count;
			if (cached.residentDab) {
				dabBuffer = this.dabStore.buffer();
				dabFirstInstance = cached.residentDab.handle.firstStamp;
			} else {
				dabBuffer = this.uploadFrameDabs(cached.data, cached.count);
			}
		}

		const meta = uploadSingleStrokeMeta(this.device, this.buffers, input);
		const { pipeline, bindGroupLayout } = this.ensureDabPipeline(tipMode);
		const bindGroup0 = this.device.createBindGroup({
			label: "Brush Dab Bind Group 0",
			layout: bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: bindings.uniformBuffer } },
				{ binding: 1, resource: { buffer: dabBuffer } },
				{ binding: 2, resource: textureView },
				{ binding: 3, resource: sampler },
				...this.grainBindings(settings),
			],
		});
		const bindGroup1 = this.device.createBindGroup({
			label: "Brush Dab Bind Group 1",
			layout: this.strokeMetaBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: meta.pathMetaBuffer } },
				{ binding: 1, resource: { buffer: meta.colorStopsBuffer } },
			],
		});

		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bindGroup0);
		pass.setBindGroup(1, bindGroup1);
		if (bindings.transformsBindGroup) {
			pass.setBindGroup(2, bindings.transformsBindGroup);
		}
		pass.setBindGroup(3, bindings.maskBindGroup);
		pass.draw(6, dabCount, 0, dabFirstInstance);
	}

	/**
	 * Draw a wet stroke's dabs into the wet layer's seed targets.
	 *
	 * The pass belongs to the caller (WetLayerPass consumes what lands here),
	 * which is why this takes an open encoder: the seed targets are cleared to
	 * the stroke's base coefficients so texels no dab covers keep them.
	 * Given `mixed`, the seed carries what the stroke picked up instead of the
	 * brush colour.
	 */
	public renderWetSeeds(
		pass: GPURenderPassEncoder,
		input: StrokeDrawInput,
		bindings: BrushDrawBindings,
		mixed?: MixedDabSource,
	): void {
		const { path, segments, settings } = input;
		const tip = this.resolveDabTipSetup(settings);
		if (!tip) return;

		const dabs = evaluateDabs(segments, settings, {
			pathStart: path.pathStart ?? 0,
			pathEnd: path.pathEnd ?? 1,
			strokeWidths: path.strokeWidths,
			strokeWidthsBaked: path.strokeWidthsBaked,
			textureAspectRatio: tip.textureAspectRatio,
			variantCount: tip.variantCount,
			startLayerIndex: tip.startLayerIndex,
			endLayerIndex: tip.endLayerIndex,
		});
		if (dabs.count === 0) return;
		const dabBuffer = this.uploadFrameDabs(dabs.data, dabs.count);
		const meta = uploadSingleStrokeMeta(this.device, this.buffers, input);

		const { pipeline, bindGroupLayout } = this.ensureWetSeedPipeline(
			tip.tipMode,
			mixed != null,
		);
		pass.setPipeline(pipeline);
		pass.setBindGroup(
			0,
			this.device.createBindGroup({
				label: "Wet Seed Bind Group 0",
				layout: bindGroupLayout,
				entries: [
					{ binding: 0, resource: { buffer: bindings.uniformBuffer } },
					{ binding: 1, resource: { buffer: mixed?.dabBuffer ?? dabBuffer } },
					{ binding: 2, resource: tip.textureView },
					{ binding: 3, resource: tip.sampler },
					...this.grainBindings(settings),
				],
			}),
		);
		pass.setBindGroup(
			1,
			this.device.createBindGroup({
				label: "Wet Seed Bind Group 1",
				layout: mixed
					? this.ensureMixedStrokeMetaBindGroupLayout()
					: this.strokeMetaBindGroupLayout,
				entries: [
					{ binding: 0, resource: { buffer: meta.pathMetaBuffer } },
					{ binding: 1, resource: { buffer: meta.colorStopsBuffer } },
					...(mixed
						? [{ binding: 2, resource: { buffer: mixed.colors } }]
						: []),
				],
			}),
		);
		if (bindings.transformsBindGroup) {
			pass.setBindGroup(2, bindings.transformsBindGroup);
		}
		pass.setBindGroup(3, bindings.maskBindGroup);
		pass.draw(6, mixed?.dabCount ?? dabs.count);
	}

	/** Set up one mixing stroke's draw state (pipeline + bind groups). The
	 *  mix driver draws each chunk into its own render pass via
	 *  drawMixedChunk as the chunked mix pass resolves colors. Buffers are
	 *  stroke-local (dab 0 at buffer start) so the flat instance index lines
	 *  up with the mixedColors buffer. */
	public prepareMixed(
		input: Omit<StrokeDrawInput, "segments">,
		mixed: { dabBuffer: GPUBuffer; colors: GPUBuffer },
		bindings: BrushDrawBindings,
	): MixedDabStrokeDrawState | null {
		const tip = this.resolveDabTipSetup(input.settings);
		if (!tip) return null;
		const { pipeline, bindGroupLayout } = this.ensureDabPipeline(
			tip.tipMode,
			true,
		);
		const meta = uploadSingleStrokeMeta(this.device, this.buffers, input);

		const bindGroup0 = this.device.createBindGroup({
			label: "Brush Dab Bind Group 0 (mixed)",
			layout: bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: bindings.uniformBuffer } },
				{ binding: 1, resource: { buffer: mixed.dabBuffer } },
				{ binding: 2, resource: tip.textureView },
				{ binding: 3, resource: tip.sampler },
				...this.grainBindings(input.settings),
			],
		});
		const bindGroup1 = this.device.createBindGroup({
			label: "Brush Dab Bind Group 1 (mixed)",
			layout: this.ensureMixedStrokeMetaBindGroupLayout(),
			entries: [
				{ binding: 0, resource: { buffer: meta.pathMetaBuffer } },
				{ binding: 1, resource: { buffer: meta.colorStopsBuffer } },
				{ binding: 2, resource: { buffer: mixed.colors } },
			],
		});
		return {
			pipeline,
			bindGroup0,
			bindGroup1,
			transformsBindGroup: bindings.transformsBindGroup,
			maskBindGroup: bindings.maskBindGroup,
			pathMetaBuffer: meta.pathMetaBuffer,
			colorStopsBuffer: meta.colorStopsBuffer,
		};
	}

	/** Draw one resolved chunk of a mixing stroke into an open render pass. */
	public drawMixedChunk(
		pass: GPURenderPassEncoder,
		stroke: MixedDabStrokeDrawState,
		firstDab: number,
		dabCount: number,
	): void {
		pass.setPipeline(stroke.pipeline);
		pass.setBindGroup(0, stroke.bindGroup0);
		pass.setBindGroup(1, stroke.bindGroup1);
		if (stroke.transformsBindGroup) {
			pass.setBindGroup(2, stroke.transformsBindGroup);
		}
		pass.setBindGroup(3, stroke.maskBindGroup);
		pass.draw(6, dabCount, 0, firstDab);
	}

	/** Falloff LUT texture for the mix pass's footprint weighting. */
	public getFalloffLutTexture(): GPUTexture {
		return this.ensureFalloffLut().texture;
	}

	public destroy(): void {
		this.dabStore.destroy();
		const { live } = this;
		live.buffer?.destroy();
		live.buffer = null;
		live.capacityFloats = 0;
		live.uploadedCommitted = 0;
		for (const buffer of live.retiredBuffers) buffer.destroy();
		live.retiredBuffers.length = 0;
		this.textureViewCache.clear();
		this.dabPipelines.clear();
		this.mixedStrokeMetaBindGroupLayout = null;
		this.textureArrayBuilder?.destroy();
		this.textureArrayBuilder = null;
		this.falloffLut?.texture.destroy();
		this.falloffLut = null;
		this.blankGrain?.texture.destroy();
		this.blankGrain = null;
		this.grainSampler = null;
	}

	/** Upload evaluated dabs into a frame-pooled instance buffer. */
	private uploadFrameDabs(data: Float32Array, count: number): GPUBuffer {
		const floatCount = count * DAB_INSTANCE_FLOATS;
		const buffer = this.buffers.acquireInstances(floatCount * 4);
		const view = data.subarray(0, floatCount);
		this.device.queue.writeBuffer(
			buffer,
			0,
			view.buffer as ArrayBuffer,
			view.byteOffset,
			view.byteLength,
		);
		return buffer;
	}

	/**
	 * Incremental upload for the live preview stroke: newly committed dabs
	 * append into a persistent grow-only buffer, the volatile tail rewrites
	 * behind them every frame.
	 */
	private uploadLiveDabs(
		segments: CubicBezierSegment[],
		settings: BrushSettings,
		options: {
			textureAspectRatio: number;
			variantCount: number;
			startLayerIndex: number;
		},
	): { buffer: GPUBuffer; count: number } | null {
		const { live } = this;
		const frame = live.accumulator.update(segments, settings, options);
		if (frame.totalCount === 0) return null;
		if (frame.reset || frame.committedCount < live.uploadedCommitted) {
			live.uploadedCommitted = 0;
		}

		const neededFloats = frame.totalCount * DAB_INSTANCE_FLOATS;
		if (!live.buffer || live.capacityFloats < neededFloats) {
			if (live.buffer) live.retiredBuffers.push(live.buffer);
			live.capacityFloats = Math.max(
				neededFloats * 2,
				4096 * DAB_INSTANCE_FLOATS,
			);
			live.buffer = this.device.createBuffer({
				label: "Live Dab Instances",
				size: live.capacityFloats * 4,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			});
			live.uploadedCommitted = 0;
		}

		if (frame.committedCount > live.uploadedCommitted) {
			const startFloat = live.uploadedCommitted * DAB_INSTANCE_FLOATS;
			const endFloat = frame.committedCount * DAB_INSTANCE_FLOATS;
			this.device.queue.writeBuffer(
				live.buffer,
				startFloat * 4,
				frame.committedData.buffer as ArrayBuffer,
				frame.committedData.byteOffset + startFloat * 4,
				(endFloat - startFloat) * 4,
			);
			live.uploadedCommitted = frame.committedCount;
		}
		if (frame.tailCount > 0) {
			const tailFloats = frame.tailCount * DAB_INSTANCE_FLOATS;
			this.device.queue.writeBuffer(
				live.buffer,
				frame.committedCount * DAB_INSTANCE_FLOATS * 4,
				frame.tailData.buffer as ArrayBuffer,
				frame.tailData.byteOffset,
				tailFloats * 4,
			);
		}
		return { buffer: live.buffer, count: frame.totalCount };
	}

	/** Resolve the tip pipeline variant + texture bindings for the settings.
	 *  Shared by the plain dab draw, the wet seed draw and the mixing route. */
	private resolveDabTipSetup(settings: BrushSettings): DabTipSetup | null {
		if (settings.tip?.kind !== "image") {
			const falloff = this.ensureFalloffLut();
			return {
				tipMode: "procedural",
				textureView: falloff.view,
				sampler: falloff.sampler,
				textureAspectRatio: 1,
				variantCount: 0,
				startLayerIndex: -1,
				endLayerIndex: -1,
			};
		}

		const setup = this.resolveScatterTextureSetup(settings);
		const textureAspectRatio = this.textureManager.getTextureAspectRatio(
			setup.effectiveTextureFileUid,
		);
		let tipMode: DabTipMode;
		let textureView: GPUTextureView;
		if (setup.textureArrayResult) {
			tipMode = "imageArray";
			textureView = setup.textureArrayResult.texture.createView({
				dimension: "2d-array",
			});
		} else {
			tipMode = "image";
			const uid = this.resolveTextureUid(setup.effectiveTextureFileUid);
			const texture = this.textureManager.getTexture(uid);
			if (!texture) return null;
			let view = this.textureViewCache.get(uid);
			if (!view) {
				view = texture.createView();
				this.textureViewCache.set(uid, view);
			}
			textureView = view;
		}
		return {
			tipMode,
			textureView,
			// Trilinear filtering over the tip's mip chain. The ribbon pipeline
			// keeps its own level-0-pinned sampler instead.
			sampler: this.textureManager.getMipSampler(),
			textureAspectRatio,
			variantCount: setup.variantCount,
			startLayerIndex: setup.startLayerIndex,
			endLayerIndex: setup.endLayerIndex,
		};
	}

	/** Resolve the brush texture and (when scatter/start/end sources are set)
	 *  the texture-array layout. Array builds must match the stamp generation
	 *  parameters, or a cache entry created by one route would render wrong
	 *  on another. */
	private resolveScatterTextureSetup(
		settings: BrushSettings,
	): ResolvedStampTextureSetup {
		const tip = settings.tip?.kind === "image" ? settings.tip : null;
		const effectiveTextureFileUid =
			resolveBrushTextureUid(settings, this.textureManager) ??
			BUILTIN_BRUSH_IDS.softCircle;

		// Def sources stay unresolved here (built-in fallback): canvas-format
		// def textures are not copy-compatible with the rgba8unorm array.
		const startUid = resolveOptionalSourceUid(tip?.startSource);
		const endUid = resolveOptionalSourceUid(tip?.endSource);
		// The first source is the tip itself; the rest are the variants a dab
		// picks between.
		const scatterUids = resolveScatterSourceUids(tip?.sources.slice(1));
		const usesTextureArray =
			scatterUids.length > 0 || startUid != null || endUid != null;

		let textureArrayResult: TextureArrayResult | null = null;
		let variantCount = 0;
		let startLayerIndex = -1;
		let endLayerIndex = -1;
		if (usesTextureArray) {
			const allUids = [effectiveTextureFileUid, ...scatterUids];
			if (startUid) allUids.push(startUid);
			if (endUid) allUids.push(endUid);
			textureArrayResult = this.ensureTextureArrayBuilder().build(allUids);
			if (textureArrayResult) {
				variantCount =
					scatterUids.length > 0 ? textureArrayResult.layerUids.length : 0;
				if (startUid) {
					startLayerIndex = textureArrayResult.layerUids.indexOf(startUid);
				}
				if (endUid) {
					endLayerIndex = textureArrayResult.layerUids.indexOf(endUid);
				}
			}
		}
		return {
			effectiveTextureFileUid,
			textureArrayResult,
			usesTextureArray,
			variantCount,
			startLayerIndex,
			endLayerIndex,
		};
	}

	/** Lazy-init the scatter texture-array builder. Only image tips with
	 *  scatter/start/end sources need it, so it stays unbuilt otherwise. */
	private ensureTextureArrayBuilder(): BrushTextureArrayBuilder {
		this.textureArrayBuilder ??= new BrushTextureArrayBuilder(
			this.device,
			this.textureManager,
		);
		return this.textureArrayBuilder;
	}

	private resolveTextureUid(preferredUid: string): string {
		if (this.textureManager.hasTexture(preferredUid)) return preferredUid;
		if (this.textureManager.hasTexture(BUILTIN_BRUSH_IDS.softCircle)) {
			return BUILTIN_BRUSH_IDS.softCircle;
		}
		return preferredUid;
	}

	private ensureDabPipeline(
		mode: DabTipMode,
		mixedColors = false,
	): DabPipelineEntry {
		const cacheKey = mixedColors ? `${mode}:mixed` : mode;
		const existing = this.dabPipelines.get(cacheKey);
		if (existing) return existing;

		const { module } = compileShaderModule(this.device, {
			label: `Brush Dab Shader (${cacheKey})`,
			code: buildBrushDabShader({ tipMode: mode, mixedColors }),
		});
		const bindGroupLayout = this.createDabBindGroupLayout(mode, cacheKey);
		const pipelineLayout = this.device.createPipelineLayout({
			label: `Brush Dab Pipeline Layout (${cacheKey})`,
			bindGroupLayouts: [
				bindGroupLayout,
				mixedColors
					? this.ensureMixedStrokeMetaBindGroupLayout()
					: this.strokeMetaBindGroupLayout,
				this.transformsBindGroupLayout,
				this.maskBindGroupLayout,
			],
		});
		const blendState: GPUBlendState = {
			color: {
				srcFactor: "one",
				dstFactor: "one-minus-src-alpha",
				operation: "add",
			},
			alpha: {
				srcFactor: "one",
				dstFactor: "one-minus-src-alpha",
				operation: "add",
			},
		};
		const pipeline = this.device.createRenderPipeline({
			label: `Brush Dab Pipeline (${cacheKey})`,
			layout: pipelineLayout,
			vertex: { module, entryPoint: "vs_main" },
			fragment: {
				module,
				entryPoint: "fs_main",
				targets: [{ format: this.canvasFormat, blend: blendState }],
			},
			primitive: { topology: "triangle-list", cullMode: "none" },
			multisample: { count: RENDER_SAMPLE_COUNT },
		});

		const entry = { pipeline, bindGroupLayout };
		this.dabPipelines.set(cacheKey, entry);
		return entry;
	}

	/** Dab pipeline writing the wet seed targets. Separate from the painting
	 *  pipeline because it has no depth attachment and six colour targets. */
	private ensureWetSeedPipeline(
		mode: DabTipMode,
		mixed: boolean,
	): DabPipelineEntry {
		const cacheKey = `${mode}:wetSeed${mixed ? ":mixed" : ""}`;
		const existing = this.dabPipelines.get(cacheKey);
		if (existing) return existing;

		const { module } = compileShaderModule(this.device, {
			label: `Brush Dab Shader (${cacheKey})`,
			code: buildBrushDabShader({
				tipMode: mode,
				wetSeed: true,
				mixedColors: mixed,
			}),
		});
		const bindGroupLayout = this.createDabBindGroupLayout(mode, cacheKey);
		const pipeline = this.device.createRenderPipeline({
			label: `Brush Dab Pipeline (${cacheKey})`,
			layout: this.device.createPipelineLayout({
				label: `Brush Dab Pipeline Layout (${cacheKey})`,
				bindGroupLayouts: [
					bindGroupLayout,
					mixed
						? this.ensureMixedStrokeMetaBindGroupLayout()
						: this.strokeMetaBindGroupLayout,
					this.transformsBindGroupLayout,
					this.maskBindGroupLayout,
				],
			}),
			vertex: { module, entryPoint: "vs_main" },
			fragment: {
				module,
				entryPoint: "fs_wet",
				targets: [...WET_SEED_TARGETS],
			},
			primitive: { topology: "triangle-list", cullMode: "none" },
			multisample: { count: RENDER_SAMPLE_COUNT },
		});

		const entry = { pipeline, bindGroupLayout };
		this.dabPipelines.set(cacheKey, entry);
		return entry;
	}

	/** Group 0 layout of every dab pipeline: viewport uniform, dab instances,
	 *  the tip texture/sampler and the paper grain pair. */
	private createDabBindGroupLayout(
		mode: DabTipMode,
		cacheKey: string,
	): GPUBindGroupLayout {
		return this.device.createBindGroupLayout({
			label: `Brush Dab Bind Group Layout 0 (${cacheKey})`,
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.VERTEX,
					buffer: { type: "uniform" },
				},
				{
					// The fragment stage reads per-dab extras via the flat
					// instance index (packed color, hardness layer, wet seeds).
					binding: 1,
					visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					buffer: { type: "read-only-storage" },
				},
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					texture: {
						sampleType: "float",
						viewDimension: mode === "image" ? "2d" : "2d-array",
					},
				},
				{
					binding: 3,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "filtering" },
				},
				{
					binding: 4,
					visibility: GPUShaderStage.FRAGMENT,
					texture: { sampleType: "float" },
				},
				{
					binding: 5,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "filtering" },
				},
			],
		});
	}

	/** Group(1) layout of the mixing route: pathMetas + colorStops + the
	 *  per-dab resolved colors from the chunked mix pass. */
	private ensureMixedStrokeMetaBindGroupLayout(): GPUBindGroupLayout {
		this.mixedStrokeMetaBindGroupLayout ??= this.device.createBindGroupLayout({
			label: "Brush Dab Bind Group Layout 1 (mixed)",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
					buffer: { type: "read-only-storage" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "read-only-storage" },
				},
				{
					binding: 2,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "read-only-storage" },
				},
			],
		});
		return this.mixedStrokeMetaBindGroupLayout;
	}

	/** Grain texture + sampler entries for a dab bind group. Falls back to a
	 *  1x1 white texture, which leaves every grain mode a no-op. */
	private grainBindings(settings: BrushSettings): GPUBindGroupEntry[] {
		const grain = settings.grain;
		let view: GPUTextureView | null = null;
		if (grain) {
			const uid =
				grain.source.kind === "file"
					? grain.source.fileUid
					: this.textureManager.resolveDefTextureUid(grain.source.defId);
			const texture = uid != null ? this.textureManager.getTexture(uid) : null;
			if (texture) view = texture.createView();
		}
		return [
			{ binding: 4, resource: view ?? this.ensureBlankGrainView() },
			{ binding: 5, resource: this.ensureGrainSampler() },
		];
	}

	private ensureBlankGrainView(): GPUTextureView {
		if (this.blankGrain) return this.blankGrain.view;
		const texture = this.device.createTexture({
			label: "Blank Grain",
			size: [1, 1],
			format: "r8unorm",
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		this.device.queue.writeTexture(
			{ texture },
			new Uint8Array([255]),
			{ bytesPerRow: 1 },
			[1, 1],
		);
		this.blankGrain = { texture, view: texture.createView() };
		return this.blankGrain.view;
	}

	private ensureGrainSampler(): GPUSampler {
		this.grainSampler ??= this.device.createSampler({
			label: "Grain Sampler",
			magFilter: "linear",
			minFilter: "linear",
			mipmapFilter: "linear",
			addressModeU: "repeat",
			addressModeV: "repeat",
		});
		return this.grainSampler;
	}

	/** 32-layer falloff LUT (r8unorm 256x1) for procedural tips. */
	private ensureFalloffLut(): NonNullable<DabRenderer["falloffLut"]> {
		if (this.falloffLut) return this.falloffLut;
		const texture = this.device.createTexture({
			label: "Brush Dab Falloff LUT",
			size: [FALLOFF_LUT_SIZE, 1, FALLOFF_LUT_LAYERS],
			format: "r8unorm",
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		const layers = buildFalloffLutLayersData();
		for (let layer = 0; layer < layers.length; layer++) {
			this.device.queue.writeTexture(
				{ texture, origin: [0, 0, layer] },
				layers[layer],
				{ bytesPerRow: FALLOFF_LUT_SIZE, rowsPerImage: 1 },
				[FALLOFF_LUT_SIZE, 1, 1],
			);
		}
		this.falloffLut = {
			texture,
			view: texture.createView({ dimension: "2d-array" }),
			sampler: this.device.createSampler({
				magFilter: "linear",
				minFilter: "linear",
				addressModeU: "clamp-to-edge",
				addressModeV: "clamp-to-edge",
			}),
		};
		return this.falloffLut;
	}
}

function hashStampInput(path: Path, segments: CubicBezierSegment[]): string {
	let h = hashSegmentsWithMetadata(segments);
	h = (h * 31 + floatBits(path.pathStart ?? 0)) | 0;
	h = (h * 31 + floatBits(path.pathEnd ?? 1)) | 0;
	h = (h * 31 + (path.strokeWidthsBaked ? 1 : 0)) | 0;
	const strokeWidths = path.strokeWidths;
	if (strokeWidths) {
		h = (h * 31 + strokeWidths.length) | 0;
		for (let i = 0; i < strokeWidths.length; i++) {
			const width = strokeWidths[i];
			h = (h * 31 + floatBits(width.t)) | 0;
			h = (h * 31 + floatBits(width.side1)) | 0;
			h = (h * 31 + floatBits(width.side2)) | 0;
		}
	}
	return h.toString(36);
}
