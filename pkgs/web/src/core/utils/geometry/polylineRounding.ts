/**
 * Builds a path through sampled points, either as straight line segments or
 * with each corner rounded by an inscribed circular arc.
 */

import type { CubicBezierSegment } from "../../schema";
import {
	type ArcBezierSegment,
	circularArcByCubics,
	type SampledPoint,
} from "./pathSampling";

// ---------------------------------------------------------------------------
// Straight-line construction
// ---------------------------------------------------------------------------

export function buildStraightPolyline(
	points: SampledPoint[],
	closed = false,
): CubicBezierSegment[] {
	if (points.length < 2) return [];

	const segments: CubicBezierSegment[] = [];
	const count = closed ? points.length : points.length - 1;

	for (let i = 0; i < count; i++) {
		const p1 = points[i];
		const p2 = points[(i + 1) % points.length];
		const dx = p2.x - p1.x;
		const dy = p2.y - p1.y;

		const segment: CubicBezierSegment = {
			cp1: { x: dx / 3, y: dy / 3, pressure: p1.pressure },
			cp2: { x: -dx / 3, y: -dy / 3, pressure: p2.pressure },
			end: { x: p2.x, y: p2.y, pressure: p2.pressure },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: i === 0,
			isClosed: closed && i === count - 1 ? true : undefined,
		};

		if (i === 0) {
			segment.start = { x: p1.x, y: p1.y, pressure: p1.pressure };
		}
		segments.push(segment);
	}
	return segments;
}

// ---------------------------------------------------------------------------
// Rounded construction (circular arc at corners)
// ---------------------------------------------------------------------------

export function buildRoundedPolyline(
	points: SampledPoint[],
	roundCorners: number,
	closed = false,
): CubicBezierSegment[] {
	if (points.length < 3) return buildStraightPolyline(points, closed);

	const n = points.length;

	// Precompute edge lengths (for closed: wrap-around edge included)
	const edgeCount = closed ? n : n - 1;
	const edgeLengths: number[] = [];
	for (let i = 0; i < edgeCount; i++) {
		const next = (i + 1) % n;
		edgeLengths.push(
			Math.hypot(points[next].x - points[i].x, points[next].y - points[i].y),
		);
	}

	// Precompute cutback distances for each corner vertex
	// For closed paths: ALL vertices are corners. For open paths: interior only.
	const cornerStart = closed ? 0 : 1;
	const cornerEnd = closed ? n : n - 1;
	const cutbacks = new Map<number, number>();
	// An edge shared by two corners gives each half its length. An edge ending
	// at an open path's anchor belongs to one corner only, so that corner may
	// use all of it and rounds like the interior corners.
	for (let i = cornerStart; i < cornerEnd; i++) {
		const prevBudget = closed
			? edgeLengths[(i - 1 + edgeCount) % edgeCount] / 2
			: edgeLengths[i - 1] / (i === 1 ? 1 : 2);
		const nextBudget =
			edgeLengths[i % edgeCount] / (!closed && i === n - 2 ? 1 : 2);
		cutbacks.set(i, roundCorners * Math.min(prevBudget, nextBudget));
	}

	const result: CubicBezierSegment[] = [];
	let prevPt: { x: number; y: number } = closed
		? getCutbackExit(points, cutbacks, n - 1, 0, closed)
		: points[0];
	let isFirst = true;

	for (let i = cornerStart; i < cornerEnd; i++) {
		const B = points[i];
		const nextIdx = (i + 1) % n;
		const C = points[nextIdx];
		const cutback = cutbacks.get(i) ?? 0;

		if (cutback < 1e-6) {
			addStraightSegment(result, prevPt, B, isFirst);
			isFirst = false;
			prevPt = B;
			continue;
		}

		const toA = normalize(sub(prevPt, B));
		const toC = normalize(sub(C, B));

		const P1 = { x: B.x + cutback * toA.x, y: B.y + cutback * toA.y };
		const P2 = { x: B.x + cutback * toC.x, y: B.y + cutback * toC.y };

		addStraightSegment(result, prevPt, P1, isFirst);
		isFirst = false;

		const arcSegs = buildCornerArc(B, P1, P2, toA, toC, cutback);
		for (const arc of arcSegs) {
			addArcSegment(result, arc);
		}

		prevPt = P2;
	}

	if (closed) {
		// Close: connect back to start
		const firstPt = getCutbackEntry(points, cutbacks, 0, closed);
		addStraightSegment(result, prevPt, firstPt, isFirst);
		if (result.length > 0) {
			result.at(-1)!.isClosed = true;
		}
	} else {
		// Open: final segment to end anchor
		addStraightSegment(result, prevPt, points.at(-1)!, isFirst);
	}

	return result;
}

