import { resolveBrushRenderRequirements } from "../../brush/access";
import {
	resolveBrushTextureUid,
	resolveOptionalSourceUid,
	resolveScatterSourceUids,
} from "../../brush/brushSource";
import type { SoftProofLutResult } from "../../color/types";
import {
	localAppearances,
	resolveElementsMapAppearance,
} from "../../document/appearancePresets";
import { PREVIEW_ELEMENT_SENTINEL_ID } from "../../document/constants";
import {
	createDefaultBrushSettings,
	createIdentityTransform,
} from "../../document/factory";
import {
	type AnyArtObject,
	type Artboard,
	type BoundingBox,
	type BrushArtSource,
	type BrushSettings,
	type CubicBezierSegment,
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
	isBlend,
	isCompoundPath,
	isGroup,
	isIdentityTransform,
	isMesh,
	isPath,
	isRepeat,
	type Path,
	type RawRGBA,
	type RepeatObject,
	type StrokeAppearance,
	type StrokeColor,
	type TextElement,
	TRANSIENT_LAYER_KIND,
	type Viewport,
} from "../../schema";
import type { TextRenderer } from "../../typography/TextRenderer";
import {
	boundsIntersect,
	boundsIntersectionBox,
	brandWorldBBox,
	calculateElementBounds,
	calculateRepeatSourceUnion,
	expandBounds,
	type LocalBBox,
	type LocalBoundsCache,
	type WorldBBox,
} from "../../utils/geometry/bounds";
import {
	applyTransformToBounds,
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
import type { RasterFrame } from "../geometry/strips/stripTypes";
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
	collectExternallyReferencedIds,
	computeDotGridPhase,
	expandRenderFilter,
	interactiveBakeDensity,
	STORE_MARGIN_PX,
	splitGroupAppearances,
	unionBoundingBoxes,
	visibleBoundsToBox,
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
	type PipelineType,
	type RenderState,
	type TextState,
	type ViewportState,
	type WorldMaskAssignment,
} from "./CanvasLayerTypes";
import { MaskedBlitBindGroupCache } from "./caches/BindGroupCache";
import type { FilteredElementCacheEntry } from "./caches/FilteredElementCache";
import type { RenderCacheManager } from "./caches/RenderCacheManager";
import {
	collectDrawableAppearances,
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
import { BlurStrokeRenderer } from "./pipeline/brush/BlurStrokeRenderer";
import {
	type BrushDrawBindings,
	BrushRenderer,
} from "./pipeline/brush/BrushRenderer";
import type { BrushTextureManager } from "./pipeline/brush/BrushTextureManager";
import { MixStrokeRenderer } from "./pipeline/brush/MixStrokeRenderer";
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
import { boundsAlmostEqual, DocumentCache } from "./pipeline/DocumentCache";
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
import {
	type GroupCompositionPlan,
	groupPlanRequiresSurface,
	type MaskApplicationPlan,
	type PlannedMask,
	planGroupComposition,
	planMaskApplication,
} from "./pipeline/MaskApplicationPlan";
import {
	type AtlasMaskComputeItem,
	type ColorAtlasBakeItem,
	type ColorAtlasCopyItem,
	OffscreenPresenter,
} from "./pipeline/OffscreenPresenter";
import {
	type BackdropElementEntry,
	buildFilterPlansForElements,
	buildFramePlanStructure,
	buildFramePlanView,
	buildPassPlan,
	type ElementFilterPlan,
	type FramePlan,
	type FramePlanStructure,
	type LayerPassPlan,
} from "./pipeline/RenderPlanner";
import {
	createBorrowedTextureRef,
	createFrameTextureRef,
	createPlacementOpacity,
	createRenderSurface,
	type RasterizedRenderSurface,
	type RenderSurface,
	releaseRenderSurface,
	replaceRenderSurface,
} from "./pipeline/RenderSurface";
import { resolveTransientWashDomain } from "./pipeline/rasterizationDomain";
import { SoftProofPass } from "./pipeline/SoftProofPass";
import { StripFrame } from "./pipeline/strips/StripFrame";
import { TexturePool, texturePoolBudgetBytes } from "./pipeline/TexturePool";
import { type UniformEntry, UniformScope } from "./pipeline/UniformScope";
import { ViewportManager } from "./pipeline/ViewportManager";
import { WashCompositor } from "./pipeline/WashCompositor";

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

/** A qualified partial redraw: the dirty world rect (snapped to the store's
 *  texel grid), its prebuf-space scissor, and the baked-region union the
 *  capture records. Produced by planPartialRedraw. */
interface PartialRedrawPlan {
	dirtyWorld: BoundingBox;
	scissor: { x: number; y: number; width: number; height: number };
	bakedUnion: BoundingBox;
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

/** A wet-enabled dab stroke appearance, resolved for the wet layer. */
interface WetStroke {
	settings: BrushSettings;
	strokeColor: StrokeColor;
}

type RendererFramePlan = FramePlan & {
	maskApplicationPlans: Map<string, MaskApplicationPlan>;
	groupCompositionPlans: Map<string, GroupCompositionPlan>;
};

/**
 * Canvas Layer - Renders document elements (paths, shapes, etc.)
 * Note: CanvasLayer doesn't implement RenderLayer because it requires
 * additional parameters (document, elementOverrides, etc.) for rendering.
 */
/** A viewport binding on the encode stack; the main canvas has no scoped buffer. */
type ViewportBindingEntry = Omit<UniformEntry, "buffer"> & {
	buffer: GPUBuffer | null;
};

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
		/** World region actually rendered into the capture (content frames draw
		 *  only the viewport region of the store, so it can be smaller than
		 *  worldBounds). Blits sample only this region; pans stay on the blit
		 *  path while the visible world remains inside it. */
		bakedWorldBounds: BoundingBox | null;
		/** Viewport zoom at capture time. Same-zoom frames (pure pan/rotate)
		 *  require baked coverage; zoom frames keep the pre-store tradeoff of
		 *  blitting whatever is cached. */
		viewportZoom: number;
		/** World rect of the whole store texture at capture time, derived from
		 *  the same source a later frame compares against (prebufVisibleBounds).
		 *  A partial redraw may restore from the cache only while the store
		 *  geometry is unchanged. */
		storeBounds: BoundingBox | null;
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
		bakedWorldBounds: null,
		viewportZoom: 1,
		storeBounds: null,
		width: 0,
		height: 0,
		valid: false,
		clearColor: { r: 1, g: 1, b: 1, a: 1 },
		dotGrid: false,
	};
	// Whether the current frame's full render should refresh compositeFrameCache
	// (set per-frame in render(); false for export/preview/subset frames).
	private captureCompositeFrameThisFrame = false;
	// Whether this frame draws the whole margined store instead of just the
	// viewport region. Viewport-driven frames (blit fall-through, interaction,
	// settle) bake the margin so subsequent pans blit; content-dirty frames keep
	// the draw region at the viewport so document edits (brush strokes) never
	// pay the oversized filter-bake/raster cost (set per-frame in render()).
	private fullStoreBakeThisFrame = false;
	// Whether this frame may attempt a partial redraw (tracked content change on
	// an ordinary live frame; final eligibility — cache/store geometry, plan
	// shape, dirty size — is decided inside renderDocument). Set in render().
	private partialRedrawCandidate = false;
	// Prebuf-space scissor active for the rest of this frame's prebuf passes
	// once a partial redraw restored the region outside it (set by the Canvas
	// Clear pass, consumed by startNewPass, cleared at the final blit).
	private activePartialScissor: {
		x: number;
		y: number;
		width: number;
		height: number;
	} | null = null;
	// World rect each element's rendered output covered when it last drew —
	// the "old bounds" side of a partial redraw's dirty rect. Grows with the
	// document; cleared when the document changes identity.
	private lastElementWorldBounds = new Map<string, BoundingBox>();
	private lastBoundsDocumentId: string | null = null;

	// Pixel preview: live-canvas frames render the prebuf at the document's
	// rasterization scale and present it with nearest sampling (see
	// setPixelPreview). Export/copy/thumbnail renders are unaffected.
	private pixelPreviewEnabled = false;

	// -- Render pipelines --
	private strokePipeline: GPURenderPipeline;
	private fillPipeline: GPURenderPipeline;
	private stripPipeline: GPURenderPipeline;
	private blitPipeline: GPURenderPipeline;
	private blitPipelineRgba8: GPURenderPipeline;
	private blitPipelineRgba32Float: GPURenderPipeline;
	private blitWithMaskPipeline: GPURenderPipeline;
	private blitWithMaskChainPipeline: GPURenderPipeline;
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
	private maskChainBindGroupLayout: GPUBindGroupLayout;
	private exposureBlitBindGroupLayout: GPUBindGroupLayout;
	private exposureUniformBuffer: GPUBuffer;
	private exposureBindGroup: GPUBindGroup | null = null;
	private exposureBindGroupSourceView: GPUTextureView | null = null;
	private transformsBindGroupLayout: GPUBindGroupLayout;
	private stripGeometryBindGroupLayout: GPUBindGroupLayout;
	private dummyGradientBindGroup: GPUBindGroup;
	private dummyMaskBindGroup: GPUBindGroup;
	private maskBindGroupLayout: GPUBindGroupLayout;
	/** Intermediate texture shared by the exposure and soft proof passes. */
	private postProcessIntermediate: GPUTexture | null = null;
	private softProofPass: SoftProofPass;
	/**
	 * Wet-ink bleed composite + diffusion compute. Lazily constructed on the
	 * first wet stroke; stays null for documents that never enable wet ink so
	 * non-wet rendering pays nothing.
	 */

	// -- Viewport & uniform binding --
	private viewportManager!: ViewportManager;
	private uniformScope: UniformScope;
	private bindGroup: GPUBindGroup;

	/**
	 * The viewport uniform of the pass being encoded: its bind group, buffer
	 * and raster frame. Always update via pushViewportBinding /
	 * popViewportBinding / setViewportBinding. Outside any override the
	 * main-canvas entry is active, whose frame follows the live viewport.
	 */
	private readonly viewportBinding = {
		active: null! as ViewportBindingEntry,
		stack: [] as ViewportBindingEntry[],
	};

	private get viewportState(): ViewportState {
		return this.viewportManager.viewportState;
	}
	private get transformsBindGroup(): GPUBindGroup | null {
		return this.viewportManager.transformsBindGroup;
	}

	private pushViewportBinding(entry: ViewportBindingEntry): void {
		this.viewportBinding.stack.push(this.viewportBinding.active);
		this.viewportBinding.active = entry;
	}

	private popViewportBinding(): void {
		this.viewportBinding.active =
			this.viewportBinding.stack.pop() ?? this.mainViewportBinding;
	}

	private setViewportBinding(entry: ViewportBindingEntry): void {
		this.viewportBinding.active = entry;
	}

	/** The texel space of the pass being encoded right now. */
	private getRasterFrame(): RasterFrame {
		return this.viewportBinding.active.frame;
	}

	/** The main-canvas binding; its frame is the live viewport of this frame. */
	private get mainViewportBinding(): ViewportBindingEntry {
		const canvas = this;
		return {
			bindGroup: this.bindGroup,
			buffer: null,
			get frame(): RasterFrame {
				return {
					viewport: canvas.viewportState.current!,
					width: canvas.viewportState.width,
					height: canvas.viewportState.height,
				};
			},
		};
	}

	/** Where a brush draw lands right now: the viewport uniform of the pass
	 *  being encoded plus the transforms and mask bind groups of the current
	 *  element. Outside any override the uniform is the main buffer. */
	private brushDrawBindings(): BrushDrawBindings {
		return {
			uniformBuffer:
				this.viewportBinding.active.buffer ??
				this.viewportManager.uniformBuffer,
			transformsBindGroup: this.transformsBindGroup ?? undefined,
			maskBindGroup: this.renderState.currentMaskBindGroup,
		};
	}

	// -- Sub-renderers --
	public readonly elements!: ElementRenderer;
	private composite!: CompositeRenderer;
	public readonly offscreen!: OffscreenPresenter;
	private filterRenderer: FilterRenderer;
	private backdropCaptureManager: BackdropCaptureManager;
	private readonly brushRenderer: BrushRenderer;
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
	private washCompositor!: WashCompositor;
	private activeFramePlan: RendererFramePlan | null = null;
	/** Isolated wash results reused across frames (fixed content key). The
	 *  cache owns the textures; eviction defers destruction to the frame
	 *  boundary. */
	private readonly washResultCache = new Map<
		string,
		{
			key: string;
			texture: GPUTexture;
			placement: { bounds: WorldBBox; uvRect: BlitUVRect };
			elementBounds: WorldBBox;
			textureBounds: WorldBBox;
			bytes: number;
		}
	>();
	private washResultCacheBytes = 0;
	/** Filters-array -> JSON fingerprint (documents update immutably). */
	private readonly washFiltersFpCache = new WeakMap<object, string>();
	/** Element -> content key (elements update immutably; the key also
	 *  embeds scale/bounds, revalidated cheaply by string comparison). */
	private readonly washKeyCache = new WeakMap<object, string>();
	/** Strip instances and coverage pages of the frame being encoded. One per
	 *  canvas target, uploaded once per frame before the submit. */
	private stripFrame!: StripFrame;
	/** Stable id used to register this canvas with backdrop-composite filter
	 *  handlers (e.g. glass extrude), keyed per canvas target. */
	private readonly canvasId: string;
	/** Per-canvas backdrop-composite drivers collected from filter handlers
	 *  (currently glass extrude). CanvasLayer drives them generically without
	 *  knowing the concrete filter behind each. */
	private backdropDrivers: BackdropEffectDriver[] = [];
	private mixStrokeRenderer: MixStrokeRenderer | null = null;
	private blurStrokeRenderer: BlurStrokeRenderer | null = null;
	/** Object identity -> serial, for backdrop content keys (see
	 *  backdropContentKeyFor). */
	private readonly objectSerials = new WeakMap<object, number>();
	private objectSerialCounter = 0;
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
		backdropMask: { texture: null, width: 0, height: 0 },
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
		currentZoom: 1,
		currentTransformIndex: 0,
		currentMaskBindGroup: null!,
	};

	/** BG3 adapter for planner-approved inline-leaf masks and mesh transients. */
	private inlineMaskEntries = new Map<string, AssignedMask>();
	/** Clip group id → key of its effective (ancestor-intersected) mask. */
	private clipGroupMaskKeys = new Map<string, string>();

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
	 * Per-frame filtered-element cache participation, set by renderDocument.
	 * Null disables the cache for the frame (partial/isolated renders).
	 * blockedIds = everything the previewed elements render (their closure),
	 * so a dragged container blocks its relocated descendants; overrideIds is
	 * the raw preview set, checked against each bake's own dependency closure
	 * at the use site so a container bake never captures preview state.
	 */
	private filterCacheFrame: {
		blockedIds: ReadonlySet<string>;
		overrideIds: ReadonlySet<string>;
	} | null = null;
	private progressiveBakeBudget = 0;
	private progressiveBakeDeferred = false;
	/** Changed-element ids recorded by render(); resolved against the merged
	 *  elements map (which knows every container kind's edges) once
	 *  renderDocument has built it. */
	private pendingFilterCacheChanges: ReadonlySet<string> | null = null;
	/** defRevision of the last frame — a def edit changes pattern pixels
	 *  without an element delta, so the filtered-element cache clears on it. */
	private lastFilterCacheDefRevision: number | undefined;
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
		appearancePresets: Document["appearancePresets"];
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
			stripPipeline: GPURenderPipeline;
			gradientFillPipeline: GPURenderPipeline;
			blitPipeline: GPURenderPipeline;
			blitPipelineRgba8: GPURenderPipeline;
			blitPipelineRgba32Float: GPURenderPipeline;
			compositePipeline: GPURenderPipeline;
			blitWithMaskPipeline: GPURenderPipeline;
			blitWithMaskChainPipeline: GPURenderPipeline;
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
			stripGeometryBindGroupLayout: GPUBindGroupLayout;
			blitWithMaskBindGroupLayout: GPUBindGroupLayout;
			maskChainBindGroupLayout: GPUBindGroupLayout;
			cacheManager: RenderCacheManager;
			brushTextureManager: BrushTextureManager;
		},
		canvasId: string,
	) {
		this.device = device;
		this.canvasFormat = canvasFormat;
		this.canvasId = canvasId;
		this.softProofPass = new SoftProofPass(device, canvasFormat);

		this.strokePipeline = pipelines.strokePipeline;
		this.fillPipeline = pipelines.fillPipeline;
		this.stripPipeline = pipelines.stripPipeline;
		this.blitPipeline = pipelines.blitPipeline;
		this.blitPipelineRgba8 = pipelines.blitPipelineRgba8;
		this.blitPipelineRgba32Float = pipelines.blitPipelineRgba32Float;
		this.compositePipeline = pipelines.compositePipeline;
		this.blitWithMaskPipeline = pipelines.blitWithMaskPipeline;
		this.blitWithMaskChainPipeline = pipelines.blitWithMaskChainPipeline;
		this.blitWithEraseMaskPipeline = pipelines.blitWithEraseMaskPipeline;
		this.blitBackdropWithMaskPipeline = pipelines.blitBackdropWithMaskPipeline;
		this.blitBackdropPunchPipeline = pipelines.blitBackdropPunchPipeline;
		this.blitGlassPunchPipeline = pipelines.blitGlassPunchPipeline;
		this.exposureBlitPipeline = pipelines.exposureBlitPipeline;
		this.quadBlitPipeline = pipelines.quadBlitPipeline;
		this.meshBlitPipeline = pipelines.meshBlitPipeline;

		this.bindGroup = resources.bindGroup;
		this.viewportBinding.active = this.mainViewportBinding;
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

		this.textState.renderer = resources.textRenderer ?? null;

		this.transformsBindGroupLayout = resources.transformsBindGroupLayout;
		this.stripGeometryBindGroupLayout = resources.stripGeometryBindGroupLayout;
		this.dummyGradientBindGroup = resources.dummyGradientBindGroup;
		this.dummyMaskBindGroup = resources.dummyMaskBindGroup;
		this.renderState.currentMaskBindGroup = this.dummyMaskBindGroup;
		this.maskBindGroupLayout = resources.maskBindGroupLayout;
		this.cacheManager = resources.cacheManager;
		this.blitWithMaskBindGroupLayout = resources.blitWithMaskBindGroupLayout;
		this.maskChainBindGroupLayout = resources.maskChainBindGroupLayout;
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
			compositeState: this.compositeState,
			viewportState: this.viewportState,
			deferDestroy: (tex) => this.offscreen.deferDestroy(tex),
		});

		this.stripFrame = new StripFrame(
			this.device,
			this.stripPipeline,
			this.stripGeometryBindGroupLayout,
		);

		this.texturePool = new TexturePool(this.device);
		this.brushRenderer = new BrushRenderer({
			device: this.device,
			canvasFormat: this.canvasFormat,
			textures: resources.brushTextureManager,
			transformsBindGroupLayout: this.transformsBindGroupLayout,
			maskBindGroupLayout: this.maskBindGroupLayout,
			// Thunk, not the instance: the manager swaps its active document
			// scope between frames, so the stamp cache must be re-resolved per use.
			getStampCache: () => this.cacheManager.stamp,
			texturePool: this.texturePool,
			uniformScope: this.uniformScope,
			deferDestroy: (texture) => this.offscreen.deferDestroy(texture),
		});

		// Cache fields below are accessor properties, not construction-time
		// snapshots: the cache manager swaps its active document scope between
		// frames, so capturing an instance here would pin a stale scope.
		const cacheManager = this.cacheManager;
		this.elements = new ElementRenderer({
			device: this.device,
			canvasFormat: this.canvasFormat,
			getBindGroup: () => this.viewportBinding.active.bindGroup,
			sampler: this.sampler,
			strokePipeline: this.strokePipeline,
			fillPipeline: this.fillPipeline,
			blitBindGroupLayout: this.blitBindGroupLayout,
			filterRenderer: this.filterRenderer,
			viewportState: this.viewportState,
			renderState: this.renderState,
			assetState: this.assetState,
			textState: this.textState,
			gradient: this.gradient,
			dummyGradientBindGroup: this.dummyGradientBindGroup,
			dummyMaskBindGroup: this.dummyMaskBindGroup,
			stripFrame: this.stripFrame,
			getTransformsBuffer: () => this.viewportManager.transformsStorageBuffer,
			getRasterFrame: () => this.getRasterFrame(),
			getGpuTransform: (slot: number) =>
				this.viewportManager.getGpuTransform(slot),
			get outlineCache() {
				return cacheManager.outline;
			},
			get stripCache() {
				return cacheManager.strip;
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
			brushRenderer: this.brushRenderer,
			getBrushDrawBindings: () => this.brushDrawBindings(),
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
			getBindGroup: () => this.viewportBinding.active.bindGroup,
			sampler: this.sampler,
			nearestSampler: this.nearestSampler,
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
			getBlendModeIndex: (bm) => this.elements.getBlendModeIndex(bm),
			getCompositionModeIndex: (cm) =>
				this.elements.getCompositionModeIndex(cm),
			deferDestroy: (tex) => this.offscreen.deferDestroy(tex),
		});

		this.washCompositor = new WashCompositor(
			this.device,
			this.texturePool,
			this.canvasFormat,
		);
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
		// The mixing stroke driver is built here rather than by a filter
		// handler: mixing is a brush route, not a filter processor, but it
		// needs the identical inline-composite seam glass uses (read the live
		// composite below the element at its z-order).
		this.mixStrokeRenderer = new MixStrokeRenderer({
			device: this.device,
			canvasFormat: this.canvasFormat,
			texturePool: this.texturePool,
			coordinator: this.backdropEffectCoordinator,
			uniformScope: this.uniformScope,
			brush: this.brushRenderer,
			getTransformIndex: (elementId) =>
				this.viewportManager.getTransformIndex(elementId),
			getTransformsBindGroup: () => this.transformsBindGroup ?? undefined,
			getMaskBindGroup: () => this.renderState.currentMaskBindGroup,
			getTransformsBuffer: () => this.viewportManager.transformsStorageBuffer,
			getBackdropContentKey: (elementId, bounds) =>
				this.backdropContentKeyFor(elementId, bounds),
			getRasterScale: () => this.getRasterScale(),
		});
		// Blur strokes read the composite below them the same way.
		this.blurStrokeRenderer = new BlurStrokeRenderer({
			device: this.device,
			canvasFormat: this.canvasFormat,
			texturePool: this.texturePool,
			coordinator: this.backdropEffectCoordinator,
			uniformScope: this.uniformScope,
			brush: this.brushRenderer,
			getTransformIndex: (elementId) =>
				this.viewportManager.getTransformIndex(elementId),
			getTransformsBindGroup: () => this.transformsBindGroup ?? undefined,
			getMaskBindGroup: () => this.renderState.currentMaskBindGroup,
			getRasterScale: () => this.getRasterScale(),
		});
		this.backdropDrivers = [
			...[...this.filterRenderer.getHandlers().values()]
				.map((h) => h.getBackdropEffectDriver?.(this.canvasId) ?? null)
				.filter((d): d is BackdropEffectDriver => d !== null),
			this.mixStrokeRenderer,
			this.blurStrokeRenderer,
		];

		this.offscreen = new OffscreenPresenter({
			device: this.device,
			canvasFormat: this.canvasFormat,
			viewportBindGroupLayout: resources.viewportBindGroupLayout,
			sampler: this.sampler,
			getBindGroup: () => this.viewportBinding.active.bindGroup,
			blitBindGroupLayout: this.blitBindGroupLayout,
			getTransformsBindGroup: () => this.transformsBindGroup,
			strokePipeline: this.strokePipeline,
			dummyGradientBindGroup: this.dummyGradientBindGroup,
			dummyMaskBindGroup: this.dummyMaskBindGroup,
			blitWithMaskPipeline: this.blitWithMaskPipeline,
			blitWithMaskChainPipeline: this.blitWithMaskChainPipeline,
			blitWithEraseMaskPipeline: this.blitWithEraseMaskPipeline,
			blitWithMaskBindGroupLayout: this.blitWithMaskBindGroupLayout,
			maskChainBindGroupLayout: this.maskChainBindGroupLayout,
			viewportState: this.viewportState,
			renderState: this.renderState,
			compositeState: this.compositeState,
			filterRenderer: this.filterRenderer,
			uniformScope: this.uniformScope,
			texturePool: this.texturePool,
			getTransformIndex: (elementId: string) =>
				this.viewportManager.getTransformIndex(elementId),
			setActiveBindGroup: (entry, replace) => {
				if (entry) {
					if (replace) {
						this.setViewportBinding(entry);
					} else {
						this.pushViewportBinding(entry);
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
			hasInlineClipMask: (groupId) => this.hasInlineClipMask(groupId),
			hasIsolatedWashAppearances: (elementId) =>
				this.hasIsolatedWashAppearances(elementId),
			renderIsolatedWashAppearances: (encoder, elementId) => {
				if (!this.hasIsolatedWashAppearances(elementId)) {
					return null;
				}
				const framePlan = this.activeFramePlan!;
				const fp = framePlan.filterPlans.get(elementId)!;
				return (
					this.renderIsolatedAppearances(
						encoder,
						fp,
						framePlan!.elementsMap,
						this.getRasterScale(),
					)?.source ?? null
				);
			},
			getRasterScale: () => this.getRasterScale(),
		});

		this.clipMaskAtlas = this.createClipMaskAtlas();

		this.defRasterizer = new DefRasterizer({
			onEvicted: (textureUid) =>
				this.brushRenderer.textures.removeDefTexture(textureUid),
		});

		// A batch flush encodes ribbon draws mid-loop — the geometry run
		// batcher must emit its pending merged draw first (paint order).
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
			pass.setBindGroup(0, this.viewportBinding.active.bindGroup);
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

	/** Whether a clip group's effective mask is available for inline drawing. */
	private hasInlineClipMask(groupId: string): boolean {
		const key = this.clipGroupMaskKeys.get(groupId);
		return key != null && this.clipMaskAtlas.getMaskEntry(key) !== null;
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
			this.clipGroupMaskKeys.clear();
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
				key: entry.maskKey,
				sources: [entry.clipPath],
				coverBounds: entry.groupBounds,
				mode: "silhouette" as const,
				parentKey: entry.parentMaskKey,
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
		this.clipGroupMaskKeys.clear();
		for (const entry of clipGroups) {
			this.clipGroupMaskKeys.set(entry.groupId, entry.maskKey);
		}

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
	 * Toggle pixel preview: render the document at the rasterization scale
	 * (Document.rasterizationDpi / 72) instead of the viewport zoom and present
	 * it with nearest sampling, so the raster grid is visible when zoomed in.
	 */
	public setPixelPreview(enabled: boolean): void {
		if (this.pixelPreviewEnabled === enabled) return;
		this.pixelPreviewEnabled = enabled;
		// The cached composite frame was rendered at the other density; a zoom
		// gesture right after toggling must not reproject it.
		this.compositeFrameCache.valid = false;
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

		// Content strategies (full / fullTransformOnly) keep the draw region at
		// the viewport; every other capture-eligible frame is viewport-driven and
		// bakes the whole store (see fullStoreBakeThisFrame).
		this.fullStoreBakeThisFrame =
			this.captureCompositeFrameThisFrame &&
			strategy !== RenderStrategy.full &&
			strategy !== RenderStrategy.fullTransformOnly;

		// A tracked content change on an ordinary live frame may redraw only the
		// changed region, restoring the rest from the composite cache. Modes
		// that change how the whole frame composites (isolation, HDR/proof,
		// pixel preview's texel snap) fall back to the full render.
		this.partialRedrawCandidate =
			this.captureCompositeFrameThisFrame &&
			(strategy === RenderStrategy.full ||
				strategy === RenderStrategy.fullTransformOnly) &&
			request.changedElements != null &&
			request.changedElements.upserted.size +
				request.changedElements.deleted.size >
				0 &&
			!editingScopeStack?.length &&
			isolatedElementId == null &&
			request.hdrExposure == null &&
			request.softProof !== true &&
			!this.pixelPreviewEnabled;

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
		this.renderState.currentZoom =
			this.viewportManager.viewportState.current?.zoom ?? 1;

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
		// composite that still covers the visible world, blit + reproject it and
		// skip the whole document render. HDR/soft-proof frames, a missing cache
		// and a pan past the store margin fall through to a normal render (which
		// re-centers the store and refreshes the cache via the capture pass).
		if (strategy === RenderStrategy.viewportBlit) {
			const needsPostProcess =
				request.hdrExposure != null || request.softProof === true;
			if (
				!needsPostProcess &&
				this.compositeFrameCache.valid &&
				this.compositeFrameCache.texture &&
				this.cachedFrameCoversViewport()
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
		// null before comparing matters: a raw `undefined !== null` compare is
		// true on EVERY transient-less frame and would silently rebuild and
		// re-upload all transforms during pan/zoom.
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
		// buffer. Geometry caches (flatten, stroke, fill) are
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
			// A tracked change set drops only the masks it touches, keeping every
			// other mask's bind group identity stable — the masked-bake cache
			// hashes on it, so a blanket drop re-baked every masked element on
			// every content frame. An untracked frame still drops everything.
			if (request.changedElements) {
				this.clipMaskAtlas.invalidateChanged(
					new Set([
						...request.changedElements.upserted,
						...request.changedElements.deleted,
					]),
				);
			} else {
				this.clipMaskAtlas.invalidateAll();
			}
			// The filtered-element cache is push-invalidated per document
			// change. Resolving the change set against container edges needs
			// the merged elements map, so record it here and let
			// renderDocument apply it. An untracked full render proves
			// nothing about what changed — clear it all.
			if (request.changedElements) {
				this.pendingFilterCacheChanges = new Set([
					...request.changedElements.upserted,
					...request.changedElements.deleted,
				]);
			} else {
				this.cacheManager.filteredElement.clear();
			}
		}
		// A shared def edit changes pattern pixels without an element delta.
		if (request.defRevision !== this.lastFilterCacheDefRevision) {
			this.lastFilterCacheDefRevision = request.defRevision;
			this.cacheManager.filteredElement.clear();
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
		// Unpin the previous frame's filtered bakes so budget eviction can
		// reach them again.
		this.cacheManager.filteredElement.beginFrame();
		this.stripFrame.beginFrame();
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
		this.brushRenderer.endFrame();
		// Per-frame release for filter handlers that own GPU resources (e.g.
		// extrude's opaque bake/normal textures) — mirrors the startFrame loop.
		for (const handler of this.filterRenderer.getHandlers().values()) {
			handler.releaseFrame?.((tex) => this.offscreen.deferDestroy(tex));
		}
		// Upload this frame's strip instances and coverage pages — after every
		// pass is encoded, before the orchestrator submits.
		this.stripFrame.finishFrame();
		this.offscreen.finishFrame();
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
		this.progressiveBakeBudget = this.renderState.isExport
			? Number.POSITIVE_INFINITY
			: PROGRESSIVE_BAKES_PER_FRAME;
		this.progressiveBakeDeferred = false;
		// Evict unused gradient textures and reset per-frame draw indices
		this.gradient.textureGenerator.beginFrame();
		this.gradient.meshTextureGenerator.beginFrame();
		this.gradient.drawIndex = 0;
		this.brushRenderer.beginFrame();
		// Reset each backdrop-composite driver's per-frame pools + inline-composed
		// tracking (glass extrude refraction), and the shared capture/pyramid
		// coordinator they sample through.
		this.backdropEffectCoordinator.beginFrame();
		this.washCompositor.beginFrame();
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

		// Partial-redraw bookkeeping: the scissor never leaks across frames, and
		// last-drawn bounds describe one document only.
		this.activePartialScissor = null;
		if (document.id !== this.lastBoundsDocumentId) {
			this.lastBoundsDocumentId = document.id;
			this.lastElementWorldBounds.clear();
		}

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
			cachedPlan.appearancePresets === document.appearancePresets &&
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
			// Expand appearance preset refs once here so the planner, bounds,
			// element renderers and caches only ever see concrete filters.
			resolveElementsMapAppearance(mergedElementsMap, document);
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
					appearancePresets: document.appearancePresets,
					transients: transientElements,
					mergedElementsMap,
					structure: planStructure,
				};
			}
		}
		// Track the active elementsMap for def rasterization so live overrides
		// (tool drafts, transient layers) are reflected in pattern previews.
		this.activeElementsMap = mergedElementsMap;

		// Resolve the deferred filtered-element push-invalidation now that the
		// elements map (which knows every container kind's edges) exists: the
		// changed elements' render closure catches descendants an edited
		// container relocated, and each entry's stored dependency closure
		// catches containers whose children/sources were edited.
		if (this.pendingFilterCacheChanges) {
			const changed = this.pendingFilterCacheChanges;
			this.pendingFilterCacheChanges = null;
			this.cacheManager.filteredElement.evictChanged(
				changed,
				expandRenderFilter(new Set(changed), mergedElementsMap),
			);
		}
		// The filtered-element cache only participates in ordinary full-document
		// frames: partial renders (elementFilter), isolation modes, and export
		// (null viewport bounds, checked at use site) draw a different subset or
		// resolution than a cached bake represents. Preview overrides/transients
		// bypass the cache per element instead of disabling the frame, so
		// dragging one element keeps every other filtered element's bake hot.
		const overrideIds: ReadonlySet<string> =
			elementOverrides?.size || transientElements?.size
				? new Set<string>([
						...(elementOverrides?.keys() ?? []),
						...(transientElements?.keys() ?? []),
					])
				: EMPTY_ID_SET;
		this.filterCacheFrame =
			!elementFilter && !editingScopeStack?.length && isolatedElementId == null
				? {
						overrideIds,
						blockedIds: overrideIds.size
							? expandRenderFilter(new Set(overrideIds), mergedElementsMap)
							: EMPTY_ID_SET,
					}
				: null;

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
		// Container routes (group offscreen) resolve wash filter plans through
		// this while the frame renders.
		this.activeFramePlan = framePlan;
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
		// Pixel preview applies only to live-canvas frames; export/copy/thumbnail
		// renders always pass clearColorOverride (same signal as the dot grid).
		const pixelPreview = this.pixelPreviewEnabled && clearColorOverride == null;
		const maxTextureDimension = this.device.limits.maxTextureDimension2D;
		// Store margin only on capture-eligible live-canvas frames: exports need
		// exact prebuf sizing, and pixel preview's world-grid texel snap has not
		// been reconciled with the margin (its pans fall through to full renders,
		// which is the pre-store behavior).
		const storeMarginPx =
			this.captureCompositeFrameThisFrame &&
			!disableViewportCulling &&
			clearColorOverride == null &&
			!pixelPreview
				? STORE_MARGIN_PX
				: 0;
		let { prebufWidth, prebufHeight, prebufZoom } = calculatePrebufDimensions({
			viewport: this.viewportState.current!,
			visibleBounds: realViewportBounds,
			canvasWidth: realCanvasWidth,
			canvasHeight: realCanvasHeight,
			maxTextureDimension,
			zoomOverride: pixelPreview ? this.getRasterScale() : undefined,
			marginPx: storeMarginPx,
		});
		const prebufViewport = {
			x: this.viewportState.current!.x,
			y: this.viewportState.current!.y,
			zoom: prebufZoom,
			rotation: 0,
		} satisfies Viewport;
		if (pixelPreview) {
			// Anchor the raster grid to world space: snap the prebuf's min corner
			// to a texel multiple so panning never shifts texel boundaries within
			// world space (which would make pixels shimmer). One extra texel of
			// coverage absorbs the sub-texel snap shift at the opposite edge.
			prebufWidth = Math.min(prebufWidth + 1, maxTextureDimension);
			prebufHeight = Math.min(prebufHeight + 1, maxTextureDimension);
			const texelWorld = 1 / prebufZoom;
			const left = prebufViewport.x - prebufWidth / (2 * prebufZoom);
			const bottom = prebufViewport.y - prebufHeight / (2 * prebufZoom);
			prebufViewport.x += Math.floor(left / texelWorld) * texelWorld - left;
			prebufViewport.y += Math.floor(bottom / texelWorld) * texelWorld - bottom;
		}
		const prebufVisibleBounds = getVisibleWorldBounds(
			prebufViewport,
			prebufWidth,
			prebufHeight,
		);
		// Draw region: what this frame actually renders (culling clamp, filter
		// bake clamp). Viewport-driven frames bake the whole margined store so
		// later pans blit; content-dirty frames keep it at the viewport so edits
		// never pay the margin's extra raster/bake area. The capture records it
		// as bakedWorldBounds — the region a blit may reveal.
		const drawRegionSource =
			storeMarginPx > 0 && !this.fullStoreBakeThisFrame && realViewportBounds
				? realViewportBounds
				: prebufVisibleBounds;
		// Reassigned to the dirty rect when this frame qualifies for a partial
		// redraw (see planPartialRedraw below, after the pass plan is known).
		// Declared before the Canvas Clear pass so its deferred execute closure
		// can see the plan chosen after the pass plan is built.
		let partialPlan: PartialRedrawPlan | null = null;
		let prebufViewportBounds =
			disableViewportCulling || realViewportBounds == null
				? null
				: {
						minX: drawRegionSource.left,
						minY: drawRegionSource.bottom,
						maxX: drawRegionSource.right,
						maxY: drawRegionSource.top,
						width: drawRegionSource.width,
						height: drawRegionSource.height,
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

		const prebufTexture = this.compositeState.prebufTexture!;
		const savedViewportCurrent = this.viewportState.current;
		const savedViewportWidth = this.viewportState.width;
		const savedViewportHeight = this.viewportState.height;
		const savedViewportBounds = this.viewportState.bounds;
		const savedDrawRegion = this.viewportState.drawRegion;
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
			// bounds = the store texture's world coverage (blit/composite
			// mapping); drawRegion = what this frame renders (culling, bake
			// clamp). They diverge on margined content frames and partial
			// redraws — conflating them squeezes the final blit.
			this.viewportState.bounds =
				disableViewportCulling || realViewportBounds == null
					? prebufViewportBounds
					: visibleBoundsToBox(prebufVisibleBounds);
			this.viewportState.drawRegion = prebufViewportBounds;
			this.pushViewportBinding(prebufEntry);
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
				// The partial variant is observable: tests assert the partial
				// redraw actually engaged instead of silently full-rendering.
				// Keyed on the plan (not the scissor) so the Canvas Clear pass —
				// which restores the store before the scissor activates — counts
				// too; a deletion's dirty rect may open no other prebuf pass.
				label: partialPlan
					? "Canvas Layer Prebuf Pass (partial)"
					: "Canvas Layer Prebuf Pass",
				colorAttachments: [
					{
						view: ctx.view(prebufHandle),
						clearValue: prebufClearColor,
						loadOp: clear ? "clear" : "load",
						storeOp: "store",
					},
				],
				timestampWrites: profiler?.timestampWrites(`Elements #${passSeq++}`),
			};
			const pass = ctx.encoder.beginRenderPass(desc);
			pass.setPipeline(this.strokePipeline);
			pass.setBindGroup(0, this.viewportBinding.active.bindGroup);
			pass.setBindGroup(1, this.transformsBindGroup!);
			pass.setBindGroup(2, this.dummyGradientBindGroup);
			pass.setBindGroup(3, this.renderState.currentMaskBindGroup);
			// Partial redraw: elements are CPU-culled to the dirty rect but a
			// partially-inside element still draws all of itself; the scissor
			// keeps its spill from overwriting the restored region.
			if (this.activePartialScissor) {
				const s = this.activePartialScissor;
				pass.setScissorRect(s.x, s.y, s.width, s.height);
			}
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
		// isolation dim, backdrop fallback, then viewport restore + final blit.
		// The graph declares each as its own pass.
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
			// The final blit targets the real canvas, not the prebuf store.
			this.activePartialScissor = null;
			this.popViewportBinding();
			this.viewportState.current = savedViewportCurrent;
			this.viewportState.width = savedViewportWidth;
			this.viewportState.height = savedViewportHeight;
			this.viewportState.bounds = savedViewportBounds;
			this.viewportState.drawRegion = savedDrawRegion;
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
					FULL_BLIT_UV_RECT,
					undefined,
					pixelPreview ? "nearest" : "linear",
				);
			}
			finalPass.end();
		};

		// Declarative layer passes (G1 step 4): one pass per layer segment,
		// the layer-composite stages spelled out, and the remaining
		// procedural tail as a single pass (split further in later steps).
		const { graph } = fg;
		const prebufHandle = graph.importTexture(prebufTexture, "prebuf");
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
			execute: (ctx) =>
				withGraphContext(ctx, () => {
					bindPrebufViewport();
					// loadOp "clear" wipes the whole store (it ignores scissors); a
					// partial frame then paints back everything OUTSIDE the dirty
					// rect from the cached composite, leaving only the dirty rect
					// cleared for re-rendering.
					const pass = startNewPass(true);
					if (partialPlan) {
						this.drawStoreRestoreBands(pass, partialPlan.dirtyWorld);
						const s = partialPlan.scissor;
						pass.setScissorRect(s.x, s.y, s.width, s.height);
					}
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
					// Every later prebuf pass this frame is confined to the dirty
					// rect; pixels outside it already hold the restored composite.
					if (partialPlan) this.activePartialScissor = partialPlan.scissor;
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
				(elementFilter && !elementFilter.has(bdElem.element.id))
			) {
				return;
			}
			graph.addPass(`Backdrop ${bdElem.element.id}`, {
				reads: [prebufHandle],
				writes: [targetHandle],
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

		// With the pass plan known, decide whether this content frame can redraw
		// only the changed region and restore the rest from the composite cache.
		if (this.partialRedrawCandidate && storeMarginPx > 0) {
			partialPlan = this.planPartialRedraw(
				fg.changedElements,
				mergedElementsMap,
				planStructure,
				passPlans,
				visibleBoundsToBox(prebufVisibleBounds),
				prebufWidth,
				prebufHeight,
				prebufZoom,
			);
			if (partialPlan) {
				// The dirty rect becomes the frame's draw region: element/segment
				// culling and the offscreen bake clamp all follow viewportState
				// .bounds, so everything outside it is skipped on the CPU.
				prebufViewportBounds = partialPlan.dirtyWorld;
			}
		}
		// Deleted elements never draw again: drop their last-drawn bounds AFTER
		// the partial plan consumed them as the deletion's dirty region, or the
		// map grows for every element the session ever removed (eraser, undo
		// churn). Live elements stay — one box per element, bounded by the
		// document.
		if (fg.changedElements) {
			for (const id of fg.changedElements.deleted) {
				this.lastElementWorldBounds.delete(id);
			}
		}

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

		// Plain layers write the same colour attachment with nothing in between.
		// Giving each its own render pass therefore buys nothing and costs a
		// full-surface colour store plus reload at every boundary. That store is
		// the largest single item in the frame. Runs accumulate here and open
		// one pass.
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
				execute: (ctx) =>
					withGraphContext(ctx, () => {
						let pass = startNewPass(false);
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
						execute: (ctx) =>
							withGraphContext(ctx, () => {
								let pass = startNewPass(false);
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
					timestampWrites: timed
						? profiler?.timestampWrites(`LayerComposite #${layerPassSeq++}`)
						: undefined,
				});
				pass.setPipeline(this.strokePipeline);
				pass.setBindGroup(0, this.viewportBinding.active.bindGroup);
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
					execute: (ctx) =>
						withGraphContext(ctx, () => {
							let pass = startLayerPass(false);
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
					// Culling clamped the frame to the draw region; only that part
					// of the store holds a complete composite. A partial redraw
					// restored the previously-baked region, so its union with the
					// dirty rect stays baked.
					this.compositeFrameCache.bakedWorldBounds = partialPlan
						? partialPlan.bakedUnion
						: (prebufViewportBounds ?? prebufBounds);
					this.compositeFrameCache.viewportZoom =
						savedViewportCurrent?.zoom ?? 1;
					this.compositeFrameCache.storeBounds =
						visibleBoundsToBox(prebufVisibleBounds);
					this.compositeFrameCache.clearColor = clearColor;
					this.compositeFrameCache.dotGrid = dotGridBackground;
					this.compositeFrameCache.valid = true;
				},
			});
		}
		if (this.progressiveBakeDeferred) this.onRequestRender?.();
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
		if (
			!cache.texture ||
			!cache.worldBounds ||
			!cache.bakedWorldBounds ||
			!viewport
		) {
			return null;
		}

		const realCanvasWidth = this.viewportState.width;
		const realCanvasHeight = this.viewportState.height;

		// The orchestrator already applied the current viewport via
		// updateViewport; sync the GPU uniform buffer so the blit reprojects the
		// cached world bounds through the live pan/zoom/rotation.
		this.restoreViewportUniformsToGPU();

		const graph = new FrameGraph();
		const renderTarget = graph.importTexture(canvasTexture, "render-target");
		graph.addPass("Viewport Blit", {
			reads: [],
			writes: [renderTarget],
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
				// Sample only the baked region: content frames leave the store's
				// margin partially rendered (culling clamps them to the viewport),
				// so blitting the full texture would reveal half-drawn content.
				const world = cache.worldBounds!;
				const baked = cache.bakedWorldBounds!;
				const bakedUVRect: BlitUVRect = {
					minU: (baked.minX - world.minX) / world.width,
					maxU: (baked.maxX - world.minX) / world.width,
					// Texture v=0 is the top row (world maxY).
					minV: (world.maxY - baked.maxY) / world.height,
					maxV: (world.maxY - baked.minY) / world.height,
				};
				this.composite.blitTextureToCanvas(
					pass,
					cache.texture!,
					baked,
					1.0,
					bakedUVRect,
					undefined,
					this.pixelPreviewEnabled ? "nearest" : "linear",
				);
				pass.end();
			},
		});
		return this.executeFrame(graph, encoder, new Map());
	}

	/**
	 * Whether the cached composite still covers the visible world. Pure pan /
	 * rotate frames (same zoom as the capture) must stay inside the baked
	 * region — outside it the store is unrendered or half-rendered. Zoom frames
	 * keep the pre-store behavior of blitting whatever is cached: the settle
	 * re-render restores full quality 100ms later.
	 */
	private cachedFrameCoversViewport(): boolean {
		const cache = this.compositeFrameCache;
		const viewport = this.viewportState.current;
		if (!viewport || !cache.bakedWorldBounds) return false;
		if (Math.abs(viewport.zoom - cache.viewportZoom) > 1e-9) return true;
		const visible = getVisibleWorldBounds(
			viewport,
			this.viewportState.width,
			this.viewportState.height,
		);
		// Half a device pixel of slack absorbs float error at the store edge.
		const eps = 0.5 / Math.max(viewport.zoom, Number.EPSILON);
		const baked = cache.bakedWorldBounds;
		return (
			visible.left >= baked.minX - eps &&
			visible.right <= baked.maxX + eps &&
			visible.bottom >= baked.minY - eps &&
			visible.top <= baked.maxY + eps
		);
	}

	/**
	 * Decide whether a tracked content change can redraw only its region.
	 * Returns the dirty world rect (snapped to the store's texel grid), the
	 * matching prebuf-space scissor, and the baked-region union the capture
	 * should record — or null to fall back to the plain full render. The
	 * fallbacks are deliberately broad: correctness first, coverage grows as
	 * the exceptional paths (filters, backdrop, glass) learn their margins.
	 */
	private planPartialRedraw(
		changedElements: FrameRequest["changedElements"],
		mergedElementsMap: Map<string, AnyArtObject>,
		planStructure: FramePlanStructure,
		passPlans: readonly LayerPassPlan[],
		storeBox: BoundingBox,
		prebufWidth: number,
		prebufHeight: number,
		prebufZoom: number,
	): PartialRedrawPlan | null {
		const cache = this.compositeFrameCache;
		if (!changedElements) return null;
		if (
			!cache.valid ||
			!cache.texture ||
			!cache.bakedWorldBounds ||
			!cache.storeBounds
		) {
			return null;
		}
		// The restore blits cached texels 1:1 back onto the store, so the store
		// geometry (anchor/zoom/dims) must be unchanged since the capture.
		if (!boundsAlmostEqual(cache.storeBounds, storeBox)) return null;
		// Backdrop and inline-glass breaks read the prebuf mid-frame; a restored
		// prebuf holds the FINAL previous composite there, not the mid-frame
		// state below the element, so those frames render fully.
		for (const layerPass of passPlans) {
			for (const segment of layerPass.segments) {
				const kind = segment.breakAfter?.kind;
				if (kind === "backdrop" || kind === "inlineBackdropCompose") {
					return null;
				}
			}
		}
		// Elements whose rendered output extends past their bounds (filter
		// margins, backdrop capture) need expansion math this path skips.
		const specialIds = new Set<string>();
		for (const candidate of planStructure.candidates) {
			if (candidate.filterPlan) {
				specialIds.add(candidate.filterPlan.elementId);
			}
			if (candidate.backdropEntry) {
				specialIds.add(candidate.backdropEntry.element.id);
			}
		}
		const changedIds = new Set([
			...changedElements.upserted,
			...changedElements.deleted,
		]);
		// The render closure: containers relocate descendants, so an edited
		// group dirties every descendant's region (and vice versa). Deleted ids
		// are gone from the elements map, so the closure walk drops them — union
		// them back in: their last-drawn bounds ARE the deletion's dirty region.
		const closure = new Set([
			...expandRenderFilter(changedIds, mergedElementsMap),
			...changedIds,
		]);
		const boundsCtx: WorldBoundsContext = {
			elementsMap: mergedElementsMap,
			localBoundsCache: planStructure.localBoundsCache,
		};
		// A changed element another element derives from (clip path, mask
		// source, compound-path/blend member) alters pixels outside its own
		// bounds — the dirty rect cannot cover that.
		const referencedIds = collectExternallyReferencedIds(mergedElementsMap);
		let parentGroupMap: ReadonlyMap<string, string> | null = null;
		let dirty: BoundingBox | null = null;
		for (const id of closure) {
			if (specialIds.has(id)) return null;
			if (referencedIds.has(id)) return null;
			dirty = unionBoundingBoxes(
				dirty,
				this.lastElementWorldBounds.get(id) ?? null,
			);
			const element = mergedElementsMap.get(id);
			if (element) {
				parentGroupMap ??= resolveParentGroupMap(boundsCtx);
				const next =
					this.renderState.boundsCache?.get(id) ??
					computeWorldBounds(element, boundsCtx, parentGroupMap);
				dirty = unionBoundingBoxes(dirty, next);
			}
		}
		if (!dirty) return null;
		// AA / hairline slack around the changed geometry (device px → world).
		dirty = expandBounds(dirty, 8 / prebufZoom);
		const clipped = boundsIntersectionBox(dirty, storeBox);
		// Entirely outside the store: nothing visible changes, but the plain
		// path keeps the bookkeeping (bounds map, capture) coherent.
		if (!clipped) return null;
		// Past this ratio a full redraw costs about the same and re-bakes the
		// whole store for later pans.
		const storeArea = storeBox.width * storeBox.height;
		if (clipped.width * clipped.height > storeArea * 0.4) return null;
		// Snap to the store texel grid so the scissor and the world-space cull
		// rect describe exactly the same pixels.
		const clampX = (v: number) => Math.min(Math.max(v, 0), prebufWidth);
		const clampY = (v: number) => Math.min(Math.max(v, 0), prebufHeight);
		const x0 = clampX(Math.floor((clipped.minX - storeBox.minX) * prebufZoom));
		const x1 = clampX(Math.ceil((clipped.maxX - storeBox.minX) * prebufZoom));
		const y0 = clampY(Math.floor((storeBox.maxY - clipped.maxY) * prebufZoom));
		const y1 = clampY(Math.ceil((storeBox.maxY - clipped.minY) * prebufZoom));
		if (x1 <= x0 || y1 <= y0) return null;
		const dirtyWorld: BoundingBox = {
			minX: storeBox.minX + x0 / prebufZoom,
			maxX: storeBox.minX + x1 / prebufZoom,
			minY: storeBox.maxY - y1 / prebufZoom,
			maxY: storeBox.maxY - y0 / prebufZoom,
			width: (x1 - x0) / prebufZoom,
			height: (y1 - y0) / prebufZoom,
		};
		const bakedUnion = boundsIntersectionBox(
			unionBoundingBoxes(cache.bakedWorldBounds, dirtyWorld)!,
			storeBox,
		);
		if (!bakedUnion) return null;
		return {
			dirtyWorld,
			scissor: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
			bakedUnion,
		};
	}

	/**
	 * Paint the cached composite back onto the store everywhere EXCEPT the
	 * dirty rect (up to four bands), leaving only the dirty rect cleared for
	 * re-rendering. The cached prebuf composite is background-complete, so
	 * src-over onto the just-cleared background reproduces it exactly; nearest
	 * sampling keeps the 1:1 texel mapping crisp.
	 */
	private drawStoreRestoreBands(
		pass: GPURenderPassEncoder,
		dirtyWorld: BoundingBox,
	): void {
		const cache = this.compositeFrameCache;
		const world = cache.worldBounds;
		if (!cache.texture || !world) return;
		const bands: BoundingBox[] = [];
		const push = (
			minX: number,
			maxX: number,
			minY: number,
			maxY: number,
		): void => {
			if (maxX <= minX || maxY <= minY) return;
			bands.push({
				minX,
				minY,
				maxX,
				maxY,
				width: maxX - minX,
				height: maxY - minY,
			});
		};
		push(world.minX, world.maxX, dirtyWorld.maxY, world.maxY); // top
		push(world.minX, world.maxX, world.minY, dirtyWorld.minY); // bottom
		push(world.minX, dirtyWorld.minX, dirtyWorld.minY, dirtyWorld.maxY); // left
		push(dirtyWorld.maxX, world.maxX, dirtyWorld.minY, dirtyWorld.maxY); // right
		for (const band of bands) {
			const uvRect: BlitUVRect = {
				minU: (band.minX - world.minX) / world.width,
				maxU: (band.maxX - world.minX) / world.width,
				// Texture v=0 is the top row (world maxY).
				minV: (world.maxY - band.maxY) / world.height,
				maxV: (world.maxY - band.minY) / world.height,
			};
			this.composite.blitTextureToCanvas(
				pass,
				cache.texture,
				band,
				1.0,
				uvRect,
				undefined,
				"nearest",
			);
		}
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
				dimPass.setBindGroup(0, this.viewportBinding.active.bindGroup);
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
		// Single density for this frame's cacheable bakes: the hash, the byte
		// budget, and the bake itself all consume this exact value. Live frames
		// follow the display density; exports keep the rasterizationDpi ceiling
		// so display-quality decisions never change exported pixels.
		const zoomBucket = interactiveBakeDensity(
			rasterScale,
			this.viewportState.current?.zoom ?? 1,
		);
		const cacheDensity = this.renderState.isExport
			? Math.min(rasterScale, zoomBucket)
			: zoomBucket;
		let plans: readonly ElementFilterPlan[];
		if (selectedPlans) {
			plans = selectedPlans;
		} else {
			const base = layerPlans.flatMap((layerPlan) =>
				layerPlan.elements.flatMap((element) => {
					const plan = filterPlans.get(element.id);
					return plan ? [plan] : [];
				}),
			);
			// Wash plans on group children never appear in layerPlan.elements
			// (only top-level elements do): execute them here too, so the
			// inline group recursion can blit the isolated wash result from
			// filteredTextures instead of drawing the dabs buildup-dark.
			const seen = new Set(base.map((plan) => plan.elementId));
			for (const plan of filterPlans.values()) {
				if (seen.has(plan.elementId)) continue;
				if (plan.allAppearancePlans?.some((p) => p.washStrokeOpacity != null)) {
					base.push(plan);
					seen.add(plan.elementId);
				}
			}
			plans = base;
		}

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

			// Frame-cache participation. A non-null hash means this element's
			// filtered bake may be reused across frames: the bake then covers
			// the full textureBounds (viewport-independent) so pans hit without
			// re-running the chain. Backdrop-reading chains depend on what is
			// behind the element and stay frame-local, as do preview-overridden
			// elements and bakes past the full-bake budget.
			let cacheHash: string | null = null;
			let cacheContentHash: string | null = null;
			let cacheDeps: ReadonlySet<string> | null = null;
			if (
				this.filterCacheFrame != null &&
				selectedPlans === undefined &&
				!rendersOwnSource &&
				this.viewportState.bounds != null &&
				!this.filterCacheFrame.blockedIds.has(element.id) &&
				!fp.postFilters.some(
					(f) =>
						resolveRenderConfigure(
							this.filterRenderer.getHandler(f.processor),
							f,
						).needsBackdrop,
				) &&
				this.filteredBakeWithinBudget(fp, cacheDensity)
			) {
				// Everything this bake renders (group children, mask/compound/
				// blend sources, …). A preview override anywhere inside means
				// the bake would capture preview state — keep it frame-local.
				const deps = expandRenderFilter(new Set([element.id]), elementsMap);
				if (!setsIntersect(deps, this.filterCacheFrame.overrideIds)) {
					cacheDeps = deps;
					cacheContentHash = this.computeFilteredElementContentHash(
						fp,
						element,
						elementsMap,
					);
					cacheHash = `${cacheDensity}:${cacheContentHash}`;
				}
			}
			if (cacheHash != null) {
				const entry = this.cacheManager.filteredElement.get(element.id);
				if (entry?.hash === cacheHash) {
					filteredTextures.set(
						element.id,
						buildCachedFilteredTextureInfo(entry, fp),
					);
					continue;
				}
				if (
					cacheContentHash != null &&
					entry &&
					this.shouldUseStaleBake(entry, cacheContentHash, cacheDensity)
				) {
					filteredTextures.set(
						element.id,
						buildCachedFilteredTextureInfo(entry, fp),
					);
					continue;
				}
			}

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
							cacheHash != null ? { density: cacheDensity } : null,
							fp.postFilters.length === 0,
						)
					: this.offscreen.renderElementToTexture(
							encoder,
							element,
							fp.textureBounds,
							elementsMap,
							rasterScale,
							selectedPlans !== undefined,
							fpFilterMargin,
							undefined,
							cacheHash != null ? { density: cacheDensity } : null,
							fp.postFilters.length === 0,
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
			// Self-sized override layers (extrude) never reach here with a
			// cacheHash (rendersOwnSource is excluded), so a plain chain result
			// is the only thing ever stored.
			if (
				cacheHash != null &&
				cacheContentHash != null &&
				cacheDeps != null &&
				!overrides
			) {
				this.storeFilteredElementBake(
					encoder,
					element.id,
					cacheHash,
					cacheContentHash,
					cacheDensity,
					cacheDeps,
					filteredTexture,
					outputBounds,
					outputUvRect,
				);
			}
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

	/** A cacheable bake covers the full textureBounds; refuse when that would
	 *  dwarf the canvas or exceed the cache's per-entry byte cap — otherwise
	 *  every frame pays a full bake + copy only for set() to reject it
	 *  (zoomed-in giants stay on the frame-local clamp path). */
	private filteredBakeWithinBudget(
		fp: ElementFilterPlan,
		density: number,
	): boolean {
		return this.bakeWithinCacheBudget(fp.textureBounds, density);
	}

	/** Single source for the paint-hash callbacks — the clip-mask atlas and
	 *  the filtered-element cache must fingerprint paint identically, or a
	 *  change one of them tracks would leave the other stale. */
	private paintHashContext(): Parameters<typeof computePaintHash>[2] {
		return {
			resolvePatternTexture: (defId) => this.resolvePatternTexture(defId),
			resolveTextOutline: (el) => this.resolveTextOutline(el),
			isImageReady: (fileUid) => this.assetState.imageTextureCache.has(fileUid),
			hasPreProcessHandler: (processor) =>
				!!this.filterRenderer.getHandler(processor)?.preProcess,
		};
	}

	private shouldUseStaleBake(
		entry: FilteredElementCacheEntry,
		contentHash: string,
		density: number,
	): boolean {
		if (entry.contentHash !== contentHash || entry.density === density)
			return false;
		if (this.progressiveBakeBudget > 0) {
			this.progressiveBakeBudget--;
			return false;
		}
		this.progressiveBakeDeferred = true;
		return true;
	}

	/** Content hash for a cached filtered bake. Push invalidation (element
	 *  edits, moves, deletions via changedElements) is the primary eviction
	 *  path; this hash catches what no element delta reports — filter
	 *  parameter edits and async paint changes (image decode, text outline
	 *  resolution) — plus the density bucket and the bake's world rect (its
	 *  position guards against a push miss relocating the bake). */
	private computeFilteredElementContentHash(
		fp: ElementFilterPlan,
		element: AnyArtObject,
		elementsMap: Map<string, AnyArtObject>,
	): string {
		const paintHash = computePaintHash(
			element,
			elementsMap,
			this.paintHashContext(),
		);
		const tb = fp.textureBounds;
		return `${Math.round(tb.minX)},${Math.round(tb.minY)},${Math.round(
			tb.width,
		)}x${Math.round(tb.height)}:${JSON.stringify(fp.postFilters)}:${paintHash}`;
	}

	/** Copy a just-produced filter result into a cache-owned texture. The copy
	 *  is negligible next to the chain it lets future frames skip. */
	private storeFilteredElementBake(
		encoder: GPUCommandEncoder,
		elementId: string,
		hash: string,
		contentHash: string,
		density: number,
		dependencyIds: ReadonlySet<string>,
		texture: GPUTexture,
		bounds: BoundingBox,
		uvRect: BlitUVRect,
	): void {
		const cacheTexture = this.device.createTexture({
			label: "Filtered Element Cache Texture",
			size: { width: texture.width, height: texture.height },
			format: texture.format,
			usage:
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST |
				GPUTextureUsage.COPY_SRC,
		});
		encoder.copyTextureToTexture(
			{ texture },
			{ texture: cacheTexture },
			{ width: texture.width, height: texture.height },
		);
		this.cacheManager.filteredElement.set(elementId, {
			hash,
			contentHash,
			density,
			texture: cacheTexture,
			bounds: brandWorldBBox(bounds),
			uvRect,
			byteSize: texture.width * texture.height * bytesPerTexel(texture.format),
			dependencyIds,
		});
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
	private bakeElementWithWorldMasks(
		encoder: GPUCommandEncoder,
		element: AnyArtObject,
		bounds: WorldBBox,
		elementsMap: Map<string, AnyArtObject>,
		masks: readonly WorldMaskAssignment[],
		rasterScale: number,
	): Pick<FilteredTextureInfo, "source" | "output"> | null {
		const baked = isGroup(element)
			? this.offscreen.renderGroupToTexture(
					encoder,
					element,
					bounds,
					elementsMap,
					this.viewportManager.getBoundsCache(),
					rasterScale,
					null,
					null,
					true,
				)
			: this.offscreen.renderElementToTexture(
					encoder,
					element,
					bounds,
					elementsMap,
					rasterScale,
					false,
					null,
					undefined,
					null,
					true,
				);
		if (!baked) return null;
		const masked = this.offscreen.applyWorldMasksToTexture(
			encoder,
			baked,
			masks,
			rasterScale,
		);
		if (!masked) return null;
		return {
			source: baked,
			output: replaceRenderSurface(baked, masked),
		};
	}

	private applyPostMasks(
		encoder: GPUCommandEncoder,
		filteredTextures: Map<string, FilteredTextureInfo>,
		elementsMap: Map<string, AnyArtObject>,
	): void {
		if (this.activeMaskApplicationPlans.size === 0) return;
		const boundsContext = this.maskBoundsContext;
		if (!boundsContext) return;
		// Display-following density, mirroring executeFilterPlans' cacheDensity:
		// masked bakes were pinned to the document raster scale, which kept the
		// whole bake blurry at any zoom past it no matter how often the frame
		// re-rendered. Export frames keep the raster scale so display-quality
		// decisions never change exported pixels.
		const rasterScale = this.renderState.isExport
			? this.getRasterScale()
			: interactiveBakeDensity(
					this.getRasterScale(),
					this.viewportState.current?.zoom ?? 1,
				);
		const atlasBakeItems: ColorAtlasBakeItem[] = [];
		const atlasBakeMasks = new Map<string, readonly WorldMaskAssignment[]>();
		const atlasCopyItems: ColorAtlasCopyItem[] = [];
		const atlasCopySources = new Map<
			string,
			{
				compute: boolean;
				existing: FilteredTextureInfo;
				masks: readonly WorldMaskAssignment[];
			}
		>();

		for (const [elementId, plan] of this.activeMaskApplicationPlans) {
			if (plan.kind !== "subtree-composite") continue;
			const element = elementsMap.get(elementId);
			if (!element) continue;

			const masks = plan.masks.flatMap((planned) => {
				const mask = this.maskEntriesByKey.get(planned.key);
				return mask ? [mask] : [];
			});
			if (masks.length === 0) continue;

			const existing = filteredTextures.get(elementId);
			if (existing?.overrideLayers) {
				// Self-sized layers (extrude solids) are blitted one by one, so the
				// masks go into each of them rather than into one combined texture.
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

						const masked = this.offscreen.applyWorldMasksToTexture(
							encoder,
							sourceSurface,
							masks,
							rasterScale,
						);
						if (masked) {
							sourceSurface = replaceRenderSurface(sourceSurface, masked);
						}
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

				// Frame-cache participation, mirroring executeFilterPlans: an
				// unfiltered masked bake covers its full bounds at R, so it is
				// viewport-independent and pans can reuse it. Filtered elements
				// stay out — their bake is cached (unmasked) by executeFilterPlans
				// under the same key, and two writers per key would thrash.
				let cacheHash: string | null = null;
				let cacheContentHash: string | null = null;
				let cacheDeps: ReadonlySet<string> | null = null;
				if (
					this.filterCacheFrame != null &&
					this.viewportState.bounds != null &&
					!this.filterCacheFrame.blockedIds.has(elementId) &&
					this.bakeWithinCacheBudget(bounds, rasterScale) &&
					!subtreeContainsReference3D(element, elementsMap)
				) {
					const deps = expandRenderFilter(new Set([elementId]), elementsMap);
					if (!setsIntersect(deps, this.filterCacheFrame.overrideIds)) {
						cacheDeps = deps;
						cacheContentHash = this.computeMaskedElementContentHash(
							element,
							elementsMap,
							masks,
							bounds,
						);
						cacheHash = `${rasterScale}:${cacheContentHash}`;
					}
				}
				if (cacheHash != null) {
					const entry = this.cacheManager.filteredElement.get(elementId);
					if (entry?.hash === cacheHash) {
						filteredTextures.set(
							elementId,
							buildCachedMaskedTextureInfo(entry, bounds),
						);
						continue;
					}
					if (
						cacheContentHash != null &&
						entry &&
						this.shouldUseStaleBake(entry, cacheContentHash, rasterScale)
					) {
						filteredTextures.set(
							elementId,
							buildCachedMaskedTextureInfo(entry, bounds),
						);
						continue;
					}
				}
				const sharedMaskView = masks[0]?.textureView;
				const colorAtlasReservation =
					element.type === "path" &&
					(element.blendMode ?? "normal") === "normal" &&
					masks.length <= 16 &&
					sharedMaskView &&
					masks.every(
						(mask) => mask.atlasRect && mask.textureView === sharedMaskView,
					)
						? this.offscreen.reserveColorAtlasBake(bounds, rasterScale)
						: null;
				if (colorAtlasReservation) {
					atlasBakeItems.push({
						key: elementId,
						element,
						elementsMap,
						...colorAtlasReservation,
					});
					atlasBakeMasks.set(elementId, masks);
					continue;
				}

				const baked = this.bakeElementWithWorldMasks(
					encoder,
					element,
					bounds,
					elementsMap,
					masks,
					rasterScale,
				);
				if (!baked) continue;
				const { output } = baked;
				if (
					cacheHash != null &&
					cacheContentHash != null &&
					cacheDeps != null &&
					output.placement.kind === "world-aabb"
				) {
					this.storeFilteredElementBake(
						encoder,
						elementId,
						cacheHash,
						cacheContentHash,
						rasterScale,
						cacheDeps,
						output.texture.texture,
						output.placement.bounds,
						output.placement.uvRect,
					);
				}
				filteredTextures.set(elementId, {
					source: baked.source,
					output,
					elementBounds: bounds,
					textureBounds: bounds,
				});
				continue;
			}

			if (this.offscreen.canDrawSurfaceWithAtlasMasks(existing.output, masks)) {
				atlasCopyItems.push({ key: elementId, surface: existing.output });
				atlasCopySources.set(elementId, {
					compute:
						(element.blendMode ?? "normal") !== "normal" ||
						(element.compositionMode ?? "normal") !== "normal",
					existing,
					masks,
				});
				continue;
			}

			const masked = this.offscreen.applyWorldMasksToTexture(
				encoder,
				existing.output,
				masks,
				this.getRasterScale(),
			);
			if (!masked) continue;

			filteredTextures.set(elementId, {
				...existing,
				output: replaceRenderSurface(existing.output, masked),
			});
		}

		const atlasSurfaces = this.offscreen.renderColorAtlasBatch(
			encoder,
			atlasBakeItems,
		);
		for (const item of atlasBakeItems) {
			const masks = atlasBakeMasks.get(item.key);
			if (!masks) continue;
			const surface = atlasSurfaces.get(item.key);
			if (
				surface &&
				this.offscreen.canDrawSurfaceWithAtlasMasks(surface, masks)
			) {
				filteredTextures.set(item.key, {
					source: surface,
					output: surface,
					elementBounds: item.bounds,
					textureBounds: item.bounds,
					postMasks: masks,
				});
				continue;
			}
			const baked = this.bakeElementWithWorldMasks(
				encoder,
				item.element,
				item.bounds,
				item.elementsMap,
				masks,
				rasterScale,
			);
			if (!baked) continue;
			filteredTextures.set(item.key, {
				...baked,
				elementBounds: item.bounds,
				textureBounds: item.bounds,
			});
		}

		const copiedSurfaces = this.offscreen.copyColorSurfacesToAtlas(
			encoder,
			atlasCopyItems,
		);
		const computeItems: AtlasMaskComputeItem[] = [];
		const computeSources = new Map<
			string,
			{
				existing: FilteredTextureInfo;
				masks: readonly WorldMaskAssignment[];
			}
		>();
		for (const [elementId, { compute, existing, masks }] of atlasCopySources) {
			const copied = copiedSurfaces.get(elementId);
			if (!compute) {
				filteredTextures.set(elementId, {
					...existing,
					output: copied ?? existing.output,
					postMasks: masks,
				});
				continue;
			}
			if (copied) {
				computeItems.push({ key: elementId, source: copied, masks });
				computeSources.set(elementId, { existing, masks });
				continue;
			}
			const masked = this.offscreen.applyWorldMasksToTexture(
				encoder,
				existing.output,
				masks,
				this.getRasterScale(),
			);
			if (!masked) continue;
			filteredTextures.set(elementId, {
				...existing,
				output: replaceRenderSurface(existing.output, masked),
				postMasks: undefined,
			});
		}
		const computedSurfaces = this.offscreen.applyAtlasMasksComputeBatch(
			encoder,
			computeItems,
		);
		for (const [elementId, { existing, masks }] of computeSources) {
			const output = computedSurfaces.get(elementId);
			if (output) {
				filteredTextures.set(elementId, {
					...existing,
					output,
					postMasks: undefined,
				});
				continue;
			}
			const masked = this.offscreen.applyWorldMasksToTexture(
				encoder,
				existing.output,
				masks,
				this.getRasterScale(),
			);
			if (!masked) continue;
			filteredTextures.set(elementId, {
				...existing,
				output: replaceRenderSurface(existing.output, masked),
				postMasks: undefined,
			});
		}
	}

	/** Content hash for a cached masked (unfiltered) bake — the applyPostMasks
	 *  counterpart of computeFilteredElementHash. Push invalidation via
	 *  dependencyIds is the primary eviction path; the hash catches async paint
	 *  changes plus everything that reshapes the bake without an element delta.
	 *  Mask fingerprints include content, coverage, and zoom. Shared-atlas
	 *  entries deliberately keep one bind-group identity across those changes. */
	private computeMaskedElementContentHash(
		element: AnyArtObject,
		elementsMap: Map<string, AnyArtObject>,
		masks: readonly AssignedMask[],
		bounds: BoundingBox,
	): string {
		const paintHash = computePaintHash(
			element,
			elementsMap,
			this.paintHashContext(),
		);
		const maskKey = masks
			.map((m) => `${m.fingerprint}i${m.inverted ? 1 : 0}`)
			.join(",");
		return `masked:${Math.round(bounds.minX)},${Math.round(
			bounds.minY,
		)},${Math.round(bounds.width)}x${Math.round(bounds.height)}:${maskKey}:${paintHash}`;
	}

	/** A cacheable bake covers its full world bounds; refuse when that would
	 *  dwarf the canvas or exceed the cache's per-entry byte cap — otherwise
	 *  every frame pays a full bake + copy only for set() to reject it. */
	private bakeWithinCacheBudget(bounds: BoundingBox, density: number): boolean {
		const bakePx =
			Math.ceil(bounds.width * density) * Math.ceil(bounds.height * density);
		return (
			bakePx <=
				this.viewportState.width *
					this.viewportState.height *
					FILTER_CACHE_FULL_BAKE_BUDGET_FACTOR &&
			bakePx * bytesPerTexel(this.canvasFormat) <=
				this.cacheManager.filteredElement.maxEntryBytes
		);
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
		const info = this.renderIsolatedAppearances(
			encoder,
			fp,
			elementsMap,
			rasterScale,
		);
		if (info) filteredTextures.set(fp.element.id, info);
	}

	private hasIsolatedWashAppearances(elementId: string): boolean {
		return (
			this.activeFramePlan?.filterPlans
				.get(elementId)
				?.allAppearancePlans?.some((plan) => plan.washStrokeOpacity != null) ??
			false
		);
	}

	/**
	 * Render every appearance of `fp` in isolation and composite them into an
	 * accumulator (wash strokes apply strokeOpacity exactly once here).
	 * Shared by the top-level filter-plan path and the group container route.
	 */
	private renderIsolatedAppearances(
		encoder: GPUCommandEncoder,
		fp: ElementFilterPlan,
		elementsMap: Map<string, AnyArtObject>,
		rasterScale: number,
	): FilteredTextureInfo | null {
		// Wash isolation (dab render + erosion + pyramid blur) is expensive
		// and, being fixed-R/DPI-scaled, zoom-independent: reuse the committed
		// result until the element's content changes.
		const washCacheKey = this.washResultCacheKey(fp, rasterScale);
		if (washCacheKey) {
			const hit = this.washResultCache.get(fp.element.id);
			if (hit && hit.key === washCacheKey) {
				this.washResultCache.delete(fp.element.id);
				this.washResultCache.set(fp.element.id, hit);
				return this.washCacheInfo(hit);
			}
		}
		const plans = fp.allAppearancePlans!;

		// A live-preview wash re-runs its full isolation every frame, so bound
		// it to what is visible: clip to the viewport and render at display
		// density. Committed strokes render once at full scale and get cached.
		let isolationBounds: WorldBBox = fp.textureBounds;
		let isolationScale = rasterScale;
		const isTransientWash =
			plans.some((plan) => plan.washStrokeOpacity != null) &&
			(fp.element.id === PREVIEW_ELEMENT_SENTINEL_ID ||
				(this.lastTransientElements != null &&
					[...this.lastTransientElements.values()].some(
						(entry) => entry.element.id === fp.element.id,
					)));
		if (isTransientWash) {
			const padWorld = plans.reduce(
				(pad, plan) =>
					plan.washWetEdge
						? Math.max(
								pad,
								Math.min(plan.washWetEdge.width, plan.washBrushSize ?? 0) +
									plan.washWetEdge.blur,
							)
						: pad,
				0,
			);
			const domain = resolveTransientWashDomain({
				textureBounds: fp.textureBounds,
				viewportBounds: this.viewportState.bounds,
				viewportPixelWidth: this.viewportState.width,
				rasterScale,
				padWorld,
			});
			if (domain == null) return null;
			isolationBounds = brandWorldBBox(domain.bounds);
			isolationScale = domain.scale;
		}

		// Collect pre-filters (geometry deformations like zigzag) to apply
		// to each isolated appearance.
		const preFilters = localAppearances(fp.element.filters).filter((f) =>
			isGeometryFilter(f, this.filterRenderer),
		);

		// Create accumulator texture at element-level textureBounds size.
		// Wash plans cap at 4096 px per side (64 MB) so even a huge stroke's
		// result always fits the cross-frame cache — effectiveZoom below
		// scales the isolated render down to match.
		const maxDim = Math.min(
			this.device.limits.maxTextureDimension2D,
			washCacheKey != null ? 4096 : Number.POSITIVE_INFINITY,
		);
		let accWidth = Math.min(
			Math.ceil(isolationBounds.width * isolationScale),
			maxDim,
		);
		let accHeight = Math.min(
			Math.ceil(isolationBounds.height * isolationScale),
			maxDim,
		);
		if (accWidth <= 0 || accHeight <= 0) return null;

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

		// Viewport for blit passes targeting the accumulator
		const effectiveZoom = Math.min(
			accWidth / isolationBounds.width,
			accHeight / isolationBounds.height,
			isolationScale,
		);
		const accViewport = {
			x: (isolationBounds.minX + isolationBounds.maxX) / 2,
			y: (isolationBounds.minY + isolationBounds.maxY) / 2,
			zoom: effectiveZoom,
			rotation: 0,
		};

		for (let i = 0; i < plans.length; i++) {
			const plan = plans[i];

			// Wash strokes: the appearance renders flow-only into
			// the isolated texture; its opacity and strokeOpacity apply exactly
			// once at composite time below.
			const isWash = plan.washStrokeOpacity != null;
			// rasterScale is DPI-derived (zoom-free), so the wet edge's texel
			// grid is already viewport-independent at this scale; a
			// brush-derived fixed-R blowup produced multi-hundred-MB
			// accumulators on large strokes.
			// Virtual element with element-level pre-filters + per-appearance pre sub-filters + this single appearance
			const virtualElement = {
				...fp.element,
				filters: [
					...preFilters,
					...plan.preSubFilters,
					isWash ? { ...plan.appearance, opacity: 1 } : plan.appearance,
				],
			} as AnyArtObject;

			// Render to isolated offscreen texture using unified element-level
			// bounds so all appearances share the same coordinate space when
			// composited onto the accumulator.
			const wetStroke = CanvasLayer.wetStrokeOf(plan.appearance);
			const appResult = wetStroke
				? this.renderWetAppearanceToTexture(
						encoder,
						fp.element,
						wetStroke,
						isolationBounds,
						isolationScale,
						this.viewportManager.getTransformIndex(fp.element.id),
					)
				: this.offscreen.renderElementToTexture(
						encoder,
						virtualElement,
						isolationBounds,
						elementsMap,
						isolationScale,
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
					isolationBounds,
				);
			}

			// Watercolor rim on the isolated wash appearance.
			if (isWash && plan.washWetEdge) {
				const scratch = this.washCompositor.applyWetEdge(
					encoder,
					appTexture,
					plan.washWetEdge,
					1 / appResult.effectiveZoom,
					plan.washBrushSize ?? 0,
				);
				for (const texture of scratch) this.offscreen.deferDestroy(texture);
			}

			// Blit appearance result onto accumulator
			// (appTexture now contains filtered result via copyTextureToTexture)
			const entry = this.uniformScope.acquire(accViewport, accWidth, accHeight);
			this.pushViewportBinding(entry);

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
					placementOpacity: createPlacementOpacity(
						plan.opacity * (plan.washStrokeOpacity ?? 1),
					),
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
				});

				this.composite.blitTextureToCanvas(
					blitPass,
					appTexture,
					appResult.placement.bounds,
					plan.opacity * (plan.washStrokeOpacity ?? 1),
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
				isolationBounds,
			);
		}

		// Compute blit UV rect to crop pool quantization margin.
		const accUsedW = isolationBounds.width * effectiveZoom;
		const accUsedH = isolationBounds.height * effectiveZoom;
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

		if (washCacheKey != null) {
			const entry = {
				key: washCacheKey,
				texture: accTexture,
				placement: { bounds: fp.textureBounds, uvRect: accBlitUvRect },
				elementBounds: fp.bounds,
				textureBounds: fp.textureBounds,
				bytes: accWidth * accHeight * 4,
			};
			const previous = this.washResultCache.get(fp.element.id);
			if (previous) {
				this.washResultCacheBytes -= previous.bytes;
				this.offscreen.deferDestroy(previous.texture);
				this.washResultCache.delete(fp.element.id);
			}
			this.washResultCache.set(fp.element.id, entry);
			this.washResultCacheBytes += entry.bytes;
			this.evictWashResultsOverBudget();
			return this.washCacheInfo(entry);
		}

		// accTexture contains the final result (applyFilters writes back via copyTextureToTexture)
		const accRef = createFrameTextureRef(accTexture, (texture) =>
			this.offscreen.deferDestroy(texture),
		);
		const accSurface = createRenderSurface(
			accRef,
			{
				kind: "world-aabb",
				bounds: isolationBounds,
				uvRect: accBlitUvRect,
			},
			{
				role: "color",
				alphaMode: "premultiplied",
				opacityState: "intrinsic",
			},
		);
		return {
			source: accSurface,
			output: accSurface,
			elementBounds: fp.bounds,
			textureBounds: isolationBounds,
		};
	}

	/**
	 * Identity of everything drawn below `elementId` that overlaps `bounds` —
	 * what a mixing stroke's result depends on besides its own content
	 *. Document updates are immutable, so object identity IS
	 * content identity: a per-object serial captures a change without deep
	 * hashing. Null when the element is not in this frame's plan, which makes
	 * the caller skip caching rather than cache under a wrong key.
	 */
	private backdropContentKeyFor(
		elementId: string,
		bounds: BoundingBox,
	): string | null {
		const plan = this.activeFramePlan;
		if (!plan) return null;
		const boundsCache = this.viewportManager.getBoundsCache();
		const parts: string[] = [];
		let reachedTarget = false;

		const visit = (element: AnyArtObject): boolean => {
			if (element.id === elementId) return true;
			const elementBounds = calculateElementBounds(
				element,
				plan.elementsMap,
				boundsCache,
			);
			if (boundsIntersect(elementBounds, bounds)) {
				// A mixing stroke's own key already folds in what it mixed
				// from, so using it here carries invalidation up the chain.
				const mixKey = this.mixStrokeRenderer?.resultKeyOf(element.id);
				parts.push(`${element.id}#${mixKey ?? this.objectSerial(element)}`);
			}
			if (isGroup(element)) {
				for (const childId of element.childIds) {
					const child = plan.elementsMap.get(childId);
					if (child && visit(child)) return true;
				}
			}
			return false;
		};

		for (const layerPlan of plan.layerPlans) {
			parts.push(
				`L${layerPlan.layerId}:${layerPlan.opacity}:${layerPlan.blendMode}`,
			);
			for (const element of layerPlan.elements) {
				if (visit(element)) {
					reachedTarget = true;
					break;
				}
			}
			if (reachedTarget) break;
		}
		if (!reachedTarget) return null;
		if (this.activeDocument) {
			parts.push(`A${this.objectSerial(this.activeDocument.artboards)}`);
		}
		// Hashed, not joined verbatim: nested mixing keys would otherwise
		// compound in length down a chain of strokes.
		return CanvasLayer.hashKeyString(parts.join("|")).toString(36);
	}

	/** FNV-1a over a key string; unsigned so the base-36 form stays short. */
	private static hashKeyString(value: string): number {
		let hash = 0x811c9dc5;
		for (let i = 0; i < value.length; i++) {
			hash ^= value.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193);
		}
		return hash >>> 0;
	}

	/** Stable per-object number, assigned on first sight. */
	private objectSerial(object: object): number {
		let serial = this.objectSerials.get(object);
		if (serial == null) {
			serial = ++this.objectSerialCounter;
			this.objectSerials.set(object, serial);
		}
		return serial;
	}

	/** Content key of a cacheable wash plan, or null when not cacheable
	 *  (non-wash plans, previews, non-path elements). */
	private washResultCacheKey(
		fp: ElementFilterPlan,
		rasterScale: number,
	): string | null {
		const element = fp.element;
		if (element.id === PREVIEW_ELEMENT_SENTINEL_ID) return null;
		if (element.type !== "path") return null;
		if (!fp.allAppearancePlans?.some((p) => p.washStrokeOpacity != null)) {
			return null;
		}
		const cached = this.washKeyCache.get(element);
		if (cached != null) return cached;
		const filters = localAppearances(element.filters);
		let filtersFp = this.washFiltersFpCache.get(filters);
		if (filtersFp == null) {
			filtersFp = JSON.stringify(filters);
			this.washFiltersFpCache.set(filters, filtersFp);
		}
		const key = [
			hashSegmentsWithMetadata(element.segments).toString(36),
			filtersFp,
			element.opacity,
			JSON.stringify(element.transform),
			rasterScale,
			fp.textureBounds.minX,
			fp.textureBounds.minY,
			fp.textureBounds.maxX,
			fp.textureBounds.maxY,
		].join(":");
		this.washKeyCache.set(element, key);
		return key;
	}

	private washCacheInfo(entry: {
		texture: GPUTexture;
		placement: { bounds: WorldBBox; uvRect: BlitUVRect };
		elementBounds: WorldBBox;
		textureBounds: WorldBBox;
	}): FilteredTextureInfo {
		// A fresh no-op ref per frame: the cache owns the texture, so the
		// frame-resource release must not destroy it.
		const ref = createFrameTextureRef(entry.texture, () => {});
		const surface = createRenderSurface(
			ref,
			{
				kind: "world-aabb",
				bounds: entry.placement.bounds,
				uvRect: entry.placement.uvRect,
			},
			{
				role: "color",
				alphaMode: "premultiplied",
				opacityState: "intrinsic",
			},
		);
		return {
			source: surface,
			output: surface,
			elementBounds: entry.elementBounds,
			textureBounds: entry.textureBounds,
		};
	}

	private evictWashResultsOverBudget(): void {
		// Sized with the texture pool: fixed-R accumulators run a few MB per
		// stroke and an undersized budget thrashes (one eviction+rerun per
		// frame, observed at 10% zoom on a stroke-heavy document).
		const MAX_BYTES = 384 * 1024 * 1024;
		while (this.washResultCacheBytes > MAX_BYTES) {
			const oldest = this.washResultCache.entries().next().value;
			if (!oldest) break;
			const [id, entry] = oldest;
			this.washResultCacheBytes -= entry.bytes;
			this.offscreen.deferDestroy(entry.texture);
			this.washResultCache.delete(id);
		}
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
	 * capture, applies filters, and blits the result through a mask texture
	 * that clips it to the element shape.
	 */
	private processBackdropElement(
		encoder: GPUCommandEncoder,
		backdropViewport: Viewport,
		textureView: GPUTextureView,
		backdropSourceTexture: GPUTexture,
		bdElem: BackdropElementEntry,
		elementsMap: Map<string, AnyArtObject>,
		alphaMultiplier: number,
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
		});
		maskPass.setPipeline(this.strokePipeline);
		maskPass.setBindGroup(0, this.viewportBinding.active.bindGroup);
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
		});
		// Two-draw replace composite: punch dst by (1 - mask·opacity), then
		// add the filtered backdrop (see blitBackdropPunchPipeline).
		blitPass.setBindGroup(0, this.viewportBinding.active.bindGroup);
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
		const ribbons = compositeContext ? this.brushRenderer.ribbons : null;

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
			// Guide paths stay visible on canvas but are excluded from exports
			// (schema: Path.isGuide "Excluded from export").
			if (
				element.type === "path" &&
				element.isGuide &&
				this.renderState.isExport
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
			const viewportBounds =
				this.viewportState.drawRegion ?? this.viewportState.bounds;
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
			// Record where this element's rendered output lands — the "old
			// bounds" side of a later partial redraw's dirty rect.
			if (pipelineType === "main") {
				this.lastElementWorldBounds.set(element.id, cullBounds);
			}

			// Set current transform index and mask bind group for this element.
			this.renderState.currentTransformIndex =
				this.viewportManager.getTransformIndex(element.id);
			this.renderState.currentMaskBindGroup =
				this.inlineMaskEntries.get(element.id)?.bindGroup ??
				this.dummyMaskBindGroup;

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
				ribbons?.flush();
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
					const previousCoverage = filteredComposite.coverage;
					const masked = this.offscreen.applyWorldMasksToTexture(
						compositeContext.encoder,
						filteredComposite,
						inlineMasks,
						this.viewportState.current?.zoom ?? 1,
						solidBounds,
					);
					// The coverage side-channel takes the same ordered stack in one
					// call so it matches the color surface's crop.
					const maskedCoverage =
						masked && previousCoverage
							? this.offscreen.applyWorldMasksToTexture(
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
									inlineMasks,
									this.viewportState.current?.zoom ?? 1,
									solidBounds,
								)
							: null;
					if (masked) {
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
				// Preserve draw order by flushing pending batches before textured blits.
				ribbons?.flush();

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
						activePass.setBindGroup(0, this.viewportBinding.active.bindGroup);
						activePass.setBindGroup(1, this.transformsBindGroup!);
						activePass.setBindGroup(2, this.dummyGradientBindGroup);
						activePass.setBindGroup(3, this.renderState.currentMaskBindGroup);
					}
				} else if (needsComposite) {
					const compositeCtx = compositeContext!;
					const captureTexture = this.compositeState.captureTexture!;
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
					activePass.setBindGroup(0, this.viewportBinding.active.bindGroup);
					activePass.setBindGroup(1, this.transformsBindGroup!);
					activePass.setBindGroup(2, this.dummyGradientBindGroup);
					activePass.setBindGroup(3, this.renderState.currentMaskBindGroup);
				} else {
					if (filteredData.postMasks) {
						this.offscreen.drawSurfaceWithAtlasMasks(
							activePass,
							filteredData.output,
							effectiveAlpha,
							filteredData.postMasks,
							this.viewportBinding.active.bindGroup,
						);
					} else {
						this.composite.blitTextureToCanvas(
							activePass,
							filteredData.output.texture.texture,
							filteredData.output.placement.bounds,
							effectiveAlpha,
							filteredData.output.placement.uvRect,
							this.blitPipeline,
						);
					}
					activePass.setPipeline(this.strokePipeline);
					activePass.setBindGroup(0, this.viewportBinding.active.bindGroup);
					activePass.setBindGroup(1, this.transformsBindGroup!);
					activePass.setBindGroup(2, this.dummyGradientBindGroup);
					activePass.setBindGroup(3, this.renderState.currentMaskBindGroup);
				}
				// Don't render children - they're already in the filtered texture
			} else if (needsComposite) {
				ribbons?.flush();
				const compositeCtx = compositeContext!;
				const captureTexture = this.compositeState.captureTexture!;

				// End the active pass before offscreen rendering on the same encoder
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
				activePass.setBindGroup(0, this.viewportBinding.active.bindGroup);
				activePass.setBindGroup(1, this.transformsBindGroup!);
				activePass.setBindGroup(2, this.dummyGradientBindGroup);
				activePass.setBindGroup(3, this.renderState.currentMaskBindGroup);
			} else if (
				isPath(element) &&
				element.eraseMasks &&
				element.eraseMasks.length > 0 &&
				compositeContext
			) {
				// EraseMask path: render to offscreen with alpha subtraction
				ribbons?.flush();
				// renderWithEraseMasks ends and re-creates the active pass.
				activePass = this.offscreen.renderWithEraseMasks(
					this.activeEncoder!,
					activePass,
					element,
					elementsMap,
					effectiveAlpha,
					elementBounds,
					compositeContext,
				);
				this.restoreViewportUniformsToGPU();
				activePass.setPipeline(this.strokePipeline);
				activePass.setBindGroup(0, this.viewportBinding.active.bindGroup);
				activePass.setBindGroup(1, this.transformsBindGroup!);
				activePass.setBindGroup(2, this.dummyGradientBindGroup);
				activePass.setBindGroup(3, this.renderState.currentMaskBindGroup);
			} else if (isPath(element)) {
				// A group's pre-filters propagate to every child, so fold them in
				// before anything inspects or resolves this path.
				const effectivePath = parentPreFilters?.length
					? ({
							...element,
							filters: [
								...localAppearances(element.filters),
								...parentPreFilters,
							],
						} as Path)
					: element;

				// Routing only needs the appearance set; resolving the geometry
				// is deferred to the branch that actually draws.
				const drawableApps = collectDrawableAppearances(
					effectivePath,
					this.filterRenderer,
				);

				// Check if all strokes are batch-eligible.
				const enabledStrokes = drawableApps.filter(
					(f) => f.processor === "stroke",
				) as StrokeAppearance[];
				const batchableStrokes = enabledStrokes.filter((s) => {
					if (!s.paramData.params.brushSettings) return false;
					if (!s.paramData.params.strokeColor) return false;
					// Only ribbon strokes batch: dab strokes draw immediately,
					// wet strokes keep their isolated path, and geometric
					// strokes render through ElementRenderer.
					return s.paramData.params.brushSettings.engine === "ribbon";
				});
				const canBatch =
					ribbons &&
					batchableStrokes.length === enabledStrokes.length &&
					enabledStrokes.length > 0;

				if (canBatch) {
					const passes = resolveAppearancePasses(
						effectivePath,
						this.filterRenderer,
					);

					// Render appearances in filters array order
					for (const { appearance: app, segments, cacheKey } of passes) {
						const appAlpha = effectiveAlpha * app.opacity;
						if (app.processor === "fill") {
							// Flush pending stroke batch before rendering fill
							ribbons.flush();

							const fill = (app as FillAppearance).paramData.params.fill;
							if (fill) {
								this.elements.renderPathFill(
									activePass,
									segments,
									fill,
									appAlpha,
									cacheKey,
								);
							}
						} else {
							const strokeApp = app as StrokeAppearance;
							const strokeColor = strokeApp.paramData.params.strokeColor;
							if (!strokeColor) continue;
							const settings =
								strokeApp.paramData.params.brushSettings ??
								createDefaultBrushSettings();
							const tip = settings.tip?.kind === "image" ? settings.tip : null;

							const textureUid = resolveBrushTextureUid(
								settings,
								this.brushRenderer.textures,
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
							if (tip) {
								// The first source is the tip; the rest are variants.
								for (const uid of resolveScatterSourceUids(
									tip.sources.slice(1),
								)) {
									this.elements.ensureBrushTexture(uid, files);
								}
								const startUid = resolveOptionalSourceUid(tip.startSource);
								if (startUid) {
									this.elements.ensureBrushTexture(startUid, files);
								}
								const endUid = resolveOptionalSourceUid(tip.endSource);
								if (endUid) {
									this.elements.ensureBrushTexture(endUid, files);
								}
							}

							ribbons.enqueue(
								activePass,
								{
									path: element,
									segments,
									strokeColor,
									settings,
									alphaMultiplier: appAlpha,
									transformIndex: this.renderState.currentTransformIndex,
								},
								this.brushDrawBindings(),
							);
						}
					}
				} else {
					// Non-batch path (non-batchable strokes or no strokes).
					ribbons?.flush();
					const passes = resolveAppearancePasses(
						effectivePath,
						this.filterRenderer,
					);
					if (passes.length > 0) {
						this.elements.renderAppearancePasses(
							activePass,
							effectivePath,
							passes,
							effectiveAlpha,
							pipelineType,
						);
					}
				}
			} else if (isGroup(element)) {
				ribbons?.flush();
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
					activePass.end();
					const isolated = this.offscreen.renderGroupToTexture(
						this.activeEncoder!,
						element,
						brandWorldBBox(cullBounds),
						elementsMap,
						localBoundsCache,
					);
					activePass = compositeContext.restartPass();
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
					const split = splitGroupAppearances(
						localAppearances(element.filters),
					);
					beforeApps = split.before;
					afterApps = split.after;
				}

				// Extract group-level pre-filters to propagate to children.
				// Nested groups apply child→parent order (innermost first).
				const groupPreFilters = localAppearances(element.filters).filter((f) =>
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
					// A clip alone does not isolate the group: with its effective
					// mask rendered and a normal blend, the children draw inline
					// (the fragment shader samples the mask), so their own blend
					// modes see the document underneath just as they would
					// outside the clip. A blended group falls back to the
					// offscreen flow, which composites it as one layer.
					if (
						this.hasInlineClipMask(element.id) &&
						(element.blendMode === "normal" || element.blendMode === undefined)
					) {
						activePass = this.renderGroupAppearanceFilters(
							activePass,
							beforeApps,
							combinedSegments ?? [],
							childAlpha,
							pipelineType,
							element.id,
							localAppearances(element.filters),
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
							localAppearances(element.filters),
							compositeContext,
						);
					} else {
						const outerMasks = this.resolveSubtreeMasks(element.id);
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
					localAppearances(element.filters),
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
					localAppearances(element.filters),
					compositeContext,
				);
			} else {
				// Non-path, non-group elements: image, compound-path, text
				ribbons?.flush();
				const effectiveElement = parentPreFilters?.length
					? ({
							...element,
							filters: [
								...localAppearances(element.filters),
								...parentPreFilters,
							],
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

		// Flush any remaining batched strokes at loop end.
		ribbons?.flush();

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
				activePass.end();
				const result = this.offscreen.renderElementToTexture(
					this.activeEncoder,
					offscreenPath as unknown as AnyArtObject,
					bounds,
				);
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
					activePass.setBindGroup(0, this.viewportBinding.active.bindGroup);
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
			writeMaskInfo: (masks) => this.viewportManager.writeMaskInfoOnly(masks),
			renderElementToMask: (...args) =>
				this.elements.renderElementToMask(...args),
			renderElements: (...args) => this.renderElements(...args),
			paintHash: (element, elementsMap) =>
				computePaintHash(element, elementsMap, this.paintHashContext()),
			viewportState: this.viewportState,
			renderState: this.renderState,
			setActiveBindGroup: (entry, replace) => {
				if (entry) {
					if (replace) {
						this.setViewportBinding(entry);
					} else {
						this.pushViewportBinding(entry);
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
	 * Drop the cached composite frame so the next viewport-only frame
	 * re-renders instead of blitting a stale composite (async resource load,
	 * external content change). Document content itself is rendered every
	 * frame and holds no cache of its own.
	 */
	public invalidateDocumentCache(): void {
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
		const textureManager = this.brushRenderer.textures;
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

	/**
	 * Render one wet appearance through the wet layer, in place of the normal
	 * offscreen element render inside the wash isolation — every wet stroke is
	 * a wash stroke, since normalize forces the paint mode.
	 */
	private renderWetAppearanceToTexture(
		encoder: GPUCommandEncoder,
		element: AnyArtObject,
		{ settings, strokeColor }: WetStroke,
		bounds: WorldBBox,
		scale: number,
		transformIndex: number,
	): RasterizedRenderSurface | null {
		if (element.type !== "path") return null;
		return this.brushRenderer.wet.renderAppearance(
			encoder,
			{
				path: element,
				segments: element.segments ?? [],
				strokeColor,
				settings,
				alphaMultiplier: 1,
				transformIndex,
			},
			this.viewportManager.getComposedTransformCache().get(element.id) ??
				getTransform(element),
			bounds,
			scale,
			{
				transformsBindGroup: this.transformsBindGroup ?? undefined,
				maskBindGroup: this.renderState.currentMaskBindGroup,
			},
		);
	}

	/** The wet settings of a stroke appearance, or null. */
	private static wetStrokeOf(appearance: Filter): WetStroke | null {
		if (appearance.processor !== "stroke") return null;
		const { brushSettings, strokeColor } = (appearance as StrokeAppearance)
			.paramData.params;
		if (brushSettings == null || strokeColor == null) return null;
		return resolveBrushRenderRequirements(brushSettings).wetEnabled
			? { settings: brushSettings, strokeColor }
			: null;
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
			this.pushViewportBinding(entryUniform);

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
			});

			renderCell(passEncoder, entryUniform.bindGroup, tempViewport);
			passEncoder.end();
			this.popViewportBinding();
		}

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
		this.backdropCaptureManager.destroy();
		this.backdropEffectCoordinator.destroy();

		// Release this canvas's backdrop-composite drivers held by filter handlers.
		for (const handler of this.filterRenderer.getHandlers().values()) {
			handler.detachCanvas?.(this.canvasId);
		}
		this.mixStrokeRenderer?.destroy();
		this.mixStrokeRenderer = null;
		this.blurStrokeRenderer?.destroy();
		this.blurStrokeRenderer = null;
		this.brushRenderer.destroy();
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
		for (const entry of this.washResultCache.values()) {
			entry.texture.destroy();
		}
		this.washResultCache.clear();
		this.washResultCacheBytes = 0;
		this.texturePool.destroy();
		this.stripFrame.destroy();
		for (const buf of this.backdropBlitPool.buffers) buf.destroy();
		this.backdropBlitPool.buffers.length = 0;

		this.compositeState.captureTexture?.destroy();
		this.compositeState.captureTexture = null;
		this.compositeState.layerTexture?.destroy();
		this.compositeState.layerTexture = null;
		this.compositeState.prebufTexture?.destroy();
		this.compositeState.prebufTexture = null;
		this.compositeState.canvasBaseTexture?.destroy();
		this.compositeState.canvasBaseTexture = null;
		this.compositeState.backdropMask.texture?.destroy();
		this.compositeState.backdropMask.texture = null;
		this.compositeState.backdropMask.width = 0;
		this.compositeState.backdropMask.height = 0;
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
		}
		this.gradient.bufferPool.length = 0;

		// Cleanup text path cache
		this.textState.pathCache.clear();
		this.textState.pendingPathCacheKeys.clear();
		this.cacheManager.clearAll();
	}
}

const EMPTY_ID_SET: ReadonlySet<string> = new Set();
/** Full-bounds cached bakes may cover at most this many canvas surfaces. */
const FILTER_CACHE_FULL_BAKE_BUDGET_FACTOR = 4;
const PROGRESSIVE_BAKES_PER_FRAME = 12;

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

	// Effective mask key per clip group: own clip path intersected with the
	// nearest enclosing clip group's effective mask, recursively.
	const maskKeys = new Map<string, string>();
	const effectiveMaskKey = (group: Group): string => {
		const cached = maskKeys.get(group.id);
		if (cached) return cached;
		const parent = enclosingClipGroup(group.id, elementsMap, parentGroupMap);
		const key = clipMaskKey(
			group.clipPathId!,
			parent ? effectiveMaskKey(parent) : undefined,
		);
		maskKeys.set(group.id, key);
		return key;
	};

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

		const parent = enclosingClipGroup(element.id, elementsMap, parentGroupMap);
		groups.push({
			groupId: element.id,
			clipPathId: element.clipPathId,
			clipPath,
			groupBounds,
			maskKey: effectiveMaskKey(element),
			parentMaskKey: parent ? effectiveMaskKey(parent) : undefined,
		});
	}
	return groups;
}

/** The nearest ancestor group that carries a clip path, if any. */
function enclosingClipGroup(
	elementId: string,
	elementsMap: Map<string, AnyArtObject>,
	parentGroupMap: ReadonlyMap<string, string>,
): Group | null {
	let parentId = parentGroupMap.get(elementId);
	while (parentId != null) {
		const parent = elementsMap.get(parentId);
		if (parent && isGroup(parent) && parent.clipPathId != null) return parent;
		parentId = parentGroupMap.get(parentId);
	}
	return null;
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
		const key = entry.maskKey;
		const maskEntry = atlas.getMaskEntry(key);
		if (!maskEntry) continue;
		masksByKey.set(key, maskEntry);

		const group = elementsMap.get(entry.groupId);
		if (!group || !isGroup(group)) continue;
		// The effective mask already carries every enclosing clip, so the
		// children need just this one — which keeps them on the inline path.
		// The group itself keeps the inherited stack for the offscreen fallback.
		const stack = [plannedMask(key, maskEntry)];
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

	const clipMaskKeyByGroup = new Map(
		clipGroups.map((entry) => [entry.groupId, entry.maskKey]),
	);
	for (const [elementId, masks] of maskStacks) {
		const element = elementsMap.get(elementId);
		if (!element) continue;
		const groupPlan = isGroup(element)
			? groupCompositionPlans.get(elementId)
			: undefined;
		// A group draws its children inline when nothing composites it as one
		// layer: a normal blend, and either no plan at all or a clip as the
		// only reason with its effective mask rendered. Its children then keep
		// their own inline masks and blend against the document like resvg
		// does. A blended group is baked and composited whole, so it keeps the
		// subtree plan that masks that bake.
		const inlineContainer =
			groupPlan != null &&
			(element.blendMode ?? "normal") === "normal" &&
			(element.compositionMode ?? "normal") === "normal" &&
			(groupPlan.kind === "passthrough" ||
				(groupPlan.kind === "isolated" &&
					groupPlan.reasons.every((reason) => reason === "clip") &&
					masksByKey.has(clipMaskKeyByGroup.get(elementId) ?? "")));
		const plan = planMaskApplication({
			node: isGroup(element) ? "subtree" : "leaf",
			masks,
			outputPlacement: dependsOnBackdrop(element) ? "world-quad" : "world-aabb",
			hasPostFilter: filterPlanIds.has(element.id),
			requiresSubtreeBoundary:
				drawsViaTexture(element) ||
				(!inlineContainer &&
					groupPlan != null &&
					groupPlanRequiresSurface(groupPlan)),
			inlineContainer,
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
 * Def sources only exist in the `source` shape (`textureFileUid`-style
 * settings never reference defs), so reading the raw params structurally —
 * like `collectPatternDefIdsInUse` does — is sufficient.
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

function setsIntersect(
	a: ReadonlySet<string>,
	b: ReadonlySet<string>,
): boolean {
	if (b.size === 0 || a.size === 0) return false;
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	for (const value of small) if (large.has(value)) return true;
	return false;
}

function bytesPerTexel(format: GPUTextureFormat): number {
	return format.includes("32float") ? 16 : format.includes("16float") ? 8 : 4;
}

/** Whether an element or any descendant is a 3D reference scene. Their
 *  texture updates arrive from the three.js runtime without any element
 *  delta or paint-hash change, so a cached bake could serve a stale scene. */
function subtreeContainsReference3D(
	element: AnyArtObject,
	elementsMap: Map<string, AnyArtObject>,
): boolean {
	if (element.type === "reference3d") return true;
	if (!isGroup(element)) return false;
	return element.childIds.some((childId) => {
		const child = elementsMap.get(childId);
		return child != null && subtreeContainsReference3D(child, elementsMap);
	});
}

/**
 * Rebuild a FilteredTextureInfo from a cached filtered bake. Source and output
 * share the borrowed cache texture — borrowed refs are skipped by frame
 * release and by post-mask replacement, so the cached texture survives.
 */
function buildCachedFilteredTextureInfo(
	entry: FilteredElementCacheEntry,
	fp: ElementFilterPlan,
): FilteredTextureInfo {
	const ref = createBorrowedTextureRef(entry.texture, "appearance-cache");
	const placement = {
		kind: "world-aabb" as const,
		bounds: entry.bounds,
		uvRect: entry.uvRect,
	};
	const semantics = {
		role: "color" as const,
		alphaMode: "premultiplied" as const,
		opacityState: "intrinsic" as const,
	};
	return {
		source: createRenderSurface(ref, placement, semantics),
		output: createRenderSurface(ref, placement, semantics),
		elementBounds: fp.bounds,
		textureBounds: fp.textureBounds,
	};
}

function buildCachedMaskedTextureInfo(
	entry: FilteredElementCacheEntry,
	bounds: WorldBBox,
): FilteredTextureInfo {
	const ref = createBorrowedTextureRef(entry.texture, "appearance-cache");
	const placement = {
		kind: "world-aabb" as const,
		bounds: entry.bounds,
		uvRect: entry.uvRect,
	};
	const semantics = {
		role: "color" as const,
		alphaMode: "premultiplied" as const,
		opacityState: "intrinsic" as const,
	};
	return {
		source: createRenderSurface(ref, placement, semantics),
		output: createRenderSurface(ref, placement, semantics),
		elementBounds: bounds,
		textureBounds: bounds,
	};
}
