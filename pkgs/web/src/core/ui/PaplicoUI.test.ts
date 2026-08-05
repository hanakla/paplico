import { afterEach, describe, expect, it, vi } from "vitest";
import { PAPLICO_MAX_ZOOM_SCALE } from "../document/constants";
import type { RawRGBA, Viewport } from "../schema";
import type { Tool } from "../tools/Tool";
import { PaplicoUI } from "./PaplicoUI";

const mountedUis: PaplicoUI[] = [];

afterEach(() => {
	for (const ui of mountedUis) ui.destroy();
	mountedUis.length = 0;
});

describe("PaplicoUI tool size adjustment", () => {
	it.each([
		["pen", "left", 90, 100, 40],
		["pen", "up", 100, 90, 40],
		["pen", "right", 110, 100, 60],
		["pen", "down", 100, 110, 60],
		["eraser", "left", 90, 100, 40],
		["eraser", "up", 100, 90, 40],
		["eraser", "right", 110, 100, 60],
		["eraser", "down", 100, 110, 60],
	] as const)("should adjust the %s size when dragging %s with Alt", (toolName, _direction, x, y, expectedWidth) => {
		const harness = createHarness(toolName, 50);

		dispatchPointer(harness.canvas, "pointerdown", {
			clientX: 100,
			clientY: 100,
			altKey: true,
		});
		dispatchPointer(harness.canvas, "pointermove", {
			clientX: x,
			clientY: y,
			altKey: true,
		});
		dispatchPointer(harness.canvas, "pointerup", {
			clientX: x,
			clientY: y,
			altKey: true,
		});

		expect(harness.setToolWidth.mock.calls.at(-1)?.[0]).toBe(expectedWidth);
		expect(harness.tool.onPointerDown).not.toHaveBeenCalled();
		expect(harness.tool.onPointerMove).not.toHaveBeenCalled();
		expect(harness.tool.onPointerUp).not.toHaveBeenCalled();
		expect(harness.setDrawing).not.toHaveBeenCalledWith(true);
	});

	it.each([
		[0.5, 70],
		[2, 55],
	] as const)("should match the screen drag distance at %sx zoom", (zoom, expectedWidth) => {
		const harness = createHarness("pen", 50, zoom);

		dispatchPointer(harness.canvas, "pointerdown", {
			clientX: 100,
			clientY: 100,
			altKey: true,
		});
		dispatchPointer(harness.canvas, "pointermove", {
			clientX: 110,
			clientY: 100,
			altKey: true,
		});

		expect(harness.setToolWidth.mock.calls.at(-1)?.[0]).toBe(expectedWidth);
	});

	it.each([
		["pen", "toolCursorUpdate"],
		["eraser", "eraserToolUpdate"],
	] as const)("should keep the %s preview centered at the drag start", (toolName, eventName) => {
		const harness = createHarness(toolName, 50);
		const cursorUpdate = vi.fn();
		harness.ui.on(eventName, cursorUpdate);

		dispatchPointer(harness.canvas, "pointerdown", {
			clientX: 100,
			clientY: 100,
			altKey: true,
		});
		dispatchPointer(harness.canvas, "pointermove", {
			clientX: 110,
			clientY: 120,
			altKey: true,
		});

		expect(cursorUpdate.mock.calls.at(-1)?.[0]).toMatchObject({
			worldX: -300,
			worldY: 200,
		});
	});

	it("should delegate a drag without Alt to the pen tool", () => {
		const harness = createHarness("pen", 50);

		dispatchPointer(harness.canvas, "pointerdown", {
			clientX: 100,
			clientY: 100,
		});
		dispatchPointer(harness.canvas, "pointermove", {
			clientX: 110,
			clientY: 100,
		});
		dispatchPointer(harness.canvas, "pointerup", {
			clientX: 110,
			clientY: 100,
		});

		expect(harness.setToolWidth).not.toHaveBeenCalled();
		expect(harness.tool.onPointerDown).toHaveBeenCalledOnce();
		expect(harness.tool.onPointerMove).toHaveBeenCalledOnce();
		expect(harness.tool.onPointerUp).toHaveBeenCalledOnce();
	});

	it("should delegate an Alt drag to tools other than pen and eraser", () => {
		const harness = createHarness("select", 50);

		dispatchPointer(harness.canvas, "pointerdown", {
			clientX: 100,
			clientY: 100,
			altKey: true,
		});
		dispatchPointer(harness.canvas, "pointermove", {
			clientX: 110,
			clientY: 100,
			altKey: true,
		});
		dispatchPointer(harness.canvas, "pointerup", {
			clientX: 110,
			clientY: 100,
			altKey: true,
		});

		expect(harness.setToolWidth).not.toHaveBeenCalled();
		expect(harness.tool.onPointerDown).toHaveBeenCalledOnce();
		expect(harness.tool.onPointerMove).toHaveBeenCalledOnce();
		expect(harness.tool.onPointerUp).toHaveBeenCalledOnce();
	});

	it("should prioritize middle-button panning over Alt size adjustment", () => {
		const harness = createHarness("pen", 50);

		dispatchPointer(harness.canvas, "pointerdown", {
			button: 1,
			clientX: 100,
			clientY: 100,
			altKey: true,
		});
		dispatchPointer(harness.canvas, "pointermove", {
			button: 1,
			clientX: 110,
			clientY: 100,
			altKey: true,
		});

		expect(harness.setViewport).toHaveBeenCalledOnce();
		expect(harness.setToolWidth).not.toHaveBeenCalled();
		expect(harness.tool.onPointerDown).not.toHaveBeenCalled();
	});

	it.each([
		"pointerup",
		"pointercancel",
		"pointerleave",
	] as const)("should clear size adjustment after %s", (endEvent) => {
		const harness = createHarness("pen", 50);

		dispatchPointer(harness.canvas, "pointerdown", {
			clientX: 100,
			clientY: 100,
			altKey: true,
		});
		dispatchPointer(harness.canvas, endEvent, {
			clientX: 100,
			clientY: 100,
			altKey: true,
		});
		dispatchPointer(harness.canvas, "pointerdown", {
			pointerId: 2,
			clientX: 120,
			clientY: 100,
		});

		expect(harness.tool.onPointerDown).toHaveBeenCalledOnce();
	});
});

