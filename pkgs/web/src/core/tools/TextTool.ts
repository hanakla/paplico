import {
	createDefaultColor,
	createIdentityTransform,
} from "../document/factory";
import { Clipboard, PAPLICO_TEXT_MIME } from "../infra/Clipboard";
import {
	buildTextCharTouchOverlay,
	TEXT_CHAR_TOUCH_HIT_PREFIX,
} from "../renderer/ui/builders/charTouch";
import { buildHoverOverlay } from "../renderer/ui/builders/hover";
import { buildMarqueeOverlay } from "../renderer/ui/builders/marquee";
import {
	buildTextFlowChainLinks,
	buildTextFlowHandles,
	buildTextFlowLinkPreview,
	buildTextRegionPreview,
	TEXT_FLOW_HANDLE_HIT_PREFIX,
	TEXT_OVERFLOW_BADGE_HIT_PREFIX,
	type TextFlowHandleData,
} from "../renderer/ui/builders/text";
import { OVERLAY_KEYS } from "../renderer/ui/overlayKeys";
import { OVERLAY_Z, UI_THEME } from "../renderer/ui/theme";
import type { MarqueeSelectionUIData } from "../renderer/ui/types";
import {
	type BlendMode,
	type CharOverride,
	type FontSource,
	generateUid,
	hsvToRgb,
	type TextAxisBinding,
	type TextContent,
	type TextElement,
	type TextLayout,
	type TextRun,
	type TextStyle,
	type Viewport,
} from "../schema";
import { getFontManager } from "../typography/fonts/FontManager";
import {
	resolveFontVariations,
	updateFontVariation,
} from "../typography/fonts/fontVariations";
import type { TextGlyphQuad } from "../typography/glyphQuad";
import { classifyPathForTextBinding } from "../typography/regionGeometry";
import { splitRunAt } from "../typography/textContent";
import {
	screenToWorld,
	type WorldBezierSegment,
} from "../utils/geometry/geometry";
import { evalCubicBezier } from "../utils/geometry/pathSampling";
import { matchKey } from "../utils/keyboard";
import { deepClone } from "../utils/lang";
import {
	isInlineDirection,
	isPositiveCrossDirection,
	isPositiveInlineDirection,
} from "../utils/writingMode";
import type { TextToolController } from "./TextToolController";
import type { PointerEventData, Tool } from "./Tool";
import type { ToolContext } from "./ToolContext";

interface TextToolOptions {
	controller: TextToolController | null;
	defaultStyle: TextStyle;
	textCreate: (text: TextElement) => void;
	textComplete: (text: TextElement) => void;
	textDelete?: (id: string) => void;
	editStart?: (text: TextElement) => void;
	editEnd?: () => void;
	previewUpdate?: (text: TextElement | null) => void;
	/** Find text element at point for re-editing */
	findTextAtPoint?: (x: number, y: number) => TextElement | null;
	/** Called when hover state changes (for BBox display) */
	hoverUpdate?: (element: TextElement | null) => void;
	/** Called when cursor position changes */
	updateTextCursor?: (
		cursorPos: number,
		x: number,
		y: number,
		fontSize?: number,
		rotation?: number,
	) => void;
	/** Called when selection style info changes (for ActionsPanel) */
	selectionStyleChange?: (
		style: Partial<TextStyle> | null,
		hasSelection: boolean,
	) => void;
	/** Called when selection range changes (for selection rect calculation) */
	selectionRangeChange?: (
		textElement: TextElement,
		startIndex: number,
		endIndex: number,
	) => void;
	/** Get accurate cursor position via TextRenderer (LOCAL coords + element offset → WORLD coords) */
	getCursorWorldPosition?: (
		textElement: TextElement,
		charIndex: number,
	) => Promise<{ x: number; y: number; height: number; rotation?: number }>;
	/** Hit test character at local position via TextRenderer */
	hitTestCharacter?: (
		textElement: TextElement,
		localX: number,
		localY: number,
	) => Promise<number | null>;
	/** Get target charIndex for up/down line navigation */
	getLineNavigationTarget?: (
		textElement: TextElement,
		charIndex: number,
		direction: "up" | "down",
	) => Promise<number | null>;
	/** Get charIndex at line start or end for the line containing charIndex */
	getLineStartEnd?: (
		textElement: TextElement,
		charIndex: number,
		which: "start" | "end",
	) => Promise<number | null>;
	/** Persist text content to Yjs so UndoManager can track keystroke-level edits.
	 * Returns the latest TextElement from the store after the update. */
	persistTextEdit?: (textElement: TextElement) => TextElement | undefined;
	/** Create a path-bound text (guide-ifies the axis path in the same undo) */
	textCreateOnPath?: (
		text: TextElement,
		pathObjectId: string,
		mode: "onPath" | "inShape",
		clickWorld: { x: number; y: number },
	) => void;
	/** Link sourceText's overflow into targetText */
	textFlowLink?: (sourceTextId: string, targetTextId: string) => void;
	/** Remove sourceText's outgoing flow link */
	textFlowUnlink?: (sourceTextId: string) => void;
	/** The text element flowing into textId */
	textFindFlowSource?: (textId: string) => TextElement | null;
}

type TextInteractionState =
	| { kind: "idle" }
	| {
			kind: "pendingBlankClick";
			startWorld: { x: number; y: number };
			startScreen: { x: number; y: number };
	  }
	| {
			kind: "regionDragging";
			startWorld: { x: number; y: number };
			currentWorld: { x: number; y: number };
	  }
	| { kind: "flowLinking"; sourceTextId: string };

interface TextToolInitOptions {
	controller?: TextToolController | null;
	defaultStyle: TextStyle;
}

interface CursorPosition {
	paragraph: number;
	run: number;
	char: number;
}

interface SelectionRange {
	start: CursorPosition;
	end: CursorPosition;
}

interface TextEditState {
	textElement: TextElement;
	cursorPosition: CursorPosition;
	selectionRange: SelectionRange | null;
	isEditing: boolean;
	isComposing: boolean;
	compositionText: string;
}

/** Pre-drag override values; drags apply deltas against these absolutes */
interface TextCharTouchBase {
	kerningAdjust: number;
	baselineShift: number;
	rotation: number;
	skewX: number;
	skewY: number;
	sizeMultiplier: number;
	/** Run font size for px → em conversion of the kerning axis */
	fontSize: number;
}

type TextCharTouchDrag =
	| {
			kind: "move";
			startWorld: { x: number; y: number };
			bases: Map<number, TextCharTouchBase>;
	  }
	| {
			kind: "rotate";
			center: { x: number; y: number };
			startAngle: number;
			bases: Map<number, TextCharTouchBase>;
	  }
	| {
			kind: "scale";
			center: { x: number; y: number };
			startDist: number;
			bases: Map<number, TextCharTouchBase>;
	  }
	| {
			kind: "skew";
			startWorld: { x: number; y: number };
			bases: Map<number, TextCharTouchBase>;
	  };

/** Touch-type session: char picking + shared-delta transform drags */
interface TextCharTouchSession {
	/** Working copy; replaced by the committed clone after each drag */
	textElement: TextElement;
	/** Selected chars as content-global indices */
	selectedCharIndices: Set<number>;
	/** World-space quads of the current selection (pre-drag) */
	quads: Map<number, TextGlyphQuad>;
	/** Element transform for world→local delta conversion */
	elementTransform: { rotation: number; scaleX: number; scaleY: number };
	drag: TextCharTouchDrag | null;
}

/** Drag-to-select rubber band over the touch-type glyphs of one text element */
interface TextCharTouchMarquee {
	/** Flow-head text element id whose glyphs the rect selects */
	targetId: string;
	startWorld: { x: number; y: number };
	endWorld: { x: number; y: number };
	/** Shift held at drag start: union the marquee hits with the current selection */
	additive: boolean;
	/** Promoted past the click→drag threshold; the rect is being drawn */
	active: boolean;
}

export class TextTool implements Tool {
	public readonly name = "text";

	private context: ToolContext;
	private controller: TextToolController | null = null;
	private options: TextToolOptions;
	private editState: TextEditState | null = null;
	private hoveredTextId: string | null = null;
	private dragAnchorWorldPos: { x: number; y: number } | null = null;
	private isDragging = false;
	private compositionAnchor: {
		paragraph: number;
		run: number;
		char: number;
		originalRunText: string;
	} | null = null;
	private hitTestSeq = 0;
	private cursorUpdateSeq = 0;
	private charTouchMode = false;
	private charTouch: TextCharTouchSession | null = null;
	private charTouchMarquee: TextCharTouchMarquee | null = null;
	/** Guards stale async glyph-pick / quad-refresh resolutions */
	private charTouchSeq = 0;
	/** Style staged at the caret for the next typed characters (no selection) */
	private pendingCaretStyle: Partial<TextStyle> | null = null;
	private interaction: TextInteractionState = { kind: "idle" };
	private hoveredText: TextElement | null = null;
	private lastZoom = 1;

	public constructor(context: ToolContext, options: TextToolInitOptions) {
		this.context = context;
		this.options = {
			controller: options.controller ?? context.textToolController,
			defaultStyle: options.defaultStyle,
			textCreate: (text) => context.textCreate(text),
			textComplete: (text) => context.textComplete(text),
			textDelete: (id) => context.textDelete(id),
			editStart: (text) => context.editStart(text),
			editEnd: () => context.editEnd(),
			previewUpdate: (text) => context.textPreviewUpdate(text),
			findTextAtPoint: (x, y) => context.findTextAtPoint(x, y),
			hoverUpdate: (element) => {
				const bounds = element ? context.getBounds(element.id) : null;
				context.uiSetOverlay(
					OVERLAY_KEYS.textHover,
					bounds
						? {
								zIndex: OVERLAY_Z.hover,
								primitives: buildHoverOverlay({ bounds }, UI_THEME),
							}
						: null,
				);
			},
			updateTextCursor: (cursorPos, x, y, fontSize, rotation) =>
				context.updateTextCursor(cursorPos, x, y, fontSize, rotation),
			selectionStyleChange: (style, hasSelection) =>
				context.selectionStyleChange(style, hasSelection),
			selectionRangeChange: (textElement, startIndex, endIndex) =>
				context.selectionRangeChange(textElement, startIndex, endIndex),
			getCursorWorldPosition: (textElement, charIndex) =>
				context.getCursorWorldPosition(textElement, charIndex),
			hitTestCharacter: (textElement, worldX, worldY) =>
				context.hitTestCharacter(textElement, worldX, worldY),
			getLineNavigationTarget: (textElement, charIndex, direction) =>
				context.getLineNavigationTarget(textElement, charIndex, direction),
			getLineStartEnd: (textElement, charIndex, which) =>
				context.getLineStartEnd(textElement, charIndex, which),
			persistTextEdit: (textElement) => context.persistTextEdit(textElement),
			textCreateOnPath: (text, pathObjectId, mode, clickWorld) =>
				context.textCreateOnPath(text, pathObjectId, mode, clickWorld),
			textFlowLink: (sourceTextId, targetTextId) =>
				context.textFlowLink(sourceTextId, targetTextId),
			textFlowUnlink: (sourceTextId) => context.textFlowUnlink(sourceTextId),
			textFindFlowSource: (textId) => context.textFindFlowSource(textId),
		};
		this.controller = this.options.controller;
	}

	// --- Lifecycle Methods ---

	public onPointerDown(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (this.context.isReadonly() || this.context.isCurrentLayerLocked())
			return;

		const worldPos = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		this.lastZoom = viewport.zoom || 1;

		// Touch-type mode replaces the whole pointer pipeline
		if (this.charTouchMode) {
			this.handleCharTouchPointerDown(event, worldPos);
			return;
		}

		// GPU overlay hits (■ flow handle / red … badge) take precedence
		const overlayHit = this.context.uiHitTest({ x: event.x, y: event.y });
		if (
			overlayHit &&
			(overlayHit.overlayKey === OVERLAY_KEYS.textFlowHandles ||
				overlayHit.overlayKey === OVERLAY_KEYS.sysTextOverflow)
		) {
			const hitId = overlayHit.hitId ?? "";
			const sourceTextId = hitId.startsWith(TEXT_FLOW_HANDLE_HIT_PREFIX)
				? hitId.slice(TEXT_FLOW_HANDLE_HIT_PREFIX.length)
				: hitId.startsWith(TEXT_OVERFLOW_BADGE_HIT_PREFIX)
					? hitId.slice(TEXT_OVERFLOW_BADGE_HIT_PREFIX.length)
					: null;
			if (sourceTextId) {
				if (event.altKey) {
					// Alt+click on a handle removes the outgoing link
					this.options.textFlowUnlink?.(sourceTextId);
					this.updateFlowHandleOverlay();
				} else {
					this.interaction = { kind: "flowLinking", sourceTextId };
					this.updateFlowLinkPreview(worldPos);
				}
				return;
			}
		}

		// When already editing, use layout-based cursor placement directly
		// instead of relying on SpatialIndex bounds (which may not cover all lines)
		if (this.editState) {
			const hitText = this.options.findTextAtPoint?.(worldPos.x, worldPos.y);
			if (hitText && hitText.id !== this.editState.textElement.id) {
				if (
					this.resolveFlowHead(hitText).id === this.editState.textElement.id
				) {
					// Same flow chain: keep editing the head, just move the caret
					// (chain-aware hitTestCharacter resolves the clicked region)
					this.isDragging = true;
					this.dragAnchorWorldPos = { x: worldPos.x, y: worldPos.y };
					if (event.shiftKey) {
						this.extendSelectionToWorldPosition(worldPos.x, worldPos.y);
					} else {
						this.moveCursorToWorldPosition(
							this.editState.textElement,
							worldPos.x,
							worldPos.y,
						);
					}
					return;
				}
				// Clicked on a different text → switch editing target. Arm the
				// drag anchor so the same gesture can continue into a selection
				this.exitEditMode();
				this.enterEditModeAtPosition(
					this.resolveFlowHead(hitText),
					worldPos.x,
					worldPos.y,
				);
				this.isDragging = true;
				this.dragAnchorWorldPos = { x: worldPos.x, y: worldPos.y };
				return;
			}
			// Clicking away from any text commits the edit (the element is
			// deleted when it stayed empty); the click itself is consumed.
			// Without a hit tester "outside" is undecidable — keep editing then
			if (this.options.findTextAtPoint && !hitText) {
				this.exitEditMode();
				return;
			}
			// Layout-coordinate-based cursor placement for the current text
			this.isDragging = true;
			this.dragAnchorWorldPos = { x: worldPos.x, y: worldPos.y };
			// Shift+click extends the selection from the current caret instead
			// of collapsing it
			if (event.shiftKey) {
				this.extendSelectionToWorldPosition(worldPos.x, worldPos.y);
			} else {
				this.moveCursorToWorldPosition(
					this.editState.textElement,
					worldPos.x,
					worldPos.y,
				);
			}
			return;
		}

		// Not editing: hit test to start editing or create new text
		if (this.options.findTextAtPoint) {
			const hitText = this.options.findTextAtPoint(worldPos.x, worldPos.y);
			if (hitText) {
				// Downstream flow regions edit through their chain head. Arm the
				// drag anchor so the entry gesture can continue into a selection
				this.enterEditModeAtPosition(
					this.resolveFlowHead(hitText),
					worldPos.x,
					worldPos.y,
				);
				this.isDragging = true;
				this.dragAnchorWorldPos = { x: worldPos.x, y: worldPos.y };
				return;
			}
		}

		// Path click: open path → text on path, closed path → area text
		if (this.tryCreateTextBoundToPath(worldPos, viewport)) return;

		// Blank click: defer creation to pointerup so a drag can become a region
		this.interaction = {
			kind: "pendingBlankClick",
			startWorld: { x: worldPos.x, y: worldPos.y },
			startScreen: { x: event.x, y: event.y },
		};
	}

	public onPointerMove(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		const worldPos = screenToWorld(
			event.x,
			event.y,
			viewport,
			canvasWidth,
			canvasHeight,
		);
		this.lastZoom = viewport.zoom || 1;

		if (this.charTouchMode) {
			this.handleCharTouchPointerMove(event, worldPos);
			return;
		}

		if (this.interaction.kind === "flowLinking") {
			this.updateFlowLinkPreview(worldPos);
			return;
		}
		if (this.interaction.kind === "pendingBlankClick") {
			const dx = event.x - this.interaction.startScreen.x;
			const dy = event.y - this.interaction.startScreen.y;
			if (dx * dx + dy * dy > REGION_DRAG_THRESHOLD_PX ** 2) {
				this.interaction = {
					kind: "regionDragging",
					startWorld: this.interaction.startWorld,
					currentWorld: { x: worldPos.x, y: worldPos.y },
				};
				this.updateRegionPreview();
			}
			return;
		}
		if (this.interaction.kind === "regionDragging") {
			this.interaction = {
				...this.interaction,
				currentWorld: { x: worldPos.x, y: worldPos.y },
			};
			this.updateRegionPreview();
			return;
		}

		// During text editing, handle drag selection instead of hover
		if (this.editState) {
			if (this.isDragging) {
				this.startOrExtendSelection(worldPos.x, worldPos.y);
			}
			this.hoveredTextId = null;
			this.hoveredText = null;
			this.options.hoverUpdate?.(null);
			return;
		}

		const hitText =
			this.options.findTextAtPoint?.(worldPos.x, worldPos.y) ?? null;
		this.hoveredTextId = hitText?.id ?? null;
		this.hoveredText = hitText;
		this.options.hoverUpdate?.(hitText);
		this.updateFlowHandleOverlay();
	}

