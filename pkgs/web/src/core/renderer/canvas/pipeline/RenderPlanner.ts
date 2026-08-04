import { readStoredBrushSize } from "../../../brush/access";
import { resolveBrushRenderRoute } from "../../../brush/renderRoute";
import {
	type AnyArtObject,
	type BlendMode,
	type CubicBezierSegment,
	type Document,
	type ElementTransform,
	type Filter,
	getTransform,
	type ImageObject,
	isFilterEnabled,
	isGroup,
	isIdentityTransform,
	isRepeat,
	type StrokeAppearance,
	type Viewport,
	type WetEdgeConfig,
} from "../../../schema";
import {
	brandWorldBBox,
	calculateElementBounds,
	calculateLocalElementBounds,
	expandBounds,
	type LocalBoundsCache,
	type WorldBBox,
} from "../../../utils/geometry/bounds";
import {
	applyTransformToPoint,
	boundsIntersectViewport,
} from "../../../utils/geometry/geometry";
import type { TransientElementEntry } from "../../types";
import { buildImageQuadSegments } from "../elements/ImageElementRenderer";
import {
	classifyFilterHandler,
	type FilterHandler,
	type FilterRenderer,
	isGeometryFilter,
	resolveRenderConfigure,
} from "./FilterRenderer";
import { applyPreFilters } from "./PreFilterRenderer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Entry describing an element that requires backdrop-filter processing. */
export interface BackdropElementEntry {
	element: AnyArtObject;
	bounds: WorldBBox;
	backdropFilters: Filter[];
	regularFilters: Filter[];
	layerIndex: number;
	/** Position within the layer's element list */
	elementIndex: number;
}

/** Per-element filter classification. Pure data, no GPU references. */
export interface ElementFilterPlan {
	elementId: string;
	element: AnyArtObject;
	bounds: WorldBBox;
	enabledFilters: Filter[];
	/** Post-filters requiring offscreen rendering (blur, drop-shadow) */
	postFilters: Filter[];
	/** Element bounds expanded by filter margins. Used for offscreen texture allocation. */
	textureBounds: WorldBBox;
	/** When present, ALL appearances must be rendered individually in order.
	 *  This replaces the old base+sub approach for correct draw ordering
	 *  when any appearance has subFilters. */
	allAppearancePlans?: AppearancePlan[];
}

/** Describes a single appearance (fill/stroke) to render individually.
 *  Used when any appearance in the element has subFilters, requiring
 *  per-appearance offscreen rendering. */
interface AppearancePlan {
	/** The appearance filter (fill or stroke) to render in isolation */
	appearance: Filter;
	/** Index of this appearance in the element's filters array */
	filterIndex: number;
	/** Enabled sub-filters with preProcess handlers (geometry deformation, e.g. zigzag) */
	preSubFilters: Filter[];
	/** Enabled sub-filters with postProcess handlers (empty if none) */
	postSubFilters: Filter[];
	/** Texture bounds expanded by sub-filter margins (element-level textureBounds if no sub-filters) */
	textureBounds: WorldBBox;
	/** Per-appearance opacity (0.0–1.0) */
	opacity: number;
	/** Per-appearance blend mode */
	blendMode: BlendMode;
	/** Wash strokes only (design §6-3): strokeOpacity to apply exactly once
	 *  when compositing the isolated appearance; dabs carry flow alone. */
	washStrokeOpacity?: number;
	/** Watercolor rim for wash strokes (§9); absent while wet is enabled. */
	washWetEdge?: WetEdgeConfig;
	/** Brush size for the wet-edge width cap (world units). */
	washBrushSize?: number;
}

/** Contiguous run of elements to render between backdrop boundaries. */
interface LayerSegment {
	elements: AnyArtObject[];
	/** Backdrop element to process AFTER this segment, or null for the final segment */
	backdropAfter: BackdropElementEntry | null;
}

/** Per-layer rendering plan. */
export interface LayerPlan {
	layerIndex: number;
	layerId: string;
	elements: AnyArtObject[];
	opacity: number;
	blendMode: BlendMode;
	/** Whether this layer needs offscreen compositing (non-normal blendMode) */
	needsLayerCompositing: boolean;
	/** Render segments: element runs separated by backdrop boundaries */
	segments: LayerSegment[];
}

/** Complete frame rendering plan. Pure data, no GPU references. */
export interface FramePlan {
	/** Resolved AnyArtObject arrays per layer id (visible layers only). */
	layerElementsCache: Map<string, AnyArtObject[]>;
	/** Elements map built from document.objects */
	elementsMap: Map<string, AnyArtObject>;
	/** Whether any layer or element uses a non-normal blend mode. */
	needsCompositing: boolean;
	/** Whether any layer alone needs compositing (non-normal blendMode). */
	anyLayerNeedsCompositing: boolean;
	/** Whether the document has artboards (affects clear color). */
	hasArtboards: boolean;
	/** Clear color for the first render pass. */
	clearColor: GPUColorDict;
	layerPlans: LayerPlan[];
	backdropElementIds: ReadonlySet<string>;
	allBackdropEntries: readonly BackdropElementEntry[];
	/** Elements needing offscreen filter pass. Key: element.id */
	filterPlans: ReadonlyMap<string, ElementFilterPlan>;
	/** Pre-computed element bounds cache from ViewportManager, used to
	 *  avoid redundant O(N) bounds recalculation in hot paths. */
	localBoundsCache?: LocalBoundsCache;
}

/** A pass break declared at plan time: the main pass ends here, something
 *  composites offscreen, and the pass restarts. */
export type SegmentBreak =
	| { kind: "backdrop"; entry: BackdropElementEntry }
	| { kind: "compositeElement"; elementId: string }
	| { kind: "inlineBackdropCompose"; elementId: string };

