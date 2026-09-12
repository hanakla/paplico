import type { CubicBezierSegment, Point } from "../../schema";
import { resolveSegment } from "../../utils/geometry/segmentOps";

type FlattenCubicBezierOptions = {
	curveTolerance?: number;
	maxDepth?: number;
};

type FlattenBezierPathOptions = FlattenCubicBezierOptions & {
	/** Subtract this offset from all output points (applied after curve resolution). */
	worldOffset?: Point;
};

const DEFAULT_CURVE_TOLERANCE = 0.25;
const DEFAULT_MAX_FLATTEN_DEPTH = 9;
// Only guards against a zero tolerance; callers at high zoom legitimately
// ask for far less than a hundredth of a world unit, and maxDepth bounds
// the subdivision either way.
const MIN_CURVE_TOLERANCE = 1e-6;
const MIN_MAX_FLATTEN_DEPTH = 1;

/** Flatten one cubic Bézier with absolute control points to [x, y, x, y, ...]. */
export function flattenCubicBezier(
	start: Point,
	cp1: Point,
	cp2: Point,
	end: Point,
	options: FlattenCubicBezierOptions = {},
): number[] {
	const { toleranceSquared, maxDepth } = normalizeOptions(options);
	const points: number[] = [];
	appendAdaptiveFlattenedSegment(
		points,
		start,
		cp1,
		cp2,
		end,
		toleranceSquared,
		maxDepth,
	);
	return points;
}

/** Flatten Bézier segments to [x, y, x, y, ...]. */
export function flattenBezierPath(
	segments: CubicBezierSegment[],
	options: FlattenBezierPathOptions = {},
): number[] {
	if (segments.length === 0) return [];

	const { toleranceSquared, maxDepth } = normalizeOptions(options);
	const points: number[] = [];
	let prevEnd = segments[0].start ?? { x: 0, y: 0 };
	const wo = options.worldOffset;

	for (const segment of segments) {
		const { start, cp1, cp2, end } = resolveSegment(segment, prevEnd);

		if (wo) {
			appendAdaptiveFlattenedSegment(
				points,
				{ x: start.x - wo.x, y: start.y - wo.y },
				{ x: cp1.x - wo.x, y: cp1.y - wo.y },
				{ x: cp2.x - wo.x, y: cp2.y - wo.y },
				{ x: end.x - wo.x, y: end.y - wo.y },
				toleranceSquared,
				maxDepth,
			);
		} else {
			appendAdaptiveFlattenedSegment(
				points,
				start,
				cp1,
				cp2,
				end,
				toleranceSquared,
				maxDepth,
			);
		}

		prevEnd = segment.end;
	}

	return points;
}

/**
 * Flatten Bézier segments to points with per-point pressure interpolation.
 * Returns `{ points, pressures }` where `pressures.length === points.length / 2`.
 */
export function flattenBezierPathWithPressure(
	segments: CubicBezierSegment[],
	options: FlattenBezierPathOptions = {},
): { points: number[]; pressures: number[] } {
	if (segments.length === 0) return { points: [], pressures: [] };

	const { curveTolerance, toleranceSquared, maxDepth } =
		normalizeOptions(options);
	const points: number[] = [];
	const pressures: number[] = [];
	let prevEnd = segments[0].start ?? { x: 0, y: 0 };
	const wo = options.worldOffset;

	for (const segment of segments) {
		const resolved = resolveSegment(segment, prevEnd);
		const start = wo ? offsetPoint(resolved.start, wo) : resolved.start;
		const cp1 = wo ? offsetPoint(resolved.cp1, wo) : resolved.cp1;
		const cp2 = wo ? offsetPoint(resolved.cp2, wo) : resolved.cp2;
		const end = wo ? offsetPoint(resolved.end, wo) : resolved.end;
		const segStartPressure = segment.startPressure ?? 0.5;
		const segEndPressure = segment.endPressure ?? 0.5;
		const segPoints: number[] = [];
		const segTValues: number[] = [];

		appendAdaptiveFlattenedSegmentWithT(
			segPoints,
			segTValues,
			start,
			cp1,
			cp2,
			end,
			toleranceSquared,
			maxDepth,
		);
		alignEndChordsToTangents(
			segPoints,
			segTValues,
			start,
			cp1,
			cp2,
			end,
			curveTolerance,
		);

		// The segment's start repeats the previous segment's end.
		const first = points.length > 0 ? 1 : 0;
		for (let index = first; index < segTValues.length; index++) {
			points.push(segPoints[index * 2], segPoints[index * 2 + 1]);
			pressures.push(
				segStartPressure +
					(segEndPressure - segStartPressure) * segTValues[index],
			);
		}

		prevEnd = segment.end;
	}

	return { points, pressures };
}