	public onPointerUp(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		if (this.charTouchMode) {
			this.handleCharTouchPointerUp();
			return;
		}
		// Flow linking is a single drag from the ■ handle: the release picks
		// the target (releasing off any text just cancels)
		if (this.interaction.kind === "flowLinking") {
			this.finishFlowLinking(
				screenToWorld(event.x, event.y, viewport, canvasWidth, canvasHeight),
			);
			return;
		}
		if (this.interaction.kind === "pendingBlankClick") {
			const start = this.interaction.startWorld;
			this.interaction = { kind: "idle" };
			this.createNewText(start);
			return;
		}
		if (this.interaction.kind === "regionDragging") {
			const { startWorld, currentWorld } = this.interaction;
			this.interaction = { kind: "idle" };
			this.context.uiSetOverlay(OVERLAY_KEYS.textRegionPreview, null);
			this.createRegionText(startWorld, currentWorld);
			return;
		}
		this.isDragging = false;
		this.dragAnchorWorldPos = null;
	}

	public onDoubleClick(
		event: PointerEventData,
		viewport: Viewport,
		canvasWidth: number,
		canvasHeight: number,
	): void {
		// Touch-type: double-clicking a text hands off to caret editing
		if (this.charTouchMode) {
			const worldPos = screenToWorld(
				event.x,
				event.y,
				viewport,
				canvasWidth,
				canvasHeight,
			);
			const hitText = this.options.findTextAtPoint?.(worldPos.x, worldPos.y);
			if (!hitText) return;
			this.setCharTouchMode(false);
			this.context.textCharTouchModeChange(false);
			this.enterEditModeAtPosition(
				this.resolveFlowHead(hitText),
				worldPos.x,
				worldPos.y,
			);
			return;
		}
		// TODO: Word selection
	}

	public onKeyDown(
		event: KeyboardEvent,
		_viewport: Viewport,
		_canvasWidth: number,
		_canvasHeight: number,
	): boolean {
		// Touch-type Escape: clear the char selection first, then leave the mode
		if (this.charTouchMode && matchKey(event, "Escape")) {
			event.preventDefault();
			this.clearCharTouchMarquee();
			if (this.charTouch && this.charTouch.selectedCharIndices.size > 0) {
				this.charTouch.selectedCharIndices = new Set();
				void this.refreshCharTouchQuads();
			} else {
				this.setCharTouchMode(false);
				this.context.textCharTouchModeChange(false);
			}
			return true;
		}

		// Escape cancels flow linking / region dragging before edit handling
		if (this.interaction.kind !== "idle" && matchKey(event, "Escape")) {
			event.preventDefault();
			this.resetInteraction();
			return true;
		}

		if (!this.editState) return false;
		const { shiftKey, key } = event;

		// Alt + Arrow: kerning (inline direction) or line spacing (cross direction)
		if (
			matchKey(event, null, { alt: true }) ||
			matchKey(event, null, { alt: true, shift: true })
		) {
			if (
				key === "ArrowLeft" ||
				key === "ArrowRight" ||
				key === "ArrowUp" ||
				key === "ArrowDown"
			) {
				event.preventDefault();
				const arrowKey = key as
					| "ArrowLeft"
					| "ArrowRight"
					| "ArrowUp"
					| "ArrowDown";
				const wm = this.editState.textElement.layout.writingMode;
				const delta = shiftKey ? 0.1 : 0.02;

				if (isInlineDirection(arrowKey, wm)) {
					const direction = isPositiveInlineDirection(arrowKey, wm) ? 1 : -1;
					this.adjustKerning(delta * direction);
				} else {
					const direction = isPositiveCrossDirection(arrowKey, wm) ? 1 : -1;
					this.adjustLineSpacing(delta * direction);
				}
				return true;
			}
		}

		// Reset kerning: Alt + Ctrl + 0
		if (matchKey(event, null, { alt: true, ctrl: true })) {
			if (key === "0") {
				event.preventDefault();
				this.resetKerning();
				return true;
			}
		}

		// Character size adjustment: Ctrl/Cmd + Shift + > or <
		if (matchKey(event, null, { ctrlOrMeta: true, shift: true })) {
			if (key === ">" || key === "." || key === "<" || key === ",") {
				event.preventDefault();
				const multiplier = key === ">" || key === "." ? 1.1 : 0.9;
				this.adjustCharacterSize(multiplier);
				return true;
			}
		}

		// Escape to exit edit mode
		if (matchKey(event, "Escape")) {
			event.preventDefault();
			this.exitEditMode();
			return true;
		}

		// TODO: Text input, cursor movement, selection
		// This will be expanded in Phase 4

		return false;
	}

	public dispose(): void {
		this.resetInteraction();
		this.charTouch = null;
		this.clearCharTouchMarquee();
		this.context.uiSetOverlay(OVERLAY_KEYS.textCharTouch, null);
		this.context.uiSetOverlay(OVERLAY_KEYS.textFlowHandles, null);
		this.context.uiSetOverlay(OVERLAY_KEYS.textFlowChain, null);
		this.controller?.registerTextTool(null);
		this.controller?.endTextEdit();
	}

	public onCancel(): void {
		this.resetInteraction();
		if (this.editState) {
			this.exitEditMode();
		}
		this.charTouch = null;
		this.clearCharTouchMarquee();
		this.context.uiSetOverlay(OVERLAY_KEYS.textCharTouch, null);
		this.hoveredTextId = null;
		this.hoveredText = null;
		this.options.hoverUpdate?.(null);
		this.context.uiSetOverlay(OVERLAY_KEYS.textFlowHandles, null);
		this.context.uiSetOverlay(OVERLAY_KEYS.textFlowChain, null);
	}

	// --- Text Input Methods (called from TextEditOverlay) ---

	public insertText(text: string): void {
		if (!this.editState || this.editState.isComposing) return;

		// Delete selection first if any
		if (this.editState.selectionRange) {
			this.deleteSelection();
		}

		const { cursorPosition, textElement } = this.editState;
		const paragraph = textElement.content.paragraphs[cursorPosition.paragraph];
		if (!paragraph) return;

		const run = paragraph.runs[cursorPosition.run];
		if (!run) return;

		// Style staged at the caret (font/size/color picked with no selection):
		// insert as a separately styled run instead of inheriting the host run
		const pending = this.pendingCaretStyle;
		if (pending) {
			this.pendingCaretStyle = null;
			const absoluteBefore = this.getCursorCharIndex();

			const parts: TextRun[] = [];
			if (cursorPosition.char > 0) {
				parts.push(splitRunAt(run, 0, cursorPosition.char));
			}
			parts.push({ text, style: { ...run.style, ...pending } });
			if (cursorPosition.char < run.text.length) {
				parts.push(splitRunAt(run, cursorPosition.char, run.text.length));
			}
			paragraph.runs.splice(cursorPosition.run, 1, ...parts);
			mergeAdjacentRuns(paragraph.runs);

			this.editState.cursorPosition = this.charIndexToCursorPosition(
				absoluteBefore + text.length,
			);
			this.requestRender();
			this.persistAndSync(textElement);
			return;
		}

		// Insert text at cursor position; per-char overrides stay attached to
		// their characters, not to run-local positions
		shiftCharOverrides(run, cursorPosition.char, text.length);
		run.text =
			run.text.slice(0, cursorPosition.char) +
			text +
			run.text.slice(cursorPosition.char);

		// Move cursor forward
		cursorPosition.char += text.length;

		this.requestRender();
		this.persistAndSync(textElement);
	}

	public deleteText(direction: "forward" | "backward"): void {
		if (!this.editState) return;

		// Delete selection if any
		if (this.editState.selectionRange) {
			this.deleteSelection();
			return;
		}

		const { cursorPosition, textElement } = this.editState;
		const paragraph = textElement.content.paragraphs[cursorPosition.paragraph];
		if (!paragraph) return;

		const run = paragraph.runs[cursorPosition.run];
		if (!run) return;

		if (direction === "backward") {
			if (cursorPosition.char > 0) {
				// Delete character before cursor
				spliceCharOverrides(run, cursorPosition.char - 1, cursorPosition.char);
				run.text =
					run.text.slice(0, cursorPosition.char - 1) +
					run.text.slice(cursorPosition.char);
				cursorPosition.char--;
			} else if (cursorPosition.run > 0) {
				// Move to previous run
				cursorPosition.run--;
				const prevRun = paragraph.runs[cursorPosition.run];
				cursorPosition.char = prevRun.text.length;
				// Delete last char of previous run if any
				if (prevRun.text.length > 0) {
					spliceCharOverrides(
						prevRun,
						prevRun.text.length - 1,
						prevRun.text.length,
					);
					prevRun.text = prevRun.text.slice(0, -1);
				}
			} else if (cursorPosition.paragraph > 0) {
				// Merge with previous paragraph
				this.mergeParagraphs(
					cursorPosition.paragraph - 1,
					cursorPosition.paragraph,
				);
			}
		} else {
			// Forward delete
			if (cursorPosition.char < run.text.length) {
				spliceCharOverrides(run, cursorPosition.char, cursorPosition.char + 1);
				run.text =
					run.text.slice(0, cursorPosition.char) +
					run.text.slice(cursorPosition.char + 1);
			} else if (cursorPosition.run < paragraph.runs.length - 1) {
				// Delete first char of next run
				const nextRun = paragraph.runs[cursorPosition.run + 1];
				if (nextRun.text.length > 0) {
					spliceCharOverrides(nextRun, 0, 1);
					nextRun.text = nextRun.text.slice(1);
				}
			} else if (
				cursorPosition.paragraph <
				textElement.content.paragraphs.length - 1
			) {
				// Merge with next paragraph
				this.mergeParagraphs(
					cursorPosition.paragraph,
					cursorPosition.paragraph + 1,
				);
			}
		}

		this.requestRender();
		this.persistAndSync(textElement);
	}

	public insertNewline(): void {
		if (!this.editState) return;

		// Delete selection first if any
		if (this.editState.selectionRange) {
			this.deleteSelection();
		}

		const { cursorPosition, textElement } = this.editState;
		const paragraph = textElement.content.paragraphs[cursorPosition.paragraph];
		if (!paragraph) return;

		const run = paragraph.runs[cursorPosition.run];
		if (!run) return;

		// Split text at cursor
		const textBefore = run.text.slice(0, cursorPosition.char);
		const textAfter = run.text.slice(cursorPosition.char);

		// Update current run with text before
		run.text = textBefore;

		// Create new paragraph with text after
		const newParagraph = {
			runs: [
				{
					text: textAfter,
					style: { ...run.style },
				},
			],
			alignment: paragraph.alignment,
			lineHeight: paragraph.lineHeight,
			indent: paragraph.indent,
			spacing: { ...paragraph.spacing },
		};

		// Insert new paragraph
		textElement.content.paragraphs.splice(
			cursorPosition.paragraph + 1,
			0,
			newParagraph,
		);

		// Move cursor to start of new paragraph
		cursorPosition.paragraph++;
		cursorPosition.run = 0;
		cursorPosition.char = 0;

		this.requestRender();
		this.persistAndSync(textElement);
	}

	public moveCursor(
		direction: "left" | "right" | "up" | "down",
		shift: boolean,
	): void {
		if (!this.editState) return;
		this.pendingCaretStyle = null;

		const { cursorPosition, textElement } = this.editState;

		// Handle selection
		if (shift) {
			if (!this.editState.selectionRange) {
				this.editState.selectionRange = {
					start: { ...cursorPosition },
					end: { ...cursorPosition },
				};
			}
		} else {
			// Clear selection on movement without shift
			if (this.editState.selectionRange) {
				const normalized = this.normalizeSelectionRange(
					this.editState.selectionRange,
				);
				if (direction === "left" || direction === "up") {
					const start = normalized.start;
					cursorPosition.paragraph = start.paragraph;
					cursorPosition.run = start.run;
					cursorPosition.char = start.char;
				} else {
					const end = normalized.end;
					cursorPosition.paragraph = end.paragraph;
					cursorPosition.run = end.run;
					cursorPosition.char = end.char;
				}
				this.editState.selectionRange = null;
				this.requestRender(false);
				return;
			}
		}
		// Move cursor position
		if (direction === "left") {
			if (cursorPosition.char > 0) {
				cursorPosition.char--;
			} else if (cursorPosition.run > 0) {
				cursorPosition.run--;
				const prevRun =
					textElement.content.paragraphs[cursorPosition.paragraph].runs[
						cursorPosition.run
					];
				cursorPosition.char = prevRun.text.length;
			} else if (cursorPosition.paragraph > 0) {
				cursorPosition.paragraph--;
				const prevPara =
					textElement.content.paragraphs[cursorPosition.paragraph];
				cursorPosition.run = prevPara.runs.length - 1;
				cursorPosition.char = prevPara.runs[cursorPosition.run].text.length;
			}
		} else if (direction === "right") {
			const paragraph =
				textElement.content.paragraphs[cursorPosition.paragraph];
			const run = paragraph.runs[cursorPosition.run];
			if (cursorPosition.char < run.text.length) {
				cursorPosition.char++;
			} else if (cursorPosition.run < paragraph.runs.length - 1) {
				cursorPosition.run++;
				cursorPosition.char = 0;
			} else if (
				cursorPosition.paragraph <
				textElement.content.paragraphs.length - 1
			) {
				cursorPosition.paragraph++;
				cursorPosition.run = 0;
				cursorPosition.char = 0;
			}
		} else if (direction === "up" || direction === "down") {
			// 上下移動はTextRendererのレイアウト情報が必要（async）
			if (this.options.getLineNavigationTarget) {
				const charIndex = this.getCursorCharIndex();
				this.options
					.getLineNavigationTarget(textElement, charIndex, direction)
					.then((targetCharIndex) => {
						if (
							!this.editState ||
							this.editState.textElement.id !== textElement.id
						)
							return;
						if (targetCharIndex == null) return;

						this.editState.cursorPosition =
							this.charIndexToCursorPosition(targetCharIndex);

						if (shift && this.editState.selectionRange) {
							this.editState.selectionRange.end = {
								...this.editState.cursorPosition,
							};
						}

						this.requestRender(false);
					});
				return; // async処理に委譲、以降のsync処理はスキップ
			}
		}

		// Update selection end if shift is pressed
		if (shift && this.editState.selectionRange) {
			this.editState.selectionRange.end = { ...cursorPosition };
		}

		this.requestRender(false);
	}

	public selectAll(): void {
		if (!this.editState) return;

		const { textElement } = this.editState;
		const paragraphs = textElement.content.paragraphs;
		const lastPara = paragraphs.at(-1);
		if (!lastPara) return;

		const lastRun = lastPara.runs.at(-1);
		if (!lastRun) return;

		this.editState.selectionRange = {
			start: { paragraph: 0, run: 0, char: 0 },
			end: {
				paragraph: paragraphs.length - 1,
				run: lastPara.runs.length - 1,
				char: lastRun.text.length,
			},
		};

		// Move cursor to end
		this.editState.cursorPosition = { ...this.editState.selectionRange.end };

		this.requestRender(false);
	}

	private getSelectedText(): string {
		if (!this.editState?.selectionRange) return "";

		const { selectionRange, textElement } = this.editState;
		const { start, end } = this.normalizeSelectionRange(selectionRange);

		let result = "";
		const paragraphs = textElement.content.paragraphs;

		for (let p = start.paragraph; p <= end.paragraph; p++) {
			const para = paragraphs[p];
			const startRun = p === start.paragraph ? start.run : 0;
			const endRun = p === end.paragraph ? end.run : para.runs.length - 1;

			for (let r = startRun; r <= endRun; r++) {
				const run = para.runs[r];
				const startChar =
					p === start.paragraph && r === start.run ? start.char : 0;
				const endChar =
					p === end.paragraph && r === end.run ? end.char : run.text.length;
				result += run.text.slice(startChar, endChar);
			}

			if (p < end.paragraph) {
				result += "\n";
			}
		}

		return result;
	}

