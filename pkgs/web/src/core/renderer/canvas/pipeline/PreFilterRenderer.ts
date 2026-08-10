import { deepClone } from "../../../../utils/lang";
import type { CubicBezierSegment, Filter } from "../../../schema";
import { applyCornerRadius } from "../../generators/CornerRadiusProcessor";
import { type FilterRenderer, isGeometryFilter } from "./FilterRenderer";

/**
 * Every pre-rasterization step an element's geometry goes through, in order:
 * corner radius is realized into fillet geometry, then the element's geometry
 * filters deform the result.
 *
 * This is the single definition of that pipeline. The flat render and the 3D
 * solid outline both resolve geometry here, so they cannot disagree on what an
 * element's shape is — the two used to spell the same two calls out separately,
 * and fixing one left the other wrong.
 */
export function resolveElementGeometry(
	segments: CubicBezierSegment[],
	filters: Filter[] | undefined,
	filterRenderer: Pick<FilterRenderer, "getHandler">,
): CubicBezierSegment[] {
	return applyPreFilters(applyCornerRadius(segments), filters, filterRenderer);
}

export function applyPreFilters(
	segments: CubicBezierSegment[],
	filters: Filter[] | undefined,
	filterRenderer: Pick<FilterRenderer, "getHandler">,
): CubicBezierSegment[] {
	if (!filters || filters.length === 0) return segments;

	const preFilters = filters.filter((f) => isGeometryFilter(f, filterRenderer));
	if (preFilters.length === 0) return segments;

	let result = deepClone(segments) as CubicBezierSegment[];
	for (const filter of preFilters) {
		const plainFilter = deepClone(filter);
		const handler = filterRenderer.getHandler(filter.processor);
		if (handler?.preProcess) {
			result = handler.preProcess(result, plainFilter);
		}
	}

	return result;
}
