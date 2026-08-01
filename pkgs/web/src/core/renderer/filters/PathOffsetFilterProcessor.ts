import type {
	Appearance,
	BezierPoint,
	CubicBezierSegment,
	Filter,
} from "../../schema";
import { splitBezierAtT } from "../../utils/geometry/pathOps";
import {
	circularArcByCubics,
	evalCubicBezier,
	evalCubicBezierDerivative,
} from "../../utils/geometry/pathSampling";
import {
	computeSubPathSignedArea,
	resolveSegment,
} from "../../utils/geometry/segmentOps";
import { splitIntoSubPaths } from "../canvas/CanvasLayer.helpers";
import type { FilterHandler } from "../canvas/pipeline/FilterRenderer";

export interface PathOffsetParams {
	offset: number; // -50.0~50.0 (positive=outward, negative=inward)
	joinType?: "miter" | "round" | "bevel"; // default: "miter"
	miterLimit?: number; // miter only. default: 4
	openPathCap?: "flat" | "round"; // endpoint connection for open paths. default: "flat"
}

export interface PathOffsetFilter extends Appearance<PathOffsetParams> {
	processor: "path-offset";
}

/**
 * Path Offset Pre-Filter — modeled after Adobe Illustrator's "Offset Path".
 *
 * Offsets path geometry inward or outward by a specified distance,
 * producing a new path that is evenly distant from the original.
 *
 * ### Parameters
 * - **offset** — Distance in world units. Positive = outward, negative = inward.
 * - **joinType** — Corner treatment: `"miter"` (default) | `"round"` | `"bevel"`.
 * - **miterLimit** — (miter only) Ratio threshold. When miter-length / |offset|
 *   exceeds this value the corner falls back to bevel. Default: 4.
 * - **openPathCap** — Endpoint connection style for open paths:
 *   `"flat"` (default) | `"round"`.
 *
 * ### Join behavior
 * - **Miter**: Extends the outer edges until they meet at a point.
 *   If the miter ratio exceeds `miterLimit`, the join is replaced by a bevel.
 * - **Round**: Inserts a circular arc at every convex joint, regardless of
 *   offset direction (positive or negative).
 * - **Bevel**: Cuts the corner with a straight line connecting the offset edges.
 *
 * ### Open paths
 * Open paths are offset on both sides by |offset|, and the endpoints are
 * connected to form a closed outline. The connection style at endpoints
 * is controlled by `openPathCap`: `"flat"` connects with a straight line,
 * `"round"` connects with a semicircular arc.
 *
 * ### Closed paths
 * Closed paths are offset uniformly inward or outward. Winding order is
 * auto-detected via signed area: positive offset always expands outward
 * regardless of CW/CCW winding.
 *
 * If an inward offset is large enough to invert the shape (signed area
 * flips sign), the original subpath is returned unchanged.
 *
 * Smaller self-intersecting artifacts at individual corners are emitted
 * as-is (matching Illustrator behavior).
 *
 * ### Algorithm
 * Subdivision + Tiller-Hanson (1984). Each cubic bezier segment is
 * adaptively subdivided until the curvature per sub-segment is low enough,
 * then each sub-segment's control polygon legs are offset along their
 * normals and consecutive legs are intersected to produce the new control
 * points. The result is a piecewise cubic approximation of the true
 * offset curve.
 */
export class PathOffsetFilterHandler implements FilterHandler {
	public async initialize(
		_device: GPUDevice,
		_canvasFormat: GPUTextureFormat,
	): Promise<void> {
		/* no-op */
	}

	public preProcess(
		segments: CubicBezierSegment[],
		filter: Filter,
	): CubicBezierSegment[] {
		const f = filter as PathOffsetFilter;
		const {
			offset,
			joinType = "miter",
			miterLimit = 4,
			openPathCap = "flat",
		} = f.paramData.params;

		if (Math.abs(offset) < EPSILON || segments.length === 0) return segments;

		const subPaths = splitIntoSubPaths(segments);
		const result: CubicBezierSegment[] = [];

		for (const sub of subPaths) {
			const isClosed = sub.at(-1)?.isClosed === true;
			const processed = isClosed
				? offsetClosedSubPath(sub, offset, joinType, miterLimit)
				: offsetOpenSubPath(sub, offset, joinType, miterLimit, openPathCap);

			if (processed.length === 0) continue;
			result.push({ ...processed[0], isMoved: true });
			for (let i = 1; i < processed.length; i++) {
				result.push(processed[i]);
			}
		}

		return result;
	}

	public onScaleFilter(
		params: Filter,
		[scaleX, scaleY]: [number, number],
	): Filter {
		const f = params as PathOffsetFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					offset: f.paramData.params.offset * uniformScale,
				},
			},
		};
	}

	public getExpansionMargin(filter: Filter): number {
		const f = filter as PathOffsetFilter;
		return Math.abs(f.paramData.params.offset ?? 0);
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		const a = paramsA as PathOffsetFilter["paramData"]["params"];
		const b = paramsB as PathOffsetFilter["paramData"]["params"];
		return {
			offset: a.offset + (b.offset - a.offset) * t,
			joinType: t < 0.5 ? a.joinType : b.joinType,
			miterLimit:
				(a.miterLimit ?? 4) + ((b.miterLimit ?? 4) - (a.miterLimit ?? 4)) * t,
			openPathCap: t < 0.5 ? a.openPathCap : b.openPathCap,
		};
	}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OFFSET_TOLERANCE = 0.5;