/** Contiguous element run the main pass can encode without a break. */
export interface PassSegment {
	elements: AnyArtObject[];
	breakAfter: SegmentBreak | null;
}

export interface LayerPassPlan {
	layerPlan: LayerPlan;
	segments: PassSegment[];
}

/**
 * Declare every pass break ahead of execution by refining each layer's
 * backdrop segments with the element-level break conditions the render loop
 * currently discovers procedurally: blend/composition-mode compositing and
 * inline backdrop composes (glass extrude). Break elements live in
 * `breakAfter`, not in `elements` — they render inside the break.
 *
 * Viewport culling is NOT applied here: a culled break element simply never
 * breaks at runtime, so runtime breaks form a subsequence of this
 * declaration (which is exactly what the shadow assertion checks).
 */
export function buildPassPlan(
	framePlan: FramePlan,
	hasInlineComposite: (element: AnyArtObject) => boolean,
): LayerPassPlan[] {
	return framePlan.layerPlans.map((layerPlan) => {
		const segments: PassSegment[] = [];
		for (const segment of layerPlan.segments) {
			let run: AnyArtObject[] = [];
			for (const element of segment.elements) {
				if (hasInlineComposite(element)) {
					segments.push({
						elements: run,
						breakAfter: {
							kind: "inlineBackdropCompose",
							elementId: element.id,
						},
					});
					run = [];
					continue;
				}
				const blendMode = element.blendMode ?? "normal";
				const compositionMode = element.compositionMode ?? "normal";
				if (blendMode !== "normal" || compositionMode !== "normal") {
					segments.push({
						elements: run,
						breakAfter: {
							kind: "compositeElement",
							elementId: element.id,
						},
					});
					run = [];
					continue;
				}
				run.push(element);
			}
			segments.push({
				elements: run,
				breakAfter: segment.backdropAfter
					? { kind: "backdrop", entry: segment.backdropAfter }
					: null,
			});
		}
		return { layerPlan, segments };
	});
}

/**
 * Document-dependent, viewport-independent part of the frame plan. Everything
 * here derives from the document (plus transient/override overlays) alone, so
 * a caller may build it once per document change and derive per-frame
 * `FramePlan`s from it via `buildFramePlanView` while panning/zooming.
 */
export interface FramePlanStructure {
	elementsMap: Map<string, AnyArtObject>;
	layerElementsCache: Map<string, AnyArtObject[]>;
	needsCompositing: boolean;
	anyLayerNeedsCompositing: boolean;
	hasArtboards: boolean;
	clearColor: GPUColorDict;
	/** Filter/backdrop candidates for every element, classified with
	 *  world-space (viewport-independent) bounds. The per-frame viewport
	 *  intersection test is applied in buildFramePlanView. */
	candidates: readonly PlanCandidate[];
	/** Per visible layer, in layer order: the inputs layerPlans need that do
	 *  not depend on the viewport. */
	layerRows: readonly LayerRow[];
	localBoundsCache?: LocalBoundsCache;
}

/** A classified element that may need filter/backdrop processing. */
interface PlanCandidate {
	bounds: WorldBBox;
	filterPlan: ElementFilterPlan | null;
	backdropEntry: BackdropElementEntry | null;
	/**
	 * Repeat-source plans bake unconditionally: `bakeRepeats` bakes every repeat
	 * regardless of the viewport, so their sources' filter plans must survive the
	 * per-candidate viewport cull too (the source's authored box may be off-screen
	 * while its instances are not).
	 */
	skipCull?: boolean;
}

/** Viewport-independent layer metadata for LayerPlan construction. */
interface LayerRow {
	layerIndex: number;
	layerId: string;
	elements: AnyArtObject[];
	opacity: number;
	blendMode: BlendMode;
	hasCompositionModeElement: boolean;
}

// ---------------------------------------------------------------------------
// Pure planning functions
// ---------------------------------------------------------------------------

/**
 * Build a cache of resolved element arrays for each visible layer.
 * The caller can avoid repeated Map lookups in subsequent passes.
 */
function buildLayerElementsCache(
	document: Document,
	elementsMap: ReadonlyMap<string, AnyArtObject>,
	transientElements?: ReadonlyMap<string, TransientElementEntry>,
): Map<string, AnyArtObject[]> {
	const cache = new Map<string, AnyArtObject[]>();
	for (const layer of document.layers) {
		if (!layer.visible) continue;
		const els: AnyArtObject[] = [];
		for (const id of layer.elementIds) {
			const el = elementsMap.get(id);
			if (el != null) els.push(el);
		}
		if (transientElements) {
			for (const [, { layerId, element, topLevel }] of transientElements) {
				if (topLevel !== false && layerId === layer.id) els.push(element);
			}
		}
		cache.set(layer.id, els);
	}
	return cache;
}

/**
 * Determine whether any layer or element requires offscreen compositing
 * (non-normal blend mode).
 */
function checkCompositingNeeded(
	document: Document,
	layerElementsCache: ReadonlyMap<string, AnyArtObject[]>,
	elementsMap: ReadonlyMap<string, AnyArtObject>,
): {
	needsCompositing: boolean;
	anyLayerNeedsCompositing: boolean;
} {
	let anyLayerNeedsCompositing = document.layers.some(
		(layer) => layer.visible && (layer.blendMode ?? "normal") !== "normal",
	);

	let anyElementNeedsCompositing = false;
	for (const layer of document.layers) {
		if (!layer.visible) continue;
		const stack: AnyArtObject[] = [...(layerElementsCache.get(layer.id) ?? [])];
		while (stack.length > 0) {
			const element = stack.pop();
			if (!element || element.visible === false) continue;
			if (
				(element.blendMode ?? "normal") !== "normal" ||
				(element.compositionMode ?? "normal") !== "normal"
			) {
				anyElementNeedsCompositing = true;
				// alpha-lock needs a transparent-background render target to
				// see actual element alpha, so force layer-level compositing.
				if ((element.compositionMode ?? "normal") !== "normal") {
					anyLayerNeedsCompositing = true;
				}
				break;
			}
			if (isGroup(element)) {
				for (const childId of element.childIds) {
					const child = elementsMap.get(childId);
					if (child) stack.push(child);
				}
			}
		}
		if (anyElementNeedsCompositing) break;
	}

	return {
		needsCompositing: anyLayerNeedsCompositing || anyElementNeedsCompositing,
		anyLayerNeedsCompositing,
	};
}

