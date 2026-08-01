import {
	resolveBrushTextureUid,
	resolveOptionalSourceUid,
	resolveScatterSourceUids,
} from "../../brush/brushSource";
import { normalizeBrushSettings } from "../../brush/normalize";
import type { SoftProofLutResult } from "../../color/types";
import { createIdentityTransform } from "../../document/factory";
import {
	type AnyArtObject,
	type Artboard,
	type BoundingBox,
	type BrushArtSource,
	type CubicBezierSegment,
	DEFAULT_WET_INK_PICKUP_STRENGTH,
	type DefEntry,
	type Document,
	type ElementTransform,
	type FillAppearance,
	type Filter,
	type Group,
	getArtboardBounds,
	getContainerChildIds,
	getTransform,
	hasGroupAppearances,
	hasWetInk,
	isBlend,
	isCompoundPath,
	isGeometricBrush,
	isGroup,
	isIdentityTransform,
	isMesh,
	isPath,
	isRepeat,
	type Path,
	type RawRGBA,
	type RepeatObject,
	type StrokeAppearance,
	type TextElement,
	TRANSIENT_LAYER_KIND,
	type Viewport,
	type WetInkSettings,
} from "../../schema";
import type { TextRenderer } from "../../typography/TextRenderer";
import {
	boundsIntersect,
	brandWorldBBox,
	calculateElementBounds,
	calculatePathBounds,
	calculateRepeatSourceUnion,
	expandBounds,
	type LocalBBox,
	type LocalBoundsCache,
	type WorldBBox,
} from "../../utils/geometry/bounds";
import {
	applyTransformToBounds,
	boundsFullyInsideViewport,
	composeTransforms,
	getVisibleWorldBounds,
} from "../../utils/geometry/geometry";
import type { MeshWarpClipGroup } from "../../utils/geometry/meshWarp";
import {
	type Affine2D,
	applyAffineToPoint,
	composeAffine,
	computeRepeatInstances,
	elementTransformToAffine,
	repeatGridRegion,
} from "../../utils/geometry/repeatInterpolation";
import { hashSegmentsWithMetadata } from "../../utils/geometry/segmentOps";
import {
	compileShaderModule,
	type StructuredView,
} from "../../utils/wgpu-utils";
import { computePaintHash } from "../filters/ExtrudeRenderCache";
import type { GPUTimingProfiler } from "../GPUTimingProfiler";
import type { GradientTextureGenerator } from "../generators/GradientTextureGenerator";
import type { MeshGradientTextureGenerator } from "../generators/MeshGradientTextureGenerator";
import { createFullscreenPipeline } from "../PipelineFactory";
import { RenderStrategy } from "../RenderOrchestrator";
import { DOT_GRID_SHADER } from "../shaders/dotGrid.wgsl";
import {
	type FrameRequest,
	HDR_EDR_HEADROOM,
	HDR_MAX_NITS,
	type TransientElementEntry,
} from "../types";
import {
	aabbOfQuad,
	calculatePrebufDimensions,
	computeDotGridPhase,
	expandRenderFilter,
	splitGroupAppearances,
} from "./CanvasLayer.helpers";
import {
	type AssetState,
	type BlitLayer,
	type BlitQuad,
	type BlitUVRect,
	type CompositeRenderContext,
	type CompositeState,
	type FilteredTextureInfo,
	FULL_BLIT_UV_RECT,
	type GradientState,
	MSAA_SAMPLE_COUNT,
	type PipelineType,
	type RenderState,
	type StencilState,
	type TextState,
	type ViewportState,
} from "./CanvasLayerTypes";
import { MaskedBlitBindGroupCache } from "./caches/BindGroupCache";
import type { RenderCacheManager } from "./caches/RenderCacheManager";
import {
	collectDrawableAppearances,
	type ResolvedAppearancePass,
	resolveAppearancePasses,
} from "./elements/appearancePasses";
import { ElementRenderer } from "./elements/ElementRenderer";
import { ElementVertexBuffer } from "./elements/ElementVertexBuffer";
import type { Reference3DRenderContext } from "./elements/Reference3DElementRenderer";
import type { BackdropCaptureManager } from "./pipeline/BackdropCaptureManager";
import {
	BackdropEffectCoordinator,
	type BackdropEffectRequest,
} from "./pipeline/BackdropEffectCoordinator";
import {
	type ClipGroupEntry,
	ClipMaskAtlas,
	clipMaskKey,
	type MaskEntry,
	type MaskRenderRequest,
	objectMaskKey,
} from "./pipeline/ClipMaskAtlas";
import {
	CompositeRenderer,
	createBlendBackdrop,
	createCompositeSourceSurface,
} from "./pipeline/CompositeRenderer";
import { DocumentCache, destroyStencilState } from "./pipeline/DocumentCache";
import { DefRasterizer } from "./pipeline/defs/DefRasterizer";
import {
	type BackdropEffectCanvasResources,
	type BackdropEffectDriver,
	type FilterGeometryContext,
	type FilterRenderer,
	hoistBlendInstanceAppearances,
	isElementRenderReplaced,
	isGeometryFilter,
	resolveRenderConfigure,
} from "./pipeline/FilterRenderer";
import {
	type FGExecuteContext,
	type FGTextureHandle,
	FrameGraph,
} from "./pipeline/FrameGraph";
import { GeometryStore } from "./pipeline/GeometryStore";
import {
	type GroupCompositionPlan,
	groupPlanRequiresSurface,
	type MaskApplicationPlan,
	type PlannedMask,
	planGroupComposition,
	planMaskApplication,
} from "./pipeline/MaskApplicationPlan";
import { OffscreenPresenter } from "./pipeline/OffscreenPresenter";
import { createPassLocalStencilAttachment } from "./pipeline/PassLocalStencil";
import {
	type BackdropElementEntry,
	buildFilterPlansForElements,
	buildFramePlanStructure,
	buildFramePlanView,
	buildPassPlan,
	type ElementFilterPlan,
	type FramePlan,
	type FramePlanStructure,
} from "./pipeline/RenderPlanner";
import {
	createBorrowedTextureRef,
	createFrameTextureRef,
	createPlacementOpacity,
	createRenderSurface,
	type RenderSurface,
	releaseRenderSurface,
	replaceRenderSurface,
} from "./pipeline/RenderSurface";
import { RunBatcher } from "./pipeline/RunBatcher";
import { SoftProofPass } from "./pipeline/SoftProofPass";
import { resolveStrokeStyle } from "./pipeline/stroke/resolveStrokeStyle";
import type { StrokeEngineRegistry } from "./pipeline/stroke/StrokeEnginePicker";
import {
	buildWetInkSimCacheKey,
	type WetInkCachedResultComposite,
	WetInkPass,
} from "./pipeline/stroke/WetInkPass";
import { TexturePool, texturePoolBudgetBytes } from "./pipeline/TexturePool";
import { UniformScope } from "./pipeline/UniformScope";
import { ViewportManager } from "./pipeline/ViewportManager";

interface PendingWetInkJob {
	compositeContext: CompositeRenderContext;
	path: Path;
	wetPasses: ResolvedAppearancePass[];
	effectiveAlpha: number;
	transformIndex: number;
	renderBufferCacheKey: string;
}

/**
 * Frame-local values the isolation-dim pass body reads, threaded from
 * renderDocument so the body can live as a named method instead of a 175-line
 * closure. Everything else it touches is CanvasLayer state reached via `this`.
 */
interface IsolationDimContext {
	encoder: GPUCommandEncoder;
	elementsMap: Map<string, AnyArtObject>;
	transientElements: ReadonlyMap<string, TransientElementEntry> | undefined;
	filteredTextures: Map<string, FilteredTextureInfo>;
	localBoundsCache: LocalBoundsCache | undefined;
	prebufTexture: GPUTexture;
	mainCompositeContext: CompositeRenderContext;
	startNewPass: (clear: boolean) => GPURenderPassEncoder;
}

/** One encoded canvas frame. The owner that calls queue.submit must settle it
 * exactly once so tile residency follows submission, not command encoding. */
export interface CanvasFrameTransaction {
	commit(): void;
	abort(): void;
}

/**
 * A pre-rendered mask paired with the document-level intent behind it.
 *
 * `inverted` lives here rather than on {@link MaskEntry} because the atlas
 * caches textures and knows nothing about which way round a mask is meant to
 * read — two elements could share one texture and disagree on that.
 */
type AssignedMask = MaskEntry & { inverted?: boolean };

type RendererFramePlan = FramePlan & {
	maskApplicationPlans: Map<string, MaskApplicationPlan>;
	groupCompositionPlans: Map<string, GroupCompositionPlan>;
};

/**
 * Canvas Layer - Renders document elements (paths, shapes, etc.)
 * Note: CanvasLayer doesn't implement RenderLayer because it requires
 * additional parameters (document, elementOverrides, etc.) for rendering.
 */
export class CanvasLayer {
	// -- GPU core --
	private device: GPUDevice;
	private canvasFormat: GPUTextureFormat;
	private sampler: GPUSampler;
	private nearestSampler: GPUSampler;

	// Last full-quality composited frame, kept so a viewport-only change
	// (pan/zoom during an interaction gesture) can blit + reproject it instead
	// of re-rendering the whole document. `worldBounds` is the world-space AABB
	// the cached prebuf covered; blitting those bounds through the current
	// viewport reproduces the correct pan/zoom/rotation via the blit shader.
	private compositeFrameCache: {
		texture: GPUTexture | null;
		worldBounds: BoundingBox | null;
		width: number;
		height: number;
		valid: boolean;
		// Final-blit background reproduced on a blit frame (the cached prebuf is
		// transparent; the clear + dot grid are applied in the final blit).
		clearColor: RawRGBA;
		dotGrid: boolean;
	} = {
		texture: null,
		worldBounds: null,
		width: 0,
		height: 0,
		valid: false,
		clearColor: { r: 1, g: 1, b: 1, a: 1 },
		dotGrid: false,
	};
	// Whether the current frame's full render should refresh compositeFrameCache
	// (set per-frame in render(); false for export/preview/subset frames).
	private captureCompositeFrameThisFrame = false;

	// -- Render pipelines --
	private strokePipeline: GPURenderPipeline;
	private fillPipeline: GPURenderPipeline;
	private stencilFanWritePipeline: GPURenderPipeline;
	private stencilCoverPipeline: GPURenderPipeline;
	private strokeUnionPipeline: GPURenderPipeline;
	private stencilZeroPipeline: GPURenderPipeline;
	private blitPipeline: GPURenderPipeline;
	private blitPipelineRgba8: GPURenderPipeline;
	private blitPipelineRgba32Float: GPURenderPipeline;
	private blitWithMaskPipeline: GPURenderPipeline;
	private blitWithEraseMaskPipeline: GPURenderPipeline;
	private blitBackdropWithMaskPipeline: GPURenderPipeline;
	private blitBackdropPunchPipeline: GPURenderPipeline;
	private blitGlassPunchPipeline: GPURenderPipeline;
	private compositePipeline: GPURenderPipeline;
	private exposureBlitPipeline: GPURenderPipeline;
	private quadBlitPipeline: GPURenderPipeline;
	private meshBlitPipeline: GPURenderPipeline;

	// -- Bind group layouts --
	private blitBindGroupLayout: GPUBindGroupLayout;
	private compositeBindGroupLayout: GPUBindGroupLayout;
	private blitWithMaskBindGroupLayout: GPUBindGroupLayout;
	private exposureBlitBindGroupLayout: GPUBindGroupLayout;
	private exposureUniformBuffer: GPUBuffer;
	private exposureBindGroup: GPUBindGroup | null = null;
	private exposureBindGroupSourceView: GPUTextureView | null = null;
	private transformsBindGroupLayout: GPUBindGroupLayout;
	private dummyGradientBindGroup: GPUBindGroup;
	private dummyMaskBindGroup: GPUBindGroup;
	private maskBindGroupLayout: GPUBindGroupLayout;
	private maskBindGroupRef: { current: GPUBindGroup } | null = null;
	/** Intermediate texture shared by the exposure and soft proof passes. */
	private postProcessIntermediate: GPUTexture | null = null;
	private softProofPass: SoftProofPass;
	/**
	 * Wet-ink bleed composite + diffusion compute. Lazily constructed on the
	 * first wet stroke; stays null for documents that never enable wet ink so
	 * non-wet rendering pays nothing.
	 */
	private wetInkPass: WetInkPass | null = null;

	// -- Viewport & uniform binding --
	private viewportManager!: ViewportManager;
	private uniformScope: UniformScope;
	private bindGroup: GPUBindGroup;

	/**
	 * Active viewport bind group + uniform buffer for the stroke engine
	 * registry's stamp / ribbon shaders. Always update via
	 * pushViewportBinding / popViewportBinding / setViewportBinding.
	 */
	private readonly viewportBinding = {
		active: null! as GPUBindGroup,
		buffer: null as GPUBuffer | null,
		bgStack: [] as GPUBindGroup[],
		bufStack: [] as (GPUBuffer | null)[],
	};

	private get viewportState(): ViewportState {
		return this.viewportManager.viewportState;
	}
	private get transformsBindGroup(): GPUBindGroup | null {
		return this.viewportManager.transformsBindGroup;
	}

	private pushViewportBinding(
		bg: GPUBindGroup,
		buffer?: GPUBuffer | null,
	): void {
		this.viewportBinding.bgStack.push(this.viewportBinding.active);
		this.viewportBinding.bufStack.push(this.viewportBinding.buffer);
		this.viewportBinding.active = bg;
		this.viewportBinding.buffer = buffer ?? null;
		this.strokeRegistry?.setActiveUniformBuffer(this.viewportBinding.buffer);
	}

	private popViewportBinding(): void {
		this.viewportBinding.active =
			this.viewportBinding.bgStack.pop() ?? this.bindGroup;
		this.viewportBinding.buffer = this.viewportBinding.bufStack.pop() ?? null;
		this.strokeRegistry?.setActiveUniformBuffer(this.viewportBinding.buffer);
	}

	private setViewportBinding(
		bg: GPUBindGroup,
		buffer?: GPUBuffer | null,
	): void {
		this.viewportBinding.active = bg;
		this.viewportBinding.buffer = buffer ?? null;
		this.strokeRegistry?.setActiveUniformBuffer(this.viewportBinding.buffer);
	}

	// -- Sub-renderers --
	public readonly elements!: ElementRenderer;
	private composite!: CompositeRenderer;
	public readonly offscreen!: OffscreenPresenter;
	private filterRenderer: FilterRenderer;
	private backdropCaptureManager: BackdropCaptureManager;
	private strokeRegistry: StrokeEngineRegistry | null = null;
	/** Request another frame (async resource loads, and tile convergence: a
	 *  settle frame that still shows coarser/approximate tiles asks for a follow
	 *  up so the residual misses bake to vector quality over frames). Wired via
	 *  setOnRequestRender. */
	private onRequestRender: (() => void) | null = null;
	/** Reference3D subsystem access, injected post-construction by the orchestrator. */
	private reference3dContextProvider:
		| (() => Reference3DRenderContext | null)
		| null = null;
	private clipMaskAtlas!: ClipMaskAtlas;
	/** Dedicated clip-mask atlas used only for export/offscreen renders, so an
	 *  export never mutates or destroys the interactive atlas's textures (the
	 *  shared-atlas use-after-destroy seen on document switch). Lazily built. */
	private exportClipMaskAtlas: ClipMaskAtlas | null = null;
	/**
	 * Rasterizes off-canvas def trees (patterns / vector brush sources) into
	 * persistent GPUTextures. Wired in via preRenderPatternDefs() /
	 * preRenderBrushDefs() / renderDefToTexture(); only kicks in once a
	 * document actually defines a `def:` brush source / pattern fill.
	 */
	private defRasterizer!: DefRasterizer;

	// -- Dot-grid background (lazy; built on the first dotless empty-canvas render) --
	private static readonly DOT_GRID_SPACING_PX = 24;
	private static readonly DOT_GRID_RADIUS_PX = 1.1;
	private static readonly DOT_GRID_COLOR = { r: 0.8, g: 0.8, b: 0.82, a: 1.0 };
	private dotGridPipeline: GPURenderPipeline | null = null;
	private dotGridUniformBuffer: GPUBuffer | null = null;
	private dotGridUniformView: StructuredView | null = null;
	private dotGridBindGroup: GPUBindGroup | null = null;

	// -- Caches --
	private cache: DocumentCache;
	private texturePool!: TexturePool;
	/** Persistent shared vertex buffer for retained element geometry. One per
	 *  canvas target, shared across document cache scopes (entries own their
	 *  leased ranges and release them when their cache scope drops). */
	private geometryStore!: GeometryStore;
	/** Merges consecutive same-state solid draws into one drawIndexed. Every
	 *  pass.end() and every non-batched draw path must flush() it first. */
	private runBatcher!: RunBatcher;
	/** Stable id used to register this canvas with backdrop-composite filter
	 *  handlers (e.g. glass extrude), keyed per canvas target. */
	private readonly canvasId: string;
	/** Per-canvas backdrop-composite drivers collected from filter handlers
	 *  (currently glass extrude). CanvasLayer drives them generically without
	 *  knowing the concrete filter behind each. */
	private backdropDrivers: BackdropEffectDriver[] = [];
	/** Shared backdrop capture/pyramid service the drivers request their
	 *  backdrop samples through; fed main-pass draw bounds for epoch tracking. */
	private backdropEffectCoordinator!: BackdropEffectCoordinator;
	private cacheManager: RenderCacheManager;

	// -- Domain state --
	private gradient!: GradientState;
	private textState: TextState = {
		renderer: null,
		pathCache: new Map(),
		pendingPathCacheKeys: new Set(),
		stalePathCache: new Map(),
	};
	private assetState: AssetState = {
		textureCache: new Map(),
		imageTextureCache: new Map(),
		pendingImageLoads: new Map(),
		currentFiles: [],
		pendingBrushTextureLoads: new Set(),
	};
	private compositeState: CompositeState = {
		captureTexture: null,
		layerTexture: null,
		prebufTexture: null,
		canvasBaseTexture: null,
		finalBlitStencil: { texture: null, width: 0, height: 0 },
		backdropMask: { texture: null, width: 0, height: 0 },
		backdropMaskStencil: { texture: null, width: 0, height: 0 },
		width: 0,
		height: 0,
	};
	private renderState: RenderState = {
		editingScopeStack: [],
		isolatedElementId: null,
		isExport: false,
		boundsCache: null,
		staleWorldBoundsIds: null,
		textAxisPathIds: null,
		paintedAxisPathIds: null,
		localBoundsCache: null,
		currentTransformIndex: 0,
		currentMaskBindGroup: null!,
	};

	/** BG3 adapter for planner-approved inline-leaf masks and mesh transients. */
	private inlineMaskEntries = new Map<string, AssignedMask>();

	/** Planner output owned by the active frame plan. This field is only an
	 *  alias so recursive render paths do not need to thread the frame plan. */
	private activeMaskApplicationPlans: ReadonlyMap<string, MaskApplicationPlan> =
		new Map();
	private activeGroupCompositionPlans: ReadonlyMap<
		string,
		GroupCompositionPlan
	> = new Map();
	/** Frame-local GPU resources addressed by PlannedMask.key. */
	private maskEntriesByKey = new Map<string, AssignedMask>();

	/** Bounds inputs captured while assigning masks, reused by
	 *  {@link applyPostMasks} to size the bake of an unfiltered element. */
	private maskBoundsContext: WorldBoundsContext | null = null;

	// -- Document cache & textures --
	private stencil: StencilState = { texture: null, width: 0, height: 0 };

	// -- Frame-transient --
	/** The command encoder for the current frame, set during render(). */
	private activeEncoder: GPUCommandEncoder | null = null;
	/**
	 * Active document for the current frame. Set by render() and used by
	 * renderDefToTexture / preRenderPatternDefs so def rasterization can resolve
	 * elementIds without callers having to thread the document through.
	 */
	private activeDocument: Document | null = null;
	/**
	 * Frame-scoped merged elementsMap for def rasterization. May include tool
	 * overrides / transient elements so pattern previews mirror the live canvas.
	 */
	private activeElementsMap: Map<string, AnyArtObject> | null = null;
	private activeGetDefRevision: ((defId: string) => number) | null = null;
	private activeProfiler: GPUTimingProfiler | null = null;

	/**
	 * Transient set rendered in the previous frame. Compared by reference to
	 * detect changes that require a transforms-buffer rebuild.
	 */
	private lastTransientElements: ReadonlyMap<
		string,
		TransientElementEntry
	> | null = null;
	/**
	 * Element ids overridden in the previous frame. The overrides map is
	 * mutated in place (no identity change per update), so bounds eviction
	 * runs every frame while any override is active — see render().
	 */
	private lastOverrideIds: ReadonlySet<string> | null = null;
	/**
	 * Merged elements map + viewport-independent frame-plan structure, reused
	 * across frames while the document is unchanged (pan/zoom never rebuilds
	 * them). Keys are compared by reference — valtio snapshots keep identity
	 * for unchanged subtrees. Never written while element overrides are
	 * active: the overrides map is mutated in place, so identity cannot prove
	 * it unchanged. Cleared when text layout reshapes local bounds without a
	 * document mutation (see setOnRequestRender).
	 */
	private framePlanStructureCache: {
		objects: Document["objects"];
		layers: Document["layers"];
		artboards: Document["artboards"];
		transients: ReadonlyMap<string, TransientElementEntry> | undefined;
		mergedElementsMap: Map<string, AnyArtObject>;
		structure: FramePlanStructure;
	} | null = null;
	private readonly backdropBlitPool = {
		f32: new Float32Array(16),
		buffers: [] as GPUBuffer[],
		index: 0,
	};
	private backdropBlitBGCache = new MaskedBlitBindGroupCache();

	public constructor(
		device: GPUDevice,
		canvasFormat: GPUTextureFormat,
		pipelines: {
			strokePipeline: GPURenderPipeline;
			fillPipeline: GPURenderPipeline;
			stencilFanWritePipeline: GPURenderPipeline;
			stencilCoverPipeline: GPURenderPipeline;
			strokeUnionPipeline: GPURenderPipeline;
			stencilZeroPipeline: GPURenderPipeline;
			pulledGeometryPipeline: GPURenderPipeline;
			pulledStencilFanWritePipeline: GPURenderPipeline;
			gradientFillPipeline: GPURenderPipeline;
			blitPipeline: GPURenderPipeline;
			blitPipelineRgba8: GPURenderPipeline;
			blitPipelineRgba32Float: GPURenderPipeline;
			compositePipeline: GPURenderPipeline;
			blitWithMaskPipeline: GPURenderPipeline;
			blitWithEraseMaskPipeline: GPURenderPipeline;
			blitBackdropWithMaskPipeline: GPURenderPipeline;
			blitBackdropPunchPipeline: GPURenderPipeline;
			blitGlassPunchPipeline: GPURenderPipeline;
			exposureBlitPipeline: GPURenderPipeline;
			quadBlitPipeline: GPURenderPipeline;
			meshBlitPipeline: GPURenderPipeline;
		},
		resources: {
			uniformBuffer: GPUBuffer;
			viewportUniformView: StructuredView;
			bindGroup: GPUBindGroup;
			viewportBindGroupLayout: GPUBindGroupLayout;
			blitBindGroupLayout: GPUBindGroupLayout;
			compositeBindGroupLayout: GPUBindGroupLayout;
			exposureBlitBindGroupLayout: GPUBindGroupLayout;
			gradientBindGroupLayout: GPUBindGroupLayout;
			transformsBindGroupLayout: GPUBindGroupLayout;
			gradientUniformView: StructuredView;
			gradientStopsView: StructuredView;
			sampler: GPUSampler;
			nearestSampler: GPUSampler;
			filterRenderer: FilterRenderer;
			backdropCaptureManager: BackdropCaptureManager;
			textRenderer?: TextRenderer;
			gradientTextureGenerator: GradientTextureGenerator;
			meshGradientTextureGenerator: MeshGradientTextureGenerator;
			dummyGradientBindGroup: GPUBindGroup;
			dummyMaskBindGroup: GPUBindGroup;
			maskBindGroupLayout: GPUBindGroupLayout;
			pulledBindGroupLayout: GPUBindGroupLayout;
			blitWithMaskBindGroupLayout: GPUBindGroupLayout;
			cacheManager: RenderCacheManager;
			maskBindGroupRef?: { current: GPUBindGroup };
		},
		canvasId: string,
	) {
		this.device = device;
		this.canvasFormat = canvasFormat;
		this.canvasId = canvasId;
		this.softProofPass = new SoftProofPass(device, canvasFormat);

		this.strokePipeline = pipelines.strokePipeline;
		this.fillPipeline = pipelines.fillPipeline;
		this.stencilFanWritePipeline = pipelines.stencilFanWritePipeline;
		this.stencilCoverPipeline = pipelines.stencilCoverPipeline;
		this.strokeUnionPipeline = pipelines.strokeUnionPipeline;
		this.stencilZeroPipeline = pipelines.stencilZeroPipeline;
		this.blitPipeline = pipelines.blitPipeline;
		this.blitPipelineRgba8 = pipelines.blitPipelineRgba8;
		this.blitPipelineRgba32Float = pipelines.blitPipelineRgba32Float;
		this.compositePipeline = pipelines.compositePipeline;
		this.blitWithMaskPipeline = pipelines.blitWithMaskPipeline;
		this.blitWithEraseMaskPipeline = pipelines.blitWithEraseMaskPipeline;
		this.blitBackdropWithMaskPipeline = pipelines.blitBackdropWithMaskPipeline;
		this.blitBackdropPunchPipeline = pipelines.blitBackdropPunchPipeline;
		this.blitGlassPunchPipeline = pipelines.blitGlassPunchPipeline;
		this.exposureBlitPipeline = pipelines.exposureBlitPipeline;
		this.quadBlitPipeline = pipelines.quadBlitPipeline;
		this.meshBlitPipeline = pipelines.meshBlitPipeline;

		this.bindGroup = resources.bindGroup;
		this.viewportBinding.active = resources.bindGroup;
		this.uniformScope = new UniformScope(
			device,
			resources.viewportBindGroupLayout,
			resources.viewportUniformView,
		);

		this.blitBindGroupLayout = resources.blitBindGroupLayout;
		this.compositeBindGroupLayout = resources.compositeBindGroupLayout;
		this.exposureBlitBindGroupLayout = resources.exposureBlitBindGroupLayout;
		this.exposureUniformBuffer = device.createBuffer({
			label: "Exposure Uniform Buffer",
			size: 16, // Minimum uniform buffer alignment
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});

		this.sampler = resources.sampler;
		this.nearestSampler = resources.nearestSampler;
		this.filterRenderer = resources.filterRenderer;

		this.backdropCaptureManager = resources.backdropCaptureManager;

		// strokeRegistry is installed post-construction via setStrokeRegistry()
		this.textState.renderer = resources.textRenderer ?? null;

		this.transformsBindGroupLayout = resources.transformsBindGroupLayout;
		this.dummyGradientBindGroup = resources.dummyGradientBindGroup;
		this.dummyMaskBindGroup = resources.dummyMaskBindGroup;
		this.renderState.currentMaskBindGroup = this.dummyMaskBindGroup;
		this.maskBindGroupLayout = resources.maskBindGroupLayout;
		this.maskBindGroupRef = resources.maskBindGroupRef ?? null;
		this.cacheManager = resources.cacheManager;
		this.blitWithMaskBindGroupLayout = resources.blitWithMaskBindGroupLayout;
		this.viewportManager = new ViewportManager(
			device,
			resources.uniformBuffer,
			resources.viewportUniformView,
			resources.transformsBindGroupLayout,
		);

		this.gradient = {
			pipeline: pipelines.gradientFillPipeline,
			bindGroupLayout: resources.gradientBindGroupLayout,
			textureGenerator: resources.gradientTextureGenerator,
			meshTextureGenerator: resources.meshGradientTextureGenerator,
			uniformView: resources.gradientUniformView,
			stopsView: resources.gradientStopsView,
			sampler: null,
			bufferPool: [],
			drawIndex: 0,
			// Create a 1x1 placeholder texture for non-free gradient bind groups
			placeholderTexture: device.createTexture({
				label: "Gradient Placeholder Texture",
				size: { width: 1, height: 1 },
				format: "rgba8unorm",
				usage: GPUTextureUsage.TEXTURE_BINDING,
			}),
			placeholderStorageBuffer: device.createBuffer({
				label: "Gradient Placeholder Storage",
				size: 256,
				usage: GPUBufferUsage.STORAGE,
			}),
		};

		this.cache = new DocumentCache({
			device: this.device,
			canvasFormat: this.canvasFormat,
			stencil: this.stencil,
			compositeState: this.compositeState,
			viewportState: this.viewportState,
			deferDestroy: (tex) => this.offscreen.deferDestroy(tex),
		});

		this.geometryStore = new GeometryStore(this.device);
		this.runBatcher = new RunBatcher(
			this.device,
			resources.pulledBindGroupLayout,
		);

		// Cache fields below are accessor properties, not construction-time
		// snapshots: the cache manager swaps its active document scope between
		// frames, so capturing an instance here would pin a stale scope.
		const cacheManager = this.cacheManager;
		this.elements = new ElementRenderer({
			device: this.device,
			canvasFormat: this.canvasFormat,
			getBindGroup: () => this.viewportBinding.active,
			sampler: this.sampler,
			strokePipeline: this.strokePipeline,
			fillPipeline: this.fillPipeline,
			stencilFanWritePipeline: this.stencilFanWritePipeline,
			stencilCoverPipeline: this.stencilCoverPipeline,
			strokeUnionPipeline: this.strokeUnionPipeline,
			stencilZeroPipeline: this.stencilZeroPipeline,
			pulledGeometryPipeline: pipelines.pulledGeometryPipeline,
			pulledStencilFanWritePipeline: pipelines.pulledStencilFanWritePipeline,
			blitBindGroupLayout: this.blitBindGroupLayout,
			filterRenderer: this.filterRenderer,
			viewportState: this.viewportState,
			renderState: this.renderState,
			assetState: this.assetState,
			textState: this.textState,
			gradient: this.gradient,
			dummyGradientBindGroup: this.dummyGradientBindGroup,
			dummyMaskBindGroup: this.dummyMaskBindGroup,
			geometryStore: this.geometryStore,
			runBatcher: this.runBatcher,
			get geometryCache() {
				return cacheManager.geometry;
			},
			get strokeCache() {
				return cacheManager.stroke;
			},
			get stencilFillCache() {
				return cacheManager.stencilFill;
			},
			get gradientCache() {
				return cacheManager.gradient;
			},
			getMaskBindGroup: () => this.renderState.currentMaskBindGroup,
			getTransientMaskBindGroup: (transientId: string) =>
				this.inlineMaskEntries.get(transientId)?.bindGroup ?? null,
			getComposedTransform: (elementId: string) =>
				this.viewportManager.getComposedTransformCache().get(elementId) ??
				createIdentityTransform(),
			getLocalBounds: (elementId: string) =>
				this.viewportManager.getBoundsCache().get(elementId) ?? null,
			getTransformsBindGroup: () => this.transformsBindGroup,
			getStrokeRegistry: () => this.strokeRegistry,
			getCompoundPathGeometryCache: () => this.cacheManager.compoundPath,
			getBlendCache: () => this.cacheManager.blend,
			getMeshWarpCache: () => this.cacheManager.meshWarp,
			getTransformIndex: (elementId: string) =>
				this.viewportManager.getTransformIndex(elementId),
			blitTextureToCanvas: (...args) =>
				this.composite.blitTextureToCanvas(...args),
			blitQuadToCanvas: (...args) => this.composite.blitQuadToCanvas(...args),
			blitMeshToCanvas: (...args) => this.composite.blitMeshToCanvas(...args),
			getParentGroupMap: () => this.viewportManager.getParentGroupMap(),
			resolvePatternTexture: (defId: string) =>
				this.resolvePatternTexture(defId),
			getReference3DContext: () => this.reference3dContextProvider?.() ?? null,
			getRasterScale: () => this.getRasterScale(),
		});

		this.composite = new CompositeRenderer({
			device: this.device,
			canvasFormat: this.canvasFormat,
			getBindGroup: () => this.viewportBinding.active,
			sampler: this.sampler,
			blitPipeline: this.blitPipeline,
			blitGlassPunchPipeline: this.blitGlassPunchPipeline,
			compositePipeline: this.compositePipeline,
			quadBlitPipeline: this.quadBlitPipeline,
			meshBlitPipeline: this.meshBlitPipeline,
			blitBindGroupLayout: this.blitBindGroupLayout,
			compositeBindGroupLayout: this.compositeBindGroupLayout,
			blitWithMaskBindGroupLayout: this.blitWithMaskBindGroupLayout,
			dummyGradientBindGroup: this.dummyGradientBindGroup,
			dummyMaskBindGroup: this.dummyMaskBindGroup,
			viewportState: this.viewportState,
			getTransformsBindGroup: () => this.transformsBindGroup,
			getCache: () => this.cache,
			writeViewportUniformsToGPU: (vp, w, h) =>
				this.writeViewportUniformsToGPU(vp, w, h),
			renderPath: (pass, path, alpha, pt) =>
				this.elements.renderPath(pass, path, alpha, pt),
			getBlendModeIndex: (bm) => this.elements.getBlendModeIndex(bm),
			getCompositionModeIndex: (cm) =>
				this.elements.getCompositionModeIndex(cm),
			deferDestroy: (tex) => this.offscreen.deferDestroy(tex),
			onBeforeDraw: () => this.runBatcher.flush(),
		});

		this.texturePool = new TexturePool(this.device);
		this.backdropCaptureManager.setTexturePool(this.texturePool);
		this.backdropEffectCoordinator = new BackdropEffectCoordinator(
			this.device,
			this.texturePool,
			this.backdropCaptureManager,
		);

		// Register this canvas with any backdrop-composite filter handlers (glass
		// extrude) so they own its per-canvas driver, then collect the drivers to
		// invoke generically — CanvasLayer keeps only the pass-lifecycle seam.
		// Cache fields are accessors (see the ElementRenderer deps note above).
		const backdropResources: BackdropEffectCanvasResources = {
			texturePool: this.texturePool,
			get appearanceCache() {
				return cacheManager.appearance;
			},
			getParentGroupMap: () => this.viewportManager.getParentGroupMap(),
			get compoundPathCache() {
				return cacheManager.compoundPath;
			},
			renderElementToTexture: (encoder, el, bounds, elementsMap, rasterScale) =>
				this.offscreen.renderElementToTexture(
					encoder,
					el,
					bounds,
					elementsMap,
					rasterScale,
					true,
				),
			resolvePatternTexture: (defId: string) =>
				this.resolvePatternTexture(defId),
			resolveTextOutline: (el) => this.resolveTextOutline(el),
			requestTextOutline: (el) => this.requestTextOutline(el),
			isImageReady: (fileUid) => this.assetState.imageTextureCache.has(fileUid),
			deferDestroy: (tex) => this.offscreen.deferDestroy(tex),
			canvasFormat: this.canvasFormat,
			backdropEffectCoordinator: this.backdropEffectCoordinator,
		};
		for (const handler of this.filterRenderer.getHandlers().values()) {
			handler.attachCanvas?.(this.canvasId, backdropResources);
		}
		this.backdropDrivers = [...this.filterRenderer.getHandlers().values()]
			.map((h) => h.getBackdropEffectDriver?.(this.canvasId) ?? null)
			.filter((d): d is BackdropEffectDriver => d !== null);

		this.offscreen = new OffscreenPresenter({
			device: this.device,
			canvasFormat: this.canvasFormat,
			sampler: this.sampler,
			getBindGroup: () => this.viewportBinding.active,
			blitBindGroupLayout: this.blitBindGroupLayout,
			getTransformsBindGroup: () => this.transformsBindGroup,
			strokePipeline: this.strokePipeline,
			dummyGradientBindGroup: this.dummyGradientBindGroup,
			dummyMaskBindGroup: this.dummyMaskBindGroup,
			blitWithMaskPipeline: this.blitWithMaskPipeline,
			blitWithEraseMaskPipeline: this.blitWithEraseMaskPipeline,
			blitWithMaskBindGroupLayout: this.blitWithMaskBindGroupLayout,
			viewportState: this.viewportState,
			renderState: this.renderState,
			compositeState: this.compositeState,
			filterRenderer: this.filterRenderer,
			uniformScope: this.uniformScope,
			texturePool: this.texturePool,
			getTransformIndex: (elementId: string) =>
				this.viewportManager.getTransformIndex(elementId),
			setActiveBindGroup: (bg, uniformBuffer, replace) => {
				if (bg) {
					if (replace) {
						this.setViewportBinding(bg, uniformBuffer);
					} else {
						this.pushViewportBinding(bg, uniformBuffer);
					}
				} else {
					this.popViewportBinding();
				}
			},
			renderElements: (pass, elems, ft, em, alpha, pt, skip, pType, ctx, rbc) =>
				this.renderElements(
					pass,
					elems,
					ft,
					em,
					alpha,
					pt,
					skip,
					pType,
					ctx,
					rbc,
				),
			dispatchElementDirect: (...args) =>
				this.elements.dispatchElementDirect(...args),
			blitTextureToCanvas: (...args) =>
				this.composite.blitTextureToCanvas(...args),
			renderElementToMask: (...args) =>
				this.elements.renderElementToMask(...args),
			blitQuadToCanvas: (pass, texture, corners, opacity, uvRect) =>
				this.composite.blitQuadToCanvas(
					pass,
					texture,
					corners,
					opacity,
					uvRect,
				),
			getElementMaskBindGroup: (elementId) =>
				this.inlineMaskEntries.get(elementId)?.bindGroup ??
				this.dummyMaskBindGroup,
			getElementPostMasks: (elementId) => this.resolveSubtreeMasks(elementId),
			getRasterScale: () => this.getRasterScale(),
		});

		this.clipMaskAtlas = this.createClipMaskAtlas();

		this.defRasterizer = new DefRasterizer({
			// Lazily forwarded — the stroke registry is installed after
			// construction via setStrokeRegistry().
			onEvicted: (textureUid) =>
				this.strokeRegistry
					?.getBrushTextureManager()
					.removeDefTexture(textureUid),
		});
	}

