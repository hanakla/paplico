import {
	readStoredBrushSize,
	resolveBrushRenderRequirements,
} from "../../../brush/access";
import { localAppearances } from "../../../document/appearancePresets";
import { classifyFilterHandler } from "../../../document/elementGeometry/filterCapabilities";
import { planBoundsOf } from "../../../document/elementGeometry/filteredBounds";
import {
	geometryFilters,
	withInheritedPreFilters,
} from "../../../document/elementGeometry/preFilters";
import {
	type AnyArtObject,
	type BlendMode,
	type BoundingBox,
	type Document,
	type ElementTransform,
	type Filter,
	isFilterEnabled,
	isGroup,
	isRepeat,
	type StrokeAppearance,
	type Viewport,
	type WetEdgeConfig,
} from "../../../schema";
import type { LocalBoundsCache } from "../../../utils/geometry/elementBounds";
import {
	boundsIntersectionBox,
	expandBounds,
	type WorldBBox,
} from "../../../utils/geometry/primitives/box";
import { boundsIntersectViewport } from "../../../utils/geometry/query/viewport";
import { placeElement } from "../../../utils/geometry/space/coordinates";
import type { FrameRequest, TransientElementEntry } from "../../types";
import {
	collectExternallyReferencedIds,
	expandRenderFilter,
	unionBoundingBoxes,
} from "../CanvasLayer.helpers";
import {
	type FilterHandler,
	type FilterRenderer,
	resolveRenderConfigure,
} from "./FilterRenderer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Entry describing an element that requires backdrop-filter processing. */
export interface BackdropElementEntry {
	element: AnyArtObject;
	bounds: WorldBBox;
	backdropFilters: Filter[];
	regularFilters: Filter[];
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
	/** When present, ALL appearances must be rendered individually in order,
	 *  which keeps the draw order correct when any appearance has subFilters. */
	allAppearancePlans?: AppearancePlan[];
	/** The chain yields only the filter's own contribution (a drop shadow),
	 *  drawn beneath the element. The element then draws as if unfiltered, so
	 *  a group's children composite against the document and that shadow
	 *  rather than inside an isolated bake. */
	underlay?: true;
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
	/** Wash strokes only: strokeOpacity to apply exactly once
	 *  when compositing the isolated appearance; dabs carry flow alone. */
	washStrokeOpacity?: number;
	/** Watercolor rim for wash strokes; absent while wet is enabled. */
	washWetEdge?: WetEdgeConfig;
	/** Brush size for the wet-edge width cap (world units). */
	washBrushSize?: number;
}

/** Per-layer rendering plan. */
interface LayerPlan {
	layerId: string;
	elements: AnyArtObject[];
	opacity: number;
	blendMode: BlendMode;
	/** Whether this layer needs offscreen compositing (non-normal blendMode) */
	needsLayerCompositing: boolean;
}

/** Complete frame rendering plan. Pure data, no GPU references. */
export interface FramePlan {
	/** Resolved AnyArtObject arrays per layer id (visible layers only). */
	layerElementsCache: Map<string, AnyArtObject[]>;
	/** Elements map built from document.objects */
	elementsMap: Map<string, AnyArtObject>;
	/** Ids of the elements the visible layers draw: their top-level elements
	 *  and everything those contain or reference. `elementsMap` also holds
	 *  elements no visible layer reaches — a hidden layer's content, or a
	 *  deleted layer's leftover descendants. */
	drawnElementIds: ReadonlySet<string>;
	/** Whether any layer or element uses a non-normal blend mode. */
	needsCompositing: boolean;
	/** Whether any layer alone needs compositing (non-normal blendMode). */
	anyLayerNeedsCompositing: boolean;
	/** Whether the document has artboards (affects clear color). */
	hasArtboards: boolean;
	/** Clear color for the first render pass. */
	clearColor: GPUColorDict;
	layerPlans: LayerPlan[];
	/** On-screen backdrop-filter elements at any depth, by element id. The
	 *  render walk processes each where it meets it, so it lands in z-order
	 *  inside its groups too. */
	backdropEntries: ReadonlyMap<string, BackdropElementEntry>;
	/** Elements needing offscreen filter pass. Key: element.id */
	filterPlans: ReadonlyMap<string, ElementFilterPlan>;
	/** Pre-computed element bounds cache from ViewportManager, used to
	 *  avoid redundant O(N) bounds recalculation in hot paths. */
	localBoundsCache?: LocalBoundsCache;
}

