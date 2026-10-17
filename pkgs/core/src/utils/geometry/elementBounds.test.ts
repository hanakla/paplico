import {
	describe,
	expect,
	it,
} from "../../../../../node_modules/vitest/dist/index";
import { createIdentityTransform } from "../../document/factory";
import type {
	AnyArtObject,
	CompoundPath,
	Group,
	Path,
	Reference3DElement,
	StrokeAppearance,
} from "../../schema";
import { closedRectSegments } from "../../testUtils/segmentFactory";
import { createTestTextElement } from "../../testUtils/typographyFixtures";
import { calculateElementBounds } from "./elementBounds";

describe("calculateElementBounds", () => {
	it("should delegate to calculatePathBounds for path elements", () => {
		const path: Path = {
			type: "path",
			id: "test-path",
			filters: [
				{
					processor: "stroke",
					paramData: {
						version: "1",
						params: {
							strokeColor: {
								type: "solid",
								color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
							},
							brushSettings: {
								version: 2,
								engine: "dab",
								strokeOpacity: 1,
								paintMode: "buildup",
								properties: { size: { base: 10 } },
								randomSeed: 0,
							},
						},
					},
				} as unknown as StrokeAppearance,
			],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			segments: [
				{
					start: { x: 0, y: 0 },
					cp1: { x: 0, y: 0 },
					cp2: { x: -50, y: -50 },
					end: { x: 100, y: 100 },
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
					isMoved: true,
				},
			],
		};

		const bounds = calculateElementBounds(path);

		expect(bounds.minX).toBe(-5);
		expect(bounds.minY).toBe(-5);
		expect(bounds.maxX).toBe(105);
		expect(bounds.maxY).toBe(105);
	});

	it("should compute center-rect bounds for reference3d elements (same model as image)", () => {
		const reference3d: Reference3DElement = {
			type: "reference3d",
			id: "reference3d-1",
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			sceneId: "scene-1",
			camera: {
				projection: "perspective",
				position: [4, 3, 6],
				target: [0, 1, 0],
				fovDeg: 50,
			},
			x: 100,
			y: 50,
			width: 400,
			height: 300,
			displayMode: "lineart",
		};

		const bounds = calculateElementBounds(reference3d);

		expect(bounds.minX).toBe(-100);
		expect(bounds.minY).toBe(-100);
		expect(bounds.maxX).toBe(300);
		expect(bounds.maxY).toBe(200);
		expect(bounds.width).toBe(400);
		expect(bounds.height).toBe(300);
	});
});

describe("calculateElementBounds for blend", () => {
	const makePath = (id: string, x: number, y: number, size = 20): Path => {
		const h = size / 2;
		return {
			type: "path",
			id,
			segments: [
				{
					start: { x: x - h, y: y - h },
					cp1: { x: 0, y: 0 },
					cp2: { x: 0, y: 0 },
					end: { x: x + h, y: y + h },
					isMoved: true,
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
				},
			],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};
	};

	it("returns the union of source paths' bounds", () => {
		const a = makePath("a", 0, 0, 20);
		const b = makePath("b", 100, 50, 20);
		const blend = {
			type: "blend" as const,
			id: "blend-1",
			objectIds: ["a", "b"],
			spacing: { type: "steps" as const, count: 3 },
			placementEasing: { type: "linear" as const },
			appearanceEasing: { type: "linear" as const },
			opacity: 1,
			blendMode: "normal" as const,
			transform: createIdentityTransform(),
		};
		const map = new Map<string, AnyArtObject>([
			["a", a],
			["b", b],
			["blend-1", blend],
		]);
		const bounds = calculateElementBounds(blend, map);
		expect(bounds.minX).toBe(-10);
		expect(bounds.minY).toBe(-10);
		expect(bounds.maxX).toBe(110);
		expect(bounds.maxY).toBe(60);
	});

	it("returns empty bounds when source paths are missing", () => {
		const blend = {
			type: "blend" as const,
			id: "blend-1",
			objectIds: ["missing"],
			spacing: { type: "steps" as const, count: 3 },
			placementEasing: { type: "linear" as const },
			appearanceEasing: { type: "linear" as const },
			opacity: 1,
			blendMode: "normal" as const,
			transform: createIdentityTransform(),
		};
		const bounds = calculateElementBounds(
			blend,
			new Map<string, AnyArtObject>(),
		);
		expect(bounds.minX).toBe(0);
		expect(bounds.maxX).toBe(0);
	});
});

