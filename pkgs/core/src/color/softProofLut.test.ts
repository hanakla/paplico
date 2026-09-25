import { describe, expect, it } from "vitest";
import { buildLutGridRgb, packRgbToRgba } from "./softProofLut";

describe("buildLutGridRgb", () => {
	it("should produce size^3 RGB triplets", () => {
		const grid = buildLutGridRgb(5);
		expect(grid.length).toBe(5 ** 3 * 3);
	});

	it("should lay out entries with red varying fastest, then green, then blue", () => {
		const size = 3;
		const grid = buildLutGridRgb(size);
		const entry = (r: number, g: number, b: number) => {
			const idx = ((b * size + g) * size + r) * 3;
			return [grid[idx], grid[idx + 1], grid[idx + 2]];
		};
		expect(entry(0, 0, 0)).toEqual([0, 0, 0]);
		expect(entry(1, 0, 0)).toEqual([128, 0, 0]);
		expect(entry(0, 1, 0)).toEqual([0, 128, 0]);
		expect(entry(0, 0, 1)).toEqual([0, 0, 128]);
		expect(entry(2, 2, 2)).toEqual([255, 255, 255]);
	});

	it("should span the full 0-255 range inclusive on each axis", () => {
		const size = 9;
		const grid = buildLutGridRgb(size);
		const lastEntry = (size ** 3 - 1) * 3;
		expect([grid[0], grid[1], grid[2]]).toEqual([0, 0, 0]);
		expect([grid[lastEntry], grid[lastEntry + 1], grid[lastEntry + 2]]).toEqual(
			[255, 255, 255],
		);
	});

	it("should throw when the grid size is smaller than 2", () => {
		expect(() => buildLutGridRgb(1)).toThrow(/grid size/);
	});
});

describe("packRgbToRgba", () => {
	it("should pack RGB triplets into RGBA with opaque alpha", () => {
		const rgba = packRgbToRgba(new Uint8ClampedArray([1, 2, 3, 4, 5, 6]));
		expect(rgba).toBeInstanceOf(Uint8Array);
		expect(Array.from(rgba)).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
	});

	it("should throw when the input length is not a multiple of 3", () => {
		expect(() => packRgbToRgba(new Uint8ClampedArray(4))).toThrow(
			/multiple of 3/,
		);
	});
});
