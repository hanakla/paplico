import { describe, expect, it } from "vitest";
import type { Color, StrokeColor } from "../schema";
import { buildStrokePaintKey, isStrokePaintSemiTransparent } from "./helpers";

describe("buildStrokePaintKey", () => {
	it("should change when the alpha multiplier changes", () => {
		const stroke = solidStroke(1);

		expect(buildStrokePaintKey(stroke, 1)).not.toBe(
			buildStrokePaintKey(stroke, 0.5),
		);
	});

	it("should change when the stroke color changes", () => {
		expect(buildStrokePaintKey(solidStroke(1), 1)).not.toBe(
			buildStrokePaintKey(solidStroke(1, { r: 0, g: 1, b: 0 }), 1),
		);
	});

	it("should collapse a color alpha and a multiplier with the same product", () => {
		// Both bake the same vertex alpha, so they can share cached vertices.
		expect(buildStrokePaintKey(solidStroke(0.5), 1)).toBe(
			buildStrokePaintKey(solidStroke(1), 0.5),
		);
	});

	it("should key gradients by the multiplier alone", () => {
		expect(buildStrokePaintKey(gradientStroke(1), 0.25)).toBe(
			buildStrokePaintKey(gradientStroke(0.5), 0.25),
		);
		expect(buildStrokePaintKey(gradientStroke(1), 0.25)).not.toBe(
			buildStrokePaintKey(gradientStroke(1), 1),
		);
	});
});

describe("isStrokePaintSemiTransparent", () => {
	it("should report an opaque solid stroke at full multiplier as opaque", () => {
		expect(isStrokePaintSemiTransparent(solidStroke(1), 1)).toBe(false);
	});

	it("should report a see-through color as semi-transparent", () => {
		expect(isStrokePaintSemiTransparent(solidStroke(0.4), 1)).toBe(true);
	});

	it("should report an opaque color under a reduced multiplier as semi-transparent", () => {
		expect(isStrokePaintSemiTransparent(solidStroke(1), 0.4)).toBe(true);
	});

	it("should report a gradient with any see-through stop as semi-transparent", () => {
		expect(isStrokePaintSemiTransparent(gradientStroke(0.2), 1)).toBe(true);
		expect(isStrokePaintSemiTransparent(gradientStroke(1), 1)).toBe(false);
	});
});

function rgb(a: number, base = { r: 1, g: 0, b: 0 }): Color {
	return { type: "rgb", r: base.r, g: base.g, b: base.b, a };
}

function solidStroke(
	alpha: number,
	base?: { r: number; g: number; b: number },
): StrokeColor {
	return { type: "solid", color: rgb(alpha, base) };
}

/** Two-stop gradient whose second stop carries `lastStopAlpha`. */
function gradientStroke(lastStopAlpha: number): StrokeColor {
	return {
		type: "stroke-gradient",
		mode: "within",
		gradient: {
			type: "linear",
			x1: 0,
			y1: 0,
			x2: 1,
			y2: 0,
			stops: [
				{ offset: 0, color: rgb(1), midpoint: 0.5 },
				{ offset: 1, color: rgb(lastStopAlpha), midpoint: 0.5 },
			],
		},
	};
}