const MAX_SUBDIVISION_DEPTH = 8;
const EPSILON = 1e-8;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface Pt {
	x: number;
	y: number;
}

interface OffsetCubic {
	p0: Pt;
	p1: Pt;
	p2: Pt;
	p3: Pt;
	tangentIn: Pt;
	tangentOut: Pt;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function offsetLeg(a: Pt, b: Pt, offset: number): { a: Pt; b: Pt } | null {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = Math.hypot(dx, dy);
	if (len < EPSILON) return null;

	const nx = -dy / len;
	const ny = dx / len;
	return {
		a: { x: a.x + nx * offset, y: a.y + ny * offset },
		b: { x: b.x + nx * offset, y: b.y + ny * offset },
	};
}

function intersectLines(a0: Pt, a1: Pt, b0: Pt, b1: Pt): Pt {
	const dax = a1.x - a0.x;
	const day = a1.y - a0.y;
	const dbx = b1.x - b0.x;
	const dby = b1.y - b0.y;
	const det = dax * dby - day * dbx;

	if (Math.abs(det) < EPSILON) {
		return { x: (a1.x + b0.x) * 0.5, y: (a1.y + b0.y) * 0.5 };
	}

	const t = ((b0.x - a0.x) * dby - (b0.y - a0.y) * dbx) / det;
	return { x: a0.x + dax * t, y: a0.y + day * t };
}

function unitTangent(a: Pt, b: Pt): Pt {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = Math.hypot(dx, dy);
	if (len < EPSILON) return { x: 1, y: 0 };
	return { x: dx / len, y: dy / len };
}

function curveNormalAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
	const tan = evalCubicBezierDerivative(p0, p1, p2, p3, t);
	const len = Math.hypot(tan.x, tan.y);
	if (len < EPSILON) return { x: 0, y: 1 };
	return { x: -tan.y / len, y: tan.x / len };
}

// ---------------------------------------------------------------------------
// Core Tiller-Hanson with adaptive subdivision
// ---------------------------------------------------------------------------

function offsetSingleBezier(
	p0: Pt,
	p1: Pt,
	p2: Pt,
	p3: Pt,
	offset: number,
	depth = 0,
): OffsetCubic[] {
	// Skip degenerate cubics where all control points coincide
	if (
		Math.hypot(p3.x - p0.x, p3.y - p0.y) < EPSILON &&
		Math.hypot(p1.x - p0.x, p1.y - p0.y) < EPSILON &&
		Math.hypot(p2.x - p0.x, p2.y - p0.y) < EPSILON
	) {
		return [];
	}

	// Offset each leg of the control polygon
	const leg0 = offsetLeg(p0, p1, offset);
	const leg1 = offsetLeg(p1, p2, offset);
	const leg2 = offsetLeg(p2, p3, offset);

	// Find the first and last non-null legs for tangent/endpoint fallbacks
	const legs = [leg0, leg1, leg2];
	const firstLeg = legs.find((l) => l != null);
	const lastLeg = legs.findLast((l) => l != null);

	if (!firstLeg || !lastLeg) {
		// Degenerate cubic — all control points coincide
		return [];
	}

	// Offset endpoints from the first/last valid leg normals
	const offP0 = firstLeg.a;
	const offP3 = lastLeg.b;

	// Compute inner control points by intersecting adjacent offset legs
	const offP1 =
		leg0 && leg1
			? intersectLines(leg0.a, leg0.b, leg1.a, leg1.b)
			: leg0
				? leg0.b
				: leg1
					? leg1.a
					: { x: (offP0.x + offP3.x) * 0.5, y: (offP0.y + offP3.y) * 0.5 };

	const offP2 =
		leg1 && leg2
			? intersectLines(leg1.a, leg1.b, leg2.a, leg2.b)
			: leg2
				? leg2.a
				: leg1
					? leg1.b
					: { x: (offP0.x + offP3.x) * 0.5, y: (offP0.y + offP3.y) * 0.5 };

	// Midpoint error check: compare t=0.5 on the offset approximation
	// with the true offset position on the original curve
	if (depth < MAX_SUBDIVISION_DEPTH) {
		const midOrig = evalCubicBezier(p0, p1, p2, p3, 0.5);
		const nMid = curveNormalAt(p0, p1, p2, p3, 0.5);
		const trueMid = {
			x: midOrig.x + nMid.x * offset,
			y: midOrig.y + nMid.y * offset,
		};
		const approxMid = evalCubicBezier(offP0, offP1, offP2, offP3, 0.5);
		const err = Math.hypot(approxMid.x - trueMid.x, approxMid.y - trueMid.y);

		if (err > OFFSET_TOLERANCE) {
			const [left, right] = splitBezierAtT(
				p0 as BezierPoint,
				p1 as BezierPoint,
				p2 as BezierPoint,
				p3 as BezierPoint,
				0.5,
			);
			return [
				...offsetSingleBezier(
					left.p0,
					left.p1,
					left.p2,
					left.p3,
					offset,
					depth + 1,
				),
				...offsetSingleBezier(
					right.p0,
					right.p1,
					right.p2,
					right.p3,
					offset,
					depth + 1,
				),
			];
		}
	}

	return [
		{
			p0: offP0,
			p1: offP1,
			p2: offP2,
			p3: offP3,
			tangentIn: unitTangent(firstLeg.a, firstLeg.b),
			tangentOut: unitTangent(lastLeg.a, lastLeg.b),
		},
	];
}

