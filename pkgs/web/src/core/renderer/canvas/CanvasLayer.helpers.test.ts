import { describe, expect, it } from "vitest";
import { localAppearances } from "../../document/appearancePresets";
import {
	createIdentityTransform,
	createStrokeBrushSettings,
} from "../../document/factory";
import type {
	AnyArtObject,
	BoundingBox,
	CompoundPath,
	CubicBezierSegment,
	FillAppearance,
	Path,
	StrokeAppearance,
	Viewport,
} from "../../schema";
import { degToRad } from "../../utils/math";
import {
	flattenBezierPath,
	flattenCubicBezier,
} from "../geometry/bezierFlatten";
import {
	calculatePrebufDimensions,
	computeDotGridPhase,
	createCompoundPathRenderPath,
	expandRenderFilter,
	groupSubPathsByContainment,
	interactiveBakeDensity,
} from "./CanvasLayer.helpers";

describe("calculatePrebufDimensions", () => {
	const viewport: Viewport = {
		x: 10,
		y: -5,
		zoom: 2,
		rotation: degToRad(37),
	};

	it("should keep the requested prebuf size when it fits within the device limit", () => {
		const visibleBounds: BoundingBox = {
			minX: -100,
			minY: -75,
			maxX: 100,
			maxY: 75,
			width: 200,
			height: 150,
		};

		const result = calculatePrebufDimensions({
			viewport,
			visibleBounds,
			canvasWidth: 800,
			canvasHeight: 600,
			maxTextureDimension: 1_024,
		});

		expect(result.prebufZoom).toBe(2);
		expect(result.prebufWidth).toBe(400);
		expect(result.prebufHeight).toBe(300);
	});

	it("should lower prebuf zoom instead of clipping when the requested texture exceeds the device limit", () => {
		const visibleBounds: BoundingBox = {
			minX: -800,
			minY: -600,
			maxX: 800,
			maxY: 600,
			width: 1_600,
			height: 1_200,
		};

		const result = calculatePrebufDimensions({
			viewport,
			visibleBounds,
			canvasWidth: 800,
			canvasHeight: 600,
			maxTextureDimension: 2_048,
		});

		expect(result.prebufZoom).toBeCloseTo(1.28);
		expect(result.prebufWidth).toBe(2_048);
		expect(result.prebufHeight).toBe(1_536);
	});

	it("should render at the zoom override while world coverage still follows the viewport", () => {
		const visibleBounds: BoundingBox = {
			minX: -100,
			minY: -75,
			maxX: 100,
			maxY: 75,
			width: 200,
			height: 150,
		};

		const result = calculatePrebufDimensions({
			viewport,
			visibleBounds,
			canvasWidth: 800,
			canvasHeight: 600,
			maxTextureDimension: 1_024,
			zoomOverride: 1,
		});

		expect(result.prebufZoom).toBe(1);
		expect(result.prebufWidth).toBe(200);
		expect(result.prebufHeight).toBe(150);
	});

	it("should still clamp an overridden zoom to the device texture limit", () => {
		const visibleBounds: BoundingBox = {
			minX: -800,
			minY: -600,
			maxX: 800,
			maxY: 600,
			width: 1_600,
			height: 1_200,
		};

		const result = calculatePrebufDimensions({
			viewport,
			visibleBounds,
			canvasWidth: 800,
			canvasHeight: 600,
			maxTextureDimension: 2_048,
			zoomOverride: 4,
		});

		expect(result.prebufZoom).toBeCloseTo(1.28);
		expect(result.prebufWidth).toBe(2_048);
		expect(result.prebufHeight).toBe(1_536);
	});
});

