/**
 * StrokeBatchContext - GPU pipelines + batch state for dab and ribbon
 * strokes. CanvasLayer and PathElementRenderer call it directly with a
 * StrokeDrawInput whose route and appearance they resolved once.
 *
 * Both pipelines consume BrushSettingsV2: the dab pipeline evaluates the
 * curve matrix into DabEvaluator instances, and the ribbon pipeline instances
 * one bezier segment per RibbonGenerator entry with the same v2 size/flow
 * curves applied at segment endpoints.
 *
 * Ribbon strokes accumulate through beginBatch/addToBatch/flushBatch so paths
 * sharing a texture issue one draw call. Dab strokes bypass that accumulator:
 * CanvasLayer routes them straight to render(), which draws from the resident
 * stamp store.
 */

import { neutralizeSizeCurves } from "../../../../brush/access";
import {
	resolveBrushTextureUid,
	resolveOptionalSourceUid,
	resolveScatterSourceUids,
} from "../../../../brush/brushSource";
import { PREVIEW_ELEMENT_SENTINEL_ID } from "../../../../document/constants";
import type { RibbonConfig } from "../../../../schema";
import {
	type BrushSettingsV2,
	BUILTIN_BRUSH_IDS,
	type CubicBezierSegment,
	colorToRawRGBA,
	type Path,
	type StrokeColor,
} from "../../../../schema";
import { calculateElementBounds } from "../../../../utils/geometry/bounds";
import {
	floatBits,
	hashSegmentsWithMetadata,
} from "../../../../utils/geometry/segmentOps";
import { compileShaderModule } from "../../../../utils/wgpu-utils";
import {
	buildBrushDabShader,
	type DabTipMode,
	WET_SEED_TARGETS,
} from "../../../shaders/brushDab.wgsl";
import { PATH_META_FLOATS } from "../../../shaders/dabColor.wgsl";
import { RIBBON_STROKE_SHADER } from "../../../shaders/ribbonStroke.wgsl";
import { type PipelineType, RENDER_SAMPLE_COUNT } from "../../CanvasLayerTypes";
import type { StampCache } from "../../caches/StampCache";
import {
	BrushTextureArrayBuilder,
	type TextureArrayResult,
} from "../brush/BrushTextureArrayBuilder";
import type { BrushTextureManager } from "../brush/BrushTextureManager";
import { evaluateDabs } from "../brush/DabEvaluator";
import { DAB_INSTANCE_FLOATS } from "../brush/DabInstanceLayout";
import { LiveDabAccumulator } from "../brush/LiveDabAccumulator";
import {
	generateRibbonInstances,
	RIBBON_FLOATS_PER_INSTANCE,
	type RibbonOptions,
	type RibbonStrokeInput,
} from "../brush/RibbonGenerator";
import {
	buildFalloffLutLayersData,
	FALLOFF_LUT_LAYERS,
	FALLOFF_LUT_SIZE,
} from "../brush/TipMaskBuilder";
import { GeometryStore } from "../GeometryStore";
import { BoundedStampStore } from "./BoundedStampStore";

/** Ribbon: subdivisions per bezier segment */
const RIBBON_STEPS = 32;
/** Ribbon: vertices per segment instance (triangle list) */
const RIBBON_VERTICES_PER_SEGMENT = RIBBON_STEPS * 6;

/** PathMeta: 16 floats (64 bytes) per path entry */

/** ColorStop: 6 floats (24 bytes) per stop */
const COLOR_STOP_FLOATS = 6;

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

export interface StrokeBatchContextOptions {
	/** Cap for the resident stamp store, in stamps. Production derives the
	 *  cap from the device limits; tests inject a small value to exercise
	 *  the pooled fallback. */
	maxResidentStamps?: number;
}

/**
 * One stroke appearance, resolved by the caller. The route decision and the
 * appearance lookup happen once at the call site; nothing here re-reads
 * `path.filters`.
 */
export interface StrokeDrawInput {
	/** Geometry owner: strokeWidths / pathStart / pathEnd, and the bounds a
	 *  "within" gradient spans. */
	path: Path;
	segments: CubicBezierSegment[];
	strokeColor: StrokeColor;
	/** Routed settings (`resolveBrushRenderRoute(...).settings`). */
	settings: BrushSettingsV2;
	alphaMultiplier: number;
	transformIndex: number;
}

/** Per-stroke draw state of the mixing route (see prepareMixedDabStroke). */
export interface MixedDabStrokeDrawState {
	pipeline: GPURenderPipeline;
	bindGroup0: GPUBindGroup;
	bindGroup1: GPUBindGroup;
	/** Same buffers the mix pass must read to resolve each dab's brush color. */
	pathMetaBuffer: GPUBuffer;
	colorStopsBuffer: GPUBuffer;
}

export class StrokeBatchContext {
	private device: GPUDevice;
	private brushBindGroupLayout: GPUBindGroupLayout;
	private textureManager: BrushTextureManager;
	private uniformBuffer: GPUBuffer; // Shared uniform buffer (viewport info)
	private activeUniformBuffer: GPUBuffer | null = null;

	// Buffer pools (grow-only, reset per frame)
	private stampBufferPool: Array<{ buffer: GPUBuffer; size: number }> = [];
	private pathMetaBufferPool: Array<{ buffer: GPUBuffer; size: number }> = [];
	private colorStopsBufferPool: Array<{ buffer: GPUBuffer; size: number }> = [];
	private poolIdx = 0;
	private pathMetaPoolIdx = 0;
	private colorStopsPoolIdx = 0;

	// Texture view cache
	private textureViewCache: Map<string, GPUTextureView> = new Map();

	// Bind group cache (flushBatch, ribbon)
	private cachedBindGroup1: GPUBindGroup | null = null;
	private cachedBG1PathMetaBuf: GPUBuffer | null = null;
	private cachedBG1ColorStopsBuf: GPUBuffer | null = null;

	// ── Batch accumulation buffers ──
	// PathMeta (per-path color/gradient info) — used by the ribbon path
	private batchPathMetas: Float32Array = new Float32Array(0);
	private batchPathCount = 0;
	// ColorStops (every path's gradient stops, concatenated)
	private batchColorStops: Float32Array = new Float32Array(0);
	private batchColorStopCount = 0;

	// ── Resident stamp stores ──
	// Dab instances + per-stroke path metas + color stops live in
	// persistent stores keyed by the StampCache entry: a cache hit draws
	// straight from the GPU with zero uploads and no per-frame pathIndex
	// rewrite (the meta's absolute store index is baked into the dabs once,
	// so meta/stops offsets must stay stable).
	private readonly dabStore: BoundedStampStore;
	private readonly metaStore: GeometryStore;
	private readonly stopsStore: GeometryStore;
	/** BG0 per (uniform buffer, brush texture uid). Keyed by uniform buffer via
	 *  WeakMap so per-pass viewport-override buffers (UniformScope pool) and
	 *  the main buffer keep separate entries instead of thrashing one slot.
	 *  Entries re-validate texture and stamp buffer on lookup — growth
	 *  replaces the stamp buffer. */
	private residentBG0Cache = new WeakMap<
		GPUBuffer,
		Map<
			string,
			{ texture: GPUTexture; stampBuf: GPUBuffer; bindGroup: GPUBindGroup }
		>
	>();
	/** Frame stamp for same-submit conflict detection on resident leases. */
	private frameCounter = 0;

	// Ribbon batch accumulation
	private batchRibbonData: Float32Array = new Float32Array(0);
	private batchRibbonSegmentCount = 0;
	private batchRibbonTextureUid: string | null = null;

	// Dab pipelines, keyed by tip mode / wet-seed / mixed-color variant
	private dabPipelines = new Map<
		string,
		{ pipeline: GPURenderPipeline; bindGroupLayout: GPUBindGroupLayout }
	>();
	private mixedBrushBindGroupLayout: GPUBindGroupLayout | null = null;
	private falloffLutView: GPUTextureView | null = null;
	private falloffLutTexture: GPUTexture | null = null;
	private blankGrainTexture: GPUTexture | null = null;
	private blankGrainView: GPUTextureView | null = null;
	private grainSampler: GPUSampler | null = null;
	private falloffSampler: GPUSampler | null = null;
	// Live-stroke dab residency (design §8): the preview path re-uses one
	// grow-only buffer; only newly committed dabs and the volatile tail are
	// uploaded per frame.
	private liveDabAccumulator: LiveDabAccumulator | null = null;
	private liveDabBuffer: GPUBuffer | null = null;
	private liveDabCapacityFloats = 0;
	private liveUploadedCommitted = 0;
	private retiredLiveDabBuffers: GPUBuffer[] = [];
	/** Settings-object -> JSON fingerprint (settings are immutable). */
	private readonly v2FingerprintCache = new WeakMap<object, string>();
	private textureArrayBuilder: BrushTextureArrayBuilder | null = null;