// ---------------------------------------------------------------------------
// Join geometry
// ---------------------------------------------------------------------------

/**
 * Try to handle a miter join by extending the adjacent offset edges to meet
 * at the miter point, without creating intermediate segments.
 * Returns "extended" if edges were extended, "skip" if gap is zero, or null
 * if the join should fall through to buildJoin (concave or miter limit exceeded).
 */
function tryMiterExtend(
	last: OffsetCubic,
	next: OffsetCubic,
	_center: Pt,
	offset: number,
	miterLimit: number,
	windingSign: number,
): "extended" | "skip" | null {
	const dist = Math.hypot(next.p0.x - last.p3.x, next.p0.y - last.p3.y);
	if (dist < EPSILON) return "skip";

	const cross =
		last.tangentOut.x * next.tangentIn.y - last.tangentOut.y * next.tangentIn.x;
	const isCornerConcave = windingSign !== 0 && cross * windingSign < 0;
	if (isCornerConcave) return null; // concave → fall through to buildJoin

	const miterPt = intersectLines(
		last.p3,
		{ x: last.p3.x + last.tangentOut.x, y: last.p3.y + last.tangentOut.y },
		next.p0,
		{
			x: next.p0.x - next.tangentIn.x,
			y: next.p0.y - next.tangentIn.y,
		},
	);
	const miterDist = Math.hypot(miterPt.x - last.p3.x, miterPt.y - last.p3.y);
	if (miterDist / Math.abs(offset) > miterLimit) return null; // exceeded → fall through

	// Extend edge endpoints to the miter point, adjusting adjacent control
	// points by the same delta to preserve curve shape near the junction.
	const dxLast = miterPt.x - last.p3.x;
	const dyLast = miterPt.y - last.p3.y;
	last.p2 = { x: last.p2.x + dxLast, y: last.p2.y + dyLast };
	last.p3 = miterPt;

	const dxNext = miterPt.x - next.p0.x;
	const dyNext = miterPt.y - next.p0.y;
	next.p1 = { x: next.p1.x + dxNext, y: next.p1.y + dyNext };
	next.p0 = miterPt;
	return "extended";
}

function buildBevelSegment(from: Pt, to: Pt): OffsetCubic {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	return {
		p0: from,
		p1: { x: from.x + dx / 3, y: from.y + dy / 3 },
		p2: { x: to.x - dx / 3, y: to.y - dy / 3 },
		p3: to,
		tangentIn: unitTangent(from, to),
		tangentOut: unitTangent(from, to),
	};
}

function buildJoin(
	prevEnd: Pt,
	prevTangentOut: Pt,
	nextStart: Pt,
	nextTangentIn: Pt,
	center: Pt,
	offset: number,
	joinType: "miter" | "round" | "bevel",
	miterLimit: number,
	windingSign: number,
): OffsetCubic[] {
	const dist = Math.hypot(nextStart.x - prevEnd.x, nextStart.y - prevEnd.y);
	if (dist < EPSILON) return [];

	// Concave joint classification:
	// windingSign: +1=CCW, -1=CW, 0=open path chain (never concave).
	// A corner is "path-concave" when it turns opposite to the winding direction.
	// A concave joint occurs only at path-concave corners with outward offset,
	// where offset edges overlap and must be clipped with bevel.
	const cross =
		prevTangentOut.x * nextTangentIn.y - prevTangentOut.y * nextTangentIn.x;
	const isCornerConcave = windingSign !== 0 && cross * windingSign < 0;
	const isOutwardOffset = windingSign !== 0 && offset * windingSign < 0;
	// Concave joint only when path-concave corner + outward offset.
	// Inward offset at concave corners creates a gap that should be
	// filled with the user's chosen join type (round/bevel/miter).
	const isConcave = isCornerConcave && isOutwardOffset;

	// Concave joints always get bevel to avoid self-intersection
	if (isConcave) return [buildBevelSegment(prevEnd, nextStart)];

	if (joinType === "bevel") return [buildBevelSegment(prevEnd, nextStart)];

	if (joinType === "miter") {
		const miterPt = intersectLines(
			prevEnd,
			{ x: prevEnd.x + prevTangentOut.x, y: prevEnd.y + prevTangentOut.y },
			nextStart,
			{
				x: nextStart.x - nextTangentIn.x,
				y: nextStart.y - nextTangentIn.y,
			},
		);
		const miterDist = Math.hypot(miterPt.x - prevEnd.x, miterPt.y - prevEnd.y);
		if (miterDist / Math.abs(offset) > miterLimit) {
			return [buildBevelSegment(prevEnd, nextStart)];
		}
		// Two line segments through the miter point
		return [
			buildBevelSegment(prevEnd, miterPt),
			buildBevelSegment(miterPt, nextStart),
		];
	}

	// Round join: circular arc from prevEnd to nextStart around center.
	// For outward offset on closed paths, sweep follows the winding direction.
	// For inward offset or open paths, sweep follows the cross product direction
	// (short arc) to avoid large arcs at converging corners.
	const startAngle = Math.atan2(prevEnd.y - center.y, prevEnd.x - center.x);
	const endAngle = Math.atan2(nextStart.y - center.y, nextStart.x - center.x);

	const isOutward = windingSign !== 0 && offset * windingSign < 0;
	let sweepEnd: number;
	if (isOutward && windingSign !== 0) {
		sweepEnd = adjustArcAngleByWinding(startAngle, endAngle, windingSign);
	} else if (isCornerConcave && !isOutward) {
		// Inward offset at concave corner: use SHORT arc.
		// Any self-intersections from opposing arcs at narrow necks are
		// resolved by boolean intersection clipping in offsetClosedSubPath.
		sweepEnd = adjustArcAngleShort(startAngle, endAngle);
	} else {
		sweepEnd = adjustArcAngle(startAngle, endAngle, cross);
	}

	const arcs = circularArcByCubics(
		center,
		Math.abs(offset),
		startAngle,
		sweepEnd,
	);

	if (arcs.length === 0) return [buildBevelSegment(prevEnd, nextStart)];

	// Pin arc endpoints to the actual offset endpoints
	arcs[0].p0 = prevEnd;
	arcs.at(-1)!.p3 = nextStart;
	return arcs;
}

