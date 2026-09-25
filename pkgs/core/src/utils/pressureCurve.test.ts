import { describe, expect, it } from "vitest";
import {
	buildPressureLut,
	DEFAULT_PRESSURE_CURVE,
	evaluatePressureCurve,
	isIdentityPressureCurve,
	sanitizePressureCurvePoints,
	transformPressure,
} from "./pressureCurve";

/** Steep S-curve: a plain cubic spline would overshoot below 0.05 / above 0.95 */
const S_CURVE = [
	{ x: 0, y: 0 },
	{ x: 0.4, y: 0.05 },
	{ x: 0.6, y: 0.95 },
	{ x: 1, y: 1 },
];

describe("transformPressure", () => {
	it("should pass pressure through bit-exact for the identity curve", () => {
		const identity = [...DEFAULT_PRESSURE_CURVE];
		for (const pressure of [0, 0.1234567, 1 / 3, 0.5, 0.9999999, 1]) {
			expect(transformPressure(identity, pressure)).toBe(pressure);
		}
	});

	it("should match evaluatePressureCurve within 1e-2 via the LUT", () => {
		let maxError = 0;
		for (let i = 0; i <= 1000; i++) {
			const x = i / 1000;
			maxError = Math.max(
				maxError,
				Math.abs(
					transformPressure(S_CURVE, x) - evaluatePressureCurve(S_CURVE, x),
				),
			);
		}
		expect(maxError).toBeLessThan(1e-2);
	});

	it("should reuse the cached LUT for the same array reference", () => {
		const points = [
			{ x: 0, y: 0 },
			{ x: 0.5, y: 0.9 },
			{ x: 1, y: 1 },
		];
		const before = transformPressure(points, 0.5);
		expect(before).toBeCloseTo(0.9, 2);

		// In-place mutation keeps the array reference, so the cached LUT is reused
		points[1] = { x: 0.5, y: 0.1 };
		expect(transformPressure(points, 0.5)).toBe(before);

		// A fresh array reference rebuilds the LUT from the mutated points
		expect(transformPressure([...points], 0.5)).toBeCloseTo(0.1, 2);
	});
});

describe("evaluatePressureCurve", () => {
	it("should pass through all control points", () => {
		for (const point of S_CURVE) {
			expect(evaluatePressureCurve(S_CURVE, point.x)).toBeCloseTo(point.y, 6);
		}
	});

	it("should stay in [0,1] monotonically without overshooting a steep S-curve", () => {
		let prev = 0;
		for (let i = 0; i <= 2000; i++) {
			const x = i / 2000;
			const y = evaluatePressureCurve(S_CURVE, x);
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(1);
			expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
			if (x <= 0.4) expect(y).toBeLessThanOrEqual(0.05 + 1e-9);
			if (x >= 0.6) expect(y).toBeGreaterThanOrEqual(0.95 - 1e-9);
			prev = y;
		}
	});
});

describe("buildPressureLut", () => {
	it("should sample the curve endpoints exactly with the default size", () => {
		const lut = buildPressureLut(S_CURVE);
		expect(lut).toHaveLength(256);
		expect(lut[0]).toBeCloseTo(0, 6);
		expect(lut[255]).toBeCloseTo(1, 6);
	});
});

describe("sanitizePressureCurvePoints", () => {
	it("should sort points by x and pin endpoints to x=0 and x=1", () => {
		const result = sanitizePressureCurvePoints([
			{ x: 0.9, y: 1 },
			{ x: 0.5, y: 0.4 },
			{ x: 0.1, y: 0 },
		]);
		expect(result.map((p) => p.x)).toEqual([0, 0.5, 1]);
	});

	it("should clamp coordinates into [0,1]", () => {
		const result = sanitizePressureCurvePoints([
			{ x: -2, y: -1 },
			{ x: 3, y: 5 },
		]);
		expect(result).toEqual([
			{ x: 0, y: 0 },
			{ x: 1, y: 1 },
		]);
	});

	it("should drop near-duplicate x values", () => {
		const result = sanitizePressureCurvePoints([
			{ x: 0, y: 0 },
			{ x: 0.5, y: 0.3 },
			{ x: 0.5005, y: 0.8 },
			{ x: 1, y: 1 },
		]);
		expect(result).toHaveLength(3);
		expect(result[1]).toEqual({ x: 0.5, y: 0.3 });
	});

	it("should fall back to the identity curve for garbage input", () => {
		expect(sanitizePressureCurvePoints([])).toEqual([
			...DEFAULT_PRESSURE_CURVE,
		]);
		expect(sanitizePressureCurvePoints([{ x: Number.NaN, y: 0.5 }])).toEqual([
			...DEFAULT_PRESSURE_CURVE,
		]);
	});

	it("should return fresh point objects", () => {
		const input = [
			{ x: 0, y: 0 },
			{ x: 1, y: 1 },
		];
		const result = sanitizePressureCurvePoints(input);
		expect(result).not.toBe(input);
		expect(result[0]).not.toBe(input[0]);
	});
});

describe("isIdentityPressureCurve", () => {
	it("should detect identity curves and reject bent curves", () => {
		expect(isIdentityPressureCurve(DEFAULT_PRESSURE_CURVE)).toBe(true);
		expect(
			isIdentityPressureCurve([
				{ x: 0, y: 0 },
				{ x: 0.5, y: 0.5 },
				{ x: 1, y: 1 },
			]),
		).toBe(true);
		expect(isIdentityPressureCurve(S_CURVE)).toBe(false);
	});
});
