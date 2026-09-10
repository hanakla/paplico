import { localAppearances } from "../../../document/appearancePresets";
import {
	type AnyArtObject,
	type BoundingBox,
	type Color,
	type CubicBezierSegment,
	type Filter,
	type FilterEntry,
	isBlend,
	isFilterEnabled,
	type Path,
	type TextElement,
	type Viewport,
} from "../../../schema";
import type { WorldBBox } from "../../../utils/geometry/bounds";
import type { QuadCorners } from "../../../utils/geometry/quadProjection";
import type { ExtrudeMeshBaker } from "../../filters/Extrude3D/ExtrudeMeshBaker";
import type { GPUTimingProfiler } from "../../GPUTimingProfiler";
import type { BlitLayer, BlitUVRect } from "../CanvasLayerTypes";
import type {
	AppearanceCache,
	AppearanceCacheEntry,
} from "../caches/AppearanceCache";
import type { CompoundPathCache } from "../caches/CompoundPathCache";
import type {
	BackdropBlurLevels,
	BackdropEffectCoordinator,
} from "./BackdropEffectCoordinator";
import type { MeshPassRenderer } from "./MeshPassRenderer";
import {
	createBorrowedTextureRef,
	type RasterizedRenderSurface,
	type TextureRef,
} from "./RenderSurface";
import type { TexturePool } from "./TexturePool";

// --- Filter Handler Interface ---

interface FilterSceneInfo {
	/** Width and height of the sourceTexture passed to the filter.
	 * When pool padding is stripped, equals Math.ceil(contentBounds * dpiScale);
	 * otherwise equals the raw GPU texture dimensions. */
	textureSize: { width: number; height: number };
	/** Rasterization scale of the source texture in texels per world px.
	 * Filter processors must scale spatial parameters (e.g. blur radius) by
	 * this value. For element filters this is the document rasterization scale
	 * (rasterizationDpi/72, possibly clamped by the GPU texture limit) and is
	 * invariant to viewport zoom, display DPI, and export scale. For backdrop
	 * filters this remains the live viewport zoom. */
	dpiScale: number;
}

/**
 * Element + scene access that a self-sizing post-filter (extrude3d) needs to
 * build its own geometry and bake the element's source appearances. Populated
 * only on element filter passes that can supply it (executeFilterPlans);
 * absent for backdrop, sub-filter, and offscreen callers. Meaningless to
 * image-only handlers, which structurally ignore it.
 */
export interface FilterGeometryContext {
	element: AnyArtObject;
	/** Override-merged frame view (tool previews + ancestor group transforms). */
	elementsMap: Map<string, AnyArtObject>;
	/** CompoundPath resolver used by group outline flattening. */
	compoundPathCache: CompoundPathCache;
	/** Child → parent group mapping (from ViewportManager). */
	getParentGroupMap: () => ReadonlyMap<string, string>;
	/**
	 * Resolve a pattern def to its tiled GPU texture (one seamless tile) and
	 * world-unit tile size. Null when the def is missing/cold.
	 */
	resolvePatternTexture: (defId: string) => {
		texture: GPUTexture;
		tileWorldSize: { width: number; height: number };
		revision: number;
	} | null;
	/**
	 * Rasterize a temp element (a fill-only path, or a group wrapping the real
	 * children) into an offscreen texture covering `textureBounds`. The filter
	 * only supplies the temp element it wants baked.
	 */
	renderElementToTexture: (
		encoder: GPUCommandEncoder,
		element: AnyArtObject,
		textureBounds: WorldBBox,
		elementsMap: Map<string, AnyArtObject> | undefined,
		rasterScale: number,
	) => RasterizedRenderSurface | null;
	texturePool: TexturePool;
	/**
	 * Resolve a Text element's already-cached glyph outline (local-space
	 * `Path` per non-empty glyph), or null on a cache miss (font still
	 * loading). On a miss, also call `requestTextOutline` to warm the cache
	 * for a later frame — matching the flicker-prevention pattern the normal
	 * text render path already uses for the same async-font-load gap.
	 */
	resolveTextOutline: (
		element: TextElement,
	) => { paths: Path[]; localBounds: BoundingBox } | null;
	/** Fire-and-forget: ensure a Text element's glyph paths are loaded and
	 *  cached (async font loading) for a subsequent frame. */
	requestTextOutline: (element: TextElement) => void;
	/** Whether an embedded image file's GPU texture has finished decoding
	 *  (async image load). Used to invalidate a cached bake once a
	 *  previously-not-ready image child becomes available. */
	isImageReady: (fileUid: string) => boolean;
}

/**
 * Context passed to filter handlers for post-processing.
 *
 * The source texture always covers the full textureBounds (element bounds +
 * filter expansion margin) regardless of viewport position or canvas size.
 * This guarantees a stable aspect ratio: UV (0,0)–(1,1) always maps to
 * the complete element region, so filter shaders need not account for
 * viewport clipping or canvas-size clamping.
 */
interface FilterCoordinateSpace {
	worldSize: { width: number; height: number };
	sourceOffset: { x: number; y: number };
}

