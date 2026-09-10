import { describe, expect, it } from "vitest";
import { colorFunctionMatrix } from "./SvgColorFunctionHandler";
import { SVG_COLOR_MATRIX_IDENTITY } from "./SvgColorMatrixHandler";

const apply = (m: number[], rgb: [number, number, number]) =>
	[0, 1, 2].map(
		(row) =>
			m[row * 5] * rgb[0] +
			m[row * 5 + 1] * rgb[1] +
			m[row * 5 + 2] * rgb[2] +
			m[row * 5 + 4],
	);

describe("colorFunctionMatrix", () => {
	it("should be the identity at each function's neutral amount", () => {
		for (const [fn, amount] of [
			["saturate", 1],
			["hue-rotate", 0],
			["grayscale", 0],
			["sepia", 0],
			["invert", 0],
			["brightness", 1],
			["contrast", 1],
		] as const) {
			const m = colorFunctionMatrix(fn, amount);
			for (const [i, v] of m.entries()) {
				expect(v, `${fn}[${i}]`).toBeCloseTo(SVG_COLOR_MATRIX_IDENTITY[i], 10);
			}
		}
	});

	it("should invert colors fully at invert(1) and leave mid gray alone", () => {
		const m = colorFunctionMatrix("invert", 1);
		expect(apply(m, [1, 0, 0.25])).toEqual([0, 1, 0.75]);
		expect(apply(m, [0.5, 0.5, 0.5])).toEqual([0.5, 0.5, 0.5]);
	});

	it("should scale around mid gray for contrast and from black for brightness", () => {
		expect(
			apply(colorFunctionMatrix("contrast", 2), [0.75, 0.5, 0.25]),
		).toEqual([1, 0.5, 0]);
		expect(apply(colorFunctionMatrix("brightness", 0.5), [1, 0.5, 0])).toEqual([
			0.5, 0.25, 0,
		]);
	});

	it("should turn grayscale(1) into the luminance weights", () => {
		const gray = apply(colorFunctionMatrix("grayscale", 1), [1, 0, 0]);
		expect(gray[0]).toBeCloseTo(0.213, 5);
		expect(gray[1]).toBeCloseTo(0.213, 5);
		expect(gray[2]).toBeCloseTo(0.213, 5);
	});

	it("should clamp the 0..1 functions above 1", () => {
		expect(colorFunctionMatrix("sepia", 3)).toEqual(
			colorFunctionMatrix("sepia", 1),
		);
	});
});
