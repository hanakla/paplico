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
import { groupRingsByContainment } from "../../utils/geometry/ringContainment";
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

/**
 * Re-wind a disjoint contour set so holes wind against their solids.
 *
 * bezierBool does not encode solid-vs-hole in the winding it returns — two
 * rectangles come back with the counter reversed, the same shapes drawn with
 * curves come back both the same way — while everything downstream reads
 * exactly that: the non-zero fill and buildExtrudeMesh's dominant-winding rule.
 * The contours are disjoint by this point, so containment is unambiguous and
 * settles it.
 */
function normalizeWinding(contours: Segment[][]): Segment[][] {
	if (contours.length < 2) return contours;

	const holes = new Set<number>();
	for (const group of groupRingsByContainment(contours.map(contourRing))) {
		for (const index of group.slice(1)) holes.add(index);
	}
	if (holes.size === 0) return contours;

	const areas = contours.map(signedContourArea);
	// Solids keep the direction most of their own area already has, so a result
	// that was already consistent comes back untouched.
	const solidTotal = areas.reduce(
		(sum, area, i) => (holes.has(i) ? sum : sum + area),
		0,
	);
	const solidSign = solidTotal >= 0 ? 1 : -1;
	return contours.map((contour, i) => {
		const wanted = holes.has(i) ? -solidSign : solidSign;
		return Math.sign(areas[i]) === wanted ? contour : reverseContour(contour);
	});
}

/**
 * A contour's polygon approximation. Curve segments contribute interior samples
 * as well as their anchor: chaining bare anchors chords every curve, and a chord
 * cuts inside a bulging outline far enough that a counter hugging that outline
 * reads as outside it.
 */
function contourRing(contour: Segment[]): [number, number][] {
	return contour.flatMap((seg) =>
		seg instanceof SegmentCurve
			? [seg.start(), seg.point(1 / 3), seg.point(2 / 3)]
			: [seg.start()],
	);
}

function reverseContour(contour: Segment[]): Segment[] {
	return [...contour]
		.reverse()
		.map((seg) =>
			seg instanceof SegmentCurve
				? new SegmentCurve(seg.p3, seg.p2, seg.p1, seg.p0, defaultGeo)
				: new SegmentLine(
						(seg as SegmentLine).p1,
						(seg as SegmentLine).p0,
						defaultGeo,
					),
		);
}

/** Signed area of a contour's anchor polygon; the sign carries the winding. */
function signedContourArea(contour: Segment[]): number {
	let sum = 0;
	for (const seg of contour) {
		const [x1, y1] = seg.start();
		const [x2, y2] = seg.end();
		sum += x1 * y2 - x2 * y1;
	}
	return sum / 2;
}

const defaultGeo = new GeometryEpsilon();

function cubicSegmentsToContour(subPath: CubicBezierSegment[]): Segment[] {
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

function contourToCubicSegments(contour: Segment[]): CubicBezierSegment[] {
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