function normalizeOptions(options: FlattenCubicBezierOptions): {
	curveTolerance: number;
	toleranceSquared: number;
	maxDepth: number;
} {
	const curveTolerance = Math.max(
		options.curveTolerance ?? DEFAULT_CURVE_TOLERANCE,
		MIN_CURVE_TOLERANCE,
	);
	return {
		curveTolerance,
		toleranceSquared: curveTolerance * curveTolerance,
		maxDepth: Math.max(
			Math.floor(options.maxDepth ?? DEFAULT_MAX_FLATTEN_DEPTH),
			MIN_MAX_FLATTEN_DEPTH,
		),
	};
}

function appendAdaptiveFlattenedSegment(
	points: number[],
	start: Point,
	cp1: Point,
	cp2: Point,
	end: Point,
	toleranceSquared: number,
	maxDepth: number,
): void {
	if (points.length === 0) points.push(start.x, start.y);

	subdivideCubicBezier(
		points,
		start,
		cp1,
		cp2,
		end,
		toleranceSquared,
		maxDepth,
		0,
	);
}

function subdivideCubicBezier(
	points: number[],
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	toleranceSquared: number,
	maxDepth: number,
	depth: number,
): void {
	if (
		depth >= maxDepth ||
		isCubicFlatEnough(p0, p1, p2, p3, toleranceSquared)
	) {
		points.push(p3.x, p3.y);
		return;
	}

	const p01 = midpoint(p0, p1);
	const p12 = midpoint(p1, p2);
	const p23 = midpoint(p2, p3);
	const p012 = midpoint(p01, p12);
	const p123 = midpoint(p12, p23);
	const p0123 = midpoint(p012, p123);

	subdivideCubicBezier(
		points,
		p0,
		p01,
		p012,
		p0123,
		toleranceSquared,
		maxDepth,
		depth + 1,
	);
	subdivideCubicBezier(
		points,
		p0123,
		p123,
		p23,
		p3,
		toleranceSquared,
		maxDepth,
		depth + 1,
	);
}

function appendAdaptiveFlattenedSegmentWithT(
	points: number[],
	tValues: number[],
	start: Point,
	cp1: Point,
	cp2: Point,
	end: Point,
	toleranceSquared: number,
	maxDepth: number,
): void {
	if (points.length === 0) {
		points.push(start.x, start.y);
		tValues.push(0);
	}

	subdivideCubicBezierWithT(
		points,
		tValues,
		start,
		cp1,
		cp2,
		end,
		toleranceSquared,
		maxDepth,
		0,
		0,
		1,
	);
}

function subdivideCubicBezierWithT(
	points: number[],
	tValues: number[],
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	toleranceSquared: number,
	maxDepth: number,
	depth: number,
	tStart: number,
	tEnd: number,
): void {
	if (
		depth >= maxDepth ||
		isCubicFlatEnough(p0, p1, p2, p3, toleranceSquared)
	) {
		points.push(p3.x, p3.y);
		tValues.push(tEnd);
		return;
	}

	const tMid = (tStart + tEnd) * 0.5;
	const p01 = midpoint(p0, p1);
	const p12 = midpoint(p1, p2);
	const p23 = midpoint(p2, p3);
	const p012 = midpoint(p01, p12);
	const p123 = midpoint(p12, p23);
	const p0123 = midpoint(p012, p123);

	subdivideCubicBezierWithT(
		points,
		tValues,
		p0,
		p01,
		p012,
		p0123,
		toleranceSquared,
		maxDepth,
		depth + 1,
		tStart,
		tMid,
	);
	subdivideCubicBezierWithT(
		points,
		tValues,
		p0123,
		p123,
		p23,
		p3,
		toleranceSquared,
		maxDepth,
		depth + 1,
		tMid,
		tEnd,
	);
}