/** Adjust endAngle so the arc sweeps in the correct direction. */
/** Adjust arc endAngle to sweep in the path's winding direction (short arc). */
function adjustArcAngleByWinding(
	startAngle: number,
	endAngle: number,
	windingSign: number,
): number {
	let diff = endAngle - startAngle;
	if (windingSign > 0) {
		// CCW path → positive (CCW) sweep
		while (diff < 0) diff += Math.PI * 2;
		if (diff > Math.PI * 2) diff -= Math.PI * 2;
	} else {
		// CW path → negative (CW) sweep
		while (diff > 0) diff -= Math.PI * 2;
		if (diff < -Math.PI * 2) diff += Math.PI * 2;
	}
	return startAngle + diff;
}

/** Always choose the shorter arc (|diff| ≤ π). */
function adjustArcAngleShort(startAngle: number, endAngle: number): number {
	let diff = endAngle - startAngle;
	// Normalize to (-π, π]
	while (diff > Math.PI) diff -= Math.PI * 2;
	while (diff <= -Math.PI) diff += Math.PI * 2;
	return startAngle + diff;
}

/** Adjust endAngle so the arc sweeps in the correct direction (open paths). */
function adjustArcAngle(
	startAngle: number,
	endAngle: number,
	cross: number,
): number {
	let diff = endAngle - startAngle;
	if (cross < 0) {
		// Counter-clockwise sweep expected
		while (diff < 0) diff += Math.PI * 2;
		if (diff > Math.PI * 2) diff -= Math.PI * 2;
	} else {
		// Clockwise sweep expected
		while (diff > 0) diff -= Math.PI * 2;
		if (diff < -Math.PI * 2) diff += Math.PI * 2;
	}
	return startAngle + diff;
}

// ---------------------------------------------------------------------------
// Output conversion
// ---------------------------------------------------------------------------

function toCubicBezierSegments(
	cubics: OffsetCubic[],
	closed: boolean,
): CubicBezierSegment[] {
	const result: CubicBezierSegment[] = [];

	for (let i = 0; i < cubics.length; i++) {
		const c = cubics[i];
		const isFirst = i === 0;
		const isLast = i === cubics.length - 1;

		const seg: CubicBezierSegment = {
			cp1: { x: c.p1.x - c.p0.x, y: c.p1.y - c.p0.y },
			cp2: { x: c.p2.x - c.p3.x, y: c.p2.y - c.p3.y },
			end: { x: c.p3.x, y: c.p3.y, pressure: 1 },
			startPressure: 1,
			endPressure: 1,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: isFirst,
			isClosed: isLast && closed ? true : undefined,
		};

		if (isFirst) {
			seg.start = { x: c.p0.x, y: c.p0.y, pressure: 1 };
		}

		result.push(seg);
	}

	return result;
}

// ---------------------------------------------------------------------------
// Subpath-level offset
// ---------------------------------------------------------------------------

function resolveSubPath(
	sub: CubicBezierSegment[],
): { start: Pt; cp1: Pt; cp2: Pt; end: Pt }[] {
	return sub.map((seg, i) => {
		const prevEnd = i > 0 ? sub[i - 1].end : undefined;
		return resolveSegment(seg, prevEnd);
	});
}

