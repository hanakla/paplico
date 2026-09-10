import type {
	BezierPoint,
	CubicBezierSegment,
	PathSegment,
} from "../../schema";
import { resolveSegment } from "../../utils/geometry/segmentOps";
import { clamp, lerp } from "../../utils/math";

const { PI, acos, tan, sqrt, min } = Math;
const ANGLE_THRESHOLD = (170 * PI) / 180;
const EPSILON = 1e-6;

/**
 * Apply fillet (corner rounding) to vertices with cornerRadius set.
 * PathSegment extends CubicBezierSegment with the cornerRadius property.
 * Returns the original array unchanged (zero allocation) when no segment has cornerRadius.
 *
 * Two-pass approach:
 *   Pass 1: Compute fillet info for all vertices using the original segment array (read-only)
 *   Pass 2: Build the result segment array from the computed fillet info
 * This prevents one vertex's fillet from interfering with another's maxRadius calculation.
 */
export function applyCornerRadius(
	segments: CubicBezierSegment[],
): CubicBezierSegment[] {
	if (segments.length < 2) return segments;

	// Check if any segment has cornerRadius
	const hasAnyRadius = segments.some((seg) => {
		const r = (seg as CubicBezierSegment & { cornerRadius?: number })
			.cornerRadius;
		return r !== undefined && r > 0;
	});
	if (!hasAnyRadius) return segments;

	const isClosed = segments[segments.length - 1].isClosed === true;

	// Pass 1: Compute fillet info for all vertices using the original segment array
	// filletInfos[i] holds fillet info for segments[i].end vertex (junction of segments[i] and segments[i+1])
	const filletInfos: (FilletInfo | null)[] = new Array(segments.length).fill(
		null,
	);

	for (let i = 0; i < segments.length - 1; i++) {
		const segIn = segments[i];
		const segOut = segments[i + 1];
		if (segOut.isMoved) continue;

		filletInfos[i] = computeFilletInfo(segments, segIn, segOut, i);
	}

	// Wrap-around vertex for closed paths
	if (isClosed && segments.length >= 2) {
		const lastIdx = segments.length - 1;
		const segIn = segments[lastIdx];
		const segOut = segments[0];
		// Process even if segOut.isMoved is true for wrap-around (this is the closed path start, not a subpath boundary)
		filletInfos[lastIdx] = computeFilletInfo(segments, segIn, segOut, lastIdx);
	}

	// Return original array if no fillet was computed
	if (filletInfos.every((f) => f == null)) return segments;

	// Pass 2: Build the result segment array
	return buildResult(segments, filletInfos, isClosed);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FilletInfo {
	/** Split parameter on the segIn side */
	tIn: number;
	/** Split parameter on the segOut side */
	tOut: number;
	/** fillet curve segments (1 for round/bevel/scoop, 2 for notch) */
	filletSegs: CubicBezierSegment[];
	/** Index of segIn in the segments array */
	segInIdx: number;
}

// ---------------------------------------------------------------------------
// Pass 1: Fillet computation (read-only on original segments)
// ---------------------------------------------------------------------------

function computeFilletInfo(
	segments: CubicBezierSegment[],
	segIn: CubicBezierSegment,
	segOut: CubicBezierSegment,
	i: number,
): FilletInfo | null {
	const radius = getCornerRadius(segIn);
	if (radius <= 0) return null;

	const V = segIn.end;
	const prevEnd = segIn.start ?? segments[i - 1]?.end;

	const inDir = computeInDirection(segIn, prevEnd);
	const outDir = computeOutDirection(segOut, V);
	if (inDir == null || outDir == null) return null;

	const cosAngle = clamp(dot(inDir, outDir), -1, 1);
	const angle = acos(cosAngle);
	if (angle >= ANGLE_THRESHOLD) return null;

	const prevEndOut = segOut.start ?? segIn.end;
	const maxRadius = min(
		radius,
		chordLength(segIn, prevEnd) / 2,
		chordLength(segOut, prevEndOut) / 2,
	);
	if (maxRadius < EPSILON) return null;

	const tIn = findParameterAtDistance(segIn, maxRadius, true, prevEnd);
	const tOut = findParameterAtDistance(segOut, maxRadius, false, prevEndOut);

	const [firstHalf] = splitBezierAt(segIn, tIn, prevEnd);
	const [, secondHalf] = splitBezierAt(segOut, tOut, prevEndOut);

	const trimIn = firstHalf.end;
	const trimOut = secondHalf.start ?? secondHalf.end;

	const n = getSuperellipseK(segIn);

	const arcAngle = PI - angle;
	const k = nToFilletK(arcAngle, n);

	const tangentIn = evaluateBezierDerivative(segIn, tIn, prevEnd);
	const tangentOut = evaluateBezierDerivative(segOut, tOut, prevEndOut);
	const tInNorm = normalize(tangentIn);
	const tOutNorm = normalize(tangentOut);

	if (tInNorm == null || tOutNorm == null) return null;

	// cp1/cp2 are relative offsets: cp1 from start (trimIn), cp2 from end (trimOut)
	// For concave curves (k<0), swap tangent directions to reflect across the bevel line
	const absK = Math.abs(k);
	const cp1Dir = k >= 0 ? tInNorm : tOutNorm;
	const cp2Dir = k >= 0 ? tOutNorm : tInNorm;
	const filletSeg: CubicBezierSegment = {
		start: { x: trimIn.x, y: trimIn.y },
		cp1: {
			x: absK * maxRadius * cp1Dir.x,
			y: absK * maxRadius * cp1Dir.y,
		},
		cp2: {
			x: -(absK * maxRadius * cp2Dir.x),
			y: -(absK * maxRadius * cp2Dir.y),
		},
		end: { x: trimOut.x, y: trimOut.y },
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: false,
	};

	return { tIn, tOut, filletSegs: [filletSeg], segInIdx: i };
}

// ---------------------------------------------------------------------------
// Pass 2: Build result array
// ---------------------------------------------------------------------------

/**
 * Build the result array from original segments and fillet info.
 * Each segment may receive up to two trims: the previous vertex's trimOut (exit trim)
 * and its own trimIn (entry trim).
 */
function buildResult(
	segments: CubicBezierSegment[],
	filletInfos: (FilletInfo | null)[],
	isClosed: boolean,
): CubicBezierSegment[] {
	const result: CubicBezierSegment[] = [];

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const prevEnd = seg.start ?? segments[i - 1]?.end;

		// Fillet at this segment's end (entry-side trim)
		const filletAtEnd = filletInfos[i];
		// Fillet at previous segment's end (exit-side trim = this segment's start-side trim)
		const prevIdx = i === 0 ? (isClosed ? segments.length - 1 : -1) : i - 1;
		const filletAtStart = prevIdx >= 0 ? filletInfos[prevIdx] : null;

		// Determine whether this segment needs trimming
		let trimmedSeg = seg;

		if (filletAtStart != null && filletAtEnd != null) {
			// Both ends are trimmed
			const prevEndForOut =
				seg.start ??
				segments[i - 1]?.end ??
				(isClosed ? segments[segments.length - 1]?.end : undefined);
			const [, afterStartTrim] = splitBezierAt(
				seg,
				filletAtStart.tOut,
				prevEndForOut,
			);
			// Apply end-side trim to afterStartTrim.
			// afterStartTrim's parameter space has been remapped from [tOut..1] to [0..1],
			// so tIn needs to be recalculated.
			const remappedTIn = remapParameter(
				filletAtEnd.tIn,
				filletAtStart.tOut,
				1,
			);
			const [startAndEndTrimmed] = splitBezierAt(
				afterStartTrim,
				remappedTIn,
				afterStartTrim.start ?? prevEndForOut,
			);
			trimmedSeg = {
				...startAndEndTrimmed,
				startPressure: seg.startPressure,
				endPressure: seg.endPressure,
				startTiltX: seg.startTiltX,
				startTiltY: seg.startTiltY,
				endTiltX: seg.endTiltX,
				endTiltY: seg.endTiltY,
				startDeltaTime: seg.startDeltaTime,
				endDeltaTime: seg.endDeltaTime,
				isMoved: seg.isMoved,
				isClosed: seg.isClosed,
			};
		} else if (filletAtEnd != null) {
			// Trim end side only (entry-side)
			const [firstHalf] = splitBezierAt(seg, filletAtEnd.tIn, prevEnd);
			trimmedSeg = {
				...firstHalf,
				startPressure: seg.startPressure,
				endPressure: seg.endPressure,
				startTiltX: seg.startTiltX,
				startTiltY: seg.startTiltY,
				endTiltX: seg.endTiltX,
				endTiltY: seg.endTiltY,
				startDeltaTime: seg.startDeltaTime,
				endDeltaTime: seg.endDeltaTime,
				isMoved: seg.isMoved,
				isClosed: seg.isClosed,
			};
		} else if (filletAtStart != null) {
			// Trim start side only (exit-side)
			const prevEndForOut =
				seg.start ??
				segments[i - 1]?.end ??
				(isClosed ? segments[segments.length - 1]?.end : undefined);
			const [, secondHalf] = splitBezierAt(
				seg,
				filletAtStart.tOut,
				prevEndForOut,
			);
			trimmedSeg = {
				...secondHalf,
				startPressure: seg.startPressure,
				endPressure: seg.endPressure,
				startTiltX: seg.startTiltX,
				startTiltY: seg.startTiltY,
				endTiltX: seg.endTiltX,
				endTiltY: seg.endTiltY,
				startDeltaTime: seg.startDeltaTime,
				endDeltaTime: seg.endDeltaTime,
				isMoved: seg.isMoved,
				isClosed: seg.isClosed,
			};
		}

		// The fillet curves continue the subpath past this segment, so a
		// closing flag has to ride the last of them, not the trimmed segment.
		if (filletAtEnd != null) {
			result.push({ ...trimmedSeg, isClosed: undefined });
			const last = filletAtEnd.filletSegs.length - 1;
			for (const [j, fs] of filletAtEnd.filletSegs.entries()) {
				result.push(
					j === last && trimmedSeg.isClosed ? { ...fs, isClosed: true } : fs,
				);
			}
		} else {
			result.push(trimmedSeg);
		}
	}

	return result;
}

