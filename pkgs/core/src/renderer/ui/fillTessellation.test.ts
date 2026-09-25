import { describe, expect, it } from "vitest";
import { type FillPoint, triangulateFillContour } from "./fillTessellation";

describe("triangulateFillContour", () => {
	it("should triangulate a rectangle without marking the internal diagonal as a boundary", () => {
		const triangles = triangulateFillContour([
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 5 },
			{ x: 0, y: 5 },
		]);

		expect(triangles).toHaveLength(2);
		expect(totalArea(triangles)).toBe(50);
		expect(
			triangles.reduce((count, { boundaryMask }) => {
				return count + bitCount(boundaryMask);
			}, 0),
		).toBe(4);
	});

	it("should preserve the area of a concave contour", () => {
		const contour = [
			{ x: 0, y: 0 },
			{ x: 6, y: 0 },
			{ x: 6, y: 4 },
			{ x: 3, y: 2 },
			{ x: 0, y: 4 },
		];

		expect(totalArea(triangulateFillContour(contour))).toBe(
			polygonArea(contour),
		);
	});

	it("should ignore a duplicated closing point", () => {
		const contour = [
			{ x: 0, y: 0 },
			{ x: 4, y: 0 },
			{ x: 0, y: 4 },
			{ x: 0, y: 0 },
		];

		expect(triangulateFillContour(contour)).toHaveLength(1);
	});

	it("should emit no triangles for a degenerate contour", () => {
		expect(
			triangulateFillContour([
				{ x: 0, y: 0 },
				{ x: 1, y: 1 },
			]),
		).toEqual([]);
	});
});

function totalArea(
	triangles: ReturnType<typeof triangulateFillContour>,
): number {
	return triangles.reduce((area, { p0, p1, p2 }) => {
		return (
			area +
			Math.abs((p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y)) /
				2
		);
	}, 0);
}

function polygonArea(points: readonly FillPoint[]): number {
	let twiceArea = 0;
	for (let i = 0; i < points.length; i++) {
		const current = points[i];
		const next = points[(i + 1) % points.length];
		twiceArea += current.x * next.y - next.x * current.y;
	}
	return Math.abs(twiceArea) / 2;
}

function bitCount(value: number): number {
	let count = 0;
	for (let remaining = value; remaining > 0; remaining >>= 1) {
		count += remaining & 1;
	}
	return count;
}
