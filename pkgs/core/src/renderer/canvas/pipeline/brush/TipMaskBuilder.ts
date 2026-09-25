import { evaluatePiecewiseLinear } from "../../../../brush/curves";

/**
 * Procedural tip falloff LUTs.
 *
 * The dab fragment shader computes the normalized squared distance rr and
 * samples a 1D falloff LUT instead of a baked 128px texture. Hardness curves
 * quantize into FALLOFF_LUT_LAYERS layers of an r8unorm texture array; a
 * custom softness curve bakes into its own layer.
 */

export const FALLOFF_LUT_SIZE = 256;
/** Quantization steps for per-dab hardness (round(h * 31)). */
export const FALLOFF_LUT_LAYERS = 32;

const MIN_HARDNESS = 1e-3;

/**
 * MyPaint two-segment falloff over normalized squared distance rr in 0..1:
 * rr < h: 1 + rr*(h-1)/h, otherwise h/(1-h)*(1-rr). Continuous at rr = h.
 */
export function hardnessFalloff(hardness: number, rr: number): number {
	const h = Math.min(Math.max(hardness, MIN_HARDNESS), 1);
	const r = Math.min(Math.max(rr, 0), 1);
	if (r >= 1) return 0;
	if (h >= 1) return 1;
	if (r < h) return 1 + (r * (h - 1)) / h;
	return (h / (1 - h)) * (1 - r);
}

/** Bake the hardness falloff into a LUT indexed by squared distance. */
export function buildFalloffLut(hardness: number): Float32Array {
	const lut = new Float32Array(FALLOFF_LUT_SIZE);
	for (let i = 0; i < FALLOFF_LUT_SIZE; i++) {
		lut[i] = hardnessFalloff(hardness, i / (FALLOFF_LUT_SIZE - 1));
	}
	return lut;
}

/**
 * Bake a custom softness curve (Krita curve-circle convention: opacity is
 * 1 - curve(distance), curve domain is LINEAR distance) into a squared-
 * distance indexed LUT so the shader can share one sampling path.
 */
export function buildFalloffLutFromCurve(
	points: readonly (readonly [number, number])[],
): Float32Array {
	const lut = new Float32Array(FALLOFF_LUT_SIZE);
	for (let i = 0; i < FALLOFF_LUT_SIZE; i++) {
		const rr = i / (FALLOFF_LUT_SIZE - 1);
		const distance = Math.sqrt(rr);
		const value = 1 - evaluatePiecewiseLinear(points, distance);
		lut[i] = Math.min(Math.max(value, 0), 1);
	}
	return lut;
}

/** Quantize a hardness curve value into a LUT array layer index. */
export function hardnessToLutIndex(hardness: number): number {
	const clamped = Math.min(Math.max(hardness, 0), 1);
	return Math.round(clamped * (FALLOFF_LUT_LAYERS - 1));
}

/** r8unorm pixel rows for every quantized hardness layer. */
export function buildFalloffLutLayersData(): Uint8Array[] {
	const layers: Uint8Array[] = [];
	for (let layer = 0; layer < FALLOFF_LUT_LAYERS; layer++) {
		const hardness = layer / (FALLOFF_LUT_LAYERS - 1);
		const lut = buildFalloffLut(hardness);
		const bytes = new Uint8Array(FALLOFF_LUT_SIZE);
		for (let i = 0; i < FALLOFF_LUT_SIZE; i++) {
			bytes[i] = Math.round(Math.min(Math.max(lut[i], 0), 1) * 255);
		}
		layers.push(bytes);
	}
	return layers;
}
