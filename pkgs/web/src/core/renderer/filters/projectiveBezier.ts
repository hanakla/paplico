/**
 * Shared geometry core for non-linear (projective) pre-filters.
 *
 * A projective point map — perspective 3D rotation (Rotate3DFilterProcessor) or
 * a full homography (perspectiveWarp.ts, used by the free-transform vertex
 * bake in PaplicoCommands) — bends straight cubic
 * segments, so the segment must be adaptively subdivided (De Casteljau at
 * t=0.5) until the projected curve is within tolerance, then each leaf is
 * projected and re-emitted. This module owns that subdivision/emit machinery;
 * callers supply only the point-projection function `project(x, y)` and an
 * optional extra subdivision predicate (e.g. Rotate3D's rotated-z variance).
 */

import type { BezierPoint, CubicBezierSegment } from "../../schema";
import {
	getStartAnchor,
	resolveCP1,
	resolveCP2,
} from "../../utils/geometry/segmentOps";
import { splitIntoSubPaths } from "../canvas/CanvasLayer.helpers";

export interface Point {
	x: number;
	y: number;
}

/** Projects a source-space point to its deformed position. */
type ProjectFn = (x: number, y: number) => Point;

/**
 * Extra "keep subdividing" test evaluated on the four *source* control points,
 * on top of the projected-midpoint error. Rotate3D uses it for rotated-z
 * variance; a plain homography needs none. Returns true to force a split.
 */
type ExtraSubdivideFn = (p0: Point, p1: Point, p2: Point, p3: Point) => boolean;

const MAX_SUBDIVISION_DEPTH = 8;

interface ProjectedLeaf {
	points: [Point, Point, Point, Point];
	tStart: number;
	tEnd: number;
}

/** Produces the projected leaves (output cubics) for one source cubic. */
type LeafGenerator = (
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	out: ProjectedLeaf[],
) => void;

/**
 * Project every segment through `project`, adaptively subdividing so curves
 * stay smooth under the non-linear map. Sub-path structure, isMoved/isClosed
 * flags and per-point pressure/tilt are preserved (interpolated across splits).
 *
 * Every subdivision leaf becomes an output segment, so strong projections can
 * multiply the vertex count — fine for render-time deformation (Rotate3D),
 * where nothing is persisted. For baking into document geometry use
 * {@link fitSegmentsWithProjection}.
 */
export function transformSegmentsWithProjection(
	segments: CubicBezierSegment[],
	project: ProjectFn,
	projectionErrorThreshold: number,
	shouldSubdivideExtra?: ExtraSubdivideFn,
): CubicBezierSegment[] {
	return mapSubPaths(segments, (p0, p1, p2, p3, out) =>
		adaptiveSubdivideAndProject(
			p0,
			p1,
			p2,
			p3,
			project,
			projectionErrorThreshold,
			shouldSubdivideExtra,
			0,
			1,
			0,
			out,
		),
	);
}

/**
 * Project every segment through `project`, approximating each projected curve
 * with a single cubic whose control points are re-fitted (interpolation through
 * the exact projections of B(1/3) and B(2/3)); a segment is split only when
 * the fit's error exceeds the tolerance. A projected straight edge is nearly
 * cubic, so warping a rectangle keeps its 4 segments instead of exploding into
 * subdivision leaves — this is the variant for baking into document geometry.
 */
export function fitSegmentsWithProjection(
	segments: CubicBezierSegment[],
	project: ProjectFn,
	projectionErrorThreshold: number,
): CubicBezierSegment[] {
	return mapSubPaths(segments, (p0, p1, p2, p3, out) =>
		adaptiveFitAndProject(
			p0,
			p1,
			p2,
			p3,
			project,
			projectionErrorThreshold,
			0,
			1,
			0,
			out,
		),
	);
}

