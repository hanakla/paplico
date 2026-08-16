import { describe, expect, it } from "vitest";
import { normalizeBrushSettingsV2 } from "../../../../brush/migrate";
import type { CubicBezierSegment } from "../../../../schema";
import { interpolateStrokeWidths } from "../../../geometry/strokeTessellator";
import { evaluateDabs } from "./DabEvaluator";
import { readDabField } from "./DabInstanceLayout";
import {
	DEFAULT_RIBBON_OPTIONS,
	generateRibbonInstances,
	RIBBON_FLOATS_PER_INSTANCE,
	type RibbonStrokeInput,
} from "./RibbonGenerator";
import {
	bakeStrokeWidthProfile,
	createStrokeHalfWidthSampler,
	resolveGeometricSizeByPressure,
} from "./strokeHalfWidth";

describe("createStrokeHalfWidthSampler", () => {
	it("should return null without brush settings or segments", () => {
		expect(
			createStrokeHalfWidthSampler({
				storedBrushSettings: undefined,
				segments: [lineSegment(0, 0, 100, 0, { isMoved: true })],
			}),
		).toBeNull();
		expect(
			createStrokeHalfWidthSampler({
				storedBrushSettings: geometricSettings(),
				segments: [],
			}),
		).toBeNull();
	});

	it("should return the constant base half width for neutral settings", () => {
		const sampler = createStrokeHalfWidthSampler({
			storedBrushSettings: geometricSettings(),
			segments: [lineSegment(0, 0, 300, 0, { isMoved: true })],
		})!;

		expect(sampler.halfWidthAt(0)).toBeCloseTo(5, 5);
		expect(sampler.halfWidthAt(0.5)).toBeCloseTo(5, 5);
		expect(sampler.halfWidthAt(1)).toBeCloseTo(5, 5);
	});

	it("should follow the pressure profile on the geometric route", () => {
		const sampler = createStrokeHalfWidthSampler({
			storedBrushSettings: geometricSettings({
				size: {
					base: 10,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -1],
								[1, 0],
							],
						},
					],
				},
			}),
			segments: [
				lineSegment(0, 0, 300, 0, {
					isMoved: true,
					startPressure: 1,
					endPressure: 0,
				}),
			],
		})!;

		expect(sampler.halfWidthAt(0)).toBeCloseTo(5, 4);
		expect(sampler.halfWidthAt(0.5)).toBeCloseTo(2.5, 4);
		expect(sampler.halfWidthAt(1)).toBeCloseTo(0, 4);
	});

	it("should taper to zero at the start and suppress the entry taper mid-stroke", () => {
		const settings = geometricSettings(undefined, { taperStart: 100 });
		const segments = [lineSegment(0, 0, 300, 0, { isMoved: true })];

		const fullStroke = createStrokeHalfWidthSampler({
			storedBrushSettings: settings,
			segments,
		})!;
		expect(fullStroke.halfWidthAt(0)).toBeCloseTo(0, 5);
		expect(fullStroke.halfWidthAt(1)).toBeCloseTo(5, 5);

		const midStrokeFragment = createStrokeHalfWidthSampler({
			storedBrushSettings: settings,
			segments,
			pathStart: 0.5,
		})!;
		expect(midStrokeFragment.halfWidthAt(0)).toBeCloseTo(5, 5);
	});

	it("should ignore taper when a dash pattern is active on the geometric route", () => {
		const sampler = createStrokeHalfWidthSampler({
			storedBrushSettings: geometricSettings(undefined, {
				taperStart: 100,
				stroking: { dashArray: [10, 10] },
			}),
			segments: [lineSegment(0, 0, 300, 0, { isMoved: true })],
		})!;

		expect(sampler.halfWidthAt(0)).toBeCloseTo(5, 5);
	});

	// Golden test against the real evaluator: the sampler must report what the
	// dab pipeline actually stamps, including speed-driven size modulation.
	it("should match the dab evaluator's emitted sizes (pressure + speedFine)", () => {
		const raw = {
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "buildup",
			properties: {
				size: {
					base: 10,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -0.3],
								[1, 0],
							],
						},
						{
							input: "speedFine",
							points: [
								[0, 0],
								[1, -0.5],
							],
						},
					],
				},
				ratio: { base: 1 },
				flow: { base: 1 },
				spacing: { base: 0.05 },
			},
			randomSeed: 0,
			tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
		};
		// Fast first half, slow second half, falling pressure.
		const segments = [
			lineSegment(0, 0, 150, 0, {
				isMoved: true,
				startPressure: 1,
				endPressure: 0.6,
				startDeltaTime: 0,
				endDeltaTime: 40,
			}),
			lineSegment(150, 0, 300, 0, {
				startPressure: 0.6,
				endPressure: 0.3,
				startDeltaTime: 40,
				endDeltaTime: 500,
			}),
		];

		const sampler = createStrokeHalfWidthSampler({
			storedBrushSettings: raw,
			segments,
		})!;
		const buffer = evaluateDabs(segments, normalizeBrushSettingsV2(raw), {
			pathStart: 0,
			pathEnd: 1,
		});
		expect(buffer.count).toBeGreaterThan(10);

		const halves: number[] = [];
		for (let i = 0; i < buffer.count; i++) {
			const pathT = readDabField(buffer.data, i, "pathT");
			const sizeX = readDabField(buffer.data, i, "sizeX");
			halves.push(sizeX * 0.5);
			expect(sampler.halfWidthAt(pathT)).toBeCloseTo(sizeX * 0.5, 5);
		}
		// The fixture must actually exercise modulation, not a constant width.
		expect(Math.max(...halves) - Math.min(...halves)).toBeGreaterThan(0.5);
	});

	// Golden test against the real generator: detects the sampler's mirrored
	// closed-form drifting if the ribbon renderer's evaluation ever changes.
	it("should match the ribbon generator's endpoint half widths", () => {
		const raw = {
			version: 2,
			engine: "ribbon",
			strokeOpacity: 1,
			paintMode: "buildup",
			properties: {
				size: {
					base: 20,
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
				flow: { base: 1 },
			},
			randomSeed: 1,
			taperStart: 60,
			taperEnd: 60,
		};
		const settings = normalizeBrushSettingsV2(raw);
		const segments = [
			lineSegment(0, 0, 100, 0, {
				isMoved: true,
				startPressure: 1,
				endPressure: 0.7,
			}),
			lineSegment(100, 0, 200, 0, { startPressure: 0.7, endPressure: 0.4 }),
			lineSegment(200, 0, 300, 0, { startPressure: 0.4, endPressure: 0.2 }),
		];
		const input: RibbonStrokeInput = {
			size: 20,
			opacity: 1,
			flow: 1,
			sizeByPressure: 0,
			colorMode: undefined,
			taperStart: 60,
			taperEnd: 60,
		};

		const sampler = createStrokeHalfWidthSampler({
			storedBrushSettings: raw,
			segments,
		})!;
		const result = generateRibbonInstances(
			segments,
			input,
			0,
			undefined,
			{ ...DEFAULT_RIBBON_OPTIONS, curved: settings },
			0,
			1,
		);
		expect(result.segmentCount).toBeGreaterThan(0);

		for (let i = 0; i < result.segmentCount; i++) {
			const off = i * RIBBON_FLOATS_PER_INSTANCE;
			const hw0 = result.data[off + 8];
			const hw1 = result.data[off + 9];
			const pathT0 = result.data[off + 16];
			const pathT1 = result.data[off + 17];
			expect(sampler.halfWidthAt(pathT0)).toBeCloseTo(hw0, 3);
			expect(sampler.halfWidthAt(pathT1)).toBeCloseTo(hw1, 3);
		}
	});
});