describe("PaplicoUI tool cursor", () => {
	it.each([
		["pen", "toolCursorUpdate"],
		["eraser", "eraserToolUpdate"],
	] as const)("should show the %s cursor as soon as the pointer presses", (toolName, eventName) => {
		const harness = createHarness(toolName, 50);
		const cursorUpdate = vi.fn();
		harness.ui.on(eventName, cursorUpdate);

		dispatchPointer(harness.canvas, "pointerdown", {
			pointerType: "touch",
			clientX: 400,
			clientY: 300,
			width: 40,
			height: 40,
		});

		// canvas 800x600 with an identity viewport: screen(400,300) -> world(0,0)
		expect(cursorUpdate.mock.calls.at(-1)?.[0]).toMatchObject({
			worldX: 0,
			worldY: 0,
		});
	});
});

describe("PaplicoUI touch draw offset", () => {
	it.each([
		"pen",
		"eraser",
	] as const)("should lift %s input above the fingertip from the very first point", (toolName) => {
		const harness = createHarness(toolName, 50, 1, 1);

		dispatchPointer(harness.canvas, "pointerdown", {
			pointerType: "touch",
			clientX: 100,
			clientY: 300,
			width: 40,
			height: 40,
		});
		dispatchPointer(harness.canvas, "pointermove", {
			pointerType: "touch",
			clientX: 100,
			clientY: 300,
			width: 40,
			height: 40,
		});

		// The full 60px lift applies from the press itself — no drift afterwards.
		expect(harness.tool.onPointerDown.mock.calls[0][0]).toMatchObject({
			x: 100,
			y: 240,
		});
		expect(harness.tool.onPointerMove.mock.calls.at(-1)?.[0]).toMatchObject({
			x: 100,
			y: 240,
		});
	});

	it("should scale the offset by the configured multiplier", () => {
		const harness = createHarness("pen", 50, 1, 0.5);

		dispatchPointer(harness.canvas, "pointerdown", {
			pointerType: "touch",
			clientX: 100,
			clientY: 300,
			width: 40,
			height: 40,
		});

		expect(harness.tool.onPointerDown.mock.calls[0][0]).toMatchObject({
			x: 100,
			y: 270,
		});
	});

	it("should not move when the reported contact width settles on the first move", () => {
		const harness = createHarness("pen", 50, 1, 1);

		// Browsers often report a placeholder width=1 at pointerdown and the
		// real contact ellipse only on the first move. The lift must not react.
		dispatchPointer(harness.canvas, "pointerdown", {
			pointerType: "touch",
			clientX: 100,
			clientY: 300,
			width: 1,
			height: 1,
		});
		dispatchPointer(harness.canvas, "pointermove", {
			pointerType: "touch",
			clientX: 100,
			clientY: 300,
			width: 40,
			height: 40,
		});
		dispatchPointer(harness.canvas, "pointermove", {
			pointerType: "touch",
			clientX: 100,
			clientY: 300,
			width: 60,
			height: 60,
		});

		const downY = harness.tool.onPointerDown.mock.calls[0][0].y;
		expect(downY).toBe(240);
		for (const call of harness.tool.onPointerMove.mock.calls) {
			expect(call[0].y).toBe(downY);
		}
	});

	it("should draw at the contact point for pen (stylus) input", () => {
		const harness = createHarness("pen", 50, 1, 1);

		dispatchPointer(harness.canvas, "pointerdown", {
			pointerType: "pen",
			clientX: 100,
			clientY: 300,
			width: 40,
			height: 40,
		});

		expect(harness.tool.onPointerDown.mock.calls[0][0]).toMatchObject({
			x: 100,
			y: 300,
		});
	});

	it("should keep touch input at the contact point for other tools", () => {
		const harness = createHarness("select", 50, 1, 1);

		dispatchPointer(harness.canvas, "pointerdown", {
			pointerType: "touch",
			clientX: 100,
			clientY: 300,
			width: 40,
			height: 40,
		});

		expect(harness.tool.onPointerDown.mock.calls[0][0]).toMatchObject({
			x: 100,
			y: 300,
		});
	});

	it("should lift the tool cursor together with the applied point", () => {
		const harness = createHarness("pen", 50, 1, 1);
		const cursorUpdate = vi.fn();
		harness.ui.on("toolCursorUpdate", cursorUpdate);

		dispatchPointer(harness.canvas, "pointermove", {
			pointerType: "touch",
			clientX: 400,
			clientY: 300,
			width: 40,
			height: 40,
		});

		// canvas 800x600 with an identity viewport: screen(400,240) -> world(0,60)
		expect(cursorUpdate.mock.calls.at(-1)?.[0]).toMatchObject({
			worldX: 0,
			worldY: 60,
		});
	});
});