/** Run a leaf generator over every sub-path, re-emitting segments/metadata. */
function mapSubPaths(
	segments: CubicBezierSegment[],
	generateLeaves: LeafGenerator,
): CubicBezierSegment[] {
	const subPaths = splitIntoSubPaths(segments);
	const result: CubicBezierSegment[] = [];

	for (const sub of subPaths) {
		const processed = processSubPath(sub, generateLeaves);
		if (processed.length === 0) continue;
		// First piece of a sub-path must carry isMoved=true so the renderer
		// treats it as a new sub-path.
		result.push({ ...processed[0], isMoved: true });
		for (let i = 1; i < processed.length; i++) {
			result.push(processed[i]);
		}
	}

	return result;
}

/** Visit every anchor/control point of a segment list (absolute coords). */
export function visitSegmentPoints(
	segments: CubicBezierSegment[],
	visit: (point: Point) => void,
): void {
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const prevEnd = i > 0 ? segments[i - 1].end : undefined;
		const start = getStartAnchor(seg, prevEnd);
		visit(start);
		visit(resolveCP1(seg.cp1, start));
		visit(resolveCP2(seg.cp2, seg.end));
		visit(seg.end);
	}
}

function processSubPath(
	segments: CubicBezierSegment[],
	generateLeaves: LeafGenerator,
): CubicBezierSegment[] {
	const result: CubicBezierSegment[] = [];
	const lastIdx = segments.length - 1;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const prevEnd = i > 0 ? segments[i - 1].end : undefined;
		const startAnchor = getStartAnchor(seg, prevEnd);
		const p0: Point = { x: startAnchor.x, y: startAnchor.y };
		const p1abs = resolveCP1(seg.cp1, startAnchor);
		const p2abs = resolveCP2(seg.cp2, seg.end);
		const p3: Point = { x: seg.end.x, y: seg.end.y };

		const projected: ProjectedLeaf[] = [];
		generateLeaves(
			p0,
			{ x: p1abs.x, y: p1abs.y },
			{ x: p2abs.x, y: p2abs.y },
			p3,
			projected,
		);

		for (let j = 0; j < projected.length; j++) {
			const {
				points: [q0, q1, q2, q3],
				tStart,
				tEnd,
			} = projected[j];
			const isFirstPiece = j === 0;
			const isLastPiece = j === projected.length - 1;

			// seg.start is only carried on the first piece, and only when the
			// original segment already had start (isMoved-style).
			const newStart: BezierPoint | undefined =
				isFirstPiece && seg.start !== undefined
					? interpolateBezierPoint(startAnchor, seg.end, tStart, q0)
					: undefined;
			const newEnd = interpolateBezierPoint(startAnchor, seg.end, tEnd, q3);
			const newCp1: BezierPoint = { x: q1.x - q0.x, y: q1.y - q0.y };
			const newCp2: BezierPoint = { x: q2.x - q3.x, y: q2.y - q3.y };

			result.push({
				...seg,
				start: newStart,
				cp1: newCp1,
				cp2: newCp2,
				end: newEnd,
				startPressure: interpolateOptionalNumber(
					seg.startPressure,
					seg.endPressure,
					tStart,
				),
				endPressure: interpolateOptionalNumber(
					seg.startPressure,
					seg.endPressure,
					tEnd,
				),
				startTiltX:
					interpolateOptionalNumber(seg.startTiltX, seg.endTiltX, tStart) ?? 0,
				startTiltY:
					interpolateOptionalNumber(seg.startTiltY, seg.endTiltY, tStart) ?? 0,
				endTiltX:
					interpolateOptionalNumber(seg.startTiltX, seg.endTiltX, tEnd) ?? 0,
				endTiltY:
					interpolateOptionalNumber(seg.startTiltY, seg.endTiltY, tEnd) ?? 0,
				startDeltaTime:
					interpolateOptionalNumber(
						seg.startDeltaTime,
						seg.endDeltaTime,
						tStart,
					) ?? 0,
				endDeltaTime:
					interpolateOptionalNumber(
						seg.startDeltaTime,
						seg.endDeltaTime,
						tEnd,
					) ?? 0,
				// Sub-pieces of a non-first segment must never claim isMoved.
				isMoved: isFirstPiece ? seg.isMoved : false,
				// isClosed sits on the last piece of the last original segment.
				isClosed: isLastPiece && i === lastIdx ? seg.isClosed : undefined,
			});
		}
	}

	return result;
}