function offsetSegmentChain(
	resolved: { start: Pt; cp1: Pt; cp2: Pt; end: Pt }[],
	offset: number,
	joinType: "miter" | "round" | "bevel",
	miterLimit: number,
	closedLoop: boolean,
	windingSign = 0,
): OffsetCubic[] {
	const allPieces: OffsetCubic[][] = [];

	for (const r of resolved) {
		const pieces = offsetSingleBezier(r.start, r.cp1, r.cp2, r.end, offset);
		allPieces.push(pieces);
	}

	// Flatten with joins between consecutive segments
	const result: OffsetCubic[] = [];
	for (let i = 0; i < allPieces.length; i++) {
		const pieces = allPieces[i];
		if (pieces.length === 0) continue;
		result.push(...pieces);

		const nextIdx = closedLoop ? (i + 1) % allPieces.length : i + 1;
		if (nextIdx >= allPieces.length && !closedLoop) continue;

		const nextPieces = allPieces[nextIdx];
		if (nextPieces.length === 0) continue;

		const last = pieces.at(-1)!;
		const next = nextPieces[0];
		const joinCenter = resolved[i].end;

		const isInwardOffset = windingSign !== 0 && offset * windingSign >= 0;

		// Miter join: always try extending edges to the miter point.
		// Inward offset + non-miter join: only extend when edges already meet
		// (convex corners where dist ≈ 0). When there's a gap (concave corners
		// in the union result), fall through to buildJoin so round/bevel arcs
		// are generated at the concave transition.
		const dist = Math.hypot(next.p0.x - last.p3.x, next.p0.y - last.p3.y);
		const useExtend =
			joinType === "miter" || (isInwardOffset && dist < EPSILON);

		if (useExtend) {
			const miterResult = tryMiterExtend(
				last,
				next,
				joinCenter,
				offset,
				joinType === "miter" ? miterLimit : 1e6,
				windingSign,
			);
			if (miterResult === "extended" || miterResult === "skip") continue;
		} else if (dist < EPSILON) {
			continue;
		}

		const joins = buildJoin(
			last.p3,
			last.tangentOut,
			next.p0,
			next.tangentIn,
			joinCenter,
			offset,
			joinType,
			miterLimit,
			windingSign,
		);
		result.push(...joins);
	}

	// Remove degenerate zero-length cubics (e.g. collapsed arc segments
	// from round join that shrank to a point during inward offset).
	return result.filter(
		(c) => Math.hypot(c.p3.x - c.p0.x, c.p3.y - c.p0.y) > EPSILON,
	);
}

function offsetClosedSubPath(
	sub: CubicBezierSegment[],
	offset: number,
	joinType: "miter" | "round" | "bevel",
	miterLimit: number,
): CubicBezierSegment[] {
	if (sub.length === 0) return [];

	// Winding order correction: ensure positive offset always expands outward.
	// In Y-up space, CCW path (area>0) has left normal pointing inward,
	// so we negate offset. CW path (area<0) has left normal pointing outward.
	const originalArea = computeSubPathSignedArea(sub);
	const effectiveOffset = originalArea >= 0 ? -offset : offset;

	const windingSign = originalArea >= 0 ? 1 : -1;

	const resolved = resolveSubPath(sub);

	// Check 0 (pre-offset): if |offset| exceeds half of the narrowest bbox
	// dimension, offset edges will cross center → return original.
	// Uses bbox min-half-dim instead of sqrt(area)/2 to avoid false positives
	// on elongated union shapes.
	if (offset < 0) {
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const r of resolved) {
			for (const pt of [r.start, r.cp1, r.cp2, r.end]) {
				minX = Math.min(minX, pt.x);
				minY = Math.min(minY, pt.y);
				maxX = Math.max(maxX, pt.x);
				maxY = Math.max(maxY, pt.y);
			}
		}
		const minHalfDim = Math.min(maxX - minX, maxY - minY) / 2;
		if (Math.abs(offset) > minHalfDim) return sub;
	}

	const cubics = offsetSegmentChain(
		resolved,
		effectiveOffset,
		joinType,
		miterLimit,
		true,
		windingSign,
	);
	if (cubics.length === 0) return sub;

	const result = toCubicBezierSegments(cubics, true);

	// Inversion guard: detect when inward offset collapsed or inverted the shape.
	const resultArea = computeSubPathSignedArea(result);

	// Check 1: signed area flip (winding reversal)
	if (originalArea !== 0 && resultArea !== 0) {
		const originalSign = originalArea > 0 ? 1 : -1;
		const resultSign = resultArea > 0 ? 1 : -1;
		if (originalSign !== resultSign) return sub;
	}

	// Check 2: inward offset should reduce area. If area increased,
	// the edges crossed center and wrapped around → inversion.
	if (offset < 0 && Math.abs(resultArea) > Math.abs(originalArea) * 1.1) {
		return sub;
	}

	// For inward offset, detect and remove self-intersection loops caused
	// by narrow necks. Offset edges from opposite sides of the neck cross,
	// producing leaf-shaped artifacts. Detect the crossing point and cut
	// the loop out of the path.
	if (offset < 0) {
		const clipped = clipSelfIntersections(result);
		if (clipped !== result) return clipped;
	}

	return result;
}