export interface FilterProcessorContext {
	device: GPUDevice;
	sourceTexture: GPUTexture;
	targetTexture: GPUTexture;
	commandEncoder: GPUCommandEncoder;
	profiler?: GPUTimingProfiler | null;
	timingLabel?: string;
	sceneInfo: FilterSceneInfo;
	/**
	 * View over the engine AppearanceCache, pre-bound to the element being
	 * filtered — a handler can only reach entries under its own appearance uid
	 * within that element. Present when the caller passed an appearance scope
	 * to applyFilters. Eviction and destroy() are driven by the engine
	 * (RenderCacheManager liveness pruning / teardown).
	 */
	appearanceCache?: {
		get(appearanceUid: string): AppearanceCacheEntry | undefined;
		set(appearanceUid: string, entry: AppearanceCacheEntry): void;
		/** Drop the entries of per-instance appearances beyond `liveCount` —
		 *  see AppearanceCache.pruneInstances. */
		pruneInstances(baseUid: string, liveCount: number): void;
	};
	/**
	 * Element + scene access for self-sizing geometry filters (extrude3d).
	 * Present only on element filter passes that can supply it.
	 */
	geometry?: FilterGeometryContext;
	/**
	 * Exact world-px size of the content area UV [0,1] maps to, derived from
	 * applyFilters' contentBounds. Unlike textureSize / dpiScale, it does not
	 * inherit the ceil/pool quantization of the texture dimensions, so a
	 * filter can size texture-local patterns in world px identically across
	 * rasterization DPI.
	 */
	sourceWorldSize?: { width: number; height: number };
	/**
	 * Exact texel position of the content's top-left corner inside
	 * sourceTexture (fractional). Offscreen passes centre the content, and the
	 * padding strip copies at integer texel origins, so the content sits up to
	 * one texel off the texture origin — by a DPI-dependent amount. A filter
	 * that anchors a grid or pattern to the content (pixelate) needs this
	 * offset; translation-invariant patterns (noise) can ignore it.
	 */
	sourceContentOffset?: { x: number; y: number };
	/**
	 * Optional unclipped coordinate space used to anchor spatial effects when
	 * sourceTexture contains only a captured subsection of the full region.
	 * sourceOffset is the subsection's top-left position in world px, with Y
	 * increasing downwards to match texture coordinates.
	 */
	coordinateSpace?: FilterCoordinateSpace;
	/**
	 * Shared backdrop pyramid accessor (backdrop filter passes only): the
	 * pre-blurred levels bracketing `sigma` (in sceneInfo.dpiScale texels) over
	 * the source region, or null when unavailable — the filter then blurs on
	 * its own. Declare the sigma via FilterHandler.getBackdropBlurSigma so the
	 * pyramid is planned deep enough.
	 */
	backdropBlur?: (sigma: number) => BackdropBlurLevels | null;
	/**
	 * The chain's untouched input (SVG's SourceGraphic): the content-sized
	 * source as it was before the first pass ran. Present only when a handler
	 * in the chain declared needsSourceGraphic, and only until a self-sizing
	 * pass replaces the working texture (the sizes no longer correspond).
	 */
	sourceGraphicTexture?: GPUTexture;
}

/**
 * The mask a self-sized underlay filter draws from: an alpha coverage texture
 * plus the world quad its used sub-rect maps onto.
 */
export interface UnderlayCoverage {
	/** Alpha channel holds the coverage; rgb is ignored. */
	texture: GPUTexture;
	/** Used sub-rect of `texture`. */
	uvRect: BlitUVRect;
	/** World-space corners `uvRect` maps onto (TL → TR → BR → BL). */
	quad: QuadCorners;
}

/**
 * Context for `FilterHandler.postProcessUnderlay` — building a filter's
 * contribution from an element's coverage instead of its pixels.
 *
 * Every field must be invariant to viewport pan and zoom and to whatever is
 * behind the element; that is what makes the result cacheable across frames
 * while the element's own pixels keep changing (glass refraction over a live
 * backdrop).
 */
export interface UnderlayProcessorContext {
	device: GPUDevice;
	commandEncoder: GPUCommandEncoder;
	coverage: UnderlayCoverage;
	/** Texels per world px to rasterize the underlay at (the document
	 *  rasterization scale, not the viewport zoom). */
	rasterScale: number;
	/** Engine appearance cache pre-bound to the element being filtered. The
	 *  handler owns the entry's payload and its destroy(). */
	appearanceCache?: {
		get(appearanceUid: string): AppearanceCacheEntry | undefined;
		set(appearanceUid: string, entry: AppearanceCacheEntry): void;
	};
	/** Opaque token identifying the coverage's content generation — the
	 *  handler folds it into its cache hash so a re-rendered mask regenerates
	 *  the underlay exactly once. */
	coverageHash: string;
	profiler?: GPUTimingProfiler | null;
	timingLabel?: string;
}

/**
 * A self-sized underlay: the filter's own contribution, to be drawn UNDER the
 * element's pixels at `bounds`. The texture belongs to the appearance cache
 * (borrowed ref), so frame-end texture sweeps must leave it alone.
 */
export interface UnderlayResult {
	texture: TextureRef;
	bounds: BoundingBox;
	uvRect: BlitUVRect;
}

/**
 * Extended context for backdrop filters (like FrostGlass)
 * These filters need access to what's already been rendered
 */
interface BackdropFilterProcessorContext extends FilterProcessorContext {
	/** Texture containing the current canvas content (backdrop) */
	backdropTexture: GPUTexture;
	/** The mask texture defining where the effect should be applied */
	maskTexture: GPUTexture;
}

/**
 * Self-sized output of a post-filter that produces its own texture instead of
 * writing back into the fixed-size source (e.g. extrude3d projects a 3D solid
 * whose bounds exceed the flat element). applyFilters collects these into
 * `overrides`, so each is blitted at its own `bounds`/`quad` rather than the
 * element's flat bounds. A plain image filter returns void (in-place).
 */
export type PostProcessResult = BlitLayer;

/** How a filter's postProcess pass needs to be invoked, decided per-filter
 *  (params-dependent) so a handler can vary by e.g. material. */
export interface FilterRenderRequirements {
	/** The renderer must capture the backdrop before this filter runs (it
	 *  reads ctx.backdropTexture), e.g. frost glass, pixelate. */
	needsBackdrop: boolean;
	/**
	 * postProcess reads ctx.sourceTexture (the element's rasterized flat
	 * look). False for a self-sizing geometry filter that builds its own
	 * output purely from ctx.geometry (e.g. extrude3d) — when such a filter
	 * leads the chain, the caller can skip rasterizing the flat look before
	 * invoking it, since that render would be discarded.
	 */
	needsSourceTexture: boolean;
	/**
	 * postProcess reads ctx.sourceGraphicTexture (the chain input, SVG's
	 * SourceGraphic) in addition to, or instead of, the previous pass output.
	 * The renderer then keeps a copy of the chain input alive for the whole
	 * chain; earlier passes may overwrite the working textures freely.
	 */
	needsSourceGraphic: boolean;
}

