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
	GeometryEpsilon,
	type Segment,
	SegmentCurve,
	SegmentLine,
} from "../../utils/geometry/bezierBool";
import { hashSegments, resolveSegment } from "../../utils/geometry/segmentOps";
import { splitIntoSubPaths } from "../canvas/CanvasLayer.helpers";
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
		const contour = cubicSegmentsToContour(sub);
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
		const opMap: Record<string, BooleanOp> = {
			union: "union",
			intersection: "intersect",
			difference: "difference",
			xor: "xor",
		};
		const op = opMap[mode] ?? "union";

		// Accumulate: fold each contour into the result via the boolean operation.
		// booleanOp treats each argument as a separate polygon (with selfIntersection=false).
		resultContours = [closedContours[0]];
		for (let i = 1; i < closedContours.length; i++) {
			resultContours = booleanOp(resultContours, [closedContours[i]], op);
			if (resultContours.length === 0) break;
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

const defaultGeo = new GeometryEpsilon();

export function cubicSegmentsToContour(
	subPath: CubicBezierSegment[],
): Segment[] {
	const contour: Segment[] = [];
	const geo = defaultGeo;

	for (let i = 0; i < subPath.length; i++) {
		const seg = subPath[i];
		const prevEnd = i > 0 ? subPath[i - 1].end : undefined;
		const resolved = resolveSegment(seg, prevEnd);

		const p0: [number, number] = [resolved.start.x, resolved.start.y];
		const cp1: [number, number] = [resolved.cp1.x, resolved.cp1.y];
		const cp2: [number, number] = [resolved.cp2.x, resolved.cp2.y];
		const p3: [number, number] = [resolved.end.x, resolved.end.y];

		// Check if this is effectively a line (all control points collinear)
		const isLine =
			Math.abs(
				(cp1[0] - p0[0]) * (p3[1] - p0[1]) - (cp1[1] - p0[1]) * (p3[0] - p0[0]),
			) < 0.01 &&
			Math.abs(
				(cp2[0] - p0[0]) * (p3[1] - p0[1]) - (cp2[1] - p0[1]) * (p3[0] - p0[0]),
			) < 0.01;

		if (isLine) {
			contour.push(new SegmentLine(p0, p3, geo));
		} else {
			contour.push(new SegmentCurve(p0, cp1, cp2, p3, geo));
		}
	}

	// Boolean operands must be closed regions: bridge the endpoints of open
	// subpaths with a line (implicit close)
	if (contour.length > 0) {
		const first = contour[0].start();
		const last = contour[contour.length - 1].end();
		if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 1e-6) {
			contour.push(
				new SegmentLine([last[0], last[1]], [first[0], first[1]], geo),
			);
		}
	}

	return contour;
}

export function contourToCubicSegments(
	contour: Segment[],
): CubicBezierSegment[] {
	const result: CubicBezierSegment[] = [];

	// Filter out zero-length segments produced by boolean operations
	const filtered = contour.filter((seg) => {
		const s = seg.start();
		const e = seg.end();
		return Math.hypot(e[0] - s[0], e[1] - s[1]) > 1e-6;
	});

	for (let i = 0; i < filtered.length; i++) {
		const seg = filtered[i];
		const isFirst = i === 0;
		const isLast = i === filtered.length - 1;

		const startPt = seg.start();
		const endPt = seg.end();

		let cp1: { x: number; y: number; pressure?: number };
		let cp2: { x: number; y: number; pressure?: number };

		if (seg instanceof SegmentCurve) {
			// Relative control points
			cp1 = { x: seg.p1[0] - startPt[0], y: seg.p1[1] - startPt[1] };
			cp2 = { x: seg.p2[0] - endPt[0], y: seg.p2[1] - endPt[1] };
		} else {
			// Line: place control points at 1/3 and 2/3 along the segment
			// so that the cubic bezier derivative is non-zero (avoids degenerate
			// tangent at endpoints which breaks curveNormal in PathOffset).
			const dx = endPt[0] - startPt[0];
			const dy = endPt[1] - startPt[1];
			cp1 = { x: dx / 3, y: dy / 3 };
			cp2 = { x: -dx / 3, y: -dy / 3 };
		}

		const cubicSeg: CubicBezierSegment = {
			cp1,
			cp2,
			end: { x: endPt[0], y: endPt[1], pressure: 1 },
			startPressure: 1,
			endPressure: 1,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: isFirst,
			isClosed: isLast ? true : undefined,
		};

		if (isFirst) {
			cubicSeg.start = {
				x: startPt[0],
				y: startPt[1],
				pressure: 1,
			};
		}

		result.push(cubicSeg);
	}

	return result;
}