function isCubicFlatEnough(
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	toleranceSquared: number,
): boolean {
	const chordX = p3.x - p0.x;
	const chordY = p3.y - p0.y;
	const chordLengthSquared = chordX * chordX + chordY * chordY;

	if (chordLengthSquared <= Number.EPSILON) {
		return (
			Math.max(
				distanceSquared(p0, p1),
				distanceSquared(p0, p2),
				distanceSquared(p0, p3),
			) <= toleranceSquared
		);
	}

	const dist1Squared = signedDoubleAreaSquared(p0, p3, p1) / chordLengthSquared;
	const dist2Squared = signedDoubleAreaSquared(p0, p3, p2) / chordLengthSquared;
	return Math.max(dist1Squared, dist2Squared) <= toleranceSquared;
}

/**
 * Make a curved segment's first and last chord run along its end tangents.
 * A chord from an endpoint to the first flattened point leans into the
 * curve by an amount that changes with the tolerance, so a corner measured
 * from the chords reads a different angle at every zoom: a miter would
 * change its ratio, its tip, and whether it bevels at all. A stub of at
 * most `stubLength` along the tangent pins the chord direction to the
 * curve's own, which is what an analytic stroker such as resvg measures.
 */
function alignEndChordsToTangents(
	points: number[],
	tValues: number[],
	start: Point,
	cp1: Point,
	cp2: Point,
	end: Point,
	stubLength: number,
): void {
	const count = points.length / 2;
	if (count < 2) return;

	const outgoing = tangentToward(start, cp1, cp2, end);
	if (outgoing) {
		const chord = Math.hypot(points[2] - points[0], points[3] - points[1]);
		const length = Math.min(stubLength, chord / 2);
		if (length > 0) {
			points.splice(
				2,
				0,
				start.x + outgoing.x * length,
				start.y + outgoing.y * length,
			);
			tValues.splice(1, 0, (tValues[1] * length) / chord);
		}
	}

	const incoming = tangentToward(end, cp2, cp1, start);
	if (incoming) {
		const last = points.length / 2 - 1;
		const chord = Math.hypot(
			points[last * 2] - points[(last - 1) * 2],
			points[last * 2 + 1] - points[(last - 1) * 2 + 1],
		);
		const length = Math.min(stubLength, chord / 2);
		if (length > 0) {
			points.splice(
				last * 2,
				0,
				end.x + incoming.x * length,
				end.y + incoming.y * length,
			);
			tValues.splice(last, 0, 1 - ((1 - tValues[last - 1]) * length) / chord);
		}
	}
}

/**
 * Unit direction from `from` toward the first of `a`, `b`, `c` that lies
 * away from it. Null when that point is `c` itself, or sits on it: the
 * segment is straight there and its chord is already its tangent.
 */
function tangentToward(
	from: Point,
	a: Point,
	b: Point,
	c: Point,
): Point | null {
	for (const target of [a, b, c]) {
		const dx = target.x - from.x;
		const dy = target.y - from.y;
		const length = Math.hypot(dx, dy);
		if (length <= 1e-10) continue;
		if (Math.hypot(target.x - c.x, target.y - c.y) <= 1e-10) return null;
		return { x: dx / length, y: dy / length };
	}
	return null;
}

function offsetPoint(p: Point, by: Point): Point {
	return { x: p.x - by.x, y: p.y - by.y };
}

function midpoint(a: Point, b: Point): Point {
	return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}

function distanceSquared(a: Point, b: Point): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return dx * dx + dy * dy;
}

function signedDoubleAreaSquared(a: Point, b: Point, p: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const cross = dx * (a.y - p.y) - dy * (a.x - p.x);
	return cross * cross;
}
