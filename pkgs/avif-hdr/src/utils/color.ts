const PQ_M1 = 0.1593017578125; // 2610 / 16384
const PQ_M2 = 78.84375; // 2523 / 32 * 128
const PQ_C1 = 0.8359375; // 3424 / 4096
const PQ_C2 = 18.8515625; // 2413 / 128
const PQ_C3 = 18.6875; // 2392 / 128

// PQ (SMPTE ST 2084) EOTF: PQ signal [0,1] -> linear light [0, 10000] cd/m²
export function pqEotf(pqSignal: number): number {
	const pqPow = pqSignal ** (1 / PQ_M2);
	const numerator = Math.max(pqPow - PQ_C1, 0);
	const denominator = PQ_C2 - PQ_C3 * pqPow;
	return 10000 * (numerator / denominator) ** (1 / PQ_M1);
}

// PQ (SMPTE ST 2084) inverse EOTF: linear light [0, 10000] cd/m² -> PQ signal [0,1]
export function pqOetf(linearLight: number): number {
	const y = linearLight / 10000;
	const yPow = y ** PQ_M1;
	const numerator = PQ_C1 + PQ_C2 * yPow;
	const denominator = 1 + PQ_C3 * yPow;
	return (numerator / denominator) ** PQ_M2;
}

// HLG (ARIB STD-B67) OETF: scene linear [0,1] -> HLG signal [0,1]
const HLG_A = 0.17883277;
const HLG_B = 1 - 4 * HLG_A; // 0.28466892
const HLG_C = 0.5 - HLG_A * Math.log(4 * HLG_A); // 0.55991073

export function hlgOetf(sceneLinear: number): number {
	if (sceneLinear <= 1 / 12) {
		return Math.sqrt(3 * sceneLinear);
	}
	return HLG_A * Math.log(12 * sceneLinear - HLG_B) + HLG_C;
}

// HLG inverse OETF: HLG signal [0,1] -> scene linear [0,1]
export function hlgInverseOetf(hlgSignal: number): number {
	if (hlgSignal <= 0.5) {
		return (hlgSignal * hlgSignal) / 3;
	}
	return (Math.exp((hlgSignal - HLG_C) / HLG_A) + HLG_B) / 12;
}

// Gamut conversion matrices (3x3, row-major)
// sRGB (BT.709) linear → BT.2020 linear
const SRGB_TO_BT2020 = [
	0.6274, 0.3293, 0.0433, 0.0691, 0.9195, 0.0114, 0.0164, 0.088, 0.8956,
] as const;

// Display P3 linear → BT.2020 linear
const P3_TO_BT2020 = [
	0.7538, 0.1986, 0.0476, 0.0457, 0.9418, 0.0125, -0.0012, 0.0176, 0.9836,
] as const;

import type { BitDepth, InputColorSpace } from "../types";

// sRGB EOTF: sRGB gamma signal [0,1] → linear light [0,1]
function srgbEotf(v: number): number {
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

// sRGB OETF: linear light [0,1] → sRGB gamma signal [0,1]
export function srgbOetf(v: number): number {
	return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

export function convertToBt2020(
	r: number,
	g: number,
	b: number,
	inputColorSpace: InputColorSpace,
): [number, number, number] {
	if (inputColorSpace === "bt2020-linear") return [r, g, b];

	let lr = r;
	let lg = g;
	let lb = b;

	// Linearize gamma-encoded inputs
	if (inputColorSpace === "srgb" || inputColorSpace === "display-p3") {
		lr = srgbEotf(r);
		lg = srgbEotf(g);
		lb = srgbEotf(b);
	}

	const m =
		inputColorSpace === "display-p3-linear" || inputColorSpace === "display-p3"
			? P3_TO_BT2020
			: SRGB_TO_BT2020;
	return [
		m[0] * lr + m[1] * lg + m[2] * lb,
		m[3] * lr + m[4] * lg + m[5] * lb,
		m[6] * lr + m[7] * lg + m[8] * lb,
	];
}

// BT.2020 non-constant luminance YCbCr coefficients
const KR_2020 = 0.2627;
const KG_2020 = 0.678;
const KB_2020 = 0.0593;

// Convert non-linear R'G'B' [0,1] (already OETF-encoded) to BT.2020 YCbCr [0,1]
export function rgbToBt2020Ycbcr(
	r: number,
	g: number,
	b: number,
): [y: number, cb: number, cr: number] {
	const y = KR_2020 * r + KG_2020 * g + KB_2020 * b;
	const cb = (b - y) / (2 * (1 - KB_2020)) + 0.5;
	const cr = (r - y) / (2 * (1 - KR_2020)) + 0.5;
	return [y, cb, cr];
}

// Quantize floating-point channel value [0,1] to integer for given bit depth
export function quantizeChannel(
	value: number,
	bitDepth: BitDepth,
	fullRange: boolean,
	chroma = false,
): number {
	const maxVal = (1 << bitDepth) - 1;
	if (fullRange) {
		return Math.round(Math.max(0, Math.min(1, value)) * maxVal);
	}
	// Studio range: luma uses 16..235, chroma uses 16..240
	const shift = bitDepth - 8;
	const low = 16 << shift;
	const high = (chroma ? 240 : 235) << shift;
	return Math.round(Math.max(0, Math.min(1, value)) * (high - low) + low);
}
