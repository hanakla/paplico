/**
 * StrokeBatchContext - shared GPU pipeline + batch state for stamp / ribbon
 * stroke engines.
 *
 * The stamp pipeline (scatter + calligraphy via StampStrokeEngine) and the
 * ribbon pipeline (art + pattern via RibbonStrokeEngine) live here. The
 * engines route their BrushSettings union member onto the generator inputs
 * (StampGenerator / RibbonGenerator) and call back into this context.
 *
 * Batch mode draws paths sharing a texture in one draw call, so a document
 * with thousands of stamp paths issues roughly one draw per distinct brush
 * texture instead of one per path.
 */

import {
	resolveBrushTextureUid,
	resolveOptionalSourceUid,
	resolveScatterSourceUids,
} from "../../../../brush/brushSource";
import { normalizeBrushSettings } from "../../../../brush/normalize";
import { resolveBrushRenderRoute } from "../../../../brush/renderRoute";
import { toLegacyBrushSettings } from "../../../../brush/toLegacy";
import { PREVIEW_ELEMENT_SENTINEL_ID } from "../../../../document/constants";
import { createDefaultBrushSettings } from "../../../../document/factory";
import {
	type ArtBrushSettings,
	type BoundingBox,
	type BrushSettings,
	type BrushSettingsV2,
	BUILTIN_BRUSH_IDS,
	type CalligraphyBrushSettings,
	type CubicBezierSegment,
	colorToRawRGBA,
	DEFAULT_CALLIGRAPHY_SPACING,
	type Path,
	type PatternBrushSettings,
	type ScatterBrushSettings,
	type StrokeAppearance,
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
import {
	BRUSH_STAMP_ARRAY_SHADER,
	BRUSH_STAMP_SHADER,
} from "../../../shaders/brushStamp.wgsl";
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
} from "../brush/RibbonGenerator";
import {
	generateStampsDirect,
	NIB_SHAPE_CIRCLE,
	type NibShape,
	type ResidentStamps,
	type StampBuffer,
} from "../brush/StampGenerator";
import {
	replaceStampPathIndex,
	STAMP_META_INDEX_MASK,
} from "../brush/StampPacking";
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
/** Stamp: 16 floats (64 bytes) per stamp — includes width, normal, flow, and motion metadata. */
const STAMP_FLOATS = 16;

const WET_ADDITIVE_BLEND: GPUBlendState = {
	color: {
		srcFactor: "one",
		dstFactor: "one",
		operation: "add",
	},
	alpha: {
		srcFactor: "one",
		dstFactor: "one",
		operation: "add",
	},
};

const WET_MAX_BLEND: GPUBlendState = {
	color: {
		srcFactor: "one",
		dstFactor: "one",
		operation: "max",
	},
	alpha: {
		srcFactor: "one",
		dstFactor: "one",
		operation: "max",
	},
};

export const WET_ISOLATED_RENDER_TARGETS: GPUColorTargetState[] = [
	{ format: "rgba16float", blend: WET_ADDITIVE_BLEND }, // pigment
	{ format: "rgba16float", blend: WET_ADDITIVE_BLEND }, // flow (additive, normalized in seed)
	{ format: "rgba16float", blend: WET_ADDITIVE_BLEND }, // fluid (water/pooling)
	{ format: "rgba16float", blend: WET_MAX_BLEND }, // mask
];

/** One resident-store stroke draw: an instanced quad run over a contiguous
 *  stamp range in the bounded stamp store. `firstStamp` is the ABSOLUTE
 *  first-stamp index — the draw's firstInstance against the whole-buffer
 *  binding. */
interface ResidentStampDraw {
	firstStamp: number;
	stampCount: number;
	textureUid: string;
}

/** Texture resolution for a stamp stroke: the single brush texture plus
 *  (when scatter/start/end sources are set) the texture-array layout that
 *  stamp generation packed layer indices against. Carried from resolve time
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

/** A stroke drawn through the frame-pooled path, carrying the texture setup
 *  and stamp buffer already produced at resolve time. */
interface PooledStampStroke {
	path: Path;
	segments: CubicBezierSegment[];
	brushSettings: ScatterBrushSettings | CalligraphyBrushSettings;
	alphaMultiplier: number;
	transformIndex: number;
	/** The resolve-time texture setup — the pooled draw must bind the same
	 *  array (or single texture) the stamps' layer indices were packed for. */
	setup: ResolvedStampTextureSetup;
	/** The resolve-time stamp buffer. Uploaded directly while non-resident
	 *  (its pathIndex floats are still 0 — exactly the pooled per-draw meta
	 *  index); regenerated only when a resident lease baked its meta index
	 *  into the array (the same-frame-conflict fallback). */
	stamps: StampBuffer;
}

/** How a scatter/calligraphy stroke resolved against the resident stores. */
type ResidentStrokeResolution =
	/** Leased (or already resident) — draw straight from the stores. */
	| { kind: "resident"; draw: ResidentStampDraw }
	/** The stroke yields no stamps — nothing to draw. */
	| { kind: "empty" }
	/** The resident stores cannot take the stroke right now (stamp store at
	 *  cap, meta index overflow, a same-frame lease conflict, or a cache
	 *  entry too large to retain) — it must be drawn through the frame-pooled
	 *  path, with the resolved setup and generated stamps carried along. */
	| {
			kind: "pooled-fallback";
			setup: ResolvedStampTextureSetup;
			stamps: StampBuffer;
	  };

/** One entry in the batch's paint-order queue. Resident and pooled-fallback
 *  strokes share ONE queue: at flush, contiguous resident entries draw as a
 *  resident run and a pooled entry draws through the frame-pooled machinery,
 *  in exactly the queued order — a full stamp store must not drop a stroke
 *  or reorder paint. */
type BatchStampEntry =
	| { kind: "resident"; draw: ResidentStampDraw }
	| ({ kind: "pooled" } & PooledStampStroke);

export interface StrokeBatchContextOptions {
	/** Cap for the resident stamp store, in stamps. Production derives the
	 *  cap from the device limits; tests inject a small value to exercise
	 *  the pooled fallback. */
	maxResidentStamps?: number;
}

export interface WetStrokeIsolatedRenderParams {
	commandEncoder: GPUCommandEncoder;
	path: Path;
	segments: Path["segments"];
	transformsBindGroup: GPUBindGroup;
	pigmentView: GPUTextureView;
	flowView: GPUTextureView;
	fluidView: GPUTextureView;
	maskView: GPUTextureView;
	scissorRect: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	viewportUniformBuffer: GPUBuffer;
	alphaMultiplier?: number;
	viewportBounds?: BoundingBox;
	transformIndex?: number;
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
	private pipeline: GPURenderPipeline;
	private bindGroupLayout: GPUBindGroupLayout;
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

	// Texture view / sampler cache
	private textureViewCache: Map<string, GPUTextureView> = new Map();
	private cachedSampler: GPUSampler | null = null;

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
	// Stamp instances + per-stroke path metas + color stops live in
	// persistent stores keyed by the StampCache entry: a cache hit draws
	// straight from the GPU with zero uploads, no culling walk, and no
	// per-frame pathIndex rewrite (the meta's absolute store index is baked
	// into the stamps once, so meta/stops offsets must stay stable).
	private readonly stampStore: BoundedStampStore;
	private readonly dabStore: BoundedStampStore;
	private readonly metaStore: GeometryStore;
	private readonly stopsStore: GeometryStore;
	/** Paint-order queue of strokes since the last flush — resident draws
	 *  interleaved with pooled fallbacks (see BatchStampEntry). */
	private batchStampQueue: BatchStampEntry[] = [];
	private readonly residentMetaScratch = new Float32Array(PATH_META_FLOATS);
	private residentBindGroup1: GPUBindGroup | null = null;
	private residentBG1MetaBuf: GPUBuffer | null = null;
	private residentBG1StopsBuf: GPUBuffer | null = null;
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

	// Scatter (texture array) pipeline — lazy initialized
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
	private scatterPipeline: GPURenderPipeline | null = null;
	private scatterBindGroupLayout: GPUBindGroupLayout | null = null;
	private textureArrayBuilder: BrushTextureArrayBuilder | null = null;
	private wetPipeline: GPURenderPipeline | null = null;
	private wetScatterPipeline: GPURenderPipeline | null = null;
	private wetScatterBindGroupLayout: GPUBindGroupLayout | null = null;

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

		// Bounded so the resident stamp binding never exceeds the device
		// storage binding limit: the buffer grows up to min(binding limit,
		// 128 MiB); a full store falls back to the frame-pooled path.
		this.stampStore = new BoundedStampStore(device, {
			floatsPerStamp: STAMP_FLOATS,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			label: "Resident Stamp Instances",
			maxCapacityStamps: options?.maxResidentStamps,
		});
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

