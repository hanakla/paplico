import { normalizeBrushSettingsV2 } from "../../../../brush/migrate";
import type { BrushSettingsV2, CubicBezierSegment } from "../../../../schema";
import { evaluateDabs } from "./DabEvaluator";
import { readDabField } from "./DabInstanceLayout";

/** Straight line from (0,0) to (100,0): collinear controls, arc length 100. */
function lineSegment(
	overrides: Partial<CubicBezierSegment> = {},
): CubicBezierSegment {
	return {
		start: { x: 0, y: 0 },
		cp1: { x: 33, y: 0 },
		cp2: { x: -33, y: 0 },
		end: { x: 100, y: 0 },
		startPressure: 0.5,
		endPressure: 0.5,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 100,
		isMoved: true,
		...overrides,
	};
}

function dabSettings(overrides: Record<string, unknown> = {}): BrushSettingsV2 {
	return normalizeBrushSettingsV2({
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: {
			size: { base: 10 },
			spacing: { base: 0.2 },
			flow: { base: 1 },
		},
		tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
		randomSeed: 1,
		...overrides,
	});
}

describe("evaluateDabs", () => {
	describe("spacing integration (Krita min-of-distance-and-time)", () => {
		it("should place dabs at fixed distance intervals when time dabs are off", () => {
			const result = evaluateDabs([lineSegment()], dabSettings());
			// size 10 * spacing 0.2 = one dab every 2 world units over 100 units.
			expect(result.count).toBe(51);
			expect(readDabField(result.data, 0, "positionX")).toBeCloseTo(0, 5);
			expect(readDabField(result.data, 1, "positionX")).toBeCloseTo(2, 1);
			expect(
				readDabField(result.data, result.count - 1, "positionX"),
			).toBeCloseTo(100, 1);
		});

		it("should emit time-based dabs when the timed interval fires first", () => {
			// 10_000 ms over 100 units: distance threshold (2 units = 200 ms)
			// loses against the 10 ms timed interval (dabsPerSecond 100).
			const settings = dabSettings({
				properties: {
					size: { base: 10 },
					spacing: { base: 0.2 },
					flow: { base: 1 },
					dabsPerSecond: { base: 100 },
				},
			});
			const result = evaluateDabs(
				[lineSegment({ endDeltaTime: 10_000 })],
				settings,
			);
			expect(result.count).toBeGreaterThanOrEqual(999);
			expect(result.count).toBeLessThanOrEqual(1003);
		});

		it("should keep distance dabs when they fire faster than the timed interval", () => {
			// 100 ms over 100 units: distance threshold (2 units = 2 ms) wins
			// against the 10 ms interval, so the count matches distance-only.
			const settings = dabSettings({
				properties: {
					size: { base: 10 },
					spacing: { base: 0.2 },
					flow: { base: 1 },
					dabsPerSecond: { base: 100 },
				},
			});
			const result = evaluateDabs([lineSegment()], settings);
			expect(result.count).toBe(51);
		});
	});

	describe("curve matrix evaluation", () => {
		it("should reproduce the v1 pressure-size formula on emitted dabs", () => {
			const k = 0.5;
			const settings = dabSettings({
				properties: {
					size: {
						base: 10,
						curves: [
							{
								input: "pressure",
								points: [
									[0, -k],
									[1, 0],
								],
							},
						],
					},
					spacing: { base: 0.2 },
					flow: { base: 1 },
				},
			});
			const result = evaluateDabs(
				[lineSegment({ startPressure: 0, endPressure: 1 })],
				settings,
			);
			// First dab at pressure 0 -> size 5; last dab at pressure 1 -> size 10.
			expect(readDabField(result.data, 0, "sizeX")).toBeCloseTo(
				10 * (1 - k),
				4,
			);
			expect(readDabField(result.data, result.count - 1, "sizeX")).toBeCloseTo(
				10,
				4,
			);
		});
	});

	describe("determinism", () => {
		it("should produce byte-identical buffers for identical inputs", () => {
			const settings = dabSettings({
				properties: {
					size: { base: 10 },
					spacing: { base: 0.2 },
					flow: { base: 1 },
					angle: {
						base: 0,
						curves: [
							{
								input: "randomPerDab",
								points: [
									[0, -Math.PI],
									[1, Math.PI],
								],
							},
						],
					},
				},
			});
			const a = evaluateDabs([lineSegment()], settings);
			const b = evaluateDabs([lineSegment()], settings);
			expect(a.count).toBe(b.count);
			expect(
				Buffer.from(a.data.buffer, 0, a.count * 4).equals(
					Buffer.from(b.data.buffer, 0, b.count * 4),
				),
			).toBe(true);
		});
	});

	describe("opaque_linearize", () => {
		it("should compensate buildup dab alpha for the expected overlap", () => {
			const settings = dabSettings({
				properties: {
					size: { base: 10 },
					spacing: { base: 0.2 },
					flow: { base: 0.5 },
				},
			});
			const result = evaluateDabs([lineSegment()], settings);
			const dabsPerPixel = 1 + 0.9 * (1 / 0.2 - 1);
			const expected = 1 - (1 - 0.5) ** (1 / dabsPerPixel);
			expect(readDabField(result.data, 0, "alpha")).toBeCloseTo(expected, 5);
		});

		it("should write plain flow as alpha in wash mode", () => {
			const settings = dabSettings({
				paintMode: "wash",
				properties: {
					size: { base: 10 },
					spacing: { base: 0.2 },
					flow: { base: 0.5 },
				},
			});
			const result = evaluateDabs([lineSegment()], settings);
			expect(readDabField(result.data, 0, "alpha")).toBeCloseTo(0.5, 5);
		});
	});

	describe("collaboration fragments", () => {
		it("should suppress the ramp-in for mid-stroke fragments", () => {
			const settings = dabSettings({
				properties: {
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
					spacing: { base: 0.2 },
					flow: { base: 1 },
				},
			});
			const segment = lineSegment({ startPressure: 0.2, endPressure: 0.9 });

			const head = evaluateDabs([segment], settings, {
				pathStart: 0,
				pathEnd: 1,
			});
			const midFragment = evaluateDabs([segment], settings, {
				pathStart: 0.5,
				pathEnd: 1,
			});

			// Fresh stroke starts at startPressure (0.2 -> size 2); a mid-stroke
			// fragment seeds from endPressure (0.9 -> size 9).
			expect(readDabField(head.data, 0, "sizeX")).toBeCloseTo(2, 4);
			expect(readDabField(midFragment.data, 0, "sizeX")).toBeCloseTo(9, 4);
		});
	});

	describe("wet gate", () => {
		it("should write wet seed fields only while wet is enabled", () => {
			const wetOn = dabSettings({
				paintMode: "wash",
				wet: {
					enabled: true,
					bleedRadius: 0.5,
					pigmentLoad: 0.85,
					grainScale: 1,
				},
				properties: {
					size: { base: 10 },
					spacing: { base: 0.2 },
					flow: { base: 1 },
					wetness: { base: 0.7 },
					directionality: { base: 0.4 },
					grainAmount: { base: 0.2 },
				},
			});
			const wetOff = dabSettings({
				properties: {
					size: { base: 10 },
					spacing: { base: 0.2 },
					flow: { base: 1 },
					wetness: { base: 0.7 },
					directionality: { base: 0.4 },
					grainAmount: { base: 0.2 },
				},
			});

			const on = evaluateDabs([lineSegment()], wetOn);
			const off = evaluateDabs([lineSegment()], wetOff);

			expect(readDabField(on.data, 0, "wetness")).toBeCloseTo(0.7, 5);
			expect(readDabField(on.data, 0, "directionality")).toBeCloseTo(0.4, 5);
			expect(readDabField(on.data, 0, "grainAmount")).toBeCloseTo(0.2, 5);
			expect(readDabField(off.data, 0, "wetness")).toBe(0);
			expect(readDabField(off.data, 0, "directionality")).toBe(0);
			expect(readDabField(off.data, 0, "grainAmount")).toBe(0);
		});
	});
});