	public async copyToClipboard(): Promise<void> {
		const text = this.getSelectedText();
		if (!text) return;

		const payload = this.extractSelectionPayload();
		try {
			if (typeof ClipboardItem === "undefined" || !payload) {
				await navigator.clipboard.writeText(text);
				return;
			}
			// Rich formats ride along with the plain text: the Paplico MIME
			// restores runs + charOverrides on in-app paste, text/html carries
			// the styles to external apps. (On non-Chromium the infra encodes
			// the custom MIME into text/html, replacing the styled markup.)
			await Clipboard.write([
				new ClipboardItem({
					"text/plain": new Blob([text], { type: "text/plain" }),
					"text/html": new Blob([textPayloadToHtml(payload)], {
						type: "text/html",
					}),
					[PAPLICO_TEXT_MIME]: new Blob([JSON.stringify(payload)], {
						type: PAPLICO_TEXT_MIME,
					}),
				}),
			]);
		} catch {
			// Clipboard access denied
		}
	}

	public async cutToClipboard(): Promise<void> {
		await this.copyToClipboard();
		this.deleteSelection();
	}

	public async pasteFromClipboard(): Promise<void> {
		try {
			// In-app rich payload takes priority over plain text
			if (typeof ClipboardItem !== "undefined") {
				const payload = await readTextPayloadFromClipboard();
				if (payload) {
					this.insertRichPayload(payload);
					return;
				}
			}

			const text = await navigator.clipboard.readText();
			if (text) {
				// Handle newlines in pasted text
				const lines = text.split(/\r?\n/);
				for (let i = 0; i < lines.length; i++) {
					this.insertText(lines[i]);
					if (i < lines.length - 1) {
						this.insertNewline();
					}
				}
			}
		} catch {
			// Clipboard access denied
		}
	}

	/** Selection as run slices with styles and reindexed charOverrides */
	private extractSelectionPayload(): TextClipboardPayload | null {
		if (!this.editState?.selectionRange) return null;

		const { selectionRange, textElement } = this.editState;
		const { start, end } = this.normalizeSelectionRange(selectionRange);
		const paragraphs = textElement.content.paragraphs;

		const payload: TextClipboardPayload = { paragraphs: [] };
		for (let p = start.paragraph; p <= end.paragraph; p++) {
			const para = paragraphs[p];
			const startRun = p === start.paragraph ? start.run : 0;
			const endRun = p === end.paragraph ? end.run : para.runs.length - 1;

			const runs: TextRun[] = [];
			for (let r = startRun; r <= endRun; r++) {
				const run = para.runs[r];
				const startChar =
					p === start.paragraph && r === start.run ? start.char : 0;
				const endChar =
					p === end.paragraph && r === end.run ? end.char : run.text.length;
				const slice = splitRunAt(run, startChar, endChar);
				if (slice.text.length > 0) runs.push(slice);
			}
			// Keep empty paragraphs so newline structure round-trips
			if (runs.length === 0) {
				runs.push({ text: "", style: { ...para.runs[startRun].style } });
			}
			payload.paragraphs.push({ runs });
		}
		return payload;
	}

	/** Insert copied run slices at the caret, keeping styles and overrides */
	private insertRichPayload(payload: TextClipboardPayload): void {
		if (!this.editState || this.editState.isComposing) return;
		if (payload.paragraphs.length === 0) return;
		if (this.editState.selectionRange) {
			this.deleteSelection();
		}

		const { cursorPosition, textElement } = this.editState;
		const paragraph = textElement.content.paragraphs[cursorPosition.paragraph];
		const run = paragraph?.runs[cursorPosition.run];
		if (!paragraph || !run) return;

		const absoluteBefore = this.getCursorCharIndex();
		const insertedLength = payload.paragraphs.reduce(
			(sum, p, i) =>
				sum + p.runs.reduce((s, r) => s + r.text.length, 0) + (i > 0 ? 1 : 0),
			0,
		);

		const before =
			cursorPosition.char > 0 ? splitRunAt(run, 0, cursorPosition.char) : null;
		const after =
			cursorPosition.char < run.text.length
				? splitRunAt(run, cursorPosition.char, run.text.length)
				: null;
		const firstRuns = payload.paragraphs[0].runs.map(cloneRun);

		if (payload.paragraphs.length === 1) {
			paragraph.runs.splice(
				cursorPosition.run,
				1,
				...[before, ...firstRuns, after].filter(
					(r): r is TextRun => r !== null,
				),
			);
			mergeAdjacentRuns(paragraph.runs);
		} else {
			// Host paragraph keeps the text before the caret + first payload
			// paragraph; the rest of the host moves to the last inserted one
			const hostTail = paragraph.runs.slice(cursorPosition.run + 1);
			paragraph.runs.splice(
				cursorPosition.run,
				paragraph.runs.length - cursorPosition.run,
				...[before, ...firstRuns].filter((r): r is TextRun => r !== null),
			);
			mergeAdjacentRuns(paragraph.runs);

			const newParagraphs = payload.paragraphs.slice(1).map((p) => ({
				...paragraph,
				spacing: { ...paragraph.spacing },
				runs: p.runs.map(cloneRun),
			}));
			const lastParagraph = newParagraphs.at(-1)!;
			lastParagraph.runs.push(
				...[after, ...hostTail].filter((r): r is TextRun => r !== null),
			);
			mergeAdjacentRuns(lastParagraph.runs);
			textElement.content.paragraphs.splice(
				cursorPosition.paragraph + 1,
				0,
				...newParagraphs,
			);
		}

		this.editState.cursorPosition = this.charIndexToCursorPosition(
			absoluteBefore + insertedLength,
		);
		this.requestRender();
		this.persistAndSync(textElement);
	}

	// --- IME Composition Methods ---

	public startComposition(): void {
		if (!this.editState) return;
		this.editState.isComposing = true;
		this.editState.compositionText = "";

		const { cursorPosition, textElement } = this.editState;
		const run =
			textElement.content.paragraphs[cursorPosition.paragraph]?.runs[
				cursorPosition.run
			];
		this.compositionAnchor = run
			? {
					paragraph: cursorPosition.paragraph,
					run: cursorPosition.run,
					char: cursorPosition.char,
					originalRunText: run.text,
				}
			: null;
	}

	public updateComposition(text: string): void {
		if (!this.editState || !this.compositionAnchor) return;
		this.editState.compositionText = text;

		const anchor = this.compositionAnchor;
		const run =
			this.editState.textElement.content.paragraphs[anchor.paragraph]?.runs[
				anchor.run
			];
		if (!run) return;

		run.text =
			anchor.originalRunText.slice(0, anchor.char) +
			text +
			anchor.originalRunText.slice(anchor.char);
		// Caret advances past the composing characters (native IME behavior);
		// endComposition resets to the anchor before inserting the final text
		this.editState.cursorPosition = {
			paragraph: anchor.paragraph,
			run: anchor.run,
			char: anchor.char + text.length,
		};
		this.requestRender(true);
	}

	public endComposition(finalText: string): void {
		if (!this.editState) return;

		// Restore original run text before re-inserting
		if (this.compositionAnchor) {
			const anchor = this.compositionAnchor;
			const run =
				this.editState.textElement.content.paragraphs[anchor.paragraph]?.runs[
					anchor.run
				];
			if (run) run.text = anchor.originalRunText;
			this.editState.cursorPosition = {
				paragraph: anchor.paragraph,
				run: anchor.run,
				char: anchor.char,
			};
		}

		this.editState.isComposing = false;
		this.editState.compositionText = "";
		this.compositionAnchor = null;

		if (finalText) {
			// Route through insertText so the caret-staged style, selection
			// replacement and persistence apply to IME input exactly like
			// direct keystrokes
			this.insertText(finalText);
			return;
		}

		this.requestRender();
	}

	public enterEditModeForElement(textElement: TextElement): void {
		if (this.editState) {
			this.exitEditMode();
		}
		this.enterEditMode(textElement);
	}

	/**
	 * Commit the current edit session (Escape / Cmd+Enter from the hidden
	 * textarea). Runs the full exit path — persist/delete, editEnd, overlay
	 * refresh — so editState never outlives the visible edit UI.
	 */
	public commitEditing(): void {
		if (!this.editState) return;
		this.exitEditMode();
	}

	// --- Touch-type mode (per-char move/rotate/scale) ---

	public setCharTouchMode(enabled: boolean): void {
		if (this.charTouchMode === enabled) return;
		this.charTouchMode = enabled;

		if (!enabled) {
			this.charTouch = null;
			this.clearCharTouchMarquee();
			this.options.previewUpdate?.(null);
			this.context.uiSetOverlay(OVERLAY_KEYS.textCharTouch, null);
			return;
		}

		// Entering from an edit session: seed the char selection from the text
		// selection, then end the edit (persisting it)
		let element: TextElement | null = null;
		const seed = new Set<number>();
		if (this.editState) {
			element = this.editState.textElement;
			const range = this.editState.selectionRange;
			if (range) {
				const a = this.getAbsoluteCharIndex(range.start);
				const b = this.getAbsoluteCharIndex(range.end);
				for (let i = Math.min(a, b); i < Math.max(a, b); i++) seed.add(i);
			}
			this.exitEditMode();
		}
		this.resetInteraction();

		if (element) {
			this.charTouch = {
				textElement: element,
				selectedCharIndices: seed,
				quads: new Map(),
				elementTransform: { rotation: 0, scaleX: 1, scaleY: 1 },
				drag: null,
			};
			void this.refreshCharTouchQuads();
		} else {
			this.charTouch = null;
		}
	}

	/** Leave char-touch mode and resume editing the same text element. */
	public endCharTouchToEdit(): void {
		const element = this.charTouch?.textElement ?? null;
		this.setCharTouchMode(false);
		this.context.textCharTouchModeChange(false);
		if (element) this.enterEditModeForElement(element);
	}

	/** Document changed externally (undo/redo/remote): resync the touch session */
	public refreshUI(): void {
		const session = this.charTouch;
		if (!this.charTouchMode || !session || session.drag) return;
		const latest = this.context.getElement(session.textElement.id);
		if (latest?.type === "text") {
			session.textElement = latest as TextElement;
			// Resize the screen-sized skew icon to the new zoom now (quads are
			// unchanged); the async re-fetch below only matters on content edits.
			if (session.quads.size > 0) {
				this.setCharTouchOverlay([...session.quads.values()]);
			}
			void this.refreshCharTouchQuads();
		} else if (!latest) {
			this.charTouch = null;
			this.context.uiSetOverlay(OVERLAY_KEYS.textCharTouch, null);
		}
	}

	private handleCharTouchPointerDown(
		event: PointerEventData,
		worldPos: { x: number; y: number },
	): void {
		// A fresh press supersedes any marquee still armed from a prior press,
		// so a stale rubber band can't hijack this gesture's pointer moves.
		this.clearCharTouchMarquee();
		const session = this.charTouch;

		// Refresh the working copy so undo/redo between drags can't resurrect
		// stale content
		if (session) {
			const latest = this.context.getElement(session.textElement.id);
			if (latest?.type === "text") {
				session.textElement = latest as TextElement;
			} else if (!latest) {
				this.charTouch = null;
				this.context.uiSetOverlay(OVERLAY_KEYS.textCharTouch, null);
				return;
			}
		}

		const hit = this.context.uiHitTest({ x: event.x, y: event.y });
		if (
			session &&
			hit?.overlayKey === OVERLAY_KEYS.textCharTouch &&
			hit.hitId?.startsWith(TEXT_CHAR_TOUCH_HIT_PREFIX)
		) {
			const action = hit.hitId.slice(TEXT_CHAR_TOUCH_HIT_PREFIX.length);

			if (action === "rotate") {
				const center = this.charTouchCombinedCenter(session);
				if (!center) return;
				session.drag = {
					kind: "rotate",
					center,
					startAngle: Math.atan2(worldPos.y - center.y, worldPos.x - center.x),
					bases: this.beginCharTouchDrag(session),
				};
				return;
			}

			if (action.startsWith("scale:")) {
				const center = this.charTouchCombinedCenter(session);
				if (!center) return;
				session.drag = {
					kind: "scale",
					center,
					startDist: Math.max(
						1e-3,
						Math.hypot(worldPos.x - center.x, worldPos.y - center.y),
					),
					bases: this.beginCharTouchDrag(session),
				};
				return;
			}

			if (action === "skew") {
				session.drag = {
					kind: "skew",
					startWorld: { x: worldPos.x, y: worldPos.y },
					bases: this.beginCharTouchDrag(session),
				};
				return;
			}

			if (action.startsWith("char:")) {
				const index = Number.parseInt(action.slice("char:".length), 10);
				if (Number.isNaN(index)) return;
				if (event.shiftKey) {
					if (session.selectedCharIndices.has(index)) {
						session.selectedCharIndices.delete(index);
					} else {
						session.selectedCharIndices.add(index);
					}
					void this.refreshCharTouchQuads();
					return;
				}
				if (!session.selectedCharIndices.has(index)) {
					session.selectedCharIndices = new Set([index]);
					void this.refreshCharTouchQuads();
				}
				session.drag = {
					kind: "move",
					startWorld: { x: worldPos.x, y: worldPos.y },
					bases: this.beginCharTouchDrag(session),
				};
				return;
			}
			return;
		}

		// Off the overlay: pick the glyph under the press immediately, and arm a
		// drag-to-select rubber band over the target text's glyphs. A drag past
		// the threshold promotes to the marquee (which overrides the single pick
		// on release); a plain click leaves the single pick in place.
		void this.charTouchPickGlyph(worldPos, event.shiftKey);
		const hitTarget =
			this.options.findTextAtPoint?.(worldPos.x, worldPos.y) ??
			this.charTouch?.textElement ??
			null;
		const target = hitTarget ? this.resolveFlowHead(hitTarget) : null;
		if (target) {
			this.charTouchMarquee = {
				targetId: target.id,
				startWorld: { x: worldPos.x, y: worldPos.y },
				endWorld: { x: worldPos.x, y: worldPos.y },
				additive: event.shiftKey,
				active: false,
			};
		}
	}

	private async charTouchPickGlyph(
		worldPos: { x: number; y: number },
		additive: boolean,
	): Promise<void> {
		const seq = ++this.charTouchSeq;
		// Downstream flow regions carry no content of their own: the session
		// always targets the chain head (overrides live on the head's runs,
		// glyph hit testing is chain-aware)
		const hitTarget =
			this.options.findTextAtPoint?.(worldPos.x, worldPos.y) ??
			this.charTouch?.textElement ??
			null;
		const hitElement = hitTarget ? this.resolveFlowHead(hitTarget) : null;
		if (!hitElement) {
			if (this.charTouch) {
				this.charTouch.selectedCharIndices = new Set();
				this.charTouch.quads = new Map();
				this.context.uiSetOverlay(OVERLAY_KEYS.textCharTouch, null);
			}
			return;
		}

		const index = await this.context.hitTestTextGlyph(
			hitElement,
			worldPos.x,
			worldPos.y,
		);
		if (seq !== this.charTouchSeq) return;

		if (index == null) {
			if (!additive && this.charTouch) {
				this.charTouch.selectedCharIndices = new Set();
				void this.refreshCharTouchQuads();
			}
			return;
		}

		if (!this.charTouch || this.charTouch.textElement.id !== hitElement.id) {
			this.charTouch = {
				textElement: hitElement,
				selectedCharIndices: new Set([index]),
				quads: new Map(),
				elementTransform: { rotation: 0, scaleX: 1, scaleY: 1 },
				drag: null,
			};
		} else if (additive) {
			if (this.charTouch.selectedCharIndices.has(index)) {
				this.charTouch.selectedCharIndices.delete(index);
			} else {
				this.charTouch.selectedCharIndices.add(index);
			}
		} else {
			this.charTouch.selectedCharIndices = new Set([index]);
		}
		void this.refreshCharTouchQuads();
	}

	private setCharTouchMarqueeOverlay(marquee: TextCharTouchMarquee): void {
		const data: MarqueeSelectionUIData = {
			startX: marquee.startWorld.x,
			startY: marquee.startWorld.y,
			endX: marquee.endWorld.x,
			endY: marquee.endWorld.y,
		};
		this.context.uiSetOverlay(OVERLAY_KEYS.textCharTouchMarquee, {
			zIndex: OVERLAY_Z.textCharTouchMarquee,
			primitives: buildMarqueeOverlay(data, UI_THEME),
		});
	}

	private clearCharTouchMarquee(): void {
		if (!this.charTouchMarquee) return;
		this.charTouchMarquee = null;
		this.context.uiSetOverlay(OVERLAY_KEYS.textCharTouchMarquee, null);
	}

