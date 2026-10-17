import type { CubicBezierSegment, Filter } from "../../schema";
import {
	type FillAppearance,
	type FilterEntry,
	isFilterEnabled,
	type PathGeometry,
	type StrokeAppearance,
} from "../../schema";
import type { Affine2D } from "../../utils/geometry/space/affine";
import { localAppearances } from "../appearancePresets";

/**
 * What document-side code needs to know about a filter implementation: how it
 * reshapes geometry, whether it rasterizes, and where it may be placed. The
 * renderer's filter handlers implement it.
 */
export interface FilterCapabilities {
	/** Pre-filter: transform geometry before rendering. */
	preProcess?(
		segments: CubicBezierSegment[],
		filter: Filter,
	): CubicBezierSegment[];

	/** Pre-filter that changes the appearance it outputs — a copy-placing
	 *  transform that scales the copies' stroke widths or carries pattern
	 *  paints along. One geometry in, the geometries to draw out; with
	 *  no appearance on the input it returns the whole deformed shape. */
	preProcessAppearance?(
		geometry: AppearanceGeometry,
		filter: Filter,
	): AppearanceGeometry[];

	/** True when this appearance fully replaces the element's own flat
	 *  fill/stroke rendering — the filter system renders the element instead,
	 *  so the flat geometry pass must draw nothing for it (e.g. extrude3d). */
	replacesElementRender?(filter: Filter): boolean;

	/** Post-filter that processes the rasterized element. Document code only
	 *  checks whether it exists. */
	postProcess?(...args: never[]): unknown;

	/** Whether the filter may sit under a fill or stroke as a sub-filter.
	 *  Omitted = it may. */
	readonly usableAsSubFilter?: boolean;
}

/** Looks up the implementation registered for a filter processor. */
export interface FilterCapabilityLookup {
	getHandler(processor: string): FilterCapabilities | undefined;
}

/** Whether a processor may sit under a fill or stroke as a sub-filter. A
 *  processor with no registered handler would do nothing there, so it may not. */
export function isUsableAsSubFilter(
	lookup: FilterCapabilityLookup,
	processor: string,
): boolean {
	const handler = lookup.getHandler(processor);
	return !!handler && handler.usableAsSubFilter !== false;
}

/**
 * Geometry on its way through the pre-filters, with what its paint has to
 * follow: the appearance drawing it (a filter may hand back a rewritten one,
 * e.g. a scaled stroke width) and the local affine a pattern paint samples
 * through (unset = as authored). `appearance` is absent when only the shape
 * is wanted — bounds, export, outlines — and a filter then returns one
 * geometry holding everything it would draw.
 */
export interface AppearanceGeometry {
	appearance?: FillAppearance | StrokeAppearance;
	path: PathGeometry;
	patternTransform?: Affine2D;
}

/** Whether the appearance's paint is a pattern, which follows a copy's
 *  placement through `AppearanceGeometry.patternTransform`. */
export function appearancePaintsPattern(
	appearance: AppearanceGeometry["appearance"],
): boolean {
	if (!appearance) return false;
	if (appearance.processor === "fill") {
		return appearance.paramData.params.fill?.type === "pattern";
	}
	return appearance.paramData.params.strokeColor?.type === "stroke-pattern";
}

/**
 * What a handler does to the element it is attached to. Routing, occlusion and
 * bounds decisions must classify through this instead of probing
 * `handler.preProcess` / `handler.postProcess` directly: those probes are
 * where "does this appearance deform its geometry?" and "does this appearance
 * have any sub-filter at all?" quietly drift apart.
 */
type FilterKind = "geometry" | "raster";

/** Classify a handler, or null when it has no handler / does neither. */
export function classifyFilterHandler(
	handler: FilterCapabilities | undefined,
): FilterKind | null {
	if (handler?.preProcess || handler?.preProcessAppearance) return "geometry";
	if (handler?.postProcess) return "raster";
	return null;
}

/** True when this enabled filter deforms geometry before rasterization. */
export function isGeometryFilter(
	filter: Filter,
	filterRenderer: FilterCapabilityLookup,
): boolean {
	return (
		isFilterEnabled(filter) &&
		classifyFilterHandler(filterRenderer.getHandler(filter.processor)) ===
			"geometry"
	);
}

/**
 * Whether the element's own flat fill/stroke render is fully replaced by an
 * enabled appearance (the filter system renders the element instead — e.g.
 * extrude3d). Lets the renderer suppress the flat geometry pass without
 * naming any specific processor.
 */
export function isElementRenderReplaced(
	element: { filters?: readonly FilterEntry[] | null },
	filterRenderer: FilterCapabilityLookup,
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
