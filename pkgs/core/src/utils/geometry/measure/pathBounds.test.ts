import {
	describe,
	expect,
	it,
} from "../../../../../../node_modules/vitest/dist/index";
import {
	createIdentityTransform,
	createStrokeBrushSettings,
} from "../../../document/factory";
import type { Path, StrokeAlign, StrokeAppearance } from "../../../schema";
import { closedRectSegments } from "../../../testUtils/segmentFactory";
import { toWorld } from "../space/coordinates";
import {
	calculatePathBounds,
	calculateSegmentListTightBounds,
} from "./pathBounds";

/** Closed 100×100 rectangle with a 10px geometric stroke at `align`. */
function alignedRectPath(align: StrokeAlign): Path {
	return {
		type: "path",
		id: "aligned-rect",
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		segments: closedRectSegments(0, 0, 100, 100),
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
						brushSettings: createStrokeBrushSettings(10, {
							lineCap: "butt",
							lineJoin: "miter",
							miterLimit: 4,
							align,
						}),
					},
				},
			} as unknown as StrokeAppearance,
		],
	};
}

describe("calculatePathBounds", () => {
	it("should calculate bounds for a simple path", () => {
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

		const bounds = calculatePathBounds(path);

		// Bounds should include stroke width (10px, so +/- 5px)
		expect(bounds.minX).toBe(-5);
		expect(bounds.minY).toBe(-5);
		expect(bounds.maxX).toBe(105);
		expect(bounds.maxY).toBe(105);
		expect(bounds.width).toBe(110);
		expect(bounds.height).toBe(110);
	});

	it("should reach a full stroke width out for an outside-aligned stroke", () => {
		const bounds = calculatePathBounds(alignedRectPath("outside"));

		expect([bounds.minX, bounds.minY, bounds.maxX, bounds.maxY]).toEqual([
			-10, -10, 110, 110,
		]);
	});

	it("should keep the half-width margin for an inside-aligned stroke", () => {
		// Open subpaths still render centered, so the margin must not shrink.
		const bounds = calculatePathBounds(alignedRectPath("inside"));

		expect([bounds.minX, bounds.minY, bounds.maxX, bounds.maxY]).toEqual([
			-5, -5, 105, 105,
		]);
	});

	it("should include size and wet bleed margin for stored v2 settings", () => {
		const path: Path = {
			type: "path",
			id: "test-path-v2",
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
								wet: {
									enabled: true,
									bleedRadius: 0.5,
									pigmentLoad: 0.85,
									grainScale: 1,
								},
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
					cp2: { x: 0, y: 0 },
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

		const bounds = calculatePathBounds(path);

		// margin = size/2 (5) + size * bleedRadius (5) = 10
		expect(bounds.minX).toBe(-10);
		expect(bounds.maxX).toBe(110);
	});

	it("should handle empty path segments", () => {
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
			segments: [],
		};

		const bounds = calculatePathBounds(path);

		expect(bounds.minX).toBe(0);
		expect(bounds.minY).toBe(0);
		expect(bounds.maxX).toBe(0);
		expect(bounds.maxY).toBe(0);
	});

	it("should handle path with start points", () => {
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
								properties: { size: { base: 2 } },
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
					start: { x: -10, y: -10 },
					cp1: { x: 10, y: 10 },
					cp2: { x: -5, y: -5 },
					end: { x: 10, y: 10 },
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

		const bounds = calculatePathBounds(path);

		// Should include start point (-10, -10) and stroke width (2px, so +/- 1px)
		expect(bounds.minX).toBe(-11);
		expect(bounds.minY).toBe(-11);
		expect(bounds.maxX).toBe(11);
		expect(bounds.maxY).toBe(11);
	});
});

describe("calculateSegmentListTightBounds", () => {
	it("should end at the curve's peak rather than at control points past it", () => {
		const bounds = calculateSegmentListTightBounds([
			{
				start: toWorld(0, 0),
				cp1: toWorld(0, 100),
				cp2: toWorld(100, 100),
				end: toWorld(100, 0),
			},
		]);

		expect(bounds?.minX).toBeCloseTo(0);
		expect(bounds?.maxX).toBeCloseTo(100);
		expect(bounds?.minY).toBeCloseTo(0);
		expect(bounds?.maxY).toBeCloseTo(75);
	});

	it("should span the anchors of straight segments", () => {
		const bounds = calculateSegmentListTightBounds([
			{
				start: toWorld(-10, 5),
				cp1: toWorld(-10, 5),
				cp2: toWorld(30, 40),
				end: toWorld(30, 40),
			},
			{ cp1: toWorld(30, 40), cp2: toWorld(20, -8), end: toWorld(20, -8) },
		]);

		expect(bounds).toMatchObject({
			minX: -10,
			minY: -8,
			maxX: 30,
			maxY: 40,
			width: 40,
			height: 48,
		});
	});

	it("should return null for an empty segment list", () => {
		expect(calculateSegmentListTightBounds([])).toBeNull();
	});
});