const DEFAULT_RENDER_REQUIREMENTS: FilterRenderRequirements = {
	needsBackdrop: false,
	needsSourceTexture: true,
	needsSourceGraphic: false,
};

/** A plain in-place image filter (no getRenderConfigure) needs the
 *  backdrop captured never, and always reads the source texture. The
 *  common Appearance.applyToBackdrop flag forces the backdrop route for
 *  any postProcess filter that doesn't replace the element render. */
export function resolveRenderConfigure(
	handler: FilterHandler | undefined,
	filter: Filter,
): FilterRenderRequirements {
	const resolved = {
		...DEFAULT_RENDER_REQUIREMENTS,
		...handler?.getRenderConfigure?.(filter),
	};
	if (
		filter.applyToBackdrop &&
		handler?.postProcess &&
		!handler.replacesElementRender?.(filter)
	) {
		resolved.needsBackdrop = true;
	}
	return resolved;
}

/**
 * Whether the element's own flat fill/stroke render is fully replaced by an
 * enabled appearance (the filter system renders the element instead — e.g.
 * extrude3d). Lets the renderer suppress the flat geometry pass without
 * naming any specific processor.
 */
export function isElementRenderReplaced(
	element: { filters?: readonly FilterEntry[] | null },
	filterRenderer: Pick<FilterRenderer, "getHandler">,
): boolean {
	for (const filter of localAppearances(element.filters ?? undefined)) {
		if (!isFilterEnabled(filter)) continue;
		if (
			filterRenderer
				.getHandler(filter.processor)
				?.replacesElementRender?.(filter)
		) {
			return true;
		}
	}
	return false;
}

/**
 * A blend renders its keys' interpolated instances; when the keys carry a
 * render-replacing appearance (e.g. extrude3d) but the blend itself doesn't,
 * copy that appearance onto the blend so the generic filter system renders
 * every instance through it (per-instance extrude). Mutates `elementsMap`,
 * replacing each such blend with a hoisted copy. No-op when the blend already
 * has one, or no key does.
 */
export function hoistBlendInstanceAppearances(
	elementsMap: Map<string, AnyArtObject>,
	filterRenderer: Pick<FilterRenderer, "getHandler">,
): void {
	for (const [id, element] of elementsMap) {
		if (!isBlend(element)) continue;
		if (isElementRenderReplaced(element, filterRenderer)) continue;
		// Hoist from the first key carrying a render-replacing appearance — but
		// prefer the first key whose appearance needs the backdrop (glass): the
		// hoisted copy decides the blend's render route, so a mixed glass/opaque
		// blend must route through the backdrop driver regardless of key order,
		// or its glass instances would silently lose their distortion.
		let fallback: Filter[] | null = null;
		let preferred: Filter[] | null = null;
		for (const keyId of element.objectIds) {
			const key = elementsMap.get(keyId);
			const replacing = localAppearances(key?.filters).filter(
				(f) =>
					isFilterEnabled(f) &&
					filterRenderer.getHandler(f.processor)?.replacesElementRender?.(f),
			);
			if (replacing.length === 0) continue;
			fallback ??= replacing;
			if (
				replacing.some(
					(f) =>
						resolveRenderConfigure(filterRenderer.getHandler(f.processor), f)
							.needsBackdrop,
				)
			) {
				preferred = replacing;
				break;
			}
		}
		const hoisted = preferred ?? fallback;
		if (hoisted) {
			elementsMap.set(id, {
				...element,
				filters: [...localAppearances(element.filters), ...hoisted],
			});
		}
	}
}

/**
 * Per-canvas resources a backdrop-effect driver needs, supplied by the
 * CanvasLayer that owns them. A single shared FilterHandler instance keeps one
 * driver per canvas id, so multiple canvas targets (e.g. live editing +
 * export) never collide.
 */
export interface BackdropEffectCanvasResources {
	texturePool: TexturePool;
	/** Read per use, never captured at construction: the cache fields are
	 *  accessor properties resolving the cache manager's active document
	 *  scope, which swaps between frames. */
	appearanceCache: AppearanceCache;
	getParentGroupMap: () => ReadonlyMap<string, string>;
	/** Same per-use contract as appearanceCache above. */
	compoundPathCache: CompoundPathCache;
	renderElementToTexture: (
		encoder: GPUCommandEncoder,
		element: AnyArtObject,
		textureBounds: WorldBBox,
		elementsMap: Map<string, AnyArtObject> | undefined,
		rasterScale: number,
	) => RasterizedRenderSurface | null;
	resolvePatternTexture: (defId: string) => {
		texture: GPUTexture;
		tileWorldSize: { width: number; height: number };
		revision: number;
	} | null;
	resolveTextOutline: (
		element: TextElement,
	) => { paths: Path[]; localBounds: BoundingBox } | null;
	requestTextOutline: (element: TextElement) => void;
	/** Whether an embedded image file's GPU texture has finished decoding. */
	isImageReady: (fileUid: string) => boolean;
	/** Defer a frame-local texture's destruction to a GPU-safe point. */
	deferDestroy: (texture: GPUTexture) => void;
	/** Canvas color format (for the driver's own compositor pipelines). */
	canvasFormat: GPUTextureFormat;
	/** Shared backdrop capture/pyramid service the driver requests its
	 *  backdrop samples through (owned by the CanvasLayer). */
	backdropEffectCoordinator: BackdropEffectCoordinator;
}

/**
 * A backdrop effect's per-canvas driver: an appearance that composites over
 * the backdrop at element z-order (e.g. glass extrude refraction). The
 * CanvasLayer owns the render-pass lifecycle and asks the driver to bake
 * before the main pass, to compose inline once it has ended its pass at the
 * element's z-order, and to release its frame textures afterward — without
 * knowing which concrete filter is behind it. The driver obtains its backdrop
 * content through the shared BackdropEffectCoordinator rather than capturing
 * on its own, so effects on one canvas share captures and blur pyramids.
 */