describe("interactiveBakeDensity", () => {
	it("should follow the display density when zooming in, past the raster scale", () => {
		expect(interactiveBakeDensity(1, 1)).toBe(1);
		// zoom 2.5 → bucket 4: bakes sharpen with the zoom instead of pinning
		// to the document raster scale (which kept them blurry forever).
		expect(interactiveBakeDensity(1, 2.5)).toBe(4);
		expect(interactiveBakeDensity(4, 8)).toBe(8);
	});

	it("should coarsen a zoomed-out bake to the power-of-two bucket above the zoom", () => {
		// zoom 0.19 → bucket 0.25; raster density 1 would be 5x the display
		expect(interactiveBakeDensity(1, 0.19)).toBe(0.25);
		expect(interactiveBakeDensity(4, 0.6)).toBe(1);
	});

	it("should cap the bucket by the element's bake budget, never below the raster scale", () => {
		// 500x500 world px at 16 texels/px is 64M texels; 8 texels/px fits.
		expect(interactiveBakeDensity(4, 10, { width: 500, height: 500 })).toBe(8);
		// A small element keeps the full bucket.
		expect(interactiveBakeDensity(4, 10, { width: 50, height: 50 })).toBe(16);
		// A huge element never drops under the document raster scale.
		expect(interactiveBakeDensity(4, 10, { width: 8000, height: 8000 })).toBe(
			4,
		);
	});

	it("should never go below the display density", () => {
		for (const zoom of [0.13, 0.3, 0.77, 1.9, 3.2]) {
			expect(interactiveBakeDensity(4, zoom)).toBeGreaterThanOrEqual(zoom);
		}
	});

	it("should return a stable value across a zoom bucket so cache keys stay stable", () => {
		expect(interactiveBakeDensity(2, 0.26)).toBe(
			interactiveBakeDensity(2, 0.49),
		);
		expect(interactiveBakeDensity(2, 0.26)).not.toBe(
			interactiveBakeDensity(2, 0.51),
		);
	});

	it("should fall back to the rasterization scale for degenerate zoom values", () => {
		expect(interactiveBakeDensity(2, 0)).toBe(2);
		expect(interactiveBakeDensity(2, -1)).toBe(2);
		expect(interactiveBakeDensity(2, Number.NaN)).toBe(2);
	});
});

describe("groupSubPathsByContainment", () => {
	it("treats inner contour with opposite winding as a hole", () => {
		const outer = ccwSquare(0, 0, 100, 100);
		const hole = cwSquare(20, 20, 80, 80);

		const groups = groupSubPathsByContainment([outer, hole]);

		expect(groups).toHaveLength(1);
		expect(groups[0].outer).toEqual(outer);
		expect(groups[0].holes).toEqual([hole]);
	});

	it("does not convert inner contour to hole when all contours share winding (non-zero)", () => {
		const outer = ccwSquare(0, 0, 100, 100);
		const innerSameWinding = ccwSquare(20, 20, 80, 80);

		const groups = groupSubPathsByContainment([outer, innerSameWinding]);

		expect(groups).toHaveLength(2);
		expect(groups[0].outer).toEqual(outer);
		expect(groups[0].holes).toEqual([]);
		expect(groups[1].outer).toEqual(innerSameWinding);
		expect(groups[1].holes).toEqual([]);
	});

	it("assigns hole to the nearest containing outer when multiple outers exist", () => {
		const outerA = ccwSquare(0, 0, 50, 50);
		const outerB = ccwSquare(70, 0, 120, 50);
		const holeInsideB = cwSquare(80, 10, 110, 40);

		const groups = groupSubPathsByContainment([outerA, outerB, holeInsideB]);

		expect(groups).toHaveLength(2);
		expect(groups[0].outer).toEqual(outerA);
		expect(groups[0].holes).toEqual([]);
		expect(groups[1].outer).toEqual(outerB);
		expect(groups[1].holes).toEqual([holeInsideB]);
	});

	it("treats island as outer by nesting depth even with irregular winding", () => {
		const outer = ccwSquare(0, 0, 120, 120);
		const hole = cwSquare(20, 20, 100, 100);
		const islandSameWindingAsHole = cwSquare(40, 40, 80, 80);

		const groups = groupSubPathsByContainment([
			outer,
			hole,
			islandSameWindingAsHole,
		]);

		expect(groups).toHaveLength(2);
		expect(groups[0].outer).toEqual(outer);
		expect(groups[0].holes).toEqual([hole]);
		expect(groups[1].outer).toEqual(islandSameWindingAsHole);
		expect(groups[1].holes).toEqual([]);
	});
});

