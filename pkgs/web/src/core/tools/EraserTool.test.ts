import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentityTransform } from "../document/factory";
import { interpolateStrokeWidths } from "../renderer/geometry/strokeTessellator";
import type { AnyArtObject, Layer, Path, StrokeAppearance } from "../schema";
import { createMockToolContext } from "../testUtils/mockToolContext";
import {
	ev,
	testCanvasHeight,
	testCanvasWidth,
	testViewport,
} from "../testUtils/pointerEvent";
import { EraserTool } from "./EraserTool";

// Default viewport (0,0,zoom=1), canvas 800×600:
//   screen(400,300) → world(0,0)
//   screen(500,300) → world(100,0)
//   screen(400,100) → world(0,200)

/** Straight-line path from world(0,0) to world(100,0) */
const testPath: Path = {
	id: "path-1",
	type: "path",
	opacity: 1,
	blendMode: "normal",
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
					brushSettings: { type: "line", size: 2, opacity: 1 },
				},
			},
		} as unknown as StrokeAppearance,
	],
	segments: [
		{
			start: { x: 0, y: 0 },
			cp1: { x: 33, y: 0 },
			cp2: { x: -34, y: 0 },
			end: { x: 100, y: 0 },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: false,
		},
	],
	transform: createIdentityTransform(),
};

const testLayer: Layer = {
	id: "l1",
	name: "Layer 1",
	visible: true,
	locked: false,
	opacity: 1,
	elementIds: ["path-1"],
};

function createMockOptions() {
	return {
		width: 2,
		getCurrentLayer: vi.fn<() => Layer | null>(() => null),
		getObjects: vi.fn<() => Record<string, AnyArtObject>>(() => ({})),
	};
}

