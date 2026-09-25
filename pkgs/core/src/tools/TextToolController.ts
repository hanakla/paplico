import type { TextEditUIData } from "../renderer/ui/types";
import type { TextStyle } from "../schema";
import type { TextTool } from "./TextTool";

/** Selection rectangle in world coordinates */
interface SelectionRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Text editing UI state
 *
 * The actual instance is injected as a Valtio proxy from outside,
 * but TextToolController itself has no dependency on Valtio.
 */
export interface TextEditState {
	isEditing: boolean;
	elementId: string | null;
	cursorX: number;
	cursorY: number;
	cursorHeight: number;
	cursorVisible: boolean;
	writingMode: "horizontal-tb" | "vertical-rl" | "vertical-lr";
	selectionStyle: Partial<TextStyle> | null;
	hasSelection: boolean;
	selectionRects: SelectionRect[];
	/** Element transform rotation in radians (for CSS rotation of cursor/selection) */
	elementRotation: number;
	/** Caret's own rotation in radians (glyph tangent for on-path text) */
	cursorRotation: number;
}

export const defaultTextEditState: TextEditState = {
	isEditing: false,
	elementId: null,
	cursorX: 0,
	cursorY: 0,
	cursorHeight: 24,
	cursorVisible: true,
	writingMode: "horizontal-tb",
	selectionStyle: null,
	hasSelection: false,
	selectionRects: [],
	elementRotation: 0,
	cursorRotation: 0,
};

const BLINK_INTERVAL_MS = 530;

/**
 * Controller for text tool UI operations
 *
 * Reactive UI updates are achieved by passing a Valtio proxy to the constructor.
 */
export class TextToolController {
	private textTool: TextTool | null = null;
	private state: TextEditState;
	private blinkTimer: ReturnType<typeof setInterval> | null = null;
	private onTextEditUIChange: ((data: TextEditUIData | null) => void) | null =
		null;

	public constructor(state: TextEditState) {
		this.state = state;
	}

	public setOnTextEditUIChange(
		cb: ((data: TextEditUIData | null) => void) | null,
	): void {
		this.onTextEditUIChange = cb;
	}

	// --- TextTool registration ---

	public registerTextTool(tool: TextTool | null): void {
		this.textTool = tool;
	}

	public getTextTool(): TextTool | null {
		return this.textTool;
	}

	// --- Edit lifecycle ---

	public startTextEdit(
		elementId: string,
		cursorX: number,
		cursorY: number,
		cursorHeight: number,
		writingMode:
			| "horizontal-tb"
			| "vertical-rl"
			| "vertical-lr" = "horizontal-tb",
		elementRotation = 0,
	): void {
		this.state.isEditing = true;
		this.state.elementId = elementId;
		this.state.cursorX = cursorX;
		this.state.cursorY = cursorY;
		this.state.cursorHeight = cursorHeight;
		this.state.cursorVisible = true;
		this.state.writingMode = writingMode;
		this.state.selectionStyle = null;
		this.state.hasSelection = false;
		this.state.selectionRects = [];
		this.state.elementRotation = elementRotation;
		this.state.cursorRotation = 0;

		this.startBlinkTimer();
		this.syncTextEditUI();
	}

	public endTextEdit(): void {
		this.stopBlinkTimer();

		this.state.isEditing = false;
		this.state.elementId = null;
		this.state.cursorX = 0;
		this.state.cursorY = 0;
		this.state.cursorHeight = 24;
		this.state.cursorVisible = true;
		this.state.writingMode = "horizontal-tb";
		this.state.selectionStyle = null;
		this.state.hasSelection = false;
		this.state.selectionRects = [];
		this.state.elementRotation = 0;
		this.state.cursorRotation = 0;

		this.onTextEditUIChange?.(null);
	}

	public isTextEditing(): boolean {
		return this.state.isEditing;
	}

	// --- Cursor management ---

	public updateTextCursor(
		cursorX: number,
		cursorY: number,
		cursorHeight?: number,
		cursorRotation?: number,
	): void {
		this.state.cursorX = cursorX;
		this.state.cursorY = cursorY;
		if (cursorHeight !== undefined) {
			this.state.cursorHeight = cursorHeight;
		}
		this.state.cursorRotation = cursorRotation ?? 0;
		// Reset visibility on cursor move
		this.state.cursorVisible = true;
		this.resetBlinkTimer();
		this.syncTextEditUI();
	}

	private toggleCursorBlink(): void {
		this.state.cursorVisible = !this.state.cursorVisible;
		this.syncTextEditUI();
	}

	/**
	 * Immediately show the cursor and reset the blink timer.
	 * Call this at the START of async cursor-move operations so
	 * the cursor stays visible during hit-test + position lookup.
	 */
	public showCursorImmediate(): void {
		this.state.cursorVisible = true;
		this.resetBlinkTimer();
		this.syncTextEditUI();
	}

	// --- Selection management ---

	public updateTextSelectionRects(rects: SelectionRect[]): void {
		this.state.selectionRects = rects;
		this.syncTextEditUI();
	}

	public updateSelectionStyle(
		style: Partial<TextStyle> | null,
		hasSelection: boolean,
	): void {
		this.state.selectionStyle = style;
		this.state.hasSelection = hasSelection;
		this.syncTextEditUI();
	}

	// --- Blink timer ---

	private startBlinkTimer(): void {
		this.stopBlinkTimer();
		this.blinkTimer = setInterval(() => {
			this.toggleCursorBlink();
		}, BLINK_INTERVAL_MS);
	}

	private stopBlinkTimer(): void {
		if (this.blinkTimer != null) {
			clearInterval(this.blinkTimer);
			this.blinkTimer = null;
		}
	}

	private resetBlinkTimer(): void {
		if (this.state.isEditing) {
			this.startBlinkTimer();
		}
	}

	// --- WebGPU UI sync ---

	private syncTextEditUI(): void {
		if (!this.state.isEditing) {
			this.onTextEditUIChange?.(null);
			return;
		}

		const s = this.state;
		const data: TextEditUIData = {
			cursor:
				s.selectionRects.length > 0
					? null
					: {
							x: s.cursorX,
							y: s.cursorY,
							height: s.cursorHeight,
							visible: s.cursorVisible,
							writingMode: s.writingMode,
							rotation: s.elementRotation + s.cursorRotation,
						},
			selectionRects: s.selectionRects.map((r) => ({
				...r,
				rotation: s.elementRotation,
			})),
			// TODO: Wire up IME composition underline from TextTool.compositionAnchor
			compositionUnderline: null,
		};

		this.onTextEditUIChange?.(data);
	}
}
