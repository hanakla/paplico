import { describe, expect, it } from "vitest";
import { createIdentityTransform } from "../../document/factory";
import type { BoundingBox } from "../../schema";
import {
	frameCenter,
	frameCorners,
	frameWorldBounds,
	resolveSelectionFrame,
	type SelectionFrame,
	transformFrame,
	worldFrame,
} from "./selectionFrame";

const box: BoundingBox = {
	minX: 0,
	minY: 0,
	maxX: 100,
	maxY: 50,
	width: 100,
	height: 50,
};

/** `box` turned a quarter about the origin and moved to (10, 20). */
const turned: SelectionFrame = {
	bounds: box,
	matrix: { ...createIdentityTransform(), x: 10, y: 20, rotation: Math.PI / 2 },
	elementId: "el",
};

describe("resolveSelectionFrame", () => {
	const frames: Record<string, SelectionFrame> = {
		turned,
		upright: {
			bounds: box,
			matrix: createIdentityTransform(),
			elementId: "upright",
		},
		mirrored: {
			bounds: box,
			matrix: { ...createIdentityTransform(), scaleX: -1 },
			elementId: "mirrored",
		},
		flat: {
			bounds: box,
			matrix: { ...createIdentityTransform(), scaleX: 0 },
			elementId: "flat",
		},
	};
	const frameOf = (id: string) => frames[id] ?? null;
	const worldBoundsOf = (id: string) =>
		frames[id] ? frameWorldBounds(frames[id]) : null;

	it("should hand a lone turned element its own frame", () => {
		expect(resolveSelectionFrame(["turned"], frameOf, worldBoundsOf)).toBe(
			turned,
		);
	});

	it("should frame a lone upright element on the world axes", () => {
		const frame = resolveSelectionFrame(["upright"], frameOf, worldBoundsOf)!;
		expect(frame.elementId).toBeNull();
		expect(frame.bounds).toEqual(box);
	});

	it("should frame a lone mirrored element on the world axes", () => {
		const frame = resolveSelectionFrame(["mirrored"], frameOf, worldBoundsOf)!;
		expect(frame.elementId).toBeNull();
		expect(frame.bounds).toMatchObject({ minX: -100, maxX: 0 });
	});

	it("should frame a flattened element on the world axes", () => {
		expect(
			resolveSelectionFrame(["flat"], frameOf, worldBoundsOf)?.elementId,
		).toBeNull();
	});

	it("should frame several elements on the world axes around all of them", () => {
		const frame = resolveSelectionFrame(
			["turned", "upright"],
			frameOf,
			worldBoundsOf,
		)!;
		expect(frame.elementId).toBeNull();
		// The turned box spans x -40..10 and y 20..120.
		expect(frame.bounds.minX).toBeCloseTo(-40);
		expect(frame.bounds.maxX).toBeCloseTo(100);
		expect(frame.bounds.minY).toBeCloseTo(0);
		expect(frame.bounds.maxY).toBeCloseTo(120);
	});

	it("should have no frame when nothing has bounds", () => {
		expect(
			resolveSelectionFrame(["missing"], frameOf, worldBoundsOf),
		).toBeNull();
	});
});

describe("frame geometry", () => {
	it("should place the corners nw, ne, se, sw through the matrix", () => {
		const [nw, ne, se, sw] = frameCorners(turned);
		expect(nw.x).toBeCloseTo(-40);
		expect(nw.y).toBeCloseTo(20);
		expect(ne.x).toBeCloseTo(-40);
		expect(ne.y).toBeCloseTo(120);
		expect(se.x).toBeCloseTo(10);
		expect(se.y).toBeCloseTo(120);
		expect(sw.x).toBeCloseTo(10);
		expect(sw.y).toBeCloseTo(20);
	});

	it("should place the centre through the matrix", () => {
		const center = frameCenter(turned);
		expect(center.x).toBeCloseTo(-15);
		expect(center.y).toBeCloseTo(70);
	});

	it("should carry the frame through a world map", () => {
		const moved = transformFrame(worldFrame(box), {
			...createIdentityTransform(),
			x: 5,
			y: 7,
		});
		expect(moved.bounds).toBe(box);
		expect(frameCenter(moved)).toEqual({ x: 55, y: 32 });
	});
});