describe("EraserTool", () => {
	let tool: EraserTool;
	let opts: ReturnType<typeof createMockOptions>;
	let ctx: ReturnType<typeof createMockToolContext>;

	beforeEach(() => {
		opts = createMockOptions();
		ctx = createMockToolContext({
			getCurrentLayer: opts.getCurrentLayer,
			getObjects: opts.getObjects,
		});
		tool = new EraserTool(ctx, { width: opts.width, mode: "slice" as const });
	});

	it("should have name 'eraser'", () => {
		expect(tool.name).toBe("eraser");
	});

	describe("Stroke lifecycle", () => {
		it("should start stroke on pointer down", () => {
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const stroke = tool.getCurrentStroke();
			expect(stroke).not.toBeNull();
			expect(stroke).toHaveLength(1);
			expect(stroke?.[0].x).toBeCloseTo(0);
			expect(stroke?.[0].y).toBeCloseTo(0);
		});

		it("should add points on pointer move", () => {
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(450, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(tool.getCurrentStroke()).toHaveLength(3);
		});

		it("should clear stroke on pointer up", () => {
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(tool.getCurrentStroke()).toBeNull();
		});

		it("should reset stroke on cancel", () => {
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(450, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onCancel();

			expect(tool.getCurrentStroke()).toBeNull();
		});
	});

	describe("Erasing paths", () => {
		it("should collapse a matching-width path without cutting it", () => {
			// Setup: layer with testPath
			opts.getCurrentLayer.mockReturnValue(testLayer);
			opts.getObjects.mockReturnValue({ "path-1": testPath });

			// Stroke directly over the path: world(0,0) → world(100,0)
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.mockCommands.deleteElements).not.toHaveBeenCalled();
			expect(ctx.mockCommands.updateElement).toHaveBeenCalled();
		});

		it("should erase paths on every layer when pierce mode is on", () => {
			// Two layers, each holding a path over the stroke line (world y=0).
			const secondPath = { ...testPath, id: "path-2" };
			const secondLayer: Layer = {
				...testLayer,
				id: "l2",
				name: "Layer 2",
				elementIds: ["path-2"],
			};
			const pierceCtx = createMockToolContext({
				getCurrentLayer: vi.fn(() => testLayer),
				getLayers: vi.fn(() => [testLayer, secondLayer]),
				getObjects: vi.fn(() => ({
					"path-1": testPath,
					"path-2": secondPath,
				})),
			});
			const pierceTool = new EraserTool(pierceCtx, {
				width: opts.width,
				mode: "slice" as const,
				pierceAllLayers: true,
			});

			// Stroke over both paths: world(0,0) → world(100,0)
			pierceTool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			pierceTool.onPointerMove(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			pierceTool.onPointerUp(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const updatedIds = pierceCtx.mockCommands.updateElement.mock.calls.map(
				(call) => call[1],
			);
			expect(updatedIds).toEqual(expect.arrayContaining(["path-1", "path-2"]));
		});

		it("should not erase path when stroke is far away", () => {
			opts.getCurrentLayer.mockReturnValue(testLayer);
			opts.getObjects.mockReturnValue({ "path-1": testPath });

			// Stroke far from path: world(0,200) → world(100,200), 200 units away
			// eraserRadius = width = 2, so 200 >> 2
			tool.onPointerDown(
				ev(400, 100),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(500, 100),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 100),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.mockCommands.deleteElements).not.toHaveBeenCalled();
		});

		it("should retain a zero-width interval without creating path fragments", () => {
			opts.getCurrentLayer.mockReturnValue(testLayer);
			opts.getObjects.mockReturnValue({ "path-1": testPath });

			// Stroke over the middle of the path: world(40,0) → world(60,0)
			// Equal eraser and stroke half-widths collapse the overlap without crossing it.
			tool.onPointerDown(
				ev(440, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(460, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(460, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.mockCommands.deleteElements).not.toHaveBeenCalled();
			expect(ctx.mockCommands.addPaths).not.toHaveBeenCalled();
			expect(ctx.mockCommands.updateElement).toHaveBeenCalled();
		});

		it("should not erase when layer is null", () => {
			// getCurrentLayer returns null (default)
			opts.getObjects.mockReturnValue({ "path-1": testPath });

			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.mockCommands.deleteElements).not.toHaveBeenCalled();
		});

		it("should process a single-point stroke without cutting at zero width", () => {
			opts.getCurrentLayer.mockReturnValue(testLayer);
			opts.getObjects.mockReturnValue({ "path-1": testPath });

			// PointerDown directly on path, but no move → single-point stroke
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Single-point stroke still checks intersection.
			// The point world(0,0) is at the path start, within eraserRadius=20.
			// EraserTool processes single-point strokes and retains the collapsed endpoint.
			expect(ctx.mockCommands.deleteElements).not.toHaveBeenCalled();
			expect(ctx.mockCommands.updateElement).toHaveBeenCalled();
		});
	});

	describe("Width-adjust mode", () => {
		let widthTool: EraserTool;
		let widthCtx: ReturnType<typeof createMockToolContext>;

		// Thick path (brushSize=80, brushHalfSize=40) avoids triggering slice
		// when eraser is positioned at the stroke edge (distance > eraserRadius)
		const thickStrokeFilter = {
			processor: "stroke",
			paramData: {
				version: "1",
				params: {
					strokeColor: {
						type: "solid",
						color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
					},
					brushSettings: { type: "line", size: 80, opacity: 1 },
				},
			},
		} as unknown as StrokeAppearance;

		const thickTestPath: Path = {
			...testPath,
			filters: [thickStrokeFilter],
		};

		const thickTestLayer: Layer = {
			...testLayer,
		};

		beforeEach(() => {
			widthCtx = createMockToolContext({
				getCurrentLayer: opts.getCurrentLayer,
				getObjects: opts.getObjects,
			});
			// eraserRadius=20, coarseHitRadius=20+40=60
			widthTool = new EraserTool(widthCtx, {
				width: 40,
				mode: "width-adjust" as const,
			});
			opts.getCurrentLayer.mockReturnValue(thickTestLayer);
			opts.getObjects.mockReturnValue({ "path-1": thickTestPath });
		});

		it("should ignore the empty space between separate subpaths", () => {
			const multiSubpath: Path = {
				...thickTestPath,
				id: "path-multi-subpath",
				segments: [
					thickTestPath.segments[0],
					{
						start: { x: 300, y: 0 },
						cp1: { x: 33, y: 0 },
						cp2: { x: -34, y: 0 },
						end: { x: 400, y: 0 },
						isMoved: true,
						startTiltX: 0,
						startTiltY: 0,
						endTiltX: 0,
						endTiltY: 0,
						startDeltaTime: 0,
						endDeltaTime: 0,
					},
				],
			};
			opts.getCurrentLayer.mockReturnValue({
				...thickTestLayer,
				elementIds: [multiSubpath.id],
			});
			opts.getObjects.mockReturnValue({ [multiSubpath.id]: multiSubpath });

			widthTool.onPointerDown(
				ev(600, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerUp(
				ev(600, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(widthCtx.mockCommands.updateElement).not.toHaveBeenCalled();
			expect(widthCtx.mockCommands.deleteElements).not.toHaveBeenCalled();
			expect(widthCtx.mockCommands.addPaths).not.toHaveBeenCalled();
		});

		/** Thick path with existing strokeWidths at t=0.2 and t=0.8 */
		const pathWithWidths: Path = {
			...thickTestPath,
			strokeWidths: [
				{ t: 0.2, side1: 0.5, side2: 1 },
				{ t: 0.8, side1: 1, side2: 0.5 },
			],
		};

		/** Thick path translated to world(200, 100) */
		const translatedPath: Path = {
			...thickTestPath,
			id: "path-translated",
			transform: { x: 200, y: 100, rotation: 0, scaleX: 1, scaleY: 1 },
		};

		const translatedLayer: Layer = {
			id: "l1",
			name: "Layer 1",
			visible: true,
			locked: false,
			opacity: 1,
			elementIds: ["path-translated"],
		};

		it("should create strokeWidths when erasing near the edge of a thick path", () => {
			// Thick path at y=0 (brushHalfSize=40, stroke extends y=[-40,40])
			// Eraser at y=30: distance=30 > eraserRadius=20 → no slice
			// coarseHitRadius=60 > 30 → hit. nearEdge=10, side1Ratio=10/40=0.25
			// screen(450,270) → world(50,30), screen(450,260) → world(50,40)
			widthTool.onPointerDown(
				ev(450, 270),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerMove(
				ev(450, 260),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerUp(
				ev(450, 260),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(widthCtx.transact).toHaveBeenCalled();
			expect(widthCtx.mockCommands.updateElement).toHaveBeenCalled();

			const widths = (
				widthCtx.mockCommands.updateElement.mock.calls.at(
					-1,
				)![2] as Partial<Path>
			).strokeWidths as Array<{
				t: number;
				side1: number;
				side2: number;
			}>;
			expect(widths.length).toBeGreaterThanOrEqual(1);
			const midPoint = widths.find((w) => Math.abs(w.t - 0.5) < 0.15);
			expect(midPoint).toBeDefined();
		});

		it("should not modify strokeWidths when erasing far from the path", () => {
			// Stroke far from path: world(50,200) area, well beyond coarseHitRadius=60
			widthTool.onPointerDown(
				ev(450, 100),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerMove(
				ev(460, 100),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerUp(
				ev(460, 100),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(widthCtx.mockCommands.updateElement).not.toHaveBeenCalled();
		});

		it("should reduce side1 when erasing from above (positive normal)", () => {
			// Path is horizontal (0,0)→(100,0). Normal = (0,1) = upward.
			// Erase from above: world(50,30) → screen(450,270). Single point.
			// distance=30 > eraserRadius=20 → no slice. nearEdge=10.
			// side1Ratio = 10/40 = 0.25. side2 preserved (eraser doesn't cross center).
			widthTool.onPointerDown(
				ev(450, 270),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerUp(
				ev(450, 270),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(widthCtx.mockCommands.updateElement).toHaveBeenCalled();
			const widths = (
				widthCtx.mockCommands.updateElement.mock.calls.at(
					-1,
				)![2] as Partial<Path>
			).strokeWidths as Array<{
				t: number;
				side1: number;
				side2: number;
			}>;
			expect(widths.length).toBeGreaterThanOrEqual(1);
			const pt = widths.find((w) => Math.abs(w.t - 0.5) < 0.15)!;
			expect(pt).toBeDefined();
			expect(pt.side1).toBeLessThan(1);
			// Eraser doesn't cross center → opposite side preserved
			expect(pt.side2).toBe(1);
		});

		it("should reduce side2 when erasing from below (negative normal)", () => {
			// Erase from below: world(50,-30) → screen(450,330)
			// distance=30 > eraserRadius=20 → no slice. side2 reduced, side1 preserved.
			widthTool.onPointerDown(
				ev(450, 330),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerUp(
				ev(450, 330),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(widthCtx.mockCommands.updateElement).toHaveBeenCalled();
			const widths = (
				widthCtx.mockCommands.updateElement.mock.calls.at(
					-1,
				)![2] as Partial<Path>
			).strokeWidths as Array<{
				t: number;
				side1: number;
				side2: number;
			}>;
			const pt = widths.find((w) => Math.abs(w.t - 0.5) < 0.15)!;
			expect(pt).toBeDefined();
			expect(pt.side1).toBe(1);
			expect(pt.side2).toBeLessThan(1);
		});

		it("should create new control points between existing strokeWidths with correct values", () => {
			// Path has existing widths at t=0.2(side1=0.5) and t=0.8(side1=1)
			// Erase from above at t≈0.5 with thick path (distance > eraserRadius → no slice)
			opts.getObjects.mockReturnValue({ "path-1": pathWithWidths });

			// world(50,30) → screen(450,270)
			widthTool.onPointerDown(
				ev(450, 270),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerUp(
				ev(450, 270),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(widthCtx.mockCommands.updateElement).toHaveBeenCalled();
			const widths = (
				widthCtx.mockCommands.updateElement.mock.calls.at(
					-1,
				)![2] as Partial<Path>
			).strokeWidths as Array<{
				t: number;
				side1: number;
				side2: number;
			}>;
			// Should have more than original 2 points
			expect(widths.length).toBeGreaterThan(2);
			// New point between existing ones
			const midPt = widths.find((w) => w.t > 0.25 && w.t < 0.75)!;
			expect(midPt).toBeDefined();
			// side1 reduced (erasing from above), side2 preserved
			expect(midPt.side1).toBeLessThan(1);
		});

		it("should preserve the width profile outside the erased range", () => {
			opts.getObjects.mockReturnValue({ "path-1": pathWithWidths });
			const beforeLeft = interpolateStrokeWidths(
				pathWithWidths.strokeWidths!,
				0.25,
			);
			const beforeRight = interpolateStrokeWidths(
				pathWithWidths.strokeWidths!,
				0.75,
			);

			widthTool.onPointerDown(
				ev(450, 270),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerUp(
				ev(450, 270),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const widths = (
				widthCtx.mockCommands.updateElement.mock.calls.at(
					-1,
				)![2] as Partial<Path>
			).strokeWidths!;
			const afterLeft = interpolateStrokeWidths(widths, 0.25);
			const afterRight = interpolateStrokeWidths(widths, 0.75);

			expect(afterLeft.side1).toBeCloseTo(beforeLeft.side1);
			expect(afterLeft.side2).toBeCloseTo(beforeLeft.side2);
			expect(afterRight.side1).toBeCloseTo(beforeRight.side1);
			expect(afterRight.side2).toBeCloseTo(beforeRight.side2);
		});

		it("should work on paths with non-identity transform (translation)", () => {
			// Thick path translated to world(200,100), runs world(200,100)→(300,100)
			// Erase from above at world(250,130) → screen(650,170)
			// distance=30 > eraserRadius=20 → no slice
			opts.getCurrentLayer.mockReturnValue(translatedLayer);
			opts.getObjects.mockReturnValue({ "path-translated": translatedPath });

			widthTool.onPointerDown(
				ev(650, 170),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerMove(
				ev(650, 160),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerUp(
				ev(650, 160),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(widthCtx.mockCommands.updateElement).toHaveBeenCalled();
			const args = widthCtx.mockCommands.updateElement.mock.calls.at(-1)!;
			expect(args[1]).toBe("path-translated");
			const widths = (args[2] as Partial<Path>).strokeWidths as Array<{
				t: number;
				side1: number;
				side2: number;
			}>;
			expect(widths.length).toBeGreaterThanOrEqual(1);
			const midPoint = widths.find((w) => Math.abs(w.t - 0.5) < 0.15);
			expect(midPoint).toBeDefined();
			expect(midPoint!.side1).toBeLessThan(1);
		});

		it("should work on paths with non-identity transform (rotation)", () => {
			// Thick path rotated 90°: local(0,0)→(100,0) → world(50,-50)→(50,50)
			// Path is vertical at x=50. brushHalfSize=40, stroke extends x=[10,90]
			const rotatedPath: Path = {
				...thickTestPath,
				id: "path-rotated",
				transform: {
					x: 0,
					y: 0,
					rotation: Math.PI / 2,
					scaleX: 1,
					scaleY: 1,
				},
			};
			const rotatedLayer: Layer = {
				...testLayer,
				elementIds: ["path-rotated"],
			};
			opts.getCurrentLayer.mockReturnValue(rotatedLayer);
			opts.getObjects.mockReturnValue({ "path-rotated": rotatedPath });

			// Erase at world(80,0) → screen(480,300). Distance from path (x=50) = 30 > 20 → no slice
			widthTool.onPointerDown(
				ev(480, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerMove(
				ev(490, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerUp(
				ev(490, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(widthCtx.mockCommands.updateElement).toHaveBeenCalled();
			const args = widthCtx.mockCommands.updateElement.mock.calls.at(-1)!;
			expect(args[1]).toBe("path-rotated");
			const widths = (args[2] as Partial<Path>).strokeWidths as Array<{
				t: number;
				side1: number;
				side2: number;
			}>;
			expect(widths.length).toBeGreaterThanOrEqual(1);
			const midPoint = widths.find((w) => Math.abs(w.t - 0.5) < 0.15);
			expect(midPoint).toBeDefined();
			expect(Math.min(midPoint!.side1, midPoint!.side2)).toBeLessThan(1);
		});

		it("should correctly interpolate when multiple eraser points create unsorted t values", () => {
			// 3+ eraser points at different t positions along thick path, all from same side
			// world(20,30)→(80,30)→(50,30): all at distance=30 > eraserRadius=20 → no slice
			// screen: (420,270)→(480,270)→(450,270)
			widthTool.onPointerDown(
				ev(420, 270),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerMove(
				ev(480, 270),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerMove(
				ev(450, 270),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerUp(
				ev(450, 270),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(widthCtx.mockCommands.updateElement).toHaveBeenCalled();
			const widths = (
				widthCtx.mockCommands.updateElement.mock.calls.at(
					-1,
				)![2] as Partial<Path>
			).strokeWidths as Array<{
				t: number;
				side1: number;
				side2: number;
			}>;
			// Result should be sorted by t
			for (let i = 1; i < widths.length; i++) {
				expect(widths[i].t).toBeGreaterThanOrEqual(widths[i - 1].t);
			}
			// Peak points should have reduced widths on the erased side (side1)
			const peaks = widths.filter((w) => w.side1 < 1);
			expect(peaks.length).toBeGreaterThanOrEqual(1);
		});

		it("should merge near-identical t values using per-side minimum", () => {
			// Two eraser points at nearly the same t from the same side
			// world(49,30) and world(51,30): both near t≈0.5, both from above
			// screen(449,270) and screen(451,270)
			widthTool.onPointerDown(
				ev(449, 270),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerMove(
				ev(451, 270),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerUp(
				ev(451, 270),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(widthCtx.mockCommands.updateElement).toHaveBeenCalled();
			const widths = (
				widthCtx.mockCommands.updateElement.mock.calls.at(
					-1,
				)![2] as Partial<Path>
			).strokeWidths as Array<{
				t: number;
				side1: number;
				side2: number;
			}>;
			const midPt = widths.find((w) => Math.abs(w.t - 0.5) < 0.15)!;
			expect(midPt).toBeDefined();
			// Hit from above → side1 reduced
			expect(midPt.side1).toBeLessThan(1);
		});

		it("should hit thick strokes when erasing near the edge", () => {
			// Thick stroke: brushSettings.size = 40, so brushHalfSize = 20
			const thickPath: Path = {
				...testPath,
				id: "path-thick",
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
								brushSettings: { type: "line", size: 40, opacity: 1 },
							},
						},
					} as unknown as StrokeAppearance,
				],
			};
			const thickLayer: Layer = {
				...testLayer,
				elementIds: ["path-thick"],
			};
			opts.getCurrentLayer.mockReturnValue(thickLayer);
			opts.getObjects.mockReturnValue({ "path-thick": thickPath });

			// Path center at y=0. brushHalfSize=20, eraserRadius=20.
			// hitRadius = 20+20 = 40. Erase at world(50,30) → 30 units from center.
			// 30 < 40 → should hit. Without brushHalfSize: 30 > 20 → would miss.
			// screen(450, 270) → world(50, 30)
			widthTool.onPointerDown(
				ev(450, 270),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerUp(
				ev(450, 270),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(widthCtx.mockCommands.updateElement).toHaveBeenCalled();
			const widths = (
				widthCtx.mockCommands.updateElement.mock.calls.at(
					-1,
				)![2] as Partial<Path>
			).strokeWidths as Array<{
				t: number;
				side1: number;
				side2: number;
			}>;
			const pt = widths.find((w) => Math.abs(w.t - 0.5) < 0.15)!;
			expect(pt).toBeDefined();
			// Erased from above (+normal) → side1 reduced
			expect(pt.side1).toBeLessThan(1);
		});

		describe("Geometric overlap reduction", () => {
			// Uses thickPath (brushSize=40, brushHalfSize=20) and eraserRadius=20
			const thickPath: Path = {
				...testPath,
				id: "path-thick",
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
								brushSettings: { type: "line", size: 40, opacity: 1 },
							},
						},
					} as unknown as StrokeAppearance,
				],
			};
			const thickLayer: Layer = {
				...testLayer,
				elementIds: ["path-thick"],
			};

			beforeEach(() => {
				opts.getCurrentLayer.mockReturnValue(thickLayer);
				opts.getObjects.mockReturnValue({ "path-thick": thickPath });
			});

			it("should barely reduce width when eraser edge just touches stroke edge", () => {
				// Path at y=0, brushHalfSize=20, stroke extends y=[-20,20]
				// Eraser at world(50,39), eraserRadius=20 → near edge at 39-20=19
				// closestSideRatio = min(1, 19/20) = 0.95
				// screen(450, 261) → world(50, 39)
				widthTool.onPointerDown(
					ev(450, 261),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);
				widthTool.onPointerUp(
					ev(450, 261),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);

				expect(widthCtx.mockCommands.updateElement).toHaveBeenCalled();
				const widths = (
					widthCtx.mockCommands.updateElement.mock.calls.at(
						-1,
					)![2] as Partial<Path>
				).strokeWidths as Array<{
					t: number;
					side1: number;
					side2: number;
				}>;
				const pt = widths.find((w) => Math.abs(w.t - 0.5) < 0.15)!;
				expect(pt).toBeDefined();
				// Barely touched → side1 close to 1 (0.95)
				expect(pt.side1).toBeGreaterThan(0.9);
				expect(pt.side1).toBeLessThan(1);
				// side2 unchanged
				expect(pt.side2).toBe(1);
			});

			it("should reduce width by half when eraser covers half the stroke", () => {
				// Eraser at world(50,30), eraserRadius=20 → near edge at 30-20=10
				// closestSideRatio = min(1, 10/20) = 0.5
				// screen(450, 270) → world(50, 30)
				widthTool.onPointerDown(
					ev(450, 270),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);
				widthTool.onPointerUp(
					ev(450, 270),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);

				expect(widthCtx.mockCommands.updateElement).toHaveBeenCalled();
				const widths = (
					widthCtx.mockCommands.updateElement.mock.calls.at(
						-1,
					)![2] as Partial<Path>
				).strokeWidths as Array<{
					t: number;
					side1: number;
					side2: number;
				}>;
				const pt = widths.find((w) => Math.abs(w.t - 0.5) < 0.15)!;
				expect(pt).toBeDefined();
				// Half covered → side1 = 0.5
				expect(pt.side1).toBeCloseTo(0.5, 1);
				// side2 unchanged
				expect(pt.side2).toBe(1);
			});

			it("should preserve a zero-width point when erasing exactly through the opposite boundary", () => {
				// Eraser at world(50,0), eraserRadius=20 and brushHalfSize=20.
				// side1 becomes -1 while side2 remains 1, so the total width is exactly 0.
				// screen(450, 300) → world(50, 0)
				widthTool.onPointerDown(
					ev(450, 300),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);
				widthTool.onPointerUp(
					ev(450, 300),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);

				expect(widthCtx.mockCommands.deleteElements).not.toHaveBeenCalled();
				const widths = (
					widthCtx.mockCommands.updateElement.mock.calls.at(
						-1,
					)![2] as Partial<Path>
				).strokeWidths!;
				const point = widths.find(({ t }) => Math.abs(t - 0.5) < 0.15)!;
				expect(point.side1).toBeCloseTo(-1);
				expect(point.side2).toBe(1);
				expect(point.side1 + point.side2).toBeCloseTo(0);
			});

			it("should preserve existing stroke widths when slicing a path", () => {
				const longPathWithWidths: Path = {
					...pathWithWidths,
					strokeWidths: [
						{ t: 0.1, side1: 0.5, side2: 1 },
						{ t: 0.9, side1: 1, side2: 0.5 },
					],
					segments: [
						{
							...pathWithWidths.segments[0],
							cp1: { x: 66, y: 0 },
							cp2: { x: -67, y: 0 },
							end: { x: 200, y: 0 },
						},
					],
				};
				opts.getCurrentLayer.mockReturnValue(thickTestLayer);
				opts.getObjects.mockReturnValue({ "path-1": longPathWithWidths });
				const cutTool = new EraserTool(widthCtx, {
					width: 80,
					mode: "width-adjust",
				});

				cutTool.onPointerDown(
					ev(500, 300),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);
				cutTool.onPointerUp(
					ev(500, 300),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);

				const splitPaths = widthCtx.mockCommands.addPaths.mock.calls.at(
					-1,
				)![0] as Path[];
				expect(splitPaths).toHaveLength(2);

				const [firstPath, secondPath] = splitPaths.toSorted(
					(a, b) => (a.pathStart ?? 0) - (b.pathStart ?? 0),
				);
				const firstSpan = (firstPath.pathEnd ?? 1) - (firstPath.pathStart ?? 0);
				const secondSpan =
					(secondPath.pathEnd ?? 1) - (secondPath.pathStart ?? 0);
				const firstWidth = firstPath.strokeWidths?.find(
					({ side1, side2 }) => side1 === 0.5 && side2 === 1,
				);
				const secondWidth = secondPath.strokeWidths?.find(
					({ side1, side2 }) => side1 === 1 && side2 === 0.5,
				);

				expect(firstWidth?.t).toBeCloseTo(
					(0.1 - (firstPath.pathStart ?? 0)) / firstSpan,
				);
				expect(secondWidth?.t).toBeCloseTo(
					(0.9 - (secondPath.pathStart ?? 0)) / secondSpan,
				);
			});

			it("should preserve one-sided width at split endpoints", () => {
				const oneSidedPath: Path = {
					...thickTestPath,
					strokeWidths: [
						{ t: 0, side1: 1, side2: 0 },
						{ t: 1, side1: 1, side2: 0 },
					],
				};
				opts.getCurrentLayer.mockReturnValue(thickTestLayer);
				opts.getObjects.mockReturnValue({ "path-1": oneSidedPath });

				widthTool.onPointerDown(
					ev(450, 300),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);
				widthTool.onPointerUp(
					ev(450, 300),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);

				const splitPaths = widthCtx.mockCommands.addPaths.mock.calls.at(
					-1,
				)![0] as Path[];
				expect(splitPaths).toHaveLength(2);
				const [firstPath, secondPath] = splitPaths.toSorted(
					(a, b) => (a.pathStart ?? 0) - (b.pathStart ?? 0),
				);
				expect(firstPath.strokeWidths?.[0]).toEqual({
					t: 0,
					side1: 1,
					side2: 0,
				});
				expect(firstPath.strokeWidths?.at(-1)?.side1).toBe(0);
				expect(firstPath.strokeWidths?.at(-1)?.side2).toBe(0);
				expect(secondPath.strokeWidths?.[0].side1).toBe(0);
				expect(secondPath.strokeWidths?.[0].side2).toBe(0);
				expect(secondPath.strokeWidths?.at(-1)).toEqual({
					t: 1,
					side1: 1,
					side2: 0,
				});
			});
			it("should persist a negative side without changing the opposite side", () => {
				// Eraser at world(50,10), eraserRadius=20 → side1=-0.5, side2=1.
				// The signed total remains positive, so the path must stay connected.
				// screen(450, 290) → world(50, 10)
				widthTool.onPointerDown(
					ev(450, 290),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);
				widthTool.onPointerUp(
					ev(450, 290),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);

				expect(widthCtx.mockCommands.deleteElements).not.toHaveBeenCalled();
				const widths = (
					widthCtx.mockCommands.updateElement.mock.calls.at(
						-1,
					)![2] as Partial<Path>
				).strokeWidths!;
				const point = widths.find(({ t }) => Math.abs(t - 0.5) < 0.15)!;
				expect(point.side1).toBeCloseTo(-0.5);
				expect(point.side2).toBe(1);
			});

			it("should split only the interval whose signed total width is negative", () => {
				opts.getCurrentLayer.mockReturnValue({
					...thickTestLayer,
					elementIds: ["before", "path-thick", "after"],
				});
				const cutTool = new EraserTool(widthCtx, {
					width: 60,
					mode: "width-adjust",
				});

				cutTool.onPointerDown(
					ev(450, 300),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);
				cutTool.onPointerUp(
					ev(450, 300),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);

				expect(widthCtx.mockCommands.deleteElements).toHaveBeenCalledWith([
					"path-thick",
				]);
				const splitPaths = widthCtx.mockCommands.addPaths.mock.calls.at(
					-1,
				)![0] as Path[];
				expect(splitPaths).toHaveLength(2);
				expect(widthCtx.mockCommands.addPaths).toHaveBeenLastCalledWith(
					splitPaths,
					1,
					thickTestLayer.id,
				);
				const [first, second] = splitPaths.toSorted(
					(a, b) => (a.pathStart ?? 0) - (b.pathStart ?? 0),
				);
				expect(first.pathEnd).toBeLessThan(second.pathStart!);
				for (const path of splitPaths) {
					for (const width of path.strokeWidths ?? []) {
						expect(width.side1 + width.side2).toBeGreaterThanOrEqual(-1e-10);
					}
				}
			});
		});

		it("should work on scaled paths", () => {
			// Thick path (brushSize=80) scaled 2x
			const scaledPath: Path = {
				...thickTestPath,
				id: "path-scaled",
				transform: { x: 0, y: 0, rotation: 0, scaleX: 2, scaleY: 2 },
			};
			const scaledLayer: Layer = {
				...testLayer,
				elementIds: ["path-scaled"],
			};
			opts.getCurrentLayer.mockReturnValue(scaledLayer);
			opts.getObjects.mockReturnValue({ "path-scaled": scaledPath });

			// Path scaled 2x: local(0,0)→(100,0) → world(-50,0)→(150,0)
			// localEraserRadius = 20/2 = 10. Erase at world(50,25):
			// local(50,12.5), distance=12.5 > 10 → no slice
			// coarseHitRadius = 10+40 = 50 > 12.5 → hit
			// screen(450,275) → world(50,25), screen(450,265) → world(50,35)
			widthTool.onPointerDown(
				ev(450, 275),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerMove(
				ev(450, 265),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerUp(
				ev(450, 265),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(widthCtx.mockCommands.updateElement).toHaveBeenCalled();
			const args = widthCtx.mockCommands.updateElement.mock.calls.at(-1)!;
			expect(args[1]).toBe("path-scaled");
			const widths = (args[2] as Partial<Path>).strokeWidths as Array<{
				t: number;
				side1: number;
				side2: number;
			}>;
			expect(widths.length).toBeGreaterThanOrEqual(1);
			const peakPt = widths.find(
				(w) => Math.abs(w.t - 0.5) < 0.15 && w.side1 < 1,
			);
			expect(peakPt).toBeDefined();
			expect(peakPt!.side1).toBeLessThan(1);
		});
	});

	describe("Ancestor transform resolution", () => {
		it("should erase path inside a translated group (slice mode)", () => {
			// Path at local(0,0)→(100,0) inside a group translated by (200,100)
			// World position: (200,100)→(300,100)
			const groupedPath: Path = {
				...testPath,
				id: "path-in-group",
			};
			const groupLayer: Layer = {
				...testLayer,
				elementIds: ["path-in-group"],
			};
			const ctx = createMockToolContext({
				getCurrentLayer: vi.fn(() => groupLayer),
				getObjects: vi.fn(() => ({
					"path-in-group": groupedPath,
				})),
				getAncestorTransform: vi.fn(() => ({
					x: 200,
					y: 100,
					rotation: 0,
					scaleX: 1,
					scaleY: 1,
				})),
			});
			const sliceTool = new EraserTool(ctx, { width: 40, mode: "slice" });

			// Stroke at world(250,100) — middle of the group-translated path
			// screen(650,200) → world(250,100)
			sliceTool.onPointerDown(
				ev(650, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			sliceTool.onPointerMove(
				ev(700, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			sliceTool.onPointerUp(
				ev(700, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.mockCommands.deleteElements).toHaveBeenCalledWith([
				"path-in-group",
			]);
		});

		it("should NOT erase path when stroke is at local position but wrong world position", () => {
			// Path inside group at (200,100). Stroke at world(50,0) would hit
			// local(50,0) but misses in world space.
			const groupedPath: Path = {
				...testPath,
				id: "path-in-group",
			};
			const groupLayer: Layer = {
				...testLayer,
				elementIds: ["path-in-group"],
			};
			const ctx = createMockToolContext({
				getCurrentLayer: vi.fn(() => groupLayer),
				getObjects: vi.fn(() => ({
					"path-in-group": groupedPath,
				})),
				getAncestorTransform: vi.fn(() => ({
					x: 200,
					y: 100,
					rotation: 0,
					scaleX: 1,
					scaleY: 1,
				})),
			});
			const sliceTool = new EraserTool(ctx, { width: 2, mode: "slice" });

			// Stroke at world(50,0) — would hit if no group transform
			sliceTool.onPointerDown(
				ev(450, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			sliceTool.onPointerMove(
				ev(460, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			sliceTool.onPointerUp(
				ev(460, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.mockCommands.deleteElements).not.toHaveBeenCalled();
		});

		it("should width-adjust path inside a rotated group", () => {
			// Thick path local(0,0)→(100,0) inside a group rotated 90°
			// After rotation: path vertical at world x=50, from world(50,-50) to world(50,50)
			// brushHalfSize=40, stroke extends x=[10,90]
			const groupedPath: Path = {
				id: "path-in-rotated-group",
				type: "path",
				opacity: 1,
				blendMode: "normal",
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
								brushSettings: { type: "line", size: 80, opacity: 1 },
							},
						},
					} as unknown as StrokeAppearance,
				],
				segments: testPath.segments,
				transform: createIdentityTransform(),
			};
			const groupLayer: Layer = {
				...testLayer,
				elementIds: ["path-in-rotated-group"],
			};
			const ctx = createMockToolContext({
				getCurrentLayer: vi.fn(() => groupLayer),
				getObjects: vi.fn(() => ({
					"path-in-rotated-group": groupedPath,
				})),
				getAncestorTransform: vi.fn(() => ({
					x: 0,
					y: 0,
					rotation: Math.PI / 2,
					scaleX: 1,
					scaleY: 1,
				})),
			});
			const widthTool = new EraserTool(ctx, {
				width: 40,
				mode: "width-adjust",
			});

			// Erase at world(80,0) → screen(480,300). Distance from path (x=50) = 30.
			// In local: (50,-30), distance=30 > eraserRadius=20 → no slice
			// coarseHitRadius=20+40=60 > 30 → hit
			widthTool.onPointerDown(
				ev(480, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerMove(
				ev(490, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			widthTool.onPointerUp(
				ev(490, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.mockCommands.updateElement).toHaveBeenCalled();
		});
	});

	describe("Cursor", () => {
		it("should return SVG circle cursor", () => {
			const cursor = tool.getCursor();
			expect(cursor).toContain("none");
		});
	});
});
