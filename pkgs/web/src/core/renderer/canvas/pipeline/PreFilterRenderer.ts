import { deepClone } from "../../../../utils/lang";
import type { CubicBezierSegment, Filter } from "../../../schema";
import { applyCornerRadius } from "../../generators/CornerRadiusProcessor";
import {
	type AppearanceGeometry,
	type FilterHandler,
	type FilterRenderer,
	isGeometryFilter,
} from "./FilterRenderer";

/**
 * Every pre-rasterization step an element's geometry goes through, in order:
 * corner radius is realized into fillet geometry, then the element's geometry
 * filters deform the result.
 *
 * This is the single definition of that pipeline. The flat render and the 3D
 * solid outline both resolve geometry here, so they cannot disagree on what an
 * element's shape is.
 */
export function resolveElementGeometry(
	segments: CubicBezierSegment[],
	filters: Filter[] | undefined,
	filterRenderer: Pick<FilterRenderer, "getHandler">,
): CubicBezierSegment[] {
	return applyPreFilters(applyCornerRadius(segments), filters, filterRenderer);
}

/**
 * `resolveElementGeometry` for the appearances drawing one path: the same
 * pipeline, resolved once and shared until a filter draws differently per
 * appearance (`preProcessAppearance`), which may hand each appearance several
 * geometries — copies with their own stroke width or pattern transform —
 * that every later filter then runs on. Returns one list per appearance.
 */
export function resolveAppearanceGeometries(
	appearances: readonly NonNullable<AppearanceGeometry["appearance"]>[],
	segments: CubicBezierSegment[],
	filters: Filter[] | undefined,
	filterRenderer: Pick<FilterRenderer, "getHandler">,
): AppearanceGeometry[][] {
	const preFilters = (filters ?? []).filter((f) =>
		isGeometryFilter(f, filterRenderer),
	);
	// Untouched input stays shared by reference; only a deforming chain
	// works on a copy.
	const flat = applyCornerRadius(segments);
	const start = preFilters.length === 0 ? flat : deepClone(flat);
	let geometries: AppearanceGeometry[][] = appearances.map((appearance) => [
		{ appearance, segments: start },
	]);
	for (const filter of preFilters) {
		const handler = filterRenderer.getHandler(filter.processor)!;
		const plainFilter = deepClone(filter);
		if (handler.preProcessAppearance) {
			geometries = geometries.map((own) =>
				own.flatMap((geometry) => runPreFilter(handler, geometry, plainFilter)),
			);
			continue;
		}
		// Appearances still sharing one segment list share its deformation.
		const deformed = new Map<CubicBezierSegment[], AppearanceGeometry[]>();
		geometries = geometries.map((own) =>
			own.flatMap((geometry) => {
				let result = deformed.get(geometry.segments);
				if (!result) {
					result = runPreFilter(handler, geometry, plainFilter);
					deformed.set(geometry.segments, result);
				}
				// A plain deformation leaves the paint alone, so the requesting
				// geometry keeps its own appearance and pattern transform.
				return result.map((g) => ({
					...g,
					appearance: geometry.appearance,
					patternTransform: geometry.patternTransform,
				}));
			}),
		);
	}
	return geometries;
}

export function applyPreFilters(
	segments: CubicBezierSegment[],
	filters: Filter[] | undefined,
	filterRenderer: Pick<FilterRenderer, "getHandler">,
): CubicBezierSegment[] {
	if (!filters || filters.length === 0) return segments;
	const geometries = applyPreFiltersToGeometry(
		{ segments },
		filters,
		filterRenderer,
	);
	return geometries.length === 1
		? geometries[0].segments
		: geometries.flatMap((geometry) => geometry.segments);
}

/**
 * Run the geometry filters among `filters` over one geometry, keeping its
 * appearance so a filter can split it or rewrite the paint. Used for the
 * sub-filters an appearance carries below itself.
 */
export function applyPreFiltersToGeometry(
	geometry: AppearanceGeometry,
	filters: readonly Filter[],
	filterRenderer: Pick<FilterRenderer, "getHandler">,
): AppearanceGeometry[] {
	const preFilters = filters.filter((f) => isGeometryFilter(f, filterRenderer));
	if (preFilters.length === 0) return [geometry];
	let geometries: AppearanceGeometry[] = [
		{ ...geometry, segments: deepClone(geometry.segments) },
	];
	for (const filter of preFilters) {
		const handler = filterRenderer.getHandler(filter.processor)!;
		const plainFilter = deepClone(filter);
		geometries = geometries.flatMap((g) =>
			runPreFilter(handler, g, plainFilter),
		);
	}
	return geometries;
}

/** One geometry filter over one geometry, through whichever hook it has. */
function runPreFilter(
	handler: FilterHandler,
	geometry: AppearanceGeometry,
	plainFilter: Filter,
): AppearanceGeometry[] {
	if (handler.preProcessAppearance) {
		return handler.preProcessAppearance(geometry, plainFilter);
	}
	return [
		{
			...geometry,
			segments: handler.preProcess!(geometry.segments, plainFilter),
		},
	];
}
