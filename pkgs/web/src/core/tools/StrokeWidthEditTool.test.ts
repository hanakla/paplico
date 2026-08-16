import { beforeEach, describe, expect, it } from "vitest";
import type { CirclePrimitive, UIOverlay } from "../renderer/ui/primitives";
import { UI_THEME } from "../renderer/ui/theme";
import type { Path, StrokeWidthPoint } from "../schema";
import {
	createMockToolContext,
	type MockToolContext,
} from "../testUtils/mockToolContext";
import {
	ev,
	testCanvasHeight,
	testCanvasWidth,
	testViewport,
} from "../testUtils/pointerEvent";
import { StrokeWidthEditTool } from "./StrokeWidthEditTool";

function createTestPath(strokeWidths?: StrokeWidthPoint[]): Path {
	return {
		type: "path",
		id: "path-1",
		opacity: 1,
		blendMode: "normal",
		segments: [
			{
				start: { x: -100, y: 0 },
				cp1: { x: 33, y: 0 },
				cp2: { x: -33, y: 0 },
				end: { x: 100, y: 0 },
				isMoved: true,
			},
		],
		filters: [
			{
				uid: "stroke-1",
				processor: "stroke" as const,
				enabled: true,
				opacity: 1,
				blendMode: "normal" as const,
				paramData: {
					version: "1",
					params: {
						strokeColor: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 },
						brushSettings: {
							version: 2 as const,
							engine: "geometric" as const,
							strokeOpacity: 1,
							paintMode: "buildup" as const,
							properties: { size: { base: 20 } },
							stroking: {
								lineCap: "round" as const,
								lineJoin: "round" as const,
								miterLimit: 4,
							},
							randomSeed: 0,
						},
					},
				},
			},
		],
		strokeWidths,
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
	} as unknown as Path;
}

/** Path whose brush settings / segment pressures drive the rendered width. */
function createBrushTestPath(options: {
	brushSettings: Record<string, unknown>;
	startPressure?: number;
	endPressure?: number;
	strokeWidths?: StrokeWidthPoint[];
}): Path {
	const base = createTestPath(options.strokeWidths);
	return {
		...base,
		segments: [
			{
				...base.segments[0],
				startPressure: options.startPressure,
				endPressure: options.endPressure,
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 200,
			},
		],
		filters: [
			{
				...base.filters![0],
				paramData: {
					version: "1",
					params: {
						strokeColor: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 },
						brushSettings: options.brushSettings,
					},
				},
			},
		],
	} as unknown as Path;
}

/** Last "stroke-width/handles" overlay pushed through the generic channel. */
function lastStrokeWidthOverlay(ctx: MockToolContext): UIOverlay | null {
	const call = ctx.uiSetOverlay.mock.calls
		.filter(([key]) => key === "stroke-width/handles")
		.at(-1);
	return call ? call[1] : null;
}

/** Handle circles carry hitId ("<pointIndex>:<side>"). */
function getHandleCircles(
	ctx: MockToolContext,
): Array<CirclePrimitive & { hitId: string }> {
	const overlay = lastStrokeWidthOverlay(ctx);
	if (!overlay) return [];
	return overlay.primitives.filter(
		(p): p is CirclePrimitive & { hitId: string } =>
			p.kind === "circle" && p.hitId != null,
	);
}

/** The width points written by the latest in-drag element update. */
function draggedWidths(ctx: MockToolContext): StrokeWidthPoint[] {
	const patch = ctx.updateElement.mock.calls.at(-1)![1] as Partial<Path>;
	return patch.strokeWidths as StrokeWidthPoint[];
}

function draggedWidthPoint(ctx: MockToolContext): StrokeWidthPoint {
	return draggedWidths(ctx)[0];
}

/** White-filled discs sitting on the path, one per width point. */
function getCenterCircles(ctx: MockToolContext): CirclePrimitive[] {
	const overlay = lastStrokeWidthOverlay(ctx);
	if (!overlay) return [];
	return overlay.primitives.filter(
		(p): p is CirclePrimitive =>
			p.kind === "circle" && p.fill?.color === UI_THEME.colors.white,
	);
}