/**
 * Recursively subdivide the cubic at t=0.5 while the projected midpoint error
 * (or the caller's extra predicate) exceeds tolerance. At each leaf, project
 * the four control points and emit the cubic.
 */
function adaptiveSubdivideAndProject(
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	project: ProjectFn,
	projectionErrorThreshold: number,
	shouldSubdivideExtra: ExtraSubdivideFn | undefined,
	tStart: number,
	tEnd: number,
	depth: number,
	out: ProjectedLeaf[],
): void {
	const projected: [Point, Point, Point, Point] = [
		project(p0.x, p0.y),
		project(p1.x, p1.y),
		project(p2.x, p2.y),
		project(p3.x, p3.y),
	];
	const midpointError = computeProjectedMidpointError(
		p0,
		p1,
		p2,
		p3,
		projected,
		project,
	);
	const extraNeedsSplit = shouldSubdivideExtra?.(p0, p1, p2, p3) ?? false;

	if (
		depth >= MAX_SUBDIVISION_DEPTH ||
		(!extraNeedsSplit && midpointError <= projectionErrorThreshold)
	) {
		out.push({ points: projected, tStart, tEnd });
		return;
	}

	// De Casteljau split at t=0.5
	const p01 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
	const p12 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
	const p23 = { x: (p2.x + p3.x) / 2, y: (p2.y + p3.y) / 2 };
	const p012 = { x: (p01.x + p12.x) / 2, y: (p01.y + p12.y) / 2 };
	const p123 = { x: (p12.x + p23.x) / 2, y: (p12.y + p23.y) / 2 };
	const p0123 = { x: (p012.x + p123.x) / 2, y: (p012.y + p123.y) / 2 };
	const tMid = (tStart + tEnd) / 2;

	adaptiveSubdivideAndProject(
		p0,
		p01,
		p012,
		p0123,
		project,
		projectionErrorThreshold,
		shouldSubdivideExtra,
		tStart,
		tMid,
		depth + 1,
		out,
	);
	adaptiveSubdivideAndProject(
		p0123,
		p123,
		p23,
		p3,
		project,
		projectionErrorThreshold,
		shouldSubdivideExtra,
		tMid,
		tEnd,
		depth + 1,
		out,
	);
}

/** Parameter samples where the fitted cubic's error is measured (the fit is
 * exact at t = 0, 1/3, 2/3, 1, so probe between those points). */
const FIT_ERROR_SAMPLES = [1 / 6, 0.5, 5 / 6];

/**
 * Approximate the projection of the cubic with a single re-fitted cubic:
 * endpoints are projected exactly and the control points are solved so the
 * curve interpolates the exact projections of B(1/3) and B(2/3). Split at
 * t=0.5 and recurse only when the fit's sampled error exceeds the tolerance.
 */
