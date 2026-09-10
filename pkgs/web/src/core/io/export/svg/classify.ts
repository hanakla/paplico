import { localAppearances } from "../../../document/appearancePresets";
import {
	type AnyArtObject,
	type BlendMode,
	colorToRawRGBA,
	type Document,
	type ElementTransform,
	type FillAppearance,
	type Filter,
	hasGroupAppearances,
	isFilterEnabled,
	isVisibleFill,
	type StrokeAppearance,
	type TextElement,
	type TextStyle,
} from "../../../schema";
import {
	boundsIntersect,
	calculateElementBounds,
} from "../../../utils/geometry/bounds";
import { composeTransforms } from "../../../utils/geometry/geometry";
import { uniformTransformScale } from "./pathData";
import { isSvgNativeFilter } from "./svgFilterPrimitives";

/**
 * How an element travels into the SVG output:
 * - "pure": serialized as-is into SVG markup
 * - "bake": vectorizable after geometry baking (text outline, boolean result,
 *   geometry filters, corner radius)
 * - "raster": must be rendered to a PNG chunk
 * - "skip": excluded from export entirely
 */
export type SvgElementClass = "pure" | "bake" | "raster" | "skip";

/** Renderer-derived predicates injected so this module stays a pure function. */
export interface ClassifyOptions {
	document: Document;
	/**
	 * Paths referenced as text axis bindings — the renderer never paints them
	 * in their own z-slot (their appearances render as an underlay of the
	 * bound text instead). Collect with {@link collectTextAxisPathIds}.
	 */
	textAxisPathIds: ReadonlySet<string>;
	/** classifyFilterHandler result for the filter's processor. */
	filterKind(filter: Filter): "geometry" | "raster" | null;
	/** True when the appearance replaces the element's own render (e.g. extrude3d). */
	filterReplacesElementRender(filter: Filter): boolean;
	/** True when the filter samples the backdrop (glass solids etc.). */
	filterNeedsBackdrop(filter: Filter): boolean;
}

/** Mirror of the renderer's per-frame text-axis-path collection. */
export function collectTextAxisPathIds(document: Document): Set<string> {
	const ids = new Set<string>();
	for (const obj of Object.values(document.objects)) {
		if (obj.type === "text" && obj.axisBinding) {
			ids.add(obj.axisBinding.pathObjectId);
		}
	}
	return ids;
}

export interface VectorItem {
	kind: "vector";
	elementId: string;
	class: "pure" | "bake";
}

/** A z-consecutive chunk of raster-only elements rendered into one PNG. */
export interface RasterRun {
	kind: "raster";
	/** Element ids in z order (bottom to top). */
	elementIds: string[];
	/** Non-normal blend of a singleton run, carried onto its <image>. */
	blendMode?: BlendMode;
}

export type LayerPlanItem = VectorItem | RasterRun;

/** Recursion guards threaded through nested classification walks. */
interface ClassifyVisitState {
	defs: Set<string>;
	masks: Set<string>;
}

export function classifyElement(
	element: AnyArtObject,
	opts: ClassifyOptions,
	ancestorTransform?: ElementTransform,
): SvgElementClass {
	return classifyElementInner(
		element,
		opts,
		{ defs: new Set(), masks: new Set() },
		ancestorTransform,
	);
}