function offsetOpenSubPath(
	sub: CubicBezierSegment[],
	offset: number,
	joinType: "miter" | "round" | "bevel",
	miterLimit: number,
	openPathCap: "flat" | "round",
): CubicBezierSegment[] {
	if (sub.length === 0) return [];

	const resolved = resolveSubPath(sub);
	const absOff = Math.abs(offset);

	// Forward side: offset by +absOff
	const forwardCubics = offsetSegmentChain(
		resolved,
		absOff,
		joinType,
		miterLimit,
		false,
	);

	// Reverse side: reverse the resolved segments, then offset by +absOff
	// (which is effectively -absOff on the original path)
	const reversedResolved = resolved
		.map((r) => ({
			start: r.end,
			cp1: r.cp2,
			cp2: r.cp1,
			end: r.start,
		}))
		.reverse();
	const reverseCubics = offsetSegmentChain(
		reversedResolved,
		absOff,
		joinType,
		miterLimit,
		false,
	);

	// End cap: connects forward chain end to reverse chain start
	const lastForward = forwardCubics.at(-1);
	const firstReverse = reverseCubics[0];
	const endTangent = resolved.at(-1)!;
	const endCapTangent = unitTangent(endTangent.start, endTangent.end);
	const endCap =
		lastForward && firstReverse
			? buildEndCap(
					lastForward.p3,
					firstReverse.p0,
					resolved.at(-1)!.end,
					endCapTangent,
					absOff,
					openPathCap,
				)
			: [];

	// Start cap: connects reverse chain end to forward chain start
	const lastReverse = reverseCubics.at(-1);
	const firstForward = forwardCubics[0];
	const startTangent = resolved[0];
	const startCapTangent = unitTangent(startTangent.end, startTangent.start);
	const startCap =
		lastReverse && firstForward
			? buildEndCap(
					lastReverse.p3,
					firstForward.p0,
					resolved[0].start,
					startCapTangent,
					absOff,
					openPathCap,
				)
			: [];

	const allCubics = [
		...forwardCubics,
		...endCap,
		...reverseCubics,
		...startCap,
	];

	if (allCubics.length === 0) return sub;
	return toCubicBezierSegments(allCubics, true);
}

function buildEndCap(
	from: Pt,
	to: Pt,
	center: Pt,
	tangent: Pt,
	absOffset: number,
	capType: "flat" | "round",
): OffsetCubic[] {
	if (capType === "flat") {
		return [buildBevelSegment(from, to)];
	}

	const startAngle = Math.atan2(from.y - center.y, from.x - center.x);
	const endAngle = Math.atan2(to.y - center.y, to.x - center.x);

	// Sweep in the direction of the tangent
	let diff = endAngle - startAngle;
	const crossCheck =
		(from.x - center.x) * tangent.y - (from.y - center.y) * tangent.x;
	if (crossCheck >= 0) {
		while (diff < 0) diff += Math.PI * 2;
	} else {
		while (diff > 0) diff -= Math.PI * 2;
	}

	const arcs = circularArcByCubics(
		center,
		absOffset,
		startAngle,
		startAngle + diff,
	);
	if (arcs.length === 0) return [buildBevelSegment(from, to)];

	arcs[0].p0 = from;
	arcs.at(-1)!.p3 = to;
	return arcs;
}

// ---------------------------------------------------------------------------
// Self-intersection clipping for inward offset results
// ---------------------------------------------------------------------------

interface BezCurve {
	p0: Pt;
	p1: Pt;
	p2: Pt;
	p3: Pt;
}

interface BBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

function bezierBbox(c: BezCurve): BBox {
	return {
		minX: Math.min(c.p0.x, c.p1.x, c.p2.x, c.p3.x),
		minY: Math.min(c.p0.y, c.p1.y, c.p2.y, c.p3.y),
		maxX: Math.max(c.p0.x, c.p1.x, c.p2.x, c.p3.x),
		maxY: Math.max(c.p0.y, c.p1.y, c.p2.y, c.p3.y),
	};
}

function bboxOverlap(a: BBox, b: BBox): boolean {
	return (
		a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
	);
}

function bboxDiag(b: BBox): number {
	const dx = b.maxX - b.minX;
	const dy = b.maxY - b.minY;
	return dx * dx + dy * dy; // squared diagonal for cheaper comparison
}

/** Split a bezier at t=0.5 using De Casteljau. */
function splitHalf(c: BezCurve): [BezCurve, BezCurve] {
	const mx01 = (c.p0.x + c.p1.x) * 0.5;
	const my01 = (c.p0.y + c.p1.y) * 0.5;
	const mx12 = (c.p1.x + c.p2.x) * 0.5;
	const my12 = (c.p1.y + c.p2.y) * 0.5;
	const mx23 = (c.p2.x + c.p3.x) * 0.5;
	const my23 = (c.p2.y + c.p3.y) * 0.5;
	const mx012 = (mx01 + mx12) * 0.5;
	const my012 = (my01 + my12) * 0.5;
	const mx123 = (mx12 + mx23) * 0.5;
	const my123 = (my12 + my23) * 0.5;
	const midX = (mx012 + mx123) * 0.5;
	const midY = (my012 + my123) * 0.5;
	return [
		{
			p0: c.p0,
			p1: { x: mx01, y: my01 },
			p2: { x: mx012, y: my012 },
			p3: { x: midX, y: midY },
		},
		{
			p0: { x: midX, y: midY },
			p1: { x: mx123, y: my123 },
			p2: { x: mx23, y: my23 },
			p3: c.p3,
		},
	];
}

const FLAT_THRESH_SQ = 0.25; // 0.5px squared
const MAX_SUBDIV_DEPTH = 20;

/**
 * Find the intersection between two bezier curves via recursive subdivision.
 * Returns t-parameters on each original curve and the intersection point.
 */
