import { describe, expect, it } from "vitest";
import type { BrushSettings, CubicBezierSegment } from "../../../../schema";
import {
	DEFAULT_RIBBON_OPTIONS,
	generateRibbonInstances,
	type RibbonStrokeInput,
} from "./RibbonGenerator";

describe("generateRibbonInstances — signed stroke widths", () => {
	it("should preserve negative side widths at segment endpoints", () => {
		const result = generateRibbonInstances(
			[straightSegment()],
			patternSettings(),
			0,
			[
				{ t: 0, side1: -0.5, side2: 1 },
				{ t: 1, side1: -1.5, side2: 0.75 },
			],
		);

		expect(result.segmentCount).toBe(1);
		expect(result.data[10]).toBeCloseTo(-0.5, 5);
		expect(result.data[11]).toBeCloseTo(-1.5, 5);
		expect(result.data[12]).toBeCloseTo(1, 5);
		expect(result.data[13]).toBeCloseTo(0.75, 5);
	});

	it("should split a cubic at interior stroke-width control points", () => {
		const result = generateRibbonInstances(
			[straightSegment()],
			patternSettings(),
			0,
			[
				{ t: 0, side1: 1, side2: 1 },
				{ t: 0.5, side1: -0.5, side2: 0.75 },
				{ t: 1, side1: 0.25, side2: 1 },
			],
		);

		expect(result.segmentCount).toBe(2);
		expect(result.data[6]).toBeCloseTo(50, 1);
		expect(result.data[16]).toBeCloseTo(0, 5);
		expect(result.data[17]).toBeCloseTo(0.5, 5);
		expect(result.data[11]).toBeCloseTo(-0.5, 5);
		expect(result.data[13]).toBeCloseTo(0.75, 5);

		const second = 28;
		expect(result.data[second]).toBeCloseTo(50, 1);
		expect(result.data[second + 16]).toBeCloseTo(0.5, 5);
		expect(result.data[second + 17]).toBeCloseTo(1, 5);
		expect(result.data[second + 10]).toBeCloseTo(-0.5, 5);
		expect(result.data[second + 12]).toBeCloseTo(0.75, 5);
	});

	it("should join the first and last instances of a closed ribbon", () => {
		const result = generateRibbonInstances(
			[
				lineSegment(0, 0, 100, 0, true),
				lineSegment(100, 0, 100, 100),
				lineSegment(100, 100, 0, 100),
				lineSegment(0, 100, 0, 0),
			],
			patternSettings(),
		);

		expect(result.segmentCount).toBe(4);
		const firstStartJoin = result.data[22];
		const lastEndJoin = result.data[3 * 28 + 23];
		expect(Math.abs(firstStartJoin)).toBeLessThan(1e20);
		expect(lastEndJoin).toBeCloseTo(firstStartJoin, 5);
	});
});

describe("generateRibbonInstances — v2 curves", () => {
	it("should modulate the half width by the size curve at segment ends", () => {
		const result = generateRibbonInstances(
			[straightSegment({ startPressure: 0, endPressure: 1 })],
			patternSettings(),
			0,
			undefined,
			{
				...DEFAULT_RIBBON_OPTIONS,
				curved: curvedSettings({
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
				}),
			},
		);

		// scale domain: pressure 0 halves the base, pressure 1 leaves it.
		expect(result.data[8]).toBeCloseTo(5, 4);
		expect(result.data[9]).toBeCloseTo(10, 4);
	});

	it("should leave the width to the flat pressure factor without curves", () => {
		const result = generateRibbonInstances(
			[straightSegment({ startPressure: 0, endPressure: 1 })],
			{ ...patternSettings(), sizeByPressure: 1 },
			0,
		);

		expect(result.data[8]).toBeCloseTo(0, 4);
		expect(result.data[9]).toBeCloseTo(5, 4);
	});

	it("should scale opacity by the flow curve", () => {
		const opacityOf = (flowBase: number): number =>
			generateRibbonInstances(
				[straightSegment()],
				patternSettings(),
				0,
				undefined,
				{
					...DEFAULT_RIBBON_OPTIONS,
					curved: curvedSettings({ flow: { base: flowBase } }),
				},
			).data[20];

		expect(opacityOf(1)).toBeCloseTo(1, 4);
		expect(opacityOf(0.5)).toBeCloseTo(0.5, 4);
	});
});

function curvedSettings(properties: Record<string, unknown>): BrushSettings {
	return {
		version: 2,
		engine: "ribbon",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: { size: { base: 10 }, flow: { base: 1 }, ...properties },
		randomSeed: 1,
	};
}

function straightSegment(
	overrides: Partial<CubicBezierSegment> = {},
): CubicBezierSegment {
	return {
		start: { x: 0, y: 0 },
		cp1: { x: 33, y: 0 },
		cp2: { x: -33, y: 0 },
		end: { x: 100, y: 0 },
		isMoved: true,
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

function lineSegment(
	startX: number,
	startY: number,
	endX: number,
	endY: number,
	isMoved: boolean = false,
): CubicBezierSegment {
	return {
		...straightSegment(),
		start: { x: startX, y: startY },
		cp1: { x: (endX - startX) / 3, y: (endY - startY) / 3 },
		cp2: { x: (startX - endX) / 3, y: (startY - endY) / 3 },
		end: { x: endX, y: endY },
		isMoved,
	};
}

function patternSettings(): RibbonStrokeInput {
	return {
		size: 10,
		opacity: 1,
		flow: 1,
		sizeByPressure: 0,
		colorMode: undefined,
		taperStart: undefined,
		taperEnd: undefined,
	};
}
