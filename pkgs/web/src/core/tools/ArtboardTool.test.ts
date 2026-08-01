import { beforeEach, describe, expect, it } from "vitest";
import { OVERLAY_Z } from "../renderer/ui/theme";
import type { Artboard } from "../schema";
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
import { brandWorldBBox } from "../utils/geometry/bounds";
import { ArtboardTool } from "./ArtboardTool";

// Default viewport (0,0,zoom=1), canvas 800×600:
//   screen(400,300) → world(0,0)
//   screen(500,200) → world(100,100)
//   screen(300,400) → world(-100,-100)

const testArtboard: Artboard = {
	id: "ab-1",
	name: "Artboard 1",
	x: 0,
	y: 0,
	width: 200,
	height: 150,
	// bounds: minX=-100, minY=-75, maxX=100, maxY=75
};

describe("ArtboardTool", () => {
	let tool: ArtboardTool;
	let ctx: MockToolContext;

	beforeEach(() => {
		ctx = createMockToolContext();
		tool = new ArtboardTool(ctx);
	});

	it("should have name 'artboard'", () => {
		expect(tool.name).toBe("artboard");
	});

	describe("Artboard creation", () => {
		it("should create artboard from drag on empty area", () => {
			// screen(200,200) → world(-200,100)
			// screen(400,100) → world(0,200)
			tool.onPointerDown(
				ev(200, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(400, 100),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.artboardCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					x: -100,
					y: 150,
					width: 200,
					height: 100,
				}),
			);

			// Should auto-select after creation
			const created = ctx.artboardCreate.mock.calls[0][0];
			expect(ctx.artboardSelect).toHaveBeenCalledWith(created.id);
		});

		it("should deselect existing artboard when clicking empty area", () => {
			tool.onPointerDown(
				ev(100, 100),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			expect(ctx.artboardSelect).toHaveBeenCalledWith(null);
		});

		it("should NOT create artboard when drag is too small", () => {
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(405, 297),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			expect(ctx.artboardCreate).not.toHaveBeenCalled();
		});

		it("should constrain to square when shift is pressed", () => {
			tool.onPointerDown(
				ev(300, 300, { shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 250, { shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const artboard = ctx.artboardCreate.mock.calls[0][0];
			expect(artboard.width).toBe(artboard.height);
		});

		it("should show preview bounds during drag", () => {
			tool.onPointerDown(
				ev(200, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(400, 100),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.uiUpdateSelectionUI).toHaveBeenCalledWith(
				expect.objectContaining({
					bounds: expect.objectContaining({ width: 200, height: 100 }),
				}),
			);
		});

		it("should snap cursor position when starting artboard creation", () => {
			ctx.snapArtboardToElements.mockImplementation((bounds) => {
				if (bounds.width === 0 && bounds.height === 0) {
					return { deltaX: 20, deltaY: -10, snapLines: [] };
				}
				return { deltaX: 0, deltaY: 0, snapLines: [] };
			});

			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.artboardCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					x: 60,
					y: 45,
					width: 80,
					height: 110,
				}),
			);
		});
	});

	describe("Artboard selection", () => {
		it("should select artboard on click and show 8 handles", () => {
			ctx.findArtboardAtPoint.mockReturnValue(testArtboard);
			ctx.getArtboards.mockReturnValue([testArtboard]);

			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.artboardSelect).toHaveBeenCalledWith("ab-1");
			expect(ctx.uiUpdateSelectionUI).toHaveBeenCalledWith(
				expect.objectContaining({
					handles: expect.arrayContaining([
						expect.objectContaining({ position: "nw" }),
						expect.objectContaining({ position: "se" }),
					]),
				}),
			);
			const ui = ctx.uiUpdateSelectionUI.mock.calls[0][0]!;
			expect(ui.handles).toHaveLength(8);
		});
	});

	describe("Artboard move", () => {
		beforeEach(() => {
			ctx.findArtboardAtPoint.mockReturnValue(testArtboard);
			ctx.getArtboards.mockReturnValue([testArtboard]);
			ctx.getSelectedArtboardId.mockReturnValue("ab-1");
		});

		it("should NOT call artboardUpdate during drag (deferred commit)", () => {
			ctx.snapArtboard.mockImplementation((_id, _bounds, dx, dy) => ({
				deltaX: dx,
				deltaY: dy,
				snapLines: [],
			}));

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

			// During drag, only selection UI should be updated, not the artboard itself
			expect(ctx.artboardUpdate).not.toHaveBeenCalled();
			expect(ctx.uiUpdateSelectionUI).toHaveBeenCalled();
		});

		it("should commit artboard move on pointer up", () => {
			ctx.snapArtboard.mockImplementation((_id, _bounds, dx, dy) => ({
				deltaX: dx,
				deltaY: dy,
				snapLines: [],
			}));

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
			tool.onPointerUp(
				ev(450, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.artboardMoveCommit).toHaveBeenCalledWith(
				"ab-1",
				{ x: 50, y: 0 },
				expect.any(Array),
				50,
				0,
			);
		});

		it("should apply snap adjustment on commit", () => {
			ctx.snapArtboard.mockReturnValue({
				deltaX: 55,
				deltaY: 0,
				snapLines: [
					{ axis: "vertical", position: 155, extentMin: -75, extentMax: 75 },
				],
			});

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
			tool.onPointerUp(
				ev(450, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.artboardMoveCommit).toHaveBeenCalledWith(
				"ab-1",
				{ x: 55, y: 0 },
				expect.any(Array),
				55,
				0,
			);
		});

		it("should commit elements together with artboard on pointer up", () => {
			const elements = [{ layerId: "l1", elementId: "e1" }];
			ctx.findElementsOnArtboard.mockReturnValue(elements);
			ctx.snapArtboard.mockReturnValue({
				deltaX: 30,
				deltaY: 20,
				snapLines: [],
			});

			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(430, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(430, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.artboardMoveCommit).toHaveBeenCalledWith(
				"ab-1",
				{ x: 30, y: 20 },
				elements,
				30,
				20,
			);
		});

		it("should not commit if drag delta is negligible", () => {
			ctx.snapArtboard.mockReturnValue({
				deltaX: 0,
				deltaY: 0,
				snapLines: [],
			});

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

			expect(ctx.artboardMoveCommit).not.toHaveBeenCalled();
		});
	});

	describe("Artboard resize", () => {
		beforeEach(() => {
			ctx.getSelectedArtboardId.mockReturnValue("ab-1");
			ctx.getArtboards.mockReturnValue([testArtboard]);
			ctx.findArtboardAtPoint.mockReturnValue(null);
		});

		it("should resize artboard by dragging a corner handle", () => {
			// SE handle: world(100, -75) → screen(500, 375)
			// Drag to screen(550, 425) → world(150, -125)
			// SE drag: maxX 100→150, minY -75→-125
			// New bounds: minX=-100, minY=-125, maxX=150, maxY=75
			// New center: x=25, y=-25, width=250, height=200
			tool.onPointerDown(
				ev(500, 375),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(550, 425),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.artboardUpdate).toHaveBeenCalledWith("ab-1", {
				x: 25,
				y: -25,
				width: 250,
				height: 200,
			});
		});

		it("should enforce minimum size of 10", () => {
			// SE handle: screen(500, 375)
			tool.onPointerDown(
				ev(500, 375),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(310, 220),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const lastUI =
				ctx.uiUpdateSelectionUI.mock.calls[
					ctx.uiUpdateSelectionUI.mock.calls.length - 1
				][0]!;
			expect(lastUI.bounds.width).toBeGreaterThanOrEqual(10);
			expect(lastUI.bounds.height).toBeGreaterThanOrEqual(10);
		});

		it("should maintain aspect ratio when shift is pressed", () => {
			// E handle: screen(500, 300)
			tool.onPointerDown(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(600, 300, { shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const lastUI =
				ctx.uiUpdateSelectionUI.mock.calls[
					ctx.uiUpdateSelectionUI.mock.calls.length - 1
				][0]!;
			const originalAspect = testArtboard.width / testArtboard.height;
			const newAspect = lastUI.bounds.width / lastUI.bounds.height;
			expect(newAspect).toBeCloseTo(originalAspect, 1);
		});
	});

	describe("Snap to elements (create mode)", () => {
		it("should call snapArtboardToElements during create drag", () => {
			ctx.snapArtboardToElements.mockReturnValue({
				deltaX: 0,
				deltaY: 0,
				snapLines: [],
			});

			tool.onPointerDown(
				ev(200, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(400, 100),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const calls = ctx.snapArtboardToElements.mock.calls;
			expect(
				calls.some(
					([bounds, zoom]) =>
						zoom === testViewport.zoom &&
						bounds.width === 0 &&
						bounds.height === 100,
				),
			).toBe(true);
			expect(
				calls.some(
					([bounds, zoom]) =>
						zoom === testViewport.zoom &&
						bounds.width === 200 &&
						bounds.height === 0,
				),
			).toBe(true);
		});

		it("should apply snap correction to preview bounds in create mode", () => {
			ctx.snapArtboardToElements.mockImplementation((bounds) => {
				if (bounds.width === 0 && bounds.height === 0) {
					return { deltaX: 0, deltaY: 0, snapLines: [] };
				}
				return { deltaX: 5, deltaY: -3, snapLines: [] };
			});

			tool.onPointerDown(
				ev(200, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(400, 100),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const ui = ctx.uiUpdateSelectionUI.mock.calls.at(-1)![0]!;
			expect(ui.bounds.minX).toBeCloseTo(-200);
			expect(ui.bounds.maxX).toBeCloseTo(5);
			expect(ui.bounds.minY).toBeCloseTo(100);
			expect(ui.bounds.maxY).toBeCloseTo(197);
		});

		it("should apply snap correction on pointer up in create mode", () => {
			ctx.snapArtboardToElements.mockImplementation((bounds) => {
				if (bounds.width === 0 && bounds.height === 0) {
					return { deltaX: 0, deltaY: 0, snapLines: [] };
				}
				if (bounds.width === 0) {
					return { deltaX: 5, deltaY: 0, snapLines: [] };
				}
				if (bounds.height === 0) {
					return { deltaX: 0, deltaY: -3, snapLines: [] };
				}
				return { deltaX: 0, deltaY: 0, snapLines: [] };
			});

			tool.onPointerDown(
				ev(200, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(400, 100),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const created = ctx.artboardCreate.mock.calls[0][0];
			expect(created.x).toBeCloseTo(-97.5);
			expect(created.y).toBeCloseTo(148.5);
			expect(created.width).toBeCloseTo(205);
			expect(created.height).toBeCloseTo(97);
		});

		it("should show snap lines UI in create mode when snapping", () => {
			const snapLine = {
				axis: "vertical" as const,
				position: -195,
				extentMin: 97,
				extentMax: 200,
			};
			ctx.snapArtboardToElements.mockImplementation((bounds) => {
				if (bounds.width === 0 && bounds.height === 0) {
					return { deltaX: 0, deltaY: 0, snapLines: [] };
				}
				if (bounds.width === 0) {
					return { deltaX: 5, deltaY: 0, snapLines: [snapLine] };
				}
				return { deltaX: 0, deltaY: 0, snapLines: [] };
			});

			tool.onPointerDown(
				ev(200, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(400, 100),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const lastCall = ctx.uiSetOverlay.mock.calls.at(-1);
			expect(lastCall?.[0]).toBe("artboard/snap-lines");
			expect(lastCall?.[1]?.zIndex).toBe(OVERLAY_Z.snapLine);
			expect(lastCall?.[1]?.primitives).toMatchObject([
				{ kind: "line", x1: -195, y1: 97, x2: -195, y2: 200 },
			]);
		});

		it("should snap opposite sides when dragging in negative direction", () => {
			ctx.snapArtboardToElements.mockImplementation((bounds) => {
				if (bounds.width === 0 && bounds.height === 0) {
					return { deltaX: 0, deltaY: 0, snapLines: [] };
				}
				if (bounds.width === 0) {
					return { deltaX: 7, deltaY: 0, snapLines: [] };
				}
				if (bounds.height === 0) {
					return { deltaX: 0, deltaY: -4, snapLines: [] };
				}
				return { deltaX: 0, deltaY: 0, snapLines: [] };
			});

			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(200, 400),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const ui = ctx.uiUpdateSelectionUI.mock.calls.at(-1)![0]!;
			expect(ui.bounds.minX).toBeCloseTo(-193);
			expect(ui.bounds.minY).toBeCloseTo(-104);
			expect(ui.bounds.maxX).toBeCloseTo(0);
			expect(ui.bounds.maxY).toBeCloseTo(0);
		});

		it("should clear snap lines when no snapping in create mode", () => {
			ctx.snapArtboardToElements.mockReturnValue({
				deltaX: 0,
				deltaY: 0,
				snapLines: [],
			});

			tool.onPointerDown(
				ev(200, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(400, 100),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.uiSetOverlay.mock.calls.at(-1)).toEqual([
				"artboard/snap-lines",
				null,
			]);
		});

		it("should clear snap lines after finishing create with snapping", () => {
			const snapLine = {
				axis: "vertical" as const,
				position: -195,
				extentMin: 97,
				extentMax: 200,
			};
			ctx.snapArtboardToElements.mockImplementation((bounds) => {
				if (bounds.width === 0 && bounds.height === 0) {
					return { deltaX: 0, deltaY: 0, snapLines: [] };
				}
				if (bounds.width === 0) {
					return { deltaX: 5, deltaY: 0, snapLines: [snapLine] };
				}
				return { deltaX: 0, deltaY: 0, snapLines: [] };
			});

			tool.onPointerDown(
				ev(200, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(400, 100),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.uiSetOverlay.mock.calls.at(-1)).toEqual([
				"artboard/snap-lines",
				null,
			]);
		});
	});

	describe("Snap on hover (before drag)", () => {
		it("should show snap lines while hovering before the drag starts", () => {
			const snapLine = {
				axis: "vertical" as const,
				position: 20,
				extentMin: -10,
				extentMax: 50,
			};
			ctx.snapArtboardToElements.mockReturnValue({
				deltaX: 20,
				deltaY: 0,
				snapLines: [snapLine],
			});

			// Hover only: onPointerMove without a preceding onPointerDown
			tool.onPointerMove(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const lastCall = ctx.uiSetOverlay.mock.calls.at(-1);
			expect(lastCall?.[0]).toBe("artboard/snap-lines");
			expect(lastCall?.[1]?.zIndex).toBe(OVERLAY_Z.snapLine);
			expect(lastCall?.[1]?.primitives).toMatchObject([
				{ kind: "line", x1: 20, y1: -10, x2: 20, y2: 50 },
			]);
		});

		it("should snap the hover point as a zero-size point", () => {
			tool.onPointerMove(
				ev(500, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const calls = ctx.snapArtboardToElements.mock.calls;
			expect(
				calls.some(
					([bounds, zoom]) =>
						zoom === testViewport.zoom &&
						bounds.width === 0 &&
						bounds.height === 0,
				),
			).toBe(true);
		});

		it("should not preview create-snap while hovering over an existing artboard", () => {
			ctx.findArtboardAtPoint.mockReturnValue(testArtboard);
			ctx.snapArtboardToElements.mockReturnValue({
				deltaX: 20,
				deltaY: 0,
				snapLines: [
					{ axis: "vertical", position: 20, extentMin: 0, extentMax: 10 },
				],
			});

			tool.onPointerMove(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.snapArtboardToElements).not.toHaveBeenCalled();
			expect(ctx.uiSetOverlay.mock.calls.at(-1)).toEqual([
				"artboard/snap-lines",
				null,
			]);
		});
	});

	describe("Snap to elements (resize mode)", () => {
		beforeEach(() => {
			ctx.getSelectedArtboardId.mockReturnValue("ab-1");
			ctx.getArtboards.mockReturnValue([testArtboard]);
			ctx.findArtboardAtPoint.mockReturnValue(null);
		});

		it("should call snapArtboardToElements during resize drag", () => {
			ctx.snapArtboardToElements.mockReturnValue({
				deltaX: 0,
				deltaY: 0,
				snapLines: [],
			});

			// SE handle: screen(500, 375) → world(100, -75)
			tool.onPointerDown(
				ev(500, 375),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(550, 425),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.snapArtboardToElements).toHaveBeenCalledWith(
				expect.objectContaining({ width: expect.any(Number) }),
				testViewport.zoom,
			);
		});

		it("should apply snap correction to artboardUpdate on resize pointer up", () => {
			ctx.snapArtboardToElements.mockReturnValue({
				deltaX: 10,
				deltaY: 0,
				snapLines: [],
			});

			// SE handle: screen(500, 375) → world(100, -75)
			// Drag to screen(550, 425) → world(150, -125)
			// Raw new bounds: minX=-100, minY=-125, maxX=150, maxY=75
			// With snap delta (10, 0): minX=-90, maxX=160
			// center: x=35, width=250
			tool.onPointerDown(
				ev(500, 375),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(550, 425),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const call = ctx.artboardUpdate.mock.calls[0];
			expect(call[0]).toBe("ab-1");
			expect(call[1].x).toBeCloseTo(30);
			expect(call[1].width).toBeCloseTo(260);
		});

		it("should apply snap correction on all edges when resizing from NW handle", () => {
			ctx.snapArtboardToElements.mockImplementation((bounds) => {
				if (bounds.width === 0) {
					return { deltaX: -8, deltaY: 0, snapLines: [] };
				}
				if (bounds.height === 0) {
					return { deltaX: 0, deltaY: 6, snapLines: [] };
				}
				return { deltaX: 0, deltaY: 0, snapLines: [] };
			});

			// NW handle: screen(300, 225) -> world(-100, 75)
			tool.onPointerDown(
				ev(300, 225),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Drag to screen(250,175) -> world(-150,125)
			tool.onPointerUp(
				ev(250, 175),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const call = ctx.artboardUpdate.mock.calls[0];
			expect(call[0]).toBe("ab-1");
			expect(call[1].x).toBeCloseTo(-29);
			expect(call[1].y).toBeCloseTo(28);
			expect(call[1].width).toBeCloseTo(258);
			expect(call[1].height).toBeCloseTo(206);
		});

		it("should keep the opposite edge fixed when snapping a resize handle", () => {
			ctx.snapArtboardToElements.mockImplementation((bounds) => {
				if (bounds.width === 0) {
					return { deltaX: 10, deltaY: 0, snapLines: [] };
				}
				return { deltaX: 0, deltaY: 0, snapLines: [] };
			});

			tool.onPointerDown(
				ev(500, 375),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(550, 425),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const ui = ctx.uiUpdateSelectionUI.mock.calls.at(-1)![0]!;
			expect(ui.bounds.minX).toBeCloseTo(-100);
			expect(ui.bounds.maxX).toBeCloseTo(160);
		});

		it("should clear snap lines after finishing resize with snapping", () => {
			const snapLine = {
				axis: "vertical" as const,
				position: 160,
				extentMin: -125,
				extentMax: 75,
			};
			ctx.snapArtboardToElements.mockImplementation((bounds) => {
				if (bounds.width === 0) {
					return { deltaX: 10, deltaY: 0, snapLines: [snapLine] };
				}
				return { deltaX: 0, deltaY: 0, snapLines: [] };
			});

			tool.onPointerDown(
				ev(500, 375),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(550, 425),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.uiSetOverlay.mock.calls.at(-1)).toEqual([
				"artboard/snap-lines",
				null,
			]);
		});
	});

	describe("Double-click: create artboard from element bounds", () => {
		it("should create artboard fitted to element when no artboard at point", () => {
			const mockElement = { id: "elem-1", type: "path" } as never;
			const mockBounds = brandWorldBBox({
				minX: -50,
				minY: -30,
				maxX: 150,
				maxY: 70,
				width: 200,
				height: 100,
			});
			ctx.findArtboardAtPoint.mockReturnValue(null);
			ctx.findElementAtPoint.mockReturnValue(mockElement);
			ctx.getBounds.mockReturnValue(mockBounds);
			ctx.getArtboards.mockReturnValue([]);

			tool.onDoubleClick(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.artboardCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					x: 50, // (−50 + 150) / 2
					y: 20, // (−30 + 70) / 2
					width: 200,
					height: 100,
				}),
			);
			const created = ctx.artboardCreate.mock.calls[0][0];
			expect(ctx.artboardSelect).toHaveBeenCalledWith(created.id);
		});

		it("should do nothing when no element at point", () => {
			ctx.findArtboardAtPoint.mockReturnValue(null);
			ctx.findElementAtPoint.mockReturnValue(null);

			tool.onDoubleClick(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.artboardCreate).not.toHaveBeenCalled();
			expect(ctx.artboardUpdate).not.toHaveBeenCalled();
		});
	});

	describe("Double-click: fit artboard to element", () => {
		it("should resize artboard to fit element when double-clicking element inside artboard", () => {
			const mockElement = { id: "elem-1", type: "path" } as never;
			const mockBounds = brandWorldBBox({
				minX: -50,
				minY: -30,
				maxX: 150,
				maxY: 70,
				width: 200,
				height: 100,
			});
			ctx.findArtboardAtPoint.mockReturnValue(testArtboard);
			ctx.findElementAtPoint.mockReturnValue(mockElement);
			ctx.getBounds.mockReturnValue(mockBounds);
			ctx.getArtboards.mockReturnValue([testArtboard]);

			tool.onDoubleClick(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.artboardUpdate).toHaveBeenCalledWith("ab-1", {
				x: 50, // (−50 + 150) / 2
				y: 20, // (−30 + 70) / 2
				width: 200,
				height: 100,
			});
			expect(ctx.artboardCreate).not.toHaveBeenCalled();
		});

		it("should not update artboard when element has no computable bounds", () => {
			const mockElement = { id: "elem-1", type: "path" } as never;
			ctx.findArtboardAtPoint.mockReturnValue(testArtboard);
			ctx.findElementAtPoint.mockReturnValue(mockElement);
			ctx.getBounds.mockReturnValue(null);

			tool.onDoubleClick(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.artboardUpdate).not.toHaveBeenCalled();
		});
	});

	describe("Cancel", () => {
		it("should reset drag state and clear UI", () => {
			ctx.findArtboardAtPoint.mockReturnValue(testArtboard);
			ctx.getArtboards.mockReturnValue([testArtboard]);

			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onCancel();

			expect(tool.getCursor()).toBe("crosshair");
			expect(ctx.uiUpdateSelectionUI).toHaveBeenCalledWith(null);
			expect(ctx.uiSetOverlay.mock.calls.at(-1)).toEqual([
				"artboard/snap-lines",
				null,
			]);
		});
	});
});
