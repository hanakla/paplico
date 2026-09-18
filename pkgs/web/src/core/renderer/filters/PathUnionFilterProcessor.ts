/**
 * Path Union Pre-Filter Processor
 * Applies bezier-native boolean operations (union/intersection/difference/xor)
 * on overlapping closed subpaths.
 *
 * Uses a sweep-line algorithm ported from polybool that operates directly
 * on cubic bezier curves, preserving curve geometry instead of polygon
 * approximation.
 */

import type { Appearance, CubicBezierSegment, Filter } from "../../schema";
import {
	type BooleanOp,
	booleanOp,
	contourToCubicSegments,
	cubicSegmentsToContour,
	GeometryEpsilon,
	normalizeWinding,
	type Segment,
	signedContourArea,
} from "../../utils/geometry/bezierBool";
import {
	hashSegments,
	splitIntoSubPaths,
} from "../../utils/geometry/segmentOps";
import type { FilterHandler } from "../canvas/pipeline/FilterRenderer";

export interface PathUnionParams {
	mode: "union" | "intersection" | "difference" | "xor";
}

export interface PathUnionFilter extends Appearance<PathUnionParams> {
	processor: "path-union";
}

/** Result-memo capacity. The sweep-line boolean op costs multiple ms per call
 *  and runs every frame from three render paths (glass outline, opaque
 *  outline, albedo bake) — a small LRU turns those into hash lookups. */
const RESULT_CACHE_LIMIT = 32;

export class PathUnionFilterHandler implements FilterHandler {
	/** Memoized boolean-op results keyed by input-geometry hash + mode
	 *  (content-hash self-validation, the same idiom the extrude mesh cache
	 *  uses with this hash). Insertion-ordered; oldest evicted past the cap. */
	private readonly resultCache = new Map<string, CubicBezierSegment[]>();

	public async initialize(
		_device: GPUDevice,
		_canvasFormat: GPUTextureFormat,
	): Promise<void> {
		/* no-op: Pre-filter does not use GPU pipelines */
	}

	public preProcess(
		segments: CubicBezierSegment[],
		filter: Filter,
	): CubicBezierSegment[] {
		const mode = (filter.paramData.params as { mode?: string }).mode ?? "union";
		// Keyed by content, not filter uid — a blend calls one filter uid with
		// each instance's segments in turn, which would thrash a per-uid slot.
		const key = `${hashSegments(segments)}:${segments.length}:${mode}`;
		const cached = this.resultCache.get(key);
		if (cached) {
			// Refresh recency, and hand out a copy so callers can't mutate the
			// cached array in place.
			this.resultCache.delete(key);
			this.resultCache.set(key, cached);
			return [...cached];
		}
		const result = applyPathBoolFilter(
			segments,
			mode as "union" | "intersection" | "difference" | "xor",
		);
		// No-op passthrough (single subpath, too few closed contours, boolean-op
		// failure): keep the reference-identity contract and memoize nothing —
		// there is no computed result to save, and a failure should retry.
		if (result === segments) return segments;
		this.resultCache.set(key, result);
		if (this.resultCache.size > RESULT_CACHE_LIMIT) {
			const oldest = this.resultCache.keys().next().value;
			if (oldest !== undefined) this.resultCache.delete(oldest);
		}
		return [...result];
	}

	public onScaleFilter(params: Filter, _scale: [number, number]): Filter {
		return params;
	}

	public getExpansionMargin(_filter: Filter): number {
		return 0;
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as { mode?: string };
		const b = paramsB as { mode?: string };
		return { mode: t < 0.5 ? a.mode : b.mode };
	}
}

function applyPathBoolFilter(
	segments: CubicBezierSegment[],
	mode: "union" | "intersection" | "difference" | "xor",
): CubicBezierSegment[] {
	if (segments.length === 0) return segments;

	const subPaths = splitIntoSubPaths(segments);
	if (subPaths.length <= 1) return segments;

	// Boolean ops need closed regions; open subpaths are implicitly closed
	// (Illustrator's pathfinder does the same) instead of being passed through
	const closedContours: Segment[][] = [];
	for (const sub of subPaths) {
		const contour = cubicSegmentsToContour(sub, defaultGeo);
		if (contour.length > 0) {
			closedContours.push(contour);
		}
	}

	if (mode === "difference") {
		if (closedContours.length < 2) return segments;
	} else {
		if (closedContours.length <= 1) return segments;
	}

	let resultContours: Segment[][];
	try {
		if (mode === "union") {
			resultContours = uniteSubPaths(closedContours);
		} else {
			// The other modes are operations BETWEEN sub-paths (first minus the
			// rest, the common area, the exclusive area), so each contour stays its
			// own operand and folds into the running result.
			const opMap: Record<string, BooleanOp> = {
				intersection: "intersect",
				difference: "difference",
				xor: "xor",
			};
			const op = opMap[mode] ?? "union";
			resultContours = [closedContours[0]];
			for (let i = 1; i < closedContours.length; i++) {
				resultContours = booleanOp(resultContours, [closedContours[i]], op);
				if (resultContours.length === 0) break;
			}
		}
	} catch {
		return segments;
	}

	// Valid empty result (e.g. intersection of disjoint subpaths)
	if (resultContours.length === 0) {
		return [];
	}

	const output: CubicBezierSegment[] = [];

	// Convert result contours back to CubicBezierSegments
	for (const contour of resultContours) {
		const segs = contourToCubicSegments(contour);
		if (segs.length > 0) {
			output.push(...segs);
		}
	}

	return output;
}

/**
 * Unite a path's sub-paths into one shape.
 *
 * The sub-paths of a single path already describe one region under the
 * non-zero rule the renderer fills with: a sub-path wound with the majority
 * adds area, one wound against it removes area. So union merges the former and
 * subtracts the latter. Treating every sub-path as another shape to absorb
 * fills a glyph's counters shut, which is the bug this shape exists to avoid.
 *
 * Winding decides it, not geometric containment — the same rule buildExtrudeMesh
 * applies downstream, so the flat render and the 3D solid agree. Containment
 * would have to be decided from a polygon approximation of a curved outline,
 * and any approximation drops counters that hug their outline.
 */
function uniteSubPaths(contours: Segment[][]): Segment[][] {
	const areas = contours.map(signedContourArea);
	const total = areas.reduce((sum, area) => sum + area, 0);
	const dominant = total >= 0 ? 1 : -1;
	const solids = contours.filter((_, i) => areas[i] * dominant > 0);
	const holes = contours.filter((_, i) => areas[i] * dominant <= 0);
	if (solids.length === 0) return contours;

	let result = [solids[0]];
	for (let i = 1; i < solids.length; i++) {
		result = booleanOp(result, [solids[i]], "union");
		if (result.length === 0) return result;
	}
	for (const hole of holes) {
		result = booleanOp(result, [hole], "difference");
		if (result.length === 0) return result;
	}
	return normalizeWinding(result);
}

const defaultGeo = new GeometryEpsilon();
