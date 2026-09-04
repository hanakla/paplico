import { describe, expect, it } from "vitest";
import type {
	BezierPoint,
	BrushSettings,
	CubicBezierSegment,
} from "../../../../schema";
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
	polylineSegmentsFromPoints,
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
				stroking: {
					lineCap: "round",
					lineJoin: "round",
					miterLimit: 4,
					dashArray: [10, 10],
				},
			}),
			segments: [lineSegment(0, 0, 300, 0, { isMoved: true })],
		})!;

		expect(sampler.halfWidthAt(0)).toBeCloseTo(5, 5);
	});

	// Golden test against the real evaluator: the sampler must report what the
	// dab pipeline actually stamps, including speed-driven size modulation.
	it("should match the dab evaluator's emitted sizes (pressure + speedFine)", () => {
		const raw: BrushSettings = {
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
		const buffer = evaluateDabs(segments, raw, {
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
		const raw: BrushSettings = {
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
		const settings = raw;
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
	function dabSettingsWithPressureCurve(): BrushSettings {
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

	it("should bake the varying width into ratio points", () => {
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

		const profile = bakeStrokeWidthProfile(raw, segments)!;
		expect(profile).not.toBeNull();
		expect(profile.length).toBeGreaterThanOrEqual(2);

		// Reconstructed width (base × profile) must match the taper-less dab
		// evaluation the renderer would have produced with the curves intact.
		const buffer = evaluateDabs(
			segments,
			{ ...raw, taperStart: undefined },
			{},
		);
		const baseHalf = 10 / 2;
		for (let i = 0; i < buffer.count; i++) {
			const pathT = readDabField(buffer.data, i, "pathT");
			const expectedHalf = readDabField(buffer.data, i, "sizeX") * 0.5;
			const ratio = interpolateStrokeWidths(profile, pathT).side1;
			expect(Math.abs(baseHalf * ratio - expectedHalf)).toBeLessThan(0.1);
		}
	});

	it("should render a baked path identically to the live curve evaluation", () => {
		const raw = { ...dabSettingsWithPressureCurve(), taperStart: undefined };
		const segments = [
			lineSegment(0, 0, 300, 0, {
				isMoved: true,
				startPressure: 1,
				endPressure: 0,
				startDeltaTime: 0,
				endDeltaTime: 300,
			}),
		];
		const profile = bakeStrokeWidthProfile(raw, segments)!;
		const settings = raw;

		// Live path: curves evaluated per dab. Baked path: curves skipped,
		// profile scales the stamp. Both must draw the same widths.
		const live = evaluateDabs(segments, settings, {});
		const bakedRun = evaluateDabs(segments, settings, {
			strokeWidths: profile,
			strokeWidthsBaked: true,
		});
		expect(bakedRun.count).toBeGreaterThan(10);
		expect(Math.abs(bakedRun.count - live.count)).toBeLessThanOrEqual(1);
		const n = Math.min(live.count, bakedRun.count);
		for (let i = 0; i < n; i++) {
			const liveHalf = readDabField(live.data, i, "sizeX") * 0.5;
			const bakedHalf = readDabField(bakedRun.data, i, "sizeX") * 0.5;
			expect(Math.abs(bakedHalf - liveHalf)).toBeLessThan(0.1);
			// No alpha clip in baked mode: the width IS the stamp size.
			expect(readDabField(bakedRun.data, i, "side1Width")).toBe(1);
			expect(readDabField(bakedRun.data, i, "side2Width")).toBe(1);
		}
	});

	it("should return null for a constant profile", () => {
		expect(
			bakeStrokeWidthProfile(dabSettingsWithPressureCurve(), [
				lineSegment(0, 0, 300, 0, {
					isMoved: true,
					startPressure: 0.5,
					endPressure: 0.5,
					startDeltaTime: 0,
					endDeltaTime: 300,
				}),
			]),
		).toBeNull();
	});

	it("should keep speed-driven width variation when baking from the input polyline", () => {
		// A fitted stroke fuses this into one cubic whose linearized timing
		// erases the speed difference — the input polyline must not.
		const points: BezierPoint[] = [];
		let t = 0;
		for (let x = 0; x <= 150; x += 2) {
			points.push({ x, y: 0, pressure: 0.5, deltaTime: t });
			t += 2; // fast half
		}
		for (let x = 152; x <= 300; x += 2) {
			points.push({ x, y: 0, pressure: 0.5, deltaTime: t });
			t += 25; // slow half
		}

		const profile = bakeStrokeWidthProfile(
			{
				...dabSettingsWithPressureCurve(),
				properties: {
					size: {
						base: 10,
						curves: [
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
				taperStart: undefined,
			},
			polylineSegmentsFromPoints(points),
		)!;

		expect(profile).not.toBeNull();
		const fastSide = interpolateStrokeWidths(profile, 0.25).side1;
		const slowSide = interpolateStrokeWidths(profile, 0.75).side1;
		// The fast half must bake meaningfully thinner than the slow half.
		expect(fastSide).toBeLessThan(slowSide * 0.7);
		expect(slowSide).toBeGreaterThan(0.9);
	});

	it("should keep ratios above 1 for width growth (size scaling has no cap)", () => {
		const raw: BrushSettings = {
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
		const profile = bakeStrokeWidthProfile(raw, [
			lineSegment(0, 0, 300, 0, {
				isMoved: true,
				startPressure: 1,
				endPressure: 0,
				startDeltaTime: 0,
				endDeltaTime: 300,
			}),
		])!;

		const maxSide = Math.max(...profile.map((point) => point.side1));
		expect(maxSide).toBeGreaterThan(1.4);
	});
});

describe("resolveGeometricSizeByPressure", () => {
	it("should read k back off the flat slider's two-point curve", () => {
		const settings = geometricSettings({
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
		});
		expect(resolveGeometricSizeByPressure(settings)).toBeCloseTo(0.3, 5);
	});

	it("should return 0 without a pressure curve", () => {
		expect(resolveGeometricSizeByPressure(geometricSettings())).toBe(0);
	});
});

function geometricSettings(
	properties?: BrushSettings["properties"],
	overrides?: Partial<BrushSettings>,
): BrushSettings {
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