export interface BackdropEffectDriver {
	/** Reset per-frame pools + inline-composed tracking. */
	beginFrame(): void;
	/** Bake this frame's solids before the main pass opens. `backdropScale` is
	 *  the backdrop capture's texels per world px (device pixels per world px
	 *  on screen, the export raster scale when exporting), so effects can turn
	 *  world-unit parameters into capture texels. When `filter` is given
	 *  (export/copy), only solids whose element id is in it are baked, so a
	 *  front object's glass solid never contaminates the export. */
	prepareFrame(
		encoder: GPUCommandEncoder,
		elementsMap: Map<string, AnyArtObject>,
		dpiScale: number,
		backdropScale: number,
		profiler?: GPUTimingProfiler | null,
		filter?: ReadonlySet<string>,
	): void;
	/** Union the element's baked solids' projected bounds (for viewport
	 *  culling) via `union`. No-op when the element has none. */
	unionSolidBounds(
		element: AnyArtObject,
		union: (b: {
			minX: number;
			minY: number;
			maxX: number;
			maxY: number;
		}) => void,
	): void;
	/** Whether the element has a backdrop-composited appearance to draw inline
	 *  at its z-order (the caller then ends its pass and calls composeInline). */
	hasInlineComposite(element: AnyArtObject): boolean;
	/** Compose the element's inline appearance over `targetTexture`. The caller
	 *  must have ended its active render pass first (this opens its own).
	 *
	 *  Pass `renderToSeparateTexture` when the caller needs to post-process the
	 *  result (e.g. multiply an object mask into it): the appearance then lands
	 *  in a returned layer for the caller to composite, instead of being written
	 *  straight onto `targetTexture` with nothing left to act on. */
	composeInline(
		element: AnyArtObject,
		encoder: GPUCommandEncoder,
		targetTexture: GPUTexture,
		viewport: Viewport,
		width: number,
		height: number,
		profiler?: GPUTimingProfiler | null,
		renderToSeparateTexture?: boolean,
	): BlitLayer | void;
	/** Forget this frame's baked solids for the given elements, so the end-of-
	 *  frame flush does not composite them. Needed for draws that are not part
	 *  of the document — baking mask content registers solids exactly like a
	 *  normal draw does. */
	discardFrameEntries?(elementIds: ReadonlySet<string>): void;
	/** The element's baked solids as plain blit layers, without the backdrop
	 *  composite. For render paths that have no backdrop to compose against —
	 *  baking mask content is one, since the mask is built before the document
	 *  underneath it exists. Empty when the element has no baked solids. */
	backdropFreeLayers?(element: AnyArtObject): BlitLayer[];
	/** Compose any baked solids not already composed inline (a render path with
	 *  no composite context), after the document pass. */
	flushRemaining(
		encoder: GPUCommandEncoder,
		prebufTexture: GPUTexture,
		viewport: Viewport,
		width: number,
		height: number,
		profiler?: GPUTimingProfiler | null,
	): void;
	/** Return this frame's textures to the pool. */
	releaseFrame(release: (texture: GPUTexture) => void): void;
}

/**
 * Interface for all filter implementations (pre- and post-filters).
 *
 * Pre-filters (`preProcess`) transform geometry segments before rasterization —
 * e.g. zigzag deformation applied to path vertices.
 * Post-filters (`postProcess`) run one or more WebGPU compute/render passes on
 * the already-rasterized element texture — e.g. blur, drop shadow, frost glass.
 */
export interface FilterHandler {
	/** No-op for handlers that don't need GPU. */
	initialize(device: GPUDevice, canvasFormat: GPUTextureFormat): Promise<void>;

	/**
	 * Called when the host element is resized. Each handler decides which of its
	 * own fields are spatial and how to scale them correctly
	 * (uniform √(sx·sy) vs. per-axis sx / sy).
	 * @param params - The filter to scale.
	 * @param scale - [scaleX, scaleY] scale factors.
	 */
	onScaleFilter(params: Filter, scale: [number, number]): Filter;

	/** Margin in world unit. Used to allocate offscreen textures large enough
	 *  to accommodate the filter effect. Handlers whose displacement scales
	 *  with the content size (zoom/rotation blurs) read the optional bounds. */
	getExpansionMargin(
		filter: Filter,
		bounds?: { width: number; height: number },
	): number;

	destroy?(): void;

	/** Called once per frame before any filter passes run, for handlers that
	 *  own per-frame GPU state (e.g. the extrude mesh pass resets its pools). */
	startFrame?(): void;

	/** Called once per frame after all filter/blit consumption is done, for
	 *  handlers that own frame-local GPU resources (e.g. extrude's bake/normal
	 *  textures) — return each one via `release` so the caller can defer its
	 *  destruction to a safe point. */
	releaseFrame?(release: (texture: GPUTexture) => void): void;

	/**
	 * Shared, frame-agnostic geometry-pass drivers (WGSL pipelines + the mesh
	 * baker), for a caller that runs its own per-canvas-layer prepare pass
	 * with them (e.g. the glass-extrude pre-pass, which needs per-canvas-layer
	 * resources — texture pool, appearance cache — this handler doesn't own,
	 * since one handler instance is shared across every CanvasLayer). Null
	 * before initialize() resolves, or for handlers with no geometry pass.
	 */
	getGeometryPassDrivers?(): {
		meshPass: MeshPassRenderer;
		baker: ExtrudeMeshBaker;
	} | null;

	/** Register a canvas's per-canvas resources so this shared handler can own
	 *  a BackdropEffectDriver for it (keyed by `canvasId`). Called by each
	 *  CanvasLayer at construction. */
	attachCanvas?(
		canvasId: string,
		resources: BackdropEffectCanvasResources,
	): void;
	/** Drop the driver + resources for a canvas being destroyed. */
	detachCanvas?(canvasId: string): void;
	/** The backdrop-effect driver for a registered canvas, or null. */
	getBackdropEffectDriver?(canvasId: string): BackdropEffectDriver | null;

