import {
	describe,
	expect,
	it,
} from "../../../../../../node_modules/vitest/dist/index";
import type { BoundingBox, FilterEntry, Path } from "../../../schema";
import { closedRectSegments, lineSeg } from "../../../testUtils/segmentFactory";
import {
	evalCubicBezier,
	evalCubicBezierDerivative,
} from "../primitives/bezier";
import { resolveSegment } from "../primitives/segment";
import {
	boundsIntersect,
	doesPathIntersectRect,
	isPointInPath,
	isPointNearSegments,
	isPointOnPath,
	pointInBounds,
} from "./hitTest";

describe("pointInBounds", () => {
	const bounds: BoundingBox = {
		minX: 10,
		minY: 20,
		maxX: 30,
		maxY: 40,
		width: 20,
		height: 20,
	};

	it("should return true for point inside bounds", () => {
		expect(pointInBounds(15, 25, bounds)).toBe(true);
		expect(pointInBounds(20, 30, bounds)).toBe(true);
	});

	it("should return true for point on bounds edge", () => {
		expect(pointInBounds(10, 20, bounds)).toBe(true);
		expect(pointInBounds(30, 40, bounds)).toBe(true);
		expect(pointInBounds(10, 40, bounds)).toBe(true);
		expect(pointInBounds(30, 20, bounds)).toBe(true);
	});

	it("should return false for point outside bounds", () => {
		expect(pointInBounds(5, 25, bounds)).toBe(false);
		expect(pointInBounds(35, 30, bounds)).toBe(false);
		expect(pointInBounds(20, 15, bounds)).toBe(false);
		expect(pointInBounds(20, 45, bounds)).toBe(false);
	});
});

describe("isPointInPath", () => {
	it("should treat a chain of isMoved sides as one polygon", () => {
		// Like an image quad: every side restates its start and is isMoved,
		// yet the sides chain end-to-start into a single polygon.
		const rect = closedRectSegments(0, 0, 100, 100);
		const sides = rect.map((segment, i) => ({
			...segment,
			start: segment.start ?? rect[i - 1].end,
			isMoved: true,
		}));
		expect(isPointInPath(50, 50, { segments: sides })).toBe(true);
		expect(isPointInPath(150, 50, { segments: sides })).toBe(false);
	});

	it("should not fill the gap between two separate contours", () => {
		const segments = [
			...closedRectSegments(0, 0, 100, 100),
			...closedRectSegments(0, 200, 100, 300),
		];
		expect(isPointInPath(50, 50, { segments })).toBe(true);
		expect(isPointInPath(50, 250, { segments })).toBe(true);
		expect(isPointInPath(50, 150, { segments })).toBe(false);
		// Left of both squares, where an edge joining the second contour's
		// end to the first contour's start would cross a ray cast to +x.
		expect(isPointInPath(-50, 150, { segments })).toBe(false);
	});

	it("should follow a symmetric S-shaped edge instead of its chord", () => {
		// The top edge bulges above y=0 near x=25 and dips below it near x=75,
		// and its midpoint lies exactly on the chord.
		const segments = [
			lineSeg(
				{ x: 100, y: 0 },
				{
					start: { x: 0, y: 0 },
					cp1: { x: 25, y: 80 },
					cp2: { x: -25, y: -80 },
				},
			),
			lineSeg({ x: 100, y: -100 }),
			lineSeg({ x: 0, y: -100 }),
			lineSeg({ x: 0, y: 0 }, { isClosed: true }),
		];

		expect(isPointInPath(25, 10, { segments })).toBe(true);
		expect(isPointInPath(75, -10, { segments })).toBe(false);
	});

	it("should fill a single curve that loops back to its own start", () => {
		const segments = [
			lineSeg(
				{ x: 0, y: 0 },
				{
					start: { x: 0, y: 0 },
					cp1: { x: 100, y: 100 },
					cp2: { x: -100, y: 100 },
					isClosed: true,
				},
			),
		];

		expect(isPointInPath(0, 50, { segments })).toBe(true);
		expect(isPointInPath(0, 100, { segments })).toBe(false);
	});
});

describe("isPointNearSegments", () => {
	it("should find every point along a long edge within the tolerance", () => {
		const segments = closedRectSegments(0, 0, 3000, 3000);
		const ys = Array.from({ length: 400 }, (_, i) => i * 7.5);

		expect(
			ys.filter((y) => !isPointNearSegments(3001, y, segments, 2)),
		).toEqual([]);
	});

	it("should not find a point farther than the tolerance from every edge", () => {
		const segments = closedRectSegments(0, 0, 3000, 3000);

		expect(isPointNearSegments(2997, 1500, segments, 2)).toBe(false);
	});
});