/** Selection ring circles (one per selected handle). */
function getSelectionRings(ctx: MockToolContext): CirclePrimitive[] {
	const overlay = lastStrokeWidthOverlay(ctx);
	if (!overlay) return [];
	return overlay.primitives.filter(
		(p): p is CirclePrimitive =>
			p.kind === "circle" &&
			p.stroke?.color === UI_THEME.colors.strokeWidthSelectionRing,
	);
}

describe("StrokeWidthEditTool", () => {
	let tool: StrokeWidthEditTool;
	let ctx: MockToolContext;
	let path: Path;

	beforeEach(() => {
		ctx = createMockToolContext();
		tool = new StrokeWidthEditTool(ctx);
		path = createTestPath();
		ctx.getPathById.mockReturnValue(path);
	});

	describe("initWithSelectedPath", () => {
		it("should display UI handles for implicit t=0 and t=1 endpoints", () => {
			tool.initWithSelectedPath(
				path,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// 2 implicit points × 2 sides = 4 handle circles
			expect(getHandleCircles(ctx)).toHaveLength(4);
			// 2 cross lines (one per width point), rendered in the handle-line color
			const crossLines = lastStrokeWidthOverlay(ctx)?.primitives.filter(
				(p) =>
					p.kind === "line" &&
					p.stroke?.color === UI_THEME.colors.pathHandleLine,
			);
			expect(crossLines).toHaveLength(2);
		});
	});

	describe("onPointerDown", () => {
		it("should select a handle when clicking near it", () => {
			tool.initWithSelectedPath(
				path,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Get actual handle positions from the overlay primitives
			const firstSide1Handle = getHandleCircles(ctx).find(
				(p) => p.hitId === "-1:side1",
			);

			// Convert world coords to screen coords for clicking
			// screenToWorld inverse: screen = center + (world - viewport) * zoom (with Y flip)
			// world.x = viewport.x + (screenX - w/2) / zoom → screenX = (world.x - viewport.x) * zoom + w/2
			// world.y = viewport.y - (screenY - h/2) / zoom → screenY = -(world.y - viewport.y) * zoom + h/2
			const screenX =
				(firstSide1Handle!.cx - testViewport.x) * testViewport.zoom +
				testCanvasWidth / 2;
			const screenY =
				-(firstSide1Handle!.cy - testViewport.y) * testViewport.zoom +
				testCanvasHeight / 2;

			tool.onPointerDown(
				ev(screenX, screenY),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Selected handles render an extra selection ring
			expect(getSelectionRings(ctx).length).toBeGreaterThanOrEqual(1);
		});

		it("should deselect when clicking empty space", () => {
			tool.initWithSelectedPath(
				path,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Click far from any handle
			tool.onPointerDown(
				ev(400, 100),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// No selection ring is rendered
			expect(getSelectionRings(ctx)).toHaveLength(0);
		});
	});

	describe("onPointerMove (handle drag)", () => {
		// A t=0.5 point whose two sides differ, so symmetric moves are visible.
		// brushHalf = 10, so its side1 handle sits at world(0, 5) → screen(400,
		// 295) and its side2 handle at world(0, -8), far enough apart that a
		// click on side1 cannot land inside side2's 8px hit radius.
		beforeEach(() => {
			path = createTestPath([{ t: 0.5, side1: 0.5, side2: 0.8 }]);
			ctx.getPathById.mockReturnValue(path);
			ctx.updateElement.mockImplementation((_id, patch) => {
				path = { ...path, ...patch } as Path;
				ctx.getPathById.mockReturnValue(path);
			});

			tool.initWithSelectedPath(
				path,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerDown(
				ev(400, 295),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
		});

		it("should move both sides by the same delta on a plain drag", () => {
			// screen(400, 297) → world y = 3 → side1 = 0.3, i.e. -0.2
			tool.onPointerMove(
				ev(400, 297),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const point = draggedWidthPoint(ctx);
			expect(point.side1).toBeCloseTo(0.3);
			expect(point.side2).toBeCloseTo(0.6);
		});

		it("should move only the dragged side on an Alt+drag", () => {
			tool.onPointerMove(
				ev(400, 297, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const point = draggedWidthPoint(ctx);
			expect(point.side1).toBeCloseTo(0.3);
			expect(point.side2).toBeCloseTo(0.8);
		});

		it("should keep the gap between both sides when the drag hits the maximum", () => {
			// screen(400, 292) → world y = 8 → side1 asks for +0.3, but side2 only
			// has 0.2 of headroom left
			tool.onPointerMove(
				ev(400, 292),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const point = draggedWidthPoint(ctx);
			expect(point.side1).toBeCloseTo(0.7);
			expect(point.side2).toBeCloseTo(1);
		});

		it("should let the dragged side cross the centerline", () => {
			// screen(400, 301) → world y = -1 → side1 = -0.1, i.e. -0.6
			tool.onPointerMove(
				ev(400, 301),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const point = draggedWidthPoint(ctx);
			expect(point.side1).toBeCloseTo(-0.1);
			expect(point.side2).toBeCloseTo(0.2);
		});

		it("should pinch to zero total width rather than deleting the stroke", () => {
			// screen(400, 320) → world y = -20 → side1 asks for -2.5, but the two
			// sides meet at zero total width after -0.65
			tool.onPointerMove(
				ev(400, 320),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const point = draggedWidthPoint(ctx);
			expect(point.side1).toBeCloseTo(-0.15);
			expect(point.side2).toBeCloseTo(0.15);
			expect(point.side1 + point.side2).toBeCloseTo(0);
		});

		it("should cross the centerline with Alt+drag without moving the other side", () => {
			// world y = -6 → side1 = -0.6, still 0.2 of total width left
			tool.onPointerMove(
				ev(400, 306, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const point = draggedWidthPoint(ctx);
			expect(point.side1).toBeCloseTo(-0.6);
			expect(point.side2).toBeCloseTo(0.8);
		});

		it("should stop an Alt+drag where it meets the opposite side", () => {
			tool.onPointerMove(
				ev(400, 320, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const point = draggedWidthPoint(ctx);
			expect(point.side1).toBeCloseTo(-0.8);
			expect(point.side2).toBeCloseTo(0.8);
		});

		it("should not let a Shift+drag take both sides below zero", () => {
			tool.onPointerMove(
				ev(400, 306, { shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const point = draggedWidthPoint(ctx);
			expect(point.side1).toBeCloseTo(0);
			expect(point.side2).toBeCloseTo(0);
		});

		it("should not accumulate the delta across successive moves", () => {
			tool.onPointerMove(
				ev(400, 297),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// world y = 6 → the dragged side must land on 0.6, not on 0.3 + 0.1
			tool.onPointerMove(
				ev(400, 294),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const point = draggedWidthPoint(ctx);
			expect(point.side1).toBeCloseTo(0.6);
			expect(point.side2).toBeCloseTo(0.9);
		});
	});

	describe("onPointerMove (point drag along the path)", () => {
		// The t=0.5 point sits at world(0, 0) → screen(400, 300), where its white
		// centre disc takes the drag.
		beforeEach(() => {
			path = createTestPath([{ t: 0.5, side1: 0.5, side2: 0.8 }]);
			ctx.getPathById.mockReturnValue(path);
			ctx.updateElement.mockImplementation((_id, patch) => {
				path = { ...path, ...patch } as Path;
				ctx.getPathById.mockReturnValue(path);
			});

			tool.initWithSelectedPath(
				path,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
		});

		it("should move the point along the path without changing its widths", () => {
			tool.onPointerMove(
				ev(450, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const point = draggedWidthPoint(ctx);
			expect(point.t).toBeGreaterThan(0.5);
			expect(point.t).toBeLessThan(1);
			expect(point.side1).toBe(0.5);
			expect(point.side2).toBe(0.8);
		});

		it("should draw one white disc per width point, pickable only in between", () => {
			// Implicit t=0 and t=1 plus the explicit t=0.5 point
			const centers = getCenterCircles(ctx);
			expect(centers).toHaveLength(3);
			expect(
				centers.filter((c) => c.hitId != null).map((c) => c.hitId),
			).toEqual(["0:center"]);
		});
	});

	describe("onPointerMove (point drag past a neighbour)", () => {
		it("should stop the point just short of the preceding one", () => {
			path = createTestPath([
				{ t: 0.3, side1: 1, side2: 1 },
				{ t: 0.5, side1: 0.5, side2: 0.8 },
			]);
			ctx.getPathById.mockReturnValue(path);
			ctx.updateElement.mockImplementation((_id, patch) => {
				path = { ...path, ...patch } as Path;
				ctx.getPathById.mockReturnValue(path);
			});

			tool.initWithSelectedPath(
				path,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Drag onto the start of the path, well past the t=0.3 point
			tool.onPointerMove(
				ev(300, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(draggedWidths(ctx)[1].t).toBeCloseTo(0.305, 3);
		});
	});

	describe("onDoubleClick", () => {
		it("should add a new StrokeWidthPoint at the closest t", () => {
			ctx.getCurrentLayer.mockReturnValue({ id: "layer-1" } as any);

			tool.initWithSelectedPath(
				path,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Double-click near the center of the path (world 0,0 = screen 400,300)
			tool.onDoubleClick!(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.transact).toHaveBeenCalled();
			expect(ctx.mockCommands.updateElement).toHaveBeenCalled();

			const widths = (
				ctx.mockCommands.updateElement.mock.calls.at(-1)![2] as Partial<Path>
			).strokeWidths as StrokeWidthPoint[];

			expect(widths.length).toBeGreaterThanOrEqual(1);
			// The new point should be near t=0.5
			const midPoint = widths.find((w) => Math.abs(w.t - 0.5) < 0.15);
			expect(midPoint).toBeDefined();
		});
	});

	describe("onKeyDown (Delete)", () => {
		it("should delete an explicit selected point", () => {
			ctx.getCurrentLayer.mockReturnValue({ id: "layer-1" } as any);

			const pathWithWidths = createTestPath([
				{ t: 0.5, side1: 0.5, side2: 0.5 },
			]);
			ctx.getPathById.mockReturnValue(pathWithWidths);

			tool.initWithSelectedPath(
				pathWithWidths,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// The effective array: implicit t=0 (index 0), explicit t=0.5 (index 1), implicit t=1 (index 2)
			// We need to hit the side1 handle of the t=0.5 point
			// At t=0.5, the path position is (0, 0) in world = screen(400, 300)
			// side1 handle at (0, 5) in world (brushHalf=10, side1=0.5) = screen(400, 295)
			tool.onPointerDown(
				ev(400, 295),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const handled = tool.onKeyDown!(
				new KeyboardEvent("keydown", { key: "Delete" }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(handled).toBe(true);
			expect(ctx.transact).toHaveBeenCalled();
			expect(ctx.mockCommands.updateElement).toHaveBeenCalled();

			const widths = (
				ctx.mockCommands.updateElement.mock.calls.at(-1)![2] as Partial<Path>
			).strokeWidths as StrokeWidthPoint[];

			expect(widths).toHaveLength(0);
		});

		it("should not delete implicit endpoint handles", () => {
			tool.initWithSelectedPath(
				path,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Select the implicit t=0 side1 handle
			// world(-100, 10) → screen(300, 290)
			tool.onPointerDown(
				ev(300, 290),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const handled = tool.onKeyDown!(
				new KeyboardEvent("keydown", { key: "Delete" }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(handled).toBe(false);
		});
	});

	describe("actual rendered width (pressure / taper)", () => {
		function pressureHalvedSettings(pressureCurveDepth: number) {
			return {
				version: 2,
				engine: "geometric",
				strokeOpacity: 1,
				paintMode: "buildup",
				properties: {
					size: {
						base: 40,
						curves: [
							{
								input: "pressure",
								points: [
									[0, -pressureCurveDepth],
									[1, 0],
								],
							},
						],
					},
				},
				randomSeed: 0,
			};
		}

		function initTool(p: Path): void {
			ctx.getPathById.mockReturnValue(p);
			ctx.updateElement.mockImplementation((_id, patch) => {
				p = { ...p, ...patch } as Path;
				ctx.getPathById.mockReturnValue(p);
			});
			tool.initWithSelectedPath(
				p,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
		}

		function handleY(ctx: MockToolContext, hitId: string): number {
			return getHandleCircles(ctx).find((p) => p.hitId === hitId)!.cy;
		}

		it("should place handles at the pressure-evaluated width, not the base width", () => {
			// base 40 (brushHalf 20), pressure 0 with a half-depth curve → half 10
			initTool(
				createBrushTestPath({
					brushSettings: pressureHalvedSettings(0.5),
					startPressure: 0,
					endPressure: 0,
				}),
			);

			expect(handleY(ctx, "-1:side1")).toBeCloseTo(10, 4);
			expect(handleY(ctx, "-2:side1")).toBeCloseTo(10, 4);
		});

		it("should collapse the handle to the centerline at a taper tip", () => {
			initTool(
				createBrushTestPath({
					brushSettings: {
						version: 2,
						engine: "geometric",
						strokeOpacity: 1,
						paintMode: "buildup",
						properties: { size: { base: 40 } },
						randomSeed: 0,
						taperStart: 100,
					},
				}),
			);

			expect(handleY(ctx, "-1:side1")).toBeCloseTo(0, 4);
			expect(handleY(ctx, "-2:side1")).toBeCloseTo(20, 4);
		});

		it("should follow the dab evaluator's sizes on a dab brush", () => {
			initTool(
				createBrushTestPath({
					brushSettings: {
						version: 2,
						engine: "dab",
						strokeOpacity: 1,
						paintMode: "buildup",
						properties: {
							size: {
								base: 10,
								curves: [
									{
										input: "pressure",
										points: [
											[0, -1],
											[1, 0],
										],
									},
								],
							},
							ratio: { base: 1 },
							flow: { base: 1 },
							spacing: { base: 0.05 },
						},
						randomSeed: 0,
						tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
					},
					startPressure: 1,
					endPressure: 0,
				}),
			);

			// Full pressure at the start (half ≈ 5), none at the end (half ≈ 0).
			expect(handleY(ctx, "-1:side1")).toBeGreaterThan(3);
			expect(handleY(ctx, "-2:side1")).toBeLessThan(1.5);
		});

		it("should convert a drag by the actual width at the point", () => {
			// half 10 → the side1 handle of {side1: 0.5} sits at world y = 5
			initTool(
				createBrushTestPath({
					brushSettings: pressureHalvedSettings(0.5),
					startPressure: 0,
					endPressure: 0,
					strokeWidths: [{ t: 0.5, side1: 0.5, side2: 0.8 }],
				}),
			);
			tool.onPointerDown(
				ev(400, 295),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// screen(400, 293) → world y = 7 → side1 asks for 7/10 = 0.7; the +0.2
			// delta is what side2's headroom allows. Dividing by the base half (20)
			// instead would ask for 0.35 and shrink the point.
			tool.onPointerMove(
				ev(400, 293),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const point = draggedWidthPoint(ctx);
			expect(point.side1).toBeCloseTo(0.7);
			expect(point.side2).toBeCloseTo(1);
		});

		it("should write finite widths when dragging at a zero-width point", () => {
			// Full-depth curve at pressure 0 → actual width 0 everywhere.
			initTool(
				createBrushTestPath({
					brushSettings: pressureHalvedSettings(1),
					startPressure: 0,
					endPressure: 0,
					strokeWidths: [{ t: 0.5, side1: 0.5, side2: 0.8 }],
				}),
			);
			// All three t=0.5 handles collapse onto world(0, 0); clicking just off
			// the centre stays outside the centre disc and grabs a side handle.
			tool.onPointerDown(
				ev(400, 294.5),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Pointer on the centerline: projected = 0 over a 0 half width would be
			// 0/0 = NaN without the ratio-denominator floor.
			tool.onPointerMove(
				ev(410, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const point = draggedWidthPoint(ctx);
			expect(Number.isFinite(point.side1)).toBe(true);
			expect(Number.isFinite(point.side2)).toBe(true);
		});
	});

	describe("onCancel", () => {
		it("should clear UI state", () => {
			tool.initWithSelectedPath(
				path,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			ctx.uiSetOverlay.mockClear();

			tool.onCancel();

			expect(ctx.uiSetOverlay.mock.calls.at(-1)).toEqual([
				"stroke-width/handles",
				null,
			]);
		});
	});

	describe("getCursor", () => {
		it("should return 'default' when not dragging", () => {
			expect(tool.getCursor()).toBe("default");
		});
	});
});