	/** Select every glyph whose quad overlaps the drag rectangle */
	private async finalizeCharTouchMarquee(
		marquee: TextCharTouchMarquee,
	): Promise<void> {
		const seq = ++this.charTouchSeq;
		const target = this.context.getElement(marquee.targetId);
		if (target?.type !== "text") return;
		const element = target as TextElement;

		const count = contentIndexCount(element);
		if (count === 0) return;
		const { quads, elementTransform } = await this.context.getTextGlyphQuads(
			element,
			Array.from({ length: count }, (_, i) => i),
		);
		if (seq !== this.charTouchSeq) return;

		const rect = {
			minX: Math.min(marquee.startWorld.x, marquee.endWorld.x),
			maxX: Math.max(marquee.startWorld.x, marquee.endWorld.x),
			minY: Math.min(marquee.startWorld.y, marquee.endWorld.y),
			maxY: Math.max(marquee.startWorld.y, marquee.endWorld.y),
		};

		// Additive drag on the same element unions with the current selection
		const selected =
			marquee.additive && this.charTouch?.textElement.id === element.id
				? new Set(this.charTouch.selectedCharIndices)
				: new Set<number>();
		for (const quad of quads) {
			if (quadIntersectsRect(quad, rect)) selected.add(quad.charIndex);
		}

		if (selected.size === 0) {
			// Empty non-additive rubber band clears the selection
			if (!marquee.additive && this.charTouch) {
				this.charTouch.selectedCharIndices = new Set();
				void this.refreshCharTouchQuads();
			}
			return;
		}

		this.charTouch = {
			textElement: element,
			selectedCharIndices: selected,
			quads: new Map(),
			elementTransform,
			drag: null,
		};
		void this.refreshCharTouchQuads();
	}

	private handleCharTouchPointerMove(
		event: PointerEventData,
		worldPos: { x: number; y: number },
	): void {
		const marquee = this.charTouchMarquee;
		if (marquee) {
			marquee.endWorld = { x: worldPos.x, y: worldPos.y };
			if (!marquee.active) {
				const screenDist =
					Math.hypot(
						worldPos.x - marquee.startWorld.x,
						worldPos.y - marquee.startWorld.y,
					) * (this.lastZoom || 1);
				if (screenDist <= REGION_DRAG_THRESHOLD_PX) return;
				marquee.active = true;
			}
			this.setCharTouchMarqueeOverlay(marquee);
			return;
		}

		const session = this.charTouch;
		const drag = session?.drag;
		if (!session || !drag) return;

		if (drag.kind === "move") {
			let wdx = worldPos.x - drag.startWorld.x;
			let wdy = worldPos.y - drag.startWorld.y;
			// Shift constrains the move to the dominant axis
			if (event.shiftKey) {
				if (Math.abs(wdx) >= Math.abs(wdy)) {
					wdy = 0;
				} else {
					wdx = 0;
				}
			}
			const local = worldDeltaToLocal(wdx, wdy, session.elementTransform);
			// Illustrator semantics: the move IS typography — the inline axis
			// writes kerning (following chars flow along), the cross axis
			// writes baseline shift. Axes swap for vertical writing.
			const isVertical =
				session.textElement.layout.writingMode !== "horizontal-tb";
			for (const [index, base] of drag.bases) {
				const ov = ensureCharOverride(session.textElement, index);
				if (!ov) continue;
				// Tate-chu-yoko glyphs compose horizontally even in vertical
				// writing, so their axes never swap
				const swapAxes =
					isVertical && !isTateChuYokoAt(session.textElement, index);
				const inlinePx = swapAxes ? local.y : local.x;
				const crossPx = swapAxes ? local.x : local.y;
				ov.kerningAdjust = base.kerningAdjust + inlinePx / base.fontSize;
				ov.baselineShift = base.baselineShift + crossPx;
			}
			this.previewCharTouchDrag(session, (quad) =>
				translateQuad(quad, wdx, wdy),
			);
			return;
		}

		if (drag.kind === "rotate") {
			const angle = Math.atan2(
				worldPos.y - drag.center.y,
				worldPos.x - drag.center.x,
			);
			let delta = angle - drag.startAngle;
			if (event.shiftKey) {
				const snap = Math.PI / 12; // 15°
				delta = Math.round(delta / snap) * snap;
			}
			const deltaDeg = (delta * 180) / Math.PI;
			for (const [index, base] of drag.bases) {
				const ov = ensureCharOverride(session.textElement, index);
				if (!ov) continue;
				ov.rotation = base.rotation + deltaDeg;
			}
			this.previewCharTouchDrag(session, (quad) => rotateQuad(quad, delta));
			return;
		}

		if (drag.kind === "skew") {
			let wdx = worldPos.x - drag.startWorld.x;
			let wdy = worldPos.y - drag.startWorld.y;
			// Shift locks the shear to the dominant drag axis (skewX- or skewY-only)
			if (event.shiftKey) {
				if (Math.abs(wdx) >= Math.abs(wdy)) {
					wdy = 0;
				} else {
					wdx = 0;
				}
			}
			const local = worldDeltaToLocal(wdx, wdy, session.elementTransform);
			const bounds = combinedQuadBounds([...session.quads.values()]);
			const refH = Math.max(bounds ? (bounds.maxY - bounds.minY) / 2 : 0, 1e-3);
			const refW = Math.max(bounds ? (bounds.maxX - bounds.minX) / 2 : 0, 1e-3);
			// Horizontal drag shears x-by-y (skewX), vertical drag shears y-by-x
			// (skewY); atan maps the drag against the selection half-extent to an angle.
			const dSkewXDeg = (Math.atan(local.x / refH) * 180) / Math.PI;
			const dSkewYDeg = (Math.atan(local.y / refW) * 180) / Math.PI;
			for (const [index, base] of drag.bases) {
				const ov = ensureCharOverride(session.textElement, index);
				if (!ov) continue;
				ov.skewX = base.skewX + dSkewXDeg;
				ov.skewY = base.skewY + dSkewYDeg;
			}
			this.previewCharTouchDrag(session, (quad) =>
				skewQuad(
					quad,
					(dSkewXDeg * Math.PI) / 180,
					(dSkewYDeg * Math.PI) / 180,
				),
			);
			return;
		}

		const dist = Math.max(
			1e-3,
			Math.hypot(worldPos.x - drag.center.x, worldPos.y - drag.center.y),
		);
		const factor = clampCharTouchScale(dist / drag.startDist);
		for (const [index, base] of drag.bases) {
			const ov = ensureCharOverride(session.textElement, index);
			if (!ov) continue;
			ov.sizeMultiplier = clampCharTouchScale(base.sizeMultiplier * factor);
		}
		this.previewCharTouchDrag(session, (quad) => scaleQuad(quad, factor));
	}

	private handleCharTouchPointerUp(): void {
		const marquee = this.charTouchMarquee;
		if (marquee) {
			this.clearCharTouchMarquee();
			// The single-glyph pick already fired on pointer-down; only a
			// promoted drag replaces it with the marquee selection.
			if (marquee.active) void this.finalizeCharTouchMarquee(marquee);
			return;
		}

		const session = this.charTouch;
		if (!session?.drag) return;
		session.drag = null;

		const latest = this.context.textCharTouchCommit(session.textElement);
		if (latest) session.textElement = latest;
		// Drop the drag preview override; the committed element renders now
		this.options.previewUpdate?.(null);
		void this.refreshCharTouchQuads();
	}

	/** Current adjustment values of the touch selection (undefined = mixed) */
	public getCharTouchSelection(): {
		count: number;
		/** Effective font size in px (run size × per-char multiplier) */
		fontSize?: number;
		kerningAdjust?: number;
		rotation?: number;
		skewX?: number;
		skewY?: number;
		lineHeight?: number;
	} | null {
		const session = this.charTouch;
		if (!this.charTouchMode || !session) return null;
		const indices = [...session.selectedCharIndices];
		if (indices.length === 0) return { count: 0 };

		const el = session.textElement;
		const pick = (get: (index: number) => number): number | undefined => {
			const first = get(indices[0]);
			return indices.every((i) => get(i) === first) ? first : undefined;
		};
		return {
			count: indices.length,
			fontSize: pick(
				(i) =>
					resolveCharFontSize(el, i) *
					(findCharOverride(el, i)?.sizeMultiplier ?? 1),
			),
			kerningAdjust: pick((i) => findCharOverride(el, i)?.kerningAdjust ?? 0),
			rotation: pick((i) => findCharOverride(el, i)?.rotation ?? 0),
			skewX: pick((i) => findCharOverride(el, i)?.skewX ?? 0),
			skewY: pick((i) => findCharOverride(el, i)?.skewY ?? 0),
			lineHeight: pick((i) => resolveCharLineHeight(el, i)),
		};
	}

	/**
	 * Absolute-value adjustments from the panel, applied to every selected
	 * char and persisted (input changes are discrete; each call is one commit)
	 */
	public setCharTouchValues(values: {
		/** Target effective font size in px (stored as a per-char multiplier) */
		fontSize?: number;
		kerningAdjust?: number;
		rotation?: number;
		/** Horizontal shear angle in degrees */
		skewX?: number;
		/** Vertical shear angle in degrees */
		skewY?: number;
		lineHeight?: number;
	}): void {
		const session = this.charTouch;
		if (!this.charTouchMode || !session) return;
		if (session.selectedCharIndices.size === 0) return;

		session.textElement = deepClone(session.textElement);
		// Descending order keeps earlier positions valid across run splits
		const indices = [...session.selectedCharIndices].sort((a, b) => b - a);
		for (const index of indices) {
			if (values.lineHeight !== undefined) {
				applyRunStyleAtChar(session.textElement, index, {
					lineHeight: Math.max(0.1, values.lineHeight),
				});
			}
			const ov = ensureCharOverride(session.textElement, index);
			if (!ov) continue;
			if (values.fontSize !== undefined && values.fontSize > 0) {
				const runSize = resolveCharFontSize(session.textElement, index);
				ov.sizeMultiplier = clampCharTouchScale(values.fontSize / runSize);
			}
			if (values.kerningAdjust !== undefined) {
				ov.kerningAdjust = values.kerningAdjust;
			}
			if (values.rotation !== undefined) {
				ov.rotation = values.rotation;
			}
			if (values.skewX !== undefined) {
				ov.skewX = values.skewX;
			}
			if (values.skewY !== undefined) {
				ov.skewY = values.skewY;
			}
		}

		const latest = this.context.textCharTouchCommit(session.textElement);
		if (latest) session.textElement = latest;
		this.options.previewUpdate?.(null);
		void this.refreshCharTouchQuads();
	}

	/** Remove every per-char override from the selected characters (touch-type style reset) */
	public resetCharTouchValues(): void {
		const session = this.charTouch;
		if (!this.charTouchMode || !session) return;
		if (session.selectedCharIndices.size === 0) return;

		session.textElement = deepClone(session.textElement);
		let changed = false;
		for (const index of session.selectedCharIndices) {
			const loc = charIndexToRunLocal(session.textElement, index);
			if (!loc) continue;
			const run =
				session.textElement.content.paragraphs[loc.paragraph].runs[loc.run];
			if (!run.charOverrides?.some((o) => o.charIndex === loc.char)) continue;
			run.charOverrides = run.charOverrides.filter(
				(o) => o.charIndex !== loc.char,
			);
			changed = true;
		}
		if (!changed) return;

		const latest = this.context.textCharTouchCommit(session.textElement);
		if (latest) session.textElement = latest;
		this.options.previewUpdate?.(null);
		void this.refreshCharTouchQuads();
	}

	/** Clone the working copy and capture pre-drag override values */
	private beginCharTouchDrag(
		session: TextCharTouchSession,
	): Map<number, TextCharTouchBase> {
		// valtio's deepClone: the working copy may be a store proxy, which
		// structuredClone rejects (DataCloneError)
		session.textElement = deepClone(session.textElement);
		const bases = new Map<number, TextCharTouchBase>();
		for (const index of session.selectedCharIndices) {
			const ov = findCharOverride(session.textElement, index);
			bases.set(index, {
				kerningAdjust: ov?.kerningAdjust ?? 0,
				baselineShift: ov?.baselineShift ?? 0,
				rotation: ov?.rotation ?? 0,
				skewX: ov?.skewX ?? 0,
				skewY: ov?.skewY ?? 0,
				sizeMultiplier: ov?.sizeMultiplier ?? 1,
				fontSize: resolveCharFontSize(session.textElement, index),
			});
		}
		return bases;
	}

	/** Live-preview the drag: real glyphs re-layout, overlay follows in sync */
	private previewCharTouchDrag(
		session: TextCharTouchSession,
		transformQuad: (quad: TextGlyphQuad) => TextGlyphQuad,
	): void {
		this.options.previewUpdate?.(session.textElement);
		this.setCharTouchOverlay(
			[...session.quads.values()].map((quad) => transformQuad(quad)),
		);
	}

	private charTouchCombinedCenter(
		session: TextCharTouchSession,
	): { x: number; y: number } | null {
		const bounds = combinedQuadBounds([...session.quads.values()]);
		if (!bounds) return null;
		return {
			x: (bounds.minX + bounds.maxX) / 2,
			y: (bounds.minY + bounds.maxY) / 2,
		};
	}

	private async refreshCharTouchQuads(): Promise<void> {
		const session = this.charTouch;
		if (!session) return;
		const seq = ++this.charTouchSeq;
		const indices = [...session.selectedCharIndices];
		if (indices.length === 0) {
			session.quads = new Map();
			this.context.uiSetOverlay(OVERLAY_KEYS.textCharTouch, null);
			return;
		}
		const result = await this.context.getTextGlyphQuads(
			session.textElement,
			indices,
		);
		if (this.charTouch !== session || seq !== this.charTouchSeq) return;
		session.quads = new Map(result.quads.map((q) => [q.charIndex, q]));
		session.elementTransform = result.elementTransform;
		this.setCharTouchOverlay([...session.quads.values()]);
	}

	private setCharTouchOverlay(quads: TextGlyphQuad[]): void {
		const bounds = combinedQuadBounds(quads);
		// Live zoom, not the pointer-updated lastZoom: the "/" icon divides
		// screen px by it, so a zoom-only change must still size it right.
		const zoom = this.context.getViewport()?.viewport.zoom ?? this.lastZoom;
		this.context.uiSetOverlay(
			OVERLAY_KEYS.textCharTouch,
			bounds
				? {
						zIndex: OVERLAY_Z.textCharTouch,
						primitives: buildTextCharTouchOverlay(
							{ quads, combinedBounds: bounds },
							UI_THEME,
							zoom,
						),
					}
				: null,
		);
	}

	public getCursor(): string {
		return this.editState || this.hoveredTextId ? "text" : "crosshair";
	}

	// --- Private Methods ---

	private buildTextElement(position: { x: number; y: number }): TextElement {
		return {
			type: "text",
			id: generateUid("obj"),
			x: position.x,
			y: position.y,
			transform: createIdentityTransform(),
			content: this.createDefaultContent(),
			defaultStyle: { ...this.options.defaultStyle },
			layout: this.createDefaultLayout(),
			opacity: 1,
			blendMode: "normal" as BlendMode,
			filters: [
				{
					uid: generateUid("app"),
					processor: "content",
					opacity: 1,
					blendMode: "normal",
					paramData: { version: "1", params: {} },
				},
			],
		};
	}

	private createNewText(position: { x: number; y: number }): void {
		const textElement = this.buildTextElement(position);
		this.enterEditMode(textElement);
		this.options.textCreate?.(textElement);
	}

	/** Drag-created fixed-box text region (wraps and clips its content) */
	private createRegionText(
		a: { x: number; y: number },
		b: { x: number; y: number },
	): void {
		// World is Y-up: the element anchor is the top-left corner
		const textElement = this.buildTextElement({
			x: Math.min(a.x, b.x),
			y: Math.max(a.y, b.y),
		});
		textElement.layout = {
			...textElement.layout,
			boxWidth: Math.abs(b.x - a.x),
			boxHeight: Math.abs(b.y - a.y),
			wordWrap: true,
			overflow: "hidden",
		};
		this.enterEditMode(textElement);
		this.options.textCreate?.(textElement);
	}

