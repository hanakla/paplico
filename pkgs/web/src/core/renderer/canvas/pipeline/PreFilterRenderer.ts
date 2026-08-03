import { deepClone } from "../../../../utils/lang";
import type { CubicBezierSegment, Filter } from "../../../schema";
import { type FilterRenderer, isGeometryFilter } from "./FilterRenderer";

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