/**
 * Remap parameter t from [oldLo..oldHi] range to [0..1].
 * Used to find tIn's position in the remapped space after splitBezierAt
 * has remapped [tOut..1] to [0..1].
 */
function remapParameter(t: number, lo: number, hi: number): number {
	if (hi - lo < EPSILON) return 0.5;
	return (t - lo) / (hi - lo);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getCornerRadius(seg: PathSegment): number {
	const r = seg.cornerRadius;
	return r != null && r > 0 ? r : 0;
}

function getSuperellipseK(seg: PathSegment): number {
	const k = seg.cornerSuperellipseN;
	return k != null && k >= -1 ? k : 2;
}

/**
 * Convert superellipse exponent n to Bezier fillet k coefficient.
 * n=2: circular arc (k = (4/3)*tan(arcAngle/4))
 * n>2: squircle-like (k approaches 1.0)
 * n<2: concave (k < kCircle)
 */
function nToFilletK(arcAngle: number, n: number): number {
	const kCircle = (4 / 3) * tan(arcAngle / 4);
	// n<1: concave curve (bows away from vertex into shape interior)
	// n=1: bevel (straight line, k=0)
	// n=2: circular arc (k=kCircle)
	// n>2: squircle (k→1.0)
	if (n < 2) return kCircle * (n - 1);
	const smoothing = Math.min(1, (n - 2) / 3);
	return kCircle + smoothing * (1.0 - kCircle);
}

// ---------------------------------------------------------------------------
// Bezier math
// ---------------------------------------------------------------------------

function evaluateBezier(
	seg: CubicBezierSegment,
	t: number,
	prevEnd?: BezierPoint,
): { x: number; y: number } {
	const resolved = resolveSegment(seg, prevEnd);
	const p0 = resolved.start;
	const p1 = resolved.cp1;
	const p2 = resolved.cp2;
	const p3 = resolved.end;
	const u = 1 - t;

	return {
		x:
			u * u * u * p0.x +
			3 * u * u * t * p1.x +
			3 * u * t * t * p2.x +
			t * t * t * p3.x,
		y:
			u * u * u * p0.y +
			3 * u * u * t * p1.y +
			3 * u * t * t * p2.y +
			t * t * t * p3.y,
	};
}

function evaluateBezierDerivative(
	seg: CubicBezierSegment,
	t: number,
	prevEnd?: BezierPoint,
): { x: number; y: number } {
	const resolved = resolveSegment(seg, prevEnd);
	const p0 = resolved.start;
	const p1 = resolved.cp1;
	const p2 = resolved.cp2;
	const p3 = resolved.end;
	const u = 1 - t;

	return {
		x:
			3 * u * u * (p1.x - p0.x) +
			6 * u * t * (p2.x - p1.x) +
			3 * t * t * (p3.x - p2.x),
		y:
			3 * u * u * (p1.y - p0.y) +
			6 * u * t * (p2.y - p1.y) +
			3 * t * t * (p3.y - p2.y),
	};
}

/**
 * De Casteljau subdivision. Split a bezier segment into two at parameter t.
 */
function splitBezierAt(
	seg: CubicBezierSegment,
	t: number,
	prevEnd?: BezierPoint,
): [CubicBezierSegment, CubicBezierSegment] {
	const resolved = resolveSegment(seg, prevEnd);
	const p0 = resolved.start;
	const p1 = resolved.cp1;
	const p2 = resolved.cp2;
	const p3 = resolved.end;

	// Level 1
	const p01x = lerp(p0.x, p1.x, t);
	const p01y = lerp(p0.y, p1.y, t);
	const p12x = lerp(p1.x, p2.x, t);
	const p12y = lerp(p1.y, p2.y, t);
	const p23x = lerp(p2.x, p3.x, t);
	const p23y = lerp(p2.y, p3.y, t);

	// Level 2
	const p012x = lerp(p01x, p12x, t);
	const p012y = lerp(p01y, p12y, t);
	const p123x = lerp(p12x, p23x, t);
	const p123y = lerp(p12y, p23y, t);

	// Level 3 (split point)
	const px = lerp(p012x, p123x, t);
	const py = lerp(p012y, p123y, t);

	const splitPoint: BezierPoint = { x: px, y: py };
	const firstStart = seg.start != null ? { x: p0.x, y: p0.y } : undefined;

	// Convert back to relative cp1/cp2
	const firstHalf: CubicBezierSegment = {
		start: firstStart,
		// cp1 relative to start anchor (p0)
		cp1: { x: p01x - p0.x, y: p01y - p0.y },
		// cp2 relative to end anchor (splitPoint)
		cp2: { x: p012x - px, y: p012y - py },
		end: splitPoint,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: seg.isMoved,
	};

	const secondHalf: CubicBezierSegment = {
		start: { x: px, y: py },
		// cp1 relative to start anchor (splitPoint)
		cp1: { x: p123x - px, y: p123y - py },
		// cp2 relative to end anchor (p3)
		cp2: { x: p23x - p3.x, y: p23y - p3.y },
		end: { x: p3.x, y: p3.y },
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: false,
	};

	return [firstHalf, secondHalf];
}

function chordLength(seg: CubicBezierSegment, prevEnd?: BezierPoint): number {
	const start = seg.start ?? prevEnd;
	if (start == null) return 0;
	return dist(start, seg.end);
}

/**
 * Binary search for parameter t where the distance from start or end equals the given distance.
 */
function findParameterAtDistance(
	seg: CubicBezierSegment,
	distance: number,
	fromEnd: boolean,
	prevEnd?: BezierPoint,
): number {
	const anchor = fromEnd ? seg.end : (seg.start ?? prevEnd ?? seg.end);
	let lo = 0;
	let hi = 1;

	// Binary search: 32 iterations for sufficient precision (2^-32 ~ 2.3e-10)
	for (let iter = 0; iter < 32; iter++) {
		const mid = (lo + hi) / 2;
		const pt = evaluateBezier(seg, mid, prevEnd);
		const d = dist(pt, anchor);

		if (fromEnd) {
			// Decreasing t moves further from end
			if (d < distance) {
				hi = mid;
			} else {
				lo = mid;
			}
		} else {
			// Increasing t moves further from start
			if (d < distance) {
				lo = mid;
			} else {
				hi = mid;
			}
		}
	}

	return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

function computeInDirection(
	seg: CubicBezierSegment,
	prevEnd?: BezierPoint,
): { x: number; y: number } | null {
	const V = seg.end;
	const _resolved = resolveSegment(seg, prevEnd);

	// Direction cp2 → V (cp2 is relative to end, so absolute cp2 = V + seg.cp2, direction = V - (V + seg.cp2) = -seg.cp2)
	const dx = -seg.cp2.x;
	const dy = -seg.cp2.y;
	if (dx * dx + dy * dy >= EPSILON * EPSILON) {
		return normalize({ x: dx, y: dy });
	}

	// Fallback when cp2 coincides with V: use start → V direction
	const start = seg.start ?? prevEnd;
	if (start == null) return null;
	const dx2 = V.x - start.x;
	const dy2 = V.y - start.y;
	if (dx2 * dx2 + dy2 * dy2 < EPSILON * EPSILON) return null;
	return normalize({ x: dx2, y: dy2 });
}

function computeOutDirection(
	seg: CubicBezierSegment,
	V: BezierPoint,
): { x: number; y: number } | null {
	// Direction V → cp1 (cp1 is relative to start anchor V, so absolute cp1 = V + seg.cp1, direction = seg.cp1)
	const dx = seg.cp1.x;
	const dy = seg.cp1.y;
	if (dx * dx + dy * dy >= EPSILON * EPSILON) {
		return normalize({ x: dx, y: dy });
	}

	// Fallback when cp1 coincides with V: use V → end direction
	const dx2 = seg.end.x - V.x;
	const dy2 = seg.end.y - V.y;
	if (dx2 * dx2 + dy2 * dy2 < EPSILON * EPSILON) return null;
	return normalize({ x: dx2, y: dy2 });
}

function normalize(v: {
	x: number;
	y: number;
}): { x: number; y: number } | null {
	const len = sqrt(v.x * v.x + v.y * v.y);
	if (len < EPSILON) return null;
	return { x: v.x / len, y: v.y / len };
}

function dot(a: { x: number; y: number }, b: { x: number; y: number }): number {
	return a.x * b.x + a.y * b.y;
}

function dist(
	a: { x: number; y: number },
	b: { x: number; y: number },
): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return sqrt(dx * dx + dy * dy);
}