	/**
	 * Click on a path outline creates a bound text: open path → text on
	 * path, closed path → area text flowed inside the shape. Only outline
	 * clicks count — interior clicks of filled shapes keep creating plain
	 * point text (findPathAtPoint reports fill hits for closed paths).
	 */
	private tryCreateTextBoundToPath(
		worldPos: { x: number; y: number },
		viewport: Viewport,
	): boolean {
		const path = this.context.findPathAtPoint(worldPos.x, worldPos.y, 5, true);
		if (!path || path.locked) return false;

		const worldSegments = this.context.getElementWorldSegments(path.id);
		if (!worldSegments || worldSegments.length === 0) return false;
		const tolerance = UI_THEME.hitTolerancePx / (viewport.zoom || 1);
		if (distanceToOutline(worldSegments, worldPos) > tolerance) return false;

		const mode = classifyPathForTextBinding(path.segments);
		const binding: TextAxisBinding =
			mode === "onPath"
				? {
						mode,
						pathObjectId: path.id,
						startOffset: 0,
						alignment: "left",
						offsetDistance: 0,
						orientation: "rotate",
					}
				: { mode, pathObjectId: path.id };

		const bounds = this.context.getBounds(path.id);
		const anchor = bounds ? { x: bounds.minX, y: bounds.maxY } : worldPos;
		const textElement = this.buildTextElement(anchor);
		textElement.axisBinding = binding;

		this.enterEditMode(textElement);
		this.options.textCreateOnPath?.(textElement, path.id, mode, worldPos);
		return true;
	}

	// --- Flow linking (■ handle interactions) ---

	/** Walk flow.nextTextElementId sources upstream to the chain head */
	private resolveFlowHead(element: TextElement): TextElement {
		let head = element;
		const visited = new Set<string>([element.id]);
		for (;;) {
			const source = this.options.textFindFlowSource?.(head.id);
			if (!source || visited.has(source.id)) return head;
			visited.add(source.id);
			head = source;
		}
	}

	private findLinkTarget(worldPos: {
		x: number;
		y: number;
	}): TextElement | null {
		const byGlyph = this.options.findTextAtPoint?.(worldPos.x, worldPos.y);
		if (byGlyph) return byGlyph;
		// Empty regions have no glyphs: fall back to bounds-based element hit
		const byBounds = this.context.findElementAtPoint(worldPos.x, worldPos.y);
		return byBounds?.type === "text" ? byBounds : null;
	}

	private finishFlowLinking(worldPos: { x: number; y: number }): void {
		if (this.interaction.kind !== "flowLinking") return;
		const { sourceTextId } = this.interaction;
		this.resetInteraction();

		const target = this.findLinkTarget(worldPos);
		if (!target || target.id === sourceTextId) return;
		// Reject a second inflow into the target
		if (this.options.textFindFlowSource?.(target.id)) return;
		// Reject cycles: the target must not be upstream of the source
		let cursorId = sourceTextId;
		const visited = new Set<string>([sourceTextId]);
		for (;;) {
			const source = this.options.textFindFlowSource?.(cursorId);
			if (!source || visited.has(source.id)) break;
			if (source.id === target.id) return;
			visited.add(source.id);
			cursorId = source.id;
		}

		this.options.textFlowLink?.(sourceTextId, target.id);
		this.updateFlowHandleOverlay();
	}

	private updateFlowLinkPreview(worldPos: { x: number; y: number }): void {
		if (this.interaction.kind !== "flowLinking") return;
		const { sourceTextId } = this.interaction;
		const sourceBounds = this.context.getBounds(sourceTextId);
		const from = sourceBounds
			? { x: sourceBounds.maxX, y: sourceBounds.minY }
			: worldPos;
		const target = this.findLinkTarget(worldPos);
		const targetBounds =
			target && target.id !== sourceTextId
				? this.context.getBounds(target.id)
				: null;
		// Every other text shows a translucent bbox; the hovered one is opaque
		const candidateBounds = this.context
			.listTextElements()
			.filter((el) => el.id !== sourceTextId && el.id !== target?.id)
			.flatMap((el) => {
				const bounds = this.context.getBounds(el.id);
				return bounds ? [bounds] : [];
			});
		this.context.uiSetOverlay(OVERLAY_KEYS.textFlowLinkPreview, {
			zIndex: OVERLAY_Z.textFlow,
			primitives: buildTextFlowLinkPreview(
				{ from, to: worldPos, targetBounds, candidateBounds },
				UI_THEME,
			),
		});
	}

	private updateRegionPreview(): void {
		if (this.interaction.kind !== "regionDragging") return;
		const { startWorld, currentWorld } = this.interaction;
		this.context.uiSetOverlay(OVERLAY_KEYS.textRegionPreview, {
			zIndex: OVERLAY_Z.marquee,
			primitives: buildTextRegionPreview(
				{
					x0: startWorld.x,
					y0: startWorld.y,
					x1: currentWorld.x,
					y1: currentWorld.y,
				},
				UI_THEME,
			),
		});
	}

	/**
	 * ■ handles on the edited and hovered texts. Only flow-capable texts
	 * (fixed box, path-bound, or already chained) get a handle — auto-sized
	 * point text has no overflow to link.
	 */
	private updateFlowHandleOverlay(): void {
		const handles: TextFlowHandleData[] = [];
		const seen = new Set<string>();
		for (const element of [this.editState?.textElement, this.hoveredText]) {
			if (!element || seen.has(element.id)) continue;
			seen.add(element.id);
			if (!isFlowCapableText(element)) continue;
			const bounds = this.context.getBounds(element.id);
			if (!bounds) continue;
			handles.push({
				textId: element.id,
				corner: { x: bounds.maxX, y: bounds.minY },
				linked: !!element.flow?.nextTextElementId,
			});
		}
		this.context.uiSetOverlay(
			OVERLAY_KEYS.textFlowHandles,
			handles.length > 0
				? {
						zIndex: OVERLAY_Z.textFlow,
						primitives: buildTextFlowHandles(handles, UI_THEME),
					}
				: null,
		);
		this.updateFlowChainOverlay();
	}

	/**
	 * Dashed connectors between chained regions, visible while any member of
	 * the chain is hovered or edited.
	 */
	private updateFlowChainOverlay(): void {
		const chains = new Map<string, TextElement[]>();
		for (const seed of [this.editState?.textElement, this.hoveredText]) {
			if (!seed) continue;
			const members = this.context.textChainMembers(seed.id);
			if (members.length > 1) chains.set(members[0].id, members);
		}

		const links: Array<{
			from: { x: number; y: number };
			to: { x: number; y: number };
		}> = [];
		for (const members of chains.values()) {
			for (let i = 0; i + 1 < members.length; i++) {
				const a = this.context.getBounds(members[i].id);
				const b = this.context.getBounds(members[i + 1].id);
				if (!a || !b) continue;
				// Out corner (bottom-right, where the ■ handle sits) → in corner
				links.push({
					from: { x: a.maxX, y: a.minY },
					to: { x: b.minX, y: b.maxY },
				});
			}
		}

		this.context.uiSetOverlay(
			OVERLAY_KEYS.textFlowChain,
			links.length > 0
				? {
						zIndex: OVERLAY_Z.textFlow,
						primitives: buildTextFlowChainLinks(
							links,
							CHAIN_DASH_SCREEN_PX / this.lastZoom,
							UI_THEME,
						),
					}
				: null,
		);
	}

	private resetInteraction(): void {
		this.interaction = { kind: "idle" };
		this.context.uiSetOverlay(OVERLAY_KEYS.textRegionPreview, null);
		this.context.uiSetOverlay(OVERLAY_KEYS.textFlowLinkPreview, null);
	}

	private createDefaultContent(): TextContent {
		return {
			paragraphs: [
				{
					runs: [
						{
							text: "",
							style: { ...this.options.defaultStyle },
						},
					],
					alignment: "left",
					lineHeight: 1.2,
					indent: 0,
					spacing: { before: 0, after: 0 },
				},
			],
		};
	}

	private createDefaultLayout(): TextLayout {
		return {
			writingMode: "horizontal-tb",
			boxWidth: "auto",
			boxHeight: "auto",
			overflow: "visible",
			wordWrap: false,
		};
	}

	private enterEditMode(textElement: TextElement): void {
		this.editState = {
			textElement,
			cursorPosition: { paragraph: 0, run: 0, char: 0 },
			selectionRange: null,
			isEditing: true,
			isComposing: false,
			compositionText: "",
		};
		this.pendingCaretStyle = null;

		this.options.hoverUpdate?.(null);
		this.options.editStart?.(textElement);
		this.notifySelectionStyleChange();
		this.updateFlowHandleOverlay();
	}

	/**
	 * テキスト要素のクリック位置で編集モードに入る
	 */
	private enterEditModeAtPosition(
		textElement: TextElement,
		worldX: number,
		worldY: number,
	): void {
		this.enterEditMode(textElement);
		this.moveCursorToWorldPosition(textElement, worldX, worldY);
	}

	/**
	 * WORLD座標のクリック位置に対応する文字インデックスにカーソルを移動
	 */
	private moveCursorToWorldPosition(
		textElement: TextElement,
		worldX: number,
		worldY: number,
	): void {
		if (!this.options.hitTestCharacter) return;

		// Show cursor immediately so it doesn't flicker during async hit-test
		this.controller?.showCursorImmediate();

		// Capture sequence so we can abort if drag selection starts before this resolves
		const seq = ++this.hitTestSeq;

		// Callback handles world→local conversion (including element transform)
		this.options
			.hitTestCharacter(textElement, worldX, worldY)
			.then((charIndex) => {
				// Drag has started (startOrExtendSelection incremented hitTestSeq) — abort
				if (seq !== this.hitTestSeq) return;
				if (!this.editState || this.editState.textElement.id !== textElement.id)
					return;

				if (charIndex != null) {
					this.pendingCaretStyle = null;
					this.editState.cursorPosition =
						this.charIndexToCursorPosition(charIndex);
					this.editState.selectionRange = null;
					// Keep cursor visible across the second async gap
					// (getCursorWorldPosition inside requestRender)
					this.controller?.showCursorImmediate();
					this.requestRender(false);
				}
			})
			.catch(() => {
				// Ensure cursor stays visible even if hit-test fails
				this.controller?.showCursorImmediate();
			});
	}

	/**
	 * 絶対文字インデックスからCursorPositionに変換
	 */
	private charIndexToCursorPosition(charIndex: number): CursorPosition {
		if (!this.editState) return { paragraph: 0, run: 0, char: 0 };

		const { textElement } = this.editState;
		let remaining = charIndex;

		for (let p = 0; p < textElement.content.paragraphs.length; p++) {
			const para = textElement.content.paragraphs[p];
			for (let r = 0; r < para.runs.length; r++) {
				const run = para.runs[r];
				if (remaining <= run.text.length) {
					return { paragraph: p, run: r, char: remaining };
				}
				remaining -= run.text.length;
			}
			remaining--; // paragraph間の改行
		}

		// 末尾を返す
		const lastPara = textElement.content.paragraphs.at(-1);
		if (lastPara) {
			const lastRun = lastPara.runs.at(-1);
			return {
				paragraph: textElement.content.paragraphs.length - 1,
				run: lastPara.runs.length - 1,
				char: lastRun?.text.length ?? 0,
			};
		}

		return { paragraph: 0, run: 0, char: 0 };
	}

	/**
	 * Start or extend text selection to a world position
	 */
	private startOrExtendSelection(worldX: number, worldY: number): void {
		if (!this.editState || !this.options.hitTestCharacter) return;
		this.pendingCaretStyle = null;

		this.hitTestSeq++;
		const te = this.editState.textElement;

		if (!this.editState.selectionRange && this.dragAnchorWorldPos) {
			// First drag: resolve anchor position and current position together
			const anchor = this.dragAnchorWorldPos;
			const seq = this.hitTestSeq;
			Promise.all([
				this.options.hitTestCharacter(te, anchor.x, anchor.y),
				this.options.hitTestCharacter(te, worldX, worldY),
			])
				.then(([anchorIndex, currentIndex]) => {
					if (seq !== this.hitTestSeq) return;
					if (!this.editState || this.editState.textElement.id !== te.id)
						return;
					if (anchorIndex == null || currentIndex == null) return;

					this.editState.selectionRange = {
						start: this.charIndexToCursorPosition(anchorIndex),
						end: this.charIndexToCursorPosition(currentIndex),
					};
					this.editState.cursorPosition =
						this.charIndexToCursorPosition(currentIndex);
					this.requestRender(false);
				})
				.catch(() => {});
			return;
		}

		const seq = this.hitTestSeq;
		this.options
			.hitTestCharacter(te, worldX, worldY)
			.then((charIndex) => {
				if (seq !== this.hitTestSeq) return;
				if (!this.editState || this.editState.textElement.id !== te.id) return;
				if (charIndex == null) return;

				if (!this.editState.selectionRange) {
					// Fallback: anchor not available, use current cursor position
					this.editState.selectionRange = {
						start: { ...this.editState.cursorPosition },
						end: this.charIndexToCursorPosition(charIndex),
					};
				} else {
					this.editState.selectionRange.end =
						this.charIndexToCursorPosition(charIndex);
				}

				this.editState.cursorPosition =
					this.charIndexToCursorPosition(charIndex);
				this.requestRender(false);
			})
			.catch(() => {});
	}

	/**
	 * Extend the selection to a world position, anchoring at the existing
	 * selection start or the current caret (Shift+click). Unlike
	 * startOrExtendSelection, the anchor is a caret position rather than a
	 * pending drag world position.
	 */
	private extendSelectionToWorldPosition(worldX: number, worldY: number): void {
		if (!this.editState || !this.options.hitTestCharacter) return;
		this.pendingCaretStyle = null;

		const anchor = {
			...(this.editState.selectionRange?.start ??
				this.editState.cursorPosition),
		};
		const te = this.editState.textElement;
		const seq = ++this.hitTestSeq;
		this.options
			.hitTestCharacter(te, worldX, worldY)
			.then((charIndex) => {
				if (seq !== this.hitTestSeq) return;
				if (!this.editState || this.editState.textElement.id !== te.id) return;
				if (charIndex == null) return;

				const end = this.charIndexToCursorPosition(charIndex);
				this.editState.selectionRange = { start: anchor, end };
				this.editState.cursorPosition = end;
				this.controller?.showCursorImmediate();
				this.requestRender(false);
			})
			.catch(() => {});
	}

	private exitEditMode(): void {
		if (!this.editState) return;

		// Restore original run text if IME composition was in progress
		if (this.compositionAnchor) {
			const anchor = this.compositionAnchor;
			const para =
				this.editState.textElement.content.paragraphs[anchor.paragraph];
			const run = para?.runs[anchor.run];
			if (run) run.text = anchor.originalRunText;
			this.compositionAnchor = null;
		}

		// Delete empty text elements — except flow-capable ones (fixed-box
		// regions, path-bound texts, chained regions), which stay as empty
		// vessels so text can be flowed into them later
		if (
			this.isTextEmpty(this.editState.textElement) &&
			!isFlowCapableText(this.editState.textElement)
		) {
			this.options.textDelete?.(this.editState.textElement.id);
		} else {
			// A style picked with no selection is staged on pendingCaretStyle
			// for the next typed character. If nothing was typed, flush it
			// into the (still empty) run and defaultStyle so it isn't lost.
			if (this.pendingCaretStyle) {
				const { textElement, cursorPosition } = this.editState;
				const run =
					textElement.content.paragraphs[cursorPosition.paragraph]?.runs[
						cursorPosition.run
					];
				if (run && run.text === "") {
					run.style = { ...run.style, ...this.pendingCaretStyle };
				}
				textElement.defaultStyle = {
					...textElement.defaultStyle,
					...this.pendingCaretStyle,
				};
			}
			this.options.textComplete?.(this.editState.textElement);
		}

		this.editState = null;
		this.pendingCaretStyle = null;
		this.isDragging = false;
		this.dragAnchorWorldPos = null;
		this.options.editEnd?.();
		this.updateFlowHandleOverlay();
	}

	private isTextEmpty(text: TextElement): boolean {
		for (const para of text.content.paragraphs) {
			for (const run of para.runs) {
				if (run.text.length > 0) return false;
			}
		}
		return true;
	}

	public get editingElementId(): string | null {
		return this.editState?.textElement.id ?? null;
	}

	/** Clamp cursor position to valid range after external content changes (e.g. Undo).
	 * When latestTextElement is provided, editState.textElement is replaced
	 * and cursor moves to the end of the content. */
	public clampCursorToContent(latestTextElement?: TextElement): void {
		if (!this.editState) return;
		if (latestTextElement) {
			const oldElement = this.editState.textElement;
			this.editState.textElement = latestTextElement;
			this.moveCursorToDiffEnd(oldElement, latestTextElement);
			this.editState.selectionRange = null;
			this.requestRender(true);
			return;
		}

		const { textElement, cursorPosition } = this.editState;
		const paras = textElement.content.paragraphs;
		if (paras.length === 0) return;

		if (cursorPosition.paragraph >= paras.length) {
			cursorPosition.paragraph = paras.length - 1;
		}
		const para = paras[cursorPosition.paragraph];

		if (cursorPosition.run >= para.runs.length) {
			cursorPosition.run = Math.max(0, para.runs.length - 1);
		}
		const run = para.runs[cursorPosition.run];

		if (run && cursorPosition.char > run.text.length) {
			cursorPosition.char = run.text.length;
		}

		this.editState.selectionRange = null;
		this.requestRender(false);
	}