describe("PaplicoUI pen input passthrough", () => {
	it("should forward PointerEvent.twist to the tool event data", () => {
		const harness = createHarness("pen", 50);

		dispatchPointer(harness.canvas, "pointerdown", {
			clientX: 100,
			clientY: 100,
			pointerType: "pen",
			twist: 90,
		});

		expect(harness.tool.onPointerDown).toHaveBeenCalledTimes(1);
		const eventData = harness.tool.onPointerDown.mock.calls[0][0];
		expect(eventData.twist).toBe(90);
	});

	it("should default twist to 0 when the event does not carry it", () => {
		const harness = createHarness("pen", 50);

		dispatchPointer(harness.canvas, "pointerdown", {
			clientX: 100,
			clientY: 100,
			pointerType: "pen",
		});

		const eventData = harness.tool.onPointerDown.mock.calls[0][0];
		expect(eventData.twist).toBe(0);
	});

	it("should forward getCoalescedEvents samples on pointermove", () => {
		const harness = createHarness("pen", 50);

		dispatchPointer(harness.canvas, "pointerdown", {
			clientX: 100,
			clientY: 100,
			pointerType: "pen",
		});

		const move = new PointerEvent("pointermove", {
			bubbles: true,
			pointerId: 1,
			pointerType: "pen",
			button: 0,
			pressure: 0.6,
			clientX: 112,
			clientY: 100,
			width: 1,
			height: 1,
		});
		const samples = [
			{
				clientX: 104,
				clientY: 100,
				pressure: 0.4,
				tiltX: 5,
				tiltY: 0,
				twist: 10,
				timeStamp: 1010,
			},
			{
				clientX: 108,
				clientY: 100,
				pressure: 0.5,
				tiltX: 6,
				tiltY: 0,
				twist: 20,
				timeStamp: 1020,
			},
			{
				clientX: 112,
				clientY: 100,
				pressure: 0.6,
				tiltX: 7,
				tiltY: 0,
				twist: 30,
				timeStamp: 1030,
			},
		];
		Object.defineProperty(move, "getCoalescedEvents", {
			value: () => samples,
		});
		harness.canvas.dispatchEvent(move);

		const eventData = harness.tool.onPointerMove.mock.calls.at(-1)?.[0];
		expect(eventData.coalesced).toHaveLength(3);
		expect(eventData.coalesced[0]).toMatchObject({
			x: 104,
			y: 100,
			twist: 10,
			timeStamp: 1010,
		});
		expect(eventData.coalesced[2]).toMatchObject({ x: 112, twist: 30 });
	});
});

