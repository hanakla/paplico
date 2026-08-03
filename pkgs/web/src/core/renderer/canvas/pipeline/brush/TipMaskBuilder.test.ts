import {
	buildFalloffLut,
	buildFalloffLutFromCurve,
	FALLOFF_LUT_LAYERS,
	FALLOFF_LUT_SIZE,
	buildFalloffLutLayersData,
	hardnessFalloff,
	hardnessToLutIndex,
} from "./TipMaskBuilder";

describe("hardnessFalloff", () => {
	it("should follow the MyPaint two-segment formula", () => {
		// Segment 1 (rr < h): 1 + rr*(h-1)/h, segment 2: h/(1-h)*(1-rr)
		expect(hardnessFalloff(0.5, 0)).toBeCloseTo(1, 10);
		expect(hardnessFalloff(0.5, 0.25)).toBeCloseTo(0.75, 10);
		expect(hardnessFalloff(0.5, 0.5)).toBeCloseTo(0.5, 10);
		expect(hardnessFalloff(0.5, 0.75)).toBeCloseTo(0.25, 10);
		expect(hardnessFalloff(0.5, 1)).toBeCloseTo(0, 10);
	});

	it("should produce a hard edge at hardness 1", () => {
		expect(hardnessFalloff(1, 0)).toBeCloseTo(1, 10);
		expect(hardnessFalloff(1, 0.5)).toBeCloseTo(1, 10);
		expect(hardnessFalloff(1, 0.999)).toBeCloseTo(1, 2);
		expect(hardnessFalloff(1, 1)).toBeCloseTo(0, 10);
	});

	it("should be continuous at the segment boundary", () => {
		for (const h of [0.2, 0.5, 0.8]) {
			expect(hardnessFalloff(h, h - 1e-9)).toBeCloseTo(
				hardnessFalloff(h, h + 1e-9),
				5,
			);
		}
	});
});

describe("buildFalloffLut", () => {
	it("should sample the falloff over squared-distance 0..1", () => {
		const lut = buildFalloffLut(0.5);
		expect(lut.length).toBe(FALLOFF_LUT_SIZE);
		expect(lut[0]).toBeCloseTo(1, 5);
		expect(lut[FALLOFF_LUT_SIZE - 1]).toBeCloseTo(0, 5);
		const mid = lut[Math.round((FALLOFF_LUT_SIZE - 1) * 0.5)];
		expect(mid).toBeCloseTo(0.5, 2);
	});
});

describe("buildFalloffLutFromCurve", () => {
	it("should map a custom softness curve over normalized distance", () => {
		// Curve value is subtracted from 1 (Krita curve-circle convention).
		const lut = buildFalloffLutFromCurve([
			[0, 0],
			[1, 1],
		]);
		expect(lut[0]).toBeCloseTo(1, 5);
		expect(lut[FALLOFF_LUT_SIZE - 1]).toBeCloseTo(0, 5);
		// The curve domain is linear distance, not squared distance.
		const quarter = lut[Math.round((FALLOFF_LUT_SIZE - 1) * 0.25)];
		expect(quarter).toBeCloseTo(1 - Math.sqrt(0.25), 2);
	});
});

describe("hardnessToLutIndex", () => {
	it("should quantize hardness into 32 layers", () => {
		expect(FALLOFF_LUT_LAYERS).toBe(32);
		expect(hardnessToLutIndex(0)).toBe(0);
		expect(hardnessToLutIndex(1)).toBe(31);
		expect(hardnessToLutIndex(0.5)).toBe(Math.round(0.5 * 31));
		expect(hardnessToLutIndex(-1)).toBe(0);
		expect(hardnessToLutIndex(2)).toBe(31);
	});
});

describe("buildFalloffLutLayersData", () => {
	it("should emit r8unorm bytes for all 32 quantized hardness layers", () => {
		const layers = buildFalloffLutLayersData();
		expect(layers.length).toBe(FALLOFF_LUT_LAYERS);
		for (const layer of layers) {
			expect(layer.length).toBe(FALLOFF_LUT_SIZE);
		}
		// Layer 31 is the hard tip: fully opaque until the very edge.
		const hard = layers[31];
		expect(hard[0]).toBe(255);
		expect(hard[Math.floor(FALLOFF_LUT_SIZE / 2)]).toBe(255);
		// Layer for hardness 0.5 matches the analytic falloff.
		const soft = layers[hardnessToLutIndex(0.5)];
		const mid = soft[Math.round((FALLOFF_LUT_SIZE - 1) * 0.5)];
		expect(mid / 255).toBeCloseTo(0.5, 1);
	});
});
