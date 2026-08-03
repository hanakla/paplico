import type { Viewport } from "../schema";
import type { PointerEventData, Tool } from "../tools/Tool";

/** Degrees to radians for test readability */
export const degToRad = (deg: number) => (deg * Math.PI) / 180;

/** テスト用デフォルトviewport */
export const testViewport: Viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

/** テスト用デフォルトキャンバスサイズ */
export const testCanvasWidth = 800;
export const testCanvasHeight = 600;

/**
 * PointerEventDataファクトリ。
 * デフォルト viewport(0,0,zoom=1) + canvas(800x600) での座標変換:
 *   screen(400,300) → world(0,0)
 *   screen(500,200) → world(100,100)
 */
export function ev(
	x: number,
	y: number,
	overrides: Partial<PointerEventData> = {},
): PointerEventData {
	return {
		x,
		y,
		pressure: 0.5,
		tiltX: 0,
		tiltY: 0,
		pointerType: "mouse",
		button: 0,
		contactWidth: 1,
		contactHeight: 1,
		shiftKey: false,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		...overrides,
	};
}

export function toolClick(tool: Tool, x: number, y: number): void {
	tool.onPointerDown(ev(x, y), testViewport, testCanvasWidth, testCanvasHeight);
	tool.onPointerUp(ev(x, y), testViewport, testCanvasWidth, testCanvasHeight);
}

export function toolDrag(
	tool: Tool,
	x: number,
	y: number,
	toX: number,
	toY: number,
): void {
	tool.onPointerDown(ev(x, y), testViewport, testCanvasWidth, testCanvasHeight);
	tool.onPointerMove(
		ev(toX, toY),
		testViewport,
		testCanvasWidth,
		testCanvasHeight,
	);
	tool.onPointerUp(
		ev(toX, toY),
		testViewport,
		testCanvasWidth,
		testCanvasHeight,
	);
}
