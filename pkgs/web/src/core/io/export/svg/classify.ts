import { resolveBrushRenderRoute } from "../../../brush/renderRoute";
import {
	type AnyArtObject,
	type BlendMode,
	type Document,
	type FillAppearance,
	type Filter,
	hasGroupAppearances,
	isFilterEnabled,
	type StrokeAppearance,
	type TextElement,
	type TextStyle,
} from "../../../schema";

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
	/** classifyFilterHandler result for the filter's processor. */
	filterKind(filter: Filter): "geometry" | "raster" | null;
	/** True when the appearance replaces the element's own render (e.g. extrude3d). */
	filterReplacesElementRender(filter: Filter): boolean;
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

export function classifyElement(
	element: AnyArtObject,
	opts: ClassifyOptions,
): SvgElementClass {
	return classifyElementInner(element, opts, new Set());
}

function classifyElementInner(
	element: AnyArtObject,
	opts: ClassifyOptions,
	visitedDefs: Set<string>,
): SvgElementClass {
	if (element.visible === false) return "skip";
	if (element.opacity <= 0) return "skip";
	if (element.type === "path" && element.isGuide) return "skip";
	if (element.type === "reference3d") {
		return element.includeInExport === true ? "raster" : "skip";
	}

	if (element.compositionMode === "alpha-lock") return "raster";

	// Mask content lives outside layers, so a raster-only mask element cannot
	// be chunk-rendered on its own — the masked owner falls back instead.
	if (element.mask && element.mask.enabled !== false) {
		for (const maskElementId of element.mask.elementIds) {
			const maskElement = opts.document.objects[maskElementId];
			if (!maskElement) continue;
			if (classifyElementInner(maskElement, opts, visitedDefs) === "raster") {
				return "raster";
			}
		}
	}

	let needsBake = false;
	for (const filter of element.filters ?? []) {
		if (!isFilterEnabled(filter)) continue;
		if (filter.applyToBackdrop) return "raster";
		if (opts.filterReplacesElementRender(filter)) return "raster";
		if (filter.subFilters?.some(isFilterEnabled)) return "raster";
		// Per-appearance blends composite against the element's other
		// appearances; SVG has no equivalent below the element level.
		if (filter.blendMode !== "normal") return "raster";

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
				!isPatternTileVectorizable(fill.defId, opts, visitedDefs)
			) {
				return "raster";
			}
		} else if (filter.processor === "stroke") {
			const params = (filter as StrokeAppearance).paramData.params;
			if (params.strokeColor.type !== "solid") return "raster";
			// No brushSettings = the renderer's constant-width geometric default.
			if (params.brushSettings) {
				const route = resolveBrushRenderRoute(params.brushSettings);
				if (route.kind !== "geometric") return "raster";
				const settings = route.settings;
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
			return element.corners ? "raster" : needsBake ? "bake" : "pure";
		case "text":
			return hasVectorizableTextPaint(element) ? "bake" : "raster";
		case "compound-path":
			return "bake";
		case "group": {
			if (hasGroupAppearances(element)) return "raster";
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
			return needsBake ? "bake" : "pure";
		}
		case "mesh":
		case "blend":
		case "repeat":
			return "raster";
		default:
			return "raster";
	}
}

/**
 * Plan how one z-ordered id list (a layer's elementIds or a group's childIds)
 * maps to SVG output items. Consecutive raster elements merge into one
 * {@link RasterRun}; a non-normal-blend raster element becomes a singleton run
 * so its blend applies against real siblings instead of a transparent chunk.
 * A backdrop-dependent element (alpha-lock / applyToBackdrop) swallows every
 * item below it in the same list — cross-layer backdrop references are a known
 * limitation and are not reproduced.
 */
export function planLayerItems(
	elementIds: readonly string[],
	opts: ClassifyOptions,
): LayerPlanItem[] {
	const items: LayerPlanItem[] = [];
	let openRun: RasterRun | null = null;

	const flush = () => {
		if (openRun) {
			items.push(openRun);
			openRun = null;
		}
	};

	for (const elementId of elementIds) {
		const element = opts.document.objects[elementId];
		if (!element) continue;
		const cls = classifyElement(element, opts);
		if (cls === "skip") continue;

		if (cls === "raster") {
			if (isBackdropDependent(element)) {
				flush();
				const swallowed = items.flatMap((item) =>
					item.kind === "vector" ? [item.elementId] : item.elementIds,
				);
				items.length = 0;
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

function hasVectorizableTextPaint(element: TextElement): boolean {
	const styles: TextStyle[] = [element.defaultStyle];
	for (const paragraph of element.content.paragraphs) {
		for (const run of paragraph.runs) {
			if (run.style) styles.push(run.style);
		}
	}
	return styles.every((style) => {
		const fillOk =
			!style.fill ||
			style.fill.type === "solid" ||
			style.fill.type === "linear" ||
			style.fill.type === "radial";
		const strokeOk = !style.stroke || style.stroke.type === "solid";
		return fillOk && strokeOk;
	});
}

function isPatternTileVectorizable(
	defId: string | null,
	opts: ClassifyOptions,
	visitedDefs: Set<string>,
): boolean {
	if (!defId) return true;
	// Cyclic def references are broken data; stop instead of recursing.
	if (visitedDefs.has(defId)) return true;
	const def = opts.document.defs?.[defId];
	if (!def) return true;

	const nextVisited = new Set(visitedDefs).add(defId);
	return def.rootElementIds.every((id) => {
		const element = opts.document.objects[id];
		if (!element) return true;
		return classifyElementInner(element, opts, nextVisited) !== "raster";
	});
}

function isBackdropDependent(element: AnyArtObject): boolean {
	if (element.compositionMode === "alpha-lock") return true;
	return (
		element.filters?.some(
			(f) => isFilterEnabled(f) && f.applyToBackdrop === true,
		) ?? false
	);
}