		const { module: shaderModule } = compileShaderModule(device, {
			label: "Brush Stamp Shader",
			code: BRUSH_STAMP_SHADER,
		});

		// Bind Group Layout 0: Viewport uniforms + Stamps + Texture
		this.bindGroupLayout = device.createBindGroupLayout({
			label: "Brush Stamp Bind Group Layout 0",
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

		// Bind Group Layout 1: PathMetas (storage) + ColorStops (storage)
		this.brushBindGroupLayout = device.createBindGroupLayout({
			label: "Brush Stamp Bind Group Layout 1",
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

		const pipelineLayout = device.createPipelineLayout({
			label: "Brush Stamp Pipeline Layout",
			bindGroupLayouts: [
				this.bindGroupLayout,
				this.brushBindGroupLayout,
				transformsBindGroupLayout,
				maskBindGroupLayout,
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

		this.pipeline = device.createRenderPipeline({
			label: "Brush Stamp Pipeline",
			layout: pipelineLayout,
			vertex: { module: shaderModule, entryPoint: "vs_main" },
			fragment: {
				module: shaderModule,
				entryPoint: "fs_main",
				targets: [{ format: canvasFormat, blend: blendState }],
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
	}

	/**
	 * Override the uniform buffer used for bind group 0.
	 * Offscreen passes call this with the per-pass uniform buffer from
	 * UniformScope so that the stamp shader reads the correct viewport
	 * parameters for the offscreen texture.
	 */
	public setActiveUniformBuffer(buffer: GPUBuffer | null): void {
		this.activeUniformBuffer = buffer;
	}

	private getEffectiveUniformBuffer(): GPUBuffer {
		return this.activeUniformBuffer ?? this.uniformBuffer;
	}

	/** Lazy-init scatter pipeline (texture_2d_array variant) */
	private ensureScatterPipeline(): {
		pipeline: GPURenderPipeline;
		bindGroupLayout: GPUBindGroupLayout;
		arrayBuilder: BrushTextureArrayBuilder;
	} {
		if (
			this.scatterPipeline &&
			this.scatterBindGroupLayout &&
			this.textureArrayBuilder
		) {
			return {
				pipeline: this.scatterPipeline,
				bindGroupLayout: this.scatterBindGroupLayout,
				arrayBuilder: this.textureArrayBuilder,
			};
		}

		const { module: shaderModule } = compileShaderModule(this.device, {
			label: "Brush Stamp Array Shader",
			code: BRUSH_STAMP_ARRAY_SHADER,
		});

		this.scatterBindGroupLayout = this.device.createBindGroupLayout({
			label: "Brush Stamp Array Bind Group Layout 0",
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
					texture: {
						sampleType: "float",
						viewDimension: "2d-array",
					},
				},
				{
					binding: 3,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "filtering" },
				},
			],
		});

		const pipelineLayout = this.device.createPipelineLayout({
			label: "Brush Stamp Array Pipeline Layout",
			bindGroupLayouts: [
				this.scatterBindGroupLayout,
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

		this.scatterPipeline = this.device.createRenderPipeline({
			label: "Brush Stamp Array Pipeline",
			layout: pipelineLayout,
			vertex: { module: shaderModule, entryPoint: "vs_main" },
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

		this.textureArrayBuilder = new BrushTextureArrayBuilder(
			this.device,
			this.textureManager,
		);

		return {
			pipeline: this.scatterPipeline,
			bindGroupLayout: this.scatterBindGroupLayout,
			arrayBuilder: this.textureArrayBuilder,
		};
	}

	private ensureWetPipeline(): GPURenderPipeline {
		if (this.wetPipeline) return this.wetPipeline;

		const { module: shaderModule } = compileShaderModule(this.device, {
			label: "Brush Stamp Wet Isolation Shader",
			code: BRUSH_STAMP_SHADER,
		});

		const pipelineLayout = this.device.createPipelineLayout({
			label: "Brush Stamp Wet Isolation Pipeline Layout",
			bindGroupLayouts: [
				this.bindGroupLayout,
				this.brushBindGroupLayout,
				this.transformsBindGroupLayout,
				this.maskBindGroupLayout,
			],
		});

		this.wetPipeline = this.device.createRenderPipeline({
			label: "Brush Stamp Wet Isolation Pipeline",
			layout: pipelineLayout,
			vertex: { module: shaderModule, entryPoint: "vs_main" },
			fragment: {
				module: shaderModule,
				entryPoint: "fs_wet",
				targets: WET_ISOLATED_RENDER_TARGETS,
			},
			primitive: { topology: "triangle-list", cullMode: "none" },
			multisample: { count: RENDER_SAMPLE_COUNT },
		});

		return this.wetPipeline;
	}

	private ensureWetScatterPipeline(): {
		pipeline: GPURenderPipeline;
		bindGroupLayout: GPUBindGroupLayout;
		arrayBuilder: BrushTextureArrayBuilder;
	} {
		if (
			this.wetScatterPipeline &&
			this.wetScatterBindGroupLayout &&
			this.textureArrayBuilder
		) {
			return {
				pipeline: this.wetScatterPipeline,
				bindGroupLayout: this.wetScatterBindGroupLayout,
				arrayBuilder: this.textureArrayBuilder,
			};
		}

		const { module: shaderModule } = compileShaderModule(this.device, {
			label: "Brush Stamp Array Wet Isolation Shader",
			code: BRUSH_STAMP_ARRAY_SHADER,
		});

		this.wetScatterBindGroupLayout = this.device.createBindGroupLayout({
			label: "Brush Stamp Array Wet Isolation Bind Group Layout 0",
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
					texture: {
						sampleType: "float",
						viewDimension: "2d-array",
					},
				},
				{
					binding: 3,
					visibility: GPUShaderStage.FRAGMENT,
					sampler: { type: "filtering" },
				},
			],
		});

		const pipelineLayout = this.device.createPipelineLayout({
			label: "Brush Stamp Array Wet Isolation Pipeline Layout",
			bindGroupLayouts: [
				this.wetScatterBindGroupLayout,
				this.brushBindGroupLayout,
				this.transformsBindGroupLayout,
				this.maskBindGroupLayout,
			],
		});

		this.wetScatterPipeline = this.device.createRenderPipeline({
			label: "Brush Stamp Array Wet Isolation Pipeline",
			layout: pipelineLayout,
			vertex: { module: shaderModule, entryPoint: "vs_main" },
			fragment: {
				module: shaderModule,
				entryPoint: "fs_wet",
				targets: WET_ISOLATED_RENDER_TARGETS,
			},
			primitive: { topology: "triangle-list", cullMode: "none" },
			multisample: { count: RENDER_SAMPLE_COUNT },
		});

		this.textureArrayBuilder ??= new BrushTextureArrayBuilder(
			this.device,
			this.textureManager,
		);

		return {
			pipeline: this.wetScatterPipeline,
			bindGroupLayout: this.wetScatterBindGroupLayout,
			arrayBuilder: this.textureArrayBuilder,
		};
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

		// Sampler with repeat U for seamless tiling. Brush textures now carry
		// mip chains for the dab pipeline; pin this legacy sampler to level 0
		// so ribbon output stays identical to the pre-mip behavior.
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
		this.stampStore.flushPendingReleases();
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
		this.batchStampQueue.length = 0;

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
	public addToBatch(
		path: Path,
		segments: CubicBezierSegment[],
		alphaMultiplier: number,
		transformIndex = 0,
	): void {
		if (segments.length === 0) return;

		const { rawBrushSettings } = StrokeBatchContext.extractStrokeParams(path);
		const route = resolveBrushRenderRoute(
			rawBrushSettings ?? createDefaultBrushSettings(),
		);

		// Geometric stroke is rendered by ElementRenderer, not the stamp pipeline.
		if (route.kind === "geometric") return;

		// Ribbon methods (pattern/art): accumulate ribbon instances separately
		if (route.kind === "ribbon-legacy") {
			const legacy = toLegacyBrushSettings(route.settings);
			if (legacy.type !== "pattern" && legacy.type !== "art") return;
			const patternSettings =
				legacy.type === "art" ? artBrushToPatternInput(legacy) : legacy;
			this.addRibbonToBatch(
				path,
				segments,
				patternSettings,
				legacy,
				alphaMultiplier,
				transformIndex,
			);
			return;
		}

		// dab-v2 strokes never enter this batch in phase 1 — the CanvasLayer
		// filter routes them through the immediate path. A stray call falls
		// back to the legacy renderer so a stroke is never dropped.
		const brushSettings = toLegacyBrushSettings(route.settings);
		if (
			brushSettings.type !== "scatter" &&
			brushSettings.type !== "calligraphy"
		) {
			return;
		}

		// Stamp methods (scatter/calligraphy) — resident lease: uploaded once,
		// every later frame draws straight from the stores. A stroke the
		// stores cannot take right now is queued as a pooled fallback in the
		// SAME paint-order queue, so it still draws, in order.
		const resolution = this.resolveResidentStroke(
			path,
			segments,
			brushSettings,
			alphaMultiplier,
			transformIndex,
			false,
		);
		if (resolution.kind === "empty") return;
		this.batchStampQueue.push(
			resolution.kind === "resident"
				? { kind: "resident", draw: resolution.draw }
				: {
						kind: "pooled",
						path,
						segments,
						brushSettings,
						alphaMultiplier,
						transformIndex,
						setup: resolution.setup,
						stamps: resolution.stamps,
					},
		);
	}

	/** Resolve the brush texture and (when scatter/start/end sources are set)
	 *  the texture-array layout. Shared by the batch, immediate, and wet
	 *  paths — array builds must match the stamp generation parameters, or a
	 *  cache entry created by one path would render wrong on another. */
	private resolveScatterTextureSetup(
		brushSettings: ScatterBrushSettings | CalligraphyBrushSettings,
		scatterSettings: ScatterBrushSettings,
		getArrayBuilder: () => BrushTextureArrayBuilder,
	): ResolvedStampTextureSetup {
		const effectiveTextureFileUid =
			resolveBrushTextureUid(brushSettings, this.textureManager) ??
			BUILTIN_BRUSH_IDS.softCircle;

		// Def sources stay unresolved here (built-in fallback): canvas-format
		// def textures are not copy-compatible with the rgba8unorm array.
		const startUid = resolveOptionalSourceUid(scatterSettings.startSource);
		const endUid = resolveOptionalSourceUid(scatterSettings.endSource);
		const scatterUids = resolveScatterSourceUids(
			scatterSettings.scatterSources,
		);
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

	/** Resolve a scatter/calligraphy stroke to its resident-store draw,
	 *  generating and leasing the stamps on first sight. Reports
	 *  "pooled-fallback" when the resident stores cannot take the run or
	 *  (with skipConflictingWrites) the lease was already synced with
	 *  different contents this frame — the caller draws it through the
	 *  frame-pooled path, and the entry stays non-resident so a later frame
	 *  with freed space retries residency naturally. */
	private resolveResidentStroke(
		path: Path,
		segments: CubicBezierSegment[],
		brushSettings: ScatterBrushSettings | CalligraphyBrushSettings,
		alphaMultiplier: number,
		transformIndex: number,
		skipConflictingWrites: boolean,
	): ResidentStrokeResolution {
		const scatterSettings: ScatterBrushSettings =
			brushSettings.type === "calligraphy"
				? calligraphyBrushToScatterInput(brushSettings)
				: brushSettings;
		const nibShape: NibShape =
			brushSettings.type === "calligraphy"
				? { aspectRatio: brushSettings.roundness }
				: NIB_SHAPE_CIRCLE;
		const setup = this.resolveScatterTextureSetup(
			brushSettings,
			scatterSettings,
			() => this.ensureScatterPipeline().arrayBuilder,
		);

		// Retrieve stamps from cache; generate and cache if not present.
		const textureAspectRatio = this.textureManager.getTextureAspectRatio(
			setup.effectiveTextureFileUid,
		);
		const cacheKey = `${path.id}:${createStampCacheFingerprint(scatterSettings, setup.effectiveTextureFileUid, textureAspectRatio)}:${nibShape.aspectRatio}:${hashStampInput(path, segments)}`;
		const stampCache = this.getStampCache();
		let fullStampBuf = stampCache.get(cacheKey);
		let retained = true;
		if (!fullStampBuf) {
			fullStampBuf = generateStampsDirect(
				segments,
				scatterSettings,
				0,
				path.pathStart ?? 0,
				path.pathEnd ?? 1,
				path.strokeWidths,
				textureAspectRatio,
				setup.variantCount,
				setup.startLayerIndex,
				setup.endLayerIndex,
				nibShape,
			);
			retained = stampCache.set(cacheKey, fullStampBuf, path.id);
		}
		if (fullStampBuf.count === 0) return { kind: "empty" };

		// A single stroke over the whole cache budget evicts itself on insert:
		// resident-izing it would create store leases no cache entry owns (and
		// so nothing would ever release) — draw it through the pooled path.
		if (!retained) {
			return { kind: "pooled-fallback", setup, stamps: fullStampBuf };
		}

		const resident = this.syncResidentStamps(
			fullStampBuf,
			path,
			alphaMultiplier,
			transformIndex,
			skipConflictingWrites,
		);
		if (!resident) {
			return { kind: "pooled-fallback", setup, stamps: fullStampBuf };
		}
		stampCache.commitResident(cacheKey);
		// Scatter mode uses a synthetic "array:"-prefixed uid so the draw loop
		// can pick the scatter pipeline (missing textures fall back to the
		// default brush).
		const textureUid = setup.textureArrayResult
			? `array:${setup.textureArrayResult.layerUids.join(",")}`
			: this.resolveTextureUid(setup.effectiveTextureFileUid);
		return {
			kind: "resident",
			draw: {
				firstStamp: resident.stamps.firstStamp,
				stampCount: fullStampBuf.count,
				textureUid,
			},
		};
	}

	/** Lease store ranges for a cached stroke on first sight; afterwards
	 *  rewrite only the meta/stops ranges whose derived contents changed.
	 *  Returns null when the stamp store cannot fit the run (the caller
	 *  falls back to the frame-pooled path), or when a rewrite is needed but
	 *  the lease was already synced this frame and skipConflictingWrites is
	 *  set — rewriting would corrupt the draws already queued against the
	 *  old contents (queue.writeBuffer lands before every draw in the
	 *  submit). */
	private syncResidentStamps(
		buf: StampBuffer,
		path: Path,
		alphaMultiplier: number,
		transformIndex: number,
		skipConflictingWrites: boolean,
	): ResidentStamps | null {
		if (!buf.resident) {
			// Admission check BEFORE any resident allocation: an overflow
			// stroke must not consume meta/stops ranges it will never draw
			// with — a same-frame burst of overflow strokes would otherwise
			// grow the stable-offset stores for data that is only released.
			if (!this.stampStore.canFit(buf.count)) return null;

			const stops = this.buildResidentStops(path);
			const stopsHandle = stops ? this.stopsStore.alloc(stops) : null;
			const meta = this.buildResidentMeta(
				path,
				alphaMultiplier,
				transformIndex,
				stopsHandle?.firstVertex ?? 0,
			);
			const metaHandle = this.metaStore.alloc(meta);
			if (metaHandle.firstVertex > STAMP_META_INDEX_MASK) {
				metaHandle.release();
				stopsHandle?.release();
				return null;
			}
			// Bake the meta's absolute store index into every stamp before the
			// one-time upload (upper 16 bits keep the scatter texture layer
			// written at generation time; cached pathIndex is always 0).
			const stamps = buf.data.slice(0, buf.count * STAMP_FLOATS);
			const u32 = StrokeBatchContext._u32Scratch;
			const f32 = StrokeBatchContext._f32Scratch;
			for (let i = 0; i < buf.count; i++) {
				const idx = i * STAMP_FLOATS + 6;
				f32[0] = stamps[idx];
				u32[0] = replaceStampPathIndex(u32[0], metaHandle.firstVertex);
				stamps[idx] = f32[0];
			}
			// canFit() was checked above, so this cannot fail; the rollback
			// stays as a safety net against admission/allocation divergence.
			const stampHandle = this.stampStore.alloc(stamps);
			if (!stampHandle) {
				metaHandle.release();
				stopsHandle?.release();
				return null;
			}
			// The store took ownership of `stamps` as its regrow mirror; the
			// cache entry shares the SAME array so the run's CPU bytes exist
			// once (StampCache budgets resident entries via byteSize alone).
			buf.data = stamps;
			buf.resident = {
				stamps: stampHandle,
				meta: metaHandle,
				stops: stopsHandle,
				metaSnapshot: meta,
				stopsSnapshot: stops,
				syncedFrame: this.frameCounter,
				byteSize:
					stamps.byteLength +
					meta.byteLength * 2 +
					(stops?.byteLength ?? 0) * 2,
			};
			return buf.resident;
		}

		const stops = this.buildResidentStops(path);
		const resident = buf.resident;
		const stopsChanged = !f32ArraysEqual(stops, resident.stopsSnapshot);
		let meta: Float32Array | null = null;
		let metaChanged = false;
		if (!stopsChanged) {
			meta = this.buildResidentMeta(
				path,
				alphaMultiplier,
				transformIndex,
				resident.stops?.firstVertex ?? 0,
			);
			metaChanged = !f32ArraysEqual(meta, resident.metaSnapshot);
		}

		if (
			(stopsChanged || metaChanged) &&
			resident.syncedFrame === this.frameCounter
		) {
			if (skipConflictingWrites) return null;
			// Batch path: overwriting a lease already synced this frame is a
			// pre-existing last-writer-wins hazard (e.g. an element drawn twice
			// in one frame with different alpha); keep the behavior but surface
			// it in dev builds.
			if (process.env.NODE_ENV !== "production") {
				console.warn(
					`[StrokeBatchContext] resident lease re-synced with different contents within one frame (path=${path.id})`,
				);
			}
		}
		resident.syncedFrame = this.frameCounter;

		let stopsMoved = false;
		if (stopsChanged) {
			if (
				stops &&
				resident.stops &&
				stops.length === resident.stops.vertexCount * COLOR_STOP_FLOATS
			) {
				resident.stops.write(stops);
			} else {
				// Stop count changed — relet the range (the meta re-bakes the
				// new absolute offset below).
				resident.stops?.release();
				resident.stops = stops ? this.stopsStore.alloc(stops) : null;
				stopsMoved = true;
			}
			resident.stopsSnapshot = stops;
			meta = this.buildResidentMeta(
				path,
				alphaMultiplier,
				transformIndex,
				resident.stops?.firstVertex ?? 0,
			);
			metaChanged = stopsMoved || !f32ArraysEqual(meta, resident.metaSnapshot);
		}
		if (metaChanged && meta) {
			resident.meta.write(meta);
			resident.metaSnapshot = meta;
		}
		resident.byteSize =
			resident.stamps.stampCount * STAMP_FLOATS * 4 +
			resident.metaSnapshot.byteLength * 2 +
			(resident.stopsSnapshot?.byteLength ?? 0) * 2;
		return resident;
	}

	/** Resident color stops for a stroke gradient (null for solid colors). */
	private buildResidentStops(path: Path): Float32Array | null {
		const { strokeColor } = StrokeBatchContext.extractStrokeParams(path);
		if (strokeColor?.type !== "stroke-gradient") return null;
		const stops = strokeColor.gradient.stops;
		const data = new Float32Array(stops.length * COLOR_STOP_FLOATS);
		for (let i = 0; i < stops.length; i++) {
			const stop = stops[i];
			const c = colorToRawRGBA(stop.color);
			const off = i * COLOR_STOP_FLOATS;
			data[off] = stop.offset;
			data[off + 1] = c.r;
			data[off + 2] = c.g;
			data[off + 3] = c.b;
			data[off + 4] = c.a;
			data[off + 5] = stop.midpoint;
		}
		return data;
	}

	private buildResidentMeta(
		path: Path,
		alphaMultiplier: number,
		transformIndex: number,
		stopOffset: number,
	): Float32Array {
		this.writeSinglePathMeta(
			this.residentMetaScratch,
			0,
			path,
			alphaMultiplier,
			transformIndex,
			stopOffset,
		);
		return this.residentMetaScratch.slice();
	}

	/**
	 * Accumulate ribbon instances for batch rendering.
	 */
	private addRibbonToBatch(
		path: Path,
		segments: CubicBezierSegment[],
		brushSettings: PatternBrushSettings,
		originalBrush: PatternBrushSettings | ArtBrushSettings,
		alphaMultiplier: number,
		transformIndex: number,
	): void {
		const ribbonOpts = this.ribbonOptionsWithCurves(path, originalBrush);
		const ribbonBuf = generateRibbonInstances(
			segments,
			brushSettings,
			this.batchPathCount,
			path.strokeWidths,
			ribbonOpts,
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
			resolveBrushTextureUid(brushSettings, this.textureManager) ??
				BUILTIN_BRUSH_IDS.softCircle,
		);

		// Add PathMeta (shared with stamps)
		this.ensureBatchPathMetas((this.batchPathCount + 1) * PATH_META_FLOATS);
		const metaOff = this.batchPathCount * PATH_META_FLOATS;
		this.writePathMeta(metaOff, path, alphaMultiplier, transformIndex);
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
		if (this.batchStampQueue.length === 0 && this.batchRibbonSegmentCount === 0)
			return;

		this.onBeforeDraw?.();

		const effectiveUniformBuffer = this.getEffectiveUniformBuffer();

		// === Stamp drawing: walk the paint-order queue ===
		// Contiguous resident entries flush as one drawResidentStamps() run
		// (zero uploads on cache hit); a pooled-fallback entry uploads and
		// draws through the frame-pooled machinery, then the walk resumes —
		// resident run → pooled stroke → next resident run keeps queue order.
		if (this.batchStampQueue.length > 0) {
			const residentRun: ResidentStampDraw[] = [];
			const flushResidentRun = () => {
				if (residentRun.length === 0) return;
				this.drawResidentStamps(
					passEncoder,
					transformsBindGroup,
					effectiveUniformBuffer,
					residentRun,
				);
				residentRun.length = 0;
			};
			for (const entry of this.batchStampQueue) {
				if (entry.kind === "resident") {
					residentRun.push(entry.draw);
					continue;
				}
				flushResidentRun();
				this.renderStampsPooled(passEncoder, entry, transformsBindGroup);
			}
			flushResidentRun();
		}

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
		this.batchStampQueue.length = 0;
		this.batchPathCount = 0;
		this.batchColorStopCount = 0;
		this.batchRibbonSegmentCount = 0;
		this.batchRibbonTextureUid = null;
	}

	/** Draw every queued resident stroke, pulling stamps/metas/stops straight
	 *  from the persistent stores. Store-adjacent same-texture strokes merge
	 *  into one instanced draw. */
	private drawResidentStamps(
		passEncoder: GPURenderPassEncoder,
		transformsBindGroup: GPUBindGroup | null,
		effectiveUniformBuffer: GPUBuffer,
		draws: readonly ResidentStampDraw[],
	): void {
		let bg0ByTexture = this.residentBG0Cache.get(effectiveUniformBuffer);
		if (!bg0ByTexture) {
			bg0ByTexture = new Map();
			this.residentBG0Cache.set(effectiveUniformBuffer, bg0ByTexture);
		}
		this.cachedSampler ??= this.textureManager.getSampler();

		// BG1-3 layouts are shared between the normal and scatter pipelines,
		// so they stay bound across pipeline switches inside the loop.
		passEncoder.setBindGroup(1, this.getResidentBindGroup1());
		if (transformsBindGroup) {
			passEncoder.setBindGroup(2, transformsBindGroup);
		}
		passEncoder.setBindGroup(3, this.getMaskBindGroup());

		// Coalesce adjacent ranges: residency allocates in draw order, so
		// consecutive strokes usually sit contiguously in the store and a
		// stable pan collapses to one draw per texture switch. Ranges are
		// only joined in queue order — painter's order is preserved.
		const merged: ResidentStampDraw[] = [];
		for (const rd of draws) {
			const last = merged.at(-1);
			if (
				last &&
				last.textureUid === rd.textureUid &&
				last.firstStamp + last.stampCount === rd.firstStamp
			) {
				last.stampCount += rd.stampCount;
			} else {
				merged.push({ ...rd });
			}
		}

		let boundPipeline: GPURenderPipeline | null = null;
		let boundBindGroup0: GPUBindGroup | null = null;
		for (const rd of merged) {
			// Re-read the stamp buffer per draw — growth replaces it — and
			// re-validate the cached per-texture bind group against it.
			const stampBuf = this.stampStore.buffer();
			const isArray = rd.textureUid.startsWith("array:");
			const arrayResult = isArray
				? this.ensureScatterPipeline().arrayBuilder.build(
						rd.textureUid.slice(6).split(","),
					)
				: null;
			const currentTexture = isArray
				? arrayResult?.texture
				: this.textureManager.getTexture(rd.textureUid);
			if (!currentTexture) continue;
			const pipeline = arrayResult
				? this.ensureScatterPipeline().pipeline
				: this.pipeline;
			let cached = bg0ByTexture.get(rd.textureUid);
			if (
				!cached ||
				cached.texture !== currentTexture ||
				cached.stampBuf !== stampBuf
			) {
				const target = this.resolveStampDrawTarget(arrayResult, rd.textureUid);
				if (!target) continue;
				cached = {
					texture: currentTexture,
					stampBuf,
					bindGroup: this.device.createBindGroup({
						label: arrayResult
							? "Brush Scatter Bind Group 0"
							: "Brush Batch Bind Group 0",
						layout: target.layout,
						entries: [
							{
								binding: 0,
								resource: { buffer: effectiveUniformBuffer },
							},
							{ binding: 1, resource: { buffer: stampBuf } },
							{ binding: 2, resource: target.textureView },
							{ binding: 3, resource: target.sampler },
						],
					}),
				};
				bg0ByTexture.set(rd.textureUid, cached);
			}
			if (boundPipeline !== pipeline) {
				passEncoder.setPipeline(pipeline);
				boundPipeline = pipeline;
			}
			if (boundBindGroup0 !== cached.bindGroup) {
				passEncoder.setBindGroup(0, cached.bindGroup);
				boundBindGroup0 = cached.bindGroup;
			}
			passEncoder.draw(6, rd.stampCount, 0, rd.firstStamp);
		}
	}

	/** Pipeline, bind-group layout, texture view, and sampler for one stamp
	 *  draw: the scatter texture_2d_array variant when `arrayResult` is set,
	 *  else the single-texture variant for `textureUid` (already resolved
	 *  through resolveTextureUid). Shared by the resident and pooled draw
	 *  paths so array-vs-single binding cannot diverge between them. Returns
	 *  null when the single texture is missing. */
	private resolveStampDrawTarget(
		arrayResult: TextureArrayResult | null,
		textureUid: string,
	): {
		pipeline: GPURenderPipeline;
		layout: GPUBindGroupLayout;
		textureView: GPUTextureView;
		sampler: GPUSampler;
	} | null {
		if (arrayResult) {
			const { pipeline, bindGroupLayout } = this.ensureScatterPipeline();
			return {
				pipeline,
				layout: bindGroupLayout,
				textureView: arrayResult.texture.createView({
					dimension: "2d-array",
				}),
				sampler: arrayResult.sampler,
			};
		}
		const texture = this.textureManager.getTexture(textureUid);
		if (!texture) return null;
		let textureView = this.textureViewCache.get(textureUid);
		if (!textureView) {
			textureView = texture.createView();
			this.textureViewCache.set(textureUid, textureView);
		}
		this.cachedSampler ??= this.textureManager.getSampler();
		return {
			pipeline: this.pipeline,
			layout: this.bindGroupLayout,
			textureView,
			sampler: this.cachedSampler,
		};
	}

	private getResidentBindGroup1(): GPUBindGroup {
		const metaBuffer = this.metaStore.buffer();
		const stopsBuffer = this.stopsStore.buffer();
		if (
			this.residentBindGroup1 &&
			this.residentBG1MetaBuf === metaBuffer &&
			this.residentBG1StopsBuf === stopsBuffer
		) {
			return this.residentBindGroup1;
		}
		const bindGroup = this.device.createBindGroup({
			label: "Resident Brush Bind Group 1",
			layout: this.brushBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: metaBuffer } },
				{ binding: 1, resource: { buffer: stopsBuffer } },
			],
		});
		this.residentBindGroup1 = bindGroup;
		this.residentBG1MetaBuf = metaBuffer;
		this.residentBG1StopsBuf = stopsBuffer;
		return bindGroup;
	}

	// ================================================================
	// Immediate draw API (fallback for offscreen/stencil)
	// ================================================================

	/**
	 * Draw a single path immediately. Used where batching does not apply (offscreen, stencil, etc.).
	 */
	public renderWetStrokeIsolated({
		commandEncoder,
		path,
		segments,
		transformsBindGroup,
		pigmentView,
		flowView,
		fluidView,
		maskView,
		scissorRect,
		viewportUniformBuffer,
		alphaMultiplier = 1,
		viewportBounds,
		transformIndex = 0,
	}: WetStrokeIsolatedRenderParams): void {
		if (segments.length === 0) return;
		if (scissorRect.width <= 0 || scissorRect.height <= 0) return;

		const { brushSettings: pathBrushSettings } =
			StrokeBatchContext.extractStrokeParams(path);
		const brushSettings: BrushSettings =
			pathBrushSettings ?? createDefaultBrushSettings();

		if (
			brushSettings.type === "pattern" ||
			brushSettings.type === "art" ||
			brushSettings.type === "stroke"
		) {
			return;
		}

		const scatterSettings: ScatterBrushSettings =
			brushSettings.type === "calligraphy"
				? calligraphyBrushToScatterInput(brushSettings)
				: brushSettings;
		const nibShape: NibShape =
			brushSettings.type === "calligraphy"
				? { aspectRatio: brushSettings.roundness }
				: NIB_SHAPE_CIRCLE;
		const setup = this.resolveScatterTextureSetup(
			brushSettings,
			scatterSettings,
			() => this.ensureWetScatterPipeline().arrayBuilder,
		);
		if (setup.usesTextureArray && !setup.textureArrayResult) return;
		const { effectiveTextureFileUid, textureArrayResult } = setup;

		const textureAspectRatio = this.textureManager.getTextureAspectRatio(
			effectiveTextureFileUid,
		);
		let stampBuf: StampBuffer = generateStampsDirect(
			segments,
			scatterSettings,
			0,
			path.pathStart ?? 0,
			path.pathEnd ?? 1,
			path.strokeWidths,
			textureAspectRatio,
			setup.variantCount,
			setup.startLayerIndex,
			setup.endLayerIndex,
			nibShape,
		);
		if (stampBuf.count === 0) return;

		if (viewportBounds) {
			const t = path.transform;
			if (
				t.rotation === 0 &&
				t.scaleX === 1 &&
				t.scaleY === 1 &&
				(t.skewX ?? 0) === 0 &&
				(t.skewY ?? 0) === 0
			) {
				const brushSize = scatterSettings.size;
				const margin = brushSize * 0.5 + 10;
				const localBounds: BoundingBox = {
					minX: viewportBounds.minX - t.x,
					minY: viewportBounds.minY - t.y,
					maxX: viewportBounds.maxX - t.x,
					maxY: viewportBounds.maxY - t.y,
					width: viewportBounds.width,
					height: viewportBounds.height,
				};
				stampBuf = cullStampBufferToViewport(stampBuf, localBounds, margin);
				if (stampBuf.count === 0) return;
			}
		}

		const stampFloatCount = stampBuf.count * STAMP_FLOATS;
		const stampByteLength = stampFloatCount * 4;
		const stampBuffer = this.acquireStampBuffer(stampByteLength);
		const stampView = stampBuf.data.subarray(0, stampFloatCount);
		this.device.queue.writeBuffer(
			stampBuffer,
			0,
			stampView.buffer as ArrayBuffer,
			stampView.byteOffset,
			stampView.byteLength,
		);

		const singleMeta = new Float32Array(PATH_META_FLOATS);
		this.writeSinglePathMeta(
			singleMeta,
			0,
			path,
			alphaMultiplier,
			transformIndex,
		);
		const pathMetaBuffer = this.acquirePathMetaBuffer(PATH_META_FLOATS * 4);
		this.device.queue.writeBuffer(pathMetaBuffer, 0, singleMeta);

		const { strokeColor: renderStrokeColor } =
			StrokeBatchContext.extractStrokeParams(path);
		const stopData = buildColorStopsData(renderStrokeColor);
		const colorStopsBuffer = this.acquireColorStopsBuffer(stopData.byteLength);
		this.device.queue.writeBuffer(colorStopsBuffer, 0, stopData);

		const bindGroup1 = this.device.createBindGroup({
			label: "Brush Stamp Wet Isolation Bind Group 1",
			layout: this.brushBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: pathMetaBuffer } },
				{ binding: 1, resource: { buffer: colorStopsBuffer } },
			],
		});

		let pipeline: GPURenderPipeline;
		let bindGroup0: GPUBindGroup;
		if (textureArrayResult) {
			const wetScatter = this.ensureWetScatterPipeline();
			const arrayView = textureArrayResult.texture.createView({
				dimension: "2d-array",
			});
			bindGroup0 = this.device.createBindGroup({
				label: "Brush Stamp Array Wet Isolation Bind Group 0",
				layout: wetScatter.bindGroupLayout,
				entries: [
					{ binding: 0, resource: { buffer: viewportUniformBuffer } },
					{ binding: 1, resource: { buffer: stampBuffer } },
					{ binding: 2, resource: arrayView },
					{ binding: 3, resource: textureArrayResult.sampler },
				],
			});
			pipeline = wetScatter.pipeline;
		} else {
			const textureUid = this.resolveTextureUid(effectiveTextureFileUid);
			const texture = this.textureManager.getTexture(textureUid);
			if (!texture) return;
			let textureView = this.textureViewCache.get(textureUid);
			if (!textureView) {
				textureView = texture.createView();
				this.textureViewCache.set(textureUid, textureView);
			}
			this.cachedSampler ??= this.textureManager.getSampler();
			bindGroup0 = this.device.createBindGroup({
				label: "Brush Stamp Wet Isolation Bind Group 0",
				layout: this.bindGroupLayout,
				entries: [
					{ binding: 0, resource: { buffer: viewportUniformBuffer } },
					{ binding: 1, resource: { buffer: stampBuffer } },
					{ binding: 2, resource: textureView },
					{ binding: 3, resource: this.cachedSampler },
				],
			});
			pipeline = this.ensureWetPipeline();
		}

		const passEncoder = commandEncoder.beginRenderPass({
			label: "Brush Stamp Wet Isolation Pass",
			colorAttachments: [
				{
					view: pigmentView,
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
				{
					view: flowView,
					clearValue: [0, 0, 0, 0],
					loadOp: "clear" as const,
					storeOp: "store" as const,
				},
				{
					view: fluidView,
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
				{
					view: maskView,
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
				},
			],
		});
		passEncoder.setViewport(
			0,
			0,
			Math.max(0, Math.ceil(scissorRect.width)),
			Math.max(0, Math.ceil(scissorRect.height)),
			0,
			1,
		);
		passEncoder.setScissorRect(
			Math.max(0, Math.floor(scissorRect.x)),
			Math.max(0, Math.floor(scissorRect.y)),
			Math.max(0, Math.ceil(scissorRect.width)),
			Math.max(0, Math.ceil(scissorRect.height)),
		);

		passEncoder.setPipeline(pipeline);
		passEncoder.setBindGroup(0, bindGroup0);
		passEncoder.setBindGroup(1, bindGroup1);
		passEncoder.setBindGroup(2, transformsBindGroup);
		passEncoder.setBindGroup(3, this.getMaskBindGroup());
		passEncoder.draw(6, stampBuf.count, 0, 0);
		passEncoder.end();
	}

	public render(
		passEncoder: GPURenderPassEncoder,
		path: Path,
		alphaMultiplier: number = 1.0,
		_pipelineType: PipelineType = "main",
		segments?: Path["segments"],
		transformsBindGroup?: GPUBindGroup,
		transformIndex = 0,
	): void {
		const actualSegments = segments ?? path.segments;
		if (actualSegments.length === 0) return;

		const { rawBrushSettings } = StrokeBatchContext.extractStrokeParams(path);
		const route = resolveBrushRenderRoute(
			rawBrushSettings ?? createDefaultBrushSettings(),
		);

		// Geometric stroke is rendered by ElementRenderer, not the stamp pipeline.
		if (route.kind === "geometric") return;

		// Ribbon methods (pattern/art): bezier segment instancing through the
		// legacy renderer until the ribbon integration phase.
		if (route.kind === "ribbon-legacy") {
			const legacy = toLegacyBrushSettings(route.settings);
			if (legacy.type !== "pattern" && legacy.type !== "art") return;
			const patternSettings =
				legacy.type === "art" ? artBrushToPatternInput(legacy) : legacy;
			this.renderRibbon(
				passEncoder,
				path,
				actualSegments,
				patternSettings,
				legacy,
				alphaMultiplier,
				transformsBindGroup,
				transformIndex,
			);
			return;
		}

		// v2 dab pipeline (curve matrix + linearize + procedural tips).
		if (route.kind === "dab-v2") {
			this.renderDabsV2(
				passEncoder,
				path,
				route.settings,
				actualSegments,
				alphaMultiplier,
				transformsBindGroup,
				transformIndex,
			);
			return;
		}

		// dab-legacy: wetV1 keeps the v1 stamp path authoritative until the wet
		// switchover (design §13-7).
		const brushSettings = toLegacyBrushSettings(route.settings);
		if (
			brushSettings.type !== "scatter" &&
			brushSettings.type !== "calligraphy"
		) {
			return;
		}

		// Stamp methods (scatter/calligraphy) — draw straight from the resident
		// stores (zero uploads on cache hit; off-screen stamps clip in the
		// vertex shader instead of the old CPU culling walk).
		const resolution = this.resolveResidentStroke(
			path,
			actualSegments,
			brushSettings,
			alphaMultiplier,
			transformIndex,
			true,
		);
		if (resolution.kind === "empty") return;
		if (resolution.kind === "resident") {
			this.drawResidentStamps(
				passEncoder,
				transformsBindGroup ?? null,
				this.getEffectiveUniformBuffer(),
				[resolution.draw],
			);
			return;
		}
		this.renderStampsPooled(
			passEncoder,
			{
				path,
				segments: actualSegments,
				brushSettings,
				alphaMultiplier,
				transformIndex,
				setup: resolution.setup,
				stamps: resolution.stamps,
			},
			transformsBindGroup,
		);
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
		settings: BrushSettingsV2;
		segments: CubicBezierSegment[];
		alphaMultiplier: number;
		transformsBindGroup: GPUBindGroup | undefined;
		transformIndex: number;
	}): void {
		const tip = this.resolveDabTipSetup(args.settings);
		if (!tip) return;

		const dabs = evaluateDabs(args.segments, args.settings, {
			pathStart: args.path.pathStart ?? 0,
			pathEnd: args.path.pathEnd ?? 1,
			strokeWidths: args.path.strokeWidths,
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
		this.writeSinglePathMeta(
			singleMeta,
			0,
			args.path,
			args.alphaMultiplier,
			args.transformIndex,
		);
		const pathMetaBuffer = this.acquirePathMetaBuffer(PATH_META_FLOATS * 4);
		this.device.queue.writeBuffer(pathMetaBuffer, 0, singleMeta);
		const { strokeColor } = StrokeBatchContext.extractStrokeParams(args.path);
		const stopData = buildColorStopsData(strokeColor);
		const colorStopsBuffer = this.acquireColorStopsBuffer(stopData.byteLength);
		this.device.queue.writeBuffer(colorStopsBuffer, 0, stopData);

		const { pipeline, bindGroupLayout } = this.ensureWetSeedPipeline(
			tip.tipMode,
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
					{ binding: 1, resource: { buffer: dabBuffer } },
					{ binding: 2, resource: tip.textureView },
					{ binding: 3, resource: tip.sampler },
					...this.grainBindings(args.path),
				],
			}),
		);
		args.passEncoder.setBindGroup(
			1,
			this.device.createBindGroup({
				label: "Wet Seed Bind Group 1",
				layout: this.brushBindGroupLayout,
				entries: [
					{ binding: 0, resource: { buffer: pathMetaBuffer } },
					{ binding: 1, resource: { buffer: colorStopsBuffer } },
				],
			}),
		);
		if (args.transformsBindGroup) {
			args.passEncoder.setBindGroup(2, args.transformsBindGroup);
		}
		args.passEncoder.setBindGroup(3, this.getMaskBindGroup());
		args.passEncoder.draw(6, dabs.count);
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
	private ensureWetSeedPipeline(mode: DabTipMode): {
		pipeline: GPURenderPipeline;
		bindGroupLayout: GPUBindGroupLayout;
	} {
		const cacheKey = `${mode}:wetSeed`;
		const existing = this.dabPipelines.get(cacheKey);
		if (existing) return existing;

		const { module } = compileShaderModule(this.device, {
			label: `Brush Dab Shader (${cacheKey})`,
			code: buildBrushDabShader({ tipMode: mode, wetSeed: true }),
		});
		const bindGroupLayout = this.createDabBindGroupLayout(mode, cacheKey);
		const pipeline = this.device.createRenderPipeline({
			label: `Brush Dab Pipeline (${cacheKey})`,
			layout: this.device.createPipelineLayout({
				label: `Brush Dab Pipeline Layout (${cacheKey})`,
				bindGroupLayouts: [
					bindGroupLayout,
					this.brushBindGroupLayout,
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
		this.writeSinglePathMeta(
			singleMeta,
			0,
			args.path,
			args.alphaMultiplier,
			args.transformIndex,
		);
		const pathMetaBuffer = this.acquirePathMetaBuffer(PATH_META_FLOATS * 4);
		this.device.queue.writeBuffer(pathMetaBuffer, 0, singleMeta);
		const { strokeColor } = StrokeBatchContext.extractStrokeParams(args.path);
		const stopData = buildColorStopsData(strokeColor);
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
				...this.grainBindings(args.path),
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
			// Texture resolution reuses the battle-tested v1 machinery through
			// the down-converted view (uids, variant arrays, start/end layers).
			const legacy = toLegacyBrushSettings(settings);
			if (legacy.type !== "scatter") return null;
			const setup = this.resolveScatterTextureSetup(
				legacy,
				legacy,
				() => this.ensureScatterPipeline().arrayBuilder,
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
			// The dab pipeline trilinearly filters the tip mip chain; the legacy
			// stamp path keeps its level-0-pinned sampler.
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
		path: Path,
		settings: BrushSettingsV2,
		segments: CubicBezierSegment[],
		alphaMultiplier: number,
		transformsBindGroup: GPUBindGroup | undefined,
		transformIndex: number,
	): void {
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
		this.writeSinglePathMeta(
			singleMeta,
			0,
			path,
			alphaMultiplier,
			transformIndex,
		);
		const pathMetaBuffer = this.acquirePathMetaBuffer(PATH_META_FLOATS * 4);
		this.device.queue.writeBuffer(pathMetaBuffer, 0, singleMeta);

		const { strokeColor } = StrokeBatchContext.extractStrokeParams(path);
		const stopData = buildColorStopsData(strokeColor);
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
				...this.grainBindings(path),
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
	private grainBindings(path: Path): GPUBindGroupEntry[] {
		const { rawBrushSettings } = StrokeBatchContext.extractStrokeParams(path);
		const grain =
			rawBrushSettings != null
				? resolveBrushRenderRoute(rawBrushSettings).settings.grain
				: undefined;
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

	/** Per-frame pooled fallback when a resident lease cannot be used: the
	 *  rare same-submit conflict (an element drawn twice in one frame with
	 *  different derived meta, e.g. the editing-scope dim overlay), a full
	 *  resident stamp store, and a cache entry too large to retain. Uploads
	 *  this draw's stamps to the pool so the resident stores stay untouched.
	 *  Called from both the immediate render() path and the batch flush's
	 *  paint-order queue walk. */
	private renderStampsPooled(
		passEncoder: GPURenderPassEncoder,
		stroke: PooledStampStroke,
		transformsBindGroup: GPUBindGroup | undefined,
	): void {
		const { path, brushSettings, setup } = stroke;
		// The resolve-time buffer uploads as-is while it never went resident:
		// its pathIndex floats are still 0, exactly the pooled per-draw meta
		// index. Once a resident lease baked its meta index into the array
		// (the same-frame-conflict fallback), regenerate — with the SAME
		// resolved setup, so texture-array layer packing matches the resident
		// path. Residency is re-checked here, at draw time: a later draw in
		// the same frame may have resident-ized the shared cache entry.
		let stampBuf = stroke.stamps;
		if (stampBuf.resident) {
			const scatterSettings: ScatterBrushSettings =
				brushSettings.type === "calligraphy"
					? calligraphyBrushToScatterInput(brushSettings)
					: brushSettings;
			const nibShape: NibShape =
				brushSettings.type === "calligraphy"
					? { aspectRatio: brushSettings.roundness }
					: NIB_SHAPE_CIRCLE;
			stampBuf = generateStampsDirect(
				stroke.segments,
				scatterSettings,
				0, // pathIndex=0 for single-path rendering (PathMeta[0])
				path.pathStart ?? 0,
				path.pathEnd ?? 1,
				path.strokeWidths,
				this.textureManager.getTextureAspectRatio(
					setup.effectiveTextureFileUid,
				),
				setup.variantCount,
				setup.startLayerIndex,
				setup.endLayerIndex,
				nibShape,
			);
		}
		if (stampBuf.count === 0) return;

		// Stamp buffer — use a subarray view so writeBuffer reads exactly
		// count * STAMP_FLOATS floats, avoiding offset/size mismatch when the
		// backing Float32Array is larger than the valid stamp region.
		const stampFloatCount = stampBuf.count * STAMP_FLOATS;
		const stampByteLength = stampFloatCount * 4;
		const stampBuffer = this.acquireStampBuffer(stampByteLength);
		const stampView = stampBuf.data.subarray(0, stampFloatCount);
		this.device.queue.writeBuffer(
			stampBuffer,
			0,
			stampView.buffer as ArrayBuffer,
			stampView.byteOffset,
			stampView.byteLength,
		);

		// PathMeta (one entry)
		const singleMeta = new Float32Array(PATH_META_FLOATS);
		this.writeSinglePathMeta(
			singleMeta,
			0,
			path,
			stroke.alphaMultiplier,
			stroke.transformIndex,
		);
		const pathMetaBuffer = this.acquirePathMetaBuffer(PATH_META_FLOATS * 4);
		this.device.queue.writeBuffer(pathMetaBuffer, 0, singleMeta);

		// ColorStops
		const { strokeColor: renderStrokeColor } =
			StrokeBatchContext.extractStrokeParams(path);
		const stopData = buildColorStopsData(renderStrokeColor);
		const colorStopsBuffer = this.acquireColorStopsBuffer(stopData.byteLength);
		this.device.queue.writeBuffer(colorStopsBuffer, 0, stopData);

		// Texture: bind the carried array (or single texture, falling back to
		// the default brush when missing) exactly as the resident path would.
		const target = this.resolveStampDrawTarget(
			setup.textureArrayResult,
			this.resolveTextureUid(setup.effectiveTextureFileUid),
		);
		if (!target) return;

		const bindGroup0 = this.device.createBindGroup({
			label: "Brush Stamp Bind Group 0",
			layout: target.layout,
			entries: [
				{ binding: 0, resource: { buffer: this.getEffectiveUniformBuffer() } },
				{ binding: 1, resource: { buffer: stampBuffer } },
				{ binding: 2, resource: target.textureView },
				{ binding: 3, resource: target.sampler },
			],
		});

		const bindGroup1 = this.device.createBindGroup({
			label: "Brush Stamp Bind Group 1",
			layout: this.brushBindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: pathMetaBuffer } },
				{ binding: 1, resource: { buffer: colorStopsBuffer } },
			],
		});

		passEncoder.setPipeline(target.pipeline);
		passEncoder.setBindGroup(0, bindGroup0);
		passEncoder.setBindGroup(1, bindGroup1);
		if (transformsBindGroup) {
			passEncoder.setBindGroup(2, transformsBindGroup);
		}
		passEncoder.setBindGroup(3, this.getMaskBindGroup());
		passEncoder.draw(6, stampBuf.count, 0, 0);
	}

	/**
	 * Single-path ribbon rendering (offscreen/stencil fallback).
	 */
	private renderRibbon(
		passEncoder: GPURenderPassEncoder,
		path: Path,
		segments: CubicBezierSegment[],
		brushSettings: PatternBrushSettings,
		originalBrush: PatternBrushSettings | ArtBrushSettings,
		alphaMultiplier: number,
		transformsBindGroup: GPUBindGroup | undefined,
		transformIndex: number,
	): void {
		const ribbonOpts = this.ribbonOptionsWithCurves(path, originalBrush);
		const ribbonBuf = generateRibbonInstances(
			segments,
			brushSettings,
			0,
			path.strokeWidths,
			ribbonOpts,
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
		this.writeSinglePathMeta(
			singleMeta,
			0,
			path,
			alphaMultiplier,
			transformIndex,
		);
		const pathMetaBuffer = this.acquirePathMetaBuffer(PATH_META_FLOATS * 4);
		this.device.queue.writeBuffer(pathMetaBuffer, 0, singleMeta);

		// ColorStops
		const { strokeColor: renderStrokeColor } =
			StrokeBatchContext.extractStrokeParams(path);
		const stopData = buildColorStopsData(renderStrokeColor);
		const colorStopsBuffer = this.acquireColorStopsBuffer(stopData.byteLength);
		this.device.queue.writeBuffer(colorStopsBuffer, 0, stopData);

		// Texture
		const textureUid = this.resolveTextureUid(
			resolveBrushTextureUid(brushSettings, this.textureManager) ??
				BUILTIN_BRUSH_IDS.softCircle,
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
		this.cachedSampler = null;
		this.cachedBindGroup1 = null;
		this.stampStore.destroy();
		this.metaStore.destroy();
		this.stopsStore.destroy();
		this.batchStampQueue.length = 0;
		this.residentBG0Cache = new WeakMap();
		this.residentBindGroup1 = null;
		this.residentBG1MetaBuf = null;
		this.residentBG1StopsBuf = null;
		this.textureArrayBuilder?.destroy();
		this.textureArrayBuilder = null;
		this.wetPipeline = null;
		this.wetScatterPipeline = null;
		this.wetScatterBindGroupLayout = null;
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
	private writePathMeta(
		metaOff: number,
		path: Path,
		alphaMultiplier: number,
		transformIndex = 0,
	): void {
		const { strokeColor, brushSettings } =
			StrokeBatchContext.extractStrokeParams(path);

		const sm = resolveStrokeColorMeta(strokeColor, path);
		const stopOffset = this.batchColorStopCount;
		const a = sm.a * alphaMultiplier;

		// Write gradient color stops to batch buffer
		if (strokeColor?.type === "stroke-gradient") {
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
		this.writeSinglePathMeta(
			this.batchPathMetas,
			metaOff,
			path,
			alphaMultiplier,
			transformIndex,
			stopOffset,
		);
	}

	/**
	 * Single-path PathMeta write (for render()).
	 */
	private writeSinglePathMeta(
		data: Float32Array,
		offset: number,
		path: Path,
		alphaMultiplier: number,
		transformIndex = 0,
		stopOffset = 0,
	): void {
		const { strokeColor, brushSettings } =
			StrokeBatchContext.extractStrokeParams(path);

		const sm = resolveStrokeColorMeta(strokeColor, path);
		const a = sm.a * alphaMultiplier;

		// Pack colorMode into upper bits of gradientMode (bit 16)
		const colorModeBit = brushSettings?.colorMode === "color" ? 1 << 16 : 0;

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
		const grain = StrokeBatchContext.grainMetaOf(path);
		u32View[0] = grain.mode;
		data[offset + 16] = f32View[0];
		data[offset + 17] = grain.scale;
		data[offset + 18] = grain.offsetX;
		data[offset + 19] = grain.offsetY;

		// Ribbon tiling used to live in one uniform shared by the whole batch,
		// which made the last path in a run dictate every other path's tiling.
		const ribbon = this.ribbonMetaOf(path, brushSettings);
		data[offset + 20] = ribbon.stretch;
		data[offset + 21] = ribbon.uvOffset;
		data[offset + 22] = ribbon.aspectRatio;
		data[offset + 23] = ribbon.stampAngle;
	}

	/** Ribbon options plus the v2 settings whose curves modulate width and
	 *  opacity, when the stroke is on the v2 route. */
	private ribbonOptionsWithCurves(
		path: Path,
		originalBrush: PatternBrushSettings | ArtBrushSettings,
	): RibbonOptions {
		const base = ribbonOptionsFor(originalBrush);
		const { rawBrushSettings } = StrokeBatchContext.extractStrokeParams(path);
		if (rawBrushSettings == null) return base;
		const route = resolveBrushRenderRoute(rawBrushSettings);
		if (route.kind !== "ribbon-legacy") return base;
		return { ...base, curved: route.settings };
	}

	/** Per-path ribbon tiling for the path meta. Zeroed for non-ribbon
	 *  brushes, which never read these fields. */
	private ribbonMetaOf(
		path: Path,
		brushSettings: BrushSettings | undefined,
	): {
		stretch: number;
		uvOffset: number;
		aspectRatio: number;
		stampAngle: number;
	} {
		if (
			brushSettings == null ||
			(brushSettings.type !== "art" && brushSettings.type !== "pattern")
		) {
			return { stretch: 0, uvOffset: 0, aspectRatio: 1, stampAngle: 0 };
		}
		const textureUid = this.resolveTextureUid(
			resolveBrushTextureUid(brushSettings, this.textureManager) ??
				BUILTIN_BRUSH_IDS.softCircle,
		);
		// The shader has always rotated the ribbon's texture by a stamp angle
		// that nothing ever set; the v2 angle property is that value.
		const { rawBrushSettings } = StrokeBatchContext.extractStrokeParams(path);
		const stampAngle =
			rawBrushSettings != null
				? (resolveBrushRenderRoute(rawBrushSettings).settings.properties.angle
						?.base ?? 0)
				: 0;
		return {
			stretch:
				brushSettings.type === "pattern" ? brushSettings.tileScale - 1 : 0,
			uvOffset:
				brushSettings.type === "pattern" ? (brushSettings.uvOffset ?? 0) : 0,
			aspectRatio: this.textureManager.getTextureAspectRatio(textureUid),
			stampAngle,
		};
	}

	/** Per-stroke grain parameters for the path meta (design §11). Grain is a
	 *  stroke-level texture: only its strength varies per dab. */
	private static grainMetaOf(path: Path): {
		mode: number;
		scale: number;
		offsetX: number;
		offsetY: number;
	} {
		const off = { mode: 0, scale: 1, offsetX: 0, offsetY: 0 };
		const { rawBrushSettings } = StrokeBatchContext.extractStrokeParams(path);
		if (rawBrushSettings == null) return off;
		const { grain, randomSeed } =
			resolveBrushRenderRoute(rawBrushSettings).settings;
		if (grain == null) return off;
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

	/** Extract stroke appearance params from path filters */
	private static extractStrokeParams(path: Path): {
		strokeColor: StrokeColor | undefined;
		brushSettings: BrushSettings | undefined;
		/** Stored value as-is — route resolution MUST use this: the legacy
		 *  view drops v2-only state (paintMode, curves, wet config). */
		rawBrushSettings: unknown;
	} {
		const strokeApp = path.filters?.find((f) => f.processor === "stroke") as
			| StrokeAppearance
			| undefined;
		const rawBrushSettings = strokeApp?.paramData.params.brushSettings;
		return {
			strokeColor: strokeApp?.paramData.params.strokeColor,
			brushSettings:
				rawBrushSettings != null
					? normalizeBrushSettings(rawBrushSettings)
					: undefined,
			rawBrushSettings,
		};
	}
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

function f32ArraysEqual(
	a: Float32Array | null,
	b: Float32Array | null,
): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
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

/** Build a cache key fingerprint from stamp-affecting brush settings fields. */
function createStampCacheFingerprint(
	b: ScatterBrushSettings,
	textureUid: string,
	textureAspectRatio = 1,
): string {
	const scatterUids = resolveScatterSourceUids(b.scatterSources).join(",");
	const startUid = resolveOptionalSourceUid(b.startSource) ?? "";
	const endUid = resolveOptionalSourceUid(b.endSource) ?? "";
	return `${textureUid}|${b.size}|${b.sizeByPressure}|${b.sizeBySpeed}|${b.spacing}|${b.flow}|${b.stampRotation}|${b.stampAngle ?? 0}|${b.rotationByTilt}|${b.aspectRatioByTilt}|${b.pooling}|${b.poolingSizeRatio}|${textureAspectRatio}|${b.colorMode ?? ""}|${scatterUids}|${startUid}|${endUid}|${b.scatterOffset ?? 0}|${b.scatterSizeVariation ?? 0}|${b.taperStart ?? 0}|${b.taperEnd ?? 0}`;
}

function hashStampInput(path: Path, segments: CubicBezierSegment[]): string {
	let h = hashSegmentsWithMetadata(segments);
	h = (h * 31 + floatBits(path.pathStart ?? 0)) | 0;
	h = (h * 31 + floatBits(path.pathEnd ?? 1)) | 0;
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
// Brush method -> generator input adapters
//
// Map a calligraphy / art union member onto the input shape consumed by
// StampGenerator / RibbonGenerator. The union member stays the source of
// truth; the adapter simply expresses it in the generator's vocabulary.
// They live here (rather than in core/brush) because the resulting structure
// is purely a renderer-side concern.
// ================================================================

/** Render-time input for the stamp generator built from a calligraphy brush. */
function calligraphyBrushToScatterInput(
	s: CalligraphyBrushSettings,
): ScatterBrushSettings {
	return {
		type: "scatter",
		// The procedural elliptical nib bypasses texture sampling in the shader,
		// but a stamp pipeline still needs a placeholder source: bind the
		// hard-circle texture so the bind group remains valid.
		source: { kind: "file", fileUid: BUILTIN_BRUSH_IDS.hardCircle },
		size: s.size,
		sizeByPressure: s.sizeByPressure,
		opacity: s.opacity,
		opacityByPressure: s.opacityByPressure,
		randomSeed: s.randomSeed,
		colorMode: s.colorMode,
		spacing: s.spacing ?? DEFAULT_CALLIGRAPHY_SPACING,
		flow: s.flow,
		stampRotation: s.angleMode === "tangent" ? "tangent" : "none",
		stampAngle: s.nibAngle,
		rotationByTilt: s.angleMode === "tilt" ? 1 : 0,
		aspectRatioByTilt: 0,
		sizeBySpeed: s.sizeBySpeed,
		pooling: s.pooling,
		poolingSizeRatio: s.poolingSizeRatio,
		taperStart: s.taperStart,
		taperEnd: s.taperEnd,
	};
}

/** Render-time input for the ribbon generator built from an art brush. */
function artBrushToPatternInput(s: ArtBrushSettings): PatternBrushSettings {
	return {
		type: "pattern",
		source: s.source,
		size: s.size,
		sizeByPressure: s.sizeByPressure,
		opacity: s.opacity,
		opacityByPressure: s.opacityByPressure,
		randomSeed: s.randomSeed,
		colorMode: s.colorMode,
		flow: s.flow,
		tileScale: 1,
		tileSpacing: 0,
		fitMode: "none",
		taperStart: s.taperStart,
		taperEnd: s.taperEnd,
	};
}

/** Pick the ribbon UV layout options matching the brush method. */
function ribbonOptionsFor(
	brush: PatternBrushSettings | ArtBrushSettings,
): RibbonOptions {
	if (brush.type === "art") {
		return {
			uvMode: "stretch",
			flipU: brush.flip ?? false,
			flipV: brush.flipAcross ?? false,
			tileSpacing: 0,
		};
	}
	return {
		uvMode: "repeat",
		flipU: false,
		flipV: false,
		tileSpacing: Math.max(brush.tileSpacing, 0),
	};
}
