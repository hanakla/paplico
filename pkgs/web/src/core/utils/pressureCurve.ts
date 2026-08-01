/**
 * Pressure curve: maps raw pen pressure [0,1] to effective pressure [0,1]
 * through user-editable control points interpolated with a Fritsch–Carlson
 * monotone cubic (never overshoots the control points).
 */

export type PressureCurvePoint = {
	x: number;
	y: number;
};

/** Identity curve (output = input). */
export const DEFAULT_PRESSURE_CURVE: readonly PressureCurvePoint[] = [
	{ x: 0, y: 0 },
	{ x: 1, y: 1 },
];

const PRESSURE_LUT_SIZE = 256;

/** Control points closer than this on the x axis are considered duplicates. */
const MIN_X_GAP = 1e-3;

/** LUT cache keyed by the points array reference (see transformPressure). */
const lutCache = new WeakMap<readonly PressureCurvePoint[], Float32Array>();

/**
 * Normalize arbitrary input into a valid curve: clamp coordinates to [0,1],
 * sort by x, drop near-duplicate x values, and pin the endpoints to x=0/x=1.
 * Falls back to the identity curve when fewer than 2 valid points remain.
 * Always returns a fresh array with fresh point objects.
 */
export function sanitizePressureCurvePoints(
	points: readonly PressureCurvePoint[],
): PressureCurvePoint[] {
	const valid = points
		.filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
		.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }))
		.sort((a, b) => a.x - b.x);

	const deduped: PressureCurvePoint[] = [];
	for (const point of valid) {
		const last = deduped.at(-1);
		if (last && point.x - last.x < MIN_X_GAP) continue;
		deduped.push(point);
	}

	if (deduped.length < 2) {
		return DEFAULT_PRESSURE_CURVE.map((p) => ({ ...p }));
	}

	deduped[0].x = 0;
	deduped[deduped.length - 1].x = 1;
	return deduped;
}

/** True when the curve is an exact identity mapping (all points on y=x). */
export function isIdentityPressureCurve(
	points: readonly PressureCurvePoint[],
): boolean {
	return points.every((p) => p.x === p.y);
}

/**
 * Evaluate the curve at x using Fritsch–Carlson monotone cubic interpolation.
 * Expects sanitized points (strictly increasing x, at least 2 points).
 */
export function evaluatePressureCurve(
	points: readonly PressureCurvePoint[],
	x: number,
): number {
	return evaluateMonotoneCubic(points, computeMonotoneTangents(points), x);
}

/** Build a lookup table sampling the curve uniformly over [0,1]. */
export function buildPressureLut(
	points: readonly PressureCurvePoint[],
	size = PRESSURE_LUT_SIZE,
): Float32Array {
	const tangents = computeMonotoneTangents(points);
	const lut = new Float32Array(size);
	for (let i = 0; i < size; i++) {
		lut[i] = evaluateMonotoneCubic(points, tangents, i / (size - 1));
	}
	return lut;
}

/**
 * Transform a pressure value through the curve using a cached LUT with
 * linear interpolation between bins. The cache is keyed by the points array
 * reference, so callers must pass a new array whenever the curve changes.
 * The identity curve passes pressure through untouched.
 */
export function transformPressure(
	points: readonly PressureCurvePoint[],
	pressure: number,
): number {
	if (isIdentityPressureCurve(points)) return pressure;

	let lut = lutCache.get(points);
	if (!lut) {
		lut = buildPressureLut(points);
		lutCache.set(points, lut);
	}

	const pos = clamp01(pressure) * (lut.length - 1);
	const i0 = Math.floor(pos);
	const i1 = Math.min(i0 + 1, lut.length - 1);
	return lut[i0] + (lut[i1] - lut[i0]) * (pos - i0);
}

/** Fritsch–Carlson tangents: yield a monotone C1 cubic through the points. */
function computeMonotoneTangents(
	points: readonly PressureCurvePoint[],
): number[] {
	const n = points.length;
	if (n < 2) return new Array(n).fill(0);

	const secants: number[] = [];
	for (let i = 0; i < n - 1; i++) {
		const h = points[i + 1].x - points[i].x;
		secants.push(h > 0 ? (points[i + 1].y - points[i].y) / h : 0);
	}

	const tangents: number[] = [secants[0]];
	for (let i = 1; i < n - 1; i++) {
		tangents.push(
			secants[i - 1] * secants[i] <= 0 ? 0 : (secants[i - 1] + secants[i]) / 2,
		);
	}
	tangents.push(secants[n - 2]);

	// Limit tangent magnitude so the interpolant stays monotone (no overshoot)
	for (let i = 0; i < n - 1; i++) {
		if (secants[i] === 0) {
			tangents[i] = 0;
			tangents[i + 1] = 0;
			continue;
		}
		const a = tangents[i] / secants[i];
		const b = tangents[i + 1] / secants[i];
		const magnitude = a * a + b * b;
		if (magnitude > 9) {
			const scale = 3 / Math.sqrt(magnitude);
			tangents[i] = scale * a * secants[i];
			tangents[i + 1] = scale * b * secants[i];
		}
	}

	return tangents;
}

function evaluateMonotoneCubic(
	points: readonly PressureCurvePoint[],
	tangents: readonly number[],
	x: number,
): number {
	const n = points.length;
	if (n === 0) return clamp01(x);
	if (n === 1) return points[0].y;
	if (x <= points[0].x) return points[0].y;
	if (x >= points[n - 1].x) return points[n - 1].y;

	let seg = 0;
	while (seg < n - 2 && points[seg + 1].x <= x) seg++;

	const p0 = points[seg];
	const p1 = points[seg + 1];
	const h = p1.x - p0.x;
	if (h <= 0) return p0.y;

	const t = (x - p0.x) / h;
	const t2 = t * t;
	const t3 = t2 * t;
	const h00 = 2 * t3 - 3 * t2 + 1;
	const h10 = t3 - 2 * t2 + t;
	const h01 = -2 * t3 + 3 * t2;
	const h11 = t3 - t2;
	return clamp01(
		h00 * p0.y +
			h10 * h * tangents[seg] +
			h01 * p1.y +
			h11 * h * tangents[seg + 1],
	);
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}