function classifyElementInner(
	element: AnyArtObject,
	opts: ClassifyOptions,
	visited: ClassifyVisitState,
	ancestorTransform?: ElementTransform,
): SvgElementClass {
	if (element.visible === false) return "skip";
	if (element.type === "path" && opts.textAxisPathIds.has(element.id)) {
		// The renderer never paints an axis path in its own z-slot; its
		// appearances render as an underlay of the bound text (which the
		// text's classification accounts for).
		return "skip";
	}
	if (element.opacity <= 0) return "skip";
	if (element.type === "path" && element.isGuide) return "skip";
	if (element.type === "reference3d") {
		return element.includeInExport === true ? "raster" : "skip";
	}

	if (element.compositionMode === "alpha-lock") return "raster";

	const composed = ancestorTransform
		? composeTransforms(ancestorTransform, element.transform)
		: element.transform;

	// Mask content lives outside layers, so a raster-only mask element cannot
	// be chunk-rendered on its own — the masked owner falls back instead.
	// The visited set stops broken cyclic mask references from recursing.
	if (
		element.mask &&
		element.mask.enabled !== false &&
		!visited.masks.has(element.id)
	) {
		const nextVisited: ClassifyVisitState = {
			defs: visited.defs,
			masks: new Set(visited.masks).add(element.id),
		};
		for (const maskElementId of element.mask.elementIds) {
			const maskElement = opts.document.objects[maskElementId];
			if (!maskElement) continue;
			// Mask element transforms are owner-local.
			if (
				classifyElementInner(maskElement, opts, nextVisited, composed) ===
				"raster"
			) {
				return "raster";
			}
		}
	}

	let needsBake = false;
	for (const filter of localAppearances(element.filters)) {
		if (!isFilterEnabled(filter)) continue;

		if (filter.processor === "fill") {
			// An invisible fill contributes nothing — it must not drag the
			// element into rasterization (e.g. a leftover transparent free
			// gradient beside a clean solid fill).
			if (!isVisibleFill(filter as FillAppearance)) continue;
		} else if (filter.processor === "stroke") {
			if (!isVisibleStroke(filter as StrokeAppearance)) continue;
		}

		if (filter.applyToBackdrop) return "raster";
		if (opts.filterReplacesElementRender(filter)) return "raster";
		if (filter.subFilters?.some(isFilterEnabled)) return "raster";
		// Per-appearance blends composite against the element's other
		// appearances; SVG has no equivalent below the element level.
		// (?? guards documents that predate the blendMode backfill.)
		if ((filter.blendMode ?? "normal") !== "normal") return "raster";

		// Native SVG filter primitives are emitted as <filter> defs by the
		// serializer, so they never force rasterization on their own.
		if (isSvgNativeFilter(filter.processor)) continue;

		const kind = opts.filterKind(filter);
		if (kind === "raster") return "raster";
		if (kind === "geometry") {
			needsBake = true;
			continue;
		}

		if (filter.processor === "fill") {
			const fill = (filter as FillAppearance).paramData.params.fill;
			if (fill.type === "free" || fill.type === "mesh") return "raster";
			// A pattern tile whose content itself needs rasterization cannot be
			// chunk-rendered (def elements are unreachable from layer walkers),
			// so the pattern-filled element falls back to raster as a whole.
			if (
				fill.type === "pattern" &&
				!isPatternTileVectorizable(fill.defId, opts, visited)
			) {
				return "raster";
			}
		} else if (filter.processor === "stroke") {
			const params = (filter as StrokeAppearance).paramData.params;
			if (params.strokeColor.type !== "solid") return "raster";
			// A constant-width stroke scales with the transform in the renderer;
			// SVG strokes only take one width, so non-uniform/skewed transforms
			// cannot be represented.
			if (uniformTransformScale(composed) === null) return "raster";
			// No brushSettings = the renderer's constant-width geometric default.
			if (params.brushSettings) {
				const settings = params.brushSettings;
				if (settings.engine !== "geometric") return "raster";
				// Variable-width geometry (taper / size curves) has no SVG stroke
				// equivalent; outline extraction is out of scope for now.
				if ((settings.taperStart ?? 0) > 0 || (settings.taperEnd ?? 0) > 0) {
					return "raster";
				}
				if (settings.properties.size?.curves?.length) return "raster";
			}
		}
	}

	switch (element.type) {
		case "path": {
			if (element.eraseMasks?.length) return "raster";
			if (element.strokeWidths?.length) return "raster";
			const hasCorners = element.segments.some(
				(seg) => (seg.cornerRadius ?? 0) > 0,
			);
			return needsBake || hasCorners ? "bake" : "pure";
		}
		case "image":
			// Geometry filters deform the image quad into a perspective blit,
			// which SVG cannot express — same as explicit corner warps.
			return element.corners || needsBake ? "raster" : "pure";
		case "text": {
			// Geometry filters apply to the laid-out glyph outlines inside the
			// renderer; the outline exporter does not reproduce that yet.
			if (needsBake) return "raster";
			// The renderer composites fill/stroke APPEARANCES onto glyph paint
			// (TextElementRenderer.buildGlyphPaintFilters); the outline exporter
			// only reads run styles, so appearance-painted text must rasterize.
			if (hasVisiblePaintAppearances(element)) return "raster";
			// An axis path carrying appearances renders as an underlay of THIS
			// text (renderAxisAppearanceUnderlay) — even at axis opacity 0.
			// The serializer has no underlay path, so the pair rasterizes.
			if (element.axisBinding) {
				const axisPath =
					opts.document.objects[element.axisBinding.pathObjectId];
				if (
					localAppearances(axisPath?.filters).some(
						(f) =>
							isFilterEnabled(f) &&
							(f.processor === "fill" || f.processor === "stroke"),
					)
				) {
					return "raster";
				}
			}
			const paint = textPaintProfile(element);
			if (!paint.vectorizable) return "raster";
			// Glyph stroke widths cannot follow a non-uniform/skewed transform.
			if (paint.hasStroke && uniformTransformScale(composed) === null) {
				return "raster";
			}
			return "bake";
		}
		case "compound-path":
			return "bake";
		case "group": {
			if (hasGroupAppearances(element)) return "raster";
			// A geometry filter on a group deforms the children inside the
			// renderer; the serializer walks children untouched, so bake is
			// not possible here yet.
			if (needsBake) return "raster";
			if (element.clipPathId) {
				const clipSource = opts.document.objects[element.clipPathId];
				if (
					clipSource &&
					clipSource.type !== "path" &&
					clipSource.type !== "compound-path" &&
					clipSource.type !== "text"
				) {
					return "raster";
				}
			}
			return "pure";
		}
		default:
			// mesh / blend / repeat and any future kind: raster is the safe
			// fallback — a chunk render always reproduces the on-canvas look.
			return "raster";
	}
}

