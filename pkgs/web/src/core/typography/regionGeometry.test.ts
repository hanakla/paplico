import { describe, expect, it } from "vitest";
import type { CubicBezierSegment, Point } from "../schema";
import { closedRectSegments, lineSeg } from "../testUtils/segmentFactory";
import {
	classifyPathForTextBinding,
	flattenClosedSubpaths,
	intervalsForBand,
} from "./regionGeometry";

/** Axis-aligned square as a closed subpath of straight-line beziers */
const squareSegments = (
	x0: number,
	y0: number,
	size: number,
): CubicBezierSegment[] => closedRectSegments(x0, y0, x0 + size, y0 + size);

const squarePolygon = (x0: number, y0: number, size: number): Point[] => [
	{ x: x0, y: y0 },
	{ x: x0 + size, y: y0 },
	{ x: x0 + size, y: y0 + size },
	{ x: x0, y: y0 + size },
];

describe("classifyPathForTextBinding", () => {
	it("should classify an open path as onPath", () => {
		const segments = [
			lineSeg({ x: 100, y: 0 }, { start: { x: 0, y: 0 } }),
			lineSeg({ x: 200, y: 50 }),
		];
		expect(classifyPathForTextBinding(segments)).toBe("onPath");
	});

	it("should classify a closed path as inShape", () => {
		expect(classifyPathForTextBinding(squareSegments(0, 0, 100))).toBe(
			"inShape",
		);
	});

	it("should classify a mix of open and closed subpaths as inShape", () => {
		const segments = [
			lineSeg({ x: 100, y: 0 }, { start: { x: 0, y: 0 } }),
			...squareSegments(200, 0, 50).map((s, i) =>
				i === 0 ? { ...s, isMoved: true } : s,
			),
		];
		expect(classifyPathForTextBinding(segments)).toBe("inShape");
	});
});

describe("flattenClosedSubpaths", () => {
	it("should return one polygon for a closed square and hit its corners", () => {
		const polygons = flattenClosedSubpaths(squareSegments(0, 0, 100));
		expect(polygons).toHaveLength(1);
		const xs = polygons[0].map((p) => p.x);
		const ys = polygons[0].map((p) => p.y);
		expect(Math.min(...xs)).toBeCloseTo(0);
		expect(Math.max(...xs)).toBeCloseTo(100);
		expect(Math.min(...ys)).toBeCloseTo(0);
		expect(Math.max(...ys)).toBeCloseTo(100);
	});

	it("should exclude open subpaths", () => {
		const open = [
			lineSeg({ x: 100, y: 0 }, { start: { x: 0, y: 0 } }),
			lineSeg({ x: 200, y: 50 }),
		];
		expect(flattenClosedSubpaths(open)).toHaveLength(0);
	});

	it("should return two polygons for a donut (outer + hole subpaths)", () => {
		const donut = [
			...squareSegments(0, 0, 100),
			...squareSegments(25, 25, 50).map((s, i) =>
				i === 0 ? { ...s, isMoved: true } : s,
			),
		];
		expect(flattenClosedSubpaths(donut)).toHaveLength(2);
	});
});

describe("intervalsForBand", () => {
	it("should return the full width for a band inside a square", () => {
		const intervals = intervalsForBand([squarePolygon(0, 0, 100)], 10, 30);
		expect(intervals).toHaveLength(1);
		expect(intervals[0].x0).toBeCloseTo(0);
		expect(intervals[0].x1).toBeCloseTo(100);
	});

	it("should return empty for a band outside the region", () => {
		expect(intervalsForBand([squarePolygon(0, 0, 100)], 150, 170)).toHaveLength(
			0,
		);
	});

	it("should return the conservative common interval for a triangle band", () => {
		// Triangle: apex at top (50, 0), base from (0, 100) to (100, 100)
		const triangle: Point[] = [
			{ x: 50, y: 0 },
			{ x: 100, y: 100 },
			{ x: 0, y: 100 },
		];
		const intervals = intervalsForBand([triangle], 40, 60);
		expect(intervals).toHaveLength(1);
		// Narrower edge (y=40) wins: width there is 40% of base
		expect(intervals[0].x0).toBeCloseTo(30);
		expect(intervals[0].x1).toBeCloseTo(70);
	});

	it("should return two intervals inside a concave U shape", () => {
		// U shape: two towers connected at the bottom
		const u: Point[] = [
			{ x: 0, y: 0 },
			{ x: 30, y: 0 },
			{ x: 30, y: 60 },
			{ x: 70, y: 60 },
			{ x: 70, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 100 },
			{ x: 0, y: 100 },
		];
		const intervals = intervalsForBand([u], 10, 30);
		expect(intervals).toHaveLength(2);
		expect(intervals[0].x0).toBeCloseTo(0);
		expect(intervals[0].x1).toBeCloseTo(30);
		expect(intervals[1].x0).toBeCloseTo(70);
		expect(intervals[1].x1).toBeCloseTo(100);
	});

	it("should exclude the hole of a donut region (even-odd)", () => {
		const polygons = [squarePolygon(0, 0, 100), squarePolygon(25, 25, 50)];
		const intervals = intervalsForBand(polygons, 40, 60);
		expect(intervals).toHaveLength(2);
		expect(intervals[0].x0).toBeCloseTo(0);
		expect(intervals[0].x1).toBeCloseTo(25);
		expect(intervals[1].x0).toBeCloseTo(75);
		expect(intervals[1].x1).toBeCloseTo(100);
	});

	it("should shrink intervals by inset and drop collapsed ones", () => {
		const withInset = intervalsForBand([squarePolygon(0, 0, 100)], 10, 30, 10);
		expect(withInset).toHaveLength(1);
		expect(withInset[0].x0).toBeCloseTo(10);
		expect(withInset[0].x1).toBeCloseTo(90);

		expect(
			intervalsForBand([squarePolygon(0, 0, 100)], 10, 30, 60),
		).toHaveLength(0);
	});
});