describe("bakeStrokeWidthProfile", () => {
	function dabSettingsWithPressureCurve(): Record<string, unknown> {
		return {
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "buildup",
			properties: {
				size: {
					base: 10,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -0.3],
								[1, 0],
							],
						},
					],
				},
				ratio: { base: 1 },
				flow: { base: 1 },
				spacing: { base: 0.05 },
			},
			randomSeed: 0,
			tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
			taperStart: 50,
		};
	}

	it("should return null when the size has no curves", () => {
		expect(
			bakeStrokeWidthProfile(geometricSettings(), [
				lineSegment(0, 0, 300, 0, { isMoved: true }),
			]),
		).toBeNull();
	});

	it("should bake the varying width into points and strip the size curves", () => {
		const raw = dabSettingsWithPressureCurve();
		const segments = [
			lineSegment(0, 0, 300, 0, {
				isMoved: true,
				startPressure: 1,
				endPressure: 0,
				startDeltaTime: 0,
				endDeltaTime: 300,
			}),
		];

		const baked = bakeStrokeWidthProfile(raw, segments)!;
		expect(baked).not.toBeNull();
		expect(baked.strokeWidths!.length).toBeGreaterThanOrEqual(2);
		expect(baked.brushSettings.properties.size?.curves).toBeUndefined();
		// Taper never bakes into the profile; it stays live in the settings.
		expect(baked.brushSettings.taperStart).toBe(50);

		// Reconstructed width (base × profile) must match the taper-less dab
		// evaluation the renderer would have produced with the curves intact.
		const buffer = evaluateDabs(
			segments,
			normalizeBrushSettingsV2({ ...raw, taperStart: undefined }),
			{},
		);
		const bakedBaseHalf = (baked.brushSettings.properties.size?.base ?? 0) / 2;
		expect(bakedBaseHalf).toBeGreaterThan(0);
		for (let i = 0; i < buffer.count; i++) {
			const pathT = readDabField(buffer.data, i, "pathT");
			const expectedHalf = readDabField(buffer.data, i, "sizeX") * 0.5;
			const ratio = interpolateStrokeWidths(baked.strokeWidths!, pathT).side1;
			expect(Math.abs(bakedBaseHalf * ratio - expectedHalf)).toBeLessThan(0.1);
		}
	});

	it("should fold a constant curve factor into the base without points", () => {
		const baked = bakeStrokeWidthProfile(dabSettingsWithPressureCurve(), [
			lineSegment(0, 0, 300, 0, {
				isMoved: true,
				startPressure: 0.5,
				endPressure: 0.5,
				startDeltaTime: 0,
				endDeltaTime: 300,
			}),
		])!;

		expect(baked.strokeWidths).toBeUndefined();
		// Curve at pressure 0.5 is -0.15 → factor 0.85 → base 10 × 0.85.
		expect(baked.brushSettings.properties.size?.base).toBeCloseTo(8.5, 2);
		expect(baked.brushSettings.properties.size?.curves).toBeUndefined();
	});

	it("should absorb width growth above the base into the baked base", () => {
		const raw = {
			...dabSettingsWithPressureCurve(),
			properties: {
				size: {
					base: 10,
					curves: [
						{
							input: "pressure",
							points: [
								[0, 0],
								[1, 0.5],
							],
						},
					],
				},
				ratio: { base: 1 },
				flow: { base: 1 },
				spacing: { base: 0.05 },
			},
			taperStart: undefined,
		};
		const baked = bakeStrokeWidthProfile(raw, [
			lineSegment(0, 0, 300, 0, {
				isMoved: true,
				startPressure: 1,
				endPressure: 0,
				startDeltaTime: 0,
				endDeltaTime: 300,
			}),
		])!;

		// Peak factor 1.5 at full pressure moves into the base; the profile
		// stays within [0, 1] so the dab stamp clip cannot cut it off.
		expect(baked.brushSettings.properties.size?.base).toBeCloseTo(15, 1);
		const maxSide = Math.max(
			...baked.strokeWidths!.map((point) => point.side1),
		);
		expect(maxSide).toBeLessThanOrEqual(1 + 1e-6);
		expect(maxSide).toBeGreaterThan(0.99);
	});
});