	/** Declare this filter's rendering requirements (backdrop capture, whether
	 *  postProcess needs the rasterized source). Omit for a plain in-place
	 *  image filter — see resolveRenderConfigure for the default. */
	getRenderConfigure?(filter: Filter): Partial<FilterRenderRequirements>;

	/** Backdrop Gaussian sigma (in capture texels at `rasterScale`) this
	 *  filter wants pre-blurred by the shared pyramid, so the renderer plans
	 *  the batch deep enough. Omit (or return 0) for backdrop filters that
	 *  sample the sharp capture. */
	getBackdropBlurSigma?(filter: Filter, rasterScale: number): number;

	/** True when this appearance fully replaces the element's own flat
	 *  fill/stroke rendering — the filter system renders the element instead,
	 *  so the flat geometry pass must draw nothing for it (e.g. extrude3d). */
	replacesElementRender?(filter: Filter): boolean;

	/** Def ids (patterns, brush sources) this filter's params reference, so the
	 *  renderer can pre-rasterize them without knowing the filter's shape (e.g.
	 *  extrude3d's material surface pattern). */
	collectReferencedDefIds?(filter: Filter): string[];

	/** Pre-filter: transform geometry before rendering. */
	preProcess?(
		segments: CubicBezierSegment[],
		filter: Filter,
	): CubicBezierSegment[];

	/** Post-filter: apply image processing to the rendered texture. A handler
	 *  that produces its own sized texture returns a PostProcessResult (the
	 *  renderer blits it at those bounds) — or an array when one appearance
	 *  yields multiple independent solids (e.g. a blend's per-instance
	 *  extrudes); a plain in-place image filter returns void. */
	postProcess?(
		context: FilterProcessorContext,
		filter: Filter,
	): PostProcessResult | PostProcessResult[] | void;

	/**
	 * Build this filter's contribution from the element's COVERAGE alone, as a
	 * self-sized texture the caller draws the element over.
	 *
	 * Implemented by filters whose output is a function of the source's alpha
	 * composited under the untouched source (drop shadow). A caller whose
	 * source pixels are rebuilt every frame for reasons unrelated to this
	 * filter — a glass solid refracting a live backdrop — can then evaluate
	 * and cache the alpha-driven part once, instead of re-running the filter
	 * on a full-canvas composite on every pan frame.
	 *
	 * Absent means the filter needs real colors and must go through
	 * `postProcess`. Returns null when it cannot produce an underlay this
	 * frame; the caller falls back to the regular chain.
	 */
	postProcessUnderlay?(
		context: UnderlayProcessorContext,
		filter: Filter,
	): UnderlayResult | null;

	/**
	 * Interpolate between two sets of filter params.
	 * @param paramsA - First set of params (the T in ParamData<T>)
	 * @param paramsB - Second set of params
	 * @param t - Interpolation factor. Can exceed [0, 1] range.
	 * @returns Interpolated params
	 */
	onInterpolate?(paramsA: unknown, paramsB: unknown, t: number): unknown;

	/** Return params with all colors passed through adjustColor.
	 * For collecting: pass an identity fn that records each color.
	 * For adjusting: pass the actual adjuster fn. */
	onAdjustColor?(
		params: unknown,
		adjustColor: (color: Color) => Color,
	): unknown;
}

/**
 * What a handler does to the element it is attached to. Routing, occlusion and
 * bounds decisions must classify through this instead of probing
 * `handler.preProcess` / `handler.postProcess` directly: those probes are
 * where "does this appearance deform its geometry?" and "does this appearance
 * have any sub-filter at all?" quietly drift apart.
 */
type FilterKind = "geometry" | "raster";

/** Deforms the path before rasterization (zigzag, path-offset, …). */
type GeometryFilterHandler = FilterHandler & {
	preProcess: NonNullable<FilterHandler["preProcess"]>;
	postProcess?: never;
};

/** Post-processes the rasterized texture (blur, drop-shadow, …). */
type RasterFilterHandler = FilterHandler & {
	preProcess?: never;
	postProcess: NonNullable<FilterHandler["postProcess"]>;
};

/** Neither — the appearance processors (fill / stroke / content). */
type PassiveFilterHandler = FilterHandler & {
	preProcess?: never;
	postProcess?: never;
};

/**
 * The shapes `registerHandler` accepts. A handler that both deforms geometry
 * and post-processes matches no member and fails to compile: the two run in
 * different stages, and every consumer classifies by the first capability it
 * finds, so such a handler would be treated inconsistently. Split it into two
 * registered handlers instead.
 */
export type RegisterableFilterHandler =
	| GeometryFilterHandler
	| RasterFilterHandler
	| PassiveFilterHandler;

/** Classify a handler, or null when it has no handler / does neither. */
export function classifyFilterHandler(
	handler: FilterHandler | undefined,
): FilterKind | null {
	if (handler?.preProcess) return "geometry";
	if (handler?.postProcess) return "raster";
	return null;
}

/** True when this enabled filter deforms geometry before rasterization. */
export function isGeometryFilter(
	filter: Filter,
	filterRenderer: Pick<FilterRenderer, "getHandler">,
): boolean {
	return (
		isFilterEnabled(filter) &&
		classifyFilterHandler(filterRenderer.getHandler(filter.processor)) ===
			"geometry"
	);
}

// --- Filter Renderer ---

/** Frames a temp ping-pong pair may sit unused before it is destroyed. */
const TEMP_PAIR_IDLE_FRAMES = 60;
/** Upper bound on concurrently held temp pairs. Viewport-clipped chains
 *  produce a few dozen distinct sizes per frame while panning, so the cap
 *  must fit a whole frame's set — otherwise the transient sizes flush the
 *  stable ones and every pair churns. LRU eviction beyond the cap skips
 *  pairs already used in the current frame. */