	/** Find where old and new text diverge and place cursor at the divergence point in new text. */
	private moveCursorToDiffEnd(
		oldElement: TextElement,
		newElement: TextElement,
	): void {
		if (!this.editState) return;

		const oldChars = this.flattenText(oldElement);
		const newChars = this.flattenText(newElement);

		// Find first difference
		let diffIdx = 0;
		const minLen = Math.min(oldChars.length, newChars.length);
		while (diffIdx < minLen && oldChars[diffIdx] === newChars[diffIdx]) {
			diffIdx++;
		}

		// If new text is longer or same, cursor goes after the inserted text
		// If new text is shorter (undo removed text), cursor goes at the diff point
		const targetCharIdx =
			newChars.length >= oldChars.length
				? diffIdx + (newChars.length - oldChars.length)
				: diffIdx;

		this.editState.cursorPosition = this.charIndexToCursorPosition(
			Math.min(targetCharIdx, newChars.length),
		);
	}

	private flattenText(element: TextElement): string {
		let text = "";
		for (const para of element.content.paragraphs) {
			if (text.length > 0) text += "\n";
			for (const run of para.runs) {
				text += run.text;
			}
		}
		return text;
	}

	private persistAndSync(textElement: TextElement): void {
		if (!this.editState) return;
		const latest = this.options.persistTextEdit?.(textElement);
		if (latest) this.editState.textElement = latest;
	}

	private requestRender(invalidateTextCache = true): void {
		if (invalidateTextCache) {
			this.options.previewUpdate?.(this.editState?.textElement ?? null);
		}
		this.notifyCursorUpdate();
		this.notifySelectionRangeChange();
		this.notifySelectionStyleChange();
	}

	/**
	 * Notify cursor position update to external UI
	 */
	private notifyCursorUpdate(): void {
		if (!this.editState || !this.options.updateTextCursor) return;

		const { textElement } = this.editState;
		const charIndex = this.getCursorCharIndex();

		if (this.options.getCursorWorldPosition) {
			// Sequence guard: rapid keystrokes put multiple lookups in flight —
			// a stale resolution must not overwrite a newer caret position
			const seq = ++this.cursorUpdateSeq;
			// TextRenderer経由で正確なカーソル座標を取得
			this.options
				.getCursorWorldPosition(textElement, charIndex)
				.then((pos) => {
					if (seq !== this.cursorUpdateSeq) return;
					this.options.updateTextCursor?.(
						charIndex,
						pos.x,
						pos.y,
						pos.height,
						pos.rotation,
					);
				})
				.catch(() => {
					if (seq !== this.cursorUpdateSeq) return;
					// Fallback to approximate position on error
					const cursorWorld = this.calculateCursorWorldPosition();
					this.options.updateTextCursor?.(
						charIndex,
						cursorWorld.x,
						cursorWorld.y,
						textElement.defaultStyle.fontSize,
					);
				});
		} else {
			// フォールバック: 近似計算
			const cursorWorld = this.calculateCursorWorldPosition();
			this.options.updateTextCursor(
				charIndex,
				cursorWorld.x,
				cursorWorld.y,
				textElement.defaultStyle.fontSize,
			);
		}
	}

	/**
	 * Calculate cursor world position based on text content
	 * This is an approximation - proper implementation would use layout info
	 */
	private calculateCursorWorldPosition(): { x: number; y: number } {
		if (!this.editState) return { x: 0, y: 0 };

		const { textElement, cursorPosition } = this.editState;
		const { x, y } = textElement;
		const fontSize = textElement.defaultStyle.fontSize;
		const lineHeight = textElement.content.paragraphs[0]?.lineHeight ?? 1.2;
		const writingMode = textElement.layout.writingMode;

		// Calculate characters before cursor in current paragraph
		let charsBefore = 0;
		const paragraph = textElement.content.paragraphs[cursorPosition.paragraph];
		if (paragraph) {
			for (let r = 0; r < cursorPosition.run; r++) {
				charsBefore += paragraph.runs[r].text.length;
			}
			charsBefore += cursorPosition.char;
		}

		// Approximate character size
		// For vertical text, height is fontSize; for horizontal, width is ~0.6 * fontSize
		const avgCharWidth = fontSize * 0.6;

		if (writingMode === "vertical-rl" || writingMode === "vertical-lr") {
			// Vertical writing mode
			// Characters flow top-to-bottom, columns flow right-to-left (rl) or left-to-right (lr)
			const verticalOffset = charsBefore * fontSize;
			const columnOffset = cursorPosition.paragraph * fontSize * lineHeight;

			// World space: Y-up
			// vertical-rl: origin is top-right, columns go left
			// vertical-lr: origin is top-left, columns go right
			if (writingMode === "vertical-rl") {
				return {
					x: x - columnOffset,
					y: y - verticalOffset,
				};
			}
			// vertical-lr
			return {
				x: x + columnOffset,
				y: y - verticalOffset,
			};
		}

		// horizontal-tb (default)
		const horizontalOffset = charsBefore * avgCharWidth;
		const verticalOffset = cursorPosition.paragraph * fontSize * lineHeight;

		// World space: Y-up, text origin is top-left of first character
		return {
			x: x + horizontalOffset,
			y: y - verticalOffset,
		};
	}

	/**
	 * Get absolute character index (for uiStore compatibility)
	 */
	private getCursorCharIndex(): number {
		if (!this.editState) return 0;

		const { textElement, cursorPosition } = this.editState;
		let index = 0;

		// Count characters in paragraphs before current
		for (let p = 0; p < cursorPosition.paragraph; p++) {
			const para = textElement.content.paragraphs[p];
			for (const run of para.runs) {
				index += run.text.length;
			}
			index++; // Newline between paragraphs
		}

		// Count characters in current paragraph before cursor
		const currentPara =
			textElement.content.paragraphs[cursorPosition.paragraph];
		if (currentPara) {
			for (let r = 0; r < cursorPosition.run; r++) {
				index += currentPara.runs[r].text.length;
			}
			index += cursorPosition.char;
		}

		return index;
	}

	/**
	 * カーニング調整（選択範囲対応）
	 */
	public adjustKerning(deltaEm: number): void {
		if (!this.editState) return;

		if (this.editState.selectionRange) {
			// 選択範囲内の全文字にカーニング適用
			this.forEachCharInSelection((run, charIndex) => {
				run.charOverrides ??= [];
				let override = run.charOverrides.find((o) => o.charIndex === charIndex);
				if (!override) {
					override = { charIndex };
					run.charOverrides.push(override);
				}
				override.kerningAdjust = (override.kerningAdjust ?? 0) + deltaEm;
			});
		} else {
			// カーソル位置の1文字
			const { cursorPosition, textElement } = this.editState;
			const paragraph =
				textElement.content.paragraphs[cursorPosition.paragraph];
			if (!paragraph) return;

			const run = paragraph.runs[cursorPosition.run];
			if (!run) return;

			run.charOverrides ??= [];
			let override = run.charOverrides.find(
				(o) => o.charIndex === cursorPosition.char,
			);
			if (!override) {
				override = { charIndex: cursorPosition.char };
				run.charOverrides.push(override);
			}
			override.kerningAdjust = (override.kerningAdjust ?? 0) + deltaEm;
		}

		this.requestRender();
	}

	/**
	 * Line spacing adjustment for the lines containing the selection, or for
	 * the caret's visual line when nothing is selected. Leading is a run style
	 * (lineHeight); the layout engine advances each line by the max leading of
	 * the chars in it, so only the touched lines move (Illustrator-style).
	 */
	public adjustLineSpacing(delta: number): void {
		this.applyLineSpacingMapper((style) => ({
			lineHeight: Math.max(
				0.1,
				(style.lineHeight ??
					this.editState?.textElement.defaultStyle.lineHeight ??
					1.5) + delta,
			),
		}));
	}

	/** Absolute-value counterpart of adjustLineSpacing (ActionsPanel input) */
	public setLineSpacing(value: number): void {
		if (Number.isNaN(value)) return;
		const lineHeight = Math.max(0.1, value);
		this.applyLineSpacingMapper(() => ({ lineHeight }));
	}

	/** Apply a lineHeight mapper to the selection, or the caret's visual line */
	private applyLineSpacingMapper(
		mapLineHeight: (style: TextStyle) => Partial<TextStyle>,
	): void {
		if (!this.editState || this.editState.isComposing) return;

		const { selectionRange, textElement } = this.editState;
		if (selectionRange) {
			const { start, end } = this.normalizeSelectionRange(selectionRange);
			const origStartAbs = this.getAbsoluteCharIndex(selectionRange.start);
			const origEndAbs = this.getAbsoluteCharIndex(selectionRange.end);

			this.mapStyleInRange(start, end, mapLineHeight);

			// Restore both range and cursor from absolute indices — run
			// split/merge invalidates the stored run indices
			this.editState.selectionRange = {
				start: this.charIndexToCursorPosition(origStartAbs),
				end: this.charIndexToCursorPosition(origEndAbs),
			};
			this.editState.cursorPosition =
				this.charIndexToCursorPosition(origEndAbs);
			this.recalculateCursorPosition();
			this.requestRender();
			this.persistAndSync(textElement);
			return;
		}

		void this.adjustCaretLineSpacing(mapLineHeight);
	}

	/** No-selection line spacing: adjust the runs of the caret's visual line */
	private async adjustCaretLineSpacing(
		mapLineHeight: (style: TextStyle) => Partial<TextStyle>,
	): Promise<void> {
		if (!this.editState) return;
		const { textElement } = this.editState;

		let startIdx: number | null = null;
		let endIdx: number | null = null;
		if (this.options.getLineStartEnd) {
			const charIndex = this.getCursorCharIndex();
			[startIdx, endIdx] = await Promise.all([
				this.options.getLineStartEnd(textElement, charIndex, "start"),
				this.options.getLineStartEnd(textElement, charIndex, "end"),
			]);
			if (!this.editState || this.editState.textElement.id !== textElement.id)
				return;
		}

		let start: CursorPosition;
		let end: CursorPosition;
		if (startIdx != null && endIdx != null && endIdx > startIdx) {
			start = this.charIndexToCursorPosition(startIdx);
			end = this.charIndexToCursorPosition(endIdx);
		} else {
			// Line geometry unavailable (or empty line): fall back to the
			// caret's whole paragraph so an empty paragraph's leading is still
			// adjustable via its (empty) runs
			const { cursorPosition } = this.editState;
			const para = textElement.content.paragraphs[cursorPosition.paragraph];
			if (!para) return;
			const lastRun = para.runs.at(-1);
			start = { paragraph: cursorPosition.paragraph, run: 0, char: 0 };
			end = {
				paragraph: cursorPosition.paragraph,
				run: Math.max(0, para.runs.length - 1),
				char: lastRun?.text.length ?? 0,
			};
		}

		// Capture the caret as an absolute index while run indices are still
		// valid, and restore it after the split/merge shifts them
		const cursorAbs = this.getCursorCharIndex();
		this.mapStyleInRange(start, end, mapLineHeight);
		this.editState.cursorPosition = this.charIndexToCursorPosition(cursorAbs);
		this.recalculateCursorPosition();
		this.requestRender();
		this.persistAndSync(this.editState.textElement);
	}

	// --- Line/Document/Word navigation ---

	public moveToLineStart(shift: boolean): void {
		if (!this.editState) return;

		const { textElement } = this.editState;
		if (!this.options.getLineStartEnd) {
			// Fallback: move to run 0, char 0 in current paragraph
			this.setSelectionOrMove(shift, {
				paragraph: this.editState.cursorPosition.paragraph,
				run: 0,
				char: 0,
			});
			return;
		}

		const charIndex = this.getCursorCharIndex();
		this.options
			.getLineStartEnd(textElement, charIndex, "start")
			.then((targetIndex) => {
				if (!this.editState || this.editState.textElement.id !== textElement.id)
					return;
				if (targetIndex == null) return;
				this.setSelectionOrMove(
					shift,
					this.charIndexToCursorPosition(targetIndex),
				);
			});
	}

	public moveToLineEnd(shift: boolean): void {
		if (!this.editState) return;

		const { textElement } = this.editState;
		if (!this.options.getLineStartEnd) {
			// Fallback: move to last char in current paragraph
			const para =
				textElement.content.paragraphs[this.editState.cursorPosition.paragraph];
			if (!para) return;
			const lastRun = para.runs.at(-1);
			this.setSelectionOrMove(shift, {
				paragraph: this.editState.cursorPosition.paragraph,
				run: para.runs.length - 1,
				char: lastRun?.text.length ?? 0,
			});
			return;
		}

		const charIndex = this.getCursorCharIndex();
		this.options
			.getLineStartEnd(textElement, charIndex, "end")
			.then((targetIndex) => {
				if (!this.editState || this.editState.textElement.id !== textElement.id)
					return;
				if (targetIndex == null) return;
				this.setSelectionOrMove(
					shift,
					this.charIndexToCursorPosition(targetIndex),
				);
			});
	}

	public moveToDocumentStart(shift: boolean): void {
		if (!this.editState) return;
		this.setSelectionOrMove(shift, { paragraph: 0, run: 0, char: 0 });
	}

	public moveToDocumentEnd(shift: boolean): void {
		if (!this.editState) return;

		const { textElement } = this.editState;
		const paragraphs = textElement.content.paragraphs;
		const lastPara = paragraphs.at(-1);
		if (!lastPara) return;
		const lastRun = lastPara.runs.at(-1);
		this.setSelectionOrMove(shift, {
			paragraph: paragraphs.length - 1,
			run: lastPara.runs.length - 1,
			char: lastRun?.text.length ?? 0,
		});
	}

	private setSelectionOrMove(shift: boolean, target: CursorPosition): void {
		if (!this.editState) return;
		this.pendingCaretStyle = null;

		if (shift) {
			if (!this.editState.selectionRange) {
				this.editState.selectionRange = {
					start: { ...this.editState.cursorPosition },
					end: target,
				};
			} else {
				this.editState.selectionRange.end = target;
			}
		} else {
			this.editState.selectionRange = null;
		}

		this.editState.cursorPosition = { ...target };
		this.requestRender(false);
	}

	private resetKerning(): void {
		if (!this.editState) return;

		const { cursorPosition, textElement } = this.editState;
		const paragraph = textElement.content.paragraphs[cursorPosition.paragraph];
		if (!paragraph) return;

		const run = paragraph.runs[cursorPosition.run];
		if (!run?.charOverrides) return;

		const override = run.charOverrides.find(
			(o) => o.charIndex === cursorPosition.char,
		);

		if (override) {
			override.kerningAdjust = 0;
		}

		this.requestRender();
	}

	/**
	 * 文字サイズ調整（選択範囲対応）
	 */
	public adjustCharacterSize(multiplier: number): void {
		if (!this.editState) return;

		if (this.editState.selectionRange) {
			this.forEachCharInSelection((run, charIndex) => {
				run.charOverrides ??= [];
				let override = run.charOverrides.find((o) => o.charIndex === charIndex);
				if (!override) {
					override = { charIndex };
					run.charOverrides.push(override);
				}
				override.sizeMultiplier = (override.sizeMultiplier ?? 1.0) * multiplier;
			});
		} else {
			const { cursorPosition, textElement } = this.editState;
			const paragraph =
				textElement.content.paragraphs[cursorPosition.paragraph];
			if (!paragraph) return;

			const run = paragraph.runs[cursorPosition.run];
			if (!run) return;

			run.charOverrides ??= [];
			let override = run.charOverrides.find(
				(o) => o.charIndex === cursorPosition.char,
			);
			if (!override) {
				override = { charIndex: cursorPosition.char };
				run.charOverrides.push(override);
			}
			override.sizeMultiplier = (override.sizeMultiplier ?? 1.0) * multiplier;
		}

		this.requestRender();
	}

