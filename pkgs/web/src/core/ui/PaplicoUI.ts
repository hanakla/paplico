import {
	PAPLICO_MAX_ZOOM_SCALE,
	PAPLICO_MIN_ZOOM_SCALE,
} from "../document/constants";
import { Clipboard, PAPLICO_ELEMENTS_MIME } from "../infra/Clipboard";
import {
	defaultShortcutCommands as Cmds,
	type PaplicoShortcuts,
} from "../PaplicoShortcuts";
import { UI_THEME } from "../renderer/ui/theme";
import type { EraserToolUIData, ToolCursorUIData } from "../renderer/ui/types";
import type { AnyArtObject, BoundingBox, RawRGBA, Viewport } from "../schema";
import { PenTool } from "../tools/PenTool";
import type { PointerEventData, Tool } from "../tools/Tool";
import type { ShapeType } from "../tools/toolSettings";
import { Emitter } from "../utils/emitter";
import { screenToWorld } from "../utils/geometry/geometry";
import { matchKey } from "../utils/keyboard";

interface PaplicoUICallbacks {
	getViewport: () => Viewport;
	setViewport: (viewport: Partial<Viewport>) => void;
	getCanvasSize: () => { width: number; height: number };
	getTool: () => Tool | null;
	isDrawing: () => boolean;
	setDrawing: (drawing: boolean) => void;
	setActiveTarget: () => void;
	requestRender: () => void;

	// Tool-specific
	getCurrentTool: () => string;
	getToolWidth: () => number;
	setToolWidth: (width: number) => void;
	getToolColor: () => RawRGBA;
	setShapeType: (shapeType: ShapeType) => void;
	/** Optional pressure remap applied to pen/touch input (mouse is kept raw) */
	transformPressure?: (pressure: number) => number;
	/**
	 * Multiplier on the touch contact width by which finger input is lifted
	 * above the contact point while drawing (0 = draw at the contact point).
	 */
	getTouchDrawOffsetScale?: () => number;

	// Yjs
	updateCursor?: (x: number, y: number) => void;
	clearCursor?: () => void;

	// Shortcut filter
	filterShortcutEvents?: (event: KeyboardEvent) => false | undefined;

	// For gesture-based object resize
	getSelectedElementIds?: () => string[];
	getSelectionBounds?: () => BoundingBox | null;

	// Restore element selection after gesture interrupt
	restoreSelection?: (ids: string[], bounds: BoundingBox | null) => void;

	// For multi-finger tap undo/redo
	getCommands?: () => { undo: () => void; redo: () => void };

	getShortcuts?: () => PaplicoShortcuts | null;

	// When true, the active tool manages its own focus target (e.g. text
	// editing textarea). Canvas.focus() is suppressed in pointerdown, and
	// keydown from the tool's element passes through to the shortcut dispatcher.
	isToolManagingFocus?: () => boolean;
}

type PaplicoUIEvents = {
	toolCursorUpdate: ToolCursorUIData | null;
	eraserToolUpdate: EraserToolUIData | null;
	fileDrop: Array<{
		file: File;
		worldX: number;
		worldY: number;
	}>;
	doubleClick: { event: PointerEventData; rect: DOMRect };
	paste: {
		worldX: number;
		worldY: number;
		data:
			| { type: "text"; text: string }
			| { type: "imagefile"; file: File }
			| { type: "svg"; svg: string; fallbackImageFile?: File }
			| { type: "artobject"; elements: AnyArtObject[] };
	};
};

// --- Gesture State (discriminated union) ---

type Point = { x: number; y: number };

type GestureIdle = { type: "idle" };

type GestureTooling = {
	type: "tooling";
	pointerId: number;
};

type GesturePan = {
	type: "pan";
	start: Point;
	startViewport: { x: number; y: number; zoom: number; rotation: number };
};

type GestureToolSize = {
	type: "tool-size";
	pointerId: number;
	start: Point;
	startWidth: number;
};

type GesturePendingTap = {
	type: "pending-tap";
	startTime: number;
	fingerCount: number;
	startPositions: Map<number, Point>;
};

type GestureViewport = {
	type: "viewport";
	intent: "pan-zoom" | "rotation" | null;
	startAngle: number;
	startDistance: number;
	startZoom: number;
	startRotation: number;
	startViewport: Viewport;
	centerWorld: Point;
	centerScreen: Point;
	// Intent detection sampling
	sampleCount: number;
	sampleAngleSum: number;
	sampleCenterSum: number;
	sampleZoomSum: number;
	prevAngle: number;
	prevCenter: Point;
	prevDistance: number;
};

type GestureObjectResize = {
	type: "object-resize";
	startDistance: number;
	startCenter: Point;
	startBounds: BoundingBox | null;
};

/** Two-finger gesture claimed by the active tool (Tool.onTouchGesture). */
type GestureToolGesture = {
	type: "tool-gesture";
	startDistance: number;
	startCenter: Point;
};

type GestureSafariTrackpad = {
	type: "safari-trackpad";
	startRotation: number;
	startZoom: number;
	cursorWorld: Point;
	cursorScreen: Point;
};

type GestureState =
	| GestureIdle
	| GestureTooling
	| GesturePan
	| GestureToolSize
	| GesturePendingTap
	| GestureViewport
	| GestureObjectResize
	| GestureToolGesture
	| GestureSafariTrackpad;

const MULTI_FINGER_TAP_THRESHOLD = 300; // ms
const TAP_MOVE_THRESHOLD = 10; // px
const MAX_CONTACT_SIZE_PX = 100; // palm rejection threshold (CSS pixels)
const TOUCH_DRAW_OFFSET_BASE_PX = 60; // touch draw offset at scale 1 (CSS pixels)

/**
 * PaplicoUI - Handles all canvas input events
 * Manages pointer, keyboard, wheel, and drag & drop interactions
 */
export class PaplicoUI extends Emitter<PaplicoUIEvents> {
	private canvas: HTMLCanvasElement;
	private callbacks: PaplicoUICallbacks;

	private unlistenAbortController: AbortController | null = null;

	private isSpaceKeyDown = false;
	private canvasFocused = false;

	// Virtual modifier keys (for touch device overlay buttons)
	private _virtualShiftKey = false;

	// Pointer tracking
	private activePointers = new Map<number, Point>();
	private activePenPointerId: number | null = null;
	private rejectedPointers = new Set<number>();

	// Snapshot of selection state taken before tool.onPointerDown,
	// used to restore selection when a multi-finger gesture interrupts tooling.
	private preToolingSnapshot: {
		selectedIds: string[];
		selectionBounds: BoundingBox | null;
		toolState: unknown;
	} | null = null;