/**
 * Classify a single element's filters into backdrop entries or filter plans.
 * Pure function — uses filterHandler metadata only (no GPU operations).
 */
function classifyElementFilters(
	element: AnyArtObject,
	bounds: WorldBBox,
	filterHandlers: ReadonlyMap<string, FilterHandler>,
	skipBackdropFilters: boolean,
	layerIndex: number,
	elementIndex: number,
): {
	filterPlan: ElementFilterPlan | null;
	backdropEntry: BackdropElementEntry | null;
} {
	const enabledFilters = element.filters?.filter(isFilterEnabled);
	if (!enabledFilters || enabledFilters.length === 0) {
		return { filterPlan: null, backdropEntry: null };
	}

	// Separate regular and backdrop filters using handler metadata
	const regularFilters: Filter[] = [];
	const backdropFilters: Filter[] = [];
	for (const filter of enabledFilters) {
		const handler = filterHandlers.get(filter.processor);
		// A render-replacing appearance (e.g. glass extrude) composites via its
		// own mechanism (the mid-pass refraction interrupt), not the generic
		// backdrop-element path, so it stays in regularFilters.
		if (resolveRenderConfigure(handler, filter).needsBackdrop) {
			if (handler?.replacesElementRender?.(filter)) {
				regularFilters.push(filter);
			} else {
				backdropFilters.push(filter);
			}
		} else {
			regularFilters.push(filter);
		}
	}

	// Backdrop filters take precedence — element goes into backdrop processing
	if (backdropFilters.length > 0 && !skipBackdropFilters) {
		return {
			filterPlan: null,
			backdropEntry: {
				element,
				bounds,
				backdropFilters,
				regularFilters,
				layerIndex,
				elementIndex,
			},
		};
	}

	// A glass extrude composites mid-pass and applies the filters that follow
	// it itself, so everything after it belongs to that path and not to this
	// one. Routing them here as well ran each of them a second time into a
	// texture the element's inline-composite branch never blits — the second
	// drop shadow in the test document cost three passes and three copies a
	// frame and was thrown away. Mirrors
	// ExtrudeAppearanceRenderer.getDownstreamFilters.
	const glassAppearanceIndex = enabledFilters.findIndex((f) => {
		const handler = filterHandlers.get(f.processor);
		return (
			!!handler?.replacesElementRender?.(f) &&
			resolveRenderConfigure(handler, f).needsBackdrop
		);
	});

	// Check if there are any post-filters (handler has postProcess). A
	// render-replacing appearance (extrude3d) routes to the post-filter path
	// only when opaque; its glass variant (needsBackdrop) routes through the
	// mid-pass refraction interrupt instead.
	const postFilters = regularFilters.filter((f) => {
		const handler = filterHandlers.get(f.processor);
		if (handler?.replacesElementRender?.(f)) {
			return !resolveRenderConfigure(handler, f).needsBackdrop;
		}
		if (
			glassAppearanceIndex >= 0 &&
			enabledFilters.indexOf(f) > glassAppearanceIndex &&
			handler?.postProcess
		) {
			return false;
		}
		return classifyFilterHandler(handler) === "raster";
	});

	// Detect whether any appearance has sub-filters that require the
	// per-appearance offscreen path. Geometry sub-filters (path-offset,
	// zigzag) deform inline — through resolveAppearancePasses for paths and
	// renderGroupAppearanceFilters for groups — so routing them offscreen
	// would only rasterize them at the document's fixed DPI. Other element
	// types have no inline per-appearance deformation, so they still need it.
	const deformsInline = isGroup(element) || element.type === "path";
	let hasAnySubFilters = false;
	for (const filter of element.filters ?? []) {
		if (!isFilterEnabled(filter)) continue;
		const needsOffscreen = (filter.subFilters ?? []).some((sf) => {
			switch (classifyFilterHandler(filterHandlers.get(sf.processor))) {
				case "geometry":
					return isFilterEnabled(sf) && !deformsInline;
				case "raster":
					return isFilterEnabled(sf);
				default:
					return false;
			}
		});
		if (needsOffscreen) {
			hasAnySubFilters = true;
			break;
		}
	}

	// A render-replacing appearance (extrude3d) draws the element itself
	// (Illustrator-style), so its fill/stroke/content appearances are
	// suppressed from routing decisions and per-appearance plans while active.
	const suppressFlatAppearances = (element.filters ?? []).some(
		(f) =>
			isFilterEnabled(f) &&
			filterHandlers.get(f.processor)?.replacesElementRender?.(f),
	);

	// Detect whether any appearance uses a non-normal blend mode,
	// which requires per-appearance offscreen rendering for correct compositing.
	// For Group elements, appearance blend modes are handled inline by
	// renderGroupAppearanceFilters, so skip offscreen routing.
	let hasNonNormalAppearanceBlend = false;
	if (!isGroup(element)) {
		for (const filter of element.filters ?? []) {
			if (!isFilterEnabled(filter)) continue;
			const isFlatAppearance =
				filter.processor === "fill" ||
				filter.processor === "stroke" ||
				filter.processor === "content";
			if (isFlatAppearance && suppressFlatAppearances) continue;
			// extrude3d is a self-sizing post-filter (fast path) — its blend is
			// applied on the layer blit, never via per-appearance offscreen.
			if (isFlatAppearance) {
				if (filter.blendMode !== "normal") {
					hasNonNormalAppearanceBlend = true;
					break;
				}
			}
		}
	}

	// Wash strokes accumulate flow in an isolated appearance texture and
	// apply strokeOpacity once at composite time — same offscreen routing as
	// a non-normal appearance blend. Groups carry no stroke appearances of
	// their own here.
	let hasWashStroke = false;
	if (!isGroup(element) && !suppressFlatAppearances) {
		for (const filter of element.filters ?? []) {
			if (!isFilterEnabled(filter) || filter.processor !== "stroke") continue;
			if (washStrokeOpacityOf(filter) != null) {
				hasWashStroke = true;
				break;
			}
		}
	}

	if (
		postFilters.length === 0 &&
		!hasAnySubFilters &&
		!hasNonNormalAppearanceBlend &&
		!hasWashStroke
	) {
		// Only pre-filters or appearance filters — rendered inline, no offscreen pass needed
		return { filterPlan: null, backdropEntry: null };
	}

	// Calculate element-level expansion margins using handler metadata (pure math).
	// Sub-filter expansion is handled per-appearance in AppearancePlan.textureBounds.
	let expansion = 0;
	for (const filter of regularFilters) {
		if (!isFilterEnabled(filter)) continue;
		const handler = filterHandlers.get(filter.processor);
		if (handler) {
			expansion = Math.max(
				expansion,
				handler.getExpansionMargin(filter, bounds),
			);
		}
	}
	const textureBounds = expandBounds(bounds, expansion);

	// Build per-appearance plans when any appearance has sub-filters.
	// ALL enabled appearances are included so they can be rendered individually
	// in array order with sub-filters applied after each one.
	let allAppearancePlans: AppearancePlan[] | undefined;
	let maxSubExpansion = 0;
	if (hasAnySubFilters || hasNonNormalAppearanceBlend || hasWashStroke) {
		allAppearancePlans = [];
		for (let i = 0; i < (element.filters?.length ?? 0); i++) {
			const filter = element.filters![i];
			if (!isFilterEnabled(filter)) continue;
			if (
				suppressFlatAppearances &&
				(filter.processor === "fill" ||
					filter.processor === "stroke" ||
					filter.processor === "content")
			) {
				continue;
			}
			// Only include appearance filters (fill/stroke/content); geometry and
			// raster filters (including extrude3d, a self-sizing post-filter) are
			// routed separately.
			const handler = filterHandlers.get(filter.processor);
			if (classifyFilterHandler(handler) !== null) continue;

			// Split this appearance's sub-filters by the stage they run in.
			let preSubFilters: Filter[] = [];
			let postSubFilters: Filter[] = [];
			let planTexBounds = textureBounds;
			if (filter.subFilters && filter.subFilters.length > 0) {
				preSubFilters = filter.subFilters.filter(
					(sf) =>
						isFilterEnabled(sf) &&
						classifyFilterHandler(filterHandlers.get(sf.processor)) ===
							"geometry",
				);
				postSubFilters = filter.subFilters.filter(
					(sf) =>
						isFilterEnabled(sf) &&
						classifyFilterHandler(filterHandlers.get(sf.processor)) ===
							"raster",
				);

				// Calculate expansion from both pre and post sub-filters
				let subExpansion = 0;
				for (const sf of [...preSubFilters, ...postSubFilters]) {
					const sfHandler = filterHandlers.get(sf.processor);
					subExpansion = Math.max(
						subExpansion,
						sfHandler?.getExpansionMargin(sf, bounds) ?? 0,
					);
				}
				if (subExpansion > 0) {
					maxSubExpansion = Math.max(maxSubExpansion, subExpansion);
					planTexBounds = expandBounds(bounds, subExpansion);
				}
			}

			const wash = filter.processor === "stroke" ? washInfoOf(filter) : null;
			allAppearancePlans.push({
				appearance: filter,
				filterIndex: i,
				preSubFilters,
				postSubFilters,
				textureBounds: planTexBounds,
				opacity: filter.opacity,
				blendMode: filter.blendMode,
				...(wash != null
					? {
							washStrokeOpacity: wash.strokeOpacity,
							washBrushSize: wash.brushSize,
							...(wash.wetEdge ? { washWetEdge: wash.wetEdge } : {}),
						}
					: {}),
			});
		}
	}

	// Re-expand element-level textureBounds to include sub-filter expansion
	// so the accumulator texture is large enough for all per-appearance results.
	const finalTextureBounds =
		maxSubExpansion > 0
			? expandBounds(bounds, Math.max(expansion, maxSubExpansion))
			: textureBounds;

	// Unify all per-appearance textureBounds to finalTextureBounds so every
	// appearance renders into the same coordinate space for accumulator compositing.
	if (allAppearancePlans) {
		for (const plan of allAppearancePlans) {
			plan.textureBounds = finalTextureBounds;
		}
	}

	return {
		filterPlan: {
			elementId: element.id,
			element,
			bounds,
			enabledFilters,
			postFilters,
			textureBounds: finalTextureBounds,
			allAppearancePlans,
		},
		backdropEntry: null,
	};
}