const MAX_TEMP_PAIRS = 48;

export class FilterRenderer {
	private device: GPUDevice;
	private handlers: Map<string, FilterHandler> = new Map();
	private tempTexture1: GPUTexture | null = null;
	private tempTexture2: GPUTexture | null = null;
	private textureSize = { width: 0, height: 0 };
	private pendingDestroy: GPUTexture[] = [];
	/**
	 * Ping-pong intermediates keyed by size/format, reused across calls and
	 * frames. Filter chains of different content sizes alternate within a
	 * single frame (element chains, drop shadows, backdrop effects), and
	 * recreating the pair on every switch allocated hundreds of MB of
	 * zero-initialized textures per second while panning — the GPU process
	 * CPU saturated on allocation instead of rendering. Pairs idle for
	 * TEMP_PAIR_IDLE_FRAMES are destroyed in flushPendingDestroy, and the
	 * map is LRU-capped at MAX_TEMP_PAIRS to bound held memory during
	 * continuous size churn (zoom gestures).
	 */
	private tempPairs = new Map<
		string,
		{
			t1: GPUTexture;
			t2: GPUTexture;
			/** Chain-input copy for needsSourceGraphic chains; created on demand. */
			src?: GPUTexture;
			lastUsedFrame: number;
		}
	>();
	private frameIndex = 0;

	public constructor(device: GPUDevice) {
		this.device = device;
	}

	public registerHandler(
		filterType: string,
		handler: RegisterableFilterHandler,
	): void {
		this.handlers.set(filterType, handler);
	}

	public getHandler(filterType: string): FilterHandler | undefined {
		return this.handlers.get(filterType);
	}

	public getHandlers(): ReadonlyMap<string, FilterHandler> {
		return this.handlers;
	}

	/**
	 * Whether the common Appearance.applyToBackdrop toggle is meaningful for
	 * this filter. Derived from the registered handler alone (no per-processor
	 * list): geometry/fill/stroke appearances have no postProcess to reroute,
	 * render-replacing ones (extrude3d) ignore the flag, and always-backdrop
	 * handlers (frost glass) make the toggle a no-op.
	 */
	public canApplyToBackdrop(filter: Filter): boolean {
		const handler = this.handlers.get(filter.processor);
		if (!handler?.postProcess) return false;
		if (handler.replacesElementRender?.(filter)) return false;
		return !resolveRenderConfigure(handler, {
			...filter,
			applyToBackdrop: false,
		}).needsBackdrop;
	}

	public scaleFilter(filter: Filter, scaleX: number, scaleY: number): Filter {
		const handler = this.handlers.get(filter.processor);
		return handler ? handler.onScaleFilter(filter, [scaleX, scaleY]) : filter;
	}

	public calculateExpansion(
		filters: readonly Filter[],
		bounds?: { width: number; height: number },
	): number {
		let margin = 0;
		for (const filter of filters) {
			if (!isFilterEnabled(filter)) continue;
			const handler = this.handlers.get(filter.processor);
			if (handler) {
				margin = Math.max(margin, handler.getExpansionMargin(filter, bounds));
			}
		}
		return margin;
	}

	/**
	 * Destroy textures that were deferred from a previous resize.
	 * Must be called once per frame AFTER the previous frame's queue.submit()
	 * has completed, so in-flight command buffers no longer reference them.
	 * Also flushes deferred destroys from all registered handlers that support it.
	 */
	public flushPendingDestroy(): void {
		for (const tex of this.pendingDestroy) {
			tex.destroy();
		}
		this.pendingDestroy.length = 0;

		// Retire temp pairs no filter chain has used for a while. Deferred via
		// pendingDestroy (drained next flush) in case something encoded this
		// frame still references them.
		this.frameIndex++;
		for (const [key, pair] of this.tempPairs) {
			if (this.frameIndex - pair.lastUsedFrame > TEMP_PAIR_IDLE_FRAMES) {
				this.pendingDestroy.push(pair.t1, pair.t2);
				if (pair.src) this.pendingDestroy.push(pair.src);
				this.tempPairs.delete(key);
			}
		}

		for (const handler of this.handlers.values()) {
			(handler as { flushPendingDestroy?(): void }).flushPendingDestroy?.();
		}
	}

	private ensureTempTextures(
		width: number,
		height: number,
		format: GPUTextureFormat,
	): void {
		const key = `${width}x${height}:${format}`;
		let pair = this.tempPairs.get(key);
		if (!pair) {
			if (this.tempPairs.size >= MAX_TEMP_PAIRS) {
				let lruKey: string | undefined;
				let lruFrame = Infinity;
				for (const [k, p] of this.tempPairs) {
					// Pairs already used this frame are the working set — evicting
					// them just recreates them moments later.
					if (p.lastUsedFrame === this.frameIndex) continue;
					if (p.lastUsedFrame < lruFrame) {
						lruFrame = p.lastUsedFrame;
						lruKey = k;
					}
				}
				if (lruKey) {
					const lru = this.tempPairs.get(lruKey)!;
					this.pendingDestroy.push(lru.t1, lru.t2);
					if (lru.src) this.pendingDestroy.push(lru.src);
					this.tempPairs.delete(lruKey);
				}
			}
			const textureDescriptor: GPUTextureDescriptor = {
				label: `Filter Temp ${width}x${height}`,
				size: { width, height },
				format,
				usage:
					GPUTextureUsage.RENDER_ATTACHMENT |
					GPUTextureUsage.TEXTURE_BINDING |
					GPUTextureUsage.COPY_SRC |
					GPUTextureUsage.COPY_DST,
			};
			pair = {
				t1: this.device.createTexture(textureDescriptor),
				t2: this.device.createTexture(textureDescriptor),
				lastUsedFrame: this.frameIndex,
			};
			this.tempPairs.set(key, pair);
		}
		pair.lastUsedFrame = this.frameIndex;
		this.tempTexture1 = pair.t1;
		this.tempTexture2 = pair.t2;
		this.textureSize = { width, height };
	}