	// Gesture state (single object replaces all gesture-related properties)
	private gesture: GestureState = { type: "idle" };

	// Double-click detection
	private lastClickTime = 0;
	private lastClickX = 0;
	private lastClickY = 0;
	private lastCursorWorldPos: Point | null = null;
	private readonly DOUBLE_CLICK_THRESHOLD = 300; // ms
	private readonly DOUBLE_CLICK_DISTANCE = 5; // px

	// Bound event handlers (for cleanup)
	private boundHandlers: {
		pointerDown: (e: PointerEvent) => void;
		pointerMove: (e: PointerEvent) => void;
		pointerUp: (e: PointerEvent) => void;
		pointerCancel: (e: PointerEvent) => void;
		pointerLeave: (e: PointerEvent) => void;
		wheel: (e: WheelEvent) => void;
		keyDown: (e: KeyboardEvent) => void;
		keyUp: (e: KeyboardEvent) => void;
		dragOver: (e: DragEvent) => void;
		drop: (e: DragEvent) => void;
		paste: (e: ClipboardEvent) => void;
		gestureStart: ((e: Event) => void) | null;
		gestureChange: ((e: Event) => void) | null;
		gestureEnd: ((e: Event) => void) | null;
	};

	public constructor(canvas: HTMLCanvasElement, callbacks: PaplicoUICallbacks) {
		super();
		this.canvas = canvas;
		this.callbacks = callbacks;

		// Bind handlers
		// GestureEvent is only used for macOS trackpad (where PointerEvent gives 1 pointer).
		// On touch devices (iPad), PointerEvent gives 2 pointers so we use that instead.
		// Registering both causes them to compete and corrupt the viewport.
		const supportsGestureEvent =
			typeof globalThis !== "undefined" &&
			"GestureEvent" in globalThis &&
			!("ontouchstart" in globalThis);

		this.boundHandlers = {
			pointerDown: this.handlePointerDown.bind(this),
			pointerMove: this.handlePointerMove.bind(this),
			pointerUp: this.handlePointerUp.bind(this),
			pointerCancel: this.handlePointerCancel.bind(this),
			pointerLeave: this.handlePointerLeave.bind(this),
			wheel: this.handleWheel.bind(this),
			keyDown: this.handleKeyDown.bind(this),
			keyUp: this.handleKeyUp.bind(this),
			dragOver: this.handleDragOver.bind(this),
			drop: this.handleDrop.bind(this),
			paste: this.handlePaste.bind(this),
			gestureStart: supportsGestureEvent
				? this.handleGestureStart.bind(this)
				: null,
			gestureChange: supportsGestureEvent
				? this.handleGestureChange.bind(this)
				: null,
			gestureEnd: supportsGestureEvent
				? this.handleGestureEnd.bind(this)
				: null,
		};

		this.setupEventListeners();
	}

	/**
	 * Setup all event listeners
	 */
	private setupEventListeners(): void {
		this.unlistenAbortController = new AbortController();
		const signal = this.unlistenAbortController.signal;

		// Canvas touch behavior and focus model
		this.canvas.style.touchAction = "none";
		this.canvas.style.outline = "none";
		this.canvas.tabIndex = 0;

		// Track canvas focus via browser native focus events
		this.canvas.addEventListener("focus", () => this.setCanvasFocused(true), {
			signal,
		});
		this.canvas.addEventListener("blur", () => this.setCanvasFocused(false), {
			signal,
		});

		// Pointer events
		this.canvas.addEventListener(
			"pointerdown",
			this.boundHandlers.pointerDown,
			{ signal },
		);
		this.canvas.addEventListener(
			"pointermove",
			this.boundHandlers.pointerMove,
			{ signal },
		);
		this.canvas.addEventListener("pointerup", this.boundHandlers.pointerUp, {
			signal,
		});
		this.canvas.addEventListener(
			"pointercancel",
			this.boundHandlers.pointerCancel,
			{ signal },
		);
		this.canvas.addEventListener(
			"pointerleave",
			this.boundHandlers.pointerLeave,
			{ signal },
		);

		// Wheel event (passive: false for Safari)
		this.canvas.addEventListener("wheel", this.boundHandlers.wheel, {
			passive: false,
			signal,
		});

		// Keyboard events (on window)
		window.addEventListener("keydown", this.boundHandlers.keyDown, { signal });
		window.addEventListener("keyup", this.boundHandlers.keyUp, { signal });

		// Drag & drop
		this.canvas.addEventListener("dragover", this.boundHandlers.dragOver, {
			signal,
		});
		this.canvas.addEventListener("drop", this.boundHandlers.drop, { signal });

		// Clipboard paste
		window.addEventListener("paste", this.boundHandlers.paste, { signal });

		// Safari GestureEvent (macOS trackpad rotation)
		if (this.boundHandlers.gestureStart) {
			this.canvas.addEventListener(
				"gesturestart",
				this.boundHandlers.gestureStart,
				{ signal },
			);
			if (this.boundHandlers.gestureChange) {
				this.canvas.addEventListener(
					"gesturechange",
					this.boundHandlers.gestureChange,
					{ signal },
				);
			}
			if (this.boundHandlers.gestureEnd) {
				this.canvas.addEventListener(
					"gestureend",
					this.boundHandlers.gestureEnd,
					{ signal },
				);
			}
		}
	}

	public setVirtualShiftKey(pressed: boolean): void {
		this._virtualShiftKey = pressed;
	}

	/** Re-emit toolCursorUpdate with the last known cursor position */
	/**
	 * Hand keyboard focus back to the canvas.
	 *
	 * Clicking a control in the surrounding UI takes focus off the canvas, and
	 * every canvas keybinding is gated on `canvasFocused` — so a button that puts
	 * the canvas into a mode leaves the user unable to leave that mode by keyboard
	 * until they click the canvas. Whatever starts such a mode calls this.
	 */
	public focusCanvas(): void {
		this.canvas.focus({ preventScroll: true });
	}

	public refreshToolCursor(): void {
		if (this.lastCursorWorldPos) {
			this.updateToolCursor(this.lastCursorWorldPos);
		}
	}

	/**
	 * Cleanup all event listeners
	 */
	public destroy(): void {
		this.unlistenAbortController?.abort();
	}

	// --- Pointer Events ---