describe("PaplicoUI zoom clamp", () => {
	function dispatchCtrlWheelZoomIn(canvas: HTMLCanvasElement) {
		// happy-dom's WheelEvent constructor does not wire up `ctrlKey` from
		// the init dict, so it has to be forced on afterward.
		const event = new WheelEvent("wheel", {
			bubbles: true,
			cancelable: true,
			deltaY: -1,
			clientX: 400,
			clientY: 300,
		});
		Object.defineProperty(event, "ctrlKey", { value: true });
		canvas.dispatchEvent(event);
	}

	it("should clamp Ctrl+wheel zoom-in to the configured max instead of PAPLICO_MAX_ZOOM_SCALE", () => {
		const harness = createHarness("pen", 50, 1, 0, 10);

		for (let i = 0; i < 100; i++) {
			dispatchCtrlWheelZoomIn(harness.canvas);
		}

		const zooms = harness.setViewport.mock.calls
			.map((call) => call[0]?.zoom)
			.filter((z): z is number => typeof z === "number");
		expect(zooms.length).toBeGreaterThan(0);
		expect(Math.max(...zooms)).toBeLessThanOrEqual(10);
	});

	it("should fall back to PAPLICO_MAX_ZOOM_SCALE when getMaxZoomScale is omitted", () => {
		const harness = createHarness("pen", 50, PAPLICO_MAX_ZOOM_SCALE - 1);

		dispatchCtrlWheelZoomIn(harness.canvas);

		const zoom = harness.setViewport.mock.calls.at(-1)?.[0]?.zoom;
		expect(zoom).toBeLessThanOrEqual(PAPLICO_MAX_ZOOM_SCALE);
	});
});

function createHarness(
	toolName: string,
	initialWidth: number,
	zoom = 1,
	touchDrawOffsetScale = 0,
	maxZoomScale?: number,
) {
	const canvas = document.createElement("canvas");
	canvas.getBoundingClientRect = () =>
		({
			left: 0,
			top: 0,
			width: 800,
			height: 600,
			right: 800,
			bottom: 600,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		}) satisfies DOMRect;

	const tool = {
		name: toolName,
		onPointerDown: vi.fn(),
		onPointerMove: vi.fn(),
		onPointerUp: vi.fn(),
		onCancel: vi.fn(),
		getCursor: vi.fn(() => "crosshair"),
	} satisfies Tool;
	const setToolWidth = vi.fn();
	const setDrawing = vi.fn();
	const setViewport = vi.fn();
	const viewport: Viewport = { x: 0, y: 0, zoom, rotation: 0 };
	const color: RawRGBA = { r: 0, g: 0, b: 0, a: 1 };

	const ui = new PaplicoUI(canvas, {
		getViewport: () => viewport,
		setViewport,
		getCanvasSize: () => ({ width: 800, height: 600 }),
		getTool: () => tool,
		isDrawing: () => false,
		setDrawing,
		setActiveTarget: vi.fn(),
		requestRender: vi.fn(),
		getCurrentTool: () => toolName,
		getToolWidth: () => initialWidth,
		setToolWidth,
		getToolColor: () => color,
		setShapeType: vi.fn(),
		getTouchDrawOffsetScale: () => touchDrawOffsetScale,
		...(maxZoomScale !== undefined
			? { getMaxZoomScale: () => maxZoomScale }
			: {}),
	});
	mountedUis.push(ui);

	return { canvas, tool, ui, setDrawing, setToolWidth, setViewport };
}

function dispatchPointer(
	canvas: HTMLCanvasElement,
	type:
		| "pointerdown"
		| "pointermove"
		| "pointerup"
		| "pointercancel"
		| "pointerleave",
	init: PointerEventInit,
): void {
	canvas.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			pointerId: 1,
			pointerType: "mouse",
			button: 0,
			pressure: 0.5,
			width: 1,
			height: 1,
			...init,
		}),
	);
}