function getCutbackEntry(
	points: SampledPoint[],
	cutbacks: Map<number, number>,
	idx: number,
	closed: boolean,
): { x: number; y: number } {
	const n = points.length;
	const cutback = cutbacks.get(idx) ?? 0;
	if (cutback < 1e-6) return points[idx];
	const prevIdx = (idx - 1 + n) % n;
	const prev = closed ? points[prevIdx] : points[Math.max(0, idx - 1)];
	const toA = normalize(sub(prev, points[idx]));
	return {
		x: points[idx].x + cutback * toA.x,
		y: points[idx].y + cutback * toA.y,
	};
}

function getCutbackExit(
	points: SampledPoint[],
	cutbacks: Map<number, number>,
	idx: number,
	nextIdx: number,
	_closed: boolean,
): { x: number; y: number } {
	const cutback = cutbacks.get(idx) ?? 0;
	if (cutback < 1e-6) return points[idx];
	const next = points[nextIdx];
	const toC = normalize(sub(next, points[idx]));
	return {
		x: points[idx].x + cutback * toC.x,
		y: points[idx].y + cutback * toC.y,
	};
}

/**
 * Build a circular arc at a corner vertex.
 * The arc is inscribed in the angle formed by the two edges.
 */
function buildCornerArc(
	cornerPt: { x: number; y: number },
	P1: { x: number; y: number },
	P2: { x: number; y: number },
	toA: { x: number; y: number },
	toC: { x: number; y: number },
	cutback: number,
): ArcBezierSegment[] {
	const dot = toA.x * toC.x + toA.y * toC.y;
	const halfAngle = Math.acos(Math.max(-1, Math.min(1, dot))) / 2;

	if (halfAngle < 1e-8) return [];

	const r = cutback * Math.tan(halfAngle);
	if (r < 1e-8) return [];

	// Bisector direction (into the angle interior)
	const bisectRaw = { x: toA.x + toC.x, y: toA.y + toC.y };
	const bisectLen = Math.hypot(bisectRaw.x, bisectRaw.y);
	if (bisectLen < 1e-8) return [];

	const bisect = { x: bisectRaw.x / bisectLen, y: bisectRaw.y / bisectLen };
	const distToCenter = r / Math.sin(halfAngle);
	const center = {
		x: cornerPt.x + distToCenter * bisect.x,
		y: cornerPt.y + distToCenter * bisect.y,
	};

	const startAngle = Math.atan2(P1.y - center.y, P1.x - center.x);
	const rawEndAngle = Math.atan2(P2.y - center.y, P2.x - center.x);

	// Always use the short arc
	const sweepEnd = adjustArcAngleShort(startAngle, rawEndAngle);

	const arcs = circularArcByCubics(center, r, startAngle, sweepEnd);
	if (arcs.length === 0) return [];

	// Pin arc endpoints to exact cutback positions
	arcs[0].p0 = P1;
	arcs.at(-1)!.p3 = P2;

	return arcs;
}

/** Always choose the shorter arc (|diff| ≤ π). */
function adjustArcAngleShort(startAngle: number, endAngle: number): number {
	let diff = endAngle - startAngle;
	while (diff > Math.PI) diff -= Math.PI * 2;
	while (diff <= -Math.PI) diff += Math.PI * 2;
	return startAngle + diff;
}

// ---------------------------------------------------------------------------
// Segment building helpers
// ---------------------------------------------------------------------------

function addStraightSegment(
	result: CubicBezierSegment[],
	from: { x: number; y: number },
	to: { x: number; y: number },
	isFirst: boolean,
): void {
	const dx = to.x - from.x;
	const dy = to.y - from.y;

	const seg: CubicBezierSegment = {
		cp1: { x: dx / 3, y: dy / 3 },
		cp2: { x: -dx / 3, y: -dy / 3 },
		end: { x: to.x, y: to.y },
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: isFirst,
	};

	if (isFirst) {
		seg.start = { x: from.x, y: from.y };
	}

	result.push(seg);
}

function addArcSegment(
	result: CubicBezierSegment[],
	arc: ArcBezierSegment,
): void {
	result.push({
		cp1: { x: arc.p1.x - arc.p0.x, y: arc.p1.y - arc.p0.y },
		cp2: { x: arc.p2.x - arc.p3.x, y: arc.p2.y - arc.p3.y },
		end: { x: arc.p3.x, y: arc.p3.y },
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: false,
	});
}

// ---------------------------------------------------------------------------
// Vector math helpers
// ---------------------------------------------------------------------------

function sub(
	a: { x: number; y: number },
	b: { x: number; y: number },
): { x: number; y: number } {
	return { x: a.x - b.x, y: a.y - b.y };
}

function normalize(v: { x: number; y: number }): { x: number; y: number } {
	const len = Math.hypot(v.x, v.y);
	if (len < 1e-12) return { x: 0, y: 0 };
	return { x: v.x / len, y: v.y / len };
}
