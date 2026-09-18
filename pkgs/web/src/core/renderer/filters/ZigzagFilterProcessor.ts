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
	buildArcLengthTable,
	type SampledPoint,
	samplePathAtArcLength,
} from "../../utils/geometry/pathSampling";
import {
	buildRoundedPolyline,
	buildStraightPolyline,
} from "../../utils/geometry/polylineRounding";
import { splitIntoSubPaths } from "../../utils/geometry/segmentOps";
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
		return buildRoundedPolyline(offsetPoints, roundCorners, closed);
	}
	return buildStraightPolyline(offsetPoints, closed);
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

	// The rounded peak height grows monotonically with the offset and is at
	// least offset * (1 - roundCorners), which bounds the search. At
	// roundCorners = 1 the height saturates at halfCycleLen / 2, so the cap
	// keeps unreachable amplitudes finite.
	let lo = amplitude;
	let hi = amplitude / Math.max(1 - roundCorners, 1e-3);
	for (let i = 0; i < 50; i++) {
		const mid = (lo + hi) / 2;
		if (roundedPeakHeight(mid, halfCycleLen, roundCorners) < amplitude) {
			lo = mid;
		} else {
			hi = mid;
		}
	}
	return hi;
}

/**
 * Height of a peak offset by `offset` after its corner is rounded with an arc
 * inscribed between edges of length hypot(halfCycleLen, 2 * offset).
 */
function roundedPeakHeight(
	offset: number,
	halfCycleLen: number,
	roundCorners: number,
): number {
	const edgeLen = Math.hypot(halfCycleLen, 2 * offset);
	// cutback * (1 - sin(halfAngle)) / cos(halfAngle), with
	// sin(halfAngle) = halfCycleLen / edgeLen and cos(halfAngle) = 2 * offset / edgeLen
	const reduction =
		(roundCorners * edgeLen * (edgeLen - halfCycleLen)) / (4 * offset);
	return offset - reduction;
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