/** A pass break declared at plan time: the main pass ends here, something
 *  composites offscreen, and the pass restarts. */
type SegmentBreak =
	| { kind: "compositeElement"; elementId: string }
	| { kind: "inlineBackdropCompose"; elementId: string };

/** Contiguous element run the main pass can encode without a break. */
interface PassSegment {
	elements: AnyArtObject[];
	breakAfter: SegmentBreak | null;
}

export interface LayerPassPlan {
	layerPlan: LayerPlan;
	segments: PassSegment[];
}

/**
 * Declare every pass break ahead of execution by splitting each layer's
 * elements at the element-level break conditions the render loop currently
 * discovers procedurally: blend/composition-mode compositing and inline
 * backdrop composes (glass extrude). Break elements live in
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
		let run: AnyArtObject[] = [];
		for (const element of layerPlan.elements) {
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
		segments.push({ elements: run, breakAfter: null });
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
	drawnElementIds: ReadonlySet<string>;
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
): {
	filterPlan: ElementFilterPlan | null;
	backdropEntry: BackdropElementEntry | null;
} {
	const enabledFilters = localAppearances(element.filters).filter(
		isFilterEnabled,
	);
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
	// would only rasterize them at the document's fixed DPI. A text draws its
	// glyphs as paths, so it deforms inline too. Other element types have no
	// inline per-appearance deformation, so they still need it.
	const deformsInline =
		isGroup(element) || element.type === "path" || element.type === "text";
	let hasAnySubFilters = false;
	for (const filter of localAppearances(element.filters)) {
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
	const suppressFlatAppearances = localAppearances(element.filters).some(
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
		for (const filter of localAppearances(element.filters)) {
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
	// The wet layer carries pigment past the stroke's own outline, so the
	// isolated texture has to hold that reach. Sized to the outline alone,
	// every bleed is cropped back to the dabs.
	let wetReach = 0;
	if (!isGroup(element) && !suppressFlatAppearances) {
		for (const filter of localAppearances(element.filters)) {
			if (!isFilterEnabled(filter) || filter.processor !== "stroke") continue;
			if (washInfoOf(filter) != null) hasWashStroke = true;
			wetReach = Math.max(wetReach, wetReachOf(filter));
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
	const textureBounds = expandBounds(bounds, expansion + wetReach);

	// Build per-appearance plans when any appearance has sub-filters.
	// ALL enabled appearances are included so they can be rendered individually
	// in array order with sub-filters applied after each one.
	let allAppearancePlans: AppearancePlan[] | undefined;
	let maxSubExpansion = 0;
	if (hasAnySubFilters || hasNonNormalAppearanceBlend || hasWashStroke) {
		allAppearancePlans = [];
		const localFilters = localAppearances(element.filters);
		for (let i = 0; i < localFilters.length; i++) {
			const filter = localFilters[i];
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
			...(allAppearancePlans == null &&
			drawsFilterBeneath(element, postFilters, filterHandlers)
				? { underlay: true as const }
				: {}),
		},
		backdropEntry: null,
	};
}

/** Shared inputs of one plan walk over a layer. */
interface PlanWalk {
	elementsMap: ReadonlyMap<string, AnyArtObject>;
	filterHandlers: ReadonlyMap<string, FilterHandler>;
	skipBackdropFilters: boolean;
	candidates: PlanCandidate[];
	localBoundsCache?: LocalBoundsCache;
	transientIds?: ReadonlySet<string>;
}

