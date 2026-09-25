import { describe, expect, it, vi } from "vitest";
import { type AnyArtObject, IDENTITY_TRANSFORM, type Vec2 } from "../schema";
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
import type { WorldBBox } from "../utils/geometry/bounds";
import { FreeTransformTool } from "./FreeTransformTool";

const ELEMENT_ID = "el-1";

// A 100×100 element centred on the world origin. Corner handles (world→screen,
// zoom 1, Y-flip, centre screen 400,300): TL(-50,50)→(350,250),
// TR(50,50)→(450,250), BR(50,-50)→(450,350), BL(-50,-50)→(350,350).
const BOUNDS: WorldBBox = {
	minX: -50,
	minY: -50,
	maxX: 50,
	maxY: 50,
	width: 100,
	height: 100,
} as WorldBBox;

describe("FreeTransformTool", () => {
	it("should preview a warp from the AABB quad when dragging a corner", () => {
		const ctx = makeContext();
		const tool = new FreeTransformTool(ctx);

		// Grab the TR corner (screen 450,250 → world 50,50) and pull it out.
		tool.onPointerDown(
			ev(450, 250),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(480, 230),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(ctx.previewDeformation).toHaveBeenCalled();
		const [ids, corners, sourceCorners] = lastWarpComputeArgs(ctx);
		expect(ids).toEqual([ELEMENT_ID]);
		// TR is index 1 (TL, TR, BR, BL). world of screen(480,230) = (80, 70).
		expect(corners[1][0]).toBeCloseTo(80, 5);
		expect(corners[1][1]).toBeCloseTo(70, 5);
		// Untouched corners and the whole source quad keep the AABB rectangle.
		expect(corners[0]).toEqual([-50, 50]);
		expect(sourceCorners).toEqual([
			[-50, 50],
			[50, 50],
			[50, -50],
			[-50, -50],
		]);
	});

	it("should bake via applyDeformation on pointer up", () => {
		const ctx = makeContext();
		const tool = new FreeTransformTool(ctx);

		tool.onPointerDown(
			ev(450, 250),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(480, 230),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp();

		expect(ctx.applyDeformation).toHaveBeenCalled();
		const [, corners] = lastWarpComputeArgs(ctx);
		expect(corners[1][0]).toBeCloseTo(80, 5);
	});

	it("should restore a warped image's corner vertices for re-editing", () => {
		const storedCorners: [Vec2, Vec2, Vec2, Vec2] = [
			[-40, 60],
			[55, 45],
			[50, -50],
			[-50, -50],
		];
		const ctx = makeContext({
			getElement: vi.fn(
				() =>
					({
						id: ELEMENT_ID,
						type: "image",
						x: 0,
						y: 0,
						width: 100,
						height: 100,
						corners: storedCorners,
						transform: IDENTITY_TRANSFORM,
					}) as unknown as AnyArtObject,
			),
		});
		const tool = new FreeTransformTool(ctx);

		// The TL handle sits at the stored corner (-40,60) → screen(360,240).
		tool.onPointerDown(
			ev(360, 240),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(355, 235),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const [, corners, sourceCorners] = lastWarpComputeArgs(ctx);
		// The drag maps from the restored quad, not the AABB.
		expect(sourceCorners).toEqual(storedCorners);
		expect(corners[0][0]).toBeCloseTo(-45, 5);
		expect(corners[0][1]).toBeCloseTo(65, 5);
	});

	it("should restore a moved image's corners at their world position", () => {
		// Corners are stored in the rect's local space; the image was moved with
		// the SelectTool, so its move delta lives on transform.x/y.
		const storedCorners: [Vec2, Vec2, Vec2, Vec2] = [
			[-40, 60],
			[55, 45],
			[50, -50],
			[-50, -50],
		];
		const ctx = makeContext({
			getElement: vi.fn(
				() =>
					({
						id: ELEMENT_ID,
						type: "image",
						x: 0,
						y: 0,
						width: 100,
						height: 100,
						corners: storedCorners,
						transform: { ...IDENTITY_TRANSFORM, x: 100, y: 20 },
					}) as unknown as AnyArtObject,
			),
		});
		const tool = new FreeTransformTool(ctx);

		// World TL = local(-40,60) + move delta(100,20) = (60,80) → screen(460,220).
		tool.onPointerDown(
			ev(460, 220),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(465, 215),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const [, corners, sourceCorners] = lastWarpComputeArgs(ctx);
		// The gizmo (and the warp's source quad) sits at the world position.
		expect(sourceCorners[0]).toEqual([60, 80]);
		expect(sourceCorners[2]).toEqual([150, -30]);
		expect(corners[0][0]).toBeCloseTo(65, 5);
		expect(corners[0][1]).toBeCloseTo(85, 5);
	});

	it("should outline text before baking when the selection contains text", async () => {
		const ctx = makeContext({
			getElement: vi.fn(
				() => ({ id: ELEMENT_ID, type: "text" }) as unknown as AnyArtObject,
			),
			outlineTextElements: vi.fn(async () => ["group-1"]),
		});
		const tool = new FreeTransformTool(ctx);

		tool.onPointerDown(
			ev(450, 250),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(480, 230),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp();
		// The outline → bake flow is async; let the promise chain settle.
		await vi.waitFor(() => {
			expect(ctx.applyDeformation).toHaveBeenCalled();
		});

		expect(ctx.outlineTextElements).toHaveBeenCalled();
		expect(ctx.outlineTextElements.mock.calls.at(-1)?.[0]).toEqual([
			ELEMENT_ID,
		]);
		// The bake targets the outlined group instead of the text element.
		const [ids] = lastWarpComputeArgs(ctx);
		expect(ids).toEqual(["group-1"]);
	});

	it("should toggle corner selection with Shift+click on a handle without warping", () => {
		const ctx = makeContext();
		const tool = new FreeTransformTool(ctx);

		// Shift+click the TR handle: selects the handle, no drag, no element toggle.
		tool.onPointerDown(
			ev(450, 250, { shiftKey: true }),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(480, 230),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(ctx.previewDeformation).not.toHaveBeenCalled();
		expect(ctx.elementToggleSelect).not.toHaveBeenCalled();
	});

	it("should drag Shift-selected corners together by the same delta", () => {
		const ctx = makeContext();
		const tool = new FreeTransformTool(ctx);

		// Select TL and TR with Shift+click.
		tool.onPointerDown(
			ev(350, 250, { shiftKey: true }),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerDown(
			ev(450, 250, { shiftKey: true }),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		// Grab TR (selected) and drag by world (+30, +20).
		tool.onPointerDown(
			ev(450, 250),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(480, 230),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const [, corners] = lastWarpComputeArgs(ctx);
		// Both selected corners moved together; the bottom edge stayed put.
		expect(corners[0]).toEqual([-20, 70]);
		expect(corners[1]).toEqual([80, 70]);
		expect(corners[2]).toEqual([50, -50]);
		expect(corners[3]).toEqual([-50, -50]);
	});

	it("should move both corners of an edge with its midpoint handle", () => {
		const ctx = makeContext();
		const tool = new FreeTransformTool(ctx);

		// Top edge midpoint world(0,50) → screen(400,250); drag by world (+30,+20).
		tool.onPointerDown(
			ev(400, 250),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(430, 230),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const [, corners] = lastWarpComputeArgs(ctx);
		// The whole top edge translates; the bottom edge stays put.
		expect(corners[0]).toEqual([-20, 70]);
		expect(corners[1]).toEqual([80, 70]);
		expect(corners[2]).toEqual([50, -50]);
		expect(corners[3]).toEqual([-50, -50]);
	});

	it("should constrain the corner drag to the dominant axis while Shift is held", () => {
		const ctx = makeContext();
		const tool = new FreeTransformTool(ctx);

		// Grab TR and drag mostly horizontally (world delta 30, 5) with Shift.
		tool.onPointerDown(
			ev(450, 250),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(480, 245, { shiftKey: true }),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const [, corners] = lastWarpComputeArgs(ctx);
		// Snapped to the horizontal axis: the vertical component drops to 0.
		expect(corners[1][1]).toBeCloseTo(50, 5);
		expect(corners[1][0]).toBeGreaterThan(50);
	});

	it("should drop the corner-handle selection when the element selection changes", () => {
		let selection = [ELEMENT_ID];
		const ctx = makeContext({
			getSelectedElementIds: vi.fn(() => selection),
		});
		const tool = new FreeTransformTool(ctx);

		// Select TL and TR handles, then switch to another element.
		tool.onPointerDown(
			ev(350, 250, { shiftKey: true }),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerDown(
			ev(450, 250, { shiftKey: true }),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		selection = ["el-2"];
		tool.refreshUI();

		// Dragging TR now moves only TR — the stale handle selection is gone.
		tool.onPointerDown(
			ev(450, 250),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(480, 230),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const [, corners] = lastWarpComputeArgs(ctx);
		expect(corners[0]).toEqual([-50, 50]);
		expect(corners[1][0]).toBeCloseTo(80, 5);
	});

	it("should keep Shift+click off the handles as element selection toggle", () => {
		const ctx = makeContext({
			findElementAtPoint: vi.fn(
				() => ({ id: "el-2" }) as unknown as AnyArtObject,
			),
		});
		const tool = new FreeTransformTool(ctx);

		// Shift+click at the box centre (no handle there) hits an element.
		tool.onPointerDown(
			ev(400, 300, { shiftKey: true }),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(ctx.elementToggleSelect).toHaveBeenCalled();
		expect(ctx.elementToggleSelect.mock.calls.at(-1)?.[0]).toBe("el-2");
	});

	it("should reject a non-convex (bow-tie) corner drag", () => {
		const ctx = makeContext();
		const tool = new FreeTransformTool(ctx);

		// Drag TR across to near BL (screen 355,345 → world -45,-45): self-intersects.
		tool.onPointerDown(
			ev(450, 250),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(355, 345),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(ctx.previewDeformation).not.toHaveBeenCalled();
	});

	it("should not warp when the press misses every corner handle", () => {
		const ctx = makeContext();
		const tool = new FreeTransformTool(ctx);

		// world(0,0) is the centre, far from any corner handle.
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

		expect(ctx.previewDeformation).not.toHaveBeenCalled();
	});

	it("should select an unselected element on a non-handle click", () => {
		const ctx = makeContext({
			findElementAtPoint: vi.fn(
				() => ({ id: "el-2" }) as unknown as AnyArtObject,
			),
		});
		const tool = new FreeTransformTool(ctx);

		tool.onPointerDown(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(ctx.elementSelect).toHaveBeenCalled();
		expect(ctx.elementSelect.mock.calls.at(-1)?.[0]).toBe("el-2");
		expect(ctx.previewDeformation).not.toHaveBeenCalled();
	});

	it("should clear the selection when clicking empty space", () => {
		const ctx = makeContext();
		const tool = new FreeTransformTool(ctx);

		// world(300,0) is outside the box and hits nothing.
		tool.onPointerDown(
			ev(700, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(ctx.selectionClear).toHaveBeenCalled();
	});

	it("should not start a warp when the element is locked", () => {
		const ctx = makeContext({ isElementLocked: vi.fn(() => true) });
		const tool = new FreeTransformTool(ctx);

		tool.onPointerDown(
			ev(450, 250),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(480, 230),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(ctx.previewDeformation).not.toHaveBeenCalled();
	});
});

// Helpers

function makeContext(
	overrides: Parameters<typeof createMockToolContext>[0] = {},
): MockToolContext {
	return createMockToolContext({
		getSelectedElementIds: vi.fn(() => [ELEMENT_ID]),
		getBounds: vi.fn(() => BOUNDS),
		getElement: vi.fn(
			() => ({ id: ELEMENT_ID, type: "path" }) as unknown as AnyArtObject,
		),
		getCurrentLayerId: vi.fn(() => "layer-1"),
		// Non-empty updates so applyDeformation (not clear) runs on commit.
		perspectiveWarpCompute: vi.fn((ids: string[]) =>
			ids.map((id) => ({ elementId: id, layerId: "layer-1", updates: {} })),
		),
		...overrides,
	});
}

function lastWarpComputeArgs(
	ctx: MockToolContext,
): [string[], [Vec2, Vec2, Vec2, Vec2], [Vec2, Vec2, Vec2, Vec2]] {
	const call = ctx.perspectiveWarpCompute.mock.calls.at(-1);
	if (!call) throw new Error("perspectiveWarpCompute was not called");
	return call as [string[], [Vec2, Vec2, Vec2, Vec2], [Vec2, Vec2, Vec2, Vec2]];
}