function adaptiveFitAndProject(
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	project: ProjectFn,
	projectionErrorThreshold: number,
	tStart: number,
	tEnd: number,
	depth: number,
	out: ProjectedLeaf[],
): void {
	const q0 = project(p0.x, p0.y);
	const q3 = project(p3.x, p3.y);
	const b13 = evaluateCubicPoint(p0, p1, p2, p3, 1 / 3);
	const b23 = evaluateCubicPoint(p0, p1, p2, p3, 2 / 3);
	const m1 = project(b13.x, b13.y);
	const m2 = project(b23.x, b23.y);

	// Interpolation fit: solve the 2x2 system so the cubic passes through m1/m2.
	// 27·m1 = 8·q0 + 12·c1 + 6·c2 + q3 ; 27·m2 = q0 + 6·c1 + 12·c2 + 8·q3
	const ax = 27 * m1.x - 8 * q0.x - q3.x;
	const ay = 27 * m1.y - 8 * q0.y - q3.y;
	const bx = 27 * m2.x - q0.x - 8 * q3.x;
	const by = 27 * m2.y - q0.y - 8 * q3.y;
	const c1: Point = { x: (2 * ax - bx) / 18, y: (2 * ay - by) / 18 };
	const c2: Point = { x: (2 * bx - ax) / 18, y: (2 * by - ay) / 18 };

	let maxError = 0;
	for (const t of FIT_ERROR_SAMPLES) {
		const source = evaluateCubicPoint(p0, p1, p2, p3, t);
		const exact = project(source.x, source.y);
		const fitted = evaluateCubicPoint(q0, c1, c2, q3, t);
		const dx = exact.x - fitted.x;
		const dy = exact.y - fitted.y;
		maxError = Math.max(maxError, Math.sqrt(dx * dx + dy * dy));
	}

	if (depth >= MAX_SUBDIVISION_DEPTH || maxError <= projectionErrorThreshold) {
		out.push({ points: [q0, c1, c2, q3], tStart, tEnd });
		return;
	}

	// De Casteljau split at t=0.5
	const p01 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
	const p12 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
	const p23 = { x: (p2.x + p3.x) / 2, y: (p2.y + p3.y) / 2 };
	const p012 = { x: (p01.x + p12.x) / 2, y: (p01.y + p12.y) / 2 };
	const p123 = { x: (p12.x + p23.x) / 2, y: (p12.y + p23.y) / 2 };
	const p0123 = { x: (p012.x + p123.x) / 2, y: (p012.y + p123.y) / 2 };
	const tMid = (tStart + tEnd) / 2;

	adaptiveFitAndProject(
		p0,
		p01,
		p012,
		p0123,
		project,
		projectionErrorThreshold,
		tStart,
		tMid,
		depth + 1,
		out,
	);
	adaptiveFitAndProject(
		p0123,
		p123,
		p23,
		p3,
		project,
		projectionErrorThreshold,
		tMid,
		tEnd,
		depth + 1,
		out,
	);
}

function computeProjectedMidpointError(
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	projected: [Point, Point, Point, Point],
	project: ProjectFn,
): number {
	const sourceMid = evaluateCubicPoint(p0, p1, p2, p3, 0.5);
	const exactProjectedMid = project(sourceMid.x, sourceMid.y);
	const approximatedMid = evaluateCubicPoint(
		projected[0],
		projected[1],
		projected[2],
		projected[3],
		0.5,
	);
	const dx = exactProjectedMid.x - approximatedMid.x;
	const dy = exactProjectedMid.y - approximatedMid.y;
	return Math.sqrt(dx * dx + dy * dy);
}

function evaluateCubicPoint(
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	t: number,
): Point {
	const mt = 1 - t;
	const mt2 = mt * mt;
	const t2 = t * t;
	return {
		x:
			mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x,
		y:
			mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y,
	};
}

function interpolateBezierPoint(
	start: BezierPoint,
	end: BezierPoint,
	t: number,
	point: Point,
): BezierPoint {
	const pressure = interpolateOptionalNumber(start.pressure, end.pressure, t);
	const tiltX = interpolateOptionalNumber(start.tiltX, end.tiltX, t);
	const tiltY = interpolateOptionalNumber(start.tiltY, end.tiltY, t);
	const deltaTime = interpolateOptionalNumber(
		start.deltaTime,
		end.deltaTime,
		t,
	);

	return {
		x: point.x,
		y: point.y,
		...(pressure === undefined ? {} : { pressure }),
		...(tiltX === undefined ? {} : { tiltX }),
		...(tiltY === undefined ? {} : { tiltY }),
		...(deltaTime === undefined ? {} : { deltaTime }),
	};
}

function interpolateOptionalNumber(
	start: number | undefined,
	end: number | undefined,
	t: number,
): number | undefined {
	if (start === undefined && end === undefined) return undefined;
	const from = start ?? end;
	const to = end ?? start;
	if (from === undefined || to === undefined) return undefined;
	return from + (to - from) * t;
}