/**
 * Collect filter plans and backdrop entries for all elements in a layer.
 * Recursion into groups mirrors the original collectFilteredElements logic.
 * Pure function — no GPU operations.
 */
/** Cached pre-filter-deformed bounds. Keyed by element object identity —
 *  document mutations produce new element objects, so entries self-invalidate
 *  and the WeakMap never outlives the element. */
const preFilteredBoundsCache = new WeakMap<AnyArtObject, WorldBBox>();

/**
 * Element bounds for filter planning. Pre-filters (3d-rotate, zigzag, …)
 * deform the geometry at render time, so plan bounds — which size the
 * offscreen texture for any post-filter chain — must come from the deformed
 * segments, or the deformed render clips at the flat outline's bbox.
 * For groups, group-level pre-filters propagate to every child at render
 * time, so the deformed bounds are the union of each child's deformed bounds
 * with the group's pre-filters appended (matching the renderers' child-first
 * merge order).
 */
export function calculatePreFilteredElementBounds(
	element: AnyArtObject,
	elementsMap: ReadonlyMap<string, AnyArtObject>,
	filterRenderer: Parameters<typeof applyPreFilters>[2],
	localBoundsCache?: LocalBoundsCache,
): WorldBBox {
	const base = calculateElementBounds(element, elementsMap, localBoundsCache);

	if (isGroup(element)) {
		if (!subtreeHasPreFilter(element, elementsMap, filterRenderer)) {
			return base;
		}
		const cached = preFilteredBoundsCache.get(element);
		if (cached) return cached;

		const groupPreFilters = (element.filters ?? []).filter((f) =>
			isGeometryFilter(f, filterRenderer),
		);
		// Children live in group-local space (own transforms applied, the
		// group's own transform not yet), so union the deformed bounds there
		// and apply the group transform afterwards.
		const flatLocal = calculateLocalElementBounds(
			element,
			elementsMap,
			localBoundsCache,
		);
		let minX = flatLocal.minX;
		let minY = flatLocal.minY;
		let maxX = flatLocal.maxX;
		let maxY = flatLocal.maxY;
		for (const id of element.childIds) {
			const child = elementsMap.get(id);
			if (!child) continue;
			const effectiveChild = groupPreFilters.length
				? ({
						...child,
						filters: [...(child.filters ?? []), ...groupPreFilters],
					} as AnyArtObject)
				: child;
			const childBounds = calculatePreFilteredElementBounds(
				effectiveChild,
				elementsMap,
				filterRenderer,
				localBoundsCache,
			);
			minX = Math.min(minX, childBounds.minX);
			minY = Math.min(minY, childBounds.minY);
			maxX = Math.max(maxX, childBounds.maxX);
			maxY = Math.max(maxY, childBounds.maxY);
		}
		const groupUnion = transformDeformedLocalBounds(
			{ minX, minY, maxX, maxY },
			getTransform(element),
			flatLocal,
		);
		preFilteredBoundsCache.set(element, groupUnion);
		return groupUnion;
	}

	if (element.type !== "path" && element.type !== "image") return base;
	const hasPreFilter = (element.filters ?? []).some((f) =>
		isGeometryFilter(f, filterRenderer),
	);
	const appearancePreSubFilters =
		element.type === "path"
			? collectAppearancePreSubFilters(element, filterRenderer)
			: [];
	if (!hasPreFilter && appearancePreSubFilters.length === 0) return base;

	const cached = preFilteredBoundsCache.get(element);
	if (cached) return cached;

	let deformed: WorldBBox;
	if (element.type === "path") {
		const segments = applyPreFilters(
			element.segments,
			element.filters,
			filterRenderer,
		);
		// Deform in local space, then apply the element transform about the
		// flat local centre — the origin the GPU transform buffer uses.
		// Appearance-level pre sub-filters deform per appearance on top of the
		// element-level pre-filters, so union every variant's local extent.
		let local: { minX: number; minY: number; maxX: number; maxY: number } =
			calculateLocalElementBounds({ ...element, segments }, elementsMap);
		for (const subFilters of appearancePreSubFilters) {
			const subSegments = applyPreFilters(segments, subFilters, filterRenderer);
			const subLocal = calculateLocalElementBounds(
				{ ...element, segments: subSegments },
				elementsMap,
			);
			local = {
				minX: Math.min(local.minX, subLocal.minX),
				minY: Math.min(local.minY, subLocal.minY),
				maxX: Math.max(local.maxX, subLocal.maxX),
				maxY: Math.max(local.maxY, subLocal.maxY),
			};
		}
		deformed = transformDeformedLocalBounds(
			local,
			getTransform(element),
			calculateLocalElementBounds(element, elementsMap, localBoundsCache),
		);
	} else {
		deformed = deformedImageWorldBounds(element, filterRenderer);
	}
	// Union with the flat bounds so strokes/effects anchored to the original
	// outline never fall outside the plan bounds either.
	const minX = Math.min(base.minX, deformed.minX);
	const minY = Math.min(base.minY, deformed.minY);
	const maxX = Math.max(base.maxX, deformed.maxX);
	const maxY = Math.max(base.maxY, deformed.maxY);
	const union = brandWorldBBox({
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	});
	preFilteredBoundsCache.set(element, union);
	return union;
}

