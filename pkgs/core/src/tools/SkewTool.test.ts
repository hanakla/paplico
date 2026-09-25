import { describe, expect, it, vi } from "vitest";
import type { AnyArtObject } from "../schema";
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
import { SkewTool } from "./SkewTool";

const ELEMENT_ID = "el-1";

// A 100×100 element centred on the world origin: screen(400,300) → world(0,0)
// is inside it, screen(700,300) → world(300,0) is outside.
const BOUNDS: WorldBBox = {
	minX: -50,
	minY: -50,
	maxX: 50,
	maxY: 50,
	width: 100,
	height: 100,
} as WorldBBox;

describe("SkewTool", () => {
	it("should stay active with no selection so an object can be picked", () => {
		const ctx = makeContext({
			getSelectedElementIds: vi.fn(() => []),
			findElementAtPoint: vi.fn(
				() => ({ id: ELEMENT_ID }) as unknown as AnyArtObject,
			),
		});
		const tool = new SkewTool(ctx);
		expect(ctx.complete).not.toHaveBeenCalled();

		// Clicking an object selects it even though nothing was selected on entry.
		tool.onPointerDown(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		expect(ctx.elementSelect).toHaveBeenCalled();
	});

	it("should shear along skewX when dragging horizontally on the element", () => {
		const ctx = makeContext();
		const tool = new SkewTool(ctx);

		// pointer down inside the selection, drag right across half the height
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

		const transform = lastPreviewTransform(ctx);
		// dx = 50 world px over half-height (50) → atan(1) = π/4
		expect(transform.skewX).toBeCloseTo(Math.PI / 4, 2);
		expect(transform.skewY).toBeCloseTo(0, 5);
	});

	it("should shear along skewY when dragging vertically on the element", () => {
		const ctx = makeContext();
		const tool = new SkewTool(ctx);

		tool.onPointerDown(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		// screen y up → world +y; drag up across half the width
		tool.onPointerMove(
			ev(400, 250),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const transform = lastPreviewTransform(ctx);
		expect(transform.skewY).toBeCloseTo(Math.PI / 4, 2);
		expect(transform.skewX).toBeCloseTo(0, 5);
	});

	it("should lock the shear to the dominant axis when Shift is held", () => {
		const ctx = makeContext();
		const tool = new SkewTool(ctx);

		tool.onPointerDown(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		// Diagonal drag, horizontal-dominant (dx = 50, dy = -40 world px) with Shift
		tool.onPointerMove(
			ev(450, 340, { shiftKey: true }),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const transform = lastPreviewTransform(ctx);
		// Horizontal drag dominates → skewX only, skewY locked to 0
		expect(transform.skewX).toBeCloseTo(Math.PI / 4, 2);
		expect(transform.skewY).toBeCloseTo(0, 5);
	});

	it("should not wipe an in-progress skew when refreshUI fires mid-drag", () => {
		const ctx = makeContext();
		const tool = new SkewTool(ctx);

		tool.onPointerDown(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(425, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		// An engine refresh (render / zoom / text re-layout) fires mid-drag.
		tool.refreshUI();
		// The drag must continue: this move should still update the skew.
		tool.onPointerMove(
			ev(450, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const transform = lastPreviewTransform(ctx);
		// dx = 50 world px over half-height (50) → atan(1) = π/4 (not the earlier 25px)
		expect(transform.skewX).toBeCloseTo(Math.PI / 4, 2);
	});

	it("should commit the skew via applyDeformation on Enter", () => {
		const ctx = makeContext();
		const tool = new SkewTool(ctx);

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
		tool.onKeyDown(new KeyboardEvent("keydown", { code: "Enter" }));

		expect(ctx.applyDeformation).toHaveBeenCalled();
		const updates = ctx.applyDeformation.mock.calls.at(-1)?.[0] as PreviewArgs;
		expect(updates[0].updates.transform?.skewX).toBeCloseTo(Math.PI / 4, 2);
		expect(ctx.complete).toHaveBeenCalled();
	});

	it("should not skew when the drag begins outside the selection", () => {
		const ctx = makeContext();
		const tool = new SkewTool(ctx);

		// world(300,0) is outside the 100×100 box
		tool.onPointerDown(
			ev(700, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(750, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(ctx.previewDeformation).not.toHaveBeenCalled();
	});

	it("should select an unselected element on click", () => {
		const ctx = makeContext({
			findElementAtPoint: vi.fn(
				() => ({ id: "el-2" }) as unknown as AnyArtObject,
			),
		});
		const tool = new SkewTool(ctx);

		tool.onPointerDown(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(ctx.elementSelect).toHaveBeenCalled();
		expect(ctx.elementSelect.mock.calls.at(-1)?.[0]).toBe("el-2");
	});

	it("should begin a skew drag on the same gesture after selecting", () => {
		const ctx = makeContext({
			findElementAtPoint: vi.fn(
				() => ({ id: "el-2" }) as unknown as AnyArtObject,
			),
		});
		const tool = new SkewTool(ctx);

		// Down selects the hit element; the continuing move should skew it.
		tool.onPointerDown(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		expect(ctx.elementSelect).toHaveBeenCalled();
		tool.onPointerMove(
			ev(450, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const transform = lastPreviewTransform(ctx);
		expect(transform.skewX).toBeCloseTo(Math.PI / 4, 2);
	});

	it("should toggle selection on Shift+click without skewing", () => {
		const ctx = makeContext({
			findElementAtPoint: vi.fn(
				() => ({ id: "el-2" }) as unknown as AnyArtObject,
			),
		});
		const tool = new SkewTool(ctx);

		tool.onPointerDown(
			ev(400, 300, { shiftKey: true }),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(ctx.elementToggleSelect).toHaveBeenCalled();
		expect(ctx.elementToggleSelect.mock.calls.at(-1)?.[0]).toBe("el-2");
		expect(ctx.previewDeformation).not.toHaveBeenCalled();
	});

	it("should clear the selection when clicking empty space", () => {
		const ctx = makeContext(); // findElementAtPoint defaults to null (a miss)
		const tool = new SkewTool(ctx);

		// world(300,0) is outside the 100×100 selection AABB
		tool.onPointerDown(
			ev(700, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(ctx.selectionClear).toHaveBeenCalled();
	});

	it("should shear only skewX when dragging the horizontal bar diagonally", () => {
		const ctx = makeContext();
		const tool = new SkewTool(ctx);

		// The horizontal bar sits above the top edge: world(0, 64) → screen(400, 236).
		tool.onPointerDown(
			ev(400, 236),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		// Diagonal drag: only the horizontal component may shear.
		tool.onPointerMove(
			ev(450, 216),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const transform = lastPreviewTransform(ctx);
		expect(transform.skewX).toBeCloseTo(Math.PI / 4, 2);
		expect(transform.skewY).toBeCloseTo(0, 5);
	});

	it("should shear only skewY when dragging the vertical bar diagonally", () => {
		const ctx = makeContext();
		const tool = new SkewTool(ctx);

		// The vertical bar sits past the left edge: world(-64, 0) → screen(336, 300).
		tool.onPointerDown(
			ev(336, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		// Diagonal drag: only the vertical component may shear.
		tool.onPointerMove(
			ev(376, 250),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const transform = lastPreviewTransform(ctx);
		expect(transform.skewY).toBeCloseTo(Math.PI / 4, 2);
		expect(transform.skewX).toBeCloseTo(0, 5);
	});

	it("should restore the original and complete on cancel", () => {
		const ctx = makeContext();
		const tool = new SkewTool(ctx);

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

		expect(ctx.clearDeformationPreview).toHaveBeenCalled();
		expect(ctx.restoreOriginal).toHaveBeenCalled();
		expect(ctx.complete).toHaveBeenCalled();
	});
});

// Helpers

type PreviewArgs = Array<{
	elementId: string;
	layerId: string;
	updates: Partial<AnyArtObject>;
}>;

function makeContext(
	overrides: Parameters<typeof createMockToolContext>[0] = {},
): MockToolContext {
	return createMockToolContext({
		getSelectedElementIds: vi.fn(() => [ELEMENT_ID]),
		getElement: vi.fn(
			() =>
				({
					id: ELEMENT_ID,
					type: "path",
					// SkewTool only reads element.transform; the rest is fixture padding.
					transform: {
						x: 0,
						y: 0,
						rotation: 0,
						scaleX: 1,
						scaleY: 1,
						skewX: 0,
						skewY: 0,
					},
				}) as unknown as AnyArtObject,
		),
		getBounds: vi.fn(() => BOUNDS),
		getCurrentLayerId: vi.fn(() => "layer-1"),
		...overrides,
	});
}

function lastPreviewTransform(ctx: MockToolContext) {
	const updates = ctx.previewDeformation.mock.calls.at(-1)?.[0] as PreviewArgs;
	if (!updates) throw new Error("previewDeformation was not called");
	const transform = updates[0].updates.transform;
	if (!transform) throw new Error("preview update carried no transform");
	return transform;
}