	private handlePointerDown(e: PointerEvent): void {
		this.callbacks.setActiveTarget();

		// Skip canvas focus when an overlay element owns focus (e.g. text
		// editing textarea), so iOS does not dismiss/re-show the keyboard.
		if (!this.callbacks.isToolManagingFocus?.()) {
			this.canvas.focus({ preventScroll: true });
		}

		const tool = this.callbacks.getTool();
		if (!tool) return;

		const rect = this.canvas.getBoundingClientRect();
		const viewport = this.callbacks.getViewport();

		// --- Palm rejection ---
		if (e.pointerType === "pen") {
			this.activePenPointerId = e.pointerId;
		}

		if (
			e.pointerType === "touch" &&
			(this.activePenPointerId !== null ||
				e.width > MAX_CONTACT_SIZE_PX ||
				e.height > MAX_CONTACT_SIZE_PX)
		) {
			this.rejectedPointers.add(e.pointerId);
			e.preventDefault();
			return;
		}

		// Pen arrived while touch-based tooling is active → cancel touch, switch to pen
		if (
			e.pointerType === "pen" &&
			this.gesture.type === "tooling" &&
			this.gesture.pointerId !== e.pointerId
		) {
			tool.onCancel();
			this.callbacks.setDrawing(false);
			this.restorePreToolingSnapshot(tool);
			this.rejectedPointers.add(this.gesture.pointerId);
			this.activePointers.delete(this.gesture.pointerId);
			this.gesture = { type: "idle" };
		}

		// Track active pointers for multi-touch gesture detection
		this.activePointers.set(e.pointerId, {
			x: e.clientX - rect.left,
			y: e.clientY - rect.top,
		});

		// Two-finger detected: enter pending-tap state (defer gesture until movement)
		if (
			this.activePointers.size === 2 &&
			(this.gesture.type === "idle" || this.gesture.type === "tooling")
		) {
			// Cancel any in-progress tool operation from the first finger
			// and restore selection that onPointerDown may have cleared.
			if (this.gesture.type === "tooling") {
				tool.onCancel();
				this.callbacks.setDrawing(false);
				this.restorePreToolingSnapshot(tool);
			}

			this.gesture = {
				type: "pending-tap",
				startTime: Date.now(),
				fingerCount: 2,
				startPositions: new Map(this.activePointers),
			};
			e.preventDefault();
			return;
		}

		// Three+ fingers during pending-tap: update finger count
		if (this.activePointers.size > 2 && this.gesture.type === "pending-tap") {
			this.gesture.fingerCount = this.activePointers.size;
			e.preventDefault();
			return;
		}

		// If already in active gesture, ignore additional pointers
		if (
			this.gesture.type === "viewport" ||
			this.gesture.type === "object-resize" ||
			this.gesture.type === "tool-gesture"
		) {
			e.preventDefault();
			return;
		}

		// Check if panning (middle button or space key)
		const shouldPan = e.button === 1 || this.isSpaceKeyDown;

		if (shouldPan) {
			this.gesture = {
				type: "pan",
				start: { x: e.clientX - rect.left, y: e.clientY - rect.top },
				startViewport: {
					x: viewport.x,
					y: viewport.y,
					zoom: viewport.zoom,
					rotation: viewport.rotation ?? 0,
				},
			};
			this.canvas.style.cursor = "grabbing";
			e.preventDefault();
			return;
		}

		if (
			e.button === 0 &&
			e.altKey &&
			(tool.name === "pen" || tool.name === "eraser")
		) {
			this.gesture = {
				type: "tool-size",
				pointerId: e.pointerId,
				start: { x: e.clientX - rect.left, y: e.clientY - rect.top },
				startWidth: this.callbacks.getToolWidth(),
			};
			try {
				this.canvas.setPointerCapture(e.pointerId);
			} catch {
				// Ignore pointer capture errors
			}
			e.preventDefault();
			return;
		}

		// Double-click detection
		const now = Date.now();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;
		const timeDiff = now - this.lastClickTime;
		const distSq = (x - this.lastClickX) ** 2 + (y - this.lastClickY) ** 2;

		if (
			timeDiff < this.DOUBLE_CLICK_THRESHOLD &&
			distSq < this.DOUBLE_CLICK_DISTANCE ** 2
		) {
			// Double-click detected
			const eventData = this.createPointerEventData(e, rect);
			if (tool.onDoubleClick) {
				tool.onDoubleClick(eventData, viewport, rect.width, rect.height);
			}
			this.emit("doubleClick", { event: eventData, rect });
			this.lastClickTime = 0; // Reset to prevent triple-click
			return;
		}

		this.lastClickTime = now;
		this.lastClickX = x;
		this.lastClickY = y;

		// Save selection state before tool processes the pointer-down.
		// If a second finger arrives (gesture interrupt), we restore this snapshot.
		this.preToolingSnapshot = {
			selectedIds: [...(this.callbacks.getSelectedElementIds?.() ?? [])],
			selectionBounds: this.callbacks.getSelectionBounds?.() ?? null,
			toolState: tool.saveInterruptibleState?.(),
		};

		this.gesture = { type: "tooling", pointerId: e.pointerId };
		this.callbacks.setDrawing(true);
		try {
			this.canvas.setPointerCapture(e.pointerId);
		} catch {
			// Ignore pointer capture errors
		}

		const eventData = this.createPointerEventData(e, rect);
		// Touch sends no hover moves before the press, so without this the
		// cursor would only appear once the finger has started moving.
		this.updateToolCursor(
			screenToWorld(
				eventData.x,
				eventData.y,
				viewport,
				rect.width,
				rect.height,
			),
		);
		tool.onPointerDown(eventData, viewport, rect.width, rect.height);
	}