describe("isPointOnPath", () => {
	it("should hit just inside a filled curve's edge at the highest zoom", () => {
		// A filled dome: a curve bulging up from (0, 0) to (1000, 0), closed by
		// the straight base. Clicks at 640x zoom come with 2px / 640 of reach.
		const dome = lineSeg(
			{ x: 1000, y: 0 },
			{ start: { x: 0, y: 0 }, cp1: { x: 0, y: 800 }, cp2: { x: 0, y: 800 } },
		);
		const path = {
			type: "path",
			id: "dome",
			segments: [dome, lineSeg({ x: 0, y: 0 })],
			filters: [{ processor: "fill" } as FilterEntry],
		} as Path;
		const { start, cp1, cp2, end } = resolveSegment(dome);
		const insideByTenth = Array.from({ length: 19 }, (_, i) => {
			const t = (i + 1) / 20;
			const point = evalCubicBezier(start, cp1, cp2, end, t);
			const tangent = evalCubicBezierDerivative(start, cp1, cp2, end, t);
			const length = Math.hypot(tangent.x, tangent.y);
			return {
				x: point.x + (tangent.y / length) * 0.1,
				y: point.y - (tangent.x / length) * 0.1,
			};
		});

		expect(
			insideByTenth.filter(({ x, y }) => !isPointOnPath(x, y, path, 2 / 640)),
		).toEqual([]);
	});
});

describe("doesPathIntersectRect", () => {
	it("should detect a small rect crossing a long edge anywhere along it", () => {
		const path = {
			segments: closedRectSegments(0, 0, 3000, 3000),
			filters: [],
		};
		const ys = Array.from({ length: 80 }, (_, i) => i * 37);

		expect(
			ys.filter((y) => !doesPathIntersectRect(path, 2980, y, 3020, y + 20)),
		).toEqual([]);
	});

	it("should not detect a rect inside an unfilled closed path", () => {
		const path = {
			segments: closedRectSegments(0, 0, 3000, 3000),
			filters: [],
		};

		expect(doesPathIntersectRect(path, 1000, 1000, 1040, 1040)).toBe(false);
	});
});

describe("boundsIntersect", () => {
	const boundsA: BoundingBox = {
		minX: 10,
		minY: 10,
		maxX: 30,
		maxY: 30,
		width: 20,
		height: 20,
	};

	it("should return true for overlapping bounds", () => {
		const boundsB: BoundingBox = {
			minX: 20,
			minY: 20,
			maxX: 40,
			maxY: 40,
			width: 20,
			height: 20,
		};

		expect(boundsIntersect(boundsA, boundsB)).toBe(true);
		expect(boundsIntersect(boundsB, boundsA)).toBe(true);
	});

	it("should return true for bounds that touch at edge", () => {
		const boundsB: BoundingBox = {
			minX: 30,
			minY: 30,
			maxX: 50,
			maxY: 50,
			width: 20,
			height: 20,
		};

		expect(boundsIntersect(boundsA, boundsB)).toBe(true);
	});

	it("should return true for one bounds completely inside another", () => {
		const boundsB: BoundingBox = {
			minX: 15,
			minY: 15,
			maxX: 25,
			maxY: 25,
			width: 10,
			height: 10,
		};

		expect(boundsIntersect(boundsA, boundsB)).toBe(true);
		expect(boundsIntersect(boundsB, boundsA)).toBe(true);
	});

	it("should return false for non-intersecting bounds", () => {
		const boundsB: BoundingBox = {
			minX: 40,
			minY: 40,
			maxX: 60,
			maxY: 60,
			width: 20,
			height: 20,
		};

		expect(boundsIntersect(boundsA, boundsB)).toBe(false);
		expect(boundsIntersect(boundsB, boundsA)).toBe(false);
	});

	it("should return false for bounds separated horizontally", () => {
		const boundsB: BoundingBox = {
			minX: 40,
			minY: 10,
			maxX: 60,
			maxY: 30,
			width: 20,
			height: 20,
		};

		expect(boundsIntersect(boundsA, boundsB)).toBe(false);
	});

	it("should return false for bounds separated vertically", () => {
		const boundsB: BoundingBox = {
			minX: 10,
			minY: 40,
			maxX: 30,
			maxY: 60,
			width: 20,
			height: 20,
		};

		expect(boundsIntersect(boundsA, boundsB)).toBe(false);
	});
});