function findBezierIntersection(
	a: BezCurve,
	b: BezCurve,
	tAmin: number,
	tAmax: number,
	tBmin: number,
	tBmax: number,
	depth: number,
): { tA: number; tB: number; pt: Pt } | null {
	const bbA = bezierBbox(a);
	const bbB = bezierBbox(b);
	if (!bboxOverlap(bbA, bbB)) return null;

	// If both curves are flat enough, do line-line intersection
	if (bboxDiag(bbA) < FLAT_THRESH_SQ && bboxDiag(bbB) < FLAT_THRESH_SQ) {
		const ix = lineSegIntersect(a.p0, a.p3, b.p0, b.p3);
		if (!ix) return null;
		return {
			tA: tAmin + ix.t1 * (tAmax - tAmin),
			tB: tBmin + ix.t2 * (tBmax - tBmin),
			pt: ix.pt,
		};
	}

	if (depth >= MAX_SUBDIV_DEPTH) {
		// Max depth: approximate with line-line
		const ix = lineSegIntersect(a.p0, a.p3, b.p0, b.p3);
		if (!ix) return null;
		return {
			tA: tAmin + ix.t1 * (tAmax - tAmin),
			tB: tBmin + ix.t2 * (tBmax - tBmin),
			pt: ix.pt,
		};
	}

	// Subdivide the curve with the larger bbox
	const diagA = bboxDiag(bbA);
	const diagB = bboxDiag(bbB);

	if (diagA >= diagB) {
		const [a1, a2] = splitHalf(a);
		const tAmid = (tAmin + tAmax) * 0.5;
		return (
			findBezierIntersection(a1, b, tAmin, tAmid, tBmin, tBmax, depth + 1) ??
			findBezierIntersection(a2, b, tAmid, tAmax, tBmin, tBmax, depth + 1)
		);
	}
	const [b1, b2] = splitHalf(b);
	const tBmid = (tBmin + tBmax) * 0.5;
	return (
		findBezierIntersection(a, b1, tAmin, tAmax, tBmin, tBmid, depth + 1) ??
		findBezierIntersection(a, b2, tAmin, tAmax, tBmid, tBmax, depth + 1)
	);
}

/**
 * Detect and split self-intersection loops from offset result.
 * When the offset path crosses itself (e.g., at narrow necks), the path
 * is split into independent closed subpaths at crossing points.
 * Subpaths whose winding direction is opposite to the original are discarded
 * (these are degenerate neck remnants from double crossings at hourglass necks).
 * Uses bezier-level bbox overlap + recursive subdivision.
 * Returns the same array reference if no intersections found.
 */
function clipSelfIntersections(
	segs: CubicBezierSegment[],
	originalWinding?: number,
): CubicBezierSegment[] {
	if (segs.length < 3) return segs;

	// Determine winding direction of the input path (positive = CCW in Y-up)
	const winding = originalWinding ?? Math.sign(computeSubPathSignedArea(segs));

	// Build resolved absolute-coordinate curves
	const curves: BezCurve[] = [];
	for (let i = 0; i < segs.length; i++) {
		const prevEnd = i > 0 ? segs[i - 1].end : undefined;
		const r = resolveSegment(segs[i], prevEnd);
		curves.push({ p0: r.start, p1: r.cp1, p2: r.cp2, p3: r.end });
	}

	const n = segs.length;

	// Check all non-adjacent segment pairs for intersection
	for (let i = 0; i < n; i++) {
		for (let j = i + 2; j < n; j++) {
			// Skip wrap-adjacent pair in closed path
			if (i === 0 && j === n - 1) continue;

			const ix = findBezierIntersection(curves[i], curves[j], 0, 1, 0, 1, 0);
			if (!ix) continue;

			// Split at the crossing point into two closed subpaths
			return splitAtCrossing(segs, curves, i, ix.tA, j, ix.tB, ix.pt, winding);
		}
	}

	return segs; // No intersection found
}

/** Default tilt/time fields for synthesized segments. */
const SYNTH_DEFAULTS = {
	startTiltX: 0,
	startTiltY: 0,
	endTiltX: 0,
	endTiltY: 0,
	startDeltaTime: 0,
	endDeltaTime: 0,
} as const;

/** Create a CubicBezierSegment from absolute-coordinate split result. */
function makeSplitSeg(
	startPt: Pt,
	p1: Pt,
	p2: Pt,
	endPt: Pt,
	opts: { isFirst?: boolean; isClosed?: boolean },
): CubicBezierSegment {
	return {
		...(opts.isFirst
			? { start: { x: startPt.x, y: startPt.y, pressure: 1 } }
			: {}),
		cp1: { x: p1.x - startPt.x, y: p1.y - startPt.y },
		cp2: { x: p2.x - endPt.x, y: p2.y - endPt.y },
		end: { x: endPt.x, y: endPt.y, pressure: 1 },
		...SYNTH_DEFAULTS,
		isMoved: opts.isFirst ?? false,
		...(opts.isClosed ? { isClosed: true } : {}),
	};
}

/**
 * Split the path into two closed subpaths at the crossing point.
 *
 * Part A: crossPt → secondHalf(segA) → [segA+1 .. segB-1] → firstHalf(segB) → crossPt
 * Part B: crossPt → secondHalf(segB) → [segB+1 .. end, 0 .. segA-1] → firstHalf(segA) → crossPt
 */
