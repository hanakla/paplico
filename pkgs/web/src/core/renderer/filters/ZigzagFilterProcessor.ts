/**
 * Zigzag Pre-Filter Processor
 * Deforms path geometry before rendering to create a zigzag effect.
 *
 * Algorithm:
 * 1. Sample the path at triangle wave key positions (peaks, troughs, zero crossings)
 * 2. Calculate the normal (perpendicular) direction at each sample point
 * 3. Offset alternating points +/- amplitude along the normal
 * 4. Connect offset points with straight line segments
 * 5. Optionally round corners with circular arcs (roundCorners > 0)
 */

import type { Appearance, CubicBezierSegment, Filter } from "../../schema";
import { lerpOptionalScalar } from "../../utils/color";
import {
	type ArcBezierSegment,
	buildArcLengthTable,
	circularArcByCubics,
	type SampledPoint,
	samplePathAtArcLength,
} from "../../utils/geometry/pathSampling";
import { splitIntoSubPaths } from "../canvas/CanvasLayer.helpers";
import type { FilterHandler } from "../canvas/pipeline/FilterRenderer";

export interface ZigzagParams {
	/** Total number of ridges (direction reversals) across the entire path */
	frequency: number; // 1~100 (default: 10)
	/** Maximum displacement perpendicular to the path (in logical units) */
	amplitude: number; // 0.0~100.0 (default: 5)
	/** Phase offset (0.0~1.0, shifts the zigzag pattern along the path) */
	phase?: number;
	/** Corner rounding amount (0.0~1.0, 0=sharp corners, 1=fully rounded) */
	roundCorners?: number;
}

export interface ZigzagFilter extends Appearance<ZigzagParams> {
	processor: "zigzag";
}

export class ZigzagFilterHandler implements FilterHandler {
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
		const subPaths = splitIntoSubPaths(segments);
		const result: CubicBezierSegment[] = [];

		for (const sub of subPaths) {
			const processed = applyZigzagFilter(sub, filter as ZigzagFilter);
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
		const f = params as ZigzagFilter;
		const uniformScale = Math.sqrt(scaleX * scaleY);
		return {
			...f,
			paramData: {
				...f.paramData,
				params: {
					...f.paramData.params,
					amplitude: f.paramData.params.amplitude * uniformScale,
				},
			},
		};
	}

	public getExpansionMargin(filter: Filter): number {
		const zigzag = filter as ZigzagFilter;
		return zigzag.paramData.params.amplitude ?? 0;
	}

	public onInterpolate(paramsA: unknown, paramsB: unknown, t: number): unknown {
		return interpolateZigzagParams(
			paramsA as ZigzagFilter["paramData"]["params"],
			paramsB as ZigzagFilter["paramData"]["params"],
			t,
		);
	}
}

function interpolateZigzagParams(
	a: ZigzagFilter["paramData"]["params"],
	b: ZigzagFilter["paramData"]["params"],
	t: number,
): ZigzagFilter["paramData"]["params"] {
	return {
		frequency: a.frequency + (b.frequency - a.frequency) * t,
		amplitude: a.amplitude + (b.amplitude - a.amplitude) * t,
		phase: lerpOptionalScalar(a.phase, b.phase, t, 0),
		roundCorners: lerpOptionalScalar(a.roundCorners, b.roundCorners, t, 0),
	};
}

// ---------------------------------------------------------------------------
// Main filter logic
// ---------------------------------------------------------------------------

function applyZigzagFilter(
	segments: CubicBezierSegment[],
	filter: ZigzagFilter,
): CubicBezierSegment[] {
	if (segments.length === 0) return segments;

	const {
		frequency,
		amplitude,
		phase = 0,
		roundCorners = 0,
	} = filter.paramData.params;

	const closed = segments.at(-1)?.isClosed === true;

	// Step 1: Sample at triangle wave key positions (peaks/troughs only)
	const {
		points: sampledPoints,
		totalCycles,
		totalLength,
	} = sampleAtZigzagKeyPositions(segments, frequency, phase, closed);

	if (sampledPoints.length < 2) return segments;

	// Step 2: Compensate amplitude for arc rounding reduction
	const effectiveAmplitude =
		roundCorners > 0
			? compensateAmplitude(amplitude, totalCycles, totalLength, roundCorners)
			: amplitude;

	// Step 3: Apply zigzag offset along normals
	const offsetPoints = applyZigzagOffset(
		sampledPoints,
		effectiveAmplitude,
		phase,
		totalCycles,
		closed,
	);

	// Step 4: Build straight-line zigzag, then optionally round corners
	if (roundCorners > 0 && offsetPoints.length >= 3) {
		return buildRoundedZigzag(offsetPoints, roundCorners, closed);
	}
	return buildStraightZigzag(offsetPoints, closed);
}

/**
 * Increase amplitude to compensate for the reduction caused by inscribed arc rounding.
 * The arc doesn't reach the corner vertex, so we overshoot the offset
 * so that the arc peak lands at the desired amplitude.
 */
