import {
	describe,
	expect,
	it,
} from "../../../../../../node_modules/vitest/dist/index";
import type { BoundingBox } from "../../../schema";
import { closedRectSegments } from "../../../testUtils/segmentFactory";
import { boundsIntersect, isPointInPath, pointInBounds } from "./hitTest";

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