	private handlePointerMove(e: PointerEvent): void {
		if (this.rejectedPointers.has(e.pointerId)) {
			e.preventDefault();
			return;
		}

		this.callbacks.setActiveTarget();
		const tool = this.callbacks.getTool();
		if (!tool) return;

		const rect = this.canvas.getBoundingClientRect();
		const viewport = this.callbacks.getViewport();

		// Update active pointer position (also register missed pointerdown as fallback)
		if (this.activePointers.has(e.pointerId) || e.pressure > 0) {
			this.activePointers.set(e.pointerId, {
				x: e.clientX - rect.left,
				y: e.clientY - rect.top,
			});
		}

		// Fallback: cancel tooling if multiple pointers detected in move
		// (covers cases where second pointerdown event was missed)
		if (this.gesture.type === "tooling" && this.activePointers.size >= 2) {
			tool.onCancel();
			this.callbacks.setDrawing(false);
			this.restorePreToolingSnapshot(tool);
			this.gesture = {
				type: "pending-tap",
				startTime: Date.now(),
				fingerCount: this.activePointers.size,
				startPositions: new Map(this.activePointers),
			};
		}

		// pending-tap → check if fingers moved enough to promote to gesture
		if (this.gesture.type === "pending-tap" && this.activePointers.size >= 2) {
			let moved = false;
			for (const [id, startPos] of this.gesture.startPositions) {
				const current = this.activePointers.get(id);
				if (
					current &&
					Math.hypot(current.x - startPos.x, current.y - startPos.y) >
						TAP_MOVE_THRESHOLD
				) {
					moved = true;
					break;
				}
			}

			if (moved) {
				this.promoteToActiveGesture(viewport, rect);
			}
		}

		// Handle active gestures
		if (this.gesture.type === "tool-gesture" && this.activePointers.size >= 2) {
			this.updateToolGesture(rect, viewport);
			return;
		}
		if (this.gesture.type === "viewport" && this.activePointers.size >= 2) {
			this.updateViewportGesture(rect);
			return;
		}
		if (
			this.gesture.type === "object-resize" &&
			this.activePointers.size >= 2
		) {
			this.updateObjectResizeGesture(rect);
			return;
		}

		// Handle panning (rotation-aware)
		if (this.gesture.type === "pan") {
			const g = this.gesture;
			const canvasX = e.clientX - rect.left;
			const canvasY = e.clientY - rect.top;

			// Update cursor position during pan
			const cursorWorld = screenToWorld(
				canvasX,
				canvasY,
				viewport,
				rect.width,
				rect.height,
			);
			this.callbacks.updateCursor?.(cursorWorld.x, cursorWorld.y);

			const worldStart = screenToWorld(
				g.start.x,
				g.start.y,
				g.startViewport,
				rect.width,
				rect.height,
			);
			const worldCurrent = screenToWorld(
				canvasX,
				canvasY,
				g.startViewport,
				rect.width,
				rect.height,
			);

			this.callbacks.setViewport({
				x: g.startViewport.x - (worldCurrent.x - worldStart.x),
				y: g.startViewport.y - (worldCurrent.y - worldStart.y),
			});
			return;
		}

		if (this.gesture.type === "tool-size") {
			if (this.gesture.pointerId !== e.pointerId) return;
			const delta =
				e.clientX -
				rect.left -
				this.gesture.start.x +
				(e.clientY - rect.top - this.gesture.start.y);
			this.callbacks.setToolWidth(
				this.gesture.startWidth + delta / this.callbacks.getViewport().zoom,
			);
		}

		const eventData = this.createPointerEventData(e, rect);

		// Calculate world position for cursor tracking
		const worldPos = screenToWorld(
			eventData.x,
			eventData.y,
			viewport,
			rect.width,
			rect.height,
		);

		// Update cursor position in awareness
		this.callbacks.updateCursor?.(worldPos.x, worldPos.y);

		// Update tool cursor UI
		const toolCursorWorldPos =
			this.gesture.type === "tool-size"
				? screenToWorld(
						this.gesture.start.x,
						this.gesture.start.y,
						viewport,
						rect.width,
						rect.height,
					)
				: worldPos;
		this.updateToolCursor(toolCursorWorldPos);

		// Allow onPointerMove for drawing tools AND interactive tools (select, path-edit, text)
		const isInteractiveTool =
			tool.name === "select" ||
			tool.name === "path-edit" ||
			tool.name === "path" ||
			tool.name === "text" ||
			tool.name === "gradient" ||
			tool.name === "reference3d" ||
			tool.name === "artboard";

		if (this.gesture.type === "tooling" || isInteractiveTool) {
			tool.onPointerMove(eventData, viewport, rect.width, rect.height);
			this.callbacks.requestRender();
		}

		// Update cursor from tool (e.g., rotation zone, resize handle hover)
		if (!this.isSpaceKeyDown) {
			this.canvas.style.cursor = tool.getCursor();
		}
	}

	private handlePointerUp(e: PointerEvent): void {
		if (this.rejectedPointers.has(e.pointerId)) {
			this.rejectedPointers.delete(e.pointerId);
			return;
		}
		if (e.pointerType === "pen") {
			this.activePenPointerId = null;
		}

		this.callbacks.setActiveTarget();
		// Remove from active pointer tracking
		this.activePointers.delete(e.pointerId);

		// pending-tap: check if this completes a multi-finger tap
		if (this.gesture.type === "pending-tap" && this.activePointers.size === 0) {
			const elapsed = Date.now() - this.gesture.startTime;
			if (elapsed < MULTI_FINGER_TAP_THRESHOLD) {
				this.handleMultiFingerTap(this.gesture.fingerCount);
				this.gesture = { type: "idle" };
				return;
			}

			this.gesture = { type: "idle" };
		}

		// End active gesture when fewer than 2 pointers remain
		if (
			(this.gesture.type === "viewport" ||
				this.gesture.type === "object-resize" ||
				this.gesture.type === "tool-gesture") &&
			this.activePointers.size < 2
		) {
			if (this.gesture.type === "tool-gesture") {
				this.endToolGesture();
			}
			if (this.gesture.type === "object-resize") {
				const tool = this.callbacks.getTool();
				if (tool && "finalizePinchResize" in tool) {
					(tool as any).finalizePinchResize();
				}
			}

			this.gesture = { type: "idle" };
			this.canvas.style.cursor = this.isSpaceKeyDown ? "grab" : "default";
			return;
		}

		// End panning
		if (this.gesture.type === "pan") {
			this.gesture = { type: "idle" };
			this.canvas.style.cursor = this.isSpaceKeyDown ? "grab" : "default";
			return;
		}

		if (this.gesture.type === "tool-size") {
			this.endToolSizeGesture(e.pointerId);
			return;
		}

		const tool = this.callbacks.getTool();
		if (!tool) return;

		// For select and path-edit tools, always call onPointerUp
		// These tools have internal state tracking (e.g., draggedHandle)
		const isSelectOrPathEdit =
			tool.name === "select" ||
			tool.name === "path-edit" ||
			tool.name === "gradient";

		if (this.gesture.type !== "tooling" && !isSelectOrPathEdit) return;

		if (this.gesture.type === "tooling") {
			this.callbacks.setDrawing(false);
			this.preToolingSnapshot = null;
			try {
				this.canvas.releasePointerCapture(this.gesture.pointerId);
			} catch {
				// Ignore pointer capture errors
			}
			this.gesture = { type: "idle" };
		}

		const rect = this.canvas.getBoundingClientRect();
		const viewport = this.callbacks.getViewport();
		const eventData = this.createPointerEventData(e, rect);

		tool.onPointerUp(eventData, viewport, rect.width, rect.height);
	}