function compensateAmplitude(
	amplitude: number,
	totalCycles: number,
	totalLength: number,
	roundCorners: number,
): number {
	if (amplitude < 1e-8 || totalCycles < 1e-8) return amplitude;

	const halfCycleLen = totalLength / (2 * totalCycles);
	const edgeLen = Math.hypot(halfCycleLen, 2 * amplitude);
	const cutback = (roundCorners * edgeLen) / 2;

	const dot =
		(halfCycleLen * halfCycleLen - 4 * amplitude * amplitude) /
		(halfCycleLen * halfCycleLen + 4 * amplitude * amplitude);
	const halfAngle = Math.acos(Math.max(-1, Math.min(1, dot))) / 2;

	if (halfAngle < 1e-8) return amplitude;

	const r = cutback * Math.tan(halfAngle);
	const reduction = r * (1 / Math.sin(halfAngle) - 1);

	return amplitude + reduction;
}

// ---------------------------------------------------------------------------
// Sampling at triangle wave key positions
// ---------------------------------------------------------------------------

interface SamplingResult {
	points: SampledPoint[];
	totalCycles: number;
	totalLength: number;
}

/**
 * Sample points at triangle wave peaks and troughs only (every half cycle).
 * For open paths, start/end samples are included (offset forced to 0 later).
 * For closed paths, only peaks/troughs are sampled (no start/end anchors).
 */
function sampleAtZigzagKeyPositions(
	segments: CubicBezierSegment[],
	frequency: number,
	phase: number,
	closed: boolean,
): SamplingResult {
	const arcLengthTable = buildArcLengthTable(segments);
	const totalLength = arcLengthTable.at(-1)?.cumulativeLength ?? 0;
	if (totalLength < 0.001)
		return { points: [], totalCycles: 0, totalLength: 0 };

	// Illustrator-compatible: frequency = ridges per side = full cycles
	const totalCycles = frequency;

	const tValues: number[] = [];

	if (!closed) {
		tValues.push(0); // Open path: include start anchor
	}

	// Enumerate peak/trough positions: wavePos = 0.25 + n*0.5
	const startWavePos = phase;
	const endWavePos = totalCycles + phase;
	const startN = Math.ceil((startWavePos - 0.25) / 0.5);
	const endN = Math.floor((endWavePos - 0.25) / 0.5);

	for (let n = startN; n <= endN; n++) {
		const wavePos = 0.25 + n * 0.5;
		const t = (wavePos - phase) / totalCycles;
		if (t > 1e-9 && t < 1 - 1e-9) {
			tValues.push(t);
		}
	}

	if (!closed) {
		tValues.push(1); // Open path: include end anchor
	}

	// Sample path at each key position
	const points: SampledPoint[] = [];
	for (const t of tValues) {
		const targetLength = t * totalLength;
		const sample = samplePathAtArcLength(
			segments,
			arcLengthTable,
			targetLength,
			totalLength,
		);
		if (sample) points.push(sample);
	}

	return { points, totalCycles, totalLength };
}

// ---------------------------------------------------------------------------
// Zigzag offset
// ---------------------------------------------------------------------------

/**
 * Triangle wave function: -1 to +1 with linear interpolation between peaks
 * period: one full cycle (0 → +1 → 0 → -1 → 0)
 */
function triangleWave(t: number): number {
	const cyclePos = t - Math.floor(t);
	if (cyclePos < 0.25) {
		return cyclePos * 4;
	} else if (cyclePos < 0.75) {
		return 1 - (cyclePos - 0.25) * 4;
	} else {
		return -1 + (cyclePos - 0.75) * 4;
	}
}

function applyZigzagOffset(
	points: SampledPoint[],
	amplitude: number,
	phase: number,
	totalCycles: number,
	closed: boolean,
): SampledPoint[] {
	if (points.length === 0) return points;

	return points.map((point, index) => {
		// Open paths: start/end anchors stay on the path (offset=0)
		if (!closed && (index === 0 || index === points.length - 1)) {
			return point;
		}

		const wavePos = point.t * totalCycles + phase;
		const waveVal = triangleWave(wavePos);
		const offset = waveVal * amplitude;

		return {
			...point,
			x: point.x + point.normalX * offset,
			y: point.y + point.normalY * offset,
		};
	});
}

// ---------------------------------------------------------------------------
// Straight-line zigzag construction
// ---------------------------------------------------------------------------

function buildStraightZigzag(
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
// Rounded zigzag construction (circular arc at corners)
// ---------------------------------------------------------------------------

function buildRoundedZigzag(
	points: SampledPoint[],
	roundCorners: number,
	closed = false,
): CubicBezierSegment[] {
	if (points.length < 3) return buildStraightZigzag(points, closed);

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
	for (let i = cornerStart; i < cornerEnd; i++) {
		const prevEdge = closed
			? edgeLengths[(i - 1 + edgeCount) % edgeCount]
			: edgeLengths[i - 1];
		const nextEdge = edgeLengths[i % edgeCount];
		const minEdge = Math.min(prevEdge, nextEdge);
		cutbacks.set(i, (roundCorners * minEdge) / 2);
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