	/**
	 * Install the stroke engine registry. Called by RenderOrchestrator after
	 * both CanvasLayer (for ElementRenderer.renderPath) and the registry's
	 * engines (which depend on ElementRenderer for the geometric wrapper)
	 * exist — breaks a circular construction dependency.
	 */
	public setStrokeRegistry(registry: StrokeEngineRegistry | null): void {
		this.strokeRegistry = registry;
		// Sync the legacy renderer's active uniform buffer with the current
		// viewport binding so push/pop state remains consistent.
		registry?.setActiveUniformBuffer(this.viewportBinding.buffer);
		// A batch flush encodes stamp/ribbon draws mid-loop — the geometry run
		// batcher must emit its pending merged draw first (paint order).
		registry?.setOnBeforeBatchDraw(() => this.runBatcher.flush());
	}

	public setOnRequestRender(callback: () => void): void {
		this.onRequestRender = callback;
		this.textState.onRequestRender = callback;
		this.assetState.onRequestRender = callback;
		this.textState.onLocalBoundsChanged = () => {
			// Text layout resolves asynchronously and reshapes local bounds
			// without any document mutation, so the cached frame-plan structure
			// (whose world bounds bake those local bounds in) must be rebuilt.
			this.framePlanStructureCache = null;
			this.viewportManager.markTransformsDirty(false);
			callback();
		};
	}

	/** Install the Reference3D subsystem accessor (null provider = reference3d skipped). */
	public setReference3DContextProvider(
		provider: () => Reference3DRenderContext | null,
	): void {
		this.reference3dContextProvider = provider;
	}

	public setOnTextBoundsComputed(
		callback: (
			elementId: string,
			bounds: WorldBBox,
			localBounds: LocalBBox,
		) => void,
	): void {
		this.textState.onTextBoundsComputed = callback;
	}

	public updateViewport(
		viewport: Viewport,
		width: number,
		height: number,
	): void {
		this.setViewportUniforms(viewport, width, height);

		// Ensure stencil texture matches canvas size
		this.cache.ensureStencilTexture(width, height);
	}

	/**
	 * Delegate to ViewportManager.
	 */
	private setViewportUniforms(
		viewport: Viewport,
		width: number,
		height: number,
	): void {
		this.viewportManager.setViewportUniforms(viewport, width, height);
	}

	private writeViewportUniformsToGPU(
		viewport: Viewport,
		width: number,
		height: number,
	): void {
		this.viewportManager.writeViewportUniformsToGPU(viewport, width, height);
	}

	private restoreViewportUniformsToGPU(): void {
		this.viewportManager.restoreViewportUniformsToGPU();
	}

	/**
	 * Blit a driver's baked solids at their own bounds/quad, then put back the
	 * geometry pipeline state the blit pipeline replaced — the same handoff the
	 * override-layer blit does, since the next element in the run draws through
	 * the geometry path and would otherwise inherit the blit's bindings.
	 */
	private blitBackdropFreeLayers(
		pass: GPURenderPassEncoder,
		layers: readonly BlitLayer[],
		alpha: number,
	): void {
		for (const layer of layers) {
			const layerAlpha = alpha * (layer.opacity ?? 1);
			if (layer.placement.kind === "world-quad") {
				this.composite.blitQuadToCanvas(
					pass,
					layer.texture.texture,
					layer.placement.quad,
					layerAlpha,
					layer.placement.uvRect,
				);
			} else {
				this.composite.blitTextureToCanvas(
					pass,
					layer.texture.texture,
					layer.placement.bounds,
					layerAlpha,
					layer.placement.uvRect,
					this.blitPipeline,
				);
			}
			pass.setPipeline(this.strokePipeline);
			pass.setBindGroup(0, this.viewportBinding.active);
			// biome-ignore lint/style/noNonNullAssertion: bound for the whole run.
			pass.setBindGroup(1, this.transformsBindGroup!);
			pass.setBindGroup(2, this.dummyGradientBindGroup);
			pass.setBindGroup(3, this.renderState.currentMaskBindGroup);
		}
	}

	/**
	 * Whether an element's pixels reach the canvas as a texture blit rather than
	 * through the geometry pipeline.
	 *
	 * This is the line that decides where a mask can be applied: the geometry
	 * pipeline samples the mask itself through BG3, while every blit runs its
	 * own pipeline and ignores it, so those elements need the mask multiplied
	 * into their texture afterwards. A new blit-drawn element type is a change
	 * to this predicate and nothing else.
	 */
	private drawsViaTexture(
		element: AnyArtObject,
		filterPlanIds: ReadonlySet<string>,
	): boolean {
		if (element.type === "image") return true;
		if (filterPlanIds.has(element.id)) return true;
		// Glass solids are deliberately kept out of the filter plans — they
		// compose against the live backdrop mid-pass instead — so the plan set
		// alone does not see them.
		return this.backdropDrivers.some((driver) =>
			driver.hasInlineComposite(element),
		);
	}

	private resolveSubtreeMasks(elementId: string): readonly AssignedMask[] {
		const plan = this.activeMaskApplicationPlans.get(elementId);
		if (plan?.kind !== "subtree-composite") return [];
		return plan.masks.flatMap((mask) => {
			const entry = this.maskEntriesByKey.get(mask.key);
			return entry ? [entry] : [];
		});
	}

	/**
	 * Collect clip groups, pre-render masks, build assignment, and
	 * re-upload transforms with mask info.
	 */
	private applyClipMasks(
		encoder: GPUCommandEncoder,
		elementsMap: Map<string, AnyArtObject>,
		framePlan: RendererFramePlan,
		filter?: ReadonlySet<string>,
	): void {
		const filterPlanIds = new Set(framePlan.filterPlans.keys());
		framePlan.groupCompositionPlans.clear();
		for (const element of elementsMap.values()) {
			if (!isGroup(element)) continue;
			framePlan.groupCompositionPlans.set(
				element.id,
				planGroupComposition({
					hasOwnMask:
						element.mask != null &&
						element.mask.enabled !== false &&
						element.mask.elementIds.length > 0,
					hasOwnClip: element.clipPathId != null,
					hasOpacity: (element.opacity ?? 1) !== 1,
					hasFilter: filterPlanIds.has(element.id),
					dependsOnBackdrop: this.backdropDrivers.some((driver) =>
						driver.hasInlineComposite(element),
					),
				}),
			);
		}
		// Fast path: skip collection when the document has neither clip groups
		// nor object masks.
		if (
			!this.viewportManager.hasClipGroups &&
			!this.viewportManager.hasObjectMasks
		) {
			framePlan.maskApplicationPlans.clear();
			this.maskEntriesByKey.clear();
			this.inlineMaskEntries.clear();
			return;
		}

		const boundsContext: WorldBoundsContext = {
			elementsMap,
			localBoundsCache: this.viewportManager.getBoundsCache(),
			parentGroupMap: this.viewportManager.getParentGroupMap(),
			composedTransformCache: this.viewportManager.getComposedTransformCache(),
		};
		let clipGroups = this.viewportManager.hasClipGroups
			? collectClipGroups(
					boundsContext,
					this.viewportState.bounds,
					(element, union) => {
						// A group filter (or baked solid) paints past the group's flat
						// bounds; count that so a spill into view is not culled.
						const plan = framePlan.filterPlans.get(element.id);
						if (plan) union(plan.textureBounds);
						for (const driver of this.backdropDrivers) {
							driver.unionSolidBounds(element, union);
						}
					},
				)
			: [];
		let objectMasks = this.viewportManager.hasObjectMasks
			? collectObjectMasks(
					boundsContext,
					this.viewportState.bounds,
					(element, union) => {
						// A filtered element paints into its expanded texture bounds,
						// and a baked solid paints its projection — both past the
						// element bounds the mask texture would otherwise be sized to.
						const plan = framePlan.filterPlans.get(element.id);
						if (plan) union(plan.textureBounds);
						for (const driver of this.backdropDrivers) {
							driver.unionSolidBounds(element, union);
						}
					},
				)
			: [];

		// Export/copy: keep only masks owned by an element inside the target
		// subtree, so a front object's clip/object mask never lands in the shared
		// atlas or the frame's mask application plans.
		if (filter) {
			clipGroups = clipGroups.filter((g) => filter.has(g.groupId));
			objectMasks = objectMasks.filter((m) => filter.has(m.ownerId));
		}

		// A clip group inside a mesh warp clips the warped members, so its mask
		// must come from the warped clip path — the document's own (unwarped)
		// entry above would cut the wrong shape.
		const meshClipGroups = this.collectMeshWarpClipGroups(elementsMap);

		// Warp transients are not document elements, so they own no transform slot
		// and would fall back to the shared identity slot 0 — a clip mask written
		// there would leak onto everything else. Reserve slots (inheriting the
		// container's transform, which is what they draw under) before the atlas
		// renders the mask, so the clip path lands in the members' space.
		this.viewportManager.reserveAuxiliaryMaskSlots(
			meshClipGroups.flatMap((group) =>
				[group.id, ...group.memberIds].map((id) => ({
					id,
					inheritFromId: group.meshId,
				})),
			),
		);

		const requests: MaskRenderRequest[] = [
			...clipGroups.map((entry) => ({
				key: clipMaskKey(entry.clipPathId),
				sources: [entry.clipPath],
				coverBounds: entry.groupBounds,
				mode: "silhouette" as const,
			})),
			...meshClipGroups.map((entry) => ({
				key: clipMaskKey(entry.id),
				sources: [entry.clipPath as AnyArtObject],
				coverBounds: entry.bounds,
				mode: "silhouette" as const,
			})),
			...objectMasks.map((entry) => ({
				key: objectMaskKey(entry.ownerId),
				sources: entry.sources,
				coverBounds: entry.ownerBounds,
				mode: "appearance" as const,
			})),
		];

		// Mask content is drawn outside the layer walk, so it has no filter plan
		// of its own. Build and run one first: an appearance that replaces the
		// element's render (a 3D solid) suppresses the flat look, so without its
		// filter the content would contribute nothing to the mask at all.
		const maskContentIds = collectMaskContentIds(objectMasks, elementsMap);
		const maskFilteredTextures = new Map<string, FilteredTextureInfo>();
		if (maskContentIds.size > 0) {
			const maskPlans = buildFilterPlansForElements(
				[...maskContentIds]
					.map((id) => elementsMap.get(id))
					.filter((element): element is AnyArtObject => element != null),
				elementsMap,
				this.filterRenderer,
				this.viewportManager.getBoundsCache(),
			);
			if (maskPlans.size > 0) {
				this.executeFilterPlans(encoder, maskFilteredTextures, framePlan, [
					...maskPlans.values(),
				]);
				this.restoreViewportUniformsToGPU();
			}
		}

		this.clipMaskAtlas.preRender(
			encoder,
			requests,
			elementsMap,
			maskFilteredTextures,
		);
		// Drawing the mask content baked whatever solids it contains, exactly as
		// a document draw would. Those bakes are not part of the document, so
		// they are dropped before the end-of-frame flush composites them and a
		// shape used purely as a mask shows up as an object too.
		if (maskContentIds.size > 0) {
			for (const driver of this.backdropDrivers) {
				driver.discardFrameEntries?.(maskContentIds);
			}
		}
		// These textures exist only to be baked into the mask, so unlike the
		// frame's filtered textures nothing downstream reads them and nothing
		// else will hand them back. Left alone they leak once per rebuild.
		for (const info of maskFilteredTextures.values()) {
			releaseRenderSurface(info.source);
			releaseRenderSurface(info.output);
			for (const layer of info.overrideLayers ?? []) {
				releaseRenderSurface(layer);
				if (layer.coverage?.kind === "frame-owned") layer.coverage.release();
			}
		}
		this.restoreViewportUniformsToGPU();

		this.inlineMaskEntries.clear();
		this.maskEntriesByKey.clear();

		if (requests.length === 0) {
			framePlan.maskApplicationPlans.clear();
			return;
		}

		const { assignment, maskApplicationPlans, masksByKey } =
			buildMaskAssignment(
				clipGroups,
				objectMasks,
				elementsMap,
				this.clipMaskAtlas,
				(element) => this.drawsViaTexture(element, filterPlanIds),
				(element) =>
					this.backdropDrivers.some((driver) =>
						driver.hasInlineComposite(element),
					),
				filterPlanIds,
			);
		for (const [elementId, plan] of maskApplicationPlans) {
			framePlan.maskApplicationPlans.set(elementId, plan);
		}
		this.maskEntriesByKey = masksByKey;
		this.maskBoundsContext = boundsContext;

		// Hand each clipped transient its warped mask (slots were reserved above).
		for (const group of meshClipGroups) {
			const entry = this.clipMaskAtlas.getMaskEntry(clipMaskKey(group.id));
			if (!entry) continue;
			for (const memberId of group.memberIds) {
				assignment.set(memberId, entry);
			}
		}

		// Write only mask fields to the GPU buffer, avoiding full rebuild.
		this.viewportManager.writeMaskInfoOnly(assignment);

		// Build per-element mask entry lookup for BG3 switching and outer mask bounds.
		for (const [elementId, maskInfo] of assignment) {
			this.inlineMaskEntries.set(elementId, maskInfo);
		}
	}

	/** Clip groups living inside mesh warp containers, warped with their members. */
	private collectMeshWarpClipGroups(
		elementsMap: Map<string, AnyArtObject>,
	): Array<MeshWarpClipGroup & { meshId: string; bounds: BoundingBox }> {
		const result: Array<
			MeshWarpClipGroup & { meshId: string; bounds: BoundingBox }
		> = [];
		for (const element of elementsMap.values()) {
			if (!isMesh(element)) continue;
			const { clipGroups } = this.elements.resolveMeshWarp(
				element,
				elementsMap,
			);
			if (clipGroups.length === 0) continue;
			// The clip path draws through the mesh's transform like its members, so
			// the mask must cover the mesh's world footprint.
			const bounds = calculateElementBounds(
				element,
				elementsMap,
				this.viewportManager.getBoundsCache(),
			);
			for (const group of clipGroups) {
				result.push({ ...group, meshId: element.id, bounds });
			}
		}
		return result;
	}

	private updateTransformsBuffer(
		elementsMap: Map<string, AnyArtObject>,
		maskMap?: ReadonlyMap<string, MaskEntry>,
	): void {
		this.viewportManager.updateTransformsBuffer(elementsMap, maskMap);
	}

	private updateViewportBoundsCache(): void {
		this.viewportManager.updateViewportBoundsCache();
	}

	/** Destroy textures that were deferred during the frame. Call after submit. */
	public flushDeferredDestroys(): void {
		this.offscreen.flushDeferredDestroys();
	}

	public getCanvasFormat(): GPUTextureFormat {
		return this.canvasFormat;
	}

	/** Mark the transform buffer as dirty so the next render re-uploads it. */
	public markTransformsDirty(): void {
		this.viewportManager.markTransformsDirty();
	}

	/** Snapshot the current viewport state for save/restore around export renders. */
	public getViewportSnapshot(): {
		viewport: Viewport | null;
		width: number;
		height: number;
	} {
		return {
			viewport: this.viewportState.current
				? { ...this.viewportState.current }
				: null,
			width: this.viewportState.width,
			height: this.viewportState.height,
		};
	}

