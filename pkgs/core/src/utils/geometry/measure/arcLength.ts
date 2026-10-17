import type { BezierPoint, CubicBezierSegment, Point } from "../../../schema";
import {
	evalCubicBezier,
	evalCubicBezierDerivative,
} from "../primitives/bezier";
import { resolveSegment } from "../primitives/segment";

/**
 * Where the point at parameter `t` of segment `segmentIndex` sits along the
 * path, as a ratio of its arc length. An index past the last segment is the
 * path's end.
 */
export function arcLengthRatioAt(
	segments: CubicBezierSegment[],
	segmentIndex: number,
	t: number = 0,
): number {
	if (segmentIndex >= segments.length) return 1;

	const lengths = segmentArcLengths(segments);
	const total = lengths.reduce((sum, length) => sum + length, 0);
	if (total <= 0) return (segmentIndex + t) / segments.length;

	const { start, cp1, cp2, end } = resolveSegment(
		segments[segmentIndex],
		segments[segmentIndex - 1]?.end,
	);
	const before =
		lengths.slice(0, segmentIndex).reduce((sum, length) => sum + length, 0) +
		approximateBezierArcLength(start, cp1, cp2, end, 0, t);
	return before / total;
}

/**
 * Where every segment starts along the path, as ratios of its arc length,
 * followed by 1 for the path's end: entry k is arcLengthRatioAt(segments, k),
 * measured in one pass.
 */
export function arcLengthRatios(segments: CubicBezierSegment[]): number[] {
	const lengths = segmentArcLengths(segments);
	const total = lengths.reduce((sum, length) => sum + length, 0);
	const ratios = [0];
	let before = 0;
	for (let i = 0; i < lengths.length; i++) {
		before += lengths[i];
		ratios.push(total > 0 ? before / total : (i + 1) / lengths.length);
	}
	return ratios;
}

export function approximateBezierArcLength(
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	startT: number,
	endT: number,
): number {
	if (endT <= startT) return 0;

	const samples = 20;
	let length = 0;
	let previous = evalCubicBezier(p0, p1, p2, p3, startT);

	for (let i = 1; i <= samples; i++) {
		const t = startT + ((endT - startT) * i) / samples;
		const current = evalCubicBezier(p0, p1, p2, p3, t);
		length += Math.hypot(current.x - previous.x, current.y - previous.y);
		previous = current;
	}

	return length;
}

/** Arc length of each segment, in order. */
function segmentArcLengths(segments: CubicBezierSegment[]): number[] {
	return segments.map((segment, i) => {
		const { start, cp1, cp2, end } = resolveSegment(
			segment,
			segments[i - 1]?.end,
		);
		return approximateBezierArcLength(start, cp1, cp2, end, 0, 1);
	});
}

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