	private handlePointerCancel(e: PointerEvent): void {
		if (this.rejectedPointers.has(e.pointerId)) {
			this.rejectedPointers.delete(e.pointerId);
			return;
		}
		if (e.pointerType === "pen") {
			this.activePenPointerId = null;
		}

		this.activePointers.delete(e.pointerId);

		if (this.gesture.type === "tool-size") {
			this.endToolSizeGesture(e.pointerId);
		}

		if (this.gesture.type === "tooling") {
			this.callbacks.setDrawing(false);
			this.gesture = { type: "idle" };

			const tool = this.callbacks.getTool();
			tool?.onCancel();
		}

		if (this.gesture.type === "tool-gesture") {
			this.endToolGesture();
			this.gesture = { type: "idle" };
			this.canvas.style.cursor = "default";
		}

		if (
			this.gesture.type === "viewport" ||
			this.gesture.type === "object-resize" ||
			this.gesture.type === "pending-tap"
		) {
			this.gesture = { type: "idle" };
			this.canvas.style.cursor = "default";
		}

		this.callbacks.clearCursor?.();
		this.emit("toolCursorUpdate", null);
		this.emit("eraserToolUpdate", null);
	}

	private endToolSizeGesture(pointerId: number): void {
		if (
			this.gesture.type !== "tool-size" ||
			this.gesture.pointerId !== pointerId
		)
			return;

		try {
			this.canvas.releasePointerCapture(pointerId);
		} catch {
			// Ignore pointer capture errors
		}
		this.gesture = { type: "idle" };
	}

	private setCanvasFocused(value: boolean): void {
		if (this.canvasFocused === value) return;
		this.canvasFocused = value;
		this.callbacks.getShortcuts?.()?.setContext("canvasFocused", value);
	}

	private handlePointerLeave(e: PointerEvent): void {
		this.activePointers.delete(e.pointerId);

		if (e.pointerType === "pen" && this.activePenPointerId === e.pointerId) {
			this.activePenPointerId = null;
		}

		this.rejectedPointers.delete(e.pointerId);

		if (this.gesture.type === "tool-size") {
			this.endToolSizeGesture(e.pointerId);
		}

		// If pointerleave fires during tooling, it means pointer capture is not
		// active (capture keeps the pointer logically inside the element).
		// End the stroke via onPointerUp as a fallback so the tool doesn't get stuck.
		if (this.gesture.type === "tooling") {
			this.callbacks.setDrawing(false);
			this.gesture = { type: "idle" };

			const tool = this.callbacks.getTool();
			if (tool) {
				const rect = this.canvas.getBoundingClientRect();
				const viewport = this.callbacks.getViewport();
				const eventData = this.createPointerEventData(e, rect);
				tool.onPointerUp(eventData, viewport, rect.width, rect.height);
			}
		}

		if (
			(this.gesture.type === "viewport" ||
				this.gesture.type === "object-resize" ||
				this.gesture.type === "tool-gesture") &&
			this.activePointers.size < 2
		) {
			if (this.gesture.type === "tool-gesture") {
				this.endToolGesture();
			}
			this.gesture = { type: "idle" };
			this.canvas.style.cursor = "default";
		}

		if (this.gesture.type === "pending-tap" && this.activePointers.size === 0) {
			this.gesture = { type: "idle" };
		}

		// Clear cursor
		this.callbacks.clearCursor?.();
		this.emit("toolCursorUpdate", null);
		this.emit("eraserToolUpdate", null);
	}

	private createPointerEventData(
		e: PointerEvent,
		rect: DOMRect,
	): PointerEventData {
		// Mouse reports a constant pressure (0.5 while pressed), so the pressure
		// curve applies to pen/touch input only.
		const pressure =
			e.pointerType !== "mouse" && this.callbacks.transformPressure
				? this.callbacks.transformPressure(e.pressure)
				: e.pressure;

		return {
			x: e.clientX - rect.left,
			y: e.clientY - rect.top - this.touchDrawOffsetY(e),
			pressure,
			tiltX: e.tiltX,
			tiltY: e.tiltY,
			pointerType: e.pointerType as "mouse" | "pen" | "touch",
			button: e.button,
			contactWidth: e.width,
			contactHeight: e.height,
			shiftKey: e.shiftKey || this._virtualShiftKey,
			ctrlKey: e.ctrlKey,
			altKey: e.altKey,
			metaKey: e.metaKey,
		};
	}

	/**
	 * Distance (CSS px) by which finger input is lifted above the contact point.
	 * A fingertip hides what it touches, so the drawing tools apply the stroke
	 * (and show their cursor) above the finger. The lift is a fixed base scaled
	 * by the user setting — never derived from the live contact ellipse, whose
	 * measurement settles only after the stroke has started and would make the
	 * stroke head drift upward.
	 */
	private touchDrawOffsetY(e: PointerEvent): number {
		if (e.pointerType !== "touch") return 0;

		const currentTool = this.callbacks.getCurrentTool();
		if (currentTool !== "pen" && currentTool !== "eraser") return 0;

		return (
			TOUCH_DRAW_OFFSET_BASE_PX *
			(this.callbacks.getTouchDrawOffsetScale?.() ?? 0)
		);
	}

	// --- Gesture Logic ---

	/** Promote pending-tap to an active gesture (viewport or object-resize) */
	private promoteToActiveGesture(viewport: Viewport, rect: DOMRect): void {
		const pointers = [...this.activePointers.values()];
		const [p0, p1] = pointers;

		const dx = p1.x - p0.x;
		const dy = p1.y - p0.y;
		const distance = Math.hypot(dx, dy);
		const centerScreenX = (p0.x + p1.x) / 2;
		const centerScreenY = (p0.y + p1.y) / 2;
		const centerWorld = screenToWorld(
			centerScreenX,
			centerScreenY,
			viewport,
			rect.width,
			rect.height,
		);

		// Tools get first shot at the two-finger gesture (e.g. Reference3D camera
		// pan/dolly inside the edited scene) — mirrors the onWheel priority.
		const tool = this.callbacks.getTool();
		if (
			tool?.onTouchGesture?.(
				{
					phase: "start",
					centerX: centerScreenX,
					centerY: centerScreenY,
					deltaX: 0,
					deltaY: 0,
					scale: 1,
				},
				viewport,
				rect.width,
				rect.height,
			)
		) {
			this.gesture = {
				type: "tool-gesture",
				startDistance: distance,
				startCenter: { x: centerScreenX, y: centerScreenY },
			};
			return;
		}

		// Check if we have selected elements AND all pointers are inside the selection bbox
		const selectionBounds = this.callbacks.getSelectionBounds?.() ?? null;
		const hasSelection =
			tool?.name === "select" &&
			(this.callbacks.getSelectedElementIds?.().length ?? 0) > 0 &&
			selectionBounds != null &&
			pointers.every((ptr) => {
				const w = screenToWorld(
					ptr.x,
					ptr.y,
					viewport,
					rect.width,
					rect.height,
				);
				return (
					w.x >= selectionBounds.minX &&
					w.x <= selectionBounds.maxX &&
					w.y >= selectionBounds.minY &&
					w.y <= selectionBounds.maxY
				);
			});

		if (hasSelection) {
			this.gesture = {
				type: "object-resize",
				startDistance: distance,
				startCenter: centerWorld,
				startBounds: selectionBounds,
			};
		} else {
			this.gesture = {
				type: "viewport",
				intent: null,
				startAngle: Math.atan2(dy, dx),
				startDistance: distance,
				startZoom: viewport.zoom,
				startRotation: viewport.rotation ?? 0,
				startViewport: {
					x: viewport.x,
					y: viewport.y,
					zoom: viewport.zoom,
					rotation: viewport.rotation ?? 0,
				},
				centerWorld,
				centerScreen: { x: centerScreenX, y: centerScreenY },
				sampleCount: 0,
				sampleAngleSum: 0,
				sampleCenterSum: 0,
				sampleZoomSum: 0,
				prevAngle: Math.atan2(dy, dx),
				prevCenter: { x: centerScreenX, y: centerScreenY },
				prevDistance: distance,
			};
		}

		this.canvas.style.cursor = "grabbing";
	}