describe("calculateElementBounds for group", () => {
	const makePath = (id: string, min: number, max: number): Path => ({
		type: "path",
		id,
		segments: closedRectSegments(min, min, max, max),
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	});
	const makeGroup = (childIds: string[], clipPathId?: string): Group => ({
		type: "group",
		id: "group",
		childIds,
		clipPathId,
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	});

	it("returns the union of children for a plain group", () => {
		const group = makeGroup(["small", "large"]);
		const map = new Map<string, AnyArtObject>([
			["small", makePath("small", -10, 10)],
			["large", makePath("large", -50, 50)],
			["group", group],
		]);
		const bounds = calculateElementBounds(group, map);
		expect(bounds.minX).toBe(-50);
		expect(bounds.maxX).toBe(50);
	});

	it("returns the clip path bounds for a clip group even when children extend past it", () => {
		const group = makeGroup(["clip", "content"], "clip");
		const map = new Map<string, AnyArtObject>([
			["clip", makePath("clip", -10, 10)],
			["content", makePath("content", -50, 50)],
			["group", group],
		]);
		const bounds = calculateElementBounds(group, map);
		expect(bounds.minX).toBe(-10);
		expect(bounds.minY).toBe(-10);
		expect(bounds.maxX).toBe(10);
		expect(bounds.maxY).toBe(10);
	});

	it("falls back to the children union when the clip path is missing", () => {
		const group = makeGroup(["content"], "missing");
		const map = new Map<string, AnyArtObject>([
			["content", makePath("content", -50, 50)],
			["group", group],
		]);
		const bounds = calculateElementBounds(group, map);
		expect(bounds.minX).toBe(-50);
		expect(bounds.maxX).toBe(50);
	});
});

describe("calculateElementBounds for compound path", () => {
	const makeRect = (
		id: string,
		minX: number,
		minY: number,
		maxX: number,
		maxY: number,
	): Path => ({
		type: "path",
		id,
		segments: closedRectSegments(minX, minY, maxX, maxY),
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	});
	const makeCompound = (op: CompoundPath["sources"][number]["op"]) =>
		({
			type: "compound-path",
			id: "compound",
			sources: [
				{ id: "base", op: "union" },
				{ id: "other", op },
			],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		}) satisfies CompoundPath;

	it("covers the face a subtract leaves, not the sources", () => {
		const map = new Map<string, AnyArtObject>([
			["base", makeRect("base", -50, -50, 50, 50)],
			["other", makeRect("other", 0, -50, 100, 50)],
		]);

		const bounds = calculateElementBounds(makeCompound("subtract"), map);

		expect(bounds.minX).toBeCloseTo(-50);
		expect(bounds.maxX).toBeCloseTo(0);
		expect(bounds.minY).toBeCloseTo(-50);
		expect(bounds.maxY).toBeCloseTo(50);
	});

	it("falls back to the sources when the result has no face", () => {
		const map = new Map<string, AnyArtObject>([
			["base", makeRect("base", -50, -50, 50, 50)],
			["other", makeRect("other", 200, -50, 300, 50)],
		]);

		const bounds = calculateElementBounds(makeCompound("intersect"), map);

		expect(bounds.minX).toBeCloseTo(-50);
		expect(bounds.maxX).toBeCloseTo(300);
	});
});

describe("calculateElementBounds for path-bound text", () => {
	const axisPath: Path = {
		type: "path",
		id: "region",
		segments: closedRectSegments(0, -30, 40, 0),
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};

	it("should estimate bounds from the axis path instead of the anchor", () => {
		// Vertical region text: glyphs fill the region to the right of the
		// anchor, which the anchor-based estimate does not cover at all
		const text = createTestTextElement("aaaaaaaa", {
			layout: { writingMode: "vertical-rl" },
			axisBinding: { mode: "inShape", pathObjectId: "region" },
		});
		const map = new Map<string, AnyArtObject>([["region", axisPath]]);

		const bounds = calculateElementBounds(text, map);

		// Region rect (0,-30)-(40,0) padded by fontSize(10) * 2
		expect(bounds.minX).toBe(-20);
		expect(bounds.minY).toBe(-50);
		expect(bounds.maxX).toBe(60);
		expect(bounds.maxY).toBe(20);
	});

	it("should cover the box area of an unbound vertical fixed-width text", () => {
		// vertical-rl fixed boxes lay columns inside [x, x+boxWidth]
		// (right of the anchor); the estimate must cover that side too
		const text = createTestTextElement("aaaaaaaa", {
			layout: {
				writingMode: "vertical-rl",
				boxWidth: 40,
				boxHeight: 30,
				wordWrap: true,
				overflow: "hidden",
			},
		});

		const bounds = calculateElementBounds(
			text,
			new Map<string, AnyArtObject>(),
		);

		expect(bounds.minX).toBeLessThanOrEqual(0);
		expect(bounds.maxX).toBeGreaterThanOrEqual(40);
		expect(bounds.minY).toBeLessThanOrEqual(-30);
		expect(bounds.maxY).toBeGreaterThanOrEqual(0);
	});

	it("should fall back to the anchor estimate when the path is missing", () => {
		const text = createTestTextElement("aaaa", {
			axisBinding: { mode: "inShape", pathObjectId: "gone" },
		});

		const bounds = calculateElementBounds(
			text,
			new Map<string, AnyArtObject>(),
		);

		// Horizontal anchor-based estimate extends rightward from the anchor
		expect(bounds.minX).toBe(0);
		expect(bounds.maxX).toBeGreaterThan(0);
	});
});
