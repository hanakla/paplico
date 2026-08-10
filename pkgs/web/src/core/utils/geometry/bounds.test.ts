import { describe, expect, it } from "vitest";
import { createIdentityTransform } from "../../document/factory";
import type {
	AnyArtObject,
	BoundingBox,
	Path,
	Reference3DElement,
	StrokeAppearance,
} from "../../schema";
import { closedRectSegments } from "../../testUtils/segmentFactory";
import { createTestTextElement } from "../../testUtils/typographyFixtures";
import {
	boundsIntersect,
	calculateElementBounds,
	calculatePathBounds,
	expandBounds,
	pointInBounds,
} from "./bounds";

describe("bounds utilities", () => {
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

	describe("expandBounds", () => {
		it("should expand bounds by margin", () => {
			const bounds: BoundingBox = {
				minX: 10,
				minY: 20,
				maxX: 30,
				maxY: 40,
				width: 20,
				height: 20,
			};

			const expanded = expandBounds(bounds, 5);

			expect(expanded.minX).toBe(5);
			expect(expanded.minY).toBe(15);
			expect(expanded.maxX).toBe(35);
			expect(expanded.maxY).toBe(45);
			expect(expanded.width).toBe(30);
			expect(expanded.height).toBe(30);
		});

		it("should handle negative margin (shrink)", () => {
			const bounds: BoundingBox = {
				minX: 0,
				minY: 0,
				maxX: 100,
				maxY: 100,
				width: 100,
				height: 100,
			};

			const shrunk = expandBounds(bounds, -10);

			expect(shrunk.minX).toBe(10);
			expect(shrunk.minY).toBe(10);
			expect(shrunk.maxX).toBe(90);
			expect(shrunk.maxY).toBe(90);
			expect(shrunk.width).toBe(80);
			expect(shrunk.height).toBe(80);
		});
	});

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
});