	private handleMultiFingerTap(fingerCount: number): void {
		if (fingerCount === 2) {
			this.callbacks.getCommands?.().undo();
		} else if (fingerCount === 3) {
			this.callbacks.getCommands?.().redo();
		}
	}

	/** Restore selection state that was saved before tool.onPointerDown. */
	private restorePreToolingSnapshot(tool: Tool): void {
		if (!this.preToolingSnapshot) return;
		const snap = this.preToolingSnapshot;
		this.preToolingSnapshot = null;
		if (snap.selectedIds.length > 0) {
			this.callbacks.restoreSelection?.(snap.selectedIds, snap.selectionBounds);
		}
		tool.restoreFromInterrupt?.(snap.toolState);
	}

	private updateToolCursor(worldPos: Point): void {
		this.lastCursorWorldPos = worldPos;
		const currentTool = this.callbacks.getCurrentTool();

		if (currentTool === "pen") {
			const color = this.callbacks.getToolColor();
			const tool = this.callbacks.getTool();
			const isLongPicking = tool instanceof PenTool && tool.isLongPicking;

			const picked = isLongPicking ? (tool as PenTool).pickedColor : null;
			this.emit("toolCursorUpdate", {
				worldX: worldPos.x,
				worldY: worldPos.y,
				radius: isLongPicking ? 0 : this.callbacks.getToolWidth() / 2,
				color: [color.r, color.g, color.b, isLongPicking ? 0 : 0.8],
				pickedColor: picked ? [picked.r, picked.g, picked.b, 1.0] : undefined,
			});
			this.callbacks.requestRender();
		} else if (currentTool === "eraser") {
			const eraserRadius = this.callbacks.getToolWidth() / 2;
			this.emit("toolCursorUpdate", null);
			this.emit("eraserToolUpdate", {
				worldX: worldPos.x,
				worldY: worldPos.y,
				radius: eraserRadius,
				color: UI_THEME.colors.eraserCursor,
			});
			this.callbacks.requestRender();
		} else {
			this.emit("toolCursorUpdate", null);
			this.emit("eraserToolUpdate", null);
		}
	}

	// --- Wheel Events ---

	private handleWheel(e: WheelEvent): void {
		e.preventDefault();

		const rect = this.canvas.getBoundingClientRect();
		const canvasWidth = rect.width;
		const canvasHeight = rect.height;

		const screenX = e.clientX - rect.left;
		const screenY = e.clientY - rect.top;

		const viewport = this.callbacks.getViewport();

		// Tools may consume wheel input first (e.g. Reference3D camera dolly).
		const tool = this.callbacks.getTool();
		if (
			tool?.onWheel?.(
				{ x: screenX, y: screenY, deltaY: e.deltaY, ctrlKey: e.ctrlKey },
				viewport,
				canvasWidth,
				canvasHeight,
			)
		) {
			return;
		}

		// macOS: ctrlKey is true for pinch zoom, false for 2-finger scroll
		if (e.ctrlKey) {
			// Zoom (pinch gesture on macOS) — rotation-aware
			const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
			const newZoom = Math.max(
				PAPLICO_MIN_ZOOM_SCALE,
				Math.min(PAPLICO_MAX_ZOOM_SCALE, viewport.zoom * zoomFactor),
			);

			// Use screenToWorld (rotation-aware) to find world position under cursor
			const worldPos = screenToWorld(
				screenX,
				screenY,
				viewport,
				canvasWidth,
				canvasHeight,
			);

			// Solve for new viewport center so that worldPos stays under cursor
			const relX = screenX - canvasWidth / 2;
			const relY = screenY - canvasHeight / 2;
			const cos = Math.cos(-viewport.rotation);
			const sin = Math.sin(-viewport.rotation);
			const unrotX = relX * cos - relY * sin;
			const unrotY = relX * sin + relY * cos;

			this.callbacks.setViewport({
				x: worldPos.x - unrotX / newZoom,
				y: worldPos.y + unrotY / newZoom,
				zoom: newZoom,
			});
		} else {
			// Pan (2-finger scroll on macOS) — rotation-aware
			const cos = Math.cos(-viewport.rotation);
			const sin = Math.sin(-viewport.rotation);
			const dx = e.deltaX;
			const dy = e.deltaY;

			this.callbacks.setViewport({
				x: viewport.x + (dx * cos - dy * sin) / viewport.zoom,
				y: viewport.y - (dx * sin + dy * cos) / viewport.zoom,
			});
		}
	}

	// --- Keyboard Events ---

	private handleKeyDown(e: KeyboardEvent): void {
		// Ignore typing in input/textarea — unless the active tool manages
		// focus (isToolManagingFocus) and the key wasn't already consumed
		// (defaultPrevented), so app-level shortcuts (undo/redo) still work.
		if (
			e.target instanceof HTMLInputElement ||
			e.target instanceof HTMLTextAreaElement
		) {
			if (!this.callbacks.isToolManagingFocus?.() || e.defaultPrevented) {
				return;
			}
		}

		// Apply external shortcut filter
		if (this.callbacks.filterShortcutEvents?.(e) === false) {
			return;
		}

		// Tool key handlers require canvas focus (they operate on canvas state directly)
		if (this.canvasFocused) {
			const tool = this.callbacks.getTool();
			if (tool?.onKeyDown) {
				const rect = this.canvas.getBoundingClientRect();
				const viewport = this.callbacks.getViewport();
				const handled = tool.onKeyDown(e, viewport, rect.width, rect.height);
				if (handled) {
					e.preventDefault();
					this.callbacks.requestRender();
					return;
				}
			}
		}

		// During text editing, only allow undo/redo shortcuts
		if (this.callbacks.isToolManagingFocus?.()) {
			const shortcuts = this.callbacks.getShortcuts?.();
			if (
				!shortcuts?.matchesCommands(e, [
					Cmds["paplico.undo"],
					Cmds["paplico.redo"],
				])
			) {
				return;
			}
		}

		// Delegate to PaplicoShortcuts (individual bindings use `when` clauses for gating)
		const shortcuts = this.callbacks.getShortcuts?.();
		if (shortcuts?.handleKeyEvent(e)) {
			e.preventDefault();
			return;
		}

		// Space: pan mode
		if (matchKey(e, "Space") && !e.repeat) {
			this.isSpaceKeyDown = true;
			this.canvas.style.cursor =
				this.gesture.type === "pan" ? "grabbing" : "grab";
		}
	}