	private deleteSelection(): void {
		if (!this.editState?.selectionRange) return;

		const { selectionRange, textElement, cursorPosition } = this.editState;
		const { start, end } = this.normalizeSelectionRange(selectionRange);
		const paragraphs = textElement.content.paragraphs;

		// Simple case: selection within a single run
		if (start.paragraph === end.paragraph && start.run === end.run) {
			const run = paragraphs[start.paragraph].runs[start.run];
			spliceCharOverrides(run, start.char, end.char);
			run.text = run.text.slice(0, start.char) + run.text.slice(end.char);

			cursorPosition.paragraph = start.paragraph;
			cursorPosition.run = start.run;
			cursorPosition.char = start.char;
		} else {
			// Complex case: selection spans multiple runs/paragraphs
			// Keep text before selection start
			const startPara = paragraphs[start.paragraph];
			const startRun = startPara.runs[start.run];
			const textBefore = startRun.text.slice(0, start.char);

			// Keep text after selection end
			const endPara = paragraphs[end.paragraph];
			const endRun = endPara.runs[end.run];
			const textAfter = endRun.text.slice(end.char);

			// Merge: set start run text to textBefore + textAfter, carrying the
			// surviving chars' overrides from both sides
			const keptOverrides = [
				...(startRun.charOverrides ?? []).filter(
					(o) => o.charIndex < start.char,
				),
				...(endRun.charOverrides ?? [])
					.filter((o) => o.charIndex >= end.char)
					.map((o) => ({
						...o,
						charIndex: o.charIndex - end.char + start.char,
					})),
			];
			startRun.charOverrides =
				keptOverrides.length > 0 ? keptOverrides : undefined;
			startRun.text = textBefore + textAfter;

			// Remove runs after start run in start paragraph
			startPara.runs.splice(start.run + 1);

			// Remove paragraphs between start and end
			if (start.paragraph < end.paragraph) {
				paragraphs.splice(start.paragraph + 1, end.paragraph - start.paragraph);
			}

			// Update cursor
			cursorPosition.paragraph = start.paragraph;
			cursorPosition.run = start.run;
			cursorPosition.char = start.char;
		}

		this.editState.selectionRange = null;
		this.requestRender();
		this.persistAndSync(textElement);
	}

	private mergeParagraphs(paraIndex1: number, paraIndex2: number): void {
		if (!this.editState) return;

		const { textElement, cursorPosition } = this.editState;
		const paragraphs = textElement.content.paragraphs;

		if (paraIndex1 < 0 || paraIndex2 >= paragraphs.length) return;

		const para1 = paragraphs[paraIndex1];
		const para2 = paragraphs[paraIndex2];

		// Remember cursor position for para1's end
		const lastRun1 = para1.runs.at(-1);
		const cursorChar = lastRun1?.text.length ?? 0;
		const cursorRun = para1.runs.length - 1;

		// Merge runs from para2 into para1
		para1.runs.push(...para2.runs);

		// Remove para2
		paragraphs.splice(paraIndex2, 1);

		// Update cursor to the merge point
		cursorPosition.paragraph = paraIndex1;
		cursorPosition.run = cursorRun;
		cursorPosition.char = cursorChar;
	}

	// --- Run splitting / merging / style application ---

	/**
	 * 選択範囲のRunスタイルを変更
	 * Run境界で分割し、選択部分にスタイルを適用し、隣接同一スタイルRunを結合する
	 */
	public applyStyleToSelection(styleUpdates: Partial<TextStyle>): void {
		this.mapSelectionStyle((style) => {
			const updates = { ...styleUpdates };
			if (updates.fontSource || updates.fontFamily) {
				updates.fontVariationSettings = {};
			} else if (updates.fontStyle !== undefined) {
				updates.fontVariationSettings = {
					...(style.fontVariationSettings ??
						this.editState?.textElement.defaultStyle.fontVariationSettings),
					...updates.fontVariationSettings,
				};
				delete updates.fontVariationSettings.ital;
			}
			return updates;
		});
	}

	/** Change only the requested coordinate in each selected run. */
	public changeSelectionFontVariation(tag: string, value: number | null): void {
		this.mapSelectionStyle((style) => {
			const effectiveStyle = {
				...this.editState?.textElement.defaultStyle,
				...style,
			};
			const axes = getFontManager().getVariationAxes(effectiveStyle.fontSource);
			return axes ? updateFontVariation(effectiveStyle, axes, tag, value) : {};
		});
	}

	/** Report effective per-axis values; undefined coordinates are mixed. */
	public getSelectionFontVariations(): {
		fontSource: FontSource | null;
		values: Record<string, number | undefined>;
	} | null {
		const styles = this.getSelectionStyles();
		if (styles.length === 0) return null;
		const source = styles[0].fontSource;
		if (!styles.every((style) => deepEqual(style.fontSource, source))) {
			return { fontSource: null, values: {} };
		}
		const axes = getFontManager().getVariationAxes(source) ?? {};
		const coordinates = styles.map((style) =>
			resolveFontVariations(style, axes),
		);
		const values: Record<string, number | undefined> = { ...coordinates[0] };
		for (const tag of Object.keys(values)) {
			if (!coordinates.every((value) => value[tag] === values[tag]))
				values[tag] = undefined;
		}
		return { fontSource: source, values };
	}

	private mapSelectionStyle(
		mapStyle: (style: TextStyle) => Partial<TextStyle>,
	): void {
		if (!this.editState || this.editState.isComposing) return;
		if (!this.editState.selectionRange) {
			// No selection: stage the style for the characters typed next
			const style = this.getSelectionStyles()[0];
			if (!style) return;
			this.pendingCaretStyle = {
				...this.pendingCaretStyle,
				...mapStyle(style),
			};
			this.notifySelectionStyleChange();
			return;
		}

		const { selectionRange, textElement } = this.editState;
		const { start, end } = this.normalizeSelectionRange(selectionRange);

		// Run分割前に絶対インデックスを保存（元の選択方向を維持）
		const origStartAbs = this.getAbsoluteCharIndex(selectionRange.start);
		const origEndAbs = this.getAbsoluteCharIndex(selectionRange.end);

		this.mapStyleInRange(start, end, mapStyle);

		// Recompute the selection (keeping its original direction) AND the
		// cursor from absolute indices: run split/merge shifts run indices,
		// and a stale cursor run index crashes getCursorCharIndex
		this.editState.selectionRange = {
			start: this.charIndexToCursorPosition(origStartAbs),
			end: this.charIndexToCursorPosition(origEndAbs),
		};
		this.editState.cursorPosition = this.charIndexToCursorPosition(origEndAbs);

		this.recalculateCursorPosition();
		this.requestRender();
		this.persistAndSync(textElement);
	}

	/**
	 * Apply a style mapper to every run in [start, end), splitting runs at the
	 * boundaries. The mapper receives each run's current style, enabling
	 * relative adjustments (e.g. lineHeight ± delta).
	 */
	private mapStyleInRange(
		start: CursorPosition,
		end: CursorPosition,
		mapStyle: (style: TextStyle) => Partial<TextStyle>,
	): void {
		if (!this.editState) return;
		const paragraphs = this.editState.textElement.content.paragraphs;

		for (let p = start.paragraph; p <= end.paragraph; p++) {
			const para = paragraphs[p];
			const runStart = p === start.paragraph ? start.run : 0;
			const runEnd = p === end.paragraph ? end.run : para.runs.length - 1;

			// 後ろから処理（spliceでインデックスがずれるため）
			for (let r = runEnd; r >= runStart; r--) {
				const run = para.runs[r];
				const charStart =
					p === start.paragraph && r === start.run ? start.char : 0;
				const charEnd =
					p === end.paragraph && r === end.run ? end.char : run.text.length;

				// Run全体が選択されている場合は分割不要
				if (charStart === 0 && charEnd === run.text.length) {
					run.style = { ...run.style, ...mapStyle(run.style) };
					continue;
				}

				// Run分割が必要
				const parts: TextRun[] = [];

				// 選択前の部分
				if (charStart > 0) {
					parts.push(splitRunAt(run, 0, charStart));
				}

				// 選択部分（スタイル適用）
				const selectedPart = splitRunAt(run, charStart, charEnd);
				selectedPart.style = {
					...selectedPart.style,
					...mapStyle(selectedPart.style),
				};
				parts.push(selectedPart);

				// 選択後の部分
				if (charEnd < run.text.length) {
					parts.push(splitRunAt(run, charEnd, run.text.length));
				}

				// 元のRunを分割結果で置換
				para.runs.splice(r, 1, ...parts);
			}

			// 隣接する同一スタイルRunを結合
			mergeAdjacentRuns(para.runs);
		}
	}

	/**
	 * 選択範囲のフォントファミリーを変更
	 */
	public changeSelectionFontFamily(
		family: string,
		fontSource: FontSource,
	): void {
		this.applyStyleToSelection({ fontFamily: family, fontSource });
	}

	/**
	 * 選択範囲のフォントサイズを変更
	 */
	public changeSelectionFontSize(fontSize: number): void {
		this.applyStyleToSelection({ fontSize });
	}

	/**
	 * カーソル位置の段落アラインメントを変更
	 * 選択範囲がある場合は選択範囲に含まれる全段落を変更
	 */
	public changeParagraphAlignment(
		alignment: "left" | "center" | "right" | "justify",
	): void {
		if (!this.editState) return;

		const { textElement, cursorPosition, selectionRange } = this.editState;
		const paragraphs = textElement.content.paragraphs;

		if (selectionRange) {
			const { start, end } = this.normalizeSelectionRange(selectionRange);
			for (let p = start.paragraph; p <= end.paragraph; p++) {
				paragraphs[p].alignment = alignment;
			}
		} else {
			paragraphs[cursorPosition.paragraph].alignment = alignment;
		}

		this.requestRender();
	}

	/**
	 * カーソル位置の段落アラインメントを取得
	 */
	public getCurrentParagraphAlignment():
		| "left"
		| "center"
		| "right"
		| "justify" {
		if (!this.editState) return "left";

		const { textElement, cursorPosition } = this.editState;
		return (
			textElement.content.paragraphs[cursorPosition.paragraph]?.alignment ??
			"left"
		);
	}

	/**
	 * 選択範囲の共通スタイルを取得
	 */
	private getSelectionStyle(): Partial<TextStyle> | null {
		const styles = this.getSelectionStyles();
		if (styles.length === 0) return null;

		// 共通値を計算
		const result: Partial<TextStyle> = { ...styles[0] };
		const keys = Object.keys(result) as (keyof TextStyle)[];
		for (const key of keys) {
			for (let i = 1; i < styles.length; i++) {
				if (!deepEqual(styles[i][key], result[key])) {
					delete result[key];
					break;
				}
			}
		}

		return result;
	}

	private getSelectionStyles(): TextStyle[] {
		if (!this.editState) return [];
		if (!this.editState.selectionRange) {
			// Caret only: report the style at the caret (with any staged style
			// on top) so pickers reflect what typing would produce
			const { cursorPosition, textElement } = this.editState;
			const run =
				textElement.content.paragraphs[cursorPosition.paragraph]?.runs[
					cursorPosition.run
				];
			if (!run && !this.pendingCaretStyle) return [];
			return [
				{
					...textElement.defaultStyle,
					...run?.style,
					...this.pendingCaretStyle,
				},
			];
		}

		const { selectionRange, textElement } = this.editState;
		const { start, end } = this.normalizeSelectionRange(selectionRange);
		const paragraphs = textElement.content.paragraphs;

		const styles: TextStyle[] = [];

		for (let p = start.paragraph; p <= end.paragraph; p++) {
			const para = paragraphs[p];
			const runStart = p === start.paragraph ? start.run : 0;
			const runEnd = p === end.paragraph ? end.run : para.runs.length - 1;

			for (let r = runStart; r <= runEnd; r++) {
				const run = para.runs[r];
				const charStart =
					p === start.paragraph && r === start.run ? start.char : 0;
				const charEnd =
					p === end.paragraph && r === end.run ? end.char : run.text.length;
				// 空範囲は無視
				if (charStart < charEnd) {
					styles.push({ ...textElement.defaultStyle, ...run.style });
				}
			}
		}

		return styles;
	}

	/**
	 * 選択範囲内の全文字に対して処理を実行
	 */
	private forEachCharInSelection(
		fn: (run: TextRun, charIndex: number) => void,
	): void {
		if (!this.editState?.selectionRange) return;

		const { selectionRange, textElement } = this.editState;
		const { start, end } = this.normalizeSelectionRange(selectionRange);
		const paragraphs = textElement.content.paragraphs;

		for (let p = start.paragraph; p <= end.paragraph; p++) {
			const para = paragraphs[p];
			const runStart = p === start.paragraph ? start.run : 0;
			const runEnd = p === end.paragraph ? end.run : para.runs.length - 1;

			for (let r = runStart; r <= runEnd; r++) {
				const run = para.runs[r];
				const charStart =
					p === start.paragraph && r === start.run ? start.char : 0;
				const charEnd =
					p === end.paragraph && r === end.run ? end.char : run.text.length;

				for (let c = charStart; c < charEnd; c++) {
					fn(run, c);
				}
			}
		}
	}

	/**
	 * Run分割後にカーソル位置を再計算
	 */
	private recalculateCursorPosition(): void {
		if (!this.editState) return;

		const { textElement, cursorPosition } = this.editState;
		// カーソルの絶対文字インデックスを取得
		const absIndex = this.getCursorCharIndex();

		// 絶対インデックスからparagraph/run/char位置を再計算
		let remaining = absIndex;
		for (let p = 0; p < textElement.content.paragraphs.length; p++) {
			const para = textElement.content.paragraphs[p];
			for (let r = 0; r < para.runs.length; r++) {
				const run = para.runs[r];
				if (remaining <= run.text.length) {
					cursorPosition.paragraph = p;
					cursorPosition.run = r;
					cursorPosition.char = remaining;
					return;
				}
				remaining -= run.text.length;
			}
			remaining--; // paragraph間の改行
		}
	}

	/**
	 * 選択範囲の絶対インデックスをコールバック通知
	 */
	private notifySelectionRangeChange(): void {
		if (!this.editState || !this.options.selectionRangeChange) return;

		const { selectionRange, textElement } = this.editState;
		if (!selectionRange) {
			// 選択なし → 空配列
			this.options.selectionRangeChange(textElement, 0, 0);
			return;
		}

		const normalized = this.normalizeSelectionRange(selectionRange);
		const startIndex = this.getAbsoluteCharIndex(normalized.start);
		const endIndex = this.getAbsoluteCharIndex(normalized.end);

		if (startIndex < endIndex) {
			this.options.selectionRangeChange(textElement, startIndex, endIndex);
		} else {
			this.options.selectionRangeChange(textElement, 0, 0);
		}
	}

	/**
	 * CursorPositionから絶対文字インデックスを算出
	 */
	private getAbsoluteCharIndex(pos: CursorPosition): number {
		if (!this.editState) return 0;

		const { textElement } = this.editState;
		let index = 0;

		for (let p = 0; p < pos.paragraph; p++) {
			const para = textElement.content.paragraphs[p];
			for (const run of para.runs) {
				index += run.text.length;
			}
			index++; // paragraph間の改行
		}

		const currentPara = textElement.content.paragraphs[pos.paragraph];
		if (currentPara) {
			for (let r = 0; r < pos.run; r++) {
				index += currentPara.runs[r].text.length;
			}
			index += pos.char;
		}

		return index;
	}

	/**
	 * 選択スタイル変更をコールバック通知
	 */
	private notifySelectionStyleChange(): void {
		// getSelectionStyle() already covers both cases: the common style
		// across a selection, or the caret's run style with any staged
		// pendingCaretStyle merged on top when there is no selection.
		const style = this.getSelectionStyle();
		const hasSelection = !!this.editState?.selectionRange;
		this.options.selectionStyleChange?.(style, hasSelection);
	}

	/**
	 * Normalize selection range so start is before end
	 */
	private normalizeSelectionRange(range: SelectionRange): SelectionRange {
		const { start, end } = range;

		// Compare positions
		const startBefore =
			start.paragraph < end.paragraph ||
			(start.paragraph === end.paragraph && start.run < end.run) ||
			(start.paragraph === end.paragraph &&
				start.run === end.run &&
				start.char <= end.char);

		if (startBefore) {
			return { start, end };
		}
		return { start: end, end: start };
	}
}

// --- Helper: Create default text style ---

export function createDefaultTextStyle(): TextStyle {
	return {
		fontFamily: "Inter",
		fontSource: {
			type: "google",
			family: "Inter",
			variants: ["400"],
		},
		fontSize: 24,
		fontWeight: 400,
		fontStyle: "normal",
		fill: {
			type: "solid",
			color: createDefaultColor(),
		},
		underline: false,
		strikethrough: false,
		letterSpacing: 0,
		baselineShift: 0,
	};
}

// --- Run manipulation helpers ---

/** Rich-text clipboard payload: run slices with styles and charOverrides */
interface TextClipboardPayload {
	paragraphs: Array<{ runs: TextRun[] }>;
}

