/**
 * Shared path sampling utilities for pre-filters.
 * Provides arc-length parameterization, cubic bezier evaluation, and segment reconstruction.
 */

import type { BezierPoint, CubicBezierSegment } from "../../schema";
import { resolveSegment } from "./segmentOps";

export interface SampledPoint {
	x: number;
	y: number;
	pressure?: number;
	/** Normal direction (unit vector perpendicular to path) */
	normalX: number;
	normalY: number;
	/** Parameter along the path (0 to 1) */
	t: number;
}

interface ArcLengthEntry {
	segmentIndex: number;
	localT: number;
	cumulativeLength: number;
}

interface Point {
	x: number;
	y: number;
}

/**
 * Build a lookup table mapping cumulative arc length to path parameters.
 * This enables arc-length parameterization for uniform sampling.
 */
export function buildArcLengthTable(
	segments: CubicBezierSegment[],
): ArcLengthEntry[] {
	const table: ArcLengthEntry[] = [];
	let cumulativeLength = 0;

	// Add starting point
	table.push({ segmentIndex: 0, localT: 0, cumulativeLength: 0 });

	const samplesPerSegment = 20; // Higher resolution for accuracy

	for (let segIdx = 0; segIdx < segments.length; segIdx++) {
		const segment = segments[segIdx];
		const prevEnd = segIdx > 0 ? segments[segIdx - 1].end : undefined;
		const resolved = resolveSegment(segment, prevEnd);
		const p0 = resolved.start;
		const p1 = resolved.cp1;
		const p2 = resolved.cp2;
		const p3 = resolved.end;

		let prevPt = evalCubicBezier(p0, p1, p2, p3, 0);

		for (let i = 1; i <= samplesPerSegment; i++) {
			const localT = i / samplesPerSegment;
			const pt = evalCubicBezier(p0, p1, p2, p3, localT);
			const dx = pt.x - prevPt.x;
			const dy = pt.y - prevPt.y;
			cumulativeLength += Math.sqrt(dx * dx + dy * dy);

			table.push({ segmentIndex: segIdx, localT, cumulativeLength });
			prevPt = pt;
		}
	}

	return table;
}

/**
 * Sample the path at a specific arc length distance from the start.
 */
export function samplePathAtArcLength(
	segments: CubicBezierSegment[],
	arcLengthTable: ArcLengthEntry[],
	targetLength: number,
	totalLength: number,
): SampledPoint | null {
	if (segments.length === 0) return null;

	// Binary search to find the arc length entry
	let low = 0;
	let high = arcLengthTable.length - 1;

	while (low < high - 1) {
		const mid = Math.floor((low + high) / 2);
		if (arcLengthTable[mid].cumulativeLength <= targetLength) {
			low = mid;
		} else {
			high = mid;
		}
	}

	const entry0 = arcLengthTable[low];
	const entry1 = arcLengthTable[high];

	// Interpolate between the two entries
	const lengthDiff = entry1.cumulativeLength - entry0.cumulativeLength;
	let interpT = 0;
	if (lengthDiff > 0.0001) {
		interpT = (targetLength - entry0.cumulativeLength) / lengthDiff;
	}

	// Handle segment boundary crossing
	let segmentIndex: number;
	let localT: number;

	if (entry0.segmentIndex === entry1.segmentIndex) {
		segmentIndex = entry0.segmentIndex;
		localT = entry0.localT + (entry1.localT - entry0.localT) * interpT;
	} else {
		// Crossing segment boundary - use entry1's segment
		segmentIndex = interpT < 0.5 ? entry0.segmentIndex : entry1.segmentIndex;
		localT =
			interpT < 0.5
				? entry0.localT + (1 - entry0.localT) * (interpT * 2)
				: entry1.localT * ((interpT - 0.5) * 2);
	}

	// Ensure valid indices
	segmentIndex = Math.min(segmentIndex, segments.length - 1);

	const segment = segments[segmentIndex];
	const prevEnd = segmentIndex > 0 ? segments[segmentIndex - 1].end : undefined;
	const resolved = resolveSegment(segment, prevEnd);
	const p0 = resolved.start;
	const p1 = resolved.cp1;
	const p2 = resolved.cp2;
	const p3 = resolved.end;

	const point = evalCubicBezier(p0, p1, p2, p3, localT);
	const tangent = evalCubicBezierDerivative(p0, p1, p2, p3, localT);
	const tangentLen = Math.sqrt(tangent.x * tangent.x + tangent.y * tangent.y);

	// Normal is perpendicular to tangent (rotate 90 degrees CCW)
	let normalX = 0;
	let normalY = 1;
	if (tangentLen > 0.0001) {
		normalX = -tangent.y / tangentLen;
		normalY = tangent.x / tangentLen;
	}

	const pressure = interpolatePressure(p0, p3, localT);
	const arcLengthT = targetLength / totalLength;

	return { x: point.x, y: point.y, pressure, normalX, normalY, t: arcLengthT };
}