/** Apply an element's SRT transform to deformed local bounds, rotating and
 *  scaling about the FLAT local bounds' centre — the same origin the GPU
 *  transform buffer and calculateElementBounds use — so the deformed extent
 *  lands where the renderer actually draws it. */
function transformDeformedLocalBounds(
	bounds: { minX: number; minY: number; maxX: number; maxY: number },
	t: ElementTransform,
	flatLocal: { minX: number; minY: number; maxX: number; maxY: number },
): WorldBBox {
	if (isIdentityTransform(t)) {
		return brandWorldBBox({
			...bounds,
			width: bounds.maxX - bounds.minX,
			height: bounds.maxY - bounds.minY,
		});
	}
	const originX = (flatLocal.minX + flatLocal.maxX) / 2;
	const originY = (flatLocal.minY + flatLocal.maxY) / 2;
	const corners = [
		[bounds.minX, bounds.minY],
		[bounds.maxX, bounds.minY],
		[bounds.maxX, bounds.maxY],
		[bounds.minX, bounds.maxY],
	] as const;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const [px, py] of corners) {
		const p = applyTransformToPoint(px, py, t, originX, originY);
		minX = Math.min(minX, p.x);
		minY = Math.min(minY, p.y);
		maxX = Math.max(maxX, p.x);
		maxY = Math.max(maxY, p.y);
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

/** True when the element or any group descendant carries an enabled
 *  preProcess filter — the gate for the deformed-bounds recursion above. */
function subtreeHasPreFilter(
	element: AnyArtObject,
	elementsMap: ReadonlyMap<string, AnyArtObject>,
	filterRenderer: Parameters<typeof applyPreFilters>[2],
): boolean {
	if (
		(element.filters ?? []).some((f) => isGeometryFilter(f, filterRenderer)) ||
		collectAppearancePreSubFilters(element, filterRenderer).length > 0
	) {
		return true;
	}
	if (!isGroup(element)) return false;
	return element.childIds.some((id) => {
		const child = elementsMap.get(id);
		return child
			? subtreeHasPreFilter(child, elementsMap, filterRenderer)
			: false;
	});
}

/** Enabled preProcess sub-filters of each enabled fill/stroke appearance —
 *  these deform geometry inline per appearance (see PathElementRenderer). */
function collectAppearancePreSubFilters(
	element: AnyArtObject,
	filterRenderer: Parameters<typeof applyPreFilters>[2],
): Filter[][] {
	const result: Filter[][] = [];
	for (const filter of element.filters ?? []) {
		if (!isFilterEnabled(filter)) continue;
		if (filter.processor !== "fill" && filter.processor !== "stroke") continue;
		const subs = (filter.subFilters ?? []).filter((sf) =>
			isGeometryFilter(sf, filterRenderer),
		);
		if (subs.length > 0) result.push(subs);
	}
	return result;
}

/**
 * World bounds of an image after pre-filter deformation, mirroring
 * ImageElementRenderer: the image rect becomes a 4-sided quad path, the
 * deformed local extent is transformed about the original rect centre.
 */
function deformedImageWorldBounds(
	image: ImageObject,
	filterRenderer: Parameters<typeof applyPreFilters>[2],
): WorldBBox {
	const halfWidth = image.width / 2;
	const halfHeight = image.height / 2;
	const local = {
		minX: image.x - halfWidth,
		minY: image.y - halfHeight,
		maxX: image.x + halfWidth,
		maxY: image.y + halfHeight,
	};
	const segments = applyPreFilters(
		buildImageQuadSegments(local),
		image.filters,
		filterRenderer,
	);

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	const include = (x: number, y: number) => {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	};
	let prevEnd: CubicBezierSegment["end"] | undefined;
	for (const segment of segments) {
		const start = segment.start ?? prevEnd;
		if (start) {
			include(start.x, start.y);
			include(start.x + segment.cp1.x, start.y + segment.cp1.y);
		}
		include(segment.end.x, segment.end.y);
		include(segment.end.x + segment.cp2.x, segment.end.y + segment.cp2.y);
		prevEnd = segment.end;
	}

	const t = getTransform(image);
	if (!isIdentityTransform(t)) {
		// Same rotation origin as the renderer: the original rect centre.
		const originX = (local.minX + local.maxX) / 2;
		const originY = (local.minY + local.maxY) / 2;
		const corners = [
			applyTransformToPoint(minX, minY, t, originX, originY),
			applyTransformToPoint(maxX, minY, t, originX, originY),
			applyTransformToPoint(maxX, maxY, t, originX, originY),
			applyTransformToPoint(minX, maxY, t, originX, originY),
		];
		minX = Math.min(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
		minY = Math.min(corners[0].y, corners[1].y, corners[2].y, corners[3].y);
		maxX = Math.max(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
		maxY = Math.max(corners[0].y, corners[1].y, corners[2].y, corners[3].y);
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

function collectPlanCandidates(
	elements: AnyArtObject[],
	elementsMap: ReadonlyMap<string, AnyArtObject>,
	layerIndex: number,
	filterHandlers: ReadonlyMap<string, FilterHandler>,
	skipBackdropFilters: boolean,
	candidates: PlanCandidate[],
	baseElementIndex = 0,
	localBoundsCache?: LocalBoundsCache,
	skipCull = false,
	transientIds?: ReadonlySet<string>,
): void {
	const handlerLookup = {
		getHandler: (processor: string) => filterHandlers.get(processor),
	};
	for (let i = 0; i < elements.length; i++) {
		const element = elements[i];
		const elementIndex = baseElementIndex + i;
		// Transient elements (live previews) mutate under a stable id without
		// any document-change invalidation, so a cached bounds entry would pin
		// the plan (and its offscreen texture) to the first frame's size.
		const elementBounds = calculatePreFilteredElementBounds(
			element,
			elementsMap,
			handlerLookup,
			transientIds?.has(element.id) ? undefined : localBoundsCache,
		);

		const { filterPlan, backdropEntry } = classifyElementFilters(
			element,
			elementBounds,
			filterHandlers,
			skipBackdropFilters,
			layerIndex,
			elementIndex,
		);

		if (filterPlan || backdropEntry) {
			candidates.push({
				bounds: filterPlan?.textureBounds ?? elementBounds,
				filterPlan,
				backdropEntry,
				skipCull,
			});
		}
		if (backdropEntry) continue;

		// Recurse into group children for individual element filters.
		// Skip recursion only when the group itself has a filterPlan (offscreen
		// rendering) — in that case renderGroupToTexture handles child filters.
		// A child inside the viewport implies its group intersects too (group
		// bounds contain the children), so classifying every child here and
		// culling per candidate in buildFramePlanView matches the previous
		// cull-before-recurse behaviour.
		if (isGroup(element) && !filterPlan) {
			const childElements = element.childIds
				.map((id) => elementsMap.get(id))
				.filter((el): el is AnyArtObject => el !== undefined);
			collectPlanCandidates(
				childElements,
				elementsMap,
				layerIndex,
				filterHandlers,
				skipBackdropFilters,
				candidates,
				elementIndex,
				localBoundsCache,
				skipCull,
			);
		} else if (isRepeat(element)) {
			// Repeat sources are absorbed (referenced only by `sourceIds`, on no
			// layer), so the layer walk never reaches them and their own filters go
			// unbaked — leaving `bakeRepeat` to replicate the bare pre-filter
			// geometry. Notably a 3D solid appearance replaces the flat look, so an
			// unbaked source would show as its original flat object. Collect the
			// source plans here so `executeFilterPlans` bakes them before
			// `bakeRepeats` runs. Backdrop filters are skipped (an absorbed source
			// has no document-behind to sample), and the plans skip the viewport
			// cull to match `bakeRepeats` baking every repeat.
			const sourceElements = element.sourceIds
				.map((id) => elementsMap.get(id))
				.filter((el): el is AnyArtObject => el !== undefined);
			collectPlanCandidates(
				sourceElements,
				elementsMap,
				layerIndex,
				filterHandlers,
				true,
				candidates,
				elementIndex,
				localBoundsCache,
				true,
			);
		}
	}
}

/**
 * Build layer segments by slicing elements at backdrop boundaries.
 * Each segment is a contiguous run of elements followed by an optional
 * backdrop element to process.
 */
function buildLayerSegments(
	layerElements: AnyArtObject[],
	backdropEntries: BackdropElementEntry[],
): LayerSegment[] {
	if (backdropEntries.length === 0) {
		return [{ elements: layerElements, backdropAfter: null }];
	}

	const sorted = [...backdropEntries].sort(
		(a, b) => a.elementIndex - b.elementIndex,
	);
	const segments: LayerSegment[] = [];
	let lastProcessedIndex = -1;

	for (const bdEntry of sorted) {
		const elementsBefore = layerElements.slice(
			lastProcessedIndex + 1,
			bdEntry.elementIndex,
		);
		segments.push({
			elements: elementsBefore,
			backdropAfter: bdEntry,
		});
		lastProcessedIndex = bdEntry.elementIndex;
	}

	// Final segment: elements after the last backdrop
	const elementsAfter = layerElements.slice(lastProcessedIndex + 1);
	segments.push({ elements: elementsAfter, backdropAfter: null });

	return segments;
}

/**
 * Build the viewport-independent part of the frame plan from document data.
 * Resolves layers, classifies every element's filters (with world-space
 * bounds), and prepares layer metadata. This is a pure function — no GPU
 * state or side effects — and its result stays valid until the document,
 * overlays (overrides/transients), or any element's local bounds change.
 */
/**
 * Filter plans for elements that are drawn outside the layer walk — mask
 * content, which belongs to no layer and so never reaches the frame plan.
 *
 * Without a plan such an element is drawn with no filters at all. For most
 * elements that only loses an effect, but an appearance that *replaces* the
 * element's render (a 3D solid) suppresses the flat look and then contributes
 * nothing whatsoever.
 *
 * Backdrop filters are skipped: they are defined against the document behind
 * the element, and inside a mask there is no such thing.
 */
export function buildFilterPlansForElements(
	elements: readonly AnyArtObject[],
	elementsMap: Map<string, AnyArtObject>,
	filterRenderer: Pick<FilterRenderer, "getHandler"> & {
		getHandlers(): ReadonlyMap<string, FilterHandler>;
	},
	localBoundsCache?: LocalBoundsCache,
): Map<string, ElementFilterPlan> {
	const filterHandlers = filterRenderer.getHandlers();
	const plans = new Map<string, ElementFilterPlan>();

	for (const element of elements) {
		const bounds = calculatePreFilteredElementBounds(
			element,
			elementsMap,
			filterRenderer,
			localBoundsCache,
		);
		const { filterPlan } = classifyElementFilters(
			element,
			bounds,
			filterHandlers,
			true,
			0,
			0,
		);
		if (filterPlan) plans.set(element.id, filterPlan);
	}

	return plans;
}

export function buildFramePlanStructure(
	document: Document,
	filterHandlers: ReadonlyMap<string, FilterHandler>,
	skipBackdropFilters: boolean,
	localBoundsCache?: LocalBoundsCache,
	existingElementsMap?: Map<string, AnyArtObject>,
	transientElements?: ReadonlyMap<string, TransientElementEntry>,
): FramePlanStructure {
	const elementsMap =
		existingElementsMap ?? new Map(Object.entries(document.objects));
	const layerElementsCache = buildLayerElementsCache(
		document,
		elementsMap,
		transientElements,
	);
	const { needsCompositing, anyLayerNeedsCompositing } = checkCompositingNeeded(
		document,
		layerElementsCache,
		elementsMap,
	);
	const hasArtboards = document.artboards.length > 0;
	const clearColor = hasArtboards
		? { r: 0.9, g: 0.9, b: 0.9, a: 1.0 }
		: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 };

	const transientIds =
		transientElements != null
			? new Set(
					[...transientElements.values()].map((entry) => entry.element.id),
				)
			: undefined;
	const candidates: PlanCandidate[] = [];
	const layerRows: LayerRow[] = [];
	for (let layerIndex = 0; layerIndex < document.layers.length; layerIndex++) {
		const layer = document.layers[layerIndex];
		if (!layer.visible) continue;
		const layerElements = layerElementsCache.get(layer.id) ?? [];
		collectPlanCandidates(
			layerElements,
			elementsMap,
			layerIndex,
			filterHandlers,
			skipBackdropFilters,
			candidates,
			0,
			localBoundsCache,
			false,
			transientIds,
		);
		const blending = scanBlendingFlags(layerElements, elementsMap);
		layerRows.push({
			layerIndex,
			layerId: layer.id,
			elements: layerElements,
			opacity: layer.opacity,
			blendMode: layer.blendMode ?? "normal",
			hasCompositionModeElement: blending.hasCompositionModeElement,
		});
	}

	return {
		elementsMap,
		layerElementsCache,
		needsCompositing,
		anyLayerNeedsCompositing,
		hasArtboards,
		clearColor,
		candidates,
		layerRows,
		localBoundsCache,
	};
}

/**
 * Derive the per-frame plan from a structure: cull candidates against the
 * viewport and slice layers into segments at the surviving backdrop
 * boundaries. Cheap — O(candidates + layers + backdrops), not O(elements).
 */
export function buildFramePlanView(
	structure: FramePlanStructure,
	viewport: Viewport,
	canvasWidth: number,
	canvasHeight: number,
): FramePlan {
	const filterPlans = new Map<string, ElementFilterPlan>();
	const allBackdropEntries: BackdropElementEntry[] = [];
	for (const candidate of structure.candidates) {
		const bounds = candidate.bounds;
		const intersects = boundsIntersectViewport(
			bounds.minX,
			bounds.minY,
			bounds.maxX,
			bounds.maxY,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		if (candidate.filterPlan && (candidate.skipCull || intersects)) {
			filterPlans.set(candidate.filterPlan.elementId, candidate.filterPlan);
		}
		if (candidate.backdropEntry && intersects) {
			allBackdropEntries.push(candidate.backdropEntry);
		}
	}

	// Group backdrops by layer for segment construction
	const backdropByLayer = new Map<number, BackdropElementEntry[]>();
	for (const entry of allBackdropEntries) {
		const arr = backdropByLayer.get(entry.layerIndex) ?? [];
		arr.push(entry);
		backdropByLayer.set(entry.layerIndex, arr);
	}

	// Build per-layer plans with segments
	const layerPlans: LayerPlan[] = [];
	for (const row of structure.layerRows) {
		const layerBackdrops = backdropByLayer.get(row.layerIndex) ?? [];
		layerPlans.push({
			layerIndex: row.layerIndex,
			layerId: row.layerId,
			elements: row.elements,
			opacity: row.opacity,
			blendMode: row.blendMode,
			needsLayerCompositing:
				row.blendMode !== "normal" || row.hasCompositionModeElement,
			segments: buildLayerSegments(row.elements, layerBackdrops),
		});
	}

	const backdropElementIds = new Set(
		allBackdropEntries.map((e) => e.element.id),
	);

	return {
		layerElementsCache: structure.layerElementsCache,
		elementsMap: structure.elementsMap,
		needsCompositing: structure.needsCompositing,
		anyLayerNeedsCompositing: structure.anyLayerNeedsCompositing,
		hasArtboards: structure.hasArtboards,
		clearColor: structure.clearColor,
		layerPlans,
		backdropElementIds,
		allBackdropEntries,
		filterPlans,
		localBoundsCache: structure.localBoundsCache,
	};
}

/** Check whether any element (including group children) has non-normal compositionMode. */
function scanBlendingFlags(
	elements: AnyArtObject[],
	elementsMap: Map<string, AnyArtObject>,
): { hasCompositionModeElement: boolean; hasBlendingElement: boolean } {
	let hasBlendingElement = false;
	const stack = [...elements];
	while (stack.length > 0) {
		const el = stack.pop()!;
		if ((el.compositionMode ?? "normal") !== "normal") {
			// Implies hasBlendingElement — nothing further to learn.
			return { hasCompositionModeElement: true, hasBlendingElement: true };
		}
		if ((el.blendMode ?? "normal") !== "normal") {
			hasBlendingElement = true;
		}
		if (isGroup(el)) {
			for (const childId of el.childIds) {
				const child = elementsMap.get(childId);
				if (child) stack.push(child);
			}
		}
	}
	return { hasCompositionModeElement: false, hasBlendingElement };
}

/** strokeOpacity of a wash-routed stroke appearance, or null otherwise. */
function washStrokeOpacityOf(filter: Filter): number | null {
	return washInfoOf(filter)?.strokeOpacity ?? null;
}

/** Wash routing info of a stroke appearance, or null for other routes. */
function washInfoOf(filter: Filter): {
	strokeOpacity: number;
	brushSize: number;
	wetEdge: WetEdgeConfig | undefined;
} | null {
	const raw = (filter as StrokeAppearance).paramData.params.brushSettings;
	if (raw == null) return null;
	const route = resolveBrushRenderRoute(raw);
	// Ribbons wash too (design §12): the isolation and the single
	// strokeOpacity application are engine-independent, and a ribbon that
	// doubles back over itself darkens exactly like a dab stroke does.
	if (route.kind !== "dab-v2" && route.kind !== "ribbon-legacy") return null;
	if (route.settings.paintMode !== "wash") return null;
	return {
		strokeOpacity: route.settings.strokeOpacity,
		brushSize: readStoredBrushSize(route.settings) ?? 0,
		// Wet edge and the wet layer are exclusive (§H-4).
		wetEdge:
			route.settings.wet?.enabled === true ? undefined : route.settings.wetEdge,
	};
}