	private handleKeyUp(e: KeyboardEvent): void {
		if (e.code === "Space") {
			this.isSpaceKeyDown = false;
			if (this.gesture.type === "pan") {
				this.gesture = { type: "idle" };
			}
			this.canvas.style.cursor = "default";
		}
	}

	// --- Drag & Drop Events ---

	private handleDragOver(e: DragEvent): void {
		e.preventDefault();
		if (e.dataTransfer) {
			e.dataTransfer.dropEffect = "copy";
		}
	}

	private async handleDrop(e: DragEvent): Promise<void> {
		e.preventDefault();

		if (!e.dataTransfer) return;

		const rect = this.canvas.getBoundingClientRect();
		const screenX = e.clientX - rect.left;
		const screenY = e.clientY - rect.top;

		const viewport = this.callbacks.getViewport();
		const worldPos = screenToWorld(
			screenX,
			screenY,
			viewport,
			rect.width,
			rect.height,
		);

		const itemsArr = Array.from(e.dataTransfer.items);
		// Include image/svg+xml: handleFileDrop imports SVG as vector (and falls
		// back to rasterizing it if nothing could be parsed).
		const fileItem = itemsArr.find(
			(i) => i.kind === "file" && i.type.startsWith("image/"),
		);

		if (fileItem) {
			const file = fileItem.getAsFile();
			if (!file) return;
			this.emit("fileDrop", [{ file, worldX: worldPos.x, worldY: worldPos.y }]);
		}
	}

	// --- Clipboard Paste Events ---

	private async handlePaste(e: ClipboardEvent): Promise<void> {
		const clipboardData = e.clipboardData;
		if (!clipboardData) return;

		// Ignore if typing in input or textarea
		if (
			e.target instanceof HTMLInputElement ||
			e.target instanceof HTMLTextAreaElement
		) {
			return;
		}

		// Ignore if TextTool is in edit mode (handled by TextEditOverlay)
		const tool = this.callbacks.getTool();
		if (tool?.name === "text") {
			return;
		}

		const rect = this.canvas.getBoundingClientRect();
		const viewport = this.callbacks.getViewport();
		const worldPos = screenToWorld(
			rect.width / 2,
			rect.height / 2,
			viewport,
			rect.width,
			rect.height,
		);

		const data = await this.classifyClipboard(clipboardData);
		if (!data) return;

		this.emit("paste", {
			worldX: worldPos.x,
			worldY: worldPos.y,
			data,
		});
	}

	/**
	 * Resolve the clipboard contents into a single discriminated payload.
	 * Priority: PAPLICO elements → SVG → raster image → plain text.
	 */
	private async classifyClipboard(
		clipboardData: DataTransfer,
	): Promise<PaplicoUIEvents["paste"]["data"] | null> {
		// 1. Paplico elements (highest priority) — Async Clipboard API
		try {
			const items = await Clipboard.read();
			for (const item of items) {
				if (item.types.includes(PAPLICO_ELEMENTS_MIME)) {
					const blob = await item.getType(PAPLICO_ELEMENTS_MIME);
					const json = await blob.text();
					const elements = JSON.parse(json) as AnyArtObject[];
					if (Array.isArray(elements) && elements.length > 0) {
						return { type: "artobject", elements };
					}
				}
			}
		} catch {
			// Async Clipboard API not available or permission denied
		}

		// 2. SVG via Async Clipboard API
		try {
			const items = await Clipboard.read();
			for (const item of items) {
				if (item.types.includes("image/svg+xml")) {
					const blob = await item.getType("image/svg+xml");
					const svg = await blob.text();
					if (svg) return { type: "svg", svg };
				}
			}
		} catch {
			// Async Clipboard API not available or permission denied
		}

		// 3. Image file / text from DataTransfer
		const items = Array.from(clipboardData.items);
		const imgItem = items.find(
			(i) =>
				i.kind === "file" &&
				i.type !== "image/svg+xml" &&
				i.type.startsWith("image/"),
		);
		if (imgItem) {
			const file = imgItem.getAsFile();
			if (file) return { type: "imagefile", file };
		}

		const textItem = items.find(
			(i) => i.kind === "string" && i.type === "text/plain",
		);
		if (textItem) {
			const text = await new Promise<string>((r) => textItem.getAsString(r));
			if (text) return { type: "text", text };
		}

		return null;
	}

	// --- Multi-pointer Gesture ---

	/** Update viewport during two-finger gesture (pan+zoom or rotation) */
	/** Feed two-finger centroid / pinch updates to the gesture-owning tool. */
	private updateToolGesture(rect: DOMRect, viewport: Viewport): void {
		if (this.gesture.type !== "tool-gesture") return;
		const tool = this.callbacks.getTool();
		if (!tool?.onTouchGesture) return;

		const [p0, p1] = [...this.activePointers.values()];
		const centerX = (p0.x + p1.x) / 2;
		const centerY = (p0.y + p1.y) / 2;
		const distance = Math.max(Math.hypot(p1.x - p0.x, p1.y - p0.y), 1e-6);
		tool.onTouchGesture(
			{
				phase: "update",
				centerX,
				centerY,
				deltaX: centerX - this.gesture.startCenter.x,
				deltaY: centerY - this.gesture.startCenter.y,
				scale: distance / Math.max(this.gesture.startDistance, 1e-6),
			},
			viewport,
			rect.width,
			rect.height,
		);
		this.callbacks.requestRender();
	}

	/** Deliver the "end" phase of a claimed two-finger gesture. */
	private endToolGesture(): void {
		const tool = this.callbacks.getTool();
		if (!tool?.onTouchGesture) return;
		const rect = this.canvas.getBoundingClientRect();
		tool.onTouchGesture(
			{ phase: "end", centerX: 0, centerY: 0, deltaX: 0, deltaY: 0, scale: 1 },
			this.callbacks.getViewport(),
			rect.width,
			rect.height,
		);
	}

