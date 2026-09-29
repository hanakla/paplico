import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyArtObject, Filter } from "../schema";
import { createMockToolContext } from "../testUtils/mockToolContext";
import {
	ev,
	testCanvasHeight,
	testCanvasWidth,
	testViewport,
	toolClick,
} from "../testUtils/pointerEvent";
import { EyedropperTool } from "./EyedropperTool";
import { LONG_PRESS_MS } from "./Tool";

// Default viewport (0,0,zoom=1), canvas 800x600: screen(400,300) → world(0,0)

describe("EyedropperTool", () => {
	const front = makeFilledElement("front", 1);
	const back = makeFilledElement("back", 0.5);

	let ctx: ReturnType<typeof createMockToolContext>;
	let callbacks: ReturnType<typeof createMockCallbacks>;
	let tool: EyedropperTool;

	beforeEach(() => {
		vi.useFakeTimers();
		ctx = createMockToolContext({
			findLeafElementAtPoint: vi.fn(() => front),
			findPaintedElementsAtPoint: vi.fn(() => [
				{ element: front, depth: 0 },
				{ element: back, depth: 0 },
			]),
			getElement: vi.fn((id: string) => ({ front, back })[id] ?? null),
		});
		callbacks = createMockCallbacks();
		tool = new EyedropperTool(ctx, callbacks);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("click", () => {
		it("should pick the frontmost element on release", () => {
			toolClick(tool, 400, 300);

			expect(callbacks.onPick).toHaveBeenCalledOnce();
			expect(pickedFillRed(callbacks)).toBe(1);
			expect(ctx.uiSetToolSession.mock.calls.at(-1)?.[0]).toBeNull();
		});

		it("should apply to the selection when elements are selected", () => {
			ctx.getSelectedElementIds.mockReturnValue(["selected-1"]);

			toolClick(tool, 400, 300);

			const [target, selectedIds] = callbacks.onPickForSelection.mock.calls[0];
			expect(target.id).toBe("front");
			expect(selectedIds).toEqual(["selected-1"]);
		});
	});

	describe("long press", () => {
		it("should list the candidates without picking anything", () => {
			press(tool, 400, 300);
			vi.advanceTimersByTime(LONG_PRESS_MS);
			release(tool, 400, 300);

			const session = ctx.uiSetToolSession.mock.calls.at(-1)?.[0];
			expect(session).toMatchObject({
				type: "eyedropper-candidates",
				point: { x: 0, y: 0 },
				candidates: [
					{ elementId: "front", depth: 0 },
					{ elementId: "back", depth: 0 },
				],
			});
			expect(callbacks.onPick).not.toHaveBeenCalled();
		});

		it("should list a lone candidate too", () => {
			ctx.findPaintedElementsAtPoint.mockReturnValue([
				{ element: front, depth: 0 },
			]);

			press(tool, 400, 300);
			vi.advanceTimersByTime(LONG_PRESS_MS);

			expect(ctx.uiSetToolSession.mock.calls.at(-1)?.[0]).toMatchObject({
				type: "eyedropper-candidates",
				candidates: [{ elementId: "front", depth: 0 }],
			});
			expect(callbacks.onPick).not.toHaveBeenCalled();
		});

		it("should stay a click when the pointer moves away before the delay", () => {
			press(tool, 400, 300);
			tool.onPointerMove(
				ev(420, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			vi.advanceTimersByTime(LONG_PRESS_MS);
			release(tool, 420, 300);

			expect(callbacks.onPick).toHaveBeenCalledOnce();
			expect(ctx.findLeafElementAtPoint.mock.calls[0]).toEqual([0, 0]);
		});
	});

	describe("right click", () => {
		it("should list the candidates immediately", () => {
			press(tool, 400, 300, 2);

			expect(ctx.uiSetToolSession.mock.calls.at(-1)?.[0]).toMatchObject({
				type: "eyedropper-candidates",
			});
			expect(callbacks.onPick).not.toHaveBeenCalled();
		});

		it("should list a lone candidate too", () => {
			ctx.findPaintedElementsAtPoint.mockReturnValue([
				{ element: front, depth: 0 },
			]);

			press(tool, 400, 300, 2);

			expect(ctx.uiSetToolSession.mock.calls.at(-1)?.[0]).toMatchObject({
				type: "eyedropper-candidates",
				candidates: [{ elementId: "front", depth: 0 }],
			});
			expect(callbacks.onPick).not.toHaveBeenCalled();
		});

		it("should pick the backdrop when nothing is painted there", () => {
			ctx.findPaintedElementsAtPoint.mockReturnValue([]);
			ctx.findLeafElementAtPoint.mockReturnValue(null);

			press(tool, 400, 300, 2);

			expect(callbacks.onPick.mock.calls[0][0].pickedColor).toBeDefined();
			expect(ctx.uiSetToolSession.mock.calls.at(-1)?.[0]).toBeNull();
		});
	});

	describe("pickCandidate", () => {
		it("should pick the chosen candidate and close the list", () => {
			press(tool, 400, 300, 2);

			tool.pickCandidate("back");

			expect(pickedFillRed(callbacks)).toBe(0.5);
			expect(ctx.uiSetToolSession.mock.calls.at(-1)?.[0]).toBeNull();
		});
	});

	describe("onCancel", () => {
		it("should close the list and drop a pending long press", () => {
			press(tool, 400, 300);

			tool.onCancel();
			vi.advanceTimersByTime(LONG_PRESS_MS);

			expect(ctx.uiSetToolSession.mock.calls.at(-1)?.[0]).toBeNull();
			expect(ctx.findPaintedElementsAtPoint).not.toHaveBeenCalled();
		});
	});
});

function createMockCallbacks() {
	return {
		onPickForSelection: vi.fn(),
		onPick: vi.fn(),
	};
}

function press(tool: EyedropperTool, x: number, y: number, button = 0): void {
	tool.onPointerDown(
		ev(x, y, { button }),
		testViewport,
		testCanvasWidth,
		testCanvasHeight,
	);
}

function release(tool: EyedropperTool, x: number, y: number): void {
	tool.onPointerUp(ev(x, y), testViewport, testCanvasWidth, testCanvasHeight);
}

/** Red channel of the fill handed to onPick, which tells the fixtures apart. */
function pickedFillRed(
	callbacks: ReturnType<typeof createMockCallbacks>,
): number | undefined {
	const fill =
		callbacks.onPick.mock.calls.at(-1)?.[0].fillAppearance?.paramData.params
			.fill;
	return fill?.type === "solid" && fill.color.type === "rgb"
		? fill.color.r
		: undefined;
}

function makeFilledElement(id: string, red: number): AnyArtObject {
	const fill = {
		uid: `${id}-fill`,
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: {
					type: "solid",
					color: { type: "rgb", r: red, g: 0, b: 0, a: 1 },
				},
			},
		},
	} as Filter;
	return {
		type: "path",
		id,
		segments: [],
		opacity: 1,
		blendMode: "normal",
		filters: [fill],
	} as unknown as AnyArtObject;
}