	// Ribbon pipeline — lazy initialized
	private ribbonPipeline: GPURenderPipeline | null = null;
	private ribbonBindGroupLayout: GPUBindGroupLayout | null = null;
	private ribbonUnitVertexBuffer: GPUBuffer | null = null;
	private ribbonSampler: GPUSampler | null = null;

	private canvasFormat: GPUTextureFormat;
	private transformsBindGroupLayout: GPUBindGroupLayout;
	private maskBindGroupLayout: GPUBindGroupLayout;

	/** Resolved per use, never captured: the cache manager swaps its active
	 *  document scope between frames, so a held StampCache instance would pin
	 *  a stale scope. */
	private getStampCache: () => StampCache;
	private getMaskBindGroup: () => GPUBindGroup;
	/** Called right before this batch's draws are encoded, so the geometry
	 *  run batcher can emit its pending merged draw first (paint order). */
	public onBeforeDraw: (() => void) | null = null;

	// ── Peak tracking (for buffer pre-sizing) ──
	private peakPathMetaFloats = 0;
	private peakColorStopFloats = 0;

	public constructor(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
		uniformBuffer: GPUBuffer,
		textureManager: BrushTextureManager,
		transformsBindGroupLayout: GPUBindGroupLayout,
		getStampCache: () => StampCache,
		maskBindGroupLayout: GPUBindGroupLayout,
		getMaskBindGroup: () => GPUBindGroup,
		options?: StrokeBatchContextOptions,
	) {
		this.device = device;
		this.uniformBuffer = uniformBuffer;
		this.textureManager = textureManager;
		this.getStampCache = getStampCache;
		this.getMaskBindGroup = getMaskBindGroup;
		this.canvasFormat = canvasFormat;
		this.transformsBindGroupLayout = transformsBindGroupLayout;
		this.maskBindGroupLayout = maskBindGroupLayout;

		this.dabStore = new BoundedStampStore(device, {
			floatsPerStamp: DAB_INSTANCE_FLOATS,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			label: "Resident Dab Instances",
			maxCapacityStamps: options?.maxResidentStamps,
		});
		// Meta/stops offsets are baked into stamp instances (pathIndex) and
		// metas (stopOffset) respectively — they must never move.
		this.metaStore = new GeometryStore(device, {
			floatsPerVertex: PATH_META_FLOATS,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			label: "Resident Stamp Path Metas",
			stableOffsets: true,
			initialCapacityVertices: 256,
		});
		this.stopsStore = new GeometryStore(device, {
			floatsPerVertex: COLOR_STOP_FLOATS,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			label: "Resident Stamp Color Stops",
			stableOffsets: true,
			initialCapacityVertices: 256,
		});

		// Bind Group Layout 1: PathMetas (storage) + ColorStops (storage).
		// Shared by every stroke pipeline (dab, ribbon, wet seed).
		this.brushBindGroupLayout = device.createBindGroupLayout({
			label: "Stroke Bind Group Layout 1",
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
			],
		});
	}

	/**
	 * Override the uniform buffer used for bind group 0.
	 * Offscreen passes call this with the per-pass uniform buffer from
	 * UniformScope so that the stroke shaders read the correct viewport
	 * parameters for the offscreen texture.
	 */
	public setActiveUniformBuffer(buffer: GPUBuffer | null): void {
		this.activeUniformBuffer = buffer;
	}

	private getEffectiveUniformBuffer(): GPUBuffer {
		return this.activeUniformBuffer ?? this.uniformBuffer;
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

	/** Lazy-init ribbon pipeline (bezier segment instancing) */
	private ensureRibbonPipeline(): {
		pipeline: GPURenderPipeline;
		bindGroupLayout: GPUBindGroupLayout;
		unitVertexBuffer: GPUBuffer;
		sampler: GPUSampler;
	} {
		if (
			this.ribbonPipeline &&
			this.ribbonBindGroupLayout &&
			this.ribbonUnitVertexBuffer &&
			this.ribbonSampler
		) {
			return {
				pipeline: this.ribbonPipeline,
				bindGroupLayout: this.ribbonBindGroupLayout,
				unitVertexBuffer: this.ribbonUnitVertexBuffer,
				sampler: this.ribbonSampler,
			};
		}

		// Static unit vertex buffer: [t, side] pairs forming triangle-list strips
		const vertexData = new Float32Array(RIBBON_VERTICES_PER_SEGMENT * 2);
		for (let i = 0; i < RIBBON_STEPS; i++) {
			const t0 = i / RIBBON_STEPS;
			const t1 = (i + 1) / RIBBON_STEPS;
			const off = i * 12; // 6 verts * 2 floats
			// Triangle 1: (t0,-1), (t1,-1), (t0,+1)
			vertexData[off] = t0;
			vertexData[off + 1] = -1;
			vertexData[off + 2] = t1;
			vertexData[off + 3] = -1;
			vertexData[off + 4] = t0;
			vertexData[off + 5] = 1;
			// Triangle 2: (t0,+1), (t1,-1), (t1,+1)
			vertexData[off + 6] = t0;
			vertexData[off + 7] = 1;
			vertexData[off + 8] = t1;
			vertexData[off + 9] = -1;
			vertexData[off + 10] = t1;
			vertexData[off + 11] = 1;
		}

		this.ribbonUnitVertexBuffer = this.device.createBuffer({
			label: "Ribbon Unit Vertex Buffer",
			size: vertexData.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
		});
		this.device.queue.writeBuffer(this.ribbonUnitVertexBuffer, 0, vertexData);

		// Sampler with repeat U for seamless tiling. Brush textures carry mip
		// chains for the dab pipeline; pin this one to level 0 so ribbon output
		// stays identical to the pre-mip behavior.
		this.ribbonSampler = this.device.createSampler({
			label: "Ribbon Repeat Sampler",
			magFilter: "linear",
			minFilter: "linear",
			lodMaxClamp: 0,
			addressModeU: "repeat",
			addressModeV: "clamp-to-edge",
		});

		const { module: shaderModule } = compileShaderModule(this.device, {
			label: "Ribbon Stroke Shader",
			code: RIBBON_STROKE_SHADER,
		});

		this.ribbonBindGroupLayout = this.device.createBindGroupLayout({
			label: "Ribbon Bind Group Layout 0",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.VERTEX,
					buffer: { type: "uniform" },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.VERTEX,
					buffer: { type: "read-only-storage" },
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

		const pipelineLayout = this.device.createPipelineLayout({
			label: "Ribbon Pipeline Layout",
			bindGroupLayouts: [
				this.ribbonBindGroupLayout,
				this.brushBindGroupLayout,
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

		this.ribbonPipeline = this.device.createRenderPipeline({
			label: "Ribbon Stroke Pipeline",
			layout: pipelineLayout,
			vertex: {
				module: shaderModule,
				entryPoint: "vs_main",
				buffers: [
					{
						arrayStride: 8, // 2 floats (t, side)
						stepMode: "vertex",
						attributes: [
							{
								shaderLocation: 0,
								offset: 0,
								format: "float32x2",
							},
						],
					},
				],
			},
			fragment: {
				module: shaderModule,
				entryPoint: "fs_main",
				targets: [{ format: this.canvasFormat, blend: blendState }],
			},
			primitive: { topology: "triangle-list", cullMode: "none" },
			depthStencil: {
				format: "depth24plus-stencil8",
				depthWriteEnabled: false,
				depthCompare: "always",
				stencilFront: {
					compare: "always",
					passOp: "keep",
					failOp: "keep",
					depthFailOp: "keep",
				},
				stencilBack: {
					compare: "always",
					passOp: "keep",
					failOp: "keep",
					depthFailOp: "keep",
				},
				stencilWriteMask: 0x00,
				stencilReadMask: 0x00,
			},
			multisample: { count: RENDER_SAMPLE_COUNT },
		});

		return {
			pipeline: this.ribbonPipeline,
			bindGroupLayout: this.ribbonBindGroupLayout,
			unitVertexBuffer: this.ribbonUnitVertexBuffer,
			sampler: this.ribbonSampler,
		};
	}

	/** Reset buffer pool indices. Call at the start of each frame. */
	public beginFrame(): void {
		this.frameCounter++;
		this.poolIdx = 0;
		this.pathMetaPoolIdx = 0;
		this.colorStopsPoolIdx = 0;
		// Return ranges released by evicted StampCache entries — deferred to
		// this frame boundary so last frame's encoded draws kept their data.
		this.dabStore.flushPendingReleases();
		this.metaStore.flushPendingReleases();
		this.stopsStore.flushPendingReleases();
		// Grown-out live dab buffers: destroyed one frame later so last
		// frame's encoded draws kept their data.
		for (const buffer of this.retiredLiveDabBuffers) buffer.destroy();
		this.retiredLiveDabBuffers.length = 0;
	}

	// ================================================================
	// Batch API
	// ================================================================

	/** Reset the batch accumulation buffers. Called at the start of renderElements(). */
	public beginBatch(): void {
		this.batchPathCount = 0;
		this.batchColorStopCount = 0;
		this.batchRibbonSegmentCount = 0;
		this.batchRibbonTextureUid = null;

		// Preallocate from the previous frame's peak sizes
		if (this.peakPathMetaFloats > this.batchPathMetas.length) {
			this.ensureBatchPathMetas(this.peakPathMetaFloats);
		}
		if (this.peakColorStopFloats > this.batchColorStops.length) {
			this.ensureBatchColorStops(this.peakColorStopFloats);
		}
	}

	/**
	 * Queue a path into the batch without drawing anything;
	 * flushBatch() draws the whole batch at once.
	 */
	public addToBatch(input: StrokeDrawInput): void {
		if (input.segments.length === 0) return;
		// Only ribbon strokes batch; dab strokes draw through render() and
		// geometric strokes never reach this context.
		const ribbon =
			input.settings.engine === "ribbon" ? input.settings.ribbon : undefined;
		if (!ribbon) return;
		this.addRibbonToBatch(input, ribbon);
	}

	/** Resolve the brush texture and (when scatter/start/end sources are set)
	 *  the texture-array layout. Shared by the batch, immediate, and wet
	 *  paths — array builds must match the stamp generation parameters, or a
	 *  cache entry created by one path would render wrong on another. */
	private resolveScatterTextureSetup(
		settings: BrushSettingsV2,
		getArrayBuilder: () => BrushTextureArrayBuilder,
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
			textureArrayResult = getArrayBuilder().build(allUids);
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

	/**
	 * Accumulate ribbon instances for batch rendering.
	 */
	private addRibbonToBatch(input: StrokeDrawInput, ribbon: RibbonConfig): void {
		const { path, segments, settings } = input;
		const ribbonBuf = generateRibbonInstances(
			segments,
			ribbonStrokeInputOf(settings),
			this.batchPathCount,
			path.strokeWidths,
			ribbonOptionsWithCurves(settings, ribbon, path.strokeWidthsBaked),
			path.pathStart ?? 0,
			path.pathEnd ?? 1,
		);
		if (ribbonBuf.segmentCount === 0) return;

		// Accumulate ribbon instance data
		const floatsNeeded = ribbonBuf.segmentCount * RIBBON_FLOATS_PER_INSTANCE;
		const destOffset =
			this.batchRibbonSegmentCount * RIBBON_FLOATS_PER_INSTANCE;
		this.ensureBatchRibbonData(destOffset + floatsNeeded);
		this.batchRibbonData.set(
			ribbonBuf.data.subarray(0, floatsNeeded),
			destOffset,
		);
		this.batchRibbonSegmentCount += ribbonBuf.segmentCount;

		// Track texture and params (last ribbon path wins for shared params)
		this.batchRibbonTextureUid = this.resolveTextureUid(
			ribbon.source.kind === "file"
				? ribbon.source.fileUid
				: BUILTIN_BRUSH_IDS.softCircle,
		);

		// Add PathMeta (shared with stamps)
		this.ensureBatchPathMetas((this.batchPathCount + 1) * PATH_META_FLOATS);
		const metaOff = this.batchPathCount * PATH_META_FLOATS;
		this.writePathMeta(metaOff, input);
		this.batchPathCount++;
	}

	/**
	 * Draw the accumulated batch. Contiguous resident entries collapse to one
	 * draw per texture switch; pooled fallbacks draw individually in between,
	 * preserving paint order.
	 */
	public flushBatch(
		passEncoder: GPURenderPassEncoder,
		_pipelineType: PipelineType,
		transformsBindGroup: GPUBindGroup,
	): void {
		if (this.batchRibbonSegmentCount === 0) return;

		this.onBeforeDraw?.();

		const effectiveUniformBuffer = this.getEffectiveUniformBuffer();

		// === Ribbon drawing ===
		if (this.batchRibbonSegmentCount > 0 && this.batchRibbonTextureUid) {
			// PathMeta + ColorStops — the ribbon path is the only remaining
			// consumer of the per-frame batch meta pools.
			const metaByteLength =
				Math.max(this.batchPathCount, 1) * PATH_META_FLOATS * 4;
			const pathMetaBuffer = this.acquirePathMetaBuffer(metaByteLength);
			this.device.queue.writeBuffer(
				pathMetaBuffer,
				0,
				this.batchPathMetas.buffer,
				this.batchPathMetas.byteOffset,
				metaByteLength,
			);

			const stopsFloatLen =
				Math.max(this.batchColorStopCount, 1) * COLOR_STOP_FLOATS;
			const stopsByteLength = stopsFloatLen * 4;
			const colorStopsBuffer = this.acquireColorStopsBuffer(stopsByteLength);
			if (this.batchColorStopCount > 0) {
				this.device.queue.writeBuffer(
					colorStopsBuffer,
					0,
					this.batchColorStops.buffer,
					this.batchColorStops.byteOffset,
					this.batchColorStopCount * COLOR_STOP_FLOATS * 4,
				);
			}

			let bindGroup1: GPUBindGroup;
			if (
				this.cachedBindGroup1 &&
				this.cachedBG1PathMetaBuf === pathMetaBuffer &&
				this.cachedBG1ColorStopsBuf === colorStopsBuffer
			) {
				bindGroup1 = this.cachedBindGroup1;
			} else {
				bindGroup1 = this.device.createBindGroup({
					label: "Brush Batch Bind Group 1",
					layout: this.brushBindGroupLayout,
					entries: [
						{ binding: 0, resource: { buffer: pathMetaBuffer } },
						{ binding: 1, resource: { buffer: colorStopsBuffer } },
					],
				});
				this.cachedBindGroup1 = bindGroup1;
				this.cachedBG1PathMetaBuf = pathMetaBuffer;
				this.cachedBG1ColorStopsBuf = colorStopsBuffer;
			}

			const {
				pipeline: ribPipeline,
				bindGroupLayout: ribBGL,
				unitVertexBuffer,
				sampler: ribSampler,
			} = this.ensureRibbonPipeline();

			const ribbonFloatCount =
				this.batchRibbonSegmentCount * RIBBON_FLOATS_PER_INSTANCE;
			const ribbonByteLength = ribbonFloatCount * 4;
			const ribbonBuffer = this.acquireStampBuffer(ribbonByteLength);
			const ribbonView = this.batchRibbonData.subarray(0, ribbonFloatCount);
			this.device.queue.writeBuffer(
				ribbonBuffer,
				0,
				ribbonView.buffer as ArrayBuffer,
				ribbonView.byteOffset,
				ribbonView.byteLength,
			);

			const texture = this.textureManager.getTexture(
				this.batchRibbonTextureUid,
			);
			if (texture) {
				let textureView = this.textureViewCache.get(this.batchRibbonTextureUid);
				if (!textureView) {
					textureView = texture.createView();
					this.textureViewCache.set(this.batchRibbonTextureUid, textureView);
				}

				const bindGroup0 = this.device.createBindGroup({
					label: "Ribbon Batch Bind Group 0",
					layout: ribBGL,
					entries: [
						{
							binding: 0,
							resource: { buffer: effectiveUniformBuffer },
						},
						{ binding: 1, resource: { buffer: ribbonBuffer } },
						{ binding: 2, resource: textureView },
						{ binding: 3, resource: ribSampler },
					],
				});

				passEncoder.setPipeline(ribPipeline);
				passEncoder.setVertexBuffer(0, unitVertexBuffer);
				passEncoder.setBindGroup(0, bindGroup0);
				passEncoder.setBindGroup(1, bindGroup1);
				passEncoder.setBindGroup(2, transformsBindGroup);
				passEncoder.setBindGroup(3, this.getMaskBindGroup());
				passEncoder.draw(
					RIBBON_VERTICES_PER_SEGMENT,
					this.batchRibbonSegmentCount,
					0,
					0,
				);
			}
		}

		// Update the peaks (for the next frame's preallocation)
		const pathMetaFloatsUsed = this.batchPathCount * PATH_META_FLOATS;
		const colorStopFloatsUsed = this.batchColorStopCount * COLOR_STOP_FLOATS;
		if (pathMetaFloatsUsed > this.peakPathMetaFloats)
			this.peakPathMetaFloats = pathMetaFloatsUsed;
		if (colorStopFloatsUsed > this.peakColorStopFloats)
			this.peakColorStopFloats = colorStopFloatsUsed;

		this.resetBatchState();
	}

	/** Reset the batch accumulation state. */
	private resetBatchState(): void {
		this.batchPathCount = 0;
		this.batchColorStopCount = 0;
		this.batchRibbonSegmentCount = 0;
		this.batchRibbonTextureUid = null;
	}

	// ================================================================
	// Immediate draw API (fallback for offscreen/stencil)
	// ================================================================

	/**
	 * Draw a single path immediately. Used where batching does not apply (offscreen, stencil, etc.).
	 */

	public render(
		passEncoder: GPURenderPassEncoder,
		input: StrokeDrawInput,
		transformsBindGroup?: GPUBindGroup,
	): void {
		if (input.segments.length === 0) return;

		// Ribbon: one instance per bezier segment, extruded on the GPU.
		if (input.settings.engine === "ribbon") {
			const ribbon = input.settings.ribbon;
			if (!ribbon) return;
			this.renderRibbon(passEncoder, input, ribbon, transformsBindGroup);
			return;
		}

		// Dab pipeline (curve matrix + linearize + procedural tips). Geometric
		// strokes are drawn by PathElementRenderer and never arrive here.
		this.renderDabsV2(passEncoder, input, transformsBindGroup);
	}

	/** v2 dab pipeline — immediate (frame-pooled) draw for curve-matrix
	 *  strokes. Residency/batching integration arrives with
	 *  BrushStrokeSession (plan phase 2); until then every v2 dab stroke
	 *  uploads its instances per frame. */
	/**
	 * Draw a wet stroke's dabs into the wet layer's seed targets.
	 *
	 * The pass belongs to the caller (WetLayerPass consumes what lands here),
	 * which is why this takes an open encoder: the seed targets are cleared to
	 * the stroke's base coefficients so texels no dab covers keep them.
	 */
	public renderWetSeedDabs(args: {
		passEncoder: GPURenderPassEncoder;
		path: Path;
		strokeColor: StrokeColor;
		settings: BrushSettingsV2;
		segments: CubicBezierSegment[];
		alphaMultiplier: number;
		transformsBindGroup: GPUBindGroup | undefined;
		transformIndex: number;
		/** Resolved per-dab colours of a mixing stroke, with the dab buffer
		 *  they index into. Given together, the seed carries what the stroke
		 *  picked up instead of the brush colour. */
		mixed?: { dabBuffer: GPUBuffer; colors: GPUBuffer; dabCount: number };
	}): void {
		const tip = this.resolveDabTipSetup(args.settings);
		if (!tip) return;

		const dabs = evaluateDabs(args.segments, args.settings, {
			pathStart: args.path.pathStart ?? 0,
			pathEnd: args.path.pathEnd ?? 1,
			strokeWidths: args.path.strokeWidths,
			strokeWidthsBaked: args.path.strokeWidthsBaked,
			textureAspectRatio: tip.textureAspectRatio,
			variantCount: tip.variantCount,
			startLayerIndex: tip.startLayerIndex,
			endLayerIndex: tip.endLayerIndex,
		});
		if (dabs.count === 0) return;

		const floatCount = dabs.count * DAB_INSTANCE_FLOATS;
		const dabBuffer = this.acquireStampBuffer(floatCount * 4);
		const dabView = dabs.data.subarray(0, floatCount);
		this.device.queue.writeBuffer(
			dabBuffer,
			0,
			dabView.buffer as ArrayBuffer,
			dabView.byteOffset,
			dabView.byteLength,
		);

		const singleMeta = new Float32Array(PATH_META_FLOATS);
		this.writeSinglePathMeta(singleMeta, 0, args);
		const pathMetaBuffer = this.acquirePathMetaBuffer(PATH_META_FLOATS * 4);
		this.device.queue.writeBuffer(pathMetaBuffer, 0, singleMeta);
		const stopData = buildColorStopsData(args.strokeColor);
		const colorStopsBuffer = this.acquireColorStopsBuffer(stopData.byteLength);
		this.device.queue.writeBuffer(colorStopsBuffer, 0, stopData);

		const { pipeline, bindGroupLayout } = this.ensureWetSeedPipeline(
			tip.tipMode,
			args.mixed != null,
		);
		args.passEncoder.setPipeline(pipeline);
		args.passEncoder.setBindGroup(
			0,
			this.device.createBindGroup({
				label: "Wet Seed Bind Group 0",
				layout: bindGroupLayout,
				entries: [
					{
						binding: 0,
						resource: { buffer: this.getEffectiveUniformBuffer() },
					},
					{
						binding: 1,
						resource: { buffer: args.mixed?.dabBuffer ?? dabBuffer },
					},
					{ binding: 2, resource: tip.textureView },
					{ binding: 3, resource: tip.sampler },
					...this.grainBindings(args.settings),
				],
			}),
		);
		args.passEncoder.setBindGroup(
			1,
			this.device.createBindGroup({
				label: "Wet Seed Bind Group 1",
				layout: args.mixed
					? this.ensureMixedBrushBindGroupLayout()
					: this.brushBindGroupLayout,
				entries: [
					{ binding: 0, resource: { buffer: pathMetaBuffer } },
					{ binding: 1, resource: { buffer: colorStopsBuffer } },
					...(args.mixed
						? [{ binding: 2, resource: { buffer: args.mixed.colors } }]
						: []),
				],
			}),
		);
		if (args.transformsBindGroup) {
			args.passEncoder.setBindGroup(2, args.transformsBindGroup);
		}
		args.passEncoder.setBindGroup(3, this.getMaskBindGroup());
		args.passEncoder.draw(6, args.mixed?.dabCount ?? dabs.count);
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

	/** Dab pipeline writing the wet seed targets. Separate from the painting
	 *  pipeline because it has no depth attachment and six colour targets. */
	private ensureWetSeedPipeline(
		mode: DabTipMode,
		mixed = false,
	): {
		pipeline: GPURenderPipeline;
		bindGroupLayout: GPUBindGroupLayout;
	} {
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
						? this.ensureMixedBrushBindGroupLayout()
						: this.brushBindGroupLayout,
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

	/** Set up one mixing stroke's draw state (pipeline + bind groups). The
	 *  mix driver draws each chunk into its own render pass via
	 *  drawMixedDabChunk as the chunked mix pass resolves colors. Buffers are
	 *  stroke-local (dab 0 at buffer start) so the flat instance index lines
	 *  up with the mixedColors buffer. Callers must have set the offscreen
	 *  viewport uniform via setActiveUniformBuffer first. */
	public prepareMixedDabStroke(args: {
		path: Path;
		strokeColor: StrokeColor;
		settings: BrushSettingsV2;
		dabBuffer: GPUBuffer;
		mixedColors: GPUBuffer;
		alphaMultiplier: number;
		transformIndex: number;
	}): MixedDabStrokeDrawState | null {
		const tip = this.resolveDabTipSetup(args.settings);
		if (!tip) return null;
		const { pipeline, bindGroupLayout } = this.ensureDabPipeline(
			tip.tipMode,
			true,
		);

		const singleMeta = new Float32Array(PATH_META_FLOATS);
		this.writeSinglePathMeta(singleMeta, 0, args);
		const pathMetaBuffer = this.acquirePathMetaBuffer(PATH_META_FLOATS * 4);
		this.device.queue.writeBuffer(pathMetaBuffer, 0, singleMeta);
		const stopData = buildColorStopsData(args.strokeColor);
		const colorStopsBuffer = this.acquireColorStopsBuffer(stopData.byteLength);
		this.device.queue.writeBuffer(colorStopsBuffer, 0, stopData);

		const bindGroup0 = this.device.createBindGroup({
			label: "Brush Dab Bind Group 0 (mixed)",
			layout: bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: this.getEffectiveUniformBuffer() } },
				{ binding: 1, resource: { buffer: args.dabBuffer } },
				{ binding: 2, resource: tip.textureView },
				{ binding: 3, resource: tip.sampler },
				...this.grainBindings(args.settings),
			],
		});
		const bindGroup1 = this.device.createBindGroup({
			label: "Brush Dab Bind Group 1 (mixed)",
			layout: this.ensureMixedBrushBindGroupLayout(),
			entries: [
				{ binding: 0, resource: { buffer: pathMetaBuffer } },
				{ binding: 1, resource: { buffer: colorStopsBuffer } },
				{ binding: 2, resource: { buffer: args.mixedColors } },
			],
		});
		return {
			pipeline,
			bindGroup0,
			bindGroup1,
			pathMetaBuffer,
			colorStopsBuffer,
		};
	}

	/** Draw one resolved chunk of a mixing stroke into an open render pass. */
	public drawMixedDabChunk(
		passEncoder: GPURenderPassEncoder,
		stroke: MixedDabStrokeDrawState,
		firstDab: number,
		dabCount: number,
		transformsBindGroup: GPUBindGroup | undefined,
	): void {
		passEncoder.setPipeline(stroke.pipeline);
		passEncoder.setBindGroup(0, stroke.bindGroup0);
		passEncoder.setBindGroup(1, stroke.bindGroup1);
		if (transformsBindGroup) {
			passEncoder.setBindGroup(2, transformsBindGroup);
		}
		passEncoder.setBindGroup(3, this.getMaskBindGroup());
		passEncoder.draw(6, dabCount, 0, firstDab);
	}

	/** Resolve the tip pipeline variant + texture bindings for v2 settings.
	 *  Shared by the plain dab draw and the mixing chunk draw. */
	private resolveDabTipSetup(settings: BrushSettingsV2): {
		tipMode: DabTipMode;
		textureView: GPUTextureView;
		sampler: GPUSampler;
		textureAspectRatio: number;
		variantCount: number;
		startLayerIndex: number;
		endLayerIndex: number;
	} | null {
		let tipMode: DabTipMode = "procedural";
		let textureView: GPUTextureView | null = null;
		let sampler: GPUSampler | null = null;
		let textureAspectRatio = 1;
		let variantCount = 0;
		let startLayerIndex = -1;
		let endLayerIndex = -1;

		if (settings.tip?.kind === "image") {
			const setup = this.resolveScatterTextureSetup(settings, () =>
				this.ensureTextureArrayBuilder(),
			);
			textureAspectRatio = this.textureManager.getTextureAspectRatio(
				setup.effectiveTextureFileUid,
			);
			variantCount = setup.variantCount;
			startLayerIndex = setup.startLayerIndex;
			endLayerIndex = setup.endLayerIndex;
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
			// Trilinear filtering over the tip's mip chain. The ribbon pipeline
			// keeps its own level-0-pinned sampler instead.
			sampler = this.textureManager.getMipSampler();
		} else {
			const falloff = this.ensureFalloffLut();
			textureView = falloff.view;
			sampler = falloff.sampler;
		}
		if (!textureView || !sampler) return null;
		return {
			tipMode,
			textureView,
			sampler,
			textureAspectRatio,
			variantCount,
			startLayerIndex,
			endLayerIndex,
		};
	}

	private renderDabsV2(
		passEncoder: GPURenderPassEncoder,
		input: StrokeDrawInput,
		transformsBindGroup: GPUBindGroup | undefined,
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
			const floatCount = dabs.count * DAB_INSTANCE_FLOATS;
			dabBuffer = this.acquireStampBuffer(floatCount * 4);
			dabCount = dabs.count;
			const dabView = dabs.data.subarray(0, floatCount);
			this.device.queue.writeBuffer(
				dabBuffer,
				0,
				dabView.buffer as ArrayBuffer,
				dabView.byteOffset,
				dabView.byteLength,
			);
		} else {
			// Committed strokes: cache the evaluated dab buffer so pans/zooms
			// re-upload but never re-evaluate (the pre-v2 path had the same
			// property through StampCache + resident stamps).
			let fingerprint = this.v2FingerprintCache.get(settings);
			if (!fingerprint) {
				fingerprint = JSON.stringify(settings);
				this.v2FingerprintCache.set(settings, fingerprint);
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
				dabBuffer = this.acquireStampBuffer(cached.data.byteLength);
				this.device.queue.writeBuffer(
					dabBuffer,
					0,
					cached.data.buffer as ArrayBuffer,
					cached.data.byteOffset,
					cached.data.byteLength,
				);
			}
		}

		const singleMeta = new Float32Array(PATH_META_FLOATS);
		this.writeSinglePathMeta(singleMeta, 0, input);
		const pathMetaBuffer = this.acquirePathMetaBuffer(PATH_META_FLOATS * 4);
		this.device.queue.writeBuffer(pathMetaBuffer, 0, singleMeta);

		const stopData = buildColorStopsData(input.strokeColor);
		const colorStopsBuffer = this.acquireColorStopsBuffer(stopData.byteLength);
		this.device.queue.writeBuffer(colorStopsBuffer, 0, stopData);

		const { pipeline, bindGroupLayout } = this.ensureDabPipeline(tipMode);
		const bindGroup0 = this.device.createBindGroup({
			label: "Brush Dab Bind Group 0",
			layout: bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: this.getEffectiveUniformBuffer() } },
				{ binding: 1, resource: { buffer: dabBuffer } },
				{ binding: 2, resource: textureView },
				{ binding: 3, resource: sampler },
				...this.grainBindings(settings),
			],
		});
		const bindGroup1 = this.device.createBindGroup({
			label: "Brush Dab Bind Group 1",
			layout: this.brushBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: pathMetaBuffer } },
				{ binding: 1, resource: { buffer: colorStopsBuffer } },
			],
		});

		passEncoder.setPipeline(pipeline);
		passEncoder.setBindGroup(0, bindGroup0);
		passEncoder.setBindGroup(1, bindGroup1);
		if (transformsBindGroup) {
			passEncoder.setBindGroup(2, transformsBindGroup);
		}
		passEncoder.setBindGroup(3, this.getMaskBindGroup());
		passEncoder.draw(6, dabCount, 0, dabFirstInstance);
	}

	/**
	 * Incremental upload for the live preview stroke: newly committed dabs
	 * append into a persistent grow-only buffer, the volatile tail rewrites
	 * behind them every frame.
	 */
	private uploadLiveDabs(
		segments: CubicBezierSegment[],
		settings: BrushSettingsV2,
		options: {
			textureAspectRatio: number;
			variantCount: number;
			startLayerIndex: number;
		},
	): { buffer: GPUBuffer; count: number } | null {
		this.liveDabAccumulator ??= new LiveDabAccumulator();
		const frame = this.liveDabAccumulator.update(segments, settings, options);
		if (frame.totalCount === 0) return null;
		if (frame.reset || frame.committedCount < this.liveUploadedCommitted) {
			this.liveUploadedCommitted = 0;
		}

		const neededFloats = frame.totalCount * DAB_INSTANCE_FLOATS;
		if (!this.liveDabBuffer || this.liveDabCapacityFloats < neededFloats) {
			if (this.liveDabBuffer) {
				this.retiredLiveDabBuffers.push(this.liveDabBuffer);
			}
			this.liveDabCapacityFloats = Math.max(
				neededFloats * 2,
				4096 * DAB_INSTANCE_FLOATS,
			);
			this.liveDabBuffer = this.device.createBuffer({
				label: "Live Dab Instances",
				size: this.liveDabCapacityFloats * 4,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			});
			this.liveUploadedCommitted = 0;
		}

		if (frame.committedCount > this.liveUploadedCommitted) {
			const startFloat = this.liveUploadedCommitted * DAB_INSTANCE_FLOATS;
			const endFloat = frame.committedCount * DAB_INSTANCE_FLOATS;
			this.device.queue.writeBuffer(
				this.liveDabBuffer,
				startFloat * 4,
				frame.committedData.buffer as ArrayBuffer,
				frame.committedData.byteOffset + startFloat * 4,
				(endFloat - startFloat) * 4,
			);
			this.liveUploadedCommitted = frame.committedCount;
		}
		if (frame.tailCount > 0) {
			const tailFloats = frame.tailCount * DAB_INSTANCE_FLOATS;
			this.device.queue.writeBuffer(
				this.liveDabBuffer,
				frame.committedCount * DAB_INSTANCE_FLOATS * 4,
				frame.tailData.buffer as ArrayBuffer,
				frame.tailData.byteOffset,
				tailFloats * 4,
			);
		}
		return { buffer: this.liveDabBuffer, count: frame.totalCount };
	}

	private ensureDabPipeline(
		mode: DabTipMode,
		mixedColors = false,
	): {
		pipeline: GPURenderPipeline;
		bindGroupLayout: GPUBindGroupLayout;
	} {
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
					? this.ensureMixedBrushBindGroupLayout()
					: this.brushBindGroupLayout,
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
			depthStencil: {
				format: "depth24plus-stencil8",
				depthWriteEnabled: false,
				depthCompare: "always",
				stencilFront: {
					compare: "always",
					passOp: "keep",
					failOp: "keep",
					depthFailOp: "keep",
				},
				stencilBack: {
					compare: "always",
					passOp: "keep",
					failOp: "keep",
					depthFailOp: "keep",
				},
				stencilWriteMask: 0x00,
				stencilReadMask: 0x00,
			},
			multisample: { count: RENDER_SAMPLE_COUNT },
		});

		const entry = { pipeline, bindGroupLayout };
		this.dabPipelines.set(cacheKey, entry);
		return entry;
	}

	/** Group(1) layout of the mixing route: pathMetas + colorStops + the
	 *  per-dab resolved colors from the chunked mix pass. */
	private ensureMixedBrushBindGroupLayout(): GPUBindGroupLayout {
		this.mixedBrushBindGroupLayout ??= this.device.createBindGroupLayout({
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
		return this.mixedBrushBindGroupLayout;
	}

	/** Grain texture + sampler entries for a dab bind group. Falls back to a
	 *  1x1 white texture, which leaves every grain mode a no-op. */
	private grainBindings(settings: BrushSettingsV2): GPUBindGroupEntry[] {
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
		if (!this.blankGrainView) {
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
			this.blankGrainTexture = texture;
			this.blankGrainView = texture.createView();
		}
		return this.blankGrainView;
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

	/** Falloff LUT texture for the mix pass's footprint weighting. */
	public getFalloffLutTexture(): GPUTexture {
		this.ensureFalloffLut();
		return this.falloffLutTexture!;
	}

	/** 32-layer falloff LUT (r8unorm 256x1) for procedural tips. */
	private ensureFalloffLut(): { view: GPUTextureView; sampler: GPUSampler } {
		if (this.falloffLutView && this.falloffSampler) {
			return { view: this.falloffLutView, sampler: this.falloffSampler };
		}
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
		this.falloffLutTexture = texture;
		this.falloffLutView = texture.createView({ dimension: "2d-array" });
		this.falloffSampler = this.device.createSampler({
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});
		return { view: this.falloffLutView, sampler: this.falloffSampler };
	}

	/**
	 * Single-path ribbon rendering (offscreen/stencil fallback).
	 */
	private renderRibbon(
		passEncoder: GPURenderPassEncoder,
		input: StrokeDrawInput,
		ribbon: RibbonConfig,
		transformsBindGroup: GPUBindGroup | undefined,
	): void {
		const { path, segments, settings } = input;
		const ribbonBuf = generateRibbonInstances(
			segments,
			ribbonStrokeInputOf(settings),
			0,
			path.strokeWidths,
			ribbonOptionsWithCurves(settings, ribbon, path.strokeWidthsBaked),
			path.pathStart ?? 0,
			path.pathEnd ?? 1,
		);
		if (ribbonBuf.segmentCount === 0) return;

		// Ribbon instance buffer
		const ribbonFloatCount =
			ribbonBuf.segmentCount * RIBBON_FLOATS_PER_INSTANCE;
		const ribbonByteLength = ribbonFloatCount * 4;
		const ribbonBuffer = this.acquireStampBuffer(ribbonByteLength);
		const ribbonView = ribbonBuf.data.subarray(0, ribbonFloatCount);
		this.device.queue.writeBuffer(
			ribbonBuffer,
			0,
			ribbonView.buffer as ArrayBuffer,
			ribbonView.byteOffset,
			ribbonView.byteLength,
		);

		// PathMeta (1 entry)
		const singleMeta = new Float32Array(PATH_META_FLOATS);
		this.writeSinglePathMeta(singleMeta, 0, input);
		const pathMetaBuffer = this.acquirePathMetaBuffer(PATH_META_FLOATS * 4);
		this.device.queue.writeBuffer(pathMetaBuffer, 0, singleMeta);

		// ColorStops
		const stopData = buildColorStopsData(input.strokeColor);
		const colorStopsBuffer = this.acquireColorStopsBuffer(stopData.byteLength);
		this.device.queue.writeBuffer(colorStopsBuffer, 0, stopData);

		// Texture
		const textureUid = this.resolveTextureUid(
			ribbon.source.kind === "file"
				? ribbon.source.fileUid
				: BUILTIN_BRUSH_IDS.softCircle,
		);
		const texture = this.textureManager.getTexture(textureUid);
		if (!texture) return;
		let textureView = this.textureViewCache.get(textureUid);
		if (!textureView) {
			textureView = texture.createView();
			this.textureViewCache.set(textureUid, textureView);
		}

		const { pipeline, bindGroupLayout, unitVertexBuffer, sampler } =
			this.ensureRibbonPipeline();

		const effectiveUniformBuffer = this.getEffectiveUniformBuffer();
		const bindGroup0 = this.device.createBindGroup({
			label: "Ribbon Bind Group 0",
			layout: bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: effectiveUniformBuffer } },
				{ binding: 1, resource: { buffer: ribbonBuffer } },
				{ binding: 2, resource: textureView },
				{ binding: 3, resource: sampler },
			],
		});
		const bindGroup1 = this.device.createBindGroup({
			label: "Ribbon Bind Group 1",
			layout: this.brushBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: pathMetaBuffer } },
				{ binding: 1, resource: { buffer: colorStopsBuffer } },
			],
		});

		passEncoder.setPipeline(pipeline);
		passEncoder.setVertexBuffer(0, unitVertexBuffer);
		passEncoder.setBindGroup(0, bindGroup0);
		passEncoder.setBindGroup(1, bindGroup1);
		if (transformsBindGroup) {
			passEncoder.setBindGroup(2, transformsBindGroup);
		}
		passEncoder.setBindGroup(3, this.getMaskBindGroup());
		passEncoder.draw(RIBBON_VERTICES_PER_SEGMENT, ribbonBuf.segmentCount, 0, 0);
	}

	public getTextureManager(): BrushTextureManager {
		return this.textureManager;
	}

	public destroy(): void {
		for (const entry of this.stampBufferPool) entry.buffer.destroy();
		this.stampBufferPool.length = 0;
		this.dabStore.destroy();
		this.liveDabBuffer?.destroy();
		this.liveDabBuffer = null;
		this.liveDabCapacityFloats = 0;
		this.liveUploadedCommitted = 0;
		this.liveDabAccumulator = null;
		for (const buffer of this.retiredLiveDabBuffers) buffer.destroy();
		this.retiredLiveDabBuffers.length = 0;
		for (const entry of this.pathMetaBufferPool) entry.buffer.destroy();
		this.pathMetaBufferPool.length = 0;
		for (const entry of this.colorStopsBufferPool) entry.buffer.destroy();
		this.colorStopsBufferPool.length = 0;
		this.textureViewCache.clear();
		this.cachedBindGroup1 = null;
		this.metaStore.destroy();
		this.stopsStore.destroy();
		this.residentBG0Cache = new WeakMap();
		this.textureArrayBuilder?.destroy();
		this.textureArrayBuilder = null;
		this.ribbonUnitVertexBuffer?.destroy();
		this.ribbonUnitVertexBuffer = null;
		this.ribbonPipeline = null;
		this.ribbonBindGroupLayout = null;
		this.ribbonSampler = null;
	}

	// ================================================================
	// PathMeta write helpers
	// ================================================================

	/**
	 * Batch PathMeta write (appends to batchPathMetas + batchColorStops).
	 */
	private writePathMeta(metaOff: number, input: StrokeDrawInput): void {
		const { strokeColor, path } = input;
		const sm = resolveStrokeColorMeta(strokeColor, path);
		const stopOffset = this.batchColorStopCount;

		// Write gradient color stops to batch buffer
		if (strokeColor.type === "stroke-gradient") {
			const stops = strokeColor.gradient.stops;
			this.ensureBatchColorStops(
				(this.batchColorStopCount + sm.stopCount) * COLOR_STOP_FLOATS,
			);
			for (let i = 0; i < sm.stopCount; i++) {
				const stop = stops[i];
				const c = colorToRawRGBA(stop.color);
				const off = (this.batchColorStopCount + i) * COLOR_STOP_FLOATS;
				this.batchColorStops[off] = stop.offset;
				this.batchColorStops[off + 1] = c.r;
				this.batchColorStops[off + 2] = c.g;
				this.batchColorStops[off + 3] = c.b;
				this.batchColorStops[off + 4] = c.a;
				this.batchColorStops[off + 5] = stop.midpoint;
			}
			this.batchColorStopCount += sm.stopCount;
		}

		// The fields themselves are written by the single-path writer: this
		// path only owns the batch's shared color-stop arena. Duplicating the
		// layout here is what left batched ribbons reading a zero texture
		// aspect ratio when the meta grew.
		this.writeSinglePathMeta(this.batchPathMetas, metaOff, input, stopOffset);
	}

	/**
	 * Single-path PathMeta write (for render()).
	 */
	private writeSinglePathMeta(
		data: Float32Array,
		offset: number,
		input: Omit<StrokeDrawInput, "segments">,
		stopOffset = 0,
	): void {
		const { strokeColor, settings, path, alphaMultiplier, transformIndex } =
			input;
		const sm = resolveStrokeColorMeta(strokeColor, path);
		const a = sm.a * alphaMultiplier;

		// Pack colorMode into upper bits of gradientMode (bit 16)
		const colorModeBit = settings.colorMode === "color" ? 1 << 16 : 0;

		const u32View = StrokeBatchContext._u32Scratch;
		const f32View = StrokeBatchContext._f32Scratch;

		data[offset] = sm.r;
		data[offset + 1] = sm.g;
		data[offset + 2] = sm.b;
		data[offset + 3] = a;
		u32View[0] = sm.gradientMode | colorModeBit;
		data[offset + 4] = f32View[0];
		u32View[0] = sm.stopCount;
		data[offset + 5] = f32View[0];
		u32View[0] = stopOffset;
		data[offset + 6] = f32View[0];
		u32View[0] = transformIndex;
		data[offset + 7] = f32View[0];
		data[offset + 8] = sm.lsx;
		data[offset + 9] = sm.lsy;
		data[offset + 10] = sm.lex;
		data[offset + 11] = sm.ley;
		data[offset + 12] = sm.bMinX;
		data[offset + 13] = sm.bMinY;
		data[offset + 14] = sm.bMaxX;
		data[offset + 15] = sm.bMaxY;

		// Grain rides on the stroke, not the dab: mode/scale/offset are
		// per-stroke, only its strength is modulated per dab.
		const grain = grainMetaOf(settings);
		u32View[0] = grain.mode;
		data[offset + 16] = f32View[0];
		data[offset + 17] = grain.scale;
		data[offset + 18] = grain.offsetX;
		data[offset + 19] = grain.offsetY;

		// Ribbon tiling used to live in one uniform shared by the whole batch,
		// which made the last path in a run dictate every other path's tiling.
		const ribbon = this.ribbonMetaOf(settings);
		data[offset + 20] = ribbon.stretch;
		data[offset + 21] = ribbon.uvOffset;
		data[offset + 22] = ribbon.aspectRatio;
		data[offset + 23] = ribbon.stampAngle;
	}

	/** Per-path ribbon tiling for the path meta. Zeroed for non-ribbon
	 *  brushes, which never read these fields. */
	private ribbonMetaOf(settings: BrushSettingsV2): {
		stretch: number;
		uvOffset: number;
		aspectRatio: number;
		stampAngle: number;
	} {
		const zero = { stretch: 0, uvOffset: 0, aspectRatio: 1, stampAngle: 0 };
		const ribbon = settings.engine === "ribbon" ? settings.ribbon : undefined;
		if (!ribbon) return zero;

		const textureUid = this.resolveTextureUid(
			ribbon.source.kind === "file"
				? ribbon.source.fileUid
				: BUILTIN_BRUSH_IDS.softCircle,
		);
		return {
			// A stretched ribbon spans the stroke once, so it has no tiling to
			// scale; only repeat mode reads this.
			stretch: ribbon.uvMode === "repeat" ? ribbon.tileScale - 1 : 0,
			uvOffset: ribbon.uvMode === "repeat" ? (ribbon.uvOffset ?? 0) : 0,
			aspectRatio: this.textureManager.getTextureAspectRatio(textureUid),
			// The shader has always rotated the ribbon's texture by a stamp angle
			// that nothing ever set; the v2 angle property is that value.
			stampAngle: settings.properties.angle?.base ?? 0,
		};
	}

	// Shared scratch for u32 <-> f32 bit-casts
	private static _u32Scratch = new Uint32Array(1);
	private static _f32Scratch = new Float32Array(
		StrokeBatchContext._u32Scratch.buffer,
	);

	// ================================================================
	// Buffer acquisition helpers
	// ================================================================

	private ensureBatchPathMetas(requiredFloats: number): void {
		if (this.batchPathMetas.length >= requiredFloats) return;
		const newSize = Math.max(
			requiredFloats,
			this.batchPathMetas.length * 2,
			256,
		);
		const newArr = new Float32Array(newSize);
		newArr.set(this.batchPathMetas);
		this.batchPathMetas = newArr;
	}

	private ensureBatchColorStops(requiredFloats: number): void {
		if (this.batchColorStops.length >= requiredFloats) return;
		const newSize = Math.max(
			requiredFloats,
			this.batchColorStops.length * 2,
			256,
		);
		const newArr = new Float32Array(newSize);
		newArr.set(this.batchColorStops);
		this.batchColorStops = newArr;
	}

	private ensureBatchRibbonData(requiredFloats: number): void {
		if (this.batchRibbonData.length >= requiredFloats) return;
		const newSize = Math.max(
			requiredFloats,
			this.batchRibbonData.length * 2,
			1024,
		);
		const newArr = new Float32Array(newSize);
		newArr.set(this.batchRibbonData);
		this.batchRibbonData = newArr;
	}

	private acquireStampBuffer(requiredSize: number): GPUBuffer {
		let entry = this.stampBufferPool[this.poolIdx];
		if (!entry || entry.size < requiredSize) {
			entry?.buffer.destroy();
			const size = poolBufferSize(requiredSize, 4096);
			entry = {
				buffer: this.device.createBuffer({
					label: "Stamp Instance Buffer (Pooled)",
					size,
					usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
				}),
				size,
			};
			this.stampBufferPool[this.poolIdx] = entry;
		}
		this.poolIdx++;
		return entry.buffer;
	}

	private acquirePathMetaBuffer(requiredSize: number): GPUBuffer {
		let entry = this.pathMetaBufferPool[this.pathMetaPoolIdx];
		if (!entry || entry.size < requiredSize) {
			entry?.buffer.destroy();
			const size = poolBufferSize(requiredSize, 1024);
			entry = {
				buffer: this.device.createBuffer({
					label: "PathMeta Storage Buffer (Pooled)",
					size,
					usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
				}),
				size,
			};
			this.pathMetaBufferPool[this.pathMetaPoolIdx] = entry;
		}
		this.pathMetaPoolIdx++;
		return entry.buffer;
	}

	private acquireColorStopsBuffer(requiredSize: number): GPUBuffer {
		let entry = this.colorStopsBufferPool[this.colorStopsPoolIdx];
		if (!entry || entry.size < requiredSize) {
			entry?.buffer.destroy();
			const size = poolBufferSize(requiredSize, 256);
			entry = {
				buffer: this.device.createBuffer({
					label: "Color Stops Storage Buffer (Pooled)",
					size,
					usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
				}),
				size,
			};
			this.colorStopsBufferPool[this.colorStopsPoolIdx] = entry;
		}
		this.colorStopsPoolIdx++;
		return entry.buffer;
	}

	private resolveTextureUid(preferredUid: string): string {
		if (this.textureManager.hasTexture(preferredUid)) return preferredUid;
		if (this.textureManager.hasTexture(BUILTIN_BRUSH_IDS.softCircle)) {
			return BUILTIN_BRUSH_IDS.softCircle;
		}
		return preferredUid;
	}
}

