import { describe, expect, it } from "vitest";
import {
	computeQuadProjectiveWeights,
	type QuadCorners,
	quadOfBounds,
} from "./quadProjection";

describe("computeQuadProjectiveWeights", () => {
	it("should weight a rectangle's corners uniformly", () => {
		// The shader divides the interpolated uv·q by the interpolated q, so a
		// constant weight cancels: a rectangle keeps plain bilinear mapping.
		const rect: QuadCorners = [
			{ x: 0, y: 10 },
			{ x: 20, y: 10 },
			{ x: 20, y: 0 },
			{ x: 0, y: 0 },
		];

		const [tl, tr, br, bl] = computeQuadProjectiveWeights(rect);

		expect(tr).toBeCloseTo(tl, 6);
		expect(br).toBeCloseTo(tl, 6);
		expect(bl).toBeCloseTo(tl, 6);
	});

	it("should weight a rotated square's corners uniformly", () => {
		// A rotation is still a parallelogram, so bilinear interpolation is
		// already the projective mapping — the correction must not distort it.
		const angle = Math.PI / 4;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		const rotate = (x: number, y: number) => ({
			x: x * cos - y * sin,
			y: x * sin + y * cos,
		});
		const rotated: QuadCorners = [
			rotate(-10, 10),
			rotate(10, 10),
			rotate(10, -10),
			rotate(-10, -10),
		];

		const [tl, tr, br, bl] = computeQuadProjectiveWeights(rotated);

		expect(tr).toBeCloseTo(tl, 6);
		expect(br).toBeCloseTo(tl, 6);
		expect(bl).toBeCloseTo(tl, 6);
	});

	it("should weight a trapezoid's wide edge by the edge-length ratio", () => {
		// Bottom edge twice the top edge: the diagonals cross off-center, and
		// the wide corners' weights come out exactly twice the narrow ones.
		const trapezoid: QuadCorners = [
			{ x: -5, y: 10 },
			{ x: 5, y: 10 },
			{ x: 10, y: 0 },
			{ x: -10, y: 0 },
		];

		const [tl, tr, br, bl] = computeQuadProjectiveWeights(trapezoid);

		expect(tr).toBeCloseTo(tl, 6);
		expect(bl).toBeCloseTo(br, 6);
		expect(br / tl).toBeCloseTo(2, 4);
	});

	it("should return neutral weights when the quad is degenerate", () => {
		const collapsed: QuadCorners = [
			{ x: 0, y: 0 },
			{ x: 0, y: 0 },
			{ x: 0, y: 0 },
			{ x: 0, y: 0 },
		];

		expect(computeQuadProjectiveWeights(collapsed)).toEqual([1, 1, 1, 1]);
	});

	it("should return neutral weights when the quad is non-convex", () => {
		// The diagonals no longer cross inside the quad, so the projective
		// correction is undefined and bilinear is the only sane fallback.
		const bowtie: QuadCorners = [
			{ x: 0, y: 10 },
			{ x: 10, y: 10 },
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
		];

		expect(computeQuadProjectiveWeights(bowtie)).toEqual([1, 1, 1, 1]);
	});
});

describe("quadOfBounds", () => {
	it("should order the corners TL, TR, BR, BL in world space (Y up)", () => {
		expect(quadOfBounds({ minX: -1, minY: -2, maxX: 3, maxY: 4 })).toEqual([
			{ x: -1, y: 4 },
			{ x: 3, y: 4 },
			{ x: 3, y: -2 },
			{ x: -1, y: -2 },
		]);
	});
});