/**
 * Plan how one z-ordered id list (a layer's elementIds or a group's childIds)
 * maps to SVG output items. Consecutive raster elements merge into one
 * {@link RasterRun}; a non-normal-blend raster element becomes a singleton run
 * so its blend applies against real siblings instead of a transparent chunk.
 * A backdrop-dependent element (alpha-lock / applyToBackdrop) swallows the
 * items below it in the same list that its bounds overlap — only those can
 * feed its backdrop. Cross-layer backdrop references and relative stacking
 * among mutually-overlapping swallowed/kept items are known limitations.
 */
export function planLayerItems(
	elementIds: readonly string[],
	opts: ClassifyOptions,
	ancestorTransform?: ElementTransform,
): LayerPlanItem[] {
	let items: LayerPlanItem[] = [];
	let openRun: RasterRun | null = null;
	let elementsMap: Map<string, AnyArtObject> | null = null;

	const flush = () => {
		if (openRun) {
			items.push(openRun);
			openRun = null;
		}
	};

	for (const elementId of elementIds) {
		const element = opts.document.objects[elementId];
		if (!element) continue;
		const cls = classifyElement(element, opts, ancestorTransform);
		if (cls === "skip") continue;

		if (cls === "raster") {
			if (isBackdropDependent(element, opts)) {
				flush();
				elementsMap ??= new Map(Object.entries(opts.document.objects));
				const backdropBounds = calculateElementBounds(element, elementsMap);
				const swallowed: string[] = [];
				const kept: LayerPlanItem[] = [];
				for (const item of items) {
					const ids =
						item.kind === "vector" ? [item.elementId] : item.elementIds;
					const overlaps = ids.some((id) => {
						const el = opts.document.objects[id];
						if (!el) return false;
						const bounds = calculateElementBounds(el, elementsMap ?? undefined);
						return boundsIntersect(bounds, backdropBounds);
					});
					if (overlaps) swallowed.push(...ids);
					else kept.push(item);
				}
				items = kept;
				openRun = {
					kind: "raster",
					elementIds: [...swallowed, elementId],
					...(element.blendMode !== "normal"
						? { blendMode: element.blendMode }
						: {}),
				};
				continue;
			}
			if (element.blendMode !== "normal") {
				flush();
				items.push({
					kind: "raster",
					elementIds: [elementId],
					blendMode: element.blendMode,
				});
				continue;
			}
			// A blended run (from a backdrop swallow) must not absorb elements
			// stacked above it — start a fresh run instead.
			if (openRun?.blendMode) flush();
			openRun ??= { kind: "raster", elementIds: [] };
			openRun.elementIds.push(elementId);
			continue;
		}

		flush();
		items.push({ kind: "vector", elementId, class: cls });
	}

	flush();
	return items;
}

