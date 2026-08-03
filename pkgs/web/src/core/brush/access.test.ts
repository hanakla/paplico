import type { BrushSettingsV2, ScatterBrushSettings } from "../schema";
import {
	readStoredBrushSize,
	readStoredBrushStroking,
	readStoredWetInk,
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
	it("should read the flat v1 size field", () => {
		expect(readStoredBrushSize({ type: "scatter", size: 12 })).toBe(12);
	});

	it("should read the v2 size property base", () => {
		expect(readStoredBrushSize(v2)).toBe(24);
	});

	it("should fall back to the registry base for v2 without a size property", () => {
		expect(readStoredBrushSize({ ...v2, properties: {} })).toBeGreaterThan(0);
	});

	it("should return undefined for non-object or sizeless input", () => {
		expect(readStoredBrushSize(null)).toBeUndefined();
		expect(readStoredBrushSize({ type: "stroke" })).toBeUndefined();
	});
});

describe("withStoredBrushSize", () => {
	it("should replace the flat v1 size field", () => {
		const out = withStoredBrushSize(
			{ type: "scatter", size: 12, flow: 0.5 },
			30,
		);
		expect(out).toEqual({ type: "scatter", size: 30, flow: 0.5 });
	});

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

describe("readStoredWetInk", () => {
	const wetInk: ScatterBrushSettings["wetInk"] = {
		enabled: true,
		bleedWidth: 0.5,
		edgeDarkening: 0.4,
		edgeRoughness: 0.3,
		paperGrain: 0.2,
		paperScale: 1,
		directionality: 0.4,
		speedInfluence: 0.5,
		accelInfluence: 0.3,
		wetness: 0.7,
		pigmentLoad: 0.85,
		absorption: 0.35,
		granulation: 0.25,
		pickupUnderlyingColor: false,
		pickupStrength: 0.35,
	};

	it("should read wetInk from a v1 scatter brush", () => {
		expect(readStoredWetInk({ type: "scatter", wetInk })).toEqual(wetInk);
	});

	it("should read wetV1 from a stored v2 brush", () => {
		expect(readStoredWetInk({ ...v2, wetV1: wetInk })).toEqual(wetInk);
	});

	it("should return undefined for stroke brushes and wet-less v2", () => {
		expect(readStoredWetInk({ type: "stroke", wetInk })).toBeUndefined();
		expect(readStoredWetInk(v2)).toBeUndefined();
	});
});

describe("readStoredBrushStroking", () => {
	const stroking = { lineCap: "butt", lineJoin: "miter", miterLimit: 2 };

	it("should read stroking from a v1 stroke brush only", () => {
		expect(readStoredBrushStroking({ type: "stroke", stroking })).toEqual(
			stroking,
		);
		expect(
			readStoredBrushStroking({ type: "scatter", stroking }),
		).toBeUndefined();
	});

	it("should read stroking from a stored v2 brush", () => {
		expect(readStoredBrushStroking({ ...v2, stroking })).toEqual(stroking);
	});
});
