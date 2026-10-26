import type {
	AnyArtObject,
	CompoundPath,
	CubicBezierSegment,
	Path,
} from "../../schema";
import {
	bakeCompoundPathSegments,
	resolveCompoundBoolean,
} from "../../utils/geometry/generate/compoundBake";
import type { FilterCapabilityLookup } from "./filterCapabilities";
import { toCompoundSourceWorldPath } from "./preFilters";

/**
 * Boolean results of compound paths for the renderer and the spatial index.
 * Results are remembered by the memo behind resolveCompoundBoolean, which the
 * bounds code shares, so a compound is combined once whichever asks first.
 */
export class CompoundPathCache {
	public resolve(
		compoundPath: CompoundPath,
		pathMap: Map<string, Path>,
	): CubicBezierSegment[] {
		return resolveCompoundBoolean(compoundPath, pathMap);
	}

	/** Boolean result of the sources that resolve to a path, as they are drawn. */
	public resolveDrawn(
		compoundPath: CompoundPath,
		resolveElement: (id: string) => AnyArtObject | undefined,
		filterRenderer: FilterCapabilityLookup,
	): CubicBezierSegment[] {
		return bakeCompoundPathSegments(compoundPath, resolveElement, (path) =>
			toCompoundSourceWorldPath(path, filterRenderer),
		);
	}
}