	/**
	 * Blit a canvasFormat texture to an rgba8unorm texture for CPU readback.
	 * The caller must have set viewport uniforms to match the export area.
	 */
	public convertToRgba8unorm(
		encoder: GPUCommandEncoder,
		source: GPUTexture,
		output: GPUTexture,
		centerX: number,
		centerY: number,
		worldWidth: number,
		worldHeight: number,
	): void {
		const blitPass = encoder.beginRenderPass({
			label: "Format Conversion (canvasFormat → rgba8unorm)",
			colorAttachments: [
				{
					view: output.createView(),
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});
		const halfW = worldWidth / 2;
		const halfH = worldHeight / 2;
		this.composite.blitTextureToCanvas(
			blitPass,
			source,
			{
				minX: centerX - halfW,
				minY: centerY - halfH,
				maxX: centerX + halfW,
				maxY: centerY + halfH,
				width: worldWidth,
				height: worldHeight,
			},
			1.0,
			FULL_BLIT_UV_RECT,
			this.blitPipelineRgba8,
		);
		blitPass.end();
	}

	/**
	 * Blit a canvasFormat texture to an rgba32float texture for HDR CPU readback.
	 */
	public convertToRgba32Float(
		encoder: GPUCommandEncoder,
		source: GPUTexture,
		output: GPUTexture,
		centerX: number,
		centerY: number,
		worldWidth: number,
		worldHeight: number,
	): void {
		const blitPass = encoder.beginRenderPass({
			label: "Format Conversion (canvasFormat → rgba32float)",
			colorAttachments: [
				{
					view: output.createView(),
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});
		const halfW = worldWidth / 2;
		const halfH = worldHeight / 2;
		this.composite.blitTextureToCanvas(
			blitPass,
			source,
			{
				minX: centerX - halfW,
				minY: centerY - halfH,
				maxX: centerX + halfW,
				maxY: centerY + halfH,
				width: worldWidth,
				height: worldHeight,
			},
			1.0,
			FULL_BLIT_UV_RECT,
			this.blitPipelineRgba32Float,
		);
		blitPass.end();
	}

	/**
	 * Upload or clear the soft proof 3D LUT used by the final display pass.
	 */
	public setSoftProofLut(lut: SoftProofLutResult | null): void {
		if (lut) {
			this.softProofPass.setLut(lut.data, lut.size);
		} else {
			this.softProofPass.clearLut();
		}
	}

	/**
	 * Apply HDR exposure as a final fullscreen blit pass.
	 * Multiplies RGB by pow(2, exposure) while preserving alpha.
	 */
	private applyExposurePass(
		encoder: GPUCommandEncoder,
		source: GPUTexture,
		targetView: GPUTextureView,
		exposure: number,
	): void {
		const maxNits = HDR_MAX_NITS;
		const edrHeadroom = HDR_EDR_HEADROOM;
		this.device.queue.writeBuffer(
			this.exposureUniformBuffer,
			0,
			new Float32Array([exposure, maxNits, edrHeadroom]),
		);

		if (!this.exposureBindGroup) {
			const sourceView = source.createView();
			this.exposureBindGroupSourceView = sourceView;
			this.exposureBindGroup = this.device.createBindGroup({
				layout: this.exposureBlitBindGroupLayout,
				entries: [
					{ binding: 0, resource: { buffer: this.exposureUniformBuffer } },
					{ binding: 1, resource: this.nearestSampler },
					{ binding: 2, resource: sourceView },
				],
			});
		}

		const pass = encoder.beginRenderPass({
			label: "Exposure Post-Process",
			colorAttachments: [
				{
					view: targetView,
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});
		pass.setPipeline(this.exposureBlitPipeline);
		pass.setBindGroup(0, this.exposureBindGroup);
		pass.draw(6);
		pass.end();
	}

	public render(
		encoder: GPUCommandEncoder,
		_textureView: GPUTextureView,
		canvasTexture: GPUTexture,
		request: FrameRequest,
		profiler?: GPUTimingProfiler | null,
	): CanvasFrameTransaction | null {
		const {
			document,
			editingScopeStack,
			isolatedElementId,
			strategy = RenderStrategy.full,
			getDefRevision,
			boundsCache,
			disableViewportCulling,
			elementFilter,
			clearColorOverride,
			elementOverrides,
			transientElements,
		} = request;

		// Persistent renderState object — set every frame so a prior export
		// render never leaks its flag into the next interactive frame.
		this.renderState.isExport = request.isExport ?? false;

		// Only a full-viewport, non-preview, non-subset render produces a frame
		// worth caching for later viewport-only blits. Export/clipboard subsets
		// (elementFilter), tool previews (elementOverrides/transientElements) and
		// export frames must never contaminate the cache.
		this.captureCompositeFrameThisFrame =
			!this.renderState.isExport &&
			!elementFilter &&
			!elementOverrides?.size &&
			!transientElements?.size;

		// Text axis paths are guides: collect them fresh each frame so paths
		// render again the moment their referencing text (or its binding) goes
		// away, without relying on the opacity restore bookkeeping.
		let textAxisPathIds: Set<string> | null = null;
		for (const obj of Object.values(document.objects)) {
			if (obj?.type === "text" && obj.axisBinding) {
				textAxisPathIds ??= new Set();
				textAxisPathIds.add(obj.axisBinding.pathObjectId);
			}
		}
		this.renderState.textAxisPathIds = textAxisPathIds;
		this.renderState.paintedAxisPathIds = textAxisPathIds ? new Set() : null;

		// Store encoder for use by sub-methods (renderElements, etc.)
		this.activeEncoder = encoder;
		this.activeDocument = document;
		// Bind the element caches to this document's scope — the single choke
		// point both the interactive path and export/preview renders go through,
		// so a transient-document render (brush preview) swaps to its own cache
		// set instead of pruning the main document's. No save/restore needed:
		// every render re-binds for its own document, including frames
		// interleaved with an awaiting export.
		this.cacheManager.setActiveDocument(document.id);
		this.activeGetDefRevision = getDefRevision ?? null;
		this.activeProfiler = profiler ?? null;

		this.recycleFramePools();

		// Reuse precomputed SpatialIndex bounds when available.
		this.renderState.boundsCache = boundsCache ?? null;
		this.renderState.localBoundsCache = this.viewportManager.getBoundsCache();
		if (!this.viewportState.current) return null;

		// viewportBlit: a viewport-only interaction frame. With a valid cached
		// composite, blit + reproject it and skip the whole document render.
		// HDR/soft-proof frames and a missing cache fall through to a normal
		// render (which refreshes the cache via the capture pass).
		if (strategy === RenderStrategy.viewportBlit) {
			const needsPostProcess =
				request.hdrExposure != null || request.softProof === true;
			if (
				!needsPostProcess &&
				this.compositeFrameCache.valid &&
				this.compositeFrameCache.texture
			) {
				return this.renderViewportBlit(encoder, canvasTexture, profiler);
			}
			// Fall through: render this frame normally and capture it.
		}
		// Transient (preview) elements carry their own transforms and parent
		// relations, so the transforms buffer must be rebuilt whenever the
		// transient set changes — even on non-full strategies. While transients
		// exist their map mutates in place (identity never changes), so rebuild
		// every frame; with none, there is nothing to rebuild. Normalizing to
		// null before comparing matters: raw `undefined !== null` used to be
		// true on EVERY transient-less frame, silently rebuilding and
		// re-uploading all transforms during pan/zoom.
		const transients = transientElements ?? null;
		if (transients !== this.lastTransientElements || transients != null) {
			this.lastTransientElements = transients;
			this.viewportManager.markTransformsDirty(false);
		}
		// Element overrides swap in new geometry under the same element id
		// (e.g. path-edit drag previews), so the cached local bounds — and the
		// GPU transform origins / texture tile rects derived from them — go
		// stale the moment an override appears, changes, or clears. The map is
		// mutated in place (no identity change per update), so evict by id
		// every frame while any override is active, and once more after the
		// set empties to restore the un-overridden bounds.
		this.renderState.staleWorldBoundsIds = null;
		if (elementOverrides?.size || this.lastOverrideIds?.size) {
			const staleIds = new Set(this.lastOverrideIds);
			if (elementOverrides) {
				for (const id of elementOverrides.keys()) staleIds.add(id);
			}
			const evicted = this.viewportManager.invalidateElementBounds(staleIds);
			// SpatialIndex only reflects committed document geometry, so its
			// world bounds for the overridden ids (and their ancestors) are
			// equally stale while overrides are live — offscreen compositing
			// textures sized from them clip the preview at the pre-drag bbox.
			if (elementOverrides?.size) {
				this.renderState.staleWorldBoundsIds = evicted;
			}
			this.lastOverrideIds = elementOverrides?.size
				? new Set(elementOverrides.keys())
				: null;
		}
		// Full document updates invalidate brush stamp caches and transform
		// buffer. Geometry caches (flatten, stroke, stencil fill) are
		// self-validating so only stale entries for deleted elements are pruned.
		// The prune scans every cache key, and only deletions give it work — a
		// tracked change set with no deletions proves there are none, so the
		// scan is skipped (an untracked frame must still take it).
		const needsDeletionPrune =
			!request.changedElements || request.changedElements.deleted.size > 0;
		if (
			strategy === RenderStrategy.full ||
			strategy === RenderStrategy.fullTransformOnly
		) {
			if (needsDeletionPrune) {
				this.cacheManager.onDocumentChange(document.objects);
			}
			// With a tracked change set, only the changed elements' transforms
			// (and their bounds-coupled ancestors/descendants) are recomposed;
			// an untracked frame falls back to the full rebuild. The strategies
			// differ only in that fallback: fullTransformOnly preserves local
			// bounds (shape-preserving moves), full drops them.
			if (request.changedElements) {
				this.viewportManager.markElementTransformsDirty(
					request.changedElements,
				);
			} else {
				this.viewportManager.markTransformsDirty(
					strategy === RenderStrategy.full,
				);
			}
			this.clipMaskAtlas.invalidateAll();
		}
		const exposure = request.hdrExposure ?? 0;
		const needsExposurePass = request.hdrExposure != null;
		// Soft proof and HDR exposure are mutually exclusive (print simulation
		// is inherently SDR). If both arrive, exposure wins and proof is skipped.
		const needsProofPass =
			!needsExposurePass &&
			request.softProof === true &&
			this.softProofPass.hasLut();
		const needsPostProcess = needsExposurePass || needsProofPass;

		// When a post-process pass is needed, render to an intermediate texture
		// first, then apply the pass (HDR exposure or soft proof LUT) as a
		// final blit to the canvas.
		let renderTargetTexture = canvasTexture;

		if (needsPostProcess) {
			if (
				!this.postProcessIntermediate ||
				this.postProcessIntermediate.width !== canvasTexture.width ||
				this.postProcessIntermediate.height !== canvasTexture.height
			) {
				this.postProcessIntermediate?.destroy();
				this.exposureBindGroup = null;
				this.exposureBindGroupSourceView = null;
				this.postProcessIntermediate = this.device.createTexture({
					label: "Post-Process Intermediate",
					size: {
						width: canvasTexture.width,
						height: canvasTexture.height,
					},
					format: this.canvasFormat,
					usage:
						GPUTextureUsage.RENDER_ATTACHMENT |
						GPUTextureUsage.TEXTURE_BINDING |
						GPUTextureUsage.COPY_SRC |
						GPUTextureUsage.COPY_DST,
				});
			}
			renderTargetTexture = this.postProcessIntermediate;
		}

		// Render document to target (canvas or intermediate).
		let filteredTextures: Map<string, FilteredTextureInfo>;
		const graph = new FrameGraph();
		const renderTarget = graph.importTexture(
			renderTargetTexture,
			"render-target",
		);
		filteredTextures = this.renderDocument(
			encoder,
			document,
			{
				graph,
				renderTarget,
				changedElements: request.changedElements,
			},
			editingScopeStack,
			isolatedElementId,
			profiler,
			disableViewportCulling,
			elementFilter,
			clearColorOverride,
			elementOverrides,
			transientElements,
			request.paintArtboardBackgrounds,
		);
		if (needsPostProcess && this.postProcessIntermediate) {
			const swapchain = graph.importTexture(canvasTexture, "swapchain");
			graph.addPass("Post-Process Blit", {
				reads: [renderTarget],
				writes: [swapchain],
				execute: (ctx) => {
					if (!this.postProcessIntermediate) return;
					// renderTarget imports the post-process intermediate; swapchain
					// imports the canvas texture. Resolve both through the graph.
					if (needsExposurePass) {
						this.applyExposurePass(
							ctx.encoder,
							ctx.get(renderTarget),
							ctx.view(swapchain),
							exposure,
						);
					} else {
						this.softProofPass.apply(
							ctx.encoder,
							ctx.view(renderTarget),
							ctx.view(swapchain),
						);
					}
				},
			});
		}
		const transaction = this.executeFrame(graph, encoder, filteredTextures);
		this.updateViewportBoundsCache();
		return transaction;
	}

	/**
	 * Recycle the per-frame pooled GPU resources left by the previous frame —
	 * the begin-frame counterpart to releaseFrameResources. Budget eviction runs
	 * here (after the prior frame's submit) so destroyed textures are no longer
	 * referenced by in-flight command buffers.
	 */
	private recycleFramePools(): void {
		this.texturePool.resetFrame();
		this.uniformScope.resetFrame();
		this.composite.resetFrame();
		this.offscreen.resetFrame();
		this.filterRenderer.flushPendingDestroy();
		// All scopes, not just the active one: a scope deactivated mid-frame must
		// still release the buffers it deferred.
		this.cacheManager.flushPendingDestroy();
		this.geometryStore.flushPendingReleases();
		this.runBatcher.beginFrame();
		this.backdropBlitPool.index = 0;
	}

	/**
	 * Execute the frame's graph and release every per-frame resource, on both
	 * the success and the throw paths. The single owner of frame
	 * commit/abort/release: a throw in graph.execute (device loss, a pass bug)
	 * must not leak tile pins, frame textures, backdrop captures/pyramids or
	 * filter bakes, or wedge LRU eviction and exhaust the atlas. Only the tile
	 * "ready" promotion is success-only — an unbaked reservation must stay a
	 * miss for a later frame to re-bake or evict.
	 */
	private executeFrame(
		graph: FrameGraph,
		encoder: GPUCommandEncoder,
		filteredTextures: Map<string, FilteredTextureInfo>,
	): CanvasFrameTransaction {
		try {
			graph.execute(encoder, this.texturePool);
		} finally {
			this.releaseFrameResources(filteredTextures);
		}
		let settled = false;
		return {
			commit: () => {
				if (settled) return;
				settled = true;
			},
			abort: () => {
				if (settled) return;
				settled = true;
			},
		};
	}

	/** Return every resource this frame leased to the deferred-destroy pool /
	 *  the tile store. Called from executeFrame's finally, so it runs whether the
	 *  frame submitted or threw. */
	private releaseFrameResources(
		filteredTextures: Map<string, FilteredTextureInfo>,
	): void {
		for (const info of filteredTextures.values()) {
			releaseRenderSurface(info.source);
			releaseRenderSurface(info.output);
			if (info.overrideLayers) {
				for (const layer of info.overrideLayers) {
					releaseRenderSurface(layer);
					if (layer.coverage?.kind === "frame-owned") layer.coverage.release();
				}
			}
		}
		// Backdrop-composite drivers' baked solids share the frame-local lifetime
		// of filteredTextures, as do the coordinator's captures + pyramid levels.
		for (const driver of this.backdropDrivers) {
			driver.releaseFrame((tex) => this.offscreen.deferDestroy(tex));
		}
		this.backdropEffectCoordinator.releaseFrame((tex) =>
			this.offscreen.deferDestroy(tex),
		);
		// Per-frame release for filter handlers that own GPU resources (e.g.
		// extrude's opaque bake/normal textures) — mirrors the startFrame loop.
		for (const handler of this.filterRenderer.getHandlers().values()) {
			handler.releaseFrame?.((tex) => this.offscreen.deferDestroy(tex));
		}
		// Upload this frame's accumulated run indices (and reset the batcher) —
		// after every pass is encoded, before the orchestrator submits.
		this.runBatcher.finishFrame();
	}

	/**
	 * Render full document (all layers and elements) to target texture.
	 */
	private renderDocument(
		encoder: GPUCommandEncoder,
		document: Document,
		fg: {
			graph: FrameGraph;
			renderTarget: FGTextureHandle;
			changedElements?: FrameRequest["changedElements"];
		},
		editingScopeStack?: string[],
		isolatedElementId?: string | null,
		profiler?: GPUTimingProfiler | null,
		disableViewportCulling?: boolean,
		elementFilter?: ReadonlySet<string>,
		clearColorOverride?: RawRGBA,
		elementOverrides?: ReadonlyMap<string, AnyArtObject>,
		transientElements?: ReadonlyMap<string, TransientElementEntry>,
		paintArtboardBackgrounds?: boolean,
	): Map<string, FilteredTextureInfo> {
		// Evict unused gradient textures and reset per-frame draw indices
		this.gradient.textureGenerator.beginFrame();
		this.gradient.meshTextureGenerator.beginFrame();
		this.gradient.drawIndex = 0;
		this.strokeRegistry?.beginFrame();
		this.elements.beginFrame();
		// Reset each backdrop-composite driver's per-frame pools + inline-composed
		// tracking (glass extrude refraction), and the shared capture/pyramid
		// coordinator they sample through.
		this.backdropEffectCoordinator.beginFrame();
		for (const driver of this.backdropDrivers) {
			driver.beginFrame();
		}
		// Per-frame reset for filter handlers that own GPU state (e.g. the
		// extrude mesh pass's uniform/MSAA pools).
		for (const handler of this.filterRenderer.getHandlers().values()) {
			handler.startFrame?.();
		}

		// Pre-compute viewport bounds once for all renderPath calls in this frame
		this.updateViewportBoundsCache();

		// Disable CPU-side viewport culling for export/offscreen rendering.
		// Elements may have transforms that place them within the target
		// post-transform, but at pre-transform positions outside the viewport.
		if (disableViewportCulling) {
			this.viewportState.bounds = null;
		}

		// Store files reference for image rendering
		this.assetState.currentFiles = document.files;

		// Store editing scope ID for isolation mode rendering
		this.renderState.editingScopeStack = editingScopeStack ?? [];
		this.renderState.isolatedElementId = isolatedElementId ?? null;

		// Build — or reuse — the merged elements map and the viewport-independent
		// frame-plan structure. Both derive purely from the document plus the
		// override/transient overlays, so document-invariant frames (pan/zoom)
		// reuse the previous frame's result instead of re-copying every object
		// and re-classifying every filter. Reuse and caching are disabled while
		// overrides are active (the map mutates in place, identity proves
		// nothing); the pre-override cache entry stays valid for after they end.
		const cachedPlan = this.framePlanStructureCache;
		let mergedElementsMap: Map<string, AnyArtObject>;
		let planStructure: FramePlanStructure;
		if (
			cachedPlan != null &&
			!elementOverrides?.size &&
			cachedPlan.objects === document.objects &&
			cachedPlan.layers === document.layers &&
			cachedPlan.artboards === document.artboards &&
			cachedPlan.transients === transientElements
		) {
			mergedElementsMap = cachedPlan.mergedElementsMap;
			planStructure = cachedPlan.structure;
		} else {
			mergedElementsMap = new Map<string, AnyArtObject>(
				Object.entries(document.objects),
			);
			if (elementOverrides) {
				for (const [id, el] of elementOverrides) mergedElementsMap.set(id, el);
			}
			if (transientElements) {
				for (const [, { element }] of transientElements)
					mergedElementsMap.set(element.id, element);
			}
			// Copy a render-replacing appearance (e.g. extrude3d) from a blend's keys
			// onto the blend so the generic filter system renders each interpolated
			// instance through it — no extrude-specific branch in the render path.
			hoistBlendInstanceAppearances(mergedElementsMap, this.filterRenderer);
			// Share the ViewportManager's bounds cache so raw element bounds
			// computed here are reused in updateTransformsBuffer (avoids double calc).
			planStructure = buildFramePlanStructure(
				document,
				this.filterRenderer.getHandlers(),
				false,
				this.viewportManager.getBoundsCache(),
				mergedElementsMap,
				transientElements,
			);
			if (!elementOverrides?.size) {
				this.framePlanStructureCache = {
					objects: document.objects,
					layers: document.layers,
					artboards: document.artboards,
					transients: transientElements,
					mergedElementsMap,
					structure: planStructure,
				};
			}
		}
		// Track the active elementsMap for def rasterization so live overrides
		// (tool drafts, transient layers) are reflected in pattern previews.
		this.activeElementsMap = mergedElementsMap;

		// Derive this frame's plan (viewport culling + backdrop segment slicing
		// — cheap, O(candidates + layers), no full element walk).
		const framePlan: RendererFramePlan = {
			...buildFramePlanView(
				planStructure,
				this.viewportState.current!,
				this.viewportState.width,
				this.viewportState.height,
			),
			maskApplicationPlans: new Map(),
			groupCompositionPlans: new Map(),
		};
		this.activeMaskApplicationPlans = framePlan.maskApplicationPlans;
		this.activeGroupCompositionPlans = framePlan.groupCompositionPlans;
		const {
			elementsMap,
			anyLayerNeedsCompositing,
			hasArtboards,
			clearColor: framePlanClearColor,
			backdropElementIds,
			localBoundsCache,
		} = framePlan;
		const clearColor = clearColorOverride ?? framePlanClearColor;
		// Note-paper dot background: only for the live empty canvas (no artboards,
		// no caller-supplied background — i.e. never for export/copy/thumbnails,
		// which always pass clearColorOverride). The prebuf is cleared transparent
		// so the dots drawn in the final blit pass show through empty areas; the
		// final target still clears to white (clearColor).
		const dotGridBackground = !hasArtboards && clearColorOverride == null;
		const prebufClearColor: RawRGBA = dotGridBackground
			? { r: 0, g: 0, b: 0, a: 0 }
			: clearColor;
		const realCanvasWidth = this.viewportState.width;
		const realCanvasHeight = this.viewportState.height;
		const realViewportBounds =
			this.viewportState.current != null
				? getVisibleWorldBounds(
						this.viewportState.current,
						realCanvasWidth,
						realCanvasHeight,
					)
				: null;
		const { prebufWidth, prebufHeight, prebufZoom } = calculatePrebufDimensions(
			{
				viewport: this.viewportState.current!,
				visibleBounds: realViewportBounds,
				canvasWidth: realCanvasWidth,
				canvasHeight: realCanvasHeight,
				maxTextureDimension: this.device.limits.maxTextureDimension2D,
			},
		);
		const prebufViewport = {
			x: this.viewportState.current!.x,
			y: this.viewportState.current!.y,
			zoom: prebufZoom,
			rotation: 0,
		} satisfies Viewport;
		const prebufVisibleBounds = getVisibleWorldBounds(
			prebufViewport,
			prebufWidth,
			prebufHeight,
		);
		const prebufViewportBounds =
			disableViewportCulling || realViewportBounds == null
				? null
				: {
						minX: prebufVisibleBounds.left,
						minY: prebufVisibleBounds.bottom,
						maxX: prebufVisibleBounds.right,
						maxY: prebufVisibleBounds.top,
						width: prebufVisibleBounds.width,
						height: prebufVisibleBounds.height,
					};

		// Expand the top-level export selection to its full render subtree so the
		// pre-passes that walk the whole elementsMap (glass bake, clip/object
		// masks, per-element filter plans) keep the selection's descendants but
		// drop front siblings. Undefined for normal renders (no elementFilter),
		// which keeps every pre-pass byte-for-byte unchanged.
		const effectiveFilter =
			elementFilter != null
				? expandRenderFilter(elementFilter, elementsMap)
				: undefined;

		// Filter layer plans to include only target elements (for clipboard
		// export). `elements` (the flat per-layer array executeFilterPlans reads)
		// must be filtered too, or a front element's appearance filters still bake.
		const layerPlans = effectiveFilter
			? framePlan.layerPlans
					.map((lp) => ({
						...lp,
						elements: lp.elements.filter((el) => effectiveFilter.has(el.id)),
						segments: lp.segments.map((seg) => ({
							...seg,
							elements: seg.elements.filter((el) => effectiveFilter.has(el.id)),
						})),
						opacity: 1.0,
					}))
					.filter((lp) =>
						lp.segments.some(
							(seg) =>
								seg.elements.length > 0 ||
								(seg.backdropAfter != null &&
									effectiveFilter.has(seg.backdropAfter.element.id)),
						),
					)
			: framePlan.layerPlans;

		// Upload transforms to GPU so that filter offscreen passes and
		// clipMaskAtlas.preRender can read the storage buffer.  When dirty
		// is false (viewport-only changes) this is a no-op.  When dirty is
		// true (element mutations) this writes transforms without mask info;
		// applyClipMasks will re-upload once more with mask info included.
		this.updateTransformsBuffer(elementsMap);

		// Prepare phase for backdrop-composite geometry filters (glass extrude):
		// encode depth-tested mesh passes into frame-local textures before any
		// consumer pass opens (a depth pass cannot be nested inside another pass).
		// Must run before executeFilterPlans — per-appearance offscreen plans
		// composite the results too. Uses its own uniform buffers, so no viewport
		// re-sync is needed. Runs immediately (not as a graph pass):
		// inline-composite classification — buildPassPlan reads the frame
		// entries this bake registers, so they must exist before the plan is
		// built.
		for (const driver of this.backdropDrivers) {
			driver.prepareFrame(
				encoder,
				elementsMap,
				this.getRasterScale(),
				// The backdrop is captured straight out of the canvas, so one
				// capture texel is one device pixel and the zoom IS its
				// texels-per-world-px — at export scale just as much as on screen.
				this.viewportState.current?.zoom ?? 1,
				profiler,
				effectiveFilter,
			);
		}

		// Register this frame's backdrop-filter regions with the coordinator, so
		// the first one to compose captures a single shared fixed-R batch that
		// serves them all (dropped and recaptured when an intersecting draw —
		// including an earlier backdrop blit — lands in a request's region).
		const backdropFilterRequests = new Map<string, BackdropEffectRequest>();
		for (const layerPlan of layerPlans) {
			for (const segment of layerPlan.segments) {
				const bdElem = segment.backdropAfter;
				if (!bdElem || bdElem.element.visible === false) continue;
				if (effectiveFilter && !effectiveFilter.has(bdElem.element.id))
					continue;
				backdropFilterRequests.set(bdElem.element.id, {
					bounds: this.getBackdropTextureBounds(bdElem),
					blurSigma: this.getBackdropBlurSigma(bdElem),
					rasterScale: this.getRasterScale(),
				});
			}
		}
		// The pooled-texture working set scales with the canvas surface; keep
		// the pool budget above it or resetFrame evicts canvas-sized textures
		// every frame just to re-allocate them the next one.
		this.texturePool.setBudgetBytes(
			texturePoolBudgetBytes(prebufWidth, prebufHeight),
		);
		if (backdropFilterRequests.size > 0) {
			this.backdropEffectCoordinator.planFrame([
				...backdropFilterRequests.values(),
			]);
		}

		// Execute GPU filter rendering for elements that need offscreen passes.
		// On the graph path this is the first declared pass: it executes before
		// the prebuf viewport bind (Canvas Clear), preserving the procedural
		// environment, though after the clip-mask/def pre-passes that are still
		// encoded outside the graph. The produced textures stay frame-transient
		// closure state until lifetime analysis (G2) gives them handles.
		const filteredTextures = new Map<string, FilteredTextureInfo>();
		const encodeElementFilters = (ctx: FGExecuteContext): void => {
			// Feed the filtered layerPlans so a front element's appearance filters
			// are not baked into the export (executeFilterPlans derives its plan
			// list from layerPlan.elements).
			this.executeFilterPlans(ctx.encoder, filteredTextures, {
				...framePlan,
				layerPlans,
			});
			// Masks land on the filtered result, so they run after the filters.
			this.applyPostMasks(ctx.encoder, filteredTextures, elementsMap);
			// Repeat elements bake their source subtree once and blit it at every
			// computed instance; store the instance blits as overrideLayers so the
			// main pass draws them like a self-sized filter output.
			this.bakeRepeats(ctx.encoder, filteredTextures, {
				...framePlan,
				layerPlans,
			});
			// Re-sync GPU uniform buffer after offscreen passes dirtied it
			this.restoreViewportUniformsToGPU();
		};
		// Pre-rasterize every pattern def referenced by visible elements'
		// fill / stroke before the main pass so the gradient renderer can
		// sample them without lazy mid-frame allocations. Mirrors
		// preRenderBrushDefs.
		const patternDefIds = collectPatternDefIdsInUse(
			elementsMap,
			this.filterRenderer,
		);
		if (patternDefIds.size > 0) {
			fg.graph.addPass("Pattern Defs", {
				reads: [],
				writes: [],
				neverCull: true,
				execute: (ctx) => {
					this.preRenderPatternDefs(ctx.encoder, patternDefIds);
					this.restoreViewportUniformsToGPU();
				},
			});
		}

		// Same pre-pass for defs referenced as brush sources so the stamp
		// pipeline finds their textures in the BrushTextureManager.
		const brushDefIds = collectBrushDefIdsInUse(elementsMap);
		if (brushDefIds.size > 0) {
			fg.graph.addPass("Brush Defs", {
				reads: [],
				writes: [],
				neverCull: true,
				execute: (ctx) => {
					this.preRenderBrushDefs(ctx.encoder, brushDefIds);
					this.restoreViewportUniformsToGPU();
				},
			});
		}

		// Pre-render masks and build the mask assignment, then upload transforms
		// once with mask info included.
		//
		// After the def pre-passes, because object masks draw their content with
		// its real appearance: a pattern-filled shape used as a mask needs its
		// pattern texture to already exist, or it bakes into the mask wrong.
		// Before the filters, because a filtered element's bake reads the mask
		// assignment, and applyPostMasks consumes what this pass decides.
		fg.graph.addPass("Masks", {
			reads: [],
			writes: [],
			neverCull: true,
			execute: (ctx) => {
				this.applyClipMasks(
					ctx.encoder,
					elementsMap,
					framePlan,
					effectiveFilter,
				);
			},
		});

		fg.graph.addPass("Element Filters", {
			reads: [],
			writes: [],
			neverCull: true,
			execute: encodeElementFilters,
		});

		// Always ensure composite textures exist so that element-level blend
		// mode compositing works even on the first frame.  The layer-level
		// compositing path is separately guarded by `anyLayerNeedsCompositing`.
		this.cache.ensureCompositeTextures(prebufWidth, prebufHeight);

		// Ensure stencil texture is available before any render pass uses it
		this.cache.ensureStencilTexture(prebufWidth, prebufHeight);

		const prebufTexture = this.compositeState.prebufTexture!;
		const savedViewportCurrent = this.viewportState.current;
		const savedViewportWidth = this.viewportState.width;
		const savedViewportHeight = this.viewportState.height;
		const savedViewportBounds = this.viewportState.bounds;
		// Swap the CPU viewport state and the active viewport binding over to
		// the prebuf. The graph path defers this until its first layer pass
		// (Canvas Clear) executes, so graph passes declared earlier (element
		// filters) still run against the real viewport, matching the
		// procedural order. `prebufBounds` binds lazily for the same reason.
		let prebufBounds: ReturnType<
			typeof this.elements.getCurrentRenderTargetBounds
		> = null;
		const bindPrebufViewport = (): void => {
			const prebufEntry = this.uniformScope.acquire(
				prebufViewport,
				prebufWidth,
				prebufHeight,
			);
			this.viewportState.current = prebufViewport;
			this.viewportState.width = prebufWidth;
			this.viewportState.height = prebufHeight;
			this.viewportState.bounds = prebufViewportBounds;
			this.pushViewportBinding(prebufEntry.bindGroup, prebufEntry.buffer);
			prebufBounds = this.elements.getCurrentRenderTargetBounds();
		};

		let activeGraphContext: FGExecuteContext | null = null;
		const withGraphContext = <T>(
			ctx: FGExecuteContext,
			execute: () => T,
		): T => {
			const previous = activeGraphContext;
			activeGraphContext = ctx;
			try {
				return execute();
			} finally {
				activeGraphContext = previous;
			}
		};

		// Helper to start a new render pass targeting the unrotated prebuf
		let passSeq = 0;
		const startNewPass = (clear: boolean): GPURenderPassEncoder => {
			const ctx = activeGraphContext;
			if (!ctx)
				throw new Error("CanvasLayer: render pass opened outside FrameGraph");
			const desc: GPURenderPassDescriptor = {
				label: "Canvas Layer Prebuf Pass",
				colorAttachments: [
					{
						view: ctx.view(prebufHandle),
						clearValue: prebufClearColor,
						loadOp: clear ? "clear" : "load",
						storeOp: "store",
					},
				],
				depthStencilAttachment: createPassLocalStencilAttachment(
					ctx.scratchView(stencilHandle),
				),
				timestampWrites: profiler?.timestampWrites(`Elements #${passSeq++}`),
			};
			const pass = ctx.encoder.beginRenderPass(desc);
			pass.setPipeline(this.strokePipeline);
			pass.setBindGroup(0, this.viewportBinding.active);
			pass.setBindGroup(1, this.transformsBindGroup!);
			pass.setBindGroup(2, this.dummyGradientBindGroup);
			pass.setBindGroup(3, this.renderState.currentMaskBindGroup);
			return pass;
		};

		const mainCompositeContext: CompositeRenderContext = {
			get encoder() {
				if (!activeGraphContext) {
					throw new Error("CanvasLayer: composite encoded outside FrameGraph");
				}
				return activeGraphContext.encoder;
			},
			get targetTexture() {
				if (!activeGraphContext) {
					throw new Error("CanvasLayer: composite encoded outside FrameGraph");
				}
				return activeGraphContext.get(prebufHandle);
			},
			restartPass: () => startNewPass(false),
		};

		// Everything after the layer passes still needs the prebuf viewport:
		// fill-batch upload, isolation dim, backdrop fallback, then viewport
		// restore + final blit. The graph declares each as its own pass.
		const encodeFillBatchUpload = (): void => {
			// Upload all batched fill vertex data in a single writeBuffer call.
			// Must happen after the render pass (all draw calls recorded) and
			// before queue.submit() so the GPU buffer contains the data when
			// the command buffer executes.
			this.elements.flushFillBatch();
		};

		const encodeBackdropFlush = (ctx: FGExecuteContext): void => {
			// Backdrop-composite fallback: warp the finished backdrop under any
			// distortion-glass extrudes not composed inline at their z-order (a
			// render path with no composite context). Runs while prebuf is complete
			// and still in prebuf space.
			for (const driver of this.backdropDrivers) {
				driver.flushRemaining(
					ctx.encoder,
					ctx.get(prebufHandle),
					prebufViewport,
					prebufWidth,
					prebufHeight,
					profiler,
				);
			}
		};

		const encodeFinalBlit = (ctx: FGExecuteContext): void => {
			this.popViewportBinding();
			this.viewportState.current = savedViewportCurrent;
			this.viewportState.width = savedViewportWidth;
			this.viewportState.height = savedViewportHeight;
			this.viewportState.bounds = savedViewportBounds;
			this.restoreViewportUniformsToGPU();
			const finalPass = ctx.encoder.beginRenderPass({
				label: "Canvas Layer Final Blit Pass",
				colorAttachments: [
					{
						// The render target is a declared FG handle; resolve its view
						// through the graph so the blit's real access matches its
						// writes declaration.
						view: ctx.view(fg.renderTarget),
						clearValue: clearColor,
						loadOp: "clear",
						storeOp: "store",
					},
				],
				depthStencilAttachment: createPassLocalStencilAttachment(
					ctx.scratchView(finalStencilHandle),
				),
			});
			// Dot background sits behind the document: draw it after the white
			// clear and before blitting the (transparent-background) prebuf, so
			// content covers the dots and empty areas keep them.
			if (dotGridBackground) {
				this.drawDotGridBackground(
					finalPass,
					realCanvasWidth,
					realCanvasHeight,
					savedViewportCurrent,
				);
			}
			if (prebufBounds) {
				this.composite.blitTextureToCanvas(
					finalPass,
					ctx.get(prebufHandle),
					prebufBounds,
					1.0,
				);
			}
			finalPass.end();
		};

		// Declarative layer passes (G1 step 4): one pass per layer segment,
		// the layer-composite stages spelled out, and the remaining
		// procedural tail as a single pass (split further in later steps).
		const { graph } = fg;
		const prebufHandle = graph.importTexture(prebufTexture, "prebuf");
		const stencilHandle = graph.importScratchAttachment(
			this.stencil.texture!,
			"stencil",
		);
		this.cache.ensureFinalBlitStencilTexture(realCanvasWidth, realCanvasHeight);
		const finalStencilHandle = graph.importScratchAttachment(
			this.compositeState.finalBlitStencil.texture!,
			"final-blit-stencil",
		);
		// The layer-composite scratch textures are shared by every
		// compositing layer (and the dim overlay reuses the capture), so
		// import each once — importing the same GPUTexture twice would
		// split its identity for lifetime analysis in later phases.
		const captureTexture = this.compositeState.captureTexture;
		const captureHandle = captureTexture
			? graph.importTexture(captureTexture, "layer-composite-capture")
			: null;
		const layerTexture = anyLayerNeedsCompositing
			? this.compositeState.layerTexture
			: null;
		const layerTextureHandle = layerTexture
			? graph.importTexture(layerTexture, "layer-composite-source")
			: null;
		const canvasBaseHandle = layerTexture
			? graph.importTexture(
					this.compositeState.canvasBaseTexture!,
					"layer-composite-base",
				)
			: null;

		graph.addPass("Canvas Clear", {
			reads: [],
			writes: [prebufHandle],
			scratchAttachments: [stencilHandle],
			execute: (ctx) =>
				withGraphContext(ctx, () => {
					bindPrebufViewport();
					const pass = startNewPass(true);
					// Artboard backgrounds render only on the clearing pass. Skip
					// when clearColorOverride is set — the caller controls the
					// background — unless the caller explicitly asks for them
					// (paintArtboardBackgrounds).
					if (
						hasArtboards &&
						(clearColorOverride == null || paintArtboardBackgrounds)
					) {
						this.renderArtboardBackgrounds(pass, document.artboards);
					}
					pass.end();
				}),
		});

		const addBackdropPass = (
			bdElem: BackdropElementEntry,
			targetHandle: FGTextureHandle,
			alphaMultiplier: number,
			targetIsPrebuf: boolean,
		): void => {
			if (
				bdElem.element.visible === false ||
				!this.stencil.texture ||
				(elementFilter && !elementFilter.has(bdElem.element.id))
			) {
				return;
			}
			graph.addPass(`Backdrop ${bdElem.element.id}`, {
				reads: [prebufHandle],
				writes: [targetHandle],
				scratchAttachments: [stencilHandle],
				// The coordinator's capture/dirty bookkeeping is a side effect
				// the graph cannot see.
				neverCull: true,
				execute: (ctx) => {
					this.processBackdropElement(
						ctx.encoder,
						prebufViewport,
						ctx.view(targetHandle),
						ctx.get(prebufHandle),
						bdElem,
						elementsMap,
						alphaMultiplier,
						ctx.scratchView(stencilHandle),
						backdropFilterRequests.get(bdElem.element.id),
					);
					// The blit rewrote part of the capture source when the target
					// is the prebuf itself — report the region so later backdrop
					// consumers patch or recapture just where it landed. Layer
					// composite targets don't touch the prebuf.
					if (targetIsPrebuf) {
						this.backdropEffectCoordinator.noteDraw(
							backdropFilterRequests.get(bdElem.element.id)?.bounds ??
								this.getBackdropTextureBounds(bdElem),
						);
					}
				},
			});
		};

		// Segment every layer along its declared breaks — backdrop,
		// composite-element and inline-backdrop-compose — so each becomes
		// its own pass, fed the element-filtered layer plans this frame
		// actually renders.
		const passPlans = buildPassPlan({ ...framePlan, layerPlans }, (element) =>
			this.backdropDrivers.some((d) => d.hasInlineComposite(element)),
		);

		// renderElements culls each element against the viewport, but only once
		// the pass is already open — so a segment whose elements are all off
		// screen still paid for opening and closing one, and the colour
		// attachment is stored and reloaded across that boundary whatever it
		// holds. Measured while panning, 29 of 38 main passes a frame issued no
		// draw at all. Asking the same question before the pass is opened costs
		// a bounds lookup per element and skips the whole pass when the answer
		// is no.
		//
		// This does not touch buildPassPlan's declaration, which stays a
		// superset of the runtime breaks — only whether a declared pass is
		// worth opening this frame.
		const anyElementOnScreen = (elements: readonly AnyArtObject[]): boolean => {
			if (prebufViewportBounds == null) return true;
			for (const element of elements) {
				if (element.visible === false) continue;
				const bounds =
					(this.renderState.staleWorldBoundsIds?.has(element.id)
						? undefined
						: this.renderState.boundsCache?.get(element.id)) ??
					calculateElementBounds(element, elementsMap, localBoundsCache);
				// Same expansion the runtime cull uses: an extrude's solid reaches
				// past the flat footprint, and culling on the flat bounds pops it
				// out at the viewport edge.
				const cull = this.expandBoundsForRenderedOutput(
					element,
					bounds,
					filteredTextures.get(element.id),
				);
				if (
					!(
						cull.maxX < prebufViewportBounds.minX ||
						cull.minX > prebufViewportBounds.maxX ||
						cull.maxY < prebufViewportBounds.minY ||
						cull.minY > prebufViewportBounds.maxY
					)
				) {
					return true;
				}
			}
			return false;
		};

		// Plain layers write the same two attachments with nothing in between,
		// and the stencil they use is already per-element (the cover step's
		// passOp is "zero", which is what makes stencilStoreOp discard sound).
		// Giving each its own render pass therefore buys nothing and costs a
		// full-surface colour store plus reload at every boundary — the largest
		// single item in the frame. Runs accumulate here and open one pass.
		//
		// Opacity stays per layer: it is an argument to renderElements, applied
		// per element, so the run is replayed group by group inside the one
		// pass rather than flattened into a single element list.
		let pendingRuns: { elements: AnyArtObject[]; opacity: number }[] = [];
		const flushPendingRuns = (): void => {
			if (pendingRuns.length === 0) return;
			const runs = pendingRuns;
			pendingRuns = [];
			graph.addPass("Layer Elements", {
				reads: [prebufHandle],
				writes: [prebufHandle],
				scratchAttachments: [stencilHandle],
				execute: (ctx) =>
					withGraphContext(ctx, () => {
						let pass = startNewPass(false);
						this.runBatcher.setBatching(true);
						for (const run of runs) {
							pass = this.renderElements(
								pass,
								run.elements,
								filteredTextures,
								elementsMap,
								run.opacity,
								null,
								backdropElementIds,
								"main",
								mainCompositeContext,
								localBoundsCache,
							);
						}
						this.runBatcher.setBatching(false);
						pass.end();
					}),
			});
		};

		for (const { layerPlan, segments } of passPlans) {
			if (
				!layerPlan.needsLayerCompositing ||
				!layerTexture ||
				!captureTexture
			) {
				const addSegmentPass = (
					name: string,
					segmentElements: AnyArtObject[],
				): void => {
					graph.addPass(name, {
						reads: [prebufHandle],
						writes: [prebufHandle],
						scratchAttachments: [stencilHandle],
						execute: (ctx) =>
							withGraphContext(ctx, () => {
								let pass = startNewPass(false);
								this.runBatcher.setBatching(true);
								pass = this.renderElements(
									pass,
									segmentElements,
									filteredTextures,
									elementsMap,
									layerPlan.opacity,
									null,
									backdropElementIds,
									"main",
									mainCompositeContext,
									localBoundsCache,
								);
								this.runBatcher.setBatching(false);
								pass.end();
							}),
					});
				};
				for (const passSegment of segments) {
					if (
						passSegment.elements.length > 0 &&
						anyElementOnScreen(passSegment.elements)
					) {
						// Joins the open run instead of opening a pass of its own.
						pendingRuns.push({
							elements: passSegment.elements,
							opacity: layerPlan.opacity,
						});
					}
					const segBreak = passSegment.breakAfter;
					if (!segBreak) continue;
					// A break needs the preceding work on the surface before it
					// reads or replaces it, so the run has to close here.
					flushPendingRuns();
					if (segBreak.kind === "backdrop") {
						addBackdropPass(
							segBreak.entry,
							prebufHandle,
							layerPlan.opacity,
							true,
						);
						continue;
					}
					// The break element renders alone: renderElements takes the
					// same offscreen-composite route it takes mid-run, so the
					// pass boundary lands exactly at the declared break. Off
					// screen it renders nothing, so the pass it would render
					// alone in is not worth opening either.
					const breakElement = elementsMap.get(segBreak.elementId);
					if (breakElement && anyElementOnScreen([breakElement])) {
						addSegmentPass(
							segBreak.kind === "inlineBackdropCompose"
								? "Inline Backdrop Compose"
								: "Composite Element",
							[breakElement],
						);
					}
				}
				continue;
			}

			// A compositing layer snapshots the prebuf as its base, so every
			// plain layer queued before it has to be on that surface first.
			flushPendingRuns();

			// A layer with nothing on screen composites a cleared texture over
			// the prebuf, which is a no-op costing five passes and two
			// full-surface copies. Measured while panning, all 19 of this
			// label's passes a frame drew nothing. Its breaks go with it: a
			// break element that never renders never breaks anything.
			const compositingLayerElements = segments.flatMap((segment) => {
				const segBreak = segment.breakAfter;
				const breakElement =
					segBreak && segBreak.kind !== "backdrop"
						? elementsMap.get(segBreak.elementId)
						: segBreak?.kind === "backdrop"
							? segBreak.entry.element
							: undefined;
				return breakElement
					? [...segment.elements, breakElement]
					: segment.elements;
			});
			if (!anyElementOnScreen(compositingLayerElements)) continue;

			// Compositing layer — the procedural path's five stages spelled
			// out as passes: base snapshot, content (clear + segments),
			// capture, composite. The fifth stage (main-pass rebinding)
			// dissolves into each subsequent pass's own setup.
			const canvasBaseTexture = this.compositeState.canvasBaseTexture!;
			graph.addPass("Layer Base Snapshot", {
				reads: [prebufHandle],
				writes: [canvasBaseHandle!],
				execute: (ctx) => {
					ctx.encoder.copyTextureToTexture(
						{ texture: ctx.get(prebufHandle) },
						{ texture: ctx.get(canvasBaseHandle!) },
						{
							width: prebufWidth,
							height: prebufHeight,
							depthOrArrayLayers: 1,
						},
					);
				},
			});

			let layerPassSeq = 0;
			const startLayerPass = (
				clear: boolean,
				timed = true,
			): GPURenderPassEncoder => {
				const ctx = activeGraphContext;
				if (!ctx) {
					throw new Error("CanvasLayer: layer pass opened outside FrameGraph");
				}
				const pass = ctx.encoder.beginRenderPass({
					label: "Layer Composite Source Pass",
					colorAttachments: [
						{
							view: ctx.view(layerTextureHandle!),
							clearValue: { r: 0, g: 0, b: 0, a: 0 },
							loadOp: clear ? "clear" : "load",
							storeOp: "store",
						},
					],
					depthStencilAttachment: createPassLocalStencilAttachment(
						ctx.scratchView(stencilHandle),
					),
					timestampWrites: timed
						? profiler?.timestampWrites(`LayerComposite #${layerPassSeq++}`)
						: undefined,
				});
				pass.setPipeline(this.strokePipeline);
				pass.setBindGroup(0, this.viewportBinding.active);
				pass.setBindGroup(1, this.transformsBindGroup!);
				pass.setBindGroup(2, this.dummyGradientBindGroup);
				pass.setBindGroup(3, this.renderState.currentMaskBindGroup);
				return pass;
			};
			const layerCompositeContext: CompositeRenderContext = {
				get encoder() {
					if (!activeGraphContext) {
						throw new Error(
							"CanvasLayer: composite encoded outside FrameGraph",
						);
					}
					return activeGraphContext.encoder;
				},
				get targetTexture() {
					if (!activeGraphContext) {
						throw new Error(
							"CanvasLayer: composite encoded outside FrameGraph",
						);
					}
					return activeGraphContext.get(layerTextureHandle!);
				},
				restartPass: () => startLayerPass(false),
				get baseTexture() {
					if (!activeGraphContext) {
						throw new Error(
							"CanvasLayer: composite encoded outside FrameGraph",
						);
					}
					return activeGraphContext.get(canvasBaseHandle!);
				},
			};

			// Unconditional clear so an all-empty layer still composites a
			// cleared texture — the graph mirror of the procedural path's
			// first startLayerPass(true).
			graph.addPass("Layer Clear", {
				reads: [],
				writes: [layerTextureHandle!],
				scratchAttachments: [stencilHandle],
				execute: (ctx) =>
					withGraphContext(ctx, () => {
						// Untimed: a draw-free clear pass yields begin/end timestamps
						// in reverse order on some GPUs, producing negative durations.
						startLayerPass(true, false).end();
					}),
			});
			const addContentPass = (
				name: string,
				segmentElements: AnyArtObject[],
			): void => {
				graph.addPass(name, {
					// Blend elements inside the layer sample the canvas-base
					// snapshot; composite intermediates read back the prebuf.
					reads: [prebufHandle, canvasBaseHandle!],
					writes: [layerTextureHandle!],
					scratchAttachments: [stencilHandle],
					execute: (ctx) =>
						withGraphContext(ctx, () => {
							let pass = startLayerPass(false);
							this.runBatcher.setBatching(true);
							pass = this.renderElements(
								pass,
								segmentElements,
								filteredTextures,
								elementsMap,
								1.0,
								null,
								backdropElementIds,
								"main",
								layerCompositeContext,
								localBoundsCache,
							);
							this.runBatcher.setBatching(false);
							pass.end();
						}),
				});
			};
			for (const passSegment of segments) {
				if (
					passSegment.elements.length > 0 &&
					anyElementOnScreen(passSegment.elements)
				) {
					addContentPass("Layer Content", passSegment.elements);
				}
				const segBreak = passSegment.breakAfter;
				if (!segBreak) continue;
				if (segBreak.kind === "backdrop") {
					addBackdropPass(segBreak.entry, layerTextureHandle!, 1.0, false);
					continue;
				}
				const breakElement = elementsMap.get(segBreak.elementId);
				if (breakElement && anyElementOnScreen([breakElement])) {
					addContentPass(
						segBreak.kind === "inlineBackdropCompose"
							? "Inline Backdrop Compose"
							: "Composite Element",
						[breakElement],
					);
				}
			}

			graph.addPass("Layer Capture", {
				reads: [prebufHandle],
				writes: [captureHandle!],
				execute: (ctx) => {
					ctx.encoder.copyTextureToTexture(
						{ texture: ctx.get(prebufHandle) },
						{ texture: ctx.get(captureHandle!) },
						{
							width: prebufWidth,
							height: prebufHeight,
							depthOrArrayLayers: 1,
						},
					);
				},
			});

			graph.addPass("Layer Composite", {
				reads: [layerTextureHandle!, captureHandle!],
				writes: [prebufHandle],
				scratchAttachments: [stencilHandle],
				execute: (ctx) =>
					withGraphContext(ctx, () => {
						const pass = startNewPass(false);
						const fullBounds = this.elements.getCurrentRenderTargetBounds();
						if (fullBounds) {
							const source = createCompositeSourceSurface(
								ctx.get(layerTextureHandle!),
								{
									kind: "world-aabb",
									bounds: fullBounds,
									uvRect: FULL_BLIT_UV_RECT,
								},
							);
							this.composite.compositeSurfaceToCanvas({
								passEncoder: pass,
								source,
								backdrop: createBlendBackdrop(
									ctx.get(captureHandle!),
									undefined,
									source.placement,
								),
								blendMode: layerPlan.blendMode,
								placementOpacity: createPlacementOpacity(layerPlan.opacity),
							});
						}
						pass.end();
					}),
			});
		}

		// The document can end on plain layers, whose run is still open.
		flushPendingRuns();

		graph.addPass("Batched Fill Upload", {
			reads: [],
			writes: [],
			// A queue.writeBuffer for every fill draw the layer passes
			// recorded — no texture IO, but the frame is blank without it.
			neverCull: true,
			execute: encodeFillBatchUpload,
		});
		if (
			captureHandle &&
			(this.renderState.editingScopeStack.length > 0 ||
				this.renderState.isolatedElementId)
		) {
			graph.addPass("Isolation Dim", {
				// Snapshots the prebuf into the capture texture, then redraws
				// the dimmed scene plus the editing subtree back over it.
				reads: [prebufHandle, captureHandle],
				writes: [prebufHandle, captureHandle],
				scratchAttachments: [stencilHandle],
				neverCull: true,
				execute: (ctx) =>
					withGraphContext(ctx, () =>
						this.encodeIsolationDim({
							encoder: ctx.encoder,
							elementsMap,
							transientElements,
							filteredTextures,
							localBoundsCache,
							prebufTexture: ctx.get(prebufHandle),
							mainCompositeContext,
							startNewPass,
						}),
					),
			});
		}
		graph.addPass("Backdrop Flush", {
			reads: [prebufHandle],
			writes: [prebufHandle],
			// The drivers decide at execute time whether any glass extrude
			// still needs its backdrop warped.
			neverCull: true,
			execute: encodeBackdropFlush,
		});
		graph.addPass("Final Blit", {
			reads: [prebufHandle],
			writes: [fg.renderTarget],
			scratchAttachments: [finalStencilHandle],
			// Also restores the real viewport after the frame's passes.
			neverCull: true,
			execute: encodeFinalBlit,
		});

		// Snapshot the completed prebuf into the persistent cache so a later
		// viewport-only frame can blit + reproject it instead of re-rendering.
		// Reads prebuf (ordered after every prebuf write); the copy runs outside
		// any render pass. prebufBounds binds during the Canvas Clear pass, so it
		// is set by the time this executes.
		if (this.captureCompositeFrameThisFrame) {
			this.ensureCompositeFrameTexture(prebufWidth, prebufHeight);
			graph.addPass("Capture Composite Frame", {
				reads: [prebufHandle],
				writes: [],
				neverCull: true,
				execute: (ctx) => {
					const cacheTex = this.compositeFrameCache.texture;
					if (!cacheTex || !prebufBounds) {
						this.compositeFrameCache.valid = false;
						return;
					}
					ctx.encoder.copyTextureToTexture(
						{ texture: ctx.get(prebufHandle) },
						{ texture: cacheTex },
						{ width: prebufWidth, height: prebufHeight },
					);
					this.compositeFrameCache.worldBounds = prebufBounds;
					this.compositeFrameCache.clearColor = clearColor;
					this.compositeFrameCache.dotGrid = dotGridBackground;
					this.compositeFrameCache.valid = true;
				},
			});
		}
		return filteredTextures;
	}

	/** Ensure the composite-frame cache texture matches the prebuf size. */
	private ensureCompositeFrameTexture(width: number, height: number): void {
		const cache = this.compositeFrameCache;
		if (cache.texture && cache.width === width && cache.height === height) {
			return;
		}
		this.offscreen.deferDestroy(cache.texture);
		cache.texture = this.device.createTexture({
			label: "Composite Frame Cache",
			size: { width, height },
			format: this.canvasFormat,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		cache.width = width;
		cache.height = height;
		// The freshly allocated texture holds no captured frame yet.
		cache.valid = false;
	}

	/**
	 * Blit the cached composite frame reprojected through the current viewport,
	 * skipping the document render entirely. Used for viewport-only interaction
	 * frames (pan/zoom gesture). The blit shader maps the cached world bounds to
	 * NDC via the live viewport uniforms, so pan/zoom/rotation all reproject for
	 * free; the overlay layer re-renders separately so gizmos stay crisp.
	 */
	private renderViewportBlit(
		encoder: GPUCommandEncoder,
		canvasTexture: GPUTexture,
		profiler?: GPUTimingProfiler | null,
	): CanvasFrameTransaction | null {
		const cache = this.compositeFrameCache;
		const viewport = this.viewportState.current;
		if (!cache.texture || !cache.worldBounds || !viewport) return null;

		const realCanvasWidth = this.viewportState.width;
		const realCanvasHeight = this.viewportState.height;

		// The orchestrator already applied the current viewport via
		// updateViewport; sync the GPU uniform buffer so the blit reprojects the
		// cached world bounds through the live pan/zoom/rotation.
		this.restoreViewportUniformsToGPU();

		const graph = new FrameGraph();
		const renderTarget = graph.importTexture(canvasTexture, "render-target");
		this.cache.ensureFinalBlitStencilTexture(realCanvasWidth, realCanvasHeight);
		const finalStencilHandle = graph.importScratchAttachment(
			this.compositeState.finalBlitStencil.texture!,
			"final-blit-stencil",
		);
		graph.addPass("Viewport Blit", {
			reads: [],
			writes: [renderTarget],
			scratchAttachments: [finalStencilHandle],
			neverCull: true,
			execute: (ctx) => {
				const pass = ctx.encoder.beginRenderPass({
					label: "Viewport Blit Pass",
					colorAttachments: [
						{
							view: ctx.view(renderTarget),
							clearValue: cache.clearColor,
							loadOp: "clear",
							storeOp: "store",
						},
					],
					depthStencilAttachment: createPassLocalStencilAttachment(
						ctx.scratchView(finalStencilHandle),
					),
					timestampWrites: profiler?.timestampWrites("Viewport Blit"),
				});
				// The cached prebuf is transparent; reproduce the final-blit
				// background (dot grid drawn behind, then the cached content).
				if (cache.dotGrid) {
					this.drawDotGridBackground(
						pass,
						realCanvasWidth,
						realCanvasHeight,
						viewport,
					);
				}
				this.composite.blitTextureToCanvas(
					pass,
					cache.texture!,
					cache.worldBounds!,
					1.0,
				);
				pass.end();
			},
		});
		return this.executeFrame(graph, encoder, new Map());
	}

	/**
	 * Composite-level editing isolation dim, declared as the "Isolation Dim"
	 * graph pass. Extracted from renderDocument so the 175-line body reads as
	 * one named unit; its frame-local inputs arrive through {@link ctx}.
	 */
	private encodeIsolationDim(ctx: IsolationDimContext): void {
		// Composite-level editing isolation dimming (editing scope / reference3d
		// edit): dim everything, then re-render the editing subtree at full
		// opacity on top.
		const editingScopeId = this.renderState.editingScopeStack.at(-1);
		if (
			(editingScopeId || this.renderState.isolatedElementId) &&
			this.viewportState.bounds &&
			this.compositeState.captureTexture
		) {
			const scopeElement = editingScopeId
				? ctx.elementsMap.get(editingScopeId)
				: undefined;
			const isolatedElement = this.renderState.isolatedElementId
				? ctx.elementsMap.get(this.renderState.isolatedElementId)
				: undefined;
			const scopedLayer = this.activeDocument?.layers.find(
				(layer) => layer.id === editingScopeId,
			);
			const isPatternEditScopedLayer =
				scopedLayer?.transientKind === TRANSIENT_LAYER_KIND.PATTERN_EDIT;
			const scopedTransientElements =
				isPatternEditScopedLayer && scopedLayer && ctx.transientElements
					? [...ctx.transientElements.values()]
							.filter(
								({ layerId, topLevel }) =>
									topLevel !== false && layerId === scopedLayer.id,
							)
							.map(({ element }) => element)
					: [];
			if (scopedLayer || isolatedElement || scopeElement) {
				// Capture current canvas (full-opacity render)
				const capture = this.compositeState.captureTexture;
				ctx.encoder.copyTextureToTexture(
					{ texture: ctx.prebufTexture },
					{ texture: capture },
					{
						width: this.viewportState.width,
						height: this.viewportState.height,
						depthOrArrayLayers: 1,
					},
				);

				// Clear canvas to the background, then reintroduce the captured
				// scene with the isolation dim opacity. Pattern-edit fully hides
				// the captured scene so only the working cell and neighbor previews
				// are redrawn in the second pass below.

				let dimPass = ctx.startNewPass(true);
				this.composite.blitTextureToCanvas(
					dimPass,
					capture,
					this.elements.getCurrentRenderTargetBounds()!,
					isPatternEditScopedLayer ? 0 : 0.3,
				);

				// Restore stroke pipeline state for element rendering
				dimPass.setPipeline(this.strokePipeline);
				dimPass.setBindGroup(0, this.viewportBinding.active);
				dimPass.setBindGroup(1, this.transformsBindGroup!);
				dimPass.setBindGroup(2, this.dummyGradientBindGroup);
				dimPass.setBindGroup(3, this.dummyMaskBindGroup);

				// Opacity of ancestors above the editing container; the container's
				// own opacity is applied per-element by renderElements below.
				let ancestorOpacity = 1.0;
				for (const stackId of this.renderState.editingScopeStack) {
					if (stackId === editingScopeId) continue;
					const g = ctx.elementsMap.get(stackId);
					if (g) ancestorOpacity *= g.opacity ?? 1.0;
				}

				if (scopedLayer) {
					if (scopedTransientElements.length > 0) {
						dimPass = this.renderElements(
							dimPass,
							scopedTransientElements,
							ctx.filteredTextures,
							ctx.elementsMap,
							1.0,
							null,
							undefined,
							"main",
							ctx.mainCompositeContext,
							ctx.localBoundsCache,
						);
					}
					const scopedElements = scopedLayer.elementIds
						.map((id) => ctx.elementsMap.get(id))
						.filter((el): el is AnyArtObject => el !== undefined);
					dimPass = this.renderElements(
						dimPass,
						scopedElements,
						ctx.filteredTextures,
						ctx.elementsMap,
						1.0,
						null,
						undefined,
						"main",
						ctx.mainCompositeContext,
						ctx.localBoundsCache,
					);
				} else if (isolatedElement) {
					// Reference3D edit isolation: only the edited element pops back to
					// full opacity (composed with its ancestor groups' opacity).
					dimPass = this.renderIsolatedElementPass(
						dimPass,
						isolatedElement,
						ctx.filteredTextures,
						ctx.elementsMap,
						ctx.mainCompositeContext,
						ctx.localBoundsCache,
					);
				} else if (scopeElement && isGroup(scopeElement)) {
					// Re-render the group's children at full opacity (dimmed only by
					// the group's own + ancestor opacity; each child's opacity is
					// applied by renderElements).
					const children = scopeElement.childIds
						.filter((id) => id !== scopeElement.clipPathId)
						.map((id) => ctx.elementsMap.get(id))
						.filter((el): el is AnyArtObject => el !== undefined);
					const parentTransform =
						this.viewportManager
							.getComposedTransformCache()
							.get(scopeElement.id) ?? null;
					dimPass = this.renderElements(
						dimPass,
						children,
						ctx.filteredTextures,
						ctx.elementsMap,
						ancestorOpacity * (scopeElement.opacity ?? 1.0),
						parentTransform,
						undefined,
						"main",
						ctx.mainCompositeContext,
						ctx.localBoundsCache,
					);
				} else if (
					scopeElement &&
					(isBlend(scopeElement) || isCompoundPath(scopeElement))
				) {
					// Blend / compound path: its sources are absorbed and not
					// standalone elements, so re-render the element itself —
					// its renderer draws the sources and intermediates. Draw position
					// comes from the element's transform index, so no parent transform
					// is needed here.
					dimPass = this.renderElements(
						dimPass,
						[scopeElement],
						ctx.filteredTextures,
						ctx.elementsMap,
						ancestorOpacity,
						null,
						undefined,
						"main",
						ctx.mainCompositeContext,
						ctx.localBoundsCache,
					);
				} else if (scopeElement) {
					// Single-element scope (path, image, text, …): same isolation
					// treatment as the reference3d isolated element.
					dimPass = this.renderIsolatedElementPass(
						dimPass,
						scopeElement,
						ctx.filteredTextures,
						ctx.elementsMap,
						ctx.mainCompositeContext,
						ctx.localBoundsCache,
					);
				}
				dimPass.end();
				this.elements.flushFillBatch();
			}
		}
	}

	/** Rasterization scale for filter offscreen passes, derived from the
	 * document's rasterizationDpi (72 DPI = 1 texel per world px). Fixed
	 * regardless of viewport zoom / display DPI / export scale so filter
	 * results stay stable. */
	private getRasterScale(): number {
		return (this.activeDocument?.rasterizationDpi ?? 72) / 72;
	}

	/**
	 * Execute GPU filter rendering for elements identified in the frame plan.
	 * Iterates layerPlans in order so filter rendering maintains correct layer ordering.
	 *
	 * For elements with `allAppearancePlans`, each appearance is rendered
	 * individually in array order, sub-filters applied per-appearance, and
	 * results composited into an accumulator texture. Element-level
	 * post-filters are applied to the final composite.
	 */
	private executeFilterPlans(
		encoder: GPUCommandEncoder,
		filteredTextures: Map<string, FilteredTextureInfo>,
		framePlan: FramePlan,
		selectedPlans?: readonly ElementFilterPlan[],
	): void {
		const { elementsMap, filterPlans, layerPlans } = framePlan;
		const rasterScale = this.getRasterScale();
		const plans =
			selectedPlans ??
			layerPlans.flatMap((layerPlan) =>
				layerPlan.elements.flatMap((element) => {
					const plan = filterPlans.get(element.id);
					return plan ? [plan] : [];
				}),
			);

		for (const fp of plans) {
			const element = fp.element;

			if (fp.allAppearancePlans) {
				// Per-appearance accumulator path: each appearance rendered
				// individually in array order with sub-filters applied.
				this.executePerAppearanceFilterPlan(
					encoder,
					filteredTextures,
					fp,
					elementsMap,
					rasterScale,
				);
				continue;
			}

			// A chain led by a source-ignoring filter (e.g. extrude3d) builds
			// its own self-sized output purely from element/scene geometry and
			// never reads the element's rasterized flat look — rendering that
			// flat look first would be pure waste (and it scales with the
			// filter's own expansion margin, e.g. extrude depth). Skip it and
			// hand applyFilters a throwaway placeholder instead.
			const firstPostFilter = fp.postFilters[0];
			const firstHandler = firstPostFilter
				? this.filterRenderer.getHandler(firstPostFilter.processor)
				: undefined;
			const rendersOwnSource =
				!!firstPostFilter &&
				!resolveRenderConfigure(firstHandler, firstPostFilter)
					.needsSourceTexture;

			// fp.textureBounds is fp.bounds expanded symmetrically by the filter
			// margin; recover that scalar so the offscreen bake can clamp to
			// (viewport + margin) without clipping the filter's bleed.
			const fpFilterMargin = (fp.textureBounds.width - fp.bounds.width) / 2;
			const offscreenResult = rendersOwnSource
				? null
				: isGroup(element)
					? this.offscreen.renderGroupToTexture(
							encoder,
							element,
							fp.textureBounds,
							elementsMap,
							this.viewportManager.getBoundsCache(),
							rasterScale,
							fpFilterMargin,
						)
					: this.offscreen.renderElementToTexture(
							encoder,
							element,
							fp.textureBounds,
							elementsMap,
							rasterScale,
							selectedPlans !== undefined,
							fpFilterMargin,
						);

			if (!rendersOwnSource && !offscreenResult) continue;
			if (!this.filterRenderer) continue;

			// Geometry filters build + bake their own solid inside postProcess;
			// give them the element/scene access and appearance scope they need.
			const geometry: FilterGeometryContext | undefined = rendersOwnSource
				? {
						element,
						elementsMap,
						compoundPathCache: this.cacheManager.compoundPath,
						getParentGroupMap: () => this.viewportManager.getParentGroupMap(),
						resolvePatternTexture: (defId) => this.resolvePatternTexture(defId),
						renderElementToTexture: (enc, el, bounds, map, scale) =>
							this.offscreen.renderElementToTexture(
								enc,
								el,
								bounds,
								map,
								scale,
								true,
							),
						texturePool: this.texturePool,
						resolveTextOutline: (el) => this.resolveTextOutline(el),
						requestTextOutline: (el) => this.requestTextOutline(el),
						isImageReady: (fileUid) =>
							this.assetState.imageTextureCache.has(fileUid),
					}
				: undefined;

			const sourceTexture = rendersOwnSource
				? this.texturePool.acquire(
						1,
						1,
						this.canvasFormat,
						1,
						GPUTextureUsage.TEXTURE_BINDING |
							GPUTextureUsage.COPY_SRC |
							GPUTextureUsage.COPY_DST,
						"Filter Placeholder Source",
					)
				: // biome-ignore lint/style/noNonNullAssertion: guarded above.
					offscreenResult!.texture.texture;

			// The viewport clamp can bake only a sub-rect of the element; hand
			// world-anchoring filters (e.g. hk:paper-v2 fibers) the full element
			// rect plus the bake's offset within it so their output stays fixed
			// to the element instead of the displayed region.
			const bakedBounds = rendersOwnSource
				? fp.textureBounds
				: // biome-ignore lint/style/noNonNullAssertion: guarded above.
					brandWorldBBox(offscreenResult!.placement.bounds);
			const { texture: filteredTexture, overrides } =
				this.filterRenderer.applyFilters(
					sourceTexture,
					fp.postFilters,
					encoder,
					undefined,
					rendersOwnSource ? rasterScale : offscreenResult!.effectiveZoom,
					// The bake may be clamped smaller than fp.textureBounds, so the
					// filter must scale against the actual baked coverage.
					bakedBounds,
					geometry
						? { elementId: element.id, cache: this.cacheManager.appearance }
						: undefined,
					geometry,
					undefined,
					{
						worldSize: {
							width: fp.textureBounds.width,
							height: fp.textureBounds.height,
						},
						sourceOffset: {
							x: bakedBounds.minX - fp.textureBounds.minX,
							y: fp.textureBounds.maxY - bakedBounds.maxY,
						},
					},
				);

			if (rendersOwnSource && !overrides) {
				// The leading filter produced nothing (e.g. an extrude
				// appearance with depth 0) — draw nothing for this element,
				// matching its already-suppressed flat look.
				this.offscreen.deferDestroy(sourceTexture);
				continue;
			}

			const sourceRef = rendersOwnSource
				? createFrameTextureRef(sourceTexture, (texture) =>
						this.offscreen.deferDestroy(texture),
					)
				: // biome-ignore lint/style/noNonNullAssertion: guarded above.
					offscreenResult!.texture;
			const outputBounds = rendersOwnSource
				? fp.bounds
				: // biome-ignore lint/style/noNonNullAssertion: guarded above.
					offscreenResult!.placement.bounds;
			const outputUvRect = rendersOwnSource
				? FULL_BLIT_UV_RECT
				: // biome-ignore lint/style/noNonNullAssertion: guarded above.
					offscreenResult!.placement.uvRect;
			filteredTextures.set(element.id, {
				source: createRenderSurface(
					sourceRef,
					{
						kind: "world-aabb",
						bounds: outputBounds,
						uvRect: outputUvRect,
					},
					{
						role: "color",
						alphaMode: "premultiplied",
						opacityState: "intrinsic",
					},
				),
				output: createRenderSurface(
					filteredTexture === sourceTexture
						? sourceRef
						: createBorrowedTextureRef(filteredTexture, "external"),
					{
						kind: "world-aabb",
						bounds: outputBounds,
						uvRect: outputUvRect,
					},
					{
						role: "color",
						alphaMode: "premultiplied",
						opacityState: "intrinsic",
					},
				),
				elementBounds: fp.bounds,
				textureBounds: fp.textureBounds,
				overrideLayers: overrides,
			});
		}
	}

	/**
	 * Bake every Repeat element's source subtree once and register one blit layer
	 * per computed instance. The source elements are absorbed (not in any
	 * layer.elementIds), so they reach the canvas only through here: the shared
	 * bake texture is blitted at each instance's world-space quad via the same
	 * `overrideLayers` path a self-sized extrude appearance uses.
	 */
	private bakeRepeats(
		encoder: GPUCommandEncoder,
		filteredTextures: Map<string, FilteredTextureInfo>,
		framePlan: FramePlan,
	): void {
		const { elementsMap, layerPlans } = framePlan;
		const rasterScale = this.getRasterScale();
		const boundsCache = this.viewportManager.getBoundsCache();
		for (const layerPlan of layerPlans) {
			for (const element of layerPlan.elements) {
				if (!isRepeat(element)) continue;
				const info = this.bakeRepeat(
					encoder,
					element,
					elementsMap,
					rasterScale,
					boundsCache,
					filteredTextures,
				);
				if (info) filteredTextures.set(element.id, info);
			}
		}
	}

	private bakeRepeat(
		encoder: GPUCommandEncoder,
		repeat: RepeatObject,
		elementsMap: Map<string, AnyArtObject>,
		rasterScale: number,
		boundsCache: LocalBoundsCache,
		filteredTextures: Map<string, FilteredTextureInfo>,
	): FilteredTextureInfo | null {
		// World union of the source elements — the region the bake covers and the
		// pivot the radial ring / mirror axis are measured from. Shared with the
		// bounds / hit-test path so all three agree on the source box and center.
		const union = calculateRepeatSourceUnion(repeat, elementsMap, boundsCache);
		if (!union || union.width <= 0 || union.height <= 0) return null;
		const unionBounds = brandWorldBBox(union);

		// Bake the sources through a throwaway group so their own transforms and
		// nested structure render exactly as authored. skipCull keeps a source that
		// sits off-screen in the bake, so its on-screen instances are not clipped.
		const syntheticGroup: Group = {
			id: `${repeat.id}::src`,
			type: "group",
			childIds: repeat.sourceIds,
			opacity: 1,
			blendMode: "normal",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		};
		const baked = this.offscreen.renderElementToTexture(
			encoder,
			syntheticGroup,
			unionBounds,
			elementsMap,
			rasterScale,
			true,
			null,
			// Source appearances (3D solids, blur, drop shadow) are pre-baked into
			// filteredTextures; hand them to the bake so the sources render their
			// filtered result instead of the bare flat geometry.
			filteredTextures,
		);
		if (!baked) return null;

		const center = {
			x: (union.minX + union.maxX) / 2,
			y: (union.minY + union.maxY) / 2,
		};
		const instances = computeRepeatInstances(repeat, center);
		// The repeat's own transform pivots the whole set around the source center,
		// mirroring how a blend pivots around its own bbox center.
		const repeatAffine = elementTransformToAffine(
			getTransform(repeat),
			center.x,
			center.y,
		);
		// Blit quad corners are TL -> TR -> BR -> BL. World space is Y-up, so the
		// top edge is maxY (matching the extrude bake's quad); ordering the corners
		// with minY on top would flip the texture vertically.
		const cb = baked.placement.bounds;
		const corners = [
			{ x: cb.minX, y: cb.maxY },
			{ x: cb.maxX, y: cb.maxY },
			{ x: cb.maxX, y: cb.minY },
			{ x: cb.minX, y: cb.minY },
		];
		const overrideLayers: BlitLayer[] =
			repeat.mode === "grid"
				? this.buildClippedGridLayers(repeat, union, cb, baked, repeatAffine)
				: instances.map((inst) => {
						const m = composeAffine(repeatAffine, inst);
						const quad: BlitQuad = [
							applyAffineToPoint(m, corners[0]),
							applyAffineToPoint(m, corners[1]),
							applyAffineToPoint(m, corners[2]),
							applyAffineToPoint(m, corners[3]),
						];
						return createRenderSurface(
							createBorrowedTextureRef(baked.texture.texture, "external"),
							{
								kind: "world-quad",
								bounds: cb,
								uvRect: baked.placement.uvRect,
								quad,
							},
							{
								role: "color",
								alphaMode: "premultiplied",
								opacityState: "intrinsic",
							},
						);
					});

		return {
			source: baked,
			output: baked,
			elementBounds: unionBounds,
			textureBounds: unionBounds,
			overrideLayers,
		};
	}

	/**
	 * Grid instances clipped to the fill region: each tile is intersected with the
	 * region (axis-aligned in the source's authored space, where grid instances
	 * are pure translations), producing a partially-visible copy at the region
	 * edge instead of a whole-copy step. The clipped rect's UV sub-range is taken
	 * from the bake, then the rect is transformed to a world quad.
	 */
	private buildClippedGridLayers(
		repeat: RepeatObject,
		union: BoundingBox,
		cb: BoundingBox,
		baked: RenderSurface,
		repeatAffine: Affine2D,
	): BlitLayer[] {
		const tileW = cb.maxX - cb.minX;
		const tileH = cb.maxY - cb.minY;
		if (tileW <= 0 || tileH <= 0) return [];
		const region = repeatGridRegion(repeat, union);
		const center = {
			x: (union.minX + union.maxX) / 2,
			y: (union.minY + union.maxY) / 2,
		};
		const uv = baked.placement.uvRect;
		const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
		const layers: BlitLayer[] = [];
		for (const inst of computeRepeatInstances(repeat, center)) {
			// Grid instances are pure translations; e/f carry the tile offset.
			const tMinX = cb.minX + inst.e;
			const tMaxX = cb.maxX + inst.e;
			const tMinY = cb.minY + inst.f;
			const tMaxY = cb.maxY + inst.f;
			const cxMin = Math.max(tMinX, region.minX);
			const cxMax = Math.min(tMaxX, region.maxX);
			const cyMin = Math.max(tMinY, region.minY);
			const cyMax = Math.min(tMaxY, region.maxY);
			if (cxMax <= cxMin || cyMax <= cyMin) continue; // fully outside region
			// V grows downward from the tile top (maxY), matching the bake's corner
			// order (TL = maxY -> minV).
			const uvRect: BlitUVRect = {
				minU: lerp(uv.minU, uv.maxU, (cxMin - tMinX) / tileW),
				maxU: lerp(uv.minU, uv.maxU, (cxMax - tMinX) / tileW),
				minV: lerp(uv.minV, uv.maxV, (tMaxY - cyMax) / tileH),
				maxV: lerp(uv.minV, uv.maxV, (tMaxY - cyMin) / tileH),
			};
			const quad: BlitQuad = [
				applyAffineToPoint(repeatAffine, { x: cxMin, y: cyMax }),
				applyAffineToPoint(repeatAffine, { x: cxMax, y: cyMax }),
				applyAffineToPoint(repeatAffine, { x: cxMax, y: cyMin }),
				applyAffineToPoint(repeatAffine, { x: cxMin, y: cyMin }),
			];
			layers.push(
				createRenderSurface(
					createBorrowedTextureRef(baked.texture.texture, "external"),
					{
						kind: "world-quad",
						bounds: aabbOfQuad(quad),
						uvRect,
						quad,
					},
					{
						role: "color",
						alphaMode: "premultiplied",
						opacityState: "intrinsic",
					},
				),
			);
		}
		return layers;
	}

	/**
	 * Multiply each deferred `ArtObject.mask` into its element's texture, after
	 * {@link executeFilterPlans} has produced one.
	 *
	 * Elements without a filter plan have no texture yet, so they are baked
	 * here first. The bake still carries any inherited clip mask through BG3,
	 * which is why an element can end up wearing both masks even though the
	 * GPU transform buffer only has room for one.
	 */
	private applyPostMasks(
		encoder: GPUCommandEncoder,
		filteredTextures: Map<string, FilteredTextureInfo>,
		elementsMap: Map<string, AnyArtObject>,
	): void {
		if (this.activeMaskApplicationPlans.size === 0) return;
		const boundsContext = this.maskBoundsContext;
		if (!boundsContext) return;
		const rasterScale = this.getRasterScale();

		for (const [elementId, plan] of this.activeMaskApplicationPlans) {
			if (plan.kind !== "subtree-composite") continue;
			const element = elementsMap.get(elementId);
			if (!element) continue;

			for (const planned of plan.masks) {
				const mask = this.maskEntriesByKey.get(planned.key);
				if (!mask) continue;
				let existing = filteredTextures.get(elementId);
				if (existing?.overrideLayers) {
					// Self-sized layers (extrude solids) are blitted one by one, so the
					// mask goes into each of them rather than into one combined texture.
					filteredTextures.set(elementId, {
						...existing,
						overrideLayers: existing.overrideLayers.map((layer) => {
							let sourceSurface: RenderSurface = layer;
							if (layer.placement.kind === "world-quad") {
								const flattened = this.offscreen.bakeQuadToTexture(
									encoder,
									layer,
								);
								if (!flattened) return layer;
								sourceSurface = replaceRenderSurface(sourceSurface, flattened);
							}

							const masked = this.offscreen.applyWorldMaskToTexture(
								encoder,
								sourceSurface,
								mask,
								this.getRasterScale(),
							);
							if (!masked) {
								return {
									...sourceSurface,
									opacity: layer.opacity,
									coverage: layer.coverage,
								};
							}
							sourceSurface = replaceRenderSurface(sourceSurface, masked);
							return {
								...sourceSurface,
								opacity: layer.opacity,
								coverage: layer.coverage,
							};
						}),
					});
					continue;
				}

				if (!existing) {
					const bounds = brandWorldBBox(
						computeWorldBounds(
							element,
							boundsContext,
							resolveParentGroupMap(boundsContext),
						),
					);
					const baked = isGroup(element)
						? this.offscreen.renderGroupToTexture(
								encoder,
								element,
								bounds,
								elementsMap,
								this.viewportManager.getBoundsCache(),
								rasterScale,
							)
						: this.offscreen.renderElementToTexture(
								encoder,
								element,
								bounds,
								elementsMap,
								rasterScale,
							);
					if (!baked) continue;
					existing = {
						source: baked,
						output: baked,
						elementBounds: bounds,
						textureBounds: bounds,
					};
				}

				const masked = this.offscreen.applyWorldMaskToTexture(
					encoder,
					existing.output,
					mask,
					this.getRasterScale(),
				);
				if (!masked) continue;

				filteredTextures.set(elementId, {
					...existing,
					output: replaceRenderSurface(existing.output, masked),
				});
			}
		}
	}

	/**
	 * Render each appearance individually in filters-array order, apply
	 * per-appearance sub-filters, composite into an accumulator texture,
	 * then apply element-level post-filters to the final composite.
	 */
	private executePerAppearanceFilterPlan(
		encoder: GPUCommandEncoder,
		filteredTextures: Map<string, FilteredTextureInfo>,
		fp: ElementFilterPlan,
		elementsMap: Map<string, AnyArtObject>,
		rasterScale: number,
	): void {
		const plans = fp.allAppearancePlans!;

		// Collect pre-filters (geometry deformations like zigzag) to apply
		// to each isolated appearance.
		const preFilters = (fp.element.filters ?? []).filter((f) =>
			isGeometryFilter(f, this.filterRenderer),
		);

		// Create accumulator texture at element-level textureBounds size.
		const maxDim = this.device.limits.maxTextureDimension2D;
		let accWidth = Math.min(
			Math.ceil(fp.textureBounds.width * rasterScale),
			maxDim,
		);
		let accHeight = Math.min(
			Math.ceil(fp.textureBounds.height * rasterScale),
			maxDim,
		);
		if (accWidth <= 0 || accHeight <= 0) return;

		const accTexture = this.texturePool.acquire(
			accWidth,
			accHeight,
			this.canvasFormat,
			1,
			GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.COPY_DST,
			"Per-Appearance Accumulator",
		);

		// Texture may be larger than requested due to quantization in pool.
		// All attachments and viewport must use the actual texture dimensions.
		accWidth = accTexture.width;
		accHeight = accTexture.height;

		const accStencilTexture = this.texturePool.acquire(
			accWidth,
			accHeight,
			"depth24plus-stencil8",
			MSAA_SAMPLE_COUNT,
			GPUTextureUsage.RENDER_ATTACHMENT,
			"Per-Appearance Accumulator Stencil",
		);

		// Viewport for blit passes targeting the accumulator
		const effectiveZoom = Math.min(
			accWidth / fp.textureBounds.width,
			accHeight / fp.textureBounds.height,
			rasterScale,
		);
		const accViewport = {
			x: (fp.textureBounds.minX + fp.textureBounds.maxX) / 2,
			y: (fp.textureBounds.minY + fp.textureBounds.maxY) / 2,
			zoom: effectiveZoom,
			rotation: 0,
		};

		for (let i = 0; i < plans.length; i++) {
			const plan = plans[i];

			// Virtual element with element-level pre-filters + per-appearance pre sub-filters + this single appearance
			const virtualElement = {
				...fp.element,
				filters: [...preFilters, ...plan.preSubFilters, plan.appearance],
			} as AnyArtObject;

			// Render to isolated offscreen texture using unified element-level
			// bounds so all appearances share the same coordinate space when
			// composited onto the accumulator.
			const appResult = this.offscreen.renderElementToTexture(
				encoder,
				virtualElement,
				fp.textureBounds,
				elementsMap,
				rasterScale,
			);
			if (!appResult) continue;
			const appTexture = appResult.texture.texture;

			// Apply sub-filters if any (same shared encoder)
			if (plan.postSubFilters.length > 0) {
				this.filterRenderer.applyFilters(
					appTexture,
					plan.postSubFilters,
					encoder,
					undefined,
					appResult.effectiveZoom,
					fp.textureBounds,
				);
			}

			// Blit appearance result onto accumulator
			// (appTexture now contains filtered result via copyTextureToTexture)
			const entry = this.uniformScope.acquire(accViewport, accWidth, accHeight);
			this.pushViewportBinding(entry.bindGroup, entry.buffer);

			if (plan.blendMode !== "normal" && i > 0) {
				// Non-normal blend requires reading the accumulator as dest texture.
				// Copy current accumulator state before compositing.
				const accCopy = this.texturePool.acquire(
					accWidth,
					accHeight,
					this.canvasFormat,
					1,
					GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
					"Accumulator Copy for Composite",
				);

				encoder.copyTextureToTexture(
					{ texture: accTexture },
					{ texture: accCopy },
					{ width: accWidth, height: accHeight },
				);

				const compositePass = encoder.beginRenderPass({
					label: `Composite Blit Pass ${i}`,
					colorAttachments: [
						{
							view: accTexture.createView(),
							clearValue: { r: 0, g: 0, b: 0, a: 0 },
							loadOp: i === 0 ? "clear" : "load",
							storeOp: "store",
						},
					],
					depthStencilAttachment: {
						view: accStencilTexture.createView(),
						depthClearValue: 1.0,
						depthLoadOp: "clear",
						depthStoreOp: "discard",
						stencilClearValue: 0,
						stencilLoadOp: "clear",
						stencilStoreOp: "discard",
					},
				});

				const source = createCompositeSourceSurface(appTexture, {
					kind: "world-aabb",
					bounds: appResult.placement.bounds,
					uvRect: appResult.placement.uvRect,
				});
				this.composite.compositeSurfaceToCanvas({
					passEncoder: compositePass,
					source,
					backdrop: createBlendBackdrop(accCopy, undefined, source.placement),
					blendMode: plan.blendMode,
					placementOpacity: createPlacementOpacity(plan.opacity),
					pipeline: this.compositePipeline,
				});

				compositePass.end();
				this.offscreen.deferDestroy(accCopy);
			} else {
				const blitPass = encoder.beginRenderPass({
					label: `Accumulator Blit Pass ${i}`,
					colorAttachments: [
						{
							view: accTexture.createView(),
							clearValue: { r: 0, g: 0, b: 0, a: 0 },
							loadOp: i === 0 ? "clear" : "load",
							storeOp: "store",
						},
					],
					depthStencilAttachment: {
						view: accStencilTexture.createView(),
						depthClearValue: 1.0,
						depthLoadOp: "clear",
						depthStoreOp: "discard",
						stencilClearValue: 0,
						stencilLoadOp: "clear",
						stencilStoreOp: "discard",
					},
				});

				this.composite.blitTextureToCanvas(
					blitPass,
					appTexture,
					appResult.placement.bounds,
					plan.opacity,
					appResult.placement.uvRect,
					this.blitPipeline,
				);

				blitPass.end();
			}
			this.popViewportBinding();
			releaseRenderSurface(appResult);
		}

		// Apply element-level post-filters to the accumulator. Use effectiveZoom
		// (not the raw rasterScale) so applyFilters' contentBounds*zoom matches
		// the accumulator's actual texel size when the GPU limit clamps it.
		if (fp.postFilters.length > 0) {
			this.filterRenderer.applyFilters(
				accTexture,
				fp.postFilters,
				encoder,
				undefined,
				effectiveZoom,
				fp.textureBounds,
			);
		}

		this.offscreen.deferDestroy(accStencilTexture);

		// Compute blit UV rect to crop pool quantization margin.
		const accUsedW = fp.textureBounds.width * effectiveZoom;
		const accUsedH = fp.textureBounds.height * effectiveZoom;
		const accUHalf = accUsedW / (2 * accWidth);
		const accVHalf = accUsedH / (2 * accHeight);
		const accBlitUvRect: BlitUVRect =
			accUsedW >= accWidth && accUsedH >= accHeight
				? FULL_BLIT_UV_RECT
				: {
						minU: 0.5 - accUHalf,
						minV: 0.5 - accVHalf,
						maxU: 0.5 + accUHalf,
						maxV: 0.5 + accVHalf,
					};

		// accTexture contains the final result (applyFilters writes back via copyTextureToTexture)
		const accRef = createFrameTextureRef(accTexture, (texture) =>
			this.offscreen.deferDestroy(texture),
		);
		const accSurface = createRenderSurface(
			accRef,
			{
				kind: "world-aabb",
				bounds: fp.textureBounds,
				uvRect: accBlitUvRect,
			},
			{
				role: "color",
				alphaMode: "premultiplied",
				opacityState: "intrinsic",
			},
		);
		filteredTextures.set(fp.element.id, {
			source: accSurface,
			output: accSurface,
			elementBounds: fp.bounds,
			textureBounds: fp.textureBounds,
		});
	}

	/** Max shared-pyramid blur sigma the element's backdrop filters declare
	 *  (in R texels), so the coordinator plans its batch pyramid deep enough. */
	private getBackdropBlurSigma(bdElem: BackdropElementEntry): number {
		const rasterScale = this.getRasterScale();
		return bdElem.backdropFilters.reduce(
			(max, filter) =>
				Math.max(
					max,
					this.filterRenderer
						.getHandler(filter.processor)
						?.getBackdropBlurSigma?.(filter, rasterScale) ?? 0,
				),
			0,
		);
	}

	/** Texture bounds a backdrop element's filter chain runs over: element
	 *  bounds expanded by the chain's largest expansion margin. */
	private getBackdropTextureBounds(bdElem: BackdropElementEntry): BoundingBox {
		const { bounds, backdropFilters, regularFilters } = bdElem;
		const backdropExpansion = this.filterRenderer.calculateExpansion(
			backdropFilters,
			bounds,
		);
		const regularExpansion = this.filterRenderer.calculateExpansion(
			regularFilters,
			bounds,
		);
		return expandBounds(bounds, Math.max(backdropExpansion, regularExpansion));
	}

	/**
	 * Process a single backdrop filter element (e.g., FrostGlass).
	 * Obtains the element's region from the coordinator's shared fixed-R
	 * capture, applies filters, and blits the result using stencil buffer for
	 * clipping.
	 */
	private processBackdropElement(
		encoder: GPUCommandEncoder,
		backdropViewport: Viewport,
		textureView: GPUTextureView,
		backdropSourceTexture: GPUTexture,
		bdElem: BackdropElementEntry,
		elementsMap: Map<string, AnyArtObject>,
		alphaMultiplier: number,
		stencilView: GPUTextureView,
		backdropRequest?: BackdropEffectRequest,
	): void {
		if (!this.viewportState.current) return;

		// Skip invisible elements
		if (bdElem.element.visible === false) return;

		const { element, backdropFilters, regularFilters } = bdElem;

		// Backdrop filters first, then regular post-filters
		const allFilters =
			regularFilters.length > 0
				? [...backdropFilters, ...regularFilters]
				: backdropFilters;

		// The region comes off a shared fixed-R capture (one per epoch across
		// all backdrop-filter elements); the world-snapped R grid keeps the
		// filters (frost glass, pixelate) invariant to viewport zoom/pan. The
		// planned request is passed through for the coordinator's pending-union
		// bookkeeping; a missing one (transient render paths) still captures.
		const rasterScale = this.getRasterScale();
		const fullBounds =
			backdropRequest?.bounds ?? this.getBackdropTextureBounds(bdElem);
		const request = backdropRequest ?? {
			bounds: fullBounds,
			blurSigma: this.getBackdropBlurSigma(bdElem),
			rasterScale,
		};
		const captured = this.backdropEffectCoordinator.acquireFixedRRegion(
			encoder,
			backdropSourceTexture,
			backdropViewport,
			this.viewportState.width,
			this.viewportState.height,
			request,
			this.activeProfiler,
		);
		// Fully off-screen region — nothing to filter or blit.
		if (!captured) return;

		this.filterRenderer.applyFilters(
			captured.texture,
			allFilters,
			encoder,
			undefined,
			rasterScale,
			undefined,
			undefined,
			undefined,
			captured.sampleBlur,
			{
				worldSize: { width: fullBounds.width, height: fullBounds.height },
				sourceOffset: {
					x: captured.actualBounds.minX - fullBounds.minX,
					y: fullBounds.maxY - captured.actualBounds.maxY,
				},
			},
		);

		// Step 1: Render element shape to a prebuf-sized mask texture
		const { width: cw, height: ch } = this.viewportState;
		this.cache.ensureBackdropMaskTextures(cw, ch);
		const maskTexture = this.compositeState.backdropMask.texture!;
		const maskStencilTexture = this.compositeState.backdropMaskStencil.texture!;

		const maskPass = encoder.beginRenderPass({
			label: `Mask Render Pass: ${element.id}`,
			colorAttachments: [
				{
					view: maskTexture.createView(),
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
			depthStencilAttachment: createPassLocalStencilAttachment(
				maskStencilTexture.createView(),
			),
		});
		maskPass.setPipeline(this.strokePipeline);
		maskPass.setBindGroup(0, this.viewportBinding.active);
		maskPass.setBindGroup(1, this.transformsBindGroup!);
		maskPass.setBindGroup(2, this.dummyGradientBindGroup);
		maskPass.setBindGroup(3, this.dummyMaskBindGroup);
		this.renderState.currentTransformIndex =
			this.viewportManager.getTransformIndex(element.id);
		this.elements.renderElementToMask(maskPass, element, elementsMap);
		maskPass.end();

		// Step 2: Blit captured backdrop × mask to canvas
		const f = this.backdropBlitPool.f32;
		f[0] = captured.actualBounds.minX;
		f[1] = captured.actualBounds.minY;
		f[2] = captured.actualBounds.maxX;
		f[3] = captured.actualBounds.maxY;
		f[4] = alphaMultiplier * (element.opacity ?? 1.0);
		f[5] = 0;
		f[6] = 0;
		f[7] = 0;
		f[8] = 0;
		f[9] = 0;
		f[10] = 1;
		f[11] = 1;
		// No outer mask for backdrop filters — sentinel zeros
		f[12] = 0;
		f[13] = 0;
		f[14] = 0;
		f[15] = 0;

		const bufIdx = this.backdropBlitPool.index;
		const blitUniformBuffer = this.acquireBackdropBlitBuffer();
		this.device.queue.writeBuffer(blitUniformBuffer, 0, f);

		const blitBindGroup = this.backdropBlitBGCache.getOrCreate(
			bufIdx,
			captured.texture,
			maskTexture,
			() =>
				this.device.createBindGroup({
					layout: this.blitWithMaskBindGroupLayout,
					entries: [
						{ binding: 0, resource: { buffer: blitUniformBuffer } },
						{ binding: 1, resource: this.sampler },
						{ binding: 2, resource: captured.texture.createView() },
						{ binding: 3, resource: maskTexture.createView() },
					],
				}),
		);

		const blitPass = encoder.beginRenderPass({
			label: `Backdrop Mask Blit Pass: ${element.id}`,
			colorAttachments: [
				{
					view: textureView,
					loadOp: "load",
					storeOp: "store",
				},
			],
			depthStencilAttachment: createPassLocalStencilAttachment(stencilView),
		});
		// Two-draw replace composite: punch dst by (1 - mask·opacity), then
		// add the filtered backdrop (see blitBackdropPunchPipeline).
		blitPass.setBindGroup(0, this.viewportBinding.active);
		blitPass.setBindGroup(1, blitBindGroup);
		blitPass.setBindGroup(2, this.dummyMaskBindGroup);
		blitPass.setPipeline(this.blitBackdropPunchPipeline);
		blitPass.draw(6);
		blitPass.setPipeline(this.blitBackdropWithMaskPipeline);
		blitPass.draw(6);
		blitPass.end();
	}

	/**
	 * Re-render a single element at full opacity (composed with all its
	 * ancestors' opacity) on top of the dimmed capture. Shared by the
	 * reference3d isolated-element pass and single-element editing scopes.
	 * The transforms buffer holds composed world transforms per element,
	 * so no parent transform is needed.
	 */
	private renderIsolatedElementPass(
		dimPass: GPURenderPassEncoder,
		element: AnyArtObject,
		filteredTextures: Map<string, FilteredTextureInfo>,
		elementsMap: Map<string, AnyArtObject>,
		mainCompositeContext: CompositeRenderContext | undefined,
		localBoundsCache: LocalBoundsCache | undefined,
	): GPURenderPassEncoder {
		let isolatedAlpha = 1.0;
		const parentGroupMap = this.viewportManager.getParentGroupMap();
		let parentId = parentGroupMap.get(element.id);
		while (parentId) {
			const ancestor = elementsMap.get(parentId);
			if (ancestor) isolatedAlpha *= ancestor.opacity ?? 1.0;
			parentId = parentGroupMap.get(parentId);
		}
		return this.renderElements(
			dimPass,
			[element],
			filteredTextures,
			elementsMap,
			isolatedAlpha,
			null,
			undefined,
			"main",
			mainCompositeContext,
			localBoundsCache,
		);
	}

	private renderElements(
		passEncoder: GPURenderPassEncoder,
		elements: AnyArtObject[],
		filteredTextures: Map<string, FilteredTextureInfo>,
		elementsMap: Map<string, AnyArtObject>,
		alphaMultiplier: number = 1.0,
		parentTransform: ElementTransform | null = null,
		skipElementIds?: ReadonlySet<string>,
		pipelineType: PipelineType = "main",
		compositeContext?: CompositeRenderContext,
		localBoundsCache?: LocalBoundsCache,
		parentPreFilters?: Filter[],
	): GPURenderPassEncoder {
		if (!this.viewportState.current) return passEncoder;

		let activePass = passEncoder;
		const batchRegistry = compositeContext ? this.strokeRegistry : null;
		let currentBatchTextureUid = "";
		const pendingWetInkJobs: PendingWetInkJob[] = [];
		let wetRenderBufferCacheKey: string | null = null;
		const getWetRenderBufferCacheKey = () => {
			wetRenderBufferCacheKey ??= buildWetInkRenderBufferCacheKey(elements);
			return wetRenderBufferCacheKey;
		};
		const flushPendingWetInkJobs = () => {
			if (pendingWetInkJobs.length === 0) return;
			// Wet-ink jobs interrupt the pass and composite back — emit any
			// pending merged run first and suspend merging until the pass resumes.
			const wasBatching = this.runBatcher.pauseBatching();
			if (batchRegistry) {
				batchRegistry.flushBatch(
					activePass,
					pipelineType,
					this.transformsBindGroup!,
				);
				currentBatchTextureUid = "";
			}
			activePass.end();
			const pendingCachedResults: WetInkCachedResultComposite[] = [];
			for (const job of pendingWetInkJobs) {
				this.applyWetInkPasses(
					job.compositeContext,
					job.path,
					job.wetPasses,
					job.effectiveAlpha,
					job.transformIndex,
					job.renderBufferCacheKey,
					pendingCachedResults,
				);
			}
			if (pendingCachedResults.length > 0) {
				this.wetInkPass!.compositeCachedResults(
					compositeContext!.encoder,
					pendingCachedResults,
					this.activeProfiler,
				);
			}
			pendingWetInkJobs.length = 0;
			activePass = compositeContext!.restartPass();
			this.runBatcher.resumeBatching(wasBatching);
		};
		if (batchRegistry) batchRegistry.beginBatch();

		for (const element of elements) {
			// Skip invisible elements (visible === false; undefined/true means visible)
			if (element.visible === false) {
				continue;
			}
			// Text axis paths are guides — never paint their fill/stroke.
			// (They still work as clip sources via renderElementToMask.)
			if (
				element.type === "path" &&
				this.renderState.textAxisPathIds?.has(element.id)
			) {
				continue;
			}
			// Skip backdrop filter elements - they'll be processed separately
			if (skipElementIds?.has(element.id)) {
				continue;
			}

			// Prefer SpatialIndex's accurate WorldBBox over per-element recomputation.
			// This is critical for text elements where calculateElementBounds uses
			// a rough fontSize-based estimate that diverges from actual rendered width.
			// When inside a Group, compose parent transform into bounds for culling.
			// Skip the SpatialIndex entry while the element's geometry is
			// overridden by a tool preview (staleWorldBoundsIds) — it still
			// reflects the committed document, and offscreen compositing
			// textures sized from it clip the preview at the pre-drag bbox.
			let elementBounds =
				(this.renderState.staleWorldBoundsIds?.has(element.id)
					? undefined
					: this.renderState.boundsCache?.get(element.id)) ??
				calculateElementBounds(element, elementsMap, localBoundsCache);

			if (parentTransform) {
				elementBounds = applyTransformToBounds(elementBounds, parentTransform);
			}
			// An extrude appearance projects a 3D solid that extends past the flat
			// footprint (depth/rotation/perspective); cull against the solid's
			// world AABB too, or it pops out when the flat bounds leave the
			// viewport (pronounced for world-space group extrudes).
			const cullBounds = this.expandBoundsForRenderedOutput(
				element,
				elementBounds,
				filteredTextures.get(element.id),
			);
			// A null viewportBounds marks an offscreen / cull-disabled pass (group
			// bake, def rasterize, transform-preserving render). Those render into
			// a texture sized to their own coverage and rely on NDC clipping, so we
			// must NOT cull here against the main-canvas viewport: that drops
			// content off the current view but inside the offscreen target — e.g. a
			// group extrude's children outside the viewport vanished from its bake,
			// which read as a zoom-dependent partial clip of the solid.
			const viewportBounds = this.viewportState.bounds;
			const intersectsViewport =
				viewportBounds == null ||
				!(
					cullBounds.maxX < viewportBounds.minX ||
					cullBounds.minX > viewportBounds.maxX ||
					cullBounds.maxY < viewportBounds.minY ||
					cullBounds.minY > viewportBounds.maxY
				);
			if (!intersectsViewport) {
				continue;
			}

			// Set current transform index and mask bind group for this element.
			this.renderState.currentTransformIndex =
				this.viewportManager.getTransformIndex(element.id);
			this.renderState.currentMaskBindGroup =
				this.inlineMaskEntries.get(element.id)?.bindGroup ??
				this.dummyMaskBindGroup;
			if (this.maskBindGroupRef) {
				this.maskBindGroupRef.current = this.renderState.currentMaskBindGroup;
			}

			const elementOpacity = element.opacity ?? 1.0;
			const effectiveAlpha = alphaMultiplier * elementOpacity;

			// Backdrop-composite geometry filter (glass extrude): composite its
			// appearance here, at the element's z-order, over the backdrop
			// composited so far — instead of on top after the whole document. It
			// replaces the flat look, so this is the element's entire appearance.
			// Interrupt the pass (the driver opens its own), like the
			// filtered-texture blend path.
			const groupCompositionPlan = isGroup(element)
				? this.activeGroupCompositionPlans.get(element.id)
				: undefined;
			const backdropDriver =
				groupCompositionPlan?.kind === "isolated"
					? undefined
					: this.backdropDrivers.find((d) => d.hasInlineComposite(element));
			// No composite context means there is no backdrop to refract: this is
			// the mask atlas baking mask content, which runs before the document
			// under the mask is drawn. Blit the lit surface instead of skipping the
			// element — its appearance replaces the flat look, so skipping draws
			// nothing at all and the mask comes out empty.
			if (backdropDriver && !compositeContext) {
				this.blitBackdropFreeLayers(
					activePass,
					backdropDriver.backdropFreeLayers?.(element) ?? [],
					effectiveAlpha,
				);
				continue;
			}
			if (backdropDriver && compositeContext) {
				flushPendingWetInkJobs();
				if (batchRegistry) {
					batchRegistry.flushBatch(
						activePass,
						pipelineType,
						this.transformsBindGroup!,
					);
					currentBatchTextureUid = "";
				}
				const wasBatching = this.runBatcher.pauseBatching();
				activePass.end();
				// A glass solid composes against the live backdrop, so it can never
				// be pre-baked like the other filtered outputs — its mask has to go
				// in here, while the pass is still closed. Asking for a separate
				// texture is what leaves something to apply it to: composed straight
				// onto the target, the pixels are already final.
				const inlineMasks = this.resolveSubtreeMasks(element.id);
				let filteredComposite = backdropDriver.composeInline(
					element,
					compositeContext.encoder,
					compositeContext.targetTexture,
					this.viewportState.current,
					this.viewportState.width,
					this.viewportState.height,
					this.activeProfiler,
					inlineMasks.length > 0,
				);
				let ownsMaskedColor = false;
				let ownsMaskedCoverage = false;
				if (filteredComposite && inlineMasks.length > 0) {
					// The composite is a canvas-sized screen-space texture spanning the
					// whole viewport, so its scale is the zoom and the part worth
					// masking is only where the solid actually paints. Re-baking the
					// full span instead costs viewportWorldWidth x scale, which grows
					// without bound as the viewport zooms out.
					let minX = Number.POSITIVE_INFINITY;
					let minY = Number.POSITIVE_INFINITY;
					let maxX = Number.NEGATIVE_INFINITY;
					let maxY = Number.NEGATIVE_INFINITY;
					backdropDriver.unionSolidBounds(element, (b) => {
						minX = Math.min(minX, b.minX);
						minY = Math.min(minY, b.minY);
						maxX = Math.max(maxX, b.maxX);
						maxY = Math.max(maxY, b.maxY);
					});
					const solidBounds =
						minX <= maxX && minY <= maxY
							? {
									minX,
									minY,
									maxX,
									maxY,
									width: maxX - minX,
									height: maxY - minY,
								}
							: undefined;
					for (const inlineMask of inlineMasks) {
						const previousCoverage = filteredComposite.coverage;
						const masked = this.offscreen.applyWorldMaskToTexture(
							compositeContext.encoder,
							filteredComposite,
							inlineMask,
							this.viewportState.current?.zoom ?? 1,
							solidBounds,
						);
						// The coverage side-channel goes through the same ordered
						// stack so every mask uses the color surface's current crop.
						const maskedCoverage =
							masked && previousCoverage
								? this.offscreen.applyWorldMaskToTexture(
										compositeContext.encoder,
										createRenderSurface(
											previousCoverage,
											filteredComposite.placement,
											{
												role: "coverage",
												alphaMode: "scalar",
												opacityState: "intrinsic",
											},
										),
										inlineMask,
										this.viewportState.current?.zoom ?? 1,
										solidBounds,
									)
								: null;
						if (!masked) continue;
						if (ownsMaskedColor) releaseRenderSurface(filteredComposite);
						if (ownsMaskedCoverage && previousCoverage) {
							if (previousCoverage.kind === "frame-owned") {
								previousCoverage.release();
							}
						}
						filteredComposite = {
							...masked,
							opacity: filteredComposite.opacity,
							coverage: maskedCoverage?.texture,
						};
						ownsMaskedColor = true;
						ownsMaskedCoverage = maskedCoverage != null;
					}
				}
				activePass = compositeContext.restartPass();
				this.runBatcher.resumeBatching(wasBatching);
				if (filteredComposite) {
					const blitOpacity = effectiveAlpha * (filteredComposite.opacity ?? 1);
					// Glass intermediate content replaces the backdrop within its
					// coverage: punch the destination first so the src-over blit
					// below totals a (1 - coverage·opacity) destination weight.
					if (filteredComposite.coverage) {
						this.composite.punchGlassCoverage(
							activePass,
							filteredComposite.texture.texture,
							filteredComposite.coverage.texture,
							filteredComposite.placement.bounds,
							blitOpacity,
							filteredComposite.placement.uvRect,
						);
					}
					this.composite.blitTextureToCanvas(
						activePass,
						filteredComposite.texture.texture,
						filteredComposite.placement.bounds,
						blitOpacity,
						filteredComposite.placement.uvRect,
						this.blitPipeline,
					);
					if (ownsMaskedColor) releaseRenderSurface(filteredComposite);
					if (
						ownsMaskedCoverage &&
						filteredComposite.coverage?.kind === "frame-owned"
					) {
						filteredComposite.coverage.release();
					}
				}
				continue;
			}

			// Report this main-pass draw to the backdrop coordinator: a captured
			// backdrop batch whose region the element touches must be recaptured
			// before the next backdrop effect samples it. (composeInline elements
			// report their own compose from inside the driver.)
			if (compositeContext) {
				this.backdropEffectCoordinator.noteDraw(cullBounds);
			}

			const filteredData = filteredTextures.get(element.id);
			const blendMode = element.blendMode ?? "normal";
			const compositionMode = element.compositionMode ?? "normal";
			const needsComposite =
				compositeContext !== undefined &&
				this.compositeState.captureTexture != null &&
				(blendMode !== "normal" || compositionMode !== "normal");
			// Filtered textures are already rasterized snapshots; render/blit directly.
			if (filteredData) {
				flushPendingWetInkJobs();
				// Preserve draw order by flushing pending batches before textured blits.
				if (batchRegistry) {
					batchRegistry.flushBatch(
						activePass,
						pipelineType,
						this.transformsBindGroup!,
					);
					currentBatchTextureUid = "";
				}

				if (filteredData.overrideLayers) {
					// Self-sized extrude solids: blit each appearance layer at its
					// own bounds/quad in order. Element blend/composition mode is
					// ignored here, exactly as the pre-refactor inline extrude blit.
					for (const layer of filteredData.overrideLayers) {
						const layerAlpha = effectiveAlpha * (layer.opacity ?? 1);
						if (layer.placement.kind === "world-quad") {
							this.composite.blitQuadToCanvas(
								activePass,
								layer.texture.texture,
								layer.placement.quad,
								layerAlpha,
								layer.placement.uvRect,
							);
						} else {
							this.composite.blitTextureToCanvas(
								activePass,
								layer.texture.texture,
								layer.placement.bounds,
								layerAlpha,
								layer.placement.uvRect,
								this.blitPipeline,
							);
						}
						activePass.setPipeline(this.strokePipeline);
						activePass.setBindGroup(0, this.viewportBinding.active);
						activePass.setBindGroup(1, this.transformsBindGroup!);
						activePass.setBindGroup(2, this.dummyGradientBindGroup);
						activePass.setBindGroup(3, this.renderState.currentMaskBindGroup);
					}
				} else if (needsComposite) {
					const compositeCtx = compositeContext!;
					const captureTexture = this.compositeState.captureTexture!;
					const wasBatching = this.runBatcher.pauseBatching();
					activePass.end();
					compositeCtx.encoder.copyTextureToTexture(
						{
							texture: compositeCtx.targetTexture,
						},
						{
							texture: captureTexture,
						},
						{
							width: Math.min(
								compositeCtx.targetTexture.width,
								captureTexture.width,
							),
							height: Math.min(
								compositeCtx.targetTexture.height,
								captureTexture.height,
							),
							depthOrArrayLayers: 1,
						},
					);
					activePass = compositeCtx.restartPass();
					this.runBatcher.resumeBatching(wasBatching);
					const source = createCompositeSourceSurface(
						filteredData.output.texture.texture,
						{
							kind: "world-aabb",
							bounds: filteredData.output.placement.bounds,
							uvRect: filteredData.output.placement.uvRect,
						},
					);
					this.composite.compositeSurfaceToCanvas({
						passEncoder: activePass,
						source,
						backdrop: createBlendBackdrop(
							captureTexture,
							compositeCtx.baseTexture,
							source.placement,
						),
						blendMode,
						placementOpacity: createPlacementOpacity(effectiveAlpha),
						compositionMode,
					});
					activePass.setPipeline(this.strokePipeline);
					activePass.setBindGroup(0, this.viewportBinding.active);
					activePass.setBindGroup(1, this.transformsBindGroup!);
					activePass.setBindGroup(2, this.dummyGradientBindGroup);
					activePass.setBindGroup(3, this.renderState.currentMaskBindGroup);
				} else {
					this.composite.blitTextureToCanvas(
						activePass,
						filteredData.output.texture.texture,
						filteredData.output.placement.bounds,
						effectiveAlpha,
						filteredData.output.placement.uvRect,
						this.blitPipeline,
					);
					activePass.setPipeline(this.strokePipeline);
					activePass.setBindGroup(0, this.viewportBinding.active);
					activePass.setBindGroup(1, this.transformsBindGroup!);
					activePass.setBindGroup(2, this.dummyGradientBindGroup);
					activePass.setBindGroup(3, this.renderState.currentMaskBindGroup);
				}
				// Don't render children - they're already in the filtered texture
			} else if (needsComposite) {
				flushPendingWetInkJobs();
				if (batchRegistry) {
					batchRegistry.flushBatch(
						activePass,
						pipelineType,
						this.transformsBindGroup!,
					);
					currentBatchTextureUid = "";
				}
				const compositeCtx = compositeContext!;
				const captureTexture = this.compositeState.captureTexture!;

				// End the active pass before offscreen rendering on the same encoder
				const wasBatching = this.runBatcher.pauseBatching();
				activePass.end();

				let sourceSurface: RenderSurface | null;
				if (isGroup(element) && element.clipPathId != null) {
					const childElements = element.childIds
						.filter((id) => id !== element.clipPathId)
						.map((id) => elementsMap.get(id))
						.filter((el): el is AnyArtObject => el !== undefined);
					const groupWorldTransform = parentTransform
						? composeTransforms(parentTransform, getTransform(element))
						: getTransform(element);
					const outerMasksForBlend = this.resolveSubtreeMasks(element.id);
					const clipResult = this.offscreen.renderClipGroupToTexture(
						this.activeEncoder!,
						element,
						childElements,
						filteredTextures,
						elementsMap,
						groupWorldTransform,
						parentTransform ?? null,
						skipElementIds,
						localBoundsCache,
						outerMasksForBlend,
					);
					sourceSurface = clipResult;
				} else {
					// Size the offscreen texture to the extrude solid (cullBounds),
					// not the flat footprint — otherwise the 3D solid's overhang is
					// clipped at the texture edge (a group extrude with a non-normal
					// blend loses the parts of the solid past the flat group box).
					const result = this.offscreen.renderElementToTexture(
						this.activeEncoder!,
						element,
						cullBounds,
						elementsMap,
					);
					sourceSurface = result;
				}
				if (!sourceSurface) {
					activePass = compositeCtx.restartPass();
					this.runBatcher.resumeBatching(wasBatching);
					continue;
				}

				this.restoreViewportUniformsToGPU();
				const copyW = Math.min(
					compositeCtx.targetTexture.width,
					captureTexture.width,
				);
				const copyH = Math.min(
					compositeCtx.targetTexture.height,
					captureTexture.height,
				);
				compositeCtx.encoder.copyTextureToTexture(
					{
						texture: compositeCtx.targetTexture,
					},
					{
						texture: captureTexture,
					},
					{
						width: copyW,
						height: copyH,
						depthOrArrayLayers: 1,
					},
				);
				activePass = compositeCtx.restartPass();
				this.runBatcher.resumeBatching(wasBatching);
				const source = createCompositeSourceSurface(
					sourceSurface.texture.texture,
					{
						kind: "world-aabb",
						bounds: sourceSurface.placement.bounds,
						uvRect: sourceSurface.placement.uvRect,
					},
				);
				this.composite.compositeSurfaceToCanvas({
					passEncoder: activePass,
					source,
					backdrop: createBlendBackdrop(
						captureTexture,
						compositeContext?.baseTexture,
						source.placement,
					),
					blendMode,
					placementOpacity: createPlacementOpacity(effectiveAlpha),
					compositionMode,
				});
				releaseRenderSurface(sourceSurface);
				activePass.setPipeline(this.strokePipeline);
				activePass.setBindGroup(0, this.viewportBinding.active);
				activePass.setBindGroup(1, this.transformsBindGroup!);
				activePass.setBindGroup(2, this.dummyGradientBindGroup);
				activePass.setBindGroup(3, this.renderState.currentMaskBindGroup);
			} else if (
				isPath(element) &&
				element.eraseMasks &&
				element.eraseMasks.length > 0 &&
				compositeContext
			) {
				flushPendingWetInkJobs();
				// EraseMask path: render to offscreen with alpha subtraction
				if (batchRegistry) {
					batchRegistry.flushBatch(
						activePass,
						pipelineType,
						this.transformsBindGroup!,
					);
					currentBatchTextureUid = "";
				}
				{
					// renderWithEraseMasks ends and re-creates the active pass.
					const wasBatching = this.runBatcher.pauseBatching();
					activePass = this.offscreen.renderWithEraseMasks(
						this.activeEncoder!,
						activePass,
						element,
						elementsMap,
						effectiveAlpha,
						elementBounds,
						compositeContext,
					);
					this.runBatcher.resumeBatching(wasBatching);
				}
				this.restoreViewportUniformsToGPU();
				activePass.setPipeline(this.strokePipeline);
				activePass.setBindGroup(0, this.viewportBinding.active);
				activePass.setBindGroup(1, this.transformsBindGroup!);
				activePass.setBindGroup(2, this.dummyGradientBindGroup);
				activePass.setBindGroup(3, this.renderState.currentMaskBindGroup);
			} else if (isPath(element)) {
				// A group's pre-filters propagate to every child, so fold them in
				// before anything inspects or resolves this path.
				const effectivePath = parentPreFilters?.length
					? ({
							...element,
							filters: [...(element.filters ?? []), ...parentPreFilters],
						} as Path)
					: element;

				// Routing only needs the appearance set; resolving the geometry
				// is deferred to the branch that actually draws.
				const drawableApps = collectDrawableAppearances(
					effectivePath,
					this.filterRenderer,
				);

				// Check if all strokes are batch-eligible. Wet-ink strokes are
				// excluded from the batch path so WetInkPass can run between
				// stroke and the next element on the shared layer target.
				const enabledStrokes = drawableApps.filter(
					(f) => f.processor === "stroke",
				) as StrokeAppearance[];
				const batchableStrokes = enabledStrokes.filter((s) => {
					if (!s.paramData.params.brushSettings) return false;
					if (!s.paramData.params.strokeColor) return false;
					const brush = normalizeBrushSettings(
						s.paramData.params.brushSettings,
					);
					return !isGeometricBrush(brush) && !hasWetInk(brush);
				});
				const canBatch =
					batchRegistry &&
					batchableStrokes.length === enabledStrokes.length &&
					enabledStrokes.length > 0;

				if (canBatch) {
					flushPendingWetInkJobs();
					const passes = resolveAppearancePasses(
						effectivePath,
						this.filterRenderer,
					);

					let viewportBounds = this.viewportState.bounds ?? undefined;
					// When rendering inside a group, adjust viewport bounds to
					// account for parentTransform so stamp culling uses correct
					// local-space bounds.
					if (viewportBounds && parentTransform) {
						if (
							parentTransform.rotation === 0 &&
							parentTransform.scaleX === 1 &&
							parentTransform.scaleY === 1 &&
							(parentTransform.skewX ?? 0) === 0 &&
							(parentTransform.skewY ?? 0) === 0
						) {
							viewportBounds = {
								minX: viewportBounds.minX - parentTransform.x,
								minY: viewportBounds.minY - parentTransform.y,
								maxX: viewportBounds.maxX - parentTransform.x,
								maxY: viewportBounds.maxY - parentTransform.y,
								width: viewportBounds.width,
								height: viewportBounds.height,
							};
						} else {
							// Parent has rotation/scale — disable stamp culling
							// (same strategy as addToBatch's existing guard).
							viewportBounds = undefined;
						}
					}

					const fullyInsideViewport =
						viewportBounds != null
							? elementBounds.minX >= viewportBounds.minX &&
								elementBounds.maxX <= viewportBounds.maxX &&
								elementBounds.minY >= viewportBounds.minY &&
								elementBounds.maxY <= viewportBounds.maxY
							: boundsFullyInsideViewport(
									elementBounds.minX,
									elementBounds.minY,
									elementBounds.maxX,
									elementBounds.maxY,
									this.viewportState.current,
									this.viewportState.width,
									this.viewportState.height,
								);

					if (viewportBounds && fullyInsideViewport) {
						viewportBounds = undefined;
					}

					// Render appearances in filters array order
					for (const { appearance: app, segments, cacheKey } of passes) {
						const appAlpha = effectiveAlpha * app.opacity;
						if (app.processor === "fill") {
							// Flush pending stroke batch before rendering fill
							batchRegistry.flushBatch(
								activePass,
								pipelineType,
								this.transformsBindGroup!,
							);
							currentBatchTextureUid = "";

							const fill = (app as FillAppearance).paramData.params.fill;
							if (fill) {
								this.elements.renderPathFill(
									activePass,
									segments,
									fill,
									appAlpha,
									pipelineType,
									cacheKey,
								);
							}
						} else {
							const strokeApp = app as StrokeAppearance;
							const brushSettings = normalizeBrushSettings(
								strokeApp.paramData.params.brushSettings,
							);

							const textureUid = resolveBrushTextureUid(
								brushSettings,
								this.strokeRegistry?.getBrushTextureManager(),
							);
							if (
								textureUid &&
								!this.elements.ensureBrushTexture(
									textureUid,
									this.assetState.currentFiles,
								)
							) {
								continue;
							}

							// Ensure scatter / start / end textures are loaded.
							// Def resolution is restricted to the primary source:
							// def textures use the canvas format, which is not
							// copy-compatible with the rgba8unorm scatter texture
							// array, so def sources in these slots fall back to
							// the built-in texture.
							const files = this.assetState.currentFiles;
							if (brushSettings.type === "scatter") {
								for (const uid of resolveScatterSourceUids(
									brushSettings.scatterSources,
								)) {
									this.elements.ensureBrushTexture(uid, files);
								}
								const startUid = resolveOptionalSourceUid(
									brushSettings.startSource,
								);
								if (startUid) {
									this.elements.ensureBrushTexture(startUid, files);
								}
								const endUid = resolveOptionalSourceUid(
									brushSettings.endSource,
								);
								if (endUid) {
									this.elements.ensureBrushTexture(endUid, files);
								}
							}

							const effectiveTextureUid = textureUid ?? "";

							if (
								currentBatchTextureUid &&
								effectiveTextureUid !== currentBatchTextureUid
							) {
								batchRegistry.flushBatch(
									activePass,
									pipelineType,
									this.transformsBindGroup!,
								);
							}
							currentBatchTextureUid = effectiveTextureUid;

							const singleStrokePath: Path = {
								...element,
								filters: [strokeApp],
							};
							const resolvedStyle = resolveStrokeStyle({
								path: singleStrokePath,
								segments,
								alphaMultiplier: appAlpha,
								transformIndex: this.renderState.currentTransformIndex,
								strokeAppearance: strokeApp,
							});
							if (resolvedStyle) {
								batchRegistry.addToBatch(
									resolvedStyle,
									this.renderState.currentTransformIndex,
								);
							}
						}
					}
				} else {
					// Non-batch path (non-batchable strokes or no strokes).
					if (batchRegistry) {
						batchRegistry.flushBatch(
							activePass,
							pipelineType,
							this.transformsBindGroup!,
						);
						currentBatchTextureUid = "";
					}
					const passes = resolveAppearancePasses(
						effectivePath,
						this.filterRenderer,
					);
					const wetStrokes =
						this.device.limits.maxColorAttachments >= 3
							? enabledStrokes.filter((s) =>
									hasWetInk(
										normalizeBrushSettings(s.paramData.params.brushSettings),
									),
								)
							: [];
					const hasWetStrokes = wetStrokes.length > 0 && compositeContext;

					if (!hasWetStrokes) {
						flushPendingWetInkJobs();
						if (passes.length > 0) {
							this.elements.renderAppearancePasses(
								activePass,
								effectivePath,
								passes,
								effectiveAlpha,
								pipelineType,
							);
						}
					} else {
						// Interleave wet and non-wet appearances in their original
						// order so that a non-wet stroke placed after a wet stroke
						// renders on top of it. Splitting the resolved PASSES (not
						// the filters array) keeps each run's geometry intact — a
						// filters-level split would drop the element's pre-filters
						// from whichever run doesn't carry them.
						const wetSet: ReadonlySet<Filter> = new Set(wetStrokes);
						let normalRun: ResolvedAppearancePass[] = [];
						let wetRun: ResolvedAppearancePass[] = [];
						let didEmit = false;

						const flushNormalRun = () => {
							if (normalRun.length === 0) return;
							flushPendingWetInkJobs();
							this.elements.renderAppearancePasses(
								activePass,
								effectivePath,
								normalRun,
								effectiveAlpha,
								pipelineType,
							);
							didEmit = true;
							normalRun = [];
						};

						const flushWetRun = () => {
							if (wetRun.length === 0) return;
							const renderBufferCacheKey = wetRun.some(({ appearance }) => {
								const brush = normalizeBrushSettings(
									(appearance as StrokeAppearance).paramData.params
										.brushSettings,
								);
								return (
									(brush.type === "scatter" || brush.type === "calligraphy") &&
									usesWetInkRenderBufferPickup(brush.wetInk)
								);
							})
								? getWetRenderBufferCacheKey()
								: "";
							pendingWetInkJobs.push({
								compositeContext,
								path: effectivePath,
								wetPasses: wetRun,
								effectiveAlpha,
								transformIndex: this.renderState.currentTransformIndex,
								renderBufferCacheKey,
							});
							didEmit = true;
							wetRun = [];
						};

						for (const pass of passes) {
							if (wetSet.has(pass.appearance)) {
								flushNormalRun();
								wetRun.push(pass);
							} else {
								flushWetRun();
								normalRun.push(pass);
							}
						}
						flushWetRun();
						flushNormalRun();

						if (!didEmit) {
							flushPendingWetInkJobs();
						}
					}
				}
			} else if (isGroup(element)) {
				flushPendingWetInkJobs();
				if (batchRegistry) {
					batchRegistry.flushBatch(
						activePass,
						pipelineType,
						this.transformsBindGroup!,
					);
					currentBatchTextureUid = "";
				}
				// An appearance that replaces the element's render (e.g. extrude3d)
				// composites the group itself via the filter system — opaque from
				// its filtered texture, glass via the refraction interrupt — so skip
				// the group's flat child rendering.
				if (isElementRenderReplaced(element, this.filterRenderer)) continue;

				const childElements = element.childIds
					.filter((id) => id !== element.clipPathId)
					.map((id) => elementsMap.get(id))
					.filter((el): el is AnyArtObject => el !== undefined);
				if (
					groupCompositionPlan?.kind === "isolated" &&
					groupCompositionPlan.reasons.every(
						(reason) => reason === "opacity",
					) &&
					compositeContext
				) {
					const wasBatching = this.runBatcher.pauseBatching();
					activePass.end();
					const isolated = this.offscreen.renderGroupToTexture(
						this.activeEncoder!,
						element,
						brandWorldBBox(cullBounds),
						elementsMap,
						localBoundsCache,
					);
					activePass = compositeContext.restartPass();
					this.runBatcher.resumeBatching(wasBatching);
					if (isolated) {
						this.composite.blitTextureToCanvas(
							activePass,
							isolated.texture.texture,
							isolated.placement.bounds,
							effectiveAlpha,
							isolated.placement.uvRect,
						);
						releaseRenderSurface(isolated);
					}
					continue;
				}
				const childAlpha = effectiveAlpha;
				const groupWorldTransform = parentTransform
					? composeTransforms(parentTransform, getTransform(element))
					: getTransform(element);

				// Resolve group-level appearances (fill/stroke on combined child paths)
				const groupHasAppearances = hasGroupAppearances(element);
				let combinedSegments: CubicBezierSegment[] | undefined;
				let beforeApps: Filter[] = [];
				let afterApps: Filter[] = [];
				if (groupHasAppearances) {
					combinedSegments = this.cacheManager.groupPath.resolve(
						element,
						elementsMap,
						this.cacheManager.compoundPath,
					);
					const split = splitGroupAppearances(element.filters);
					beforeApps = split.before;
					afterApps = split.after;
				}

				// Extract group-level pre-filters to propagate to children.
				// Nested groups apply child→parent order (innermost first).
				const groupPreFilters = (element.filters ?? []).filter((f) =>
					isGeometryFilter(f, this.filterRenderer),
				);
				const effectivePreFilters =
					groupPreFilters.length > 0 || parentPreFilters?.length
						? [...groupPreFilters, ...(parentPreFilters ?? [])]
						: undefined;

				const canRenderClipped =
					groupCompositionPlan?.kind === "isolated" &&
					groupCompositionPlan.reasons.includes("clip") &&
					compositeContext !== undefined &&
					element.clipPathId != null;
				if (canRenderClipped) {
					// If the mask is in the atlas, blend mode is normal, and
					// this group is NOT nested inside another clip group,
					// render children inline — the fragment shader samples the
					// mask texture.  Otherwise fall back to the offscreen flow.
					const hasMaskInAtlas =
						this.clipMaskAtlas.getMaskEntry(element.clipPathId!) !== null;
					if (
						hasMaskInAtlas &&
						this.activeMaskApplicationPlans.get(element.id)?.kind !==
							"subtree-composite" &&
						(element.blendMode === "normal" || element.blendMode === undefined)
					) {
						activePass = this.renderGroupAppearanceFilters(
							activePass,
							beforeApps,
							combinedSegments ?? [],
							childAlpha,
							pipelineType,
							element.id,
							element.filters,
							compositeContext,
						);
						activePass = this.renderElements(
							activePass,
							childElements,
							filteredTextures,
							elementsMap,
							childAlpha,
							groupWorldTransform,
							skipElementIds,
							pipelineType,
							compositeContext,
							localBoundsCache,
							effectivePreFilters,
						);
						activePass = this.renderGroupAppearanceFilters(
							activePass,
							afterApps,
							combinedSegments ?? [],
							childAlpha,
							pipelineType,
							element.id,
							element.filters,
							compositeContext,
						);
					} else {
						const outerMasks = this.resolveSubtreeMasks(element.id);
						const wasBatching = this.runBatcher.pauseBatching();
						try {
							activePass = this.offscreen.renderClipGroup(
								this.activeEncoder!,
								activePass,
								element,
								childElements,
								filteredTextures,
								elementsMap,
								childAlpha,
								groupWorldTransform,
								parentTransform ?? null,
								skipElementIds,
								compositeContext,
								localBoundsCache,
								outerMasks,
							);
						} finally {
							this.runBatcher.resumeBatching(wasBatching);
						}
					}
					continue;
				}
				activePass = this.renderGroupAppearanceFilters(
					activePass,
					beforeApps,
					combinedSegments ?? [],
					childAlpha,
					pipelineType,
					element.id,
					element.filters,
					compositeContext,
				);
				activePass = this.renderElements(
					activePass,
					childElements,
					filteredTextures,
					elementsMap,
					childAlpha,
					groupWorldTransform,
					skipElementIds,
					pipelineType,
					compositeContext,
					localBoundsCache,
					effectivePreFilters,
				);
				activePass = this.renderGroupAppearanceFilters(
					activePass,
					afterApps,
					combinedSegments ?? [],
					childAlpha,
					pipelineType,
					element.id,
					element.filters,
					compositeContext,
				);
			} else {
				// Non-path, non-group elements: image, compound-path, text
				flushPendingWetInkJobs();
				if (batchRegistry) {
					batchRegistry.flushBatch(
						activePass,
						pipelineType,
						this.transformsBindGroup!,
					);
					currentBatchTextureUid = "";
				}
				const effectiveElement = parentPreFilters?.length
					? ({
							...element,
							filters: [...(element.filters ?? []), ...parentPreFilters],
						} as AnyArtObject)
					: element;
				this.elements.dispatchElementDirect(
					activePass,
					effectiveElement,
					elementsMap,
					effectiveAlpha,
					pipelineType,
				);
			}
		}

		flushPendingWetInkJobs();
		if (batchRegistry) {
			// Flush any remaining batched strokes at loop end.
			batchRegistry.flushBatch(
				activePass,
				pipelineType,
				this.transformsBindGroup!,
			);
		}

		return activePass;
	}

	/**
	 * Union `flat` with the world AABB of everything the element actually paints
	 * beyond its flat geometry: a filter's expanded coverage (blur/drop-shadow/
	 * glow/outline bleed) and any extrude solids (their projected quad/bounds).
	 * Both culling and offscreen texture sizing must use this expanded box, or a
	 * partly-off-screen element whose effect reaches into view is wrongly clipped
	 * or culled. Returns `flat` unchanged when nothing extends it.
	 */
	private expandBoundsForRenderedOutput(
		element: AnyArtObject,
		flat: WorldBBox,
		filtered: FilteredTextureInfo | undefined,
	): WorldBBox {
		const renderReplaced = isElementRenderReplaced(
			element,
			this.filterRenderer,
		);
		// No render-replacing appearance and no filtered coverage → flat is exact.
		if (!renderReplaced && !filtered) return flat;
		let minX = flat.minX;
		let minY = flat.minY;
		let maxX = flat.maxX;
		let maxY = flat.maxY;
		const union = (b: {
			minX: number;
			minY: number;
			maxX: number;
			maxY: number;
		}): void => {
			minX = Math.min(minX, b.minX);
			minY = Math.min(minY, b.minY);
			maxX = Math.max(maxX, b.maxX);
			maxY = Math.max(maxY, b.maxY);
		};
		// Filter-expanded coverage (blur/drop-shadow/glow/outline spread beyond
		// the flat silhouette). Output placement is the exact baked coverage.
		if (filtered) union(filtered.output.placement.bounds);
		// Opaque extrude solids (post-filter path) are stored as blit layers.
		for (const layer of filtered?.overrideLayers ?? []) {
			union(layer.placement.bounds);
		}
		// Backdrop-composite solids (glass extrude) live in their driver.
		if (renderReplaced) {
			for (const driver of this.backdropDrivers) {
				driver.unionSolidBounds(element, union);
			}
		}
		return brandWorldBBox({
			minX,
			minY,
			maxX,
			maxY,
			width: maxX - minX,
			height: maxY - minY,
		});
	}

	/**
	 * Render group-level fill/stroke appearances using the combined path
	 * of all child elements. Segments include each child's own transform
	 * (via toWorldPath), so the group's transform index is used to apply
	 * the group's world transform on the GPU side.
	 */
	private renderGroupAppearanceFilters(
		activePass: GPURenderPassEncoder,
		appearances: Filter[],
		combinedSegments: CubicBezierSegment[],
		alpha: number,
		pipelineType: PipelineType,
		groupId: string,
		groupFilters: Filter[] | undefined,
		compositeContext: CompositeRenderContext | undefined,
	): GPURenderPassEncoder {
		if (appearances.length === 0 || combinedSegments.length === 0)
			return activePass;

		const savedTransformIndex = this.renderState.currentTransformIndex;
		this.renderState.currentTransformIndex =
			this.viewportManager.getTransformIndex(groupId);

		const paramHash = hashGroupAppearanceFingerprint(appearances, groupFilters);

		// Extract top-level pre-filters (zigzag, etc.) from the group's filters.
		const preFilters = (groupFilters ?? []).filter(
			(f) =>
				f.processor !== "fill" &&
				f.processor !== "stroke" &&
				f.processor !== "content" &&
				f.enabled !== false,
		);

		// Render each appearance individually so per-appearance sub-filters
		// (e.g., PathOffset on a fill) are applied correctly.
		for (const app of appearances) {
			const preSubFilters = (app.subFilters ?? []).filter((sf: Filter) =>
				isGeometryFilter(sf, this.filterRenderer),
			);

			const tempPath: Path = {
				type: "path",
				id: `${groupId}:group-app:${app.uid}:${paramHash}`,
				opacity: 1,
				blendMode: "normal",
				segments: combinedSegments,
				filters: [...preFilters, ...preSubFilters, app],
				transform: createIdentityTransform(),
			};

			const appBlendMode = app.blendMode ?? "normal";
			if (
				appBlendMode !== "normal" &&
				compositeContext &&
				this.activeEncoder &&
				this.compositeState.captureTexture
			) {
				// Non-normal blend mode: render to offscreen, then composite.
				// Use the group's id so renderElementToTexture picks up the
				// group's transform index from ViewportManager, and apply the
				// group's transform to the bounds so the offscreen viewport
				// covers the correct world-space region.
				const offscreenPath: Path = { ...tempPath, id: groupId };
				let bounds = calculateElementBounds(offscreenPath);
				const groupTransform = this.viewportManager
					.getComposedTransformCache()
					.get(groupId);
				if (groupTransform) {
					bounds = applyTransformToBounds(bounds, groupTransform);
				}
				const wasBatching = this.runBatcher.pauseBatching();
				activePass.end();
				const result = this.offscreen.renderElementToTexture(
					this.activeEncoder,
					offscreenPath as unknown as AnyArtObject,
					bounds,
				);
				this.runBatcher.resumeBatching(wasBatching);
				if (result) {
					this.restoreViewportUniformsToGPU();
					const captureTexture = this.compositeState.captureTexture!;
					const copyW = Math.min(
						compositeContext.targetTexture.width,
						captureTexture.width,
					);
					const copyH = Math.min(
						compositeContext.targetTexture.height,
						captureTexture.height,
					);
					compositeContext.encoder.copyTextureToTexture(
						{ texture: compositeContext.targetTexture },
						{ texture: captureTexture },
						{
							width: copyW,
							height: copyH,
							depthOrArrayLayers: 1,
						},
					);
					activePass = compositeContext.restartPass();
					// Appearance opacity is already applied inside
					// renderElementToTexture → renderPath, so only pass the
					// group's effective alpha here to avoid double-application.
					const source = createCompositeSourceSurface(result.texture.texture, {
						kind: "world-aabb",
						bounds: result.placement.bounds,
						uvRect: result.placement.uvRect,
					});
					this.composite.compositeSurfaceToCanvas({
						passEncoder: activePass,
						source,
						backdrop: createBlendBackdrop(
							captureTexture,
							compositeContext.baseTexture,
							source.placement,
						),
						blendMode: appBlendMode,
						placementOpacity: createPlacementOpacity(alpha),
						compositionMode: "normal",
					});
					activePass.setPipeline(this.strokePipeline);
					activePass.setBindGroup(0, this.viewportBinding.active);
					activePass.setBindGroup(1, this.transformsBindGroup!);
					activePass.setBindGroup(2, this.dummyGradientBindGroup);
					activePass.setBindGroup(3, this.renderState.currentMaskBindGroup);
					releaseRenderSurface(result);
				} else {
					activePass = compositeContext.restartPass();
				}
			} else {
				this.elements.renderPath(
					activePass,
					tempPath,
					alpha * app.opacity,
					pipelineType,
				);
			}
		}

		this.renderState.currentTransformIndex = savedTransformIndex;
		return activePass;
	}

	/**
	 * Render artboard backgrounds as white filled rectangles
	 * This is called before rendering elements so artboard backgrounds appear behind content
	 */
	private renderArtboardBackgrounds(
		passEncoder: GPURenderPassEncoder,
		artboards: Artboard[],
	): void {
		if (artboards.length === 0) return;

		const buf = new ElementVertexBuffer(0);

		const r = 1.0,
			g = 1.0,
			b = 1.0,
			a = 1.0;

		for (const artboard of artboards) {
			const { minX, minY, maxX, maxY } = getArtboardBounds(artboard);

			// Two triangles for a filled rectangle (triangle-list topology)
			buf.pushFill(minX, minY, r, g, b, a);
			buf.pushFill(maxX, minY, r, g, b, a);
			buf.pushFill(minX, maxY, r, g, b, a);
			buf.pushFill(maxX, minY, r, g, b, a);
			buf.pushFill(maxX, maxY, r, g, b, a);
			buf.pushFill(minX, maxY, r, g, b, a);
		}

		if (buf.length === 0) return;

		const vertexData = buf.toFloat32Array();
		const vertexBuffer = this.device.createBuffer({
			label: "Artboard Backgrounds Vertex Buffer",
			size: vertexData.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
		});

		this.device.queue.writeBuffer(
			vertexBuffer,
			0,
			vertexData.buffer,
			vertexData.byteOffset,
			vertexData.byteLength,
		);

		passEncoder.setVertexBuffer(0, vertexBuffer);
		for (let i = 0; i < artboards.length; i++) {
			passEncoder.draw(6, 1, i * 6, 0);
		}
	}

	private ensureDotGridPipeline(): void {
		if (this.dotGridPipeline) return;

		const { module, uniformViews } = compileShaderModule(this.device, {
			label: "Dot Grid Background",
			code: DOT_GRID_SHADER,
		});
		const view = uniformViews.u;
		const uniformBuffer = this.device.createBuffer({
			label: "Dot Grid Uniform Buffer",
			size: view.arrayBuffer.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		const bindGroupLayout = this.device.createBindGroupLayout({
			label: "Dot Grid Bind Group Layout",
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.FRAGMENT,
					buffer: { type: "uniform" },
				},
			],
		});
		this.dotGridUniformView = view;
		this.dotGridUniformBuffer = uniformBuffer;
		this.dotGridBindGroup = this.device.createBindGroup({
			label: "Dot Grid Bind Group",
			layout: bindGroupLayout,
			entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
		});
		this.dotGridPipeline = createFullscreenPipeline({
			device: this.device,
			label: "Dot Grid Pipeline",
			shaderModule: module,
			pipelineLayout: this.device.createPipelineLayout({
				label: "Dot Grid Pipeline Layout",
				bindGroupLayouts: [bindGroupLayout],
			}),
			targetFormat: this.canvasFormat,
			// Premultiplied-over, matching the final blit pass's blit pipeline.
			blend: {
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
			},
			// The final blit pass carries a depth24plus-stencil8 attachment; a no-op
			// depth/stencil keeps this pipeline compatible with it.
			depthStencil: {
				format: "depth24plus-stencil8",
				depthWriteEnabled: false,
				depthCompare: "always",
			},
			multisampleCount: 1,
		});
	}

	private drawDotGridBackground(
		pass: GPURenderPassEncoder,
		targetWidth: number,
		targetHeight: number,
		viewport: Viewport | null,
	): void {
		if (!viewport) return;
		this.ensureDotGridPipeline();
		const view = this.dotGridUniformView;
		const buffer = this.dotGridUniformBuffer;
		if (!view || !buffer || !this.dotGridPipeline || !this.dotGridBindGroup) {
			return;
		}

		// @builtin(position) is in target (backing-store) pixels, which currently
		// match CSS pixels, so on-screen spacing equals the pixel spacing below.
		const spacingPx = CanvasLayer.DOT_GRID_SPACING_PX;
		const radiusPx = CanvasLayer.DOT_GRID_RADIUS_PX;

		// Anchor the lattice phase to the world origin's screen projection so the
		// dots pan with the canvas while keeping constant on-screen spacing.
		const { phaseX, phaseY } = computeDotGridPhase(
			targetWidth,
			targetHeight,
			viewport,
		);

		const color = CanvasLayer.DOT_GRID_COLOR;
		view.set({
			spacingPx,
			radiusPx,
			phaseX,
			phaseY,
			colorR: color.r,
			colorG: color.g,
			colorB: color.b,
			colorA: color.a,
		});
		this.device.queue.writeBuffer(buffer, 0, view.arrayBuffer);

		pass.setPipeline(this.dotGridPipeline);
		pass.setBindGroup(0, this.dotGridBindGroup);
		pass.draw(3, 1, 0, 0);
	}

	private createClipMaskAtlas(): ClipMaskAtlas {
		return new ClipMaskAtlas({
			device: this.device,
			canvasFormat: this.canvasFormat,
			texturePool: this.texturePool,
			uniformScope: this.uniformScope,
			maskBindGroupLayout: this.maskBindGroupLayout,
			strokePipeline: this.strokePipeline,
			dummyGradientBindGroup: this.dummyGradientBindGroup,
			dummyMaskBindGroup: this.dummyMaskBindGroup,
			getTransformsBindGroup: () => this.transformsBindGroup,
			getTransformIndex: (elementId: string) =>
				this.viewportManager.getTransformIndex(elementId),
			renderElementToMask: (...args) =>
				this.elements.renderElementToMask(...args),
			renderElements: (...args) => this.renderElements(...args),
			paintHash: (element, elementsMap) =>
				computePaintHash(element, elementsMap, {
					resolvePatternTexture: (defId) => this.resolvePatternTexture(defId),
					resolveTextOutline: (el) => this.resolveTextOutline(el),
					isImageReady: (fileUid) =>
						this.assetState.imageTextureCache.has(fileUid),
					hasPreProcessHandler: (processor) =>
						!!this.filterRenderer.getHandler(processor)?.preProcess,
				}),
			viewportState: this.viewportState,
			renderState: this.renderState,
			setActiveBindGroup: (bg, uniformBuffer, replace) => {
				if (bg) {
					if (replace) {
						this.setViewportBinding(bg, uniformBuffer);
					} else {
						this.pushViewportBinding(bg, uniformBuffer);
					}
				} else {
					this.popViewportBinding();
				}
			},
			deferDestroy: (tex) => this.offscreen.deferDestroy(tex),
		});
	}

	/**
	 * Run one synchronous export/offscreen render against a dedicated export
	 * clip-mask atlas, so the interactive atlas's textures are never mutated or
	 * destroyed by the export (fixes the shared-atlas use-after-destroy on
	 * document switch). Must wrap a single synchronous render only — no await
	 * inside `fn` — since the swap is a plain field toggle.
	 */
	public withExportClipMaskAtlas<T>(fn: () => T): T {
		const saved = this.clipMaskAtlas;
		this.clipMaskAtlas = this.exportClipMaskAtlas ??=
			this.createClipMaskAtlas();
		try {
			return fn();
		} finally {
			this.clipMaskAtlas = saved;
		}
	}

	/**
	 * Invalidate cached text paths for one element or the entire cache.
	 */
	public invalidateTextCache(elementId?: string): void {
		this.elements.invalidateTextCache(elementId);
	}

	/**
	 * No-op: document cache was removed — every frame renders directly.
	 * Kept for API compatibility with RenderOrchestrator / Paplico.
	 */
	public invalidateDocumentCache(): void {
		// Force the next viewport-only frame to re-render instead of blitting a
		// now-stale composite (async resource load, external content change).
		this.compositeFrameCache.valid = false;
	}

	/**
	 * Pre-pass hook: rasterize every pattern def referenced by visible elements
	 * so the main pass can sample them through the unified gradient shader's
	 * pattern case. Uses the pattern-band resolution policy (tile world size ×
	 * target scale, clamped 64..2048).
	 */
	public preRenderPatternDefs(
		encoder: GPUCommandEncoder,
		patternDefIdsInUse: ReadonlySet<string>,
	): void {
		if (patternDefIdsInUse.size === 0) return;
		const doc = this.activeDocument;
		if (!doc) return;
		const zoom = this.viewportState.current?.zoom ?? 1;
		for (const defId of patternDefIdsInUse) {
			const entry = doc.defs?.[defId];
			if (!entry || entry.kind !== "pattern" || !entry.tile) continue;
			const revision = this.activeGetDefRevision?.(defId) ?? 1;
			const size = DefRasterizer.resolveTargetSize({
				kind: "pattern",
				tileWorldSize: entry.tile,
				targetScale: Math.max(zoom, 0.5),
			});
			this.defRasterizer.ensureRasterized(
				defId,
				revision,
				size.width,
				size.height,
				(id, w, h) => this.renderDefToTexture(encoder, id, w, h),
			);
		}
	}

	/**
	 * Pre-pass hook: rasterize every def referenced as a brush source by a
	 * visible element's stroke appearance and register the resulting texture
	 * with the BrushTextureManager, so the stamp/ribbon pipelines can bind it
	 * during the main pass. Uses the scatter-band resolution policy (source
	 * world size × zoom, long edge clamped to pow2 64..1024).
	 */
	private preRenderBrushDefs(
		encoder: GPUCommandEncoder,
		brushDefIdsInUse: ReadonlySet<string>,
	): void {
		if (brushDefIdsInUse.size === 0) return;
		const doc = this.activeDocument;
		if (!doc) return;
		const textureManager = this.strokeRegistry?.getBrushTextureManager();
		if (!textureManager) return;
		const elementsMap =
			this.activeElementsMap ?? new Map(Object.entries(doc.objects));
		const zoom = this.viewportState.current?.zoom ?? 1;
		for (const defId of brushDefIdsInUse) {
			// Any DefKind is a valid brush source — pattern defs sample their
			// tile rectangle, vector-brush defs their tight root bbox.
			const entry = doc.defs?.[defId];
			if (!entry) continue;
			const bounds = this.computeDefSourceBounds(entry, elementsMap);
			if (!bounds) continue;
			const revision = this.activeGetDefRevision?.(defId) ?? 1;
			const size = DefRasterizer.resolveTargetSize({
				kind: "scatter",
				worldSize: {
					width: bounds.maxX - bounds.minX,
					height: bounds.maxY - bounds.minY,
				},
				zoom,
			});
			const cached = this.defRasterizer.ensureRasterized(
				defId,
				revision,
				size.width,
				size.height,
				(id, w, h) => this.renderDefToTexture(encoder, id, w, h),
			);
			if (!cached) continue;
			textureManager.registerDefTexture(
				defId,
				cached.textureUid,
				cached.texture,
				size.width,
				size.height,
			);
		}
	}

	/**
	 * Resolve a pattern def to its rasterized tile texture + world-space tile
	 * size for the gradient renderer (case 5 in unified.wgsl). Returns null
	 * when the def is unknown, has no tile, or its rasterized texture is not
	 * yet in the cache.
	 *
	 * Production callers go through preRenderPatternDefs() before the main
	 * pass so the cache is warm by the time element renderers ask for the
	 * texture. For a stale or cold cache the renderer falls back to a
	 * transparent sample without crashing.
	 */
	public resolvePatternTexture(defId: string): {
		texture: GPUTexture;
		tileWorldSize: { width: number; height: number };
		revision: number;
	} | null {
		const doc = this.activeDocument;
		if (!doc) return null;
		const entry = doc.defs?.[defId];
		if (!entry || entry.kind !== "pattern" || !entry.tile) return null;
		const revision = this.activeGetDefRevision?.(defId) ?? 1;
		const zoom = this.viewportState.current?.zoom ?? 1;
		const size = DefRasterizer.resolveTargetSize({
			kind: "pattern",
			tileWorldSize: entry.tile,
			targetScale: Math.max(zoom, 0.5),
		});
		// Lazily rasterize when the cache is cold. This keeps the main pass
		// correct even when a tool composes a new def mid-frame.
		const encoder = this.activeEncoder;
		if (!encoder) return null;
		const cached = this.defRasterizer.ensureRasterized(
			defId,
			revision,
			size.width,
			size.height,
			(id, w, h) => this.renderDefToTexture(encoder, id, w, h),
		);
		if (!cached) return null;
		return {
			texture: cached.texture,
			tileWorldSize: { width: entry.tile.width, height: entry.tile.height },
			revision,
		};
	}

	/**
	 * Synchronous glyph-outline cache lookup for a Text element (local-space
	 * `Path` per non-empty glyph). Null on a cache miss (font still loading) —
	 * callers needing the outline this frame should also call
	 * requestTextOutline to warm the cache for a later one. Mirrors
	 * ElementRenderer.renderElementToMask's own text-case lookup.
	 */
	private resolveTextOutline(
		element: TextElement,
	): { paths: Path[]; localBounds: BoundingBox } | null {
		if (!this.textState.renderer) return null;
		const cacheKey = this.textState.renderer.computeTextCacheKey(element);
		return this.textState.pathCache.get(cacheKey) ?? null;
	}

	/** Fire-and-forget: kick off async font/layout loading so a later frame's
	 *  resolveTextOutline call can hit the cache. Triggers a re-render once
	 *  the cache is warm (unlike ensureTextPaths, which is an awaited
	 *  pre-warm with no render trigger, used for export). */
	private requestTextOutline(element: TextElement): void {
		this.elements.requestTextOutline(element);
	}

	/**
	 * Compute the def-local source rectangle a def is rasterized from:
	 * - "pattern" defs with a valid tile: the tile rectangle centered at the
	 *   origin (element positions are stored already centered).
	 * - other defs (vector-brush sources): best-effort tight bbox of all root
	 *   elements.
	 * Returns null when no bounds can be derived (no resolvable root element).
	 * The resolved tile is returned alongside so callers can branch on the
	 * tiling semantics without re-validating `entry.tile`.
	 */
	private computeDefSourceBounds(
		entry: DefEntry,
		elementsMap: Map<string, AnyArtObject>,
	): {
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
		tile: { width: number; height: number } | null;
	} | null {
		const tile =
			entry.kind === "pattern" &&
			entry.tile &&
			entry.tile.width > 0 &&
			entry.tile.height > 0
				? entry.tile
				: null;
		if (tile) {
			const halfW = tile.width / 2;
			const halfH = tile.height / 2;
			return { minX: -halfW, minY: -halfH, maxX: halfW, maxY: halfH, tile };
		}
		let mnx = Number.POSITIVE_INFINITY;
		let mny = Number.POSITIVE_INFINITY;
		let mxx = Number.NEGATIVE_INFINITY;
		let mxy = Number.NEGATIVE_INFINITY;
		for (const id of entry.rootElementIds) {
			const el = elementsMap.get(id);
			if (!el) continue;
			const b = calculateElementBounds(el, elementsMap);
			if (b.minX < mnx) mnx = b.minX;
			if (b.minY < mny) mny = b.minY;
			if (b.maxX > mxx) mxx = b.maxX;
			if (b.maxY > mxy) mxy = b.maxY;
		}
		if (
			!Number.isFinite(mnx) ||
			!Number.isFinite(mny) ||
			!Number.isFinite(mxx) ||
			!Number.isFinite(mxy)
		) {
			return null;
		}
		return { minX: mnx, minY: mny, maxX: mxx, maxY: mxy, tile: null };
	}

	private applyWetInkPasses(
		compositeContext: CompositeRenderContext,
		path: Path,
		wetPasses: readonly ResolvedAppearancePass[],
		effectiveAlpha: number,
		transformIndex: number,
		renderBufferCacheKey: string,
		pendingCachedResults?: WetInkCachedResultComposite[],
	): void {
		const viewport = this.viewportState.current;
		if (!viewport) return;
		if (!this.strokeRegistry || !this.transformsBindGroup) return;
		const target = compositeContext.targetTexture;
		const worldPerPixel = 1 / Math.max(viewport.zoom, 1e-5);
		if (!this.wetInkPass) {
			this.wetInkPass = new WetInkPass(this.device, this.canvasFormat);
		}
		const ownsCachedResults = pendingCachedResults == null;
		const cachedResults = pendingCachedResults ?? [];
		const flushCachedResults = () => {
			if (cachedResults.length === 0) return;
			this.wetInkPass!.compositeCachedResults(
				compositeContext.encoder,
				cachedResults,
				this.activeProfiler,
			);
			cachedResults.length = 0;
		};
		const worldOriginX = viewport.x - (target.width * worldPerPixel) / 2;
		const worldOriginY = viewport.y + (target.height * worldPerPixel) / 2;
		const composedTransform =
			this.viewportManager.getComposedTransformCache().get(path.id) ??
			path.transform;
		const pathKey = [
			path.id,
			(path.pathStart ?? 0).toFixed(5),
			(path.pathEnd ?? 1).toFixed(5),
			composedTransform.x.toFixed(3),
			composedTransform.y.toFixed(3),
			composedTransform.rotation.toFixed(4),
			composedTransform.scaleX.toFixed(4),
			composedTransform.scaleY.toFixed(4),
			(composedTransform.skewX ?? 0).toFixed(4),
			(composedTransform.skewY ?? 0).toFixed(4),
		].join(":");
		for (let index = 0; index < wetPasses.length; index++) {
			const { appearance, segments: strokeSegments } = wetPasses[index];
			const strokeApp = appearance as StrokeAppearance;
			// The pass carries the deformed geometry (pre-filters + this
			// appearance's own sub-filters), so the simulation runs on the shape
			// the stroke actually draws.
			const strokeCenterBounds = calculatePathBounds({
				...path,
				segments: strokeSegments,
				filters: [],
			});
			const segmentsKey = hashSegmentsWithMetadata(strokeSegments);
			const brush = normalizeBrushSettings(
				strokeApp.paramData.params.brushSettings,
			);
			if (brush.type !== "scatter" && brush.type !== "calligraphy") continue;
			const wetInk = brush.wetInk;
			if (!wetInk?.enabled) continue;
			const simulationBrushSize = Math.max(brush.size, 1);
			const effectBounds = applyTransformToBounds(
				expandBounds(
					strokeCenterBounds,
					brush.size * (0.5 + wetInk.bleedWidth),
				),
				composedTransform,
			);
			const bboxPixelRect = computeWetInkPixelRect(
				effectBounds,
				{ x: worldOriginX, y: worldOriginY },
				worldPerPixel,
				target.width,
				target.height,
			);
			if (bboxPixelRect.width === 0 || bboxPixelRect.height === 0) continue;

			const simulationDomain = resolveWetInkSimulationDomain(
				effectBounds,
				simulationBrushSize,
				this.device.limits.maxTextureDimension2D,
			);
			const simWPP = simulationDomain.worldPerPixel;
			const usesPickup = usesWetInkRenderBufferPickup(wetInk);
			const basePathKey = `${pathKey}:${segmentsKey}:${index}:${hashWetStrokeCacheKey(
				strokeApp,
				effectiveAlpha,
				path,
			)}`;

			for (
				let tileIdx = 0;
				tileIdx < simulationDomain.tiles.length;
				tileIdx++
			) {
				const tile = simulationDomain.tiles[tileIdx];
				const innerWorldMinX = tile.worldOrigin.x + tile.innerOffset.x * simWPP;
				const innerWorldMaxY = tile.worldOrigin.y - tile.innerOffset.y * simWPP;
				const innerWorldMaxX = innerWorldMinX + tile.innerSize.width * simWPP;
				const innerWorldMinY = innerWorldMaxY - tile.innerSize.height * simWPP;
				const innerBounds: BoundingBox = {
					minX: innerWorldMinX,
					minY: innerWorldMinY,
					maxX: innerWorldMaxX,
					maxY: innerWorldMaxY,
					width: innerWorldMaxX - innerWorldMinX,
					height: innerWorldMaxY - innerWorldMinY,
				};
				const tileBboxPixelRect = computeWetInkPixelRect(
					innerBounds,
					{ x: worldOriginX, y: worldOriginY },
					worldPerPixel,
					target.width,
					target.height,
				);
				if (tileBboxPixelRect.width === 0 || tileBboxPixelRect.height === 0)
					continue;

				const tileKeySuffix =
					simulationDomain.tiles.length > 1 ? `:t${tileIdx}` : "";
				const contentKey = buildWetInkSimCacheKey({
					pathKey: `${basePathKey}${tileKeySuffix}`,
					settings: wetInk,
					randomSeed: brush.randomSeed ?? 0,
					brushSize: brush.size,
					domainWorldOrigin: tile.worldOrigin,
					domainWorldSize: {
						width: tile.textureSize.width * simWPP,
						height: tile.textureSize.height * simWPP,
					},
					domainTextureSize: tile.textureSize,
					domainWorldPerPixel: simWPP,
				});
				const cacheKey = usesPickup
					? `${contentKey}|rb:${renderBufferCacheKey}`
					: contentKey;
				const compositeParams = {
					target,
					bboxPixelRect: tileBboxPixelRect,
					domainTextureSize: tile.textureSize,
					domainWorldOrigin: tile.worldOrigin,
					domainWorldPerPixel: simWPP,
					targetWorldOrigin: { x: worldOriginX, y: worldOriginY },
					targetWorldPerPixel: worldPerPixel,
					randomSeed: brush.randomSeed ?? 0,
					settings: wetInk,
					cacheKey,
				};
				const driedResult = this.wetInkPass.lookupDried(
					contentKey,
					compositeParams,
				);
				if (driedResult) {
					cachedResults.push(driedResult);
					continue;
				}
				const cachedResult =
					this.wetInkPass.lookupCachedResult(compositeParams);
				if (cachedResult) {
					this.wetInkPass.trackStability(contentKey, cacheKey);
					cachedResults.push(cachedResult);
					continue;
				}
				flushCachedResults();
				const domainViewport = {
					x: tile.worldOrigin.x + (tile.textureSize.width * simWPP) / 2,
					y: tile.worldOrigin.y - (tile.textureSize.height * simWPP) / 2,
					zoom: 1 / simWPP,
					rotation: 0,
				};
				const domainUniform = this.uniformScope.acquire(
					domainViewport,
					tile.textureSize.width,
					tile.textureSize.height,
				);
				const tempUsage =
					GPUTextureUsage.RENDER_ATTACHMENT |
					GPUTextureUsage.TEXTURE_BINDING |
					GPUTextureUsage.COPY_SRC |
					GPUTextureUsage.COPY_DST;
				const pigmentTexture = this.texturePool.acquire(
					tile.textureSize.width,
					tile.textureSize.height,
					"rgba16float",
					1,
					tempUsage,
					"WetInk Isolated Pigment",
				);
				const fluidTexture = this.texturePool.acquire(
					tile.textureSize.width,
					tile.textureSize.height,
					"rgba16float",
					1,
					tempUsage,
					"WetInk Isolated Fluid",
				);
				const flowTexture = this.texturePool.acquire(
					tile.textureSize.width,
					tile.textureSize.height,
					"rgba16float",
					1,
					tempUsage,
					"WetInk Isolated Flow",
				);
				const maskTexture = this.texturePool.acquire(
					tile.textureSize.width,
					tile.textureSize.height,
					"rgba16float",
					1,
					tempUsage,
					"WetInk Isolated Mask",
				);
				const wetPath: Path = {
					...path,
					segments: strokeSegments,
					filters: [strokeApp],
				};
				this.strokeRegistry.renderWetStrokeIsolated({
					commandEncoder: compositeContext.encoder,
					path: wetPath,
					segments: strokeSegments,
					transformsBindGroup: this.transformsBindGroup,
					pigmentView: pigmentTexture.createView(),
					flowView: flowTexture.createView(),
					fluidView: fluidTexture.createView(),
					maskView: maskTexture.createView(),
					scissorRect: {
						x: 0,
						y: 0,
						width: tile.textureSize.width,
						height: tile.textureSize.height,
					},
					viewportUniformBuffer: domainUniform.buffer,
					alphaMultiplier: effectiveAlpha * strokeApp.opacity,
					viewportBounds: effectBounds,
					transformIndex,
				});

				this.wetInkPass.apply(
					compositeContext.encoder,
					{
						...compositeParams,
						pigmentView: pigmentTexture.createView(),
						flowView: flowTexture.createView(),
						fluidView: fluidTexture.createView(),
						maskView: maskTexture.createView(),
						renderBufferView: target.createView(),
						brushSize: brush.size,
					},
					this.activeProfiler,
				);
				this.wetInkPass.trackStability(contentKey, cacheKey);
				this.texturePool.release(pigmentTexture);
				this.texturePool.release(flowTexture);
				this.texturePool.release(fluidTexture);
				this.texturePool.release(maskTexture);
			}
		}
		if (ownsCachedResults) flushCachedResults();
	}

	/**
	 * Rasterize one DefEntry's rootElementIds tree into a freshly created
	 * GPUTexture sized `width x height`. Returns null when the def cannot be
	 * resolved yet (still missing renderer wiring for off-canvas viewport
	 * pushes; the production path is wired up by the pattern feature).
	 */
	public renderDefToTexture(
		encoder: GPUCommandEncoder,
		defId: string,
		width: number,
		height: number,
	): GPUTexture | null {
		if (width <= 0 || height <= 0) return null;
		const doc = this.activeDocument;
		if (!doc) return null;
		const entry = doc.defs?.[defId];
		if (!entry) return null;
		const elementsMap =
			this.activeElementsMap ?? new Map(Object.entries(doc.objects));

		// Resolve the root elements that compose this def. Missing IDs are
		// skipped silently (defensive — defs should always reference live
		// objects, but a remote peer may briefly desync).
		const rootElements: AnyArtObject[] = [];
		for (const id of entry.rootElementIds) {
			const el = elementsMap.get(id);
			if (el) rootElements.push(el);
		}
		if (rootElements.length === 0) return null;

		// Compute the source rectangle in def-local world space (tile rectangle
		// for pattern defs, tight root-element bbox for vector-brush sources).
		const sourceBounds = this.computeDefSourceBounds(entry, elementsMap);
		if (!sourceBounds) return null;
		const { minX, minY, maxX, maxY, tile } = sourceBounds;
		const srcW = Math.max(1e-6, maxX - minX);
		const srcH = Math.max(1e-6, maxY - minY);
		const zoom = Math.min(width / srcW, height / srcH);
		if (!Number.isFinite(zoom) || zoom <= 0) return null;
		const cx = (minX + maxX) / 2;
		const cy = (minY + maxY) / 2;

		// Persistent texture (NOT from texturePool — DefRasterizer keeps it
		// alive across frames). Cleared to transparent so unpainted pixels
		// blend correctly when sampled by the pattern shader.
		const texture = this.device.createTexture({
			label: `Def Rasterize Texture (${defId})`,
			size: [width, height, 1],
			format: this.canvasFormat,
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST,
		});

		// Sized to match the colour target exactly. The pool would round
		// up to its quantization step and produce a depth attachment whose
		// width / height disagree with the colour attachment, which the
		// renderpass validator rejects (the colour texture is created at
		// the exact `width × height` requested by the caller).
		const stencilTexture = this.device.createTexture({
			label: `Def Rasterize Stencil (${defId})`,
			size: [width, height, 1],
			format: "depth24plus-stencil8",
			sampleCount: MSAA_SAMPLE_COUNT,
			usage: GPUTextureUsage.RENDER_ATTACHMENT,
		});

		// Pattern defs need seamless wrap so elements that straddle the tile
		// boundary appear on the opposite side. We achieve this by drawing
		// the element set into nine adjacent tile cells (center + 8
		// neighbors) and clipping to the tile rectangle via the bound
		// viewport. Each cell is rendered through its own viewport shifted
		// by a multiple of the tile size — this avoids cloning the element
		// graph or rebuilding the transforms buffer, which would be
		// significantly more invasive.
		//
		// Non-pattern defs (vector-brush sources) only draw the center cell
		// since they have no tiling semantics.
		const tileOffsets: Array<{ dx: number; dy: number }> = tile
			? [
					{ dx: 0, dy: 0 },
					{ dx: tile.width, dy: 0 },
					{ dx: -tile.width, dy: 0 },
					{ dx: 0, dy: tile.height },
					{ dx: 0, dy: -tile.height },
					{ dx: tile.width, dy: tile.height },
					{ dx: tile.width, dy: -tile.height },
					{ dx: -tile.width, dy: tile.height },
					{ dx: -tile.width, dy: -tile.height },
				]
			: [{ dx: 0, dy: 0 }];

		const emptyFilteredTextures = new Map<string, FilteredTextureInfo>();
		const savedViewport = this.viewportState.current;
		const savedViewportWidth = this.viewportState.width;
		const savedViewportHeight = this.viewportState.height;
		const savedViewportBounds = this.viewportState.bounds;
		this.viewportState.bounds = null;

		// Initial pipeline state mirrors the main pass so element dispatch
		// reuses the same shared bind groups.
		const renderCell = (
			passEncoder: GPURenderPassEncoder,
			entryBindGroup: GPUBindGroup,
			tempViewport: Viewport,
		) => {
			this.viewportState.current = tempViewport;
			this.viewportState.width = width;
			this.viewportState.height = height;
			this.viewportState.bounds = null;
			passEncoder.setPipeline(this.strokePipeline);
			passEncoder.setBindGroup(0, entryBindGroup);
			if (this.transformsBindGroup) {
				passEncoder.setBindGroup(1, this.transformsBindGroup);
			}
			passEncoder.setBindGroup(2, this.dummyGradientBindGroup);
			passEncoder.setBindGroup(3, this.dummyMaskBindGroup);
			this.renderElements(
				passEncoder,
				rootElements,
				emptyFilteredTextures,
				elementsMap,
				1.0,
				null,
				undefined,
				"offscreen",
			);
		};

		for (let i = 0; i < tileOffsets.length; i++) {
			const { dx, dy } = tileOffsets[i];
			// Shifting the camera by +dx/+dy makes content draw at -dx/-dy in
			// screen space, so to make the element appear at world (+dx,+dy)
			// we move the camera by (-dx,-dy).
			const tempViewport = {
				x: cx - dx,
				y: cy - dy,
				zoom,
				rotation: 0,
			} satisfies Viewport;
			const entryUniform = this.uniformScope.acquire(
				tempViewport,
				width,
				height,
			);
			this.pushViewportBinding(entryUniform.bindGroup, entryUniform.buffer);

			const passEncoder = encoder.beginRenderPass({
				label: `Def Rasterize Pass (${defId}) [${i === 0 ? "center" : `wrap ${dx},${dy}`}]`,
				colorAttachments: [
					{
						view: texture.createView(),
						clearValue: { r: 0, g: 0, b: 0, a: 0 },
						// First pass clears; subsequent passes load the previous
						// cells so the final texture is the union of all 9 draws.
						loadOp: i === 0 ? "clear" : "load",
						storeOp: "store",
					},
				],
				depthStencilAttachment: {
					view: stencilTexture.createView(),
					depthClearValue: 1.0,
					depthLoadOp: "clear",
					depthStoreOp: "discard",
					stencilClearValue: 0,
					stencilLoadOp: "clear",
					stencilStoreOp: "discard",
				},
			});

			renderCell(passEncoder, entryUniform.bindGroup, tempViewport);
			passEncoder.end();
			this.popViewportBinding();
		}

		this.offscreen.deferDestroy(stencilTexture);
		this.viewportState.current = savedViewport;
		this.viewportState.width = savedViewportWidth;
		this.viewportState.height = savedViewportHeight;
		this.viewportState.bounds = savedViewportBounds;
		this.restoreViewportUniformsToGPU();

		return texture;
	}

	/**
	 * Cleanup resources
	 */
	private acquireBackdropBlitBuffer(): GPUBuffer {
		if (this.backdropBlitPool.index < this.backdropBlitPool.buffers.length) {
			return this.backdropBlitPool.buffers[this.backdropBlitPool.index++];
		}
		const buf = this.device.createBuffer({
			label: `Backdrop Blit Uniform Buffer [pool ${this.backdropBlitPool.buffers.length}]`,
			size: 16 * 4, // 16 floats (12 base + 4 outer mask bounds)
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.backdropBlitPool.buffers.push(buf);
		this.backdropBlitPool.index++;
		return buf;
	}

	public destroy(): void {
		this.postProcessIntermediate?.destroy();
		this.postProcessIntermediate = null;
		this.compositeFrameCache.texture?.destroy();
		this.compositeFrameCache.texture = null;
		this.compositeFrameCache.valid = false;
		this.exposureBindGroup = null;
		this.exposureBindGroupSourceView = null;
		this.exposureUniformBuffer.destroy();
		this.softProofPass.destroy();
		this.wetInkPass?.destroy();
		this.wetInkPass = null;
		this.backdropCaptureManager.destroy();
		this.backdropEffectCoordinator.destroy();

		// Release this canvas's backdrop-composite drivers held by filter handlers.
		for (const handler of this.filterRenderer.getHandlers().values()) {
			handler.detachCanvas?.(this.canvasId);
		}
		this.backdropDrivers = [];

		// Cleanup viewport manager (transforms buffer)
		this.viewportManager.destroy();

		// Cleanup per-pass uniform buffer pool
		this.uniformScope.destroy();

		// Cleanup sub-renderer pools
		this.clipMaskAtlas.destroy();
		this.exportClipMaskAtlas?.destroy();
		this.defRasterizer.destroy();
		this.composite.destroy();
		this.offscreen.destroy();
		this.texturePool.destroy();
		this.geometryStore.destroy();
		this.runBatcher.destroy();
		for (const buf of this.backdropBlitPool.buffers) buf.destroy();
		this.backdropBlitPool.buffers.length = 0;

		// Cleanup stencil textures (every size generation the slots hold)
		destroyStencilState(this.stencil);

		this.compositeState.captureTexture?.destroy();
		this.compositeState.captureTexture = null;
		this.compositeState.layerTexture?.destroy();
		this.compositeState.layerTexture = null;
		this.compositeState.prebufTexture?.destroy();
		this.compositeState.prebufTexture = null;
		this.compositeState.canvasBaseTexture?.destroy();
		this.compositeState.canvasBaseTexture = null;
		destroyStencilState(this.compositeState.finalBlitStencil);
		this.compositeState.backdropMask.texture?.destroy();
		this.compositeState.backdropMask.texture = null;
		this.compositeState.backdropMask.width = 0;
		this.compositeState.backdropMask.height = 0;
		destroyStencilState(this.compositeState.backdropMaskStencil);
		this.compositeState.width = 0;
		this.compositeState.height = 0;

		// Cleanup texture cache
		for (const texture of this.assetState.textureCache.values()) {
			texture.destroy();
		}
		this.assetState.textureCache.clear();

		// Cleanup image texture cache
		for (const texture of this.assetState.imageTextureCache.values()) {
			texture.destroy();
		}
		this.assetState.imageTextureCache.clear();
		this.assetState.pendingImageLoads.clear();

		// Cleanup gradient resources
		this.gradient.textureGenerator.destroy();
		this.gradient.meshTextureGenerator.destroy();
		this.gradient.placeholderTexture.destroy();
		this.gradient.placeholderStorageBuffer.destroy();
		for (const entry of this.gradient.bufferPool) {
			entry.uniformBuffer.destroy();
			entry.stopsBuffer.destroy();
			entry.vertexBuffer.destroy();
		}
		this.gradient.bufferPool.length = 0;

		// Cleanup text path cache
		this.textState.pathCache.clear();
		this.textState.pendingPathCacheKeys.clear();
		this.cacheManager.clearAll();
	}
}

function computeWetInkPixelRect(
	bounds: BoundingBox,
	viewportWorldOrigin: { x: number; y: number },
	worldPerPixel: number,
	textureWidth: number,
	textureHeight: number,
): { x: number; y: number; width: number; height: number } {
	const pixelsPerWorld = 1 / Math.max(worldPerPixel, 1e-5);
	const minX = Math.floor(
		(bounds.minX - viewportWorldOrigin.x) * pixelsPerWorld,
	);
	const minY = Math.floor(
		(viewportWorldOrigin.y - bounds.maxY) * pixelsPerWorld,
	);
	const maxX = Math.ceil(
		(bounds.maxX - viewportWorldOrigin.x) * pixelsPerWorld,
	);
	const maxY = Math.ceil(
		(viewportWorldOrigin.y - bounds.minY) * pixelsPerWorld,
	);
	const x = Math.max(0, Math.min(textureWidth, minX));
	const y = Math.max(0, Math.min(textureHeight, minY));
	const xEnd = Math.max(0, Math.min(textureWidth, maxX));
	const yEnd = Math.max(0, Math.min(textureHeight, maxY));
	return {
		x,
		y,
		width: Math.max(0, xEnd - x),
		height: Math.max(0, yEnd - y),
	};
}

function usesWetInkRenderBufferPickup(
	settings: WetInkSettings | undefined,
): boolean {
	return (
		settings?.pickupUnderlyingColor === true &&
		(settings.pickupStrength ?? DEFAULT_WET_INK_PICKUP_STRENGTH) > 0
	);
}

function hashWetStrokeCacheKey(
	strokeApp: StrokeAppearance,
	effectiveAlpha: number,
	path: Path,
): string {
	return hashString(
		JSON.stringify({
			enabled: strokeApp.enabled,
			opacity: strokeApp.opacity,
			effectiveAlpha,
			params: strokeApp.paramData.params,
			subFilters: strokeApp.subFilters,
			pathStart: path.pathStart ?? 0,
			pathEnd: path.pathEnd ?? 1,
		}),
	).toString(36);
}

function buildWetInkRenderBufferCacheKey(
	elements: readonly AnyArtObject[],
): string {
	return hashString(JSON.stringify(elements)).toString(36);
}

function hashString(value: string): number {
	let h = 0;
	for (let i = 0; i < value.length; i++) {
		h = (h * 31 + value.charCodeAt(i)) | 0;
	}
	return h;
}

const WET_INK_MAX_SIMULATION_WORLD_PER_TEXEL = 1;
const WET_INK_SIMULATION_TEXELS_PER_BRUSH_SIZE = 96;
const WET_INK_MIN_SIMULATION_WORLD_PER_TEXEL = 0.125;
const WET_INK_MAX_SIMULATION_TEXTURE_SIDE = 2048;
const WET_INK_TILE_OVERLAP_TEXELS = 48;

type WetInkSimulationTile = {
	worldOrigin: { x: number; y: number };
	textureSize: { width: number; height: number };
	innerOffset: { x: number; y: number };
	innerSize: { width: number; height: number };
};

function resolveWetInkSimulationDomain(
	bounds: BoundingBox,
	brushSize: number,
	deviceMaxTextureSide: number,
): {
	tiles: WetInkSimulationTile[];
	worldPerPixel: number;
} {
	const maxSide = Math.max(
		1,
		Math.min(WET_INK_MAX_SIMULATION_TEXTURE_SIDE, deviceMaxTextureSide),
	);
	const brushWorldPerPixel =
		Math.max(brushSize, 1) / WET_INK_SIMULATION_TEXELS_PER_BRUSH_SIZE;
	const worldPerPixel = Math.max(
		WET_INK_MIN_SIMULATION_WORLD_PER_TEXEL,
		Math.min(WET_INK_MAX_SIMULATION_WORLD_PER_TEXEL, brushWorldPerPixel),
	);
	const fullWidth = Math.max(1, Math.ceil(bounds.width / worldPerPixel));
	const fullHeight = Math.max(1, Math.ceil(bounds.height / worldPerPixel));

	if (fullWidth <= maxSide && fullHeight <= maxSide) {
		return {
			tiles: [
				{
					worldOrigin: { x: bounds.minX, y: bounds.maxY },
					textureSize: { width: fullWidth, height: fullHeight },
					innerOffset: { x: 0, y: 0 },
					innerSize: { width: fullWidth, height: fullHeight },
				},
			],
			worldPerPixel,
		};
	}

	const overlap = WET_INK_TILE_OVERLAP_TEXELS;
	const tileInner = Math.max(1, maxSide - 2 * overlap);
	const numTilesX = Math.max(1, Math.ceil(fullWidth / tileInner));
	const numTilesY = Math.max(1, Math.ceil(fullHeight / tileInner));
	const tiles: WetInkSimulationTile[] = [];

	for (let ty = 0; ty < numTilesY; ty++) {
		for (let tx = 0; tx < numTilesX; tx++) {
			const innerStartX = tx * tileInner;
			const innerStartY = ty * tileInner;
			const innerW = Math.min(tileInner, fullWidth - innerStartX);
			const innerH = Math.min(tileInner, fullHeight - innerStartY);
			if (innerW <= 0 || innerH <= 0) continue;

			const padStartX = Math.max(0, innerStartX - overlap);
			const padStartY = Math.max(0, innerStartY - overlap);
			const padEndX = Math.min(fullWidth, innerStartX + innerW + overlap);
			const padEndY = Math.min(fullHeight, innerStartY + innerH + overlap);
			const texW = padEndX - padStartX;
			const texH = padEndY - padStartY;

			tiles.push({
				worldOrigin: {
					x: bounds.minX + padStartX * worldPerPixel,
					y: bounds.maxY - padStartY * worldPerPixel,
				},
				textureSize: { width: texW, height: texH },
				innerOffset: {
					x: innerStartX - padStartX,
					y: innerStartY - padStartY,
				},
				innerSize: { width: innerW, height: innerH },
			});
		}
	}

	return { tiles, worldPerPixel };
}

// ---------------------------------------------------------------------------
// Clip mask helpers
// ---------------------------------------------------------------------------

/**
 * Build a hash from group appearance filters and their sub-filters
 * so that any parameter change (color, size, offset, etc.) produces
 * a different cache key for the temp path used in group rendering.
 */
function hashGroupAppearanceFingerprint(
	appearances: Filter[],
	groupFilters: Filter[] | undefined,
): number {
	let h = 0;

	// Hash each appearance's params (covers strokeColor, fill, brushSettings)
	for (const app of appearances) {
		h = (h * 31 + app.opacity * 1000) | 0;
		hashJson(app.paramData.params);

		// Hash sub-filter params (PathOffset offset value, etc.)
		for (const sf of app.subFilters ?? []) {
			if (sf.enabled === false) continue;
			hashJson(sf.paramData.params);
		}
	}

	// Hash top-level pre-filter params (zigzag, etc.)
	for (const f of groupFilters ?? []) {
		if (
			f.processor === "fill" ||
			f.processor === "stroke" ||
			f.processor === "content" ||
			f.enabled === false
		)
			continue;
		hashJson(f.paramData.params);
	}

	return h;

	function hashJson(obj: unknown): void {
		const json = JSON.stringify(obj);
		for (let i = 0; i < json.length; i++) {
			h = (h * 31 + json.charCodeAt(i)) | 0 | 0;
		}
	}
}

/** Shared inputs for the world-bounds walk both mask collectors perform. */
interface WorldBoundsContext {
	elementsMap: Map<string, AnyArtObject>;
	localBoundsCache?: LocalBoundsCache;
	parentGroupMap?: ReadonlyMap<string, string>;
	composedTransformCache?: ReadonlyMap<string, ElementTransform>;
}

/** An element whose `ArtObject.mask` needs a mask texture this frame. */
interface ObjectMaskEntry {
	ownerId: string;
	/** Root elements of the mask content, in draw order. */
	sources: AnyArtObject[];
	/** World-space bounds of the masked element. */
	ownerBounds: BoundingBox;
	inverted: boolean;
}

/**
 * Walk elementsMap and collect all Groups that have a clipPathId set.
 * Returns one entry per clip group (multiple groups may share a clipPathId).
 */
function collectClipGroups(
	ctx: WorldBoundsContext,
	viewportBounds: BoundingBox | null,
	/** Report where the group actually paints, when that exceeds its element
	 *  bounds (a group filter's expansion margin, a 3D solid's projection), so a
	 *  group whose effect spills into view is not culled by its flat bounds. */
	expandToRenderedExtent?: (
		element: AnyArtObject,
		union: (bounds: BoundingBox) => void,
	) => void,
): ClipGroupEntry[] {
	const { elementsMap } = ctx;
	const parentGroupMap = resolveParentGroupMap(ctx);

	const groups: ClipGroupEntry[] = [];
	for (const [, element] of elementsMap) {
		if (!isGroup(element) || element.clipPathId == null) continue;
		const clipPath = elementsMap.get(element.clipPathId);
		if (!clipPath) continue;

		const groupBounds = computeWorldBounds(element, ctx, parentGroupMap);

		// Cull against the rendered extent (flat bounds unioned with any filter
		// spread), not the flat bounds, or a group whose effect reaches into view
		// while its geometry sits just off-screen would be dropped. The atlas
		// layer is still sized to the clip region (groupBounds) below.
		let cullBounds: BoundingBox = groupBounds;
		expandToRenderedExtent?.(element, (b) => {
			cullBounds = unionBounds(cullBounds, b);
		});

		// Skip clip groups entirely outside the viewport to avoid
		// allocating atlas layers for invisible masks.
		if (viewportBounds && !boundsIntersect(cullBounds, viewportBounds)) {
			continue;
		}

		groups.push({
			groupId: element.id,
			clipPathId: element.clipPathId,
			clipPath,
			groupBounds,
		});
	}
	return groups;
}

/**
 * Walk elementsMap and collect every element carrying an enabled
 * `ArtObject.mask` with at least one surviving source.
 *
 * An enabled mask with no resolvable sources is deliberately NOT collected:
 * without a mask texture the element renders unmasked, which reads as "the
 * mask does nothing" rather than "everything disappeared". A freshly added,
 * still-empty mask is exactly that case.
 */
function collectObjectMasks(
	ctx: WorldBoundsContext,
	viewportBounds: BoundingBox | null,
	/** Report where the owner actually paints, when that exceeds its element
	 *  bounds (a 3D solid's projection, a filter's expansion margin). */
	expandToRenderedExtent?: (
		element: AnyArtObject,
		union: (bounds: BoundingBox) => void,
	) => void,
): ObjectMaskEntry[] {
	const { elementsMap } = ctx;
	const parentGroupMap = resolveParentGroupMap(ctx);

	const masks: ObjectMaskEntry[] = [];
	for (const [, element] of elementsMap) {
		const mask = element.mask;
		if (!mask || mask.enabled === false) continue;

		const sources: AnyArtObject[] = [];
		for (const id of mask.elementIds) {
			const source = elementsMap.get(id);
			if (source) sources.push(source);
		}
		if (sources.length === 0) continue;

		// Everything outside the mask texture reads as uncovered, so the texture
		// has to span everywhere the owner puts pixels — and no further, since
		// that is the only place a mask changes anything. Content reaching past
		// the owner is cropped here rather than enlarging the texture: past a
		// size limit the atlas falls back to clipping against the viewport, and
		// then the owner itself gets cut and vanishes where the mask stops.
		//
		// The owner's element bounds are its flat footprint, which a 3D solid
		// paints well beyond, so its rendered extent is unioned in.
		let ownerBounds = computeWorldBounds(element, ctx, parentGroupMap);
		expandToRenderedExtent?.(element, (b) => {
			ownerBounds = unionBounds(ownerBounds, b);
		});

		if (viewportBounds && !boundsIntersect(ownerBounds, viewportBounds)) {
			continue;
		}

		masks.push({
			ownerId: element.id,
			sources,
			ownerBounds,
			inverted: mask.inverted === true,
		});
	}
	return masks;
}

/** Reuse the cached child→parent map when available, otherwise build one. */
function resolveParentGroupMap(
	ctx: WorldBoundsContext,
): ReadonlyMap<string, string> {
	if (ctx.parentGroupMap && ctx.parentGroupMap.size > 0) {
		return ctx.parentGroupMap;
	}
	const built = new Map<string, string>();
	for (const [, el] of ctx.elementsMap) {
		if (isGroup(el)) {
			for (const childId of el.childIds) built.set(childId, el.id);
		}
	}
	return built;
}

/**
 * Every element drawn while building the object masks: each mask's roots plus
 * everything nested under them. Rendering these is a side effect of building
 * the mask, so anything the draw registered for later compositing has to be
 * undone with this set.
 */
function collectMaskContentIds(
	objectMasks: ObjectMaskEntry[],
	elementsMap: Map<string, AnyArtObject>,
): Set<string> {
	const collected = new Set<string>();
	const stack = objectMasks.flatMap((entry) =>
		entry.sources.map((source) => source.id),
	);

	for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
		if (collected.has(id)) continue;
		const element = elementsMap.get(id);
		if (!element) continue;
		collected.add(id);
		for (const childId of getContainerChildIds(element) ?? []) {
			stack.push(childId);
		}
		// A mask's content can itself carry a mask, and drawing the outer one
		// draws the inner one too. Missing that edge leaves the nested content
		// registered, so a solid two masks deep composites onto the document.
		for (const nestedId of element.mask?.elementIds ?? []) {
			stack.push(nestedId);
		}
	}

	return collected;
}

/** Smallest box containing both. */
function unionBounds(a: BoundingBox, b: BoundingBox): BoundingBox {
	const minX = Math.min(a.minX, b.minX);
	const minY = Math.min(a.minY, b.minY);
	const maxX = Math.max(a.maxX, b.maxX);
	const maxY = Math.max(a.maxY, b.maxY);
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Element bounds with every ancestor transform composed in, i.e. world space. */
function computeWorldBounds(
	element: AnyArtObject,
	ctx: WorldBoundsContext,
	parentGroupMap: ReadonlyMap<string, string>,
): BoundingBox {
	let bounds = calculateElementBounds(
		element,
		ctx.elementsMap,
		ctx.localBoundsCache,
	);
	const parentId = parentGroupMap.get(element.id);
	if (parentId && ctx.composedTransformCache) {
		const parentComposed = ctx.composedTransformCache.get(parentId);
		if (parentComposed && !isIdentityTransform(parentComposed)) {
			bounds = applyTransformToBounds(bounds, parentComposed);
		}
		return bounds;
	}
	let ancestorId = parentId;
	while (ancestorId) {
		const ancestor = ctx.elementsMap.get(ancestorId);
		if (ancestor) {
			const t = getTransform(ancestor);
			if (!isIdentityTransform(t)) {
				bounds = applyTransformToBounds(bounds, t);
			}
		}
		ancestorId = parentGroupMap.get(ancestorId);
	}
	return bounds;
}

/**
 * Build a mapping from element ID → clip mask layer info.
 *
 * For each clip group, all direct children (excluding the clip path itself)
 * and their non-clip descendants are assigned the mask.  Nested clip groups
 * (sub-groups that have their own clipPathId) stop the recursion — their
 * children receive a separate mask assignment.
 *
 * Layer indices are assigned via insertion-order deduplication of clipPathId,
 * matching the order used by ClipMaskAtlas.preRender().
 */
function buildMaskAssignment(
	clipGroups: ClipGroupEntry[],
	objectMasks: ObjectMaskEntry[],
	elementsMap: Map<string, AnyArtObject>,
	atlas: ClipMaskAtlas,
	drawsViaTexture: (element: AnyArtObject) => boolean,
	dependsOnBackdrop: (element: AnyArtObject) => boolean,
	filterPlanIds: ReadonlySet<string>,
): {
	assignment: Map<string, AssignedMask>;
	maskApplicationPlans: Map<string, MaskApplicationPlan>;
	groupCompositionPlans: Map<string, GroupCompositionPlan>;
	masksByKey: Map<string, AssignedMask>;
} {
	const assignment = new Map<string, AssignedMask>();
	const maskApplicationPlans = new Map<string, MaskApplicationPlan>();
	const groupCompositionPlans = new Map<string, GroupCompositionPlan>();
	const masksByKey = new Map<string, AssignedMask>();
	const maskStacks = new Map<string, PlannedMask[]>();
	const parentGroupMap = resolveParentGroupMap({ elementsMap });
	const clipGroupIds = new Set(clipGroups.map((entry) => entry.groupId));
	const objectMaskOwnerIds = new Set(objectMasks.map((entry) => entry.ownerId));

	const sortedClipGroups = [...clipGroups].sort(
		(a, b) =>
			getGroupDepth(a.groupId, parentGroupMap) -
			getGroupDepth(b.groupId, parentGroupMap),
	);
	for (const entry of sortedClipGroups) {
		const key = clipMaskKey(entry.clipPathId);
		const maskEntry = atlas.getMaskEntry(key);
		if (!maskEntry) continue;
		masksByKey.set(key, maskEntry);

		const group = elementsMap.get(entry.groupId);
		if (!group || !isGroup(group)) continue;
		const stack = [
			...(maskStacks.get(group.id) ?? []),
			plannedMask(key, maskEntry),
		];
		for (const childId of group.childIds) {
			if (childId === group.clipPathId) continue;
			assignMaskStackRecursive(childId, stack, elementsMap, maskStacks);
		}
	}

	for (const entry of objectMasks) {
		const key = objectMaskKey(entry.ownerId);
		const maskEntry = atlas.getMaskEntry(key);
		if (!maskEntry) continue;
		const owner = elementsMap.get(entry.ownerId);
		if (!owner) continue;

		const assigned = { ...maskEntry, inverted: entry.inverted };
		masksByKey.set(key, assigned);
		maskStacks.set(entry.ownerId, [
			...(maskStacks.get(entry.ownerId) ?? []),
			plannedMask(key, assigned),
		]);
	}

	for (const element of elementsMap.values()) {
		if (!isGroup(element)) continue;
		groupCompositionPlans.set(
			element.id,
			planGroupComposition({
				hasOwnMask: objectMaskOwnerIds.has(element.id),
				hasOwnClip: clipGroupIds.has(element.id),
				hasOpacity: (element.opacity ?? 1) !== 1,
				hasFilter: filterPlanIds.has(element.id),
				dependsOnBackdrop: dependsOnBackdrop(element),
			}),
		);
	}

	for (const [elementId, masks] of maskStacks) {
		const element = elementsMap.get(elementId);
		if (!element) continue;
		const groupPlan = isGroup(element)
			? groupCompositionPlans.get(elementId)
			: undefined;
		const plan = planMaskApplication({
			node: isGroup(element) ? "subtree" : "leaf",
			masks,
			outputPlacement: dependsOnBackdrop(element) ? "world-quad" : "world-aabb",
			hasPostFilter: filterPlanIds.has(element.id),
			requiresSubtreeBoundary:
				drawsViaTexture(element) ||
				(groupPlan != null && groupPlanRequiresSurface(groupPlan)),
		});
		maskApplicationPlans.set(elementId, plan);
		if (plan.kind !== "inline-leaf") continue;
		const maskEntry = masksByKey.get(plan.mask.key);
		if (maskEntry) assignment.set(elementId, maskEntry);
	}

	return {
		assignment,
		maskApplicationPlans,
		groupCompositionPlans,
		masksByKey,
	};
}

function plannedMask(key: string, mask: AssignedMask): PlannedMask {
	return {
		key,
		coverage: {
			kind: "world-aabb",
			bounds: mask.bounds,
			uvRect: FULL_BLIT_UV_RECT,
		},
		inverted: mask.inverted ?? false,
	};
}

function getGroupDepth(
	elementId: string,
	parentGroupMap: ReadonlyMap<string, string>,
): number {
	let depth = 0;
	let parentId = parentGroupMap.get(elementId);
	while (parentId != null) {
		depth++;
		parentId = parentGroupMap.get(parentId);
	}
	return depth;
}

/** Assign an inherited stack through groups without crossing a nested clip. */
function assignMaskStackRecursive(
	elementId: string,
	stack: readonly PlannedMask[],
	elementsMap: Map<string, AnyArtObject>,
	maskStacks: Map<string, PlannedMask[]>,
): void {
	maskStacks.set(elementId, [...stack]);
	const element = elementsMap.get(elementId);
	if (!element || !isGroup(element) || element.clipPathId != null) return;

	for (const childId of element.childIds) {
		assignMaskStackRecursive(childId, stack, elementsMap, maskStacks);
	}
}

/** World AABB of a blit quad's four corners. */
/**
 * Walk the resolved elementsMap and collect every PatternFill `defId` that's
 * referenced by a visible element's fill or stroke. Empty `defId`s (the
 * "pattern selected but no def picked" sentinel) are filtered out so the
 * rasterizer doesn't waste a pass on them.
 *
 * Used by CanvasLayer.render as a pre-pass before the main render pass so
 * pattern textures are warm by the time the gradient renderer asks for them.
 */
function collectPatternDefIdsInUse(
	elementsMap: Map<string, AnyArtObject>,
	filterRenderer: FilterRenderer,
): Set<string> {
	const out = new Set<string>();
	for (const element of elementsMap.values()) {
		// Path fill / shape fill.
		if (element.type === "path" || element.type === "compound-path") {
			const fill = (element as { fill?: { type?: string; defId?: string } })
				.fill;
			if (fill?.type === "pattern" && fill.defId) out.add(fill.defId);
		}
		// Path/text stroke + appearance filters carry the StrokePattern.
		const filters = (element as { filters?: ReadonlyArray<unknown> }).filters;
		if (Array.isArray(filters)) {
			for (const f of filters) {
				const filter = f as {
					processor?: string;
					paramData?: {
						params?: {
							strokeColor?: {
								type?: string;
								pattern?: { defId?: string };
							};
							fill?: { type?: string; defId?: string };
						};
					};
				};
				if (filter.processor === "stroke") {
					const sc = filter.paramData?.params?.strokeColor;
					if (sc?.type === "stroke-pattern" && sc.pattern?.defId) {
						out.add(sc.pattern.defId);
					}
				}
				if (filter.processor === "fill") {
					const fc = filter.paramData?.params?.fill;
					if (fc?.type === "pattern" && fc.defId) out.add(fc.defId);
				}
				// Def ids referenced by a filter's own params (e.g. an extrude3d
				// material's surface pattern) — resolved via the handler, so the
				// collector names no specific processor.
				const referenced = filterRenderer
					.getHandler((f as Filter).processor)
					?.collectReferencedDefIds?.(f as Filter);
				if (referenced) for (const id of referenced) out.add(id);
			}
		}
	}
	return out;
}

/**
 * Walk the resolved elementsMap and collect every def id referenced as a brush
 * source by an element's stroke appearances. Only the primary `source` slot is
 * collected — scatter/start/end def sources stay unresolved at render time
 * (their textures would have to join the rgba8unorm scatter texture array,
 * which the canvas-format def textures are not copy-compatible with).
 *
 * Def sources only exist in the modern `source` shape (legacy
 * `textureFileUid`-style settings predate defs), so reading the raw params
 * structurally — like `collectPatternDefIdsInUse` does — is sufficient.
 *
 * Used by CanvasLayer.render as a pre-pass before the main render pass so
 * brush def textures are warm by the time the stamp pipeline binds them.
 */
function collectBrushDefIdsInUse(
	elementsMap: Map<string, AnyArtObject>,
): Set<string> {
	const out = new Set<string>();
	for (const element of elementsMap.values()) {
		const filters = (element as { filters?: ReadonlyArray<unknown> }).filters;
		if (!Array.isArray(filters)) continue;
		for (const f of filters) {
			const filter = f as {
				processor?: string;
				paramData?: {
					params?: { brushSettings?: { source?: BrushArtSource } };
				};
			};
			if (filter.processor !== "stroke") continue;
			const source = filter.paramData?.params?.brushSettings?.source;
			if (source?.kind === "def" && source.defId) out.add(source.defId);
		}
	}
	return out;
}