/** Evaluate cubic bezier at parameter t */
export function evalCubicBezier(
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	t: number,
): Point {
	const u = 1 - t;
	const tt = t * t;
	const uu = u * u;
	const uuu = uu * u;
	const ttt = tt * t;

	return {
		x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
		y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
	};
}

/** Evaluate cubic bezier second derivative at parameter t */
/** Evaluate cubic bezier derivative (tangent) at parameter t */
export function evalCubicBezierDerivative(
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	t: number,
): Point {
	const u = 1 - t;
	const tt = t * t;
	const uu = u * u;

	return {
		x:
			3 * uu * (p1.x - p0.x) +
			6 * u * t * (p2.x - p1.x) +
			3 * tt * (p3.x - p2.x),
		y:
			3 * uu * (p1.y - p0.y) +
			6 * u * t * (p2.y - p1.y) +
			3 * tt * (p3.y - p2.y),
	};
}

function interpolatePressure(
	p0: BezierPoint,
	p3: BezierPoint,
	t: number,
): number | undefined {
	if (p0.pressure === undefined && p3.pressure === undefined) {
		return undefined;
	}
	const pressure0 = p0.pressure ?? 1;
	const pressure3 = p3.pressure ?? 1;
	return pressure0 + (pressure3 - pressure0) * t;
}

// ---------------------------------------------------------------------------
// Circular arc to cubic bezier conversion
// ---------------------------------------------------------------------------

const ARC_EPSILON = 1e-8;

export interface ArcBezierSegment {
	p0: Point;
	p1: Point;
	p2: Point;
	p3: Point;
	tangentIn: Point;
	tangentOut: Point;
}

/**
 * Convert a circular arc into cubic Bezier segments.
 * Arcs larger than π/2 are subdivided for accuracy.
 */
export function circularArcByCubics(
	center: Point,
	radius: number,
	startAngle: number,
	endAngle: number,
): ArcBezierSegment[] {
	let totalAngle = endAngle - startAngle;
	while (totalAngle > Math.PI * 2) totalAngle -= Math.PI * 2;
	while (totalAngle < -Math.PI * 2) totalAngle += Math.PI * 2;

	if (Math.abs(totalAngle) < ARC_EPSILON) return [];

	const maxArc = Math.PI / 2;
	const numArcs = Math.ceil(Math.abs(totalAngle) / maxArc);
	const arcAngle = totalAngle / numArcs;
	const result: ArcBezierSegment[] = [];

	let currentAngle = startAngle;
	for (let i = 0; i < numArcs; i++) {
		const nextAngle = currentAngle + arcAngle;
		const k = (4 / 3) * Math.tan(arcAngle / 4);

		const cosA = Math.cos(currentAngle);
		const sinA = Math.sin(currentAngle);
		const cosB = Math.cos(nextAngle);
		const sinB = Math.sin(nextAngle);

		const sp: Point = {
			x: center.x + cosA * radius,
			y: center.y + sinA * radius,
		};
		const ep: Point = {
			x: center.x + cosB * radius,
			y: center.y + sinB * radius,
		};

		result.push({
			p0: sp,
			p1: { x: sp.x + -sinA * k * radius, y: sp.y + cosA * k * radius },
			p2: { x: ep.x - -sinB * k * radius, y: ep.y - cosB * k * radius },
			p3: ep,
			tangentIn: { x: -sinA, y: cosA },
			tangentOut: { x: -sinB, y: cosB },
		});

		currentAngle = nextAngle;
	}

	return result;
}