async function readTextPayloadFromClipboard(): Promise<TextClipboardPayload | null> {
	try {
		const items = await Clipboard.read();
		for (const item of items) {
			if (!item.types.includes(PAPLICO_TEXT_MIME)) continue;
			const blob = await item.getType(PAPLICO_TEXT_MIME);
			const parsed = JSON.parse(await blob.text()) as TextClipboardPayload;
			if (Array.isArray(parsed?.paragraphs)) return parsed;
		}
	} catch {
		// Clipboard read denied or no rich payload present
	}
	return null;
}

function textPayloadToHtml(payload: TextClipboardPayload): string {
	return payload.paragraphs
		.map(
			(p) =>
				`<div>${p.runs
					.map(
						(r) =>
							`<span style="${textStyleToCss(r.style)}">${escapeHtml(r.text)}</span>`,
					)
					.join("")}</div>`,
		)
		.join("");
}

function textStyleToCss(style: TextStyle): string {
	const parts = [
		`font-family: '${style.fontFamily.replaceAll("'", "")}'`,
		`font-size: ${style.fontSize}px`,
		`font-weight: ${style.fontWeight}`,
		`font-style: ${style.fontStyle}`,
	];
	const variations = Object.entries(style.fontVariationSettings ?? {})
		.filter(
			([tag, value]) =>
				/^[A-Za-z0-9]{4}$/.test(tag) &&
				tag !== "wght" &&
				Number.isFinite(value),
		)
		.map(([tag, value]) => `&quot;${tag}&quot; ${value}`);
	if (variations.length > 0)
		parts.push(`font-variation-settings: ${variations.join(", ")}`);
	if (style.letterSpacing) {
		parts.push(`letter-spacing: ${style.letterSpacing}em`);
	}
	const decorations = [
		style.underline ? "underline" : null,
		style.strikethrough ? "line-through" : null,
	].filter((d): d is string => d !== null);
	if (decorations.length > 0) {
		parts.push(`text-decoration: ${decorations.join(" ")}`);
	}
	const color = solidFillToCss(style.fill);
	if (color) parts.push(`color: ${color}`);
	return parts.join("; ");
}

function solidFillToCss(fill: TextStyle["fill"]): string | null {
	if (fill?.type !== "solid") return null;
	const c = fill.color;
	const [r, g, b] =
		c.type === "rgb" ? [c.r, c.g, c.b] : hsvToRgb(c.h, c.s, c.v);
	const to255 = (v: number) => Math.round(v * 255);
	return `rgba(${to255(r)}, ${to255(g)}, ${to255(b)}, ${c.a})`;
}

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function cloneRun(run: TextRun): TextRun {
	return {
		text: run.text,
		style: { ...run.style },
		charOverrides: run.charOverrides?.map((o) => ({ ...o })),
	};
}

/**
 * Text deletion counterpart of splitRunAt: drop overrides covering the
 * removed range [from, to) and shift later ones left so they stay attached
 * to their characters.
 */
function spliceCharOverrides(run: TextRun, from: number, to: number): void {
	if (!run.charOverrides?.length) return;
	const removed = to - from;
	const kept = run.charOverrides
		.filter((o) => o.charIndex < from || o.charIndex >= to)
		.map((o) =>
			o.charIndex >= to ? { ...o, charIndex: o.charIndex - removed } : o,
		);
	run.charOverrides = kept.length > 0 ? kept : undefined;
}

/** Text insertion counterpart: shift overrides at/after `from` right by `count` */
function shiftCharOverrides(run: TextRun, from: number, count: number): void {
	if (!run.charOverrides?.length) return;
	run.charOverrides = run.charOverrides.map((o) =>
		o.charIndex >= from ? { ...o, charIndex: o.charIndex + count } : o,
	);
}

/**
 * 隣接する同一スタイルのRunを結合（in-place）
 */
function mergeAdjacentRuns(runs: TextRun[]): void {
	let i = 0;
	while (i < runs.length - 1) {
		if (areStylesEqual(runs[i].style, runs[i + 1].style)) {
			const current = runs[i];
			const next = runs[i + 1];
			const currentLen = current.text.length;

			// テキストを結合
			current.text += next.text;

			// charOverridesを結合（nextのインデックスをシフト）
			const shiftedOverrides =
				next.charOverrides?.map((o) => ({
					...o,
					charIndex: o.charIndex + currentLen,
				})) ?? [];
			current.charOverrides = [
				...(current.charOverrides ?? []),
				...shiftedOverrides,
			];
			if (current.charOverrides.length === 0) {
				current.charOverrides = undefined;
			}

			// nextを削除
			runs.splice(i + 1, 1);
		} else {
			i++;
		}
	}
}

/**
 * TextStyleの深い等値比較
 */
function areStylesEqual(a: TextStyle, b: TextStyle): boolean {
	return (
		a.fontFamily === b.fontFamily &&
		a.fontSize === b.fontSize &&
		a.fontWeight === b.fontWeight &&
		a.fontStyle === b.fontStyle &&
		a.underline === b.underline &&
		a.strikethrough === b.strikethrough &&
		a.letterSpacing === b.letterSpacing &&
		a.baselineShift === b.baselineShift &&
		deepEqual(a.fontSource, b.fontSource) &&
		deepEqual(a.fontVariationSettings, b.fontVariationSettings) &&
		deepEqual(a.fill, b.fill) &&
		deepEqual(a.stroke, b.stroke) &&
		a.strokeWidth === b.strokeWidth &&
		a.lineHeight === b.lineHeight &&
		(a.tateChuYoko ?? false) === (b.tateChuYoko ?? false)
	);
}

/**
 * 簡易deep equal
 */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a == null || b == null) return a === b;
	if (typeof a !== typeof b) return false;
	if (typeof a !== "object") return false;

	const keysA = Object.keys(a as Record<string, unknown>);
	const keysB = Object.keys(b as Record<string, unknown>);
	if (keysA.length !== keysB.length) return false;

	for (const key of keysA) {
		if (
			!deepEqual(
				(a as Record<string, unknown>)[key],
				(b as Record<string, unknown>)[key],
			)
		)
			return false;
	}
	return true;
}

// --- Path-bound text helpers ---

/** Screen-pixel drag distance before a blank click becomes a region drag */
const REGION_DRAG_THRESHOLD_PX = 3;

/** Screen-pixel dash length for the chain connector pattern */
const CHAIN_DASH_SCREEN_PX = 8;

/** Texts that can participate in a flow chain (have an overflow to link) */
function isFlowCapableText(element: TextElement): boolean {
	return (
		element.axisBinding != null ||
		element.flow != null ||
		element.layout.boxWidth !== "auto" ||
		element.layout.boxHeight !== "auto"
	);
}

/**
 * Distance from a point to a path outline (world-space segments with
 * absolute control points), via piecewise-linear sampling of each segment.
 */
function distanceToOutline(
	segments: readonly WorldBezierSegment[],
	point: { x: number; y: number },
): number {
	const SAMPLES = 20;
	let bestSq = Number.POSITIVE_INFINITY;
	let prevEnd: { x: number; y: number } | null = null;
	for (const seg of segments) {
		const start = seg.start ?? prevEnd;
		prevEnd = seg.end;
		if (!start) continue;
		let prev: { x: number; y: number } = start;
		for (let i = 1; i <= SAMPLES; i++) {
			const p = evalCubicBezier(start, seg.cp1, seg.cp2, seg.end, i / SAMPLES);
			bestSq = Math.min(bestSq, pointSegmentDistSq(point, prev, p));
			prev = p;
		}
	}
	return Math.sqrt(bestSq);
}

function pointSegmentDistSq(
	p: { x: number; y: number },
	a: { x: number; y: number },
	b: { x: number; y: number },
): number {
	const abx = b.x - a.x;
	const aby = b.y - a.y;
	const lenSq = abx * abx + aby * aby;
	const t =
		lenSq === 0
			? 0
			: Math.max(
					0,
					Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq),
				);
	const cx = a.x + abx * t;
	const cy = a.y + aby * t;
	return (p.x - cx) ** 2 + (p.y - cy) ** 2;
}

// --- Touch-type helpers ---

const CHAR_TOUCH_SCALE_MIN = 0.1;
const CHAR_TOUCH_SCALE_MAX = 10;
/** Last-resort fontSize for the px → em kerning conversion */
const DEFAULT_CHAR_TOUCH_FONT_SIZE = 16;

function clampCharTouchScale(value: number): number {
	return Math.min(CHAR_TOUCH_SCALE_MAX, Math.max(CHAR_TOUCH_SCALE_MIN, value));
}

/** World drag delta → element-local delta (inverse rotation, inverse scale) */
function worldDeltaToLocal(
	dx: number,
	dy: number,
	t: { rotation: number; scaleX: number; scaleY: number },
): { x: number; y: number } {
	const cos = Math.cos(-t.rotation);
	const sin = Math.sin(-t.rotation);
	const rx = dx * cos - dy * sin;
	const ry = dx * sin + dy * cos;
	return { x: rx / (t.scaleX || 1), y: ry / (t.scaleY || 1) };
}

/**
 * Content-global char index → {paragraph, run, run-local char}. Strict glyph
 * containment (unlike caret positions, an index sitting on a newline or past
 * the end resolves to null).
 */
/** Total content indices in a text element (glyphs + inter-paragraph newlines) */
function contentIndexCount(element: TextElement): number {
	let total = 0;
	const paragraphs = element.content.paragraphs;
	for (let p = 0; p < paragraphs.length; p++) {
		if (p > 0) total += 1; // the newline between paragraphs holds one index
		for (const run of paragraphs[p].runs) total += run.text.length;
	}
	return total;
}

/** AABB overlap between a glyph quad and a world-space selection rectangle */
function quadIntersectsRect(
	quad: TextGlyphQuad,
	rect: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const c of quad.corners) {
		if (c.x < minX) minX = c.x;
		if (c.x > maxX) maxX = c.x;
		if (c.y < minY) minY = c.y;
		if (c.y > maxY) maxY = c.y;
	}
	return (
		minX <= rect.maxX &&
		maxX >= rect.minX &&
		minY <= rect.maxY &&
		maxY >= rect.minY
	);
}

function charIndexToRunLocal(
	element: TextElement,
	contentIndex: number,
): { paragraph: number; run: number; char: number } | null {
	let remaining = contentIndex;
	const paragraphs = element.content.paragraphs;
	for (let p = 0; p < paragraphs.length; p++) {
		if (p > 0) {
			// The newline between paragraphs occupies one content index
			if (remaining === 0) return null;
			remaining--;
		}
		const para = paragraphs[p];
		for (let r = 0; r < para.runs.length; r++) {
			const len = para.runs[r].text.length;
			if (remaining < len) return { paragraph: p, run: r, char: remaining };
			remaining -= len;
		}
	}
	return null;
}

/** Effective run lineHeight multiplier of the char at a content-global index */
function resolveCharLineHeight(
	element: TextElement,
	contentIndex: number,
): number {
	const loc = charIndexToRunLocal(element, contentIndex);
	const run = loc
		? element.content.paragraphs[loc.paragraph].runs[loc.run]
		: undefined;
	return run?.style.lineHeight ?? element.defaultStyle.lineHeight ?? 1.5;
}

/** Split the run so styleUpdates applies to exactly one char */
function applyRunStyleAtChar(
	element: TextElement,
	contentIndex: number,
	styleUpdates: Partial<TextStyle>,
): void {
	const loc = charIndexToRunLocal(element, contentIndex);
	if (!loc) return;
	const para = element.content.paragraphs[loc.paragraph];
	const run = para.runs[loc.run];
	if (loc.char === 0 && run.text.length <= 1) {
		run.style = { ...run.style, ...styleUpdates };
		mergeAdjacentRuns(para.runs);
		return;
	}
	const parts: TextRun[] = [];
	if (loc.char > 0) parts.push(splitRunAt(run, 0, loc.char));
	const target = splitRunAt(run, loc.char, loc.char + 1);
	target.style = { ...target.style, ...styleUpdates };
	parts.push(target);
	if (loc.char + 1 < run.text.length) {
		parts.push(splitRunAt(run, loc.char + 1, run.text.length));
	}
	para.runs.splice(loc.run, 1, ...parts);
	mergeAdjacentRuns(para.runs);
}

/** Run font size (unscaled) of the char at a content-global index */
function resolveCharFontSize(
	element: TextElement,
	contentIndex: number,
): number {
	const loc = charIndexToRunLocal(element, contentIndex);
	const run = loc
		? element.content.paragraphs[loc.paragraph].runs[loc.run]
		: undefined;
	return (
		run?.style.fontSize ??
		element.defaultStyle.fontSize ??
		DEFAULT_CHAR_TOUCH_FONT_SIZE
	);
}

/** Whether the char at a content-global index composes as tate-chu-yoko */
function isTateChuYokoAt(element: TextElement, contentIndex: number): boolean {
	const loc = charIndexToRunLocal(element, contentIndex);
	const run = loc
		? element.content.paragraphs[loc.paragraph].runs[loc.run]
		: undefined;
	return (run?.style.tateChuYoko ?? element.defaultStyle.tateChuYoko) === true;
}

function findCharOverride(
	element: TextElement,
	contentIndex: number,
): CharOverride | undefined {
	const loc = charIndexToRunLocal(element, contentIndex);
	if (!loc) return undefined;
	return element.content.paragraphs[loc.paragraph].runs[
		loc.run
	].charOverrides?.find((o) => o.charIndex === loc.char);
}

function ensureCharOverride(
	element: TextElement,
	contentIndex: number,
): CharOverride | null {
	const loc = charIndexToRunLocal(element, contentIndex);
	if (!loc) return null;
	const run = element.content.paragraphs[loc.paragraph].runs[loc.run];
	run.charOverrides ??= [];
	let override = run.charOverrides.find((o) => o.charIndex === loc.char);
	if (!override) {
		override = { charIndex: loc.char };
		run.charOverrides.push(override);
	}
	return override;
}

function translateQuad(
	quad: TextGlyphQuad,
	dx: number,
	dy: number,
): TextGlyphQuad {
	return {
		...quad,
		pivot: { x: quad.pivot.x + dx, y: quad.pivot.y + dy },
		corners: quad.corners.map((c) => ({ x: c.x + dx, y: c.y + dy })) as [
			{ x: number; y: number },
			{ x: number; y: number },
			{ x: number; y: number },
			{ x: number; y: number },
		],
	};
}

/** Spin the quad around its own pivot (uniform-delta semantics) */
function rotateQuad(quad: TextGlyphQuad, deltaRad: number): TextGlyphQuad {
	const cos = Math.cos(deltaRad);
	const sin = Math.sin(deltaRad);
	const rotate = (c: { x: number; y: number }) => {
		const dx = c.x - quad.pivot.x;
		const dy = c.y - quad.pivot.y;
		return {
			x: quad.pivot.x + dx * cos - dy * sin,
			y: quad.pivot.y + dx * sin + dy * cos,
		};
	};
	return {
		...quad,
		rotation: quad.rotation + deltaRad,
		corners: quad.corners.map(rotate) as TextGlyphQuad["corners"],
	};
}

function scaleQuad(quad: TextGlyphQuad, factor: number): TextGlyphQuad {
	const scale = (c: { x: number; y: number }) => ({
		x: quad.pivot.x + (c.x - quad.pivot.x) * factor,
		y: quad.pivot.y + (c.y - quad.pivot.y) * factor,
	});
	return {
		...quad,
		width: quad.width * factor,
		height: quad.height * factor,
		corners: quad.corners.map(scale) as TextGlyphQuad["corners"],
	};
}

/**
 * Approximate live-preview shear of the overlay quad around its pivot (the real
 * glyphs re-layout with the exact shear; this only keeps the overlay box roughly
 * on them during the drag). Shear is applied in world axes — the box follows the
 * glyphs closely enough for feedback and snaps exact on the post-drag refresh.
 */
function skewQuad(
	quad: TextGlyphQuad,
	skewXRad: number,
	skewYRad: number,
): TextGlyphQuad {
	const kx = skewXRad === 0 ? 0 : Math.tan(skewXRad);
	const ky = skewYRad === 0 ? 0 : Math.tan(skewYRad);
	const shear = (c: { x: number; y: number }) => {
		const dx = c.x - quad.pivot.x;
		const dy = c.y - quad.pivot.y;
		return { x: quad.pivot.x + dx + kx * dy, y: quad.pivot.y + dy + ky * dx };
	};
	return {
		...quad,
		corners: quad.corners.map(shear) as TextGlyphQuad["corners"],
	};
}

function combinedQuadBounds(
	quads: readonly TextGlyphQuad[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
	if (quads.length === 0) return null;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const quad of quads) {
		for (const c of quad.corners) {
			minX = Math.min(minX, c.x);
			minY = Math.min(minY, c.y);
			maxX = Math.max(maxX, c.x);
			maxY = Math.max(maxY, c.y);
		}
	}
	return { minX, minY, maxX, maxY };
}