/**
 * Whether a stroke appearance produces any visible pixels: opaque enough,
 * non-transparent solid color (non-solid paints are treated as visible),
 * and a non-zero brush width. Shared with the serializer so classification
 * and output cannot disagree on what counts as visible.
 */
export function isVisibleStroke(appearance: StrokeAppearance): boolean {
	if ((appearance.opacity ?? 1) <= 0) return false;
	const params = appearance.paramData.params;
	if (
		params.strokeColor.type === "solid" &&
		colorToRawRGBA(params.strokeColor.color).a <= 0
	) {
		return false;
	}
	if (!params.brushSettings) return true;
	return (params.brushSettings.properties.size?.base ?? 1) > 0;
}

/** True when element-level fill/stroke appearances would paint the glyphs. */
function hasVisiblePaintAppearances(element: TextElement): boolean {
	return localAppearances(element.filters).some(
		(f) =>
			isFilterEnabled(f) &&
			((f.processor === "fill" && isVisibleFill(f as FillAppearance)) ||
				(f.processor === "stroke" && isVisibleStroke(f as StrokeAppearance))),
	);
}

function textPaintProfile(element: TextElement): {
	vectorizable: boolean;
	hasStroke: boolean;
} {
	const styles: TextStyle[] = [element.defaultStyle];
	for (const paragraph of element.content.paragraphs) {
		for (const run of paragraph.runs) {
			if (run.style) styles.push(run.style);
		}
	}
	let hasStroke = false;
	const vectorizable = styles.every((style) => {
		const fillOk =
			!style.fill ||
			style.fill.type === "solid" ||
			style.fill.type === "linear" ||
			style.fill.type === "radial";
		if (style.stroke) hasStroke = true;
		const strokeOk = !style.stroke || style.stroke.type === "solid";
		return fillOk && strokeOk;
	});
	return { vectorizable, hasStroke };
}

function isPatternTileVectorizable(
	defId: string | null,
	opts: ClassifyOptions,
	visited: ClassifyVisitState,
): boolean {
	if (!defId) return true;
	// Cyclic def references are broken data; stop instead of recursing.
	if (visited.defs.has(defId)) return true;
	const def = opts.document.defs?.[defId];
	if (!def) return true;

	const nextVisited: ClassifyVisitState = {
		defs: new Set(visited.defs).add(defId),
		masks: visited.masks,
	};
	return def.rootElementIds.every((id) => {
		const element = opts.document.objects[id];
		if (!element) return true;
		return classifyElementInner(element, opts, nextVisited) !== "raster";
	});
}

function isBackdropDependent(
	element: AnyArtObject,
	opts: ClassifyOptions,
): boolean {
	if (element.compositionMode === "alpha-lock") return true;
	return (
		localAppearances(element.filters).some(
			(f) =>
				isFilterEnabled(f) &&
				(f.applyToBackdrop === true || opts.filterNeedsBackdrop(f)),
		) ?? false
	);
}
