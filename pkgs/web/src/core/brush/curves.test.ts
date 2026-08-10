import {
	buildCurveLut,
	CURVE_LUT_BINS,
	evaluateBrushProperty,
	evaluatePiecewiseLinear,
	sampleCurveLut,
} from "./curves";

describe("evaluatePiecewiseLinear", () => {
	it("should interpolate linearly between points", () => {
		expect(
			evaluatePiecewiseLinear(
				[
					[0, 0],
					[1, 1],
				],
				0.25,
			),
		).toBeCloseTo(0.25, 10);
		expect(
			evaluatePiecewiseLinear(
				[
					[0, -0.5],
					[0.5, 0],
					[1, 0.25],
				],
				0.25,
			),
		).toBeCloseTo(-0.25, 10);
		expect(
			evaluatePiecewiseLinear(
				[
					[0, -0.5],
					[0.5, 0],
					[1, 0.25],
				],
				0.75,
			),
		).toBeCloseTo(0.125, 10);
	});

	it("should clamp to edge values outside the defined x range", () => {
		const points: [number, number][] = [
			[0.2, 0.1],
			[0.8, 0.5],
		];
		expect(evaluatePiecewiseLinear(points, 0)).toBeCloseTo(0.1, 10);
		expect(evaluatePiecewiseLinear(points, 1)).toBeCloseTo(0.5, 10);
	});

	it("should return 0 for an empty curve", () => {
		expect(evaluatePiecewiseLinear([], 0.5)).toBe(0);
	});

	it("should return the point value for a single-point curve", () => {
		expect(evaluatePiecewiseLinear([[0.3, 0.7]], 0.9)).toBeCloseTo(0.7, 10);
	});

	it("should accept unsorted points", () => {
		expect(
			evaluatePiecewiseLinear(
				[
					[1, 1],
					[0, 0],
				],
				0.5,
			),
		).toBeCloseTo(0.5, 10);
	});
});

describe("buildCurveLut / sampleCurveLut", () => {
	it("should have CURVE_LUT_BINS entries", () => {
		const lut = buildCurveLut([
			[0, 0],
			[1, 1],
		]);
		expect(lut.length).toBe(CURVE_LUT_BINS);
	});

	it("should match direct evaluation within LUT resolution", () => {
		const points: [number, number][] = [
			[0, -0.4],
			[0.3, 0.2],
			[0.6, -0.1],
			[1, 0.9],
		];
		const lut = buildCurveLut(points);
		for (let i = 0; i <= 100; i++) {
			const x = i / 100;
			const direct = evaluatePiecewiseLinear(points, x);
			expect(Math.abs(sampleCurveLut(lut, x) - direct)).toBeLessThanOrEqual(
				5e-3,
			);
		}
	});

	it("should clamp sampling outside 0..1", () => {
		const points: [number, number][] = [
			[0, 0.2],
			[1, 0.8],
		];
		const lut = buildCurveLut(points);
		expect(sampleCurveLut(lut, -1)).toBeCloseTo(0.2, 5);
		expect(sampleCurveLut(lut, 2)).toBeCloseTo(0.8, 5);
	});
});

describe("evaluateBrushProperty", () => {
	it("should reproduce the v1 pressure-size formula exactly via a two-point curve", () => {
		const k = 0.7;
		const config = {
			base: 10,
			curves: [
				{
					input: "pressure" as const,
					points: [
						[0, -k],
						[1, 0],
					] as [number, number][],
				},
			],
		};
		for (const p of [0, 0.25, 0.5, 1]) {
			expect(
				evaluateBrushProperty("size", config, { pressure: p }),
			).toBeCloseTo(10 * (1 - k + k * p), 10);
		}
	});

	it("should clamp the scale domain factor at zero", () => {
		const config = {
			base: 10,
			curves: [
				{
					input: "pressure" as const,
					points: [
						[0, -2],
						[1, -2],
					] as [number, number][],
				},
			],
		};
		expect(evaluateBrushProperty("size", config, { pressure: 0.5 })).toBe(0);
	});

	it("should sum contributions from multiple curves", () => {
		const config = {
			base: 10,
			curves: [
				{
					input: "pressure" as const,
					points: [
						[0, 0.5],
						[1, 0.5],
					] as [number, number][],
				},
				{
					input: "speedFine" as const,
					points: [
						[0, 0.5],
						[1, 0.5],
					] as [number, number][],
				},
			],
		};
		expect(
			evaluateBrushProperty("size", config, { pressure: 0.5, speedFine: 0.5 }),
		).toBeCloseTo(20, 10);
	});

	it("should fall back to the registry base when config is missing", () => {
		expect(evaluateBrushProperty("flow", undefined, {})).toBe(1);
		expect(evaluateBrushProperty("wetness", undefined, {})).toBeCloseTo(
			0.7,
			10,
		);
	});

	it("should treat a missing input value as 0", () => {
		const config = {
			base: 10,
			curves: [
				{
					input: "pressure" as const,
					points: [
						[0, -0.5],
						[1, 0],
					] as [number, number][],
				},
			],
		};
		expect(evaluateBrushProperty("size", config, {})).toBeCloseTo(5, 10);
	});

	it("should clamp wetness to the 0..1.5 offset range", () => {
		const up = {
			base: 0.7,
			curves: [
				{
					input: "pressure" as const,
					points: [
						[0, 2],
						[1, 2],
					] as [number, number][],
				},
			],
		};
		const down = {
			base: 0.7,
			curves: [
				{
					input: "pressure" as const,
					points: [
						[0, -2],
						[1, -2],
					] as [number, number][],
				},
			],
		};
		expect(evaluateBrushProperty("wetness", up, { pressure: 0.5 })).toBeCloseTo(
			1.5,
			10,
		);
		expect(evaluateBrushProperty("wetness", down, { pressure: 0.5 })).toBe(0);
	});

	it("should evaluate offset domain as base plus sum", () => {
		const config = {
			base: 0,
			curves: [
				{
					input: "twist" as const,
					points: [
						[0, -Math.PI],
						[1, Math.PI],
					] as [number, number][],
				},
			],
		};
		expect(evaluateBrushProperty("angle", config, { twist: 0.75 })).toBeCloseTo(
			Math.PI / 2,
			10,
		);
	});
});
