import type { Viewport } from "../schema";

export interface PointerEventData {
	x: number; // screen coordinates
	y: number;
	pressure: number; // 0.0~1.0
	tiltX: number; // -90~90 degrees
	tiltY: number;
	/** Pen barrel rotation (PointerEvent.twist, 0-359 degrees; 0 without hardware support). */
	twist: number;
	pointerType: "mouse" | "pen" | "touch";
	button: number;
	contactWidth: number; // PointerEvent.width (contact geometry in CSS pixels)
	contactHeight: number; // PointerEvent.height (contact geometry in CSS pixels)
	shiftKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	metaKey: boolean;
}

export interface WheelEventData {
	x: number; // screen coordinates
	y: number;
	deltaY: number;
	ctrlKey: boolean;
}

export interface TouchGestureEventData {
	phase: "start" | "update" | "end";
	/** Two-finger centroid (screen px, canvas-relative). */
	centerX: number;
	centerY: number;
	/** Centroid movement since the gesture start (screen px). */
	deltaX: number;
	deltaY: number;
	/** Finger-distance ratio since the gesture start (pinch scale). */
	scale: number;
}

export interface Tool {
	readonly name: string;

	/**
	 * Called when pointer is pressed down
	 */
	onPointerDown(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void;

	/**
	 * Called when pointer moves (only while pressed)
	 */
	onPointerMove(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void;

	/**
	 * Called when pointer is released
	 */
	onPointerUp(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void;

	/**
	 * Called when pointer is double-clicked
	 */
	onDoubleClick?(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void;

	/**
	 * Called when the tool operation should be cancelled (e.g., Escape key)
	 */
	onCancel(): void;

	/**
	 * Returns the CSS cursor string for this tool
	 */
	getCursor(): string;

	/**
	 * Called when a key is pressed.
	 * Returns true if the tool handled the event (prevents default behavior).
	 */
	onKeyDown?(
		event: KeyboardEvent,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): boolean;

	/**
	 * Called on wheel input before the default canvas zoom / pan handling.
	 * Returns true if the tool consumed the event (e.g. 3D camera dolly).
	 */
	onWheel?(
		event: WheelEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): boolean;

	/**
	 * Called when a two-finger touch gesture is promoted, before the default
	 * canvas pan/zoom handling. Returning true from the "start" phase claims
	 * the gesture (e.g. 3D camera pan/dolly); "update"/"end" phases follow
	 * only for a claimed gesture.
	 */
	onTouchGesture?(
		event: TouchGestureEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): boolean;

	/**
	 * Save tool-internal state that should be restored if the current
	 * pointer-down operation is interrupted by a multi-finger gesture.
	 */
	saveInterruptibleState?(): unknown;

	/**
	 * Restore state previously saved by saveInterruptibleState.
	 */
	restoreFromInterrupt?(state: unknown): void;

	/**
	 * Called externally when UI overlay should be refreshed from current state.
	 */
	refreshUI?(): void;

	/**
	 * Called when a tool is disposed.
	 * TODO: Requiring
	 */
	dispose?(): void;
}