	private updateViewportGesture(rect: DOMRect): void {
		if (this.gesture.type !== "viewport") return;

		const pointers = [...this.activePointers.values()];
		if (pointers.length < 2) return;
		const [p0, p1] = pointers;

		const dx = p1.x - p0.x;
		const dy = p1.y - p0.y;
		const currentAngle = Math.atan2(dy, dx);
		const currentDistance = Math.hypot(dx, dy);
		const centerScreenX = (p0.x + p1.x) / 2;
		const centerScreenY = (p0.y + p1.y) / 2;

		const g = this.gesture;

		const angleDelta = currentAngle - g.startAngle;
		const distanceRatio =
			g.startDistance > 0 ? currentDistance / g.startDistance : 1;

		// Intent detection: accumulate per-frame deltas over several samples,
		// then decide based on which component dominates.
		if (g.intent === null) {
			const frameCenterDelta = Math.hypot(
				centerScreenX - g.prevCenter.x,
				centerScreenY - g.prevCenter.y,
			);
			const frameAngleDelta = Math.abs(currentAngle - g.prevAngle);
			const frameZoomDelta =
				g.prevDistance > 0 ? Math.abs(currentDistance / g.prevDistance - 1) : 0;

			g.sampleAngleSum += frameAngleDelta;
			g.sampleCenterSum += frameCenterDelta;
			g.sampleZoomSum += frameZoomDelta;
			g.sampleCount++;
			g.prevAngle = currentAngle;
			g.prevCenter = { x: centerScreenX, y: centerScreenY };
			g.prevDistance = currentDistance;

			const SAMPLES_NEEDED = 5;
			if (g.sampleCount >= SAMPLES_NEEDED) {
				// Compare accumulated per-frame angle change (radians)
				// vs accumulated per-frame zoom change (ratio).
				// On touch, rotating fingers inevitably changes distance,
				// so use a generous ratio: if angle dominates zoom by 3x, it's rotation.
				if (
					g.sampleAngleSum > (2 * Math.PI) / 180 &&
					g.sampleAngleSum > g.sampleZoomSum * 3
				) {
					g.intent = "rotation";
				} else {
					g.intent = "pan-zoom";
				}
			}
		}

		if (g.intent === null) return;

		if (g.intent === "pan-zoom") {
			const newZoom = Math.max(
				PAPLICO_MIN_ZOOM_SCALE,
				Math.min(PAPLICO_MAX_ZOOM_SCALE, g.startZoom * distanceRatio),
			);

			const cos = Math.cos(-g.startRotation);
			const sin = Math.sin(-g.startRotation);
			const relX = centerScreenX - rect.width / 2;
			const relY = centerScreenY - rect.height / 2;
			const unrotX = relX * cos - relY * sin;
			const unrotY = relX * sin + relY * cos;

			this.callbacks.setViewport({
				x: g.centerWorld.x - unrotX / newZoom,
				y: g.centerWorld.y + unrotY / newZoom,
				zoom: newZoom,
			});
		} else {
			// Rotation — gestureCenterWorld stays fixed at initial screen position
			const newRotation = g.startRotation + angleDelta;

			const cos = Math.cos(-newRotation);
			const sin = Math.sin(-newRotation);
			const relX = g.centerScreen.x - rect.width / 2;
			const relY = g.centerScreen.y - rect.height / 2;
			const unrotX = relX * cos - relY * sin;
			const unrotY = relX * sin + relY * cos;

			const viewport = this.callbacks.getViewport();
			this.callbacks.setViewport({
				x: g.centerWorld.x - unrotX / viewport.zoom,
				y: g.centerWorld.y + unrotY / viewport.zoom,
				rotation: newRotation,
			});
		}
	}

	/** Update object resize during two-finger gesture */
	private updateObjectResizeGesture(rect: DOMRect): void {
		if (this.gesture.type !== "object-resize" || !this.gesture.startBounds)
			return;

		const pointers = [...this.activePointers.values()];
		if (pointers.length < 2) return;
		const [p0, p1] = pointers;

		const dx = p1.x - p0.x;
		const dy = p1.y - p0.y;
		const currentDistance = Math.hypot(dx, dy);

		const scaleRatio =
			this.gesture.startDistance > 0
				? currentDistance / this.gesture.startDistance
				: 1;

		const tool = this.callbacks.getTool();
		if (tool && "handlePinchResize" in tool) {
			const viewport = this.callbacks.getViewport();
			(tool as any).handlePinchResize(
				this.gesture.startBounds,
				this.gesture.startCenter,
				scaleRatio,
				viewport,
				rect.width,
				rect.height,
			);
		}
	}

	// --- Safari GestureEvent (macOS trackpad rotation) ---

	private handleGestureStart(e: Event): void {
		e.preventDefault();
		const viewport = this.callbacks.getViewport();
		const rect = this.canvas.getBoundingClientRect();
		const ge = e as unknown as { clientX: number; clientY: number };
		const screenX = ge.clientX - rect.left;
		const screenY = ge.clientY - rect.top;

		this.gesture = {
			type: "safari-trackpad",
			startRotation: viewport.rotation ?? 0,
			startZoom: viewport.zoom,
			cursorWorld: screenToWorld(
				screenX,
				screenY,
				viewport,
				rect.width,
				rect.height,
			),
			cursorScreen: { x: screenX, y: screenY },
		};
	}

	private handleGestureChange(e: Event): void {
		e.preventDefault();

		if (this.gesture.type !== "safari-trackpad") return;

		const ge = e as unknown as { rotation: number; scale: number };
		const g = this.gesture;
		const rect = this.canvas.getBoundingClientRect();

		const newRotation = g.startRotation + (ge.rotation * Math.PI) / 180;
		const newZoom = Math.max(
			PAPLICO_MIN_ZOOM_SCALE,
			Math.min(PAPLICO_MAX_ZOOM_SCALE, g.startZoom * ge.scale),
		);

		// Solve for viewport center so that cursorWorld stays at cursorScreen
		const relX = g.cursorScreen.x - rect.width / 2;
		const relY = g.cursorScreen.y - rect.height / 2;
		const cos = Math.cos(-newRotation);
		const sin = Math.sin(-newRotation);
		const unrotX = relX * cos - relY * sin;
		const unrotY = relX * sin + relY * cos;

		this.callbacks.setViewport({
			x: g.cursorWorld.x - unrotX / newZoom,
			y: g.cursorWorld.y + unrotY / newZoom,
			zoom: newZoom,
			rotation: newRotation,
		});
	}

	private handleGestureEnd(e: Event): void {
		e.preventDefault();
		if (this.gesture.type === "safari-trackpad") {
			this.gesture = { type: "idle" };
		}
	}
}