describe("flattenBezierPath", () => {
	const strongCurve: CubicBezierSegment[] = [
		{
			start: { x: 0, y: 0 },
			cp1: { x: 0, y: 80 },
			cp2: { x: -80, y: 0 },
			end: { x: 80, y: 80 },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: true,
		},
	];

	it("subdivides curved segments more when tolerance is smaller", () => {
		const coarse = flattenBezierPath(strongCurve, { curveTolerance: 8 });
		const fine = flattenBezierPath(strongCurve, { curveTolerance: 0.25 });

		expect(fine.length).toBeGreaterThan(coarse.length);
	});

	it("keeps straight segments as endpoints", () => {
		const straightLine: CubicBezierSegment[] = [
			{
				start: { x: 0, y: 0 },
				cp1: { x: 10, y: 0 },
				cp2: { x: -10, y: 0 },
				end: { x: 100, y: 0 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: true,
			},
		];

		expect(flattenBezierPath(straightLine)).toEqual([0, 0, 100, 0]);
	});
});

describe("flattenCubicBezier", () => {
	it("accepts absolute control points without segment metadata", () => {
		expect(
			flattenCubicBezier(
				{ x: 0, y: 0 },
				{ x: 10, y: 0 },
				{ x: 90, y: 0 },
				{ x: 100, y: 0 },
			),
		).toEqual([0, 0, 100, 0]);
	});
});

describe("createCompoundPathRenderPath", () => {
	it("disables stroke and injects white fill for mask rendering", () => {
		const segments = createSimpleSegments();
		const baseBrush = createStrokeBrushSettings(9);
		const baseSourcePath: Path = {
			type: "path",
			id: "base",
			segments,
			filters: [
				{
					processor: "stroke",
					paramData: {
						version: "1",
						params: {
							strokeColor: {
								type: "solid",
								color: { type: "rgb", r: 0.1, g: 0.2, b: 0.3, a: 1 },
							},
							brushSettings: baseBrush,
						},
					},
				} as unknown as StrokeAppearance,
			],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};
		const compoundPath = createCompoundPath();
		compoundPath.filters = [];

		const renderPath = createCompoundPathRenderPath(
			compoundPath,
			segments,
			baseSourcePath,
			"offscreen",
			true,
		);

		const renderStroke = localAppearances(renderPath.filters).find(
			(f) => f.processor === "stroke",
		) as StrokeAppearance | undefined;
		const renderFill = (
			localAppearances(renderPath.filters).find(
				(f) => f.processor === "fill",
			) as FillAppearance | undefined
		)?.paramData.params.fill;
		expect(renderStroke).toBeUndefined();
		expect(renderFill).toEqual({
			type: "solid",
			color: { type: "rgb", r: 1, g: 1, b: 1, a: 1 },
		});
	});

	it("keeps original stroke/fill styles in main pipeline", () => {
		const segments = createSimpleSegments();
		const compoundPath = createCompoundPath();

		const renderPath = createCompoundPathRenderPath(
			compoundPath,
			segments,
			undefined,
			"main",
		);

		const renderStroke = localAppearances(renderPath.filters).find(
			(f) => f.processor === "stroke",
		) as StrokeAppearance | undefined;
		const renderFill = (
			localAppearances(renderPath.filters).find(
				(f) => f.processor === "fill",
			) as FillAppearance | undefined
		)?.paramData.params.fill;
		const cpStroke = localAppearances(compoundPath.filters).find(
			(f) => f.processor === "stroke",
		) as StrokeAppearance | undefined;
		const cpFill = (
			localAppearances(compoundPath.filters).find(
				(f) => f.processor === "fill",
			) as FillAppearance | undefined
		)?.paramData.params.fill;
		expect(renderStroke?.paramData.params.strokeColor).toEqual(
			cpStroke?.paramData.params.strokeColor,
		);
		expect(renderFill).toEqual(cpFill);
	});
});

describe("computeDotGridPhase", () => {
	const W = 800;
	const H = 600;

	it("centers the world origin on screen at the default viewport", () => {
		const vp: Viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
		expect(computeDotGridPhase(W, H, vp)).toEqual({ phaseX: 400, phaseY: 300 });
	});

	it("moves the phase by delta*zoom when the canvas pans (pan-follow)", () => {
		const base: Viewport = { x: 0, y: 0, zoom: 2, rotation: 0 };
		const panned: Viewport = { x: 10, y: 5, zoom: 2, rotation: 0 };
		const a = computeDotGridPhase(W, H, base);
		const b = computeDotGridPhase(W, H, panned);
		// Screen X moves left by dx*zoom; screen Y (top-left origin) moves down by dy*zoom.
		expect(b.phaseX - a.phaseX).toBeCloseTo(-10 * 2, 6);
		expect(b.phaseY - a.phaseY).toBeCloseTo(5 * 2, 6);
	});

	it("keeps the phase fixed across zoom when the viewport is at the origin (no crawl)", () => {
		const z1 = computeDotGridPhase(W, H, { x: 0, y: 0, zoom: 1, rotation: 0 });
		const z4 = computeDotGridPhase(W, H, { x: 0, y: 0, zoom: 4, rotation: 0 });
		expect(z4).toEqual(z1);
	});
});

describe("expandRenderFilter", () => {
	// Synthetic fixtures: expandRenderFilter only reads type, childIds / sources
	// / objectIds+spineSourceId (via getContainerChildIds), mask.elementIds,
	// clipPathId and axisBinding — so a minimal cast object is enough.
	const el = (o: { id: string; type: string } & Record<string, unknown>) =>
		o as unknown as AnyArtObject;
	const mapOf = (...els: AnyArtObject[]) =>
		new Map(els.map((e) => [e.id, e] as const));

	it("includes group children recursively and the group's clip path, excluding siblings", () => {
		const map = mapOf(
			el({
				id: "G",
				type: "group",
				childIds: ["C1", "G2"],
				clipPathId: "CLIP",
			}),
			el({ id: "C1", type: "path" }),
			el({ id: "G2", type: "group", childIds: ["C2"] }),
			el({ id: "C2", type: "path" }),
			el({ id: "CLIP", type: "path" }),
			el({ id: "S", type: "group", childIds: ["S1"] }),
			el({ id: "S1", type: "path" }),
		);
		expect([...expandRenderFilter(new Set(["G"]), map)].sort()).toEqual([
			"C1",
			"C2",
			"CLIP",
			"G",
			"G2",
		]);
	});

	it("includes object-mask sources recursively", () => {
		const map = mapOf(
			el({ id: "M", type: "path", mask: { elementIds: ["MSRC"] } }),
			el({
				id: "MSRC",
				type: "group",
				childIds: ["MSRC_C"],
				mask: { elementIds: ["MSRC2"] },
			}),
			el({ id: "MSRC_C", type: "path" }),
			el({ id: "MSRC2", type: "path" }),
		);
		expect([...expandRenderFilter(new Set(["M"]), map)].sort()).toEqual([
			"M",
			"MSRC",
			"MSRC2",
			"MSRC_C",
		]);
	});

	it("includes a text's axis-bound path and clip path", () => {
		const map = mapOf(
			el({
				id: "T",
				type: "text",
				axisBinding: { pathObjectId: "AXIS" },
				clipPathId: "TCLIP",
			}),
			el({ id: "AXIS", type: "path" }),
			el({ id: "TCLIP", type: "path" }),
		);
		expect([...expandRenderFilter(new Set(["T"]), map)].sort()).toEqual([
			"AXIS",
			"T",
			"TCLIP",
		]);
	});

	it("includes compound-path sources and blend objectIds + spine", () => {
		const map = mapOf(
			el({
				id: "CP",
				type: "compound-path",
				sources: [{ id: "P1" }, { id: "P2" }],
			}),
			el({ id: "P1", type: "path" }),
			el({ id: "P2", type: "path" }),
			el({
				id: "B",
				type: "blend",
				objectIds: ["B1", "B2"],
				spineSourceId: "SP",
			}),
			el({ id: "B1", type: "path" }),
			el({ id: "B2", type: "path" }),
			el({ id: "SP", type: "path" }),
		);
		expect([...expandRenderFilter(new Set(["CP"]), map)].sort()).toEqual([
			"CP",
			"P1",
			"P2",
		]);
		expect([...expandRenderFilter(new Set(["B"]), map)].sort()).toEqual([
			"B",
			"B1",
			"B2",
			"SP",
		]);
	});

	it("skips dangling references without throwing", () => {
		const map = mapOf(
			el({ id: "G", type: "group", childIds: ["MISSING"], clipPathId: "GONE" }),
		);
		expect([...expandRenderFilter(new Set(["G"]), map)]).toEqual(["G"]);
	});
});

function ccwSquare(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): number[] {
	return [minX, minY, maxX, minY, maxX, maxY, minX, maxY];
}

function cwSquare(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): number[] {
	return [minX, minY, minX, maxY, maxX, maxY, maxX, minY];
}

function createSimpleSegments(): CubicBezierSegment[] {
	return [
		{
			start: { x: 0, y: 0 },
			cp1: { x: 10, y: 0 },
			cp2: { x: -10, y: 0 },
			end: { x: 100, y: 0 },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: true,
			isClosed: true,
		},
	];
}

function createCompoundPath(
	overrides: Partial<CompoundPath> = {},
): CompoundPath {
	return {
		type: "compound-path",
		id: "compound-1",
		sources: [{ id: "source-1", op: "union" }],
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
						brushSettings: { type: "line", size: 6, opacity: 1 },
					},
				},
			} as unknown as StrokeAppearance,
			{
				processor: "fill",
				paramData: {
					version: "1",
					params: {
						fill: {
							type: "solid",
							color: { type: "rgb", r: 0.8, g: 0.2, b: 0.2, a: 1 },
						},
					},
				},
			} as FillAppearance,
		],
		opacity: 0.7,
		blendMode: "normal",
		transform: createIdentityTransform(),
		...overrides,
	};
}