describe("resolveGeometricSizeByPressure", () => {
	it("should read k back off the flat slider's two-point curve", () => {
		const settings = normalizeBrushSettingsV2(
			geometricSettings({
				size: {
					base: 10,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -0.3],
								[1, 0],
							],
						},
					],
				},
			}),
		);
		expect(resolveGeometricSizeByPressure(settings)).toBeCloseTo(0.3, 5);
	});

	it("should return 0 without a pressure curve", () => {
		expect(
			resolveGeometricSizeByPressure(
				normalizeBrushSettingsV2(geometricSettings()),
			),
		).toBe(0);
	});
});

function geometricSettings(
	properties?: Record<string, unknown>,
	overrides?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		version: 2,
		engine: "geometric",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: { size: { base: 10 }, ...properties },
		randomSeed: 1,
		...overrides,
	};
}

function lineSegment(
	startX: number,
	startY: number,
	endX: number,
	endY: number,
	overrides: Partial<CubicBezierSegment> = {},
): CubicBezierSegment {
	return {
		start: { x: startX, y: startY },
		cp1: { x: (endX - startX) / 3, y: (endY - startY) / 3 },
		cp2: { x: (startX - endX) / 3, y: (startY - endY) / 3 },
		end: { x: endX, y: endY },
		isMoved: false,
		startPressure: 1,
		endPressure: 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 1,
		...overrides,
	};
}
