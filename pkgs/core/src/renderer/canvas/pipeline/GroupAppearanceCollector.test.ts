import { describe, expect, it } from "vitest";
import { CompoundPathCache } from "../../../document/elementGeometry/CompoundPathCache";
import { createIdentityTransform } from "../../../document/factory";
import type {
	AnyArtObject,
	CubicBezierSegment,
	Group,
	Path,
} from "../../../schema";
import { mockGroup, mockPath } from "../../../testUtils/mockElements";
import { closedRectSegments } from "../../../testUtils/segmentFactory";
import { computeSubPathSignedArea } from "../../../utils/geometry/measure/area";
import { splitIntoSubPaths } from "../../../utils/geometry/primitives/segment";
import { reverseSubPath } from "../../../utils/geometry/reshape/segment";
import { collectGroupSegments } from "./GroupAppearanceCollector";

describe("collectGroupSegments", () => {
	it("should keep a child's hole wound against its outer contour", () => {
		const areas = collectedAreas([ringPath("ring", 0, false)]);

		expect(areas[0]).toBeGreaterThan(0);
		expect(areas[1]).toBeLessThan(0);
	});

	it("should turn a child whose outer contour winds clockwise, hole included", () => {
		const areas = collectedAreas([ringPath("ring", 0, true)]);

		expect(areas[0]).toBeGreaterThan(0);
		expect(areas[1]).toBeLessThan(0);
	});

	it("should wind the outer contours of all children the same way", () => {
		const areas = collectedAreas([
			ringPath("a", 0, false),
			ringPath("b", 5, true),
		]);

		expect(areas.map(Math.sign)).toEqual([1, -1, 1, -1]);
	});

	it("should leave out a hidden child", () => {
		const hidden = rectPath("hidden", 0, 0, 10, 10);
		hidden.visible = false;

		const bounds = collectedBounds([hidden, rectPath("shown", 20, 0, 30, 10)]);

		expect(bounds).toEqual({ minX: 20, maxX: 30 });
	});

	it("should take the shape of a nested clip group from its clip path", () => {
		const clipPath = rectPath("clip", 0, 0, 10, 10);
		const big = rectPath("big", -20, -20, 30, 30);
		const nested = {
			...mockGroup("nested", [clipPath.id, big.id]),
			clipPathId: clipPath.id,
		};

		const bounds = collectedBounds([nested], [clipPath, big]);

		expect(bounds).toEqual({ minX: 0, maxX: 10 });
	});
});

/** The x range of what a group of `children` collects. */
function collectedBounds(
	children: AnyArtObject[],
	nestedContent: AnyArtObject[] = [],
): { minX: number; maxX: number } {
	const group = mockGroup(
		"group",
		children.map((child) => child.id),
	);
	const segments = collectGroupSegments(
		group,
		new Map<string, AnyArtObject>(
			[...children, ...nestedContent].map((el) => [el.id, el]),
		),
		new CompoundPathCache(),
	);
	const xs = segments.flatMap((seg) => [seg.start?.x ?? seg.end.x, seg.end.x]);
	return { minX: Math.min(...xs), maxX: Math.max(...xs) };
}

function rectPath(
	id: string,
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): Path {
	const path = mockPath(id);
	path.segments = closedRectSegments(minX, minY, maxX, maxY);
	return path;
}

/** Signed areas of the subpaths a group of `children` collects, in order. */
function collectedAreas(children: Path[]): number[] {
	const group: Group = {
		type: "group",
		id: "group",
		childIds: children.map((child) => child.id),
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
	const segments = collectGroupSegments(
		group,
		new Map<string, AnyArtObject>(children.map((child) => [child.id, child])),
		new CompoundPathCache(),
	);
	return splitIntoSubPaths(segments).map(computeSubPathSignedArea);
}

/** A 10×10 square with a 4×4 hole. `reversed` flips both contours. */
function ringPath(id: string, x: number, reversed: boolean): Path {
	const outer = counterClockwise(closedRectSegments(x, 0, x + 10, 10));
	const hole = reverseSubPath(
		counterClockwise(closedRectSegments(x + 3, 3, x + 7, 7)),
	);
	const contours = reversed
		? [reverseSubPath(outer), reverseSubPath(hole)]
		: [outer, hole];
	return {
		type: "path",
		id,
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		segments: contours.flatMap((contour) => [
			{ ...contour[0], isMoved: true },
			...contour.slice(1),
		]),
	};
}

function counterClockwise(
	segments: CubicBezierSegment[],
): CubicBezierSegment[] {
	return computeSubPathSignedArea(segments) < 0
		? reverseSubPath(segments)
		: segments;
}
