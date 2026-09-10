import {
	resolveColorMatrix,
	type SvgColorMatrixParams,
} from "./SvgColorMatrixHandler";

const IDENTITY = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];

describe("resolveColorMatrix", () => {
	it("should return identity for saturate 1", () => {
		expect(matrix("saturate", [1])).toEqual(IDENTITY);
	});

	it("should use the spec luminance weights for saturate 0", () => {
		const m = matrix("saturate", [0]);
		for (const row of [0, 1, 2]) {
			expect(m.slice(row * 5, row * 5 + 5)).toEqual([
				0.213, 0.715, 0.072, 0, 0,
			]);
		}
		expect(m.slice(15)).toEqual([0, 0, 0, 1, 0]);
	});

	it("should return identity for hueRotate 0", () => {
		expect(matrix("hueRotate", [0])).toEqual(IDENTITY);
	});

	it("should match the spec formula for hueRotate 180", () => {
		// cos = -1, sin = 0: base minus the cosine term.
		const expected = [
			0.213 - 0.787,
			0.715 + 0.715,
			0.072 + 0.072,
			0,
			0,
			0.213 + 0.213,
			0.715 - 0.285,
			0.072 + 0.072,
			0,
			0,
			0.213 + 0.213,
			0.715 + 0.715,
			0.072 - 0.928,
			0,
			0,
			0,
			0,
			0,
			1,
			0,
		];
		const m = matrix("hueRotate", [180]);
		for (const [i, v] of m.entries()) {
			expect(v).toBeCloseTo(expected[i], 10);
		}
	});

	it("should write the luminance weights into the alpha row for luminanceToAlpha", () => {
		const m = matrix("luminanceToAlpha", []);
		expect(m.slice(0, 15).every((v) => v === 0)).toBe(true);
		expect(m.slice(15)).toEqual([0.2125, 0.7154, 0.0721, 0, 0]);
	});

	it("should fall back to identity when a matrix has too few values", () => {
		expect(matrix("matrix", [1, 2, 3])).toEqual(IDENTITY);
	});
});

function matrix(
	type: SvgColorMatrixParams["type"],
	values: number[],
): number[] {
	return resolveColorMatrix({ in: "previous", type, values });
}