	/** The chain-input copy texture for the current temp pair. */
	private ensureSourceGraphicTexture(): GPUTexture {
		const { width, height } = this.textureSize;
		const format = this.tempTexture1!.format;
		const pair = this.tempPairs.get(`${width}x${height}:${format}`)!;
		pair.src ??= this.device.createTexture({
			label: `Filter SourceGraphic ${width}x${height}`,
			size: { width, height },
			format,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		return pair.src;
	}

	/**
	 * @param maskTexture - Defines the region where backdrop filters are applied.
	 * @param dpiScale - Rasterization scale (texels per world px) of the source
	 *   texture; filter parameters (e.g. blur radius) are scaled by it. For
	 *   element filters this is the fixed document rasterization scale; for
	 *   backdrop filters it is the live viewport zoom.
	 * @param contentBounds - Content dimensions in world units.
	 *   When the source texture includes pool padding, filters run on
	 *   content-sized intermediaries so UV [0,1] maps exactly to content.
	 *   `texelOffset` is the content's top-left texel in the source texture;
	 *   without it the content is assumed centred.
	 * @param appearanceScope - Element identity of the filtered content plus the
	 *   engine AppearanceCache. When provided, handlers receive an
	 *   element-scoped `appearanceCache` accessor on their context.
	 */
	public applyFilters(
		sourceTexture: GPUTexture,
		filters: readonly Filter[],
		encoder: GPUCommandEncoder,
		maskTexture?: GPUTexture,
		dpiScale: number = 1.0,
		contentBounds?: {
			width: number;
			height: number;
			texelOffset?: { x: number; y: number };
		},
		appearanceScope?: { elementId: string; cache: AppearanceCache },
		geometry?: FilterGeometryContext,
		backdropBlur?: (sigma: number) => BackdropBlurLevels | null,
		coordinateSpace?: FilterCoordinateSpace,
		profiler?: GPUTimingProfiler | null,
		timingLabel?: string,
	): { texture: GPUTexture; overrides?: PostProcessResult[] } {
		if (filters.length === 0) {
			return { texture: sourceTexture };
		}

		const srcW = sourceTexture.width;
		const srcH = sourceTexture.height;
		const format = sourceTexture.format;

		const activeFilters: Array<{ filter: Filter; handler: FilterHandler }> = [];
		for (const filter of filters) {
			if (!isFilterEnabled(filter)) continue;
			const handler = this.handlers.get(filter.processor);
			if (!handler?.postProcess) {
				if (
					!handler &&
					filter.processor !== "fill" &&
					filter.processor !== "stroke" &&
					filter.processor !== "content"
				) {
					console.warn(
						`No handler registered for filter type: ${filter.processor}`,
					);
				}
				continue;
			}
			activeFilters.push({
				filter,
				handler,
			});
		}
		if (activeFilters.length === 0) {
			return { texture: sourceTexture };
		}

		// A chain led by a source-ignoring handler (e.g. extrude3d) never reads
		// sourceTexture's content, so the caller may have passed a throwaway
		// placeholder sized nothing like contentBounds. Skip every step that
		// assumes sourceTexture holds real, correctly-sized content.
		const firstIgnoresSource = !resolveRenderConfigure(
			activeFilters[0].handler,
			activeFilters[0].filter,
		).needsSourceTexture;

		// When the source texture has pool padding, run filters on content-sized
		// intermediaries so UV [0,1] maps exactly to the content area.
		// Filters never see quantization artifacts.
		const cw = contentBounds ? Math.ceil(contentBounds.width * dpiScale) : srcW;
		const ch = contentBounds
			? Math.ceil(contentBounds.height * dpiScale)
			: srcH;
		const isPadded = !firstIgnoresSource && (cw !== srcW || ch !== srcH);

		this.ensureTempTextures(cw, ch, format);

		if (!this.tempTexture1 || !this.tempTexture2) {
			console.warn("Failed to allocate temp textures for filtering");
			return { texture: sourceTexture };
		}

		let currentSource: GPUTexture;
		let currentTarget: GPUTexture;
		let finalTexture: GPUTexture = sourceTexture;

		// Content is rendered centred inside the quantised source texture.
		// Compute the pixel offset so we extract exactly the content region.
		const padOffX = Math.floor((srcW - cw) / 2);
		const padOffY = Math.floor((srcH - ch) / 2);

		if (isPadded) {
			// Strip padding: copy centred content to content-sized temp
			encoder.copyTextureToTexture(
				{ texture: sourceTexture, origin: { x: padOffX, y: padOffY } },
				{ texture: this.tempTexture1 },
				{ width: cw, height: ch },
			);
			currentSource = this.tempTexture1;
			currentTarget = this.tempTexture2;
		} else {
			// firstIgnoresSource also lands here: currentSource is never read by
			// the leading handler, so its (possibly nonsensically-sized) content
			// doesn't matter.
			currentSource = sourceTexture;
			currentTarget = this.tempTexture1;
		}

		// Keep the chain input alive for handlers that read SourceGraphic: the
		// ping-pong textures are overwritten pass by pass, and in-place handlers
		// may also write back into currentSource (the two-pass blur does).
		let sourceGraphicTexture: GPUTexture | undefined;
		if (
			!firstIgnoresSource &&
			activeFilters.some(
				({ filter, handler }) =>
					resolveRenderConfigure(handler, filter).needsSourceGraphic,
			)
		) {
			sourceGraphicTexture = this.ensureSourceGraphicTexture();
			encoder.copyTextureToTexture(
				{ texture: currentSource },
				{ texture: sourceGraphicTexture },
				{ width: cw, height: ch },
			);
		}

		const sceneInfo: FilterSceneInfo = {
			textureSize: { width: cw, height: ch },
			dpiScale,
		};

		// Bind the appearance cache to the element being filtered so handlers
		// can only address their own appearance uid within that element.
		const appearanceCache = appearanceScope
			? {
					get: (appearanceUid: string) =>
						appearanceScope.cache.get(appearanceScope.elementId, appearanceUid),
					set: (appearanceUid: string, entry: AppearanceCacheEntry) =>
						appearanceScope.cache.set(
							appearanceScope.elementId,
							appearanceUid,
							entry,
						),
					pruneInstances: (baseUid: string, liveCount: number) =>
						appearanceScope.cache.pruneInstances(
							appearanceScope.elementId,
							baseUid,
							liveCount,
						),
				}
			: undefined;

		const overrides: PostProcessResult[] = [];

		// Exact world size UV [0,1] maps to; a self-sizing pass replaces the
		// texture, after which only the texel-derived fallback remains valid.
		let sourceWorldSize = contentBounds
			? { width: contentBounds.width, height: contentBounds.height }
			: undefined;
		// Fractional texel position of the content's top-left corner: offscreen
		// passes centre the content unless they say where they put it, and the
		// padding strip copies at an integer origin, so the content sits a
		// DPI-dependent sub-texel amount off the texture origin. In-place
		// passes preserve positions, so the offset stays valid down the chain
		// until a self-sizing pass replaces it.
		const placedOffset = contentBounds?.texelOffset ?? {
			x: contentBounds ? (srcW - contentBounds.width * dpiScale) / 2 : 0,
			y: contentBounds ? (srcH - contentBounds.height * dpiScale) / 2 : 0,
		};
		let sourceContentOffset = contentBounds
			? {
					x: placedOffset.x - (isPadded ? padOffX : 0),
					y: placedOffset.y - (isPadded ? padOffY : 0),
				}
			: undefined;
		let currentCoordinateSpace = coordinateSpace;

		for (let i = 0; i < activeFilters.length; i++) {
			const { filter, handler } = activeFilters[i];
			const isLastPass = i === activeFilters.length - 1;
			if (!handler.postProcess) continue;

			const base = {
				device: this.device,
				sourceTexture: currentSource,
				targetTexture: currentTarget,
				commandEncoder: encoder,
				profiler,
				timingLabel,
				sceneInfo,
				appearanceCache,
				geometry,
				sourceWorldSize,
				sourceContentOffset,
				coordinateSpace: currentCoordinateSpace,
				backdropBlur,
				sourceGraphicTexture,
			};
			const context: FilterProcessorContext | BackdropFilterProcessorContext =
				maskTexture && resolveRenderConfigure(handler, filter).needsBackdrop
					? { ...base, backdropTexture: sourceTexture, maskTexture }
					: base;

			const out = handler.postProcess(context, filter);

			if (out) {
				// Self-sizing pass: it produced its own texture(s) at its own
				// bounds, so the in-place ping-pong does not apply. Multiple
				// self-sizing passes (e.g. several extrude appearances on one
				// element, or one blend's per-instance extrudes) each contribute a
				// blit layer. Downstream image filters (e.g. blur stacked on the
				// solid) ping-pong at the new size, reading the last layer's
				// output as their source.
				const outLayers = Array.isArray(out) ? out : [out];
				overrides.push(...outLayers);
				const lastLayer = outLayers.at(-1)!;
				finalTexture = lastLayer.texture.texture;
				if (!isLastPass) {
					this.ensureTempTextures(
						lastLayer.texture.texture.width,
						lastLayer.texture.texture.height,
						format,
					);
					if (!this.tempTexture1 || !this.tempTexture2) break;
					currentSource = lastLayer.texture.texture;
					currentTarget = this.tempTexture1;
					sceneInfo.textureSize = {
						width: lastLayer.texture.texture.width,
						height: lastLayer.texture.texture.height,
					};
					sourceWorldSize = undefined;
					sourceContentOffset = undefined;
					currentCoordinateSpace = undefined;
					sourceGraphicTexture = undefined;
				}
			} else {
				finalTexture = currentTarget;
				if (!isLastPass) {
					currentSource = currentTarget;
					currentTarget =
						currentTarget === this.tempTexture1
							? this.tempTexture2
							: this.tempTexture1;
				}
			}
		}

		if (overrides.length > 0) {
			// Self-sized output is blitted at its own bounds/quad; there is no
			// copy-back into the fixed-size source. A downstream in-place filter
			// (blur stacked on the solid) rewrites the last layer's texture, so
			// re-point it to whatever the last pass wrote.
			overrides[overrides.length - 1] = {
				...overrides[overrides.length - 1],
				texture:
					overrides.at(-1)!.texture.texture === finalTexture
						? overrides.at(-1)!.texture
						: createBorrowedTextureRef(finalTexture, "external"),
			};
			return { texture: finalTexture, overrides };
		}

		if (firstIgnoresSource) {
			// The leading handler produced nothing (e.g. an extrude appearance
			// with depth 0) — finalTexture may be an untouched temp buffer (a
			// source-ignoring handler that returns void draws nothing at all,
			// unlike an in-place filter, for which void always means "I
			// wrote into targetTexture"). Report back the original placeholder
			// rather than that meaningless buffer.
			return { texture: sourceTexture };
		}

		// In-place chain: copy result back to source texture (centred position).
		if (isPadded) {
			encoder.copyTextureToTexture(
				{ texture: finalTexture },
				{ texture: sourceTexture, origin: { x: padOffX, y: padOffY } },
				{ width: cw, height: ch },
			);
		} else if (finalTexture !== sourceTexture) {
			encoder.copyTextureToTexture(
				{ texture: finalTexture },
				{ texture: sourceTexture },
				{ width: srcW, height: srcH },
			);
		}

		return { texture: sourceTexture };
	}

	public destroy(): void {
		this.flushPendingDestroy();
		for (const pair of this.tempPairs.values()) {
			pair.t1.destroy();
			pair.t2.destroy();
			pair.src?.destroy();
		}
		this.tempPairs.clear();
		this.tempTexture1 = null;
		this.tempTexture2 = null;

		for (const handler of this.handlers.values()) {
			handler.destroy?.();
		}
		this.handlers.clear();
	}
}
