import type {
	BrushInputId,
	BrushPropertyConfig,
	BrushPropertyId,
} from "../schema";
import { BRUSH_PROPERTY_REGISTRY, MAX_SCALE_FACTOR } from "./properties";

/** LUT resolution for curve evaluation (Krita floatTransfer(256) equivalent). */
export const CURVE_LUT_BINS = 256;

/**
 * Evaluate a piecewise linear curve at x. Points may be unsorted; x outside
 * the defined range clamps to the edge values. An empty curve yields 0.
 */
export function evaluatePiecewiseLinear(
	points: readonly (readonly [number, number])[],
	x: number,
): number {
	if (points.length === 0) return 0;
	if (points.length === 1) return points[0][1];

	const sorted = [...points].sort((a, b) => a[0] - b[0]);
	if (x <= sorted[0][0]) return sorted[0][1];
	const last = sorted[sorted.length - 1];
	if (x >= last[0]) return last[1];

	for (let i = 0; i < sorted.length - 1; i++) {
		const [x0, y0] = sorted[i];
		const [x1, y1] = sorted[i + 1];
		if (x < x0 || x > x1) continue;
		if (x1 === x0) return y1;
		const t = (x - x0) / (x1 - x0);
		return y0 + (y1 - y0) * t;
	}
	return last[1];
}

/** Bake a curve into a LUT sampled uniformly over x in 0..1. */
export function buildCurveLut(
	points: readonly (readonly [number, number])[],
	bins: number = CURVE_LUT_BINS,
): Float32Array {
	const lut = new Float32Array(bins);
	for (let i = 0; i < bins; i++) {
		lut[i] = evaluatePiecewiseLinear(points, i / (bins - 1));
	}
	return lut;
}

/** Sample a baked LUT with linear interpolation. x clamps to 0..1. */
export function sampleCurveLut(lut: Float32Array, x: number): number {
	const clamped = Math.min(Math.max(x, 0), 1);
	const pos = clamped * (lut.length - 1);
	const i = Math.floor(pos);
	const frac = pos - i;
	const a = lut[i];
	const b = lut[Math.min(i + 1, lut.length - 1)];
	return a + (b - a) * frac;
}

/**
 * Evaluate one property against the curve matrix.
 * Missing config falls back to the registry base; missing inputs read as 0.
 */
export function evaluateBrushProperty(
	id: BrushPropertyId,
	config: BrushPropertyConfig | undefined,
	inputs: Readonly<Partial<Record<BrushInputId, number>>>,
): number {
	const spec = BRUSH_PROPERTY_REGISTRY[id];
	const base = config?.base ?? spec.base;

	let sum = 0;
	for (const curve of config?.curves ?? []) {
		sum += evaluatePiecewiseLinear(curve.points, inputs[curve.input] ?? 0);
	}

	if (spec.domain === "scale") {
		const factor = Math.min(Math.max(1 + sum, 0), MAX_SCALE_FACTOR);
		return clampToRange(base * factor, spec.min, spec.max);
	}
	return clampToRange(base + sum, spec.min, spec.max);
}

function clampToRange(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
