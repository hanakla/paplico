import type { BrushSettingsV2 } from "../schema";
import {
	readStoredBrushSize,
	readStoredBrushStroking,
	readStoredWetBleedRatio,
	withStoredBrushSize,
} from "./access";

const v2: BrushSettingsV2 = {
	version: 2,
	engine: "dab",
	strokeOpacity: 1,
	paintMode: "buildup",
	properties: {
		size: {
			base: 24,
			curves: [
				{
					input: "pressure",
					points: [
						[0, -0.5],
						[1, 0],
					],
				},
			],
		},
		flow: { base: 0.8 },
	},
	randomSeed: 0,
};

describe("readStoredBrushSize", () => {
	it("should read the v2 size property base", () => {
		expect(readStoredBrushSize(v2)).toBe(24);
	});

	it("should fall back to the registry base for v2 without a size property", () => {
		expect(readStoredBrushSize({ ...v2, properties: {} })).toBeGreaterThan(0);
	});

	it("should return undefined for non-object input", () => {
		expect(readStoredBrushSize(null)).toBeUndefined();
	});
});

describe("withStoredBrushSize", () => {
	it("should patch the v2 size base while keeping its curves", () => {
		const out = withStoredBrushSize(v2, 48);
		expect(out.properties.size?.base).toBe(48);
		expect(out.properties.size?.curves?.length).toBe(1);
		expect(out.properties.flow?.base).toBe(0.8);
	});

	it("should not mutate the input", () => {
		withStoredBrushSize(v2, 48);
		expect(v2.properties.size?.base).toBe(24);
	});
});

describe("readStoredWetBleedRatio", () => {
	it("should read the bleed from a v2 wet brush", () => {
		expect(
			readStoredWetBleedRatio({
				version: 2,
				wet: { enabled: true, bleedRadius: 0.75 },
			}),
		).toBe(0.75);
	});

	it("should read zero when wet is off or absent", () => {
		expect(
			readStoredWetBleedRatio({
				version: 2,
				wet: { enabled: false, bleedRadius: 0.75 },
			}),
		).toBe(0);
		expect(readStoredWetBleedRatio({ ...v2 })).toBe(0);
		expect(readStoredWetBleedRatio(null)).toBe(0);
	});
});

describe("readStoredBrushStroking", () => {
	const stroking = { lineCap: "butt", lineJoin: "miter", miterLimit: 2 };

	it("should return undefined when the brush carries no stroking", () => {
		expect(readStoredBrushStroking(v2)).toBeUndefined();
	});

	it("should read stroking from a stored v2 brush", () => {
		expect(readStoredBrushStroking({ ...v2, stroking })).toEqual(stroking);
	});
});