/** Per-stroke grain parameters for the path meta (design §11). Grain is a
 *  stroke-level texture: only its strength varies per dab. */
function grainMetaOf(settings: BrushSettingsV2): {
	mode: number;
	scale: number;
	offsetX: number;
	offsetY: number;
} {
	const { grain, randomSeed } = settings;
	if (grain == null) return { mode: 0, scale: 1, offsetX: 0, offsetY: 0 };
	const mode = grain.mode === "subtract" ? 2 : 1;
	if (!grain.randomOffsetPerStroke) {
		return { mode, scale: grain.scale, offsetX: 0, offsetY: 0 };
	}
	// Seeded so the offset stays a pure function of the stroke's settings.
	let state = (randomSeed ^ 0x85ebca6b) >>> 0;
	const rand = (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return { mode, scale: grain.scale, offsetX: rand(), offsetY: rand() };
}

// ================================================================
// Shared stroke-color helpers
// ================================================================

const GRADIENT_MODE_MAP = { within: 1, along: 2, across: 3 } as const;

/** Scratch object reused across frames (rendering is synchronous). */
const _strokeMeta = {
	gradientMode: 0,
	r: 0,
	g: 0,
	b: 0,
	a: 1,
	stopCount: 0,
	lsx: 0,
	lsy: 0,
	lex: 1,
	ley: 0,
	bMinX: 0,
	bMinY: 0,
	bMaxX: 1,
	bMaxY: 1,
};

/**
 * Resolve StrokeColor into flat numeric fields used by PathMeta.
 * Returns a reusable scratch object — copy needed fields before the
 * next call. Gradient color stops are NOT written here; callers that
 * need them (batch mode) handle them separately.
 */
function resolveStrokeColorMeta(
	strokeColor: StrokeColor | undefined,
	path: Path,
): typeof _strokeMeta {
	_strokeMeta.gradientMode = 0;
	_strokeMeta.r = 0;
	_strokeMeta.g = 0;
	_strokeMeta.b = 0;
	_strokeMeta.a = 1;
	_strokeMeta.stopCount = 0;
	_strokeMeta.lsx = 0;
	_strokeMeta.lsy = 0;
	_strokeMeta.lex = 1;
	_strokeMeta.ley = 0;
	_strokeMeta.bMinX = 0;
	_strokeMeta.bMinY = 0;
	_strokeMeta.bMaxX = 1;
	_strokeMeta.bMaxY = 1;

	if (strokeColor?.type === "stroke-gradient") {
		_strokeMeta.gradientMode = GRADIENT_MODE_MAP[strokeColor.mode];
		_strokeMeta.stopCount = strokeColor.gradient.stops.length;

		if (_strokeMeta.gradientMode === 1) {
			const eb = calculateElementBounds(path);
			_strokeMeta.bMinX = eb.minX;
			_strokeMeta.bMinY = eb.minY;
			_strokeMeta.bMaxX = eb.maxX;
			_strokeMeta.bMaxY = eb.maxY;
		}
		_strokeMeta.lsx = strokeColor.gradient.x1;
		_strokeMeta.lsy = strokeColor.gradient.y1;
		_strokeMeta.lex = strokeColor.gradient.x2;
		_strokeMeta.ley = strokeColor.gradient.y2;

		if (strokeColor.gradient.stops.length > 0) {
			const c = colorToRawRGBA(strokeColor.gradient.stops[0].color);
			_strokeMeta.r = c.r;
			_strokeMeta.g = c.g;
			_strokeMeta.b = c.b;
			_strokeMeta.a = c.a;
		}
	} else if (strokeColor?.type === "solid") {
		const c = colorToRawRGBA(strokeColor.color);
		_strokeMeta.r = c.r;
		_strokeMeta.g = c.g;
		_strokeMeta.b = c.b;
		_strokeMeta.a = c.a;
	}

	return _strokeMeta;
}

/**
 * Build a Float32Array of color-stop data from a StrokeColor.
 * Used by immediate-mode rendering (single draw calls).
 */
/** Round pooled buffer sizes up to a power of two so gradual size growth
 *  reuses buffers instead of destroying/recreating them every frame. */
function poolBufferSize(requiredSize: number, minSize: number): number {
	return Math.max(2 ** Math.ceil(Math.log2(requiredSize)), minSize);
}

function buildColorStopsData(
	strokeColor: StrokeColor | undefined,
): Float32Array<ArrayBuffer> {
	const stops =
		strokeColor?.type === "stroke-gradient" ? strokeColor.gradient.stops : [];
	const stopData = new Float32Array(
		Math.max(stops.length, 1) * COLOR_STOP_FLOATS,
	);
	for (let i = 0; i < stops.length; i++) {
		const stop = stops[i];
		const c = colorToRawRGBA(stop.color);
		const off = i * COLOR_STOP_FLOATS;
		stopData[off] = stop.offset;
		stopData[off + 1] = c.r;
		stopData[off + 2] = c.g;
		stopData[off + 3] = c.b;
		stopData[off + 4] = c.a;
		stopData[off + 5] = stop.midpoint;
	}
	return stopData;
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

// ================================================================
// BrushSettingsV2 -> generator input adapters
//
// Express v2 settings in the vocabulary RibbonGenerator consumes. The
// settings object stays the source of truth; these only reshape it.
// They live here (rather than in core/brush) because the resulting structure
// is purely a renderer-side concern.
// ================================================================

/** Pick the ribbon UV layout options matching the brush method. */
/** What the ribbon geometry reads, taken off v2 settings. The width's
 *  pressure response is a two-point line from -k to 0; the generator wants
 *  that k back. */
function ribbonStrokeInputOf(settings: BrushSettingsV2): RibbonStrokeInput {
	const sizeCurve = settings.properties.size?.curves?.find(
		(curve) => curve.input === "pressure",
	);
	return {
		size: settings.properties.size?.base ?? 10,
		opacity: settings.strokeOpacity,
		flow: settings.properties.flow?.base ?? 1,
		sizeByPressure: sizeCurve ? -(sizeCurve.points[0][1] ?? 0) : 0,
		colorMode: settings.colorMode,
		taperStart: settings.taperStart,
		taperEnd: settings.taperEnd,
	};
}

/** Ribbon options plus the v2 settings whose curves modulate width and
 *  opacity. Baked paths carry the size curves' evaluation in strokeWidths,
 *  which the ribbon applies as its side ratios; size then evaluates from the
 *  base. */
function ribbonOptionsWithCurves(
	settings: BrushSettingsV2,
	ribbon: RibbonConfig,
	strokeWidthsBaked: boolean | undefined,
): RibbonOptions {
	return {
		uvMode: ribbon.uvMode,
		flipU: ribbon.flipU ?? false,
		flipV: ribbon.flipV ?? false,
		tileSpacing:
			ribbon.uvMode === "stretch" ? 0 : Math.max(ribbon.tileSpacing, 0),
		curved: strokeWidthsBaked ? neutralizeSizeCurves(settings) : settings,
	};
}