function collectPlanCandidates(
	elements: AnyArtObject[],
	walk: PlanWalk,
	skipCull = false,
	/** The chain the enclosing groups place the elements under — see
	 *  planBoundsOf. */
	parentMatrix: ElementTransform | null = null,
	/** Geometry filters the enclosing groups hand down, innermost first. */
	parentPreFilters?: Filter[],
): void {
	const {
		elementsMap,
		filterHandlers,
		skipBackdropFilters,
		candidates,
		localBoundsCache,
		transientIds,
	} = walk;
	const handlerLookup = {
		getHandler: (processor: string) => filterHandlers.get(processor),
	};
	for (const child of elements) {
		// Filter plans and backdrop entries render from their element alone,
		// not through the group walk, so the element carries the geometry
		// filters its groups hand down for both its shape and its bounds.
		const element = withInheritedPreFilters(child, parentPreFilters);
		// Transient elements (live previews) mutate under a stable id without
		// any document-change invalidation, so a cached bounds entry would pin
		// the plan (and its offscreen texture) to the first frame's size.
		const elementBounds = planBoundsOf(
			element,
			elementsMap,
			handlerLookup,
			transientIds?.has(element.id) ? undefined : localBoundsCache,
			parentMatrix,
		);

		const { filterPlan, backdropEntry } = classifyElementFilters(
			element,
			elementBounds,
			filterHandlers,
			skipBackdropFilters,
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

		// Recurse into group children for individual element filters. A child
		// inside the viewport implies its group intersects too (group bounds
		// contain the children), so classifying every child here and culling
		// per candidate in buildFramePlanView matches a cull before the
		// recursion. A group drawn from its bake may bake past the viewport,
		// so what lies beneath it keeps its plans wherever it is.
		if (isGroup(element)) {
			const childElements = element.childIds
				.map((id) => elementsMap.get(id))
				.filter((el): el is AnyArtObject => el !== undefined);
			collectPlanCandidates(
				childElements,
				walk,
				skipCull || (filterPlan != null && !filterPlan.underlay),
				placeElement(parentMatrix, element),
				// `element` already carries the inherited filters after its own.
				geometryFilters(element, handlerLookup),
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
				{ ...walk, skipBackdropFilters: true },
				true,
			);
		}
	}
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
	/** The chain the element's enclosing containers place it under, or null
	 *  at the top level — see planBoundsOf. */
	parentMatrixOf?: (elementId: string) => ElementTransform | null,
): Map<string, ElementFilterPlan> {
	const filterHandlers = filterRenderer.getHandlers();
	const plans = new Map<string, ElementFilterPlan>();

	for (const element of elements) {
		const bounds = planBoundsOf(
			element,
			elementsMap,
			filterRenderer,
			localBoundsCache,
			parentMatrixOf?.(element.id) ?? null,
		);
		const { filterPlan } = classifyElementFilters(
			element,
			bounds,
			filterHandlers,
			true,
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
	const drawnElementIds = expandRenderFilter(
		new Set(
			[...layerElementsCache.values()].flatMap((elements) =>
				elements.map((element) => element.id),
			),
		),
		elementsMap,
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
	for (const layer of document.layers) {
		if (!layer.visible) continue;
		const layerElements = layerElementsCache.get(layer.id) ?? [];
		collectPlanCandidates(layerElements, {
			elementsMap,
			filterHandlers,
			skipBackdropFilters,
			candidates,
			localBoundsCache,
			transientIds,
		});
		const blending = scanBlendingFlags(layerElements, elementsMap);
		layerRows.push({
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
		drawnElementIds,
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
 * viewport. Cheap — O(candidates + layers), not O(elements).
 */
export function buildFramePlanView(
	structure: FramePlanStructure,
	viewport: Viewport,
	canvasWidth: number,
	canvasHeight: number,
): FramePlan {
	const filterPlans = new Map<string, ElementFilterPlan>();
	const backdropEntries = new Map<string, BackdropElementEntry>();
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
			backdropEntries.set(
				candidate.backdropEntry.element.id,
				candidate.backdropEntry,
			);
		}
	}

	const layerPlans: LayerPlan[] = structure.layerRows.map((row) => ({
		layerId: row.layerId,
		elements: row.elements,
		opacity: row.opacity,
		blendMode: row.blendMode,
		needsLayerCompositing:
			row.blendMode !== "normal" || row.hasCompositionModeElement,
	}));

	return {
		layerElementsCache: structure.layerElementsCache,
		elementsMap: structure.elementsMap,
		drawnElementIds: structure.drawnElementIds,
		needsCompositing: structure.needsCompositing,
		anyLayerNeedsCompositing: structure.anyLayerNeedsCompositing,
		hasArtboards: structure.hasArtboards,
		clearColor: structure.clearColor,
		layerPlans,
		backdropEntries,
		filterPlans,
		localBoundsCache: structure.localBoundsCache,
	};
}

/** Check whether any element (including group children) has non-normal compositionMode. */
export function scanBlendingFlags(
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

/** How far past its outline a wet stroke's pigment can reach, in world units. */
function wetReachOf(filter: Filter): number {
	const settings = (filter as StrokeAppearance).paramData.params.brushSettings;
	if (settings == null) return 0;
	if (!resolveBrushRenderRequirements(settings).wetEnabled) return 0;
	const brushSize = readStoredBrushSize(settings) ?? 0;
	return brushSize * (0.5 + Math.max(settings.wet!.bleedRadius, 0));
}

/** Wash routing info of a stroke appearance, or null for other routes. */
function washInfoOf(filter: Filter): {
	strokeOpacity: number;
	brushSize: number;
	wetEdge: WetEdgeConfig | undefined;
} | null {
	const settings = (filter as StrokeAppearance).paramData.params.brushSettings;
	if (settings == null) return null;
	const requirements = resolveBrushRenderRequirements(settings);
	if (!requirements.requiresIsolation) return null;
	return {
		strokeOpacity: requirements.strokeOpacity,
		brushSize: readStoredBrushSize(settings) ?? 0,
		wetEdge: requirements.wetEdge,
	};
}

/**
 * Whether the element's filter chain can be drawn beneath it instead of
 * replacing it with a bake: a group whose only raster filter builds itself
 * from coverage alone. Anything that composites the group as one layer (its
 * own blend mode, opacity, clip or mask) needs the bake regardless.
 */
function drawsFilterBeneath(
	element: AnyArtObject,
	postFilters: readonly Filter[],
	filterHandlers: ReadonlyMap<string, FilterHandler>,
): boolean {
	if (!isGroup(element) || postFilters.length !== 1) return false;
	if (!filterHandlers.get(postFilters[0].processor)?.postProcessUnderlay) {
		return false;
	}
	const hasOwnMask =
		element.mask != null &&
		element.mask.enabled !== false &&
		element.mask.elementIds.length > 0;
	return (
		(element.blendMode ?? "normal") === "normal" &&
		(element.compositionMode ?? "normal") === "normal" &&
		(element.opacity ?? 1) === 1 &&
		element.clipPathId == null &&
		!hasOwnMask
	);
}

/** A texel rectangle of the store texture (x/y from its top-left corner). */
export interface TexelRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A qualified partial redraw. `dirtyWorld` is the rect this frame
 *  re-renders, snapped to the store's texel grid, and `scissor` is the same
 *  rect in prebuf texels. It reaches past the region that actually changed
 *  by the footprint of the backdrop reads there, so those reads see freshly
 *  drawn pixels. Once the frame is drawn, `restoreBands` — every texel
 *  outside the changed region that the cache holds — are copied back from
 *  the cache, which also undoes any pass that drew past the scissor. */
export interface PartialRedrawPlan {
	dirtyWorld: BoundingBox;
	scissor: TexelRect;
	restoreBands: TexelRect[];
	/** Offset from a store texel to the cache texel holding the same world
	 *  point: the store may re-anchor by whole texels since the capture. */
	cacheOffset: { x: number; y: number };
	bakedUnion: BoundingBox;
}

/** An element that reads the picture beneath it this frame: a backdrop
 *  filter, or an inline composite that warps or blurs the prebuf. */
export interface PartialRedrawBackdropRead {
	bounds: BoundingBox;
	/** How far (world units) the read behind one output pixel reaches. */
	footprint: number;
}

/** CPU-side facts about the previous frame and the current frame's bounds. */
export interface PartialRedrawState {
	/** Whether the previous composite holds a captured frame to restore. */
	canRestore: boolean;
	/** World region the previous capture rendered completely. */
	bakedWorldBounds: BoundingBox | null;
	/** World rect of the whole store texture at capture time. */
	capturedStoreBounds: BoundingBox | null;
	/** Store texels per world unit at capture time. */
	capturedStoreDensity: number;
	backdropReads: readonly PartialRedrawBackdropRead[];
	/** The element's world bounds in the captured frame, or null when that
	 *  frame did not hold it. */
	previousWorldBoundsOf(id: string): BoundingBox | null;
	/** The element's world bounds as of this frame, or null when it is gone. */
	currentWorldBoundsOf(id: string): BoundingBox | null;
	/** The element holding the element this frame as a child or mask, if any. */
	parentOf(id: string): string | undefined;
}

/**
 * Decide whether a frame can redraw only part of the store and restore the
 * rest from the cached composite. The redrawn part covers the tracked
 * content change and whatever of `targetRegion` (the region the frame must
 * leave complete) the cache does not hold. Returns null to fall back to the
 * plain full render. The fallbacks are deliberately broad: correctness
 * first.
 */
export function planPartialRedraw(
	changedElements: FrameRequest["changedElements"],
	elementsMap: Map<string, AnyArtObject>,
	planStructure: FramePlanStructure,
	storeBox: BoundingBox,
	targetRegion: BoundingBox,
	prebufWidth: number,
	prebufHeight: number,
	prebufZoom: number,
	state: PartialRedrawState,
): PartialRedrawPlan | null {
	if (!changedElements) return null;
	if (
		!state.canRestore ||
		!state.bakedWorldBounds ||
		!state.capturedStoreBounds
	) {
		return null;
	}
	// The restore copies cached texels 1:1 back onto the store, so the store
	// must sit on the capture's texel grid.
	const cacheOffset = storeTexelOffset(
		state.capturedStoreBounds,
		state.capturedStoreDensity,
		storeBox,
		prebufZoom,
	);
	if (!cacheOffset) return null;
	const changed = changedRegionOf(
		changedElements,
		elementsMap,
		planStructure,
		prebufZoom,
		state,
	);
	if (changed === undefined) return null;
	const toTexels = (b: BoundingBox, snap: "outward" | "inward" = "outward") =>
		toStoreTexelRect(b, storeBox, prebufWidth, prebufHeight, prebufZoom, snap);
	const toWorld = (r: TexelRect): BoundingBox =>
		texelRectToWorld(r, storeBox, prebufZoom);
	// A full render records the viewport it drew, which cuts texels at its
	// edges. The screen showed those texels as captured, so they are reused
	// whole instead of falling between the scissor and the restore.
	const bakedTexels = toTexels(state.bakedWorldBounds);
	const reusable =
		bakedTexels &&
		trimInteriorStoreEdges(
			toWorld(bakedTexels),
			state.capturedStoreBounds,
			storeBox,
			state.backdropReads,
		);
	if (!reusable) return null;
	const halfTexel = 0.5 / prebufZoom;
	const dirty = unionBoundingBoxes(
		changed && spreadByBackdropReads(changed.bounds, state.backdropReads),
		uncoveredBounds(targetRegion, reusable, halfTexel),
	);
	if (!dirty) return null;
	const clipped = boundsIntersectionBox(dirty, storeBox);
	// Entirely outside the store: nothing visible changes, but the plain
	// path keeps the bookkeeping (bounds map, capture) coherent.
	if (!clipped) return null;
	const guard = backdropGuard(clipped, state.backdropReads);
	const drawn = boundsIntersectionBox(
		expandBounds(clipped, guard + (changed?.inputReach ?? 0)),
		storeBox,
	);
	if (!drawn) return null;
	// Past this ratio a full redraw costs about the same and re-bakes the
	// whole store for later pans.
	const storeArea = storeBox.width * storeBox.height;
	if (drawn.width * drawn.height > storeArea * 0.4) return null;
	const dirtyTexels = toTexels(clipped);
	const drawnTexels = toTexels(drawn);
	// Inward, so a restore band never copies a texel the cache does not hold.
	const reusableTexels = toTexels(reusable, "inward");
	if (!dirtyTexels || !drawnTexels || !reusableTexels) return null;
	const storeTexels = { x: 0, y: 0, width: prebufWidth, height: prebufHeight };
	const restoreBands = subtractTexelRect(storeTexels, dirtyTexels).flatMap(
		(band) => {
			const kept = intersectTexelRects(band, reusableTexels);
			return kept ? [kept] : [];
		},
	);
	return {
		dirtyWorld: toWorld(drawnTexels),
		scissor: drawnTexels,
		restoreBands,
		cacheOffset,
		bakedUnion:
			rectangularUnion(toWorld(reusableTexels), toWorld(dirtyTexels)) ??
			boundsIntersectionBox(targetRegion, storeBox) ??
			toWorld(dirtyTexels),
	};
}

/**
 * `reusable` without what a backdrop read drew near an edge of the captured
 * store that now lies inside the store. The read found nothing past that
 * edge, so its pixels within its footprint of it are incomplete — harmless
 * at the store's edge, wrong once a re-anchor brings them inside. Each such
 * side is trimmed back by the footprint of the reads touching it.
 */
function trimInteriorStoreEdges(
	reusable: BoundingBox,
	captured: BoundingBox,
	storeBox: BoundingBox,
	reads: readonly PartialRedrawBackdropRead[],
): BoundingBox | null {
	let { minX, minY, maxX, maxY } = reusable;
	for (const { bounds, footprint } of reads) {
		if (footprint <= 0) continue;
		const overlapsX =
			bounds.maxX > captured.minX && bounds.minX < captured.maxX;
		const overlapsY =
			bounds.maxY > captured.minY && bounds.minY < captured.maxY;
		if (
			captured.minX > storeBox.minX &&
			overlapsY &&
			bounds.minX < captured.minX + footprint
		) {
			minX = Math.max(minX, captured.minX + footprint);
		}
		if (
			captured.maxX < storeBox.maxX &&
			overlapsY &&
			bounds.maxX > captured.maxX - footprint
		) {
			maxX = Math.min(maxX, captured.maxX - footprint);
		}
		if (
			captured.minY > storeBox.minY &&
			overlapsX &&
			bounds.minY < captured.minY + footprint
		) {
			minY = Math.max(minY, captured.minY + footprint);
		}
		if (
			captured.maxY < storeBox.maxY &&
			overlapsX &&
			bounds.maxY > captured.maxY - footprint
		) {
			maxY = Math.min(maxY, captured.maxY - footprint);
		}
	}
	return maxX > minX && maxY > minY ? box(minX, minY, maxX, maxY) : null;
}

/**
 * The world region a tracked change redraws, or null when nothing changed
 * and undefined when the change needs a full render. A filtered group
 * holding a changed element spreads the change by its filter reach, and
 * every pixel of that region reads the group's content that far again:
 * `inputReach` is the band the frame draws past the region so those reads
 * are complete. The restore copies that band back from the cache.
 */
function changedRegionOf(
	changedElements: NonNullable<FrameRequest["changedElements"]>,
	elementsMap: Map<string, AnyArtObject>,
	planStructure: FramePlanStructure,
	prebufZoom: number,
	state: PartialRedrawState,
): { bounds: BoundingBox; inputReach: number } | null | undefined {
	const changedIds = new Set([
		...changedElements.upserted,
		...changedElements.deleted,
	]);
	if (changedIds.size === 0) return null;
	// Elements whose rendered output extends past their bounds (filter
	// margins, backdrop capture) need expansion math this path skips.
	const filterPlans = new Map<string, ElementFilterPlan>();
	const backdropIds = new Set<string>();
	for (const candidate of planStructure.candidates) {
		if (candidate.filterPlan) {
			filterPlans.set(candidate.filterPlan.elementId, candidate.filterPlan);
		}
		if (candidate.backdropEntry) {
			backdropIds.add(candidate.backdropEntry.element.id);
		}
	}
	// The render closure: containers relocate descendants, so an edited
	// group dirties every descendant's region (and vice versa). Deleted ids
	// are gone from the elements map, so the closure walk drops them — union
	// them back in: their bounds in the captured frame ARE the deletion's
	// dirty region.
	const closure = new Set([
		...expandRenderFilter(changedIds, elementsMap),
		...changedIds,
	]);
	// A changed element another element derives from (clip path, mask
	// source, compound-path/blend member) alters pixels outside its own
	// bounds — the dirty rect cannot cover that.
	const referencedIds = collectExternallyReferencedIds(elementsMap);
	let dirty: BoundingBox | null = null;
	for (const id of closure) {
		if (filterPlans.has(id) || backdropIds.has(id)) return undefined;
		if (referencedIds.has(id)) return undefined;
		dirty = unionBoundingBoxes(dirty, state.previousWorldBoundsOf(id));
		dirty = unionBoundingBoxes(dirty, state.currentWorldBoundsOf(id));
	}
	if (!dirty) return undefined;
	let reach = 0;
	for (const id of changedIds) {
		const ancestorReach = filteredAncestorReach(
			id,
			elementsMap,
			filterPlans,
			backdropIds,
			state,
		);
		if (ancestorReach === undefined) return undefined;
		reach = Math.max(reach, ancestorReach);
	}
	// AA / hairline slack around the changed geometry (device px → world).
	return {
		bounds: expandBounds(dirty, reach + 8 / prebufZoom),
		inputReach: reach,
	};
}

/**
 * How far the filters of `id`'s enclosing groups spread a change of it,
 * summed over nested filtered groups, or undefined when an enclosing
 * container moves or reads its content in a way the dirty rect cannot
 * follow (a non-group container, a backdrop filter). Each group's chain is
 * bounded by its plan's margin once per filter, since chained filters
 * spread one after another.
 */
function filteredAncestorReach(
	id: string,
	elementsMap: ReadonlyMap<string, AnyArtObject>,
	filterPlans: ReadonlyMap<string, ElementFilterPlan>,
	backdropIds: ReadonlySet<string>,
	state: PartialRedrawState,
): number | undefined {
	let reach = 0;
	for (
		let ancestor = state.parentOf(id);
		ancestor !== undefined;
		ancestor = state.parentOf(ancestor)
	) {
		if (elementsMap.get(ancestor)?.type !== "group") return undefined;
		if (backdropIds.has(ancestor)) return undefined;
		const plan = filterPlans.get(ancestor);
		if (!plan) continue;
		const { bounds, textureBounds } = plan;
		const margin = Math.max(
			bounds.minX - textureBounds.minX,
			bounds.minY - textureBounds.minY,
			textureBounds.maxX - bounds.maxX,
			textureBounds.maxY - bounds.maxY,
			0,
		);
		reach += margin * Math.max(plan.postFilters.length, 1);
	}
	return reach;
}

/** Whole-texel offset from the current store to the captured one, or null
 *  when the two texel grids differ. */
function storeTexelOffset(
	captured: BoundingBox,
	capturedDensity: number,
	storeBox: BoundingBox,
	density: number,
): { x: number; y: number } | null {
	if (capturedDensity !== density) return null;
	const x = (storeBox.minX - captured.minX) * density;
	const y = (captured.maxY - storeBox.maxY) * density;
	const wholeX = Math.round(x);
	const wholeY = Math.round(y);
	if (Math.abs(x - wholeX) > 1e-3 || Math.abs(y - wholeY) > 1e-3) return null;
	return { x: wholeX, y: wholeY };
}

/** Bounding box of the part of `target` outside `covered`, or null when
 *  `covered` holds all of it. Strips thinner than `minExtent` are float
 *  error, not uncovered area. */
function uncoveredBounds(
	target: BoundingBox,
	covered: BoundingBox,
	minExtent: number,
): BoundingBox | null {
	const inner = boundsIntersectionBox(target, covered);
	if (!inner) return target;
	const strips: BoundingBox[] = [
		box(target.minX, target.minY, inner.minX, target.maxY),
		box(inner.maxX, target.minY, target.maxX, target.maxY),
		box(inner.minX, target.minY, inner.maxX, inner.minY),
		box(inner.minX, inner.maxY, inner.maxX, target.maxY),
	];
	let uncovered: BoundingBox | null = null;
	for (const strip of strips) {
		if (strip.width < minExtent || strip.height < minExtent) continue;
		uncovered = unionBoundingBoxes(uncovered, strip);
	}
	return uncovered;
}

/** World distance the redrawn region must reach past `region` so every
 *  backdrop read whose output lands inside it sees freshly drawn pixels. A
 *  read whose output lands in the
 *  widened region needs that region widened again (one backdrop element
 *  may sit under another), so the widening repeats until no new read
 *  touches it. */
function backdropGuard(
	region: BoundingBox,
	reads: readonly PartialRedrawBackdropRead[],
): number {
	const pending = new Set(reads);
	let guard = 0;
	for (let grew = true; grew; ) {
		grew = false;
		const reached = expandBounds(region, guard);
		for (const read of pending) {
			if (!boundsIntersectionBox(read.bounds, reached)) continue;
			guard += read.footprint;
			pending.delete(read);
			grew = true;
		}
	}
	return guard;
}

/** `changed` widened by every backdrop read whose output it affects: a read
 *  within its footprint of a changed pixel draws differently there, so that
 *  part of the read's bounds changed too. A widened region may reach further
 *  reads, so the widening repeats until no new read touches it. */
function spreadByBackdropReads(
	changed: BoundingBox,
	reads: readonly PartialRedrawBackdropRead[],
): BoundingBox {
	const pending = new Set(reads);
	let region = changed;
	for (let grew = true; grew; ) {
		grew = false;
		for (const read of pending) {
			const affected = boundsIntersectionBox(
				read.bounds,
				expandBounds(region, read.footprint),
			);
			if (!affected) continue;
			region = unionBoundingBoxes(region, affected)!;
			pending.delete(read);
			grew = true;
		}
	}
	return region;
}

/** `bounds` snapped to the store's texel grid, in store texels. An edge
 *  within float error of a texel boundary stays on it either way. */
function toStoreTexelRect(
	bounds: BoundingBox,
	storeBox: BoundingBox,
	prebufWidth: number,
	prebufHeight: number,
	prebufZoom: number,
	snap: "outward" | "inward",
): TexelRect | null {
	const eps = 1e-6;
	const lower = snap === "outward" ? Math.floor : Math.ceil;
	const upper = snap === "outward" ? Math.ceil : Math.floor;
	const toLower = (v: number) => lower(snap === "outward" ? v + eps : v - eps);
	const toUpper = (v: number) => upper(snap === "outward" ? v - eps : v + eps);
	const clampX = (v: number) => Math.min(Math.max(v, 0), prebufWidth);
	const clampY = (v: number) => Math.min(Math.max(v, 0), prebufHeight);
	const x0 = clampX(toLower((bounds.minX - storeBox.minX) * prebufZoom));
	const x1 = clampX(toUpper((bounds.maxX - storeBox.minX) * prebufZoom));
	const y0 = clampY(toLower((storeBox.maxY - bounds.maxY) * prebufZoom));
	const y1 = clampY(toUpper((storeBox.maxY - bounds.minY) * prebufZoom));
	if (x1 <= x0 || y1 <= y0) return null;
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function texelRectToWorld(
	rect: TexelRect,
	storeBox: BoundingBox,
	prebufZoom: number,
): BoundingBox {
	return box(
		storeBox.minX + rect.x / prebufZoom,
		storeBox.maxY - (rect.y + rect.height) / prebufZoom,
		storeBox.minX + (rect.x + rect.width) / prebufZoom,
		storeBox.maxY - rect.y / prebufZoom,
	);
}

/** `outer` minus `inner` (which it contains) as up to four rects. */
function subtractTexelRect(outer: TexelRect, inner: TexelRect): TexelRect[] {
	const innerRight = inner.x + inner.width;
	const innerBottom = inner.y + inner.height;
	const outerRight = outer.x + outer.width;
	const outerBottom = outer.y + outer.height;
	return [
		{ x: outer.x, y: outer.y, width: outer.width, height: inner.y - outer.y },
		{
			x: outer.x,
			y: innerBottom,
			width: outer.width,
			height: outerBottom - innerBottom,
		},
		{ x: outer.x, y: inner.y, width: inner.x - outer.x, height: inner.height },
		{
			x: innerRight,
			y: inner.y,
			width: outerRight - innerRight,
			height: inner.height,
		},
	].filter((r) => r.width > 0 && r.height > 0);
}

function intersectTexelRects(a: TexelRect, b: TexelRect): TexelRect | null {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	if (right <= x || bottom <= y) return null;
	return { x, y, width: right - x, height: bottom - y };
}

/** Union of two boxes when it is itself a rectangle, else null. */
function rectangularUnion(a: BoundingBox, b: BoundingBox): BoundingBox | null {
	const union = unionBoundingBoxes(a, b)!;
	const overlap = boundsIntersectionBox(a, b);
	const overlapArea = overlap ? overlap.width * overlap.height : 0;
	const coveredArea = a.width * a.height + b.width * b.height - overlapArea;
	return Math.abs(coveredArea - union.width * union.height) <=
		1e-6 * union.width * union.height
		? union
		: null;
}

function box(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): BoundingBox {
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