function splitAtCrossing(
	segs: CubicBezierSegment[],
	curves: BezCurve[],
	segIdxA: number,
	tA: number,
	segIdxB: number,
	tB: number,
	crossPt: Pt,
	winding: number,
): CubicBezierSegment[] {
	const cA = curves[segIdxA];
	const cB = curves[segIdxB];

	// Split the two bezier segments at their respective t values
	const [beforeA, afterA] =
		tA > EPSILON && tA < 1 - EPSILON
			? splitBezierAtT(cA.p0, cA.p1, cA.p2, cA.p3, tA)
			: tA <= EPSILON
				? [null, { p0: cA.p0, p1: cA.p1, p2: cA.p2, p3: cA.p3 }]
				: [{ p0: cA.p0, p1: cA.p1, p2: cA.p2, p3: cA.p3 }, null];
	const [beforeB, afterB] =
		tB > EPSILON && tB < 1 - EPSILON
			? splitBezierAtT(cB.p0, cB.p1, cB.p2, cB.p3, tB)
			: tB <= EPSILON
				? [null, { p0: cB.p0, p1: cB.p1, p2: cB.p2, p3: cB.p3 }]
				: [{ p0: cB.p0, p1: cB.p1, p2: cB.p2, p3: cB.p3 }, null];

	// --- Part A: crossPt → afterA → [segA+1..segB-1] → beforeB → crossPt ---
	const partA: CubicBezierSegment[] = [];

	if (afterA) {
		partA.push(
			makeSplitSeg(crossPt, afterA.p1, afterA.p2, afterA.p3, {
				isFirst: true,
			}),
		);
	}
	for (let k = segIdxA + 1; k < segIdxB; k++) {
		const seg = { ...segs[k], isClosed: undefined };
		if (partA.length === 0) {
			// First segment of Part A — needs start + isMoved
			seg.start = { x: curves[k].p0.x, y: curves[k].p0.y, pressure: 1 };
			seg.isMoved = true;
		}
		partA.push(seg);
	}
	if (beforeB) {
		const isFirst = partA.length === 0;
		partA.push(
			makeSplitSeg(beforeB.p0, beforeB.p1, beforeB.p2, crossPt, {
				isFirst,
				isClosed: true,
			}),
		);
	}
	if (partA.length > 0) {
		partA[partA.length - 1] = {
			...partA[partA.length - 1],
			isClosed: true,
		};
	}

	// --- Part B: crossPt → afterB → [segB+1..end, 0..segA-1] → beforeA → crossPt ---
	const partB: CubicBezierSegment[] = [];

	if (afterB) {
		partB.push(
			makeSplitSeg(crossPt, afterB.p1, afterB.p2, afterB.p3, {
				isFirst: true,
			}),
		);
	}
	// Segments after B and wrapping to before A
	for (let k = segIdxB + 1; k < segs.length; k++) {
		const seg = { ...segs[k], isClosed: undefined };
		if (partB.length === 0) {
			seg.start = { x: curves[k].p0.x, y: curves[k].p0.y, pressure: 1 };
			seg.isMoved = true;
		}
		partB.push(seg);
	}
	for (let k = 0; k < segIdxA; k++) {
		const seg = { ...segs[k], isClosed: undefined };
		if (partB.length === 0) {
			seg.start = { x: curves[k].p0.x, y: curves[k].p0.y, pressure: 1 };
			seg.isMoved = true;
		} else {
			// Remove isMoved from wrapped segments since they're mid-path now
			seg.isMoved = false;
			delete seg.start;
		}
		partB.push(seg);
	}
	if (beforeA) {
		const isFirst = partB.length === 0;
		partB.push(
			makeSplitSeg(beforeA.p0, beforeA.p1, beforeA.p2, crossPt, {
				isFirst,
				isClosed: true,
			}),
		);
	}
	if (partB.length > 0) {
		partB[partB.length - 1] = {
			...partB[partB.length - 1],
			isClosed: true,
		};
	}

	// Recursively clip each part for remaining intersections,
	// preserving the original winding direction to discard neck remnants.
	const clippedA =
		partA.length >= 3 ? clipSelfIntersections(partA, winding) : partA;
	const clippedB =
		partB.length >= 3 ? clipSelfIntersections(partB, winding) : partB;

	// Discard subpaths whose winding is opposite to the original path.
	// These are neck remnants created when two crossings at a narrow neck
	// split the path into lobes + an inverted intermediate region.
	const result = [...clippedA, ...clippedB];
	const parts = splitIntoSubPaths(result);
	if (parts.length <= 1) return result;

	const kept = parts.filter(
		(p) => Math.sign(computeSubPathSignedArea(p)) === winding,
	);
	return kept.length > 0 ? kept.flat() : result;
}

/** Line segment intersection test. Returns t parameters and point, or null. */
function lineSegIntersect(
	a0: Pt,
	a1: Pt,
	b0: Pt,
	b1: Pt,
): { t1: number; t2: number; pt: Pt } | null {
	const dx1 = a1.x - a0.x;
	const dy1 = a1.y - a0.y;
	const dx2 = b1.x - b0.x;
	const dy2 = b1.y - b0.y;

	const denom = dx1 * dy2 - dy1 * dx2;
	if (Math.abs(denom) < 1e-10) return null;

	const dx3 = b0.x - a0.x;
	const dy3 = b0.y - a0.y;
	const t1 = (dx3 * dy2 - dy3 * dx2) / denom;
	const t2 = (dx3 * dy1 - dy3 * dx1) / denom;

	if (t1 < 0 || t1 > 1 || t2 < 0 || t2 > 1) return null;

	return {
		t1,
		t2,
		pt: { x: a0.x + t1 * dx1, y: a0.y + t1 * dy1 },
	};
}
