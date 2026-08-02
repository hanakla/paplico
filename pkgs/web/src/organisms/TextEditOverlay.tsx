"use client";

import { useEffect, useRef } from "react";
import { useSnapshot } from "valtio";
import { usePaplico, usePaplicoMaybe } from "@/contexts/PaplicoContext";
import { useTargetViewport } from "@/contexts/ViewIdContext";
import { worldToScreen } from "@/core/utils/geometry/geometry";
import {
	isInlineDirection,
	isPositiveCrossDirection,
	isPositiveInlineDirection,
	remapArrowToCursor,
} from "@/core/utils/writingMode";
import { uiState } from "@/stores/uiStore";
import { useEventCallback } from "@/utils/hooks";

interface TextEditOverlayProps {
	canvasWidth: number;
	canvasHeight: number;
}

/**
 * Text editing overlay — hidden textarea for keyboard/IME input capture only.
 * All visual feedback (cursor blink, selection rects, composition underline)
 * is rendered by UILayer on the WebGPU canvas.
 */
export function TextEditOverlay({
	canvasWidth,
	canvasHeight,
}: TextEditOverlayProps) {
	const paplico = usePaplicoMaybe();
	const ui = useSnapshot(uiState);

	if (!paplico || !ui.textEditState.isEditing) {
		return null;
	}

	return (
		<TextEditOverlayInner
			canvasWidth={canvasWidth}
			canvasHeight={canvasHeight}
		/>
	);
}

function TextEditOverlayInner({
	canvasWidth,
	canvasHeight,
}: TextEditOverlayProps) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const ui = useSnapshot(uiState);
	const paplico = usePaplico();
	const { textEditState } = ui;
	const controller = paplico.textToolController;

	// Prevent focus from leaving the textarea when interacting with the canvas
	// during text editing. On desktop, mousedown preventDefault suppresses the
	// browser's default focus-move behaviour. On iOS, PaplicoUI.handlePointerDown
	// skips canvas.focus() when isTextEditing is true. The focusout handler is
	// a fallback for edge cases (programmatic blur, non-canvas elements).
	useEffect(() => {
		if (!textEditState.isEditing) return;

		// Initial focus (preventScroll: focusing the off-canvas 1px textarea
		// must not scroll the page — see PaplicoUI.canvas.focus for the same)
		textareaRef.current?.focus({ preventScroll: true });

		const preventCanvasFocusLoss = (e: Event) => {
			const target = e.target as HTMLElement;
			// Only suppress focus change for canvas clicks — let UI controls
			// (font combobox, size input, etc.) receive focus normally.
			if (target instanceof HTMLCanvasElement) {
				e.preventDefault();
				// Focus may sit on a UI control (color picker, size input) after
				// styling: clicking back onto the canvas must return typing focus
				// to the hidden textarea, or keystrokes keep going to the control
				textareaRef.current?.focus({ preventScroll: true });
			}
		};

		// Fallback: if focusout still fires (e.g. programmatic blur, or a
		// non-canvas element that isn't a UI control), re-focus the textarea.
		const handleFocusOut = (e: FocusEvent) => {
			if (e.target !== textareaRef.current) return;
			if (!uiState.textEditState.isEditing) return;

			const nextTarget = e.relatedTarget as HTMLElement | null;
			if (
				nextTarget instanceof HTMLInputElement ||
				nextTarget instanceof HTMLTextAreaElement ||
				nextTarget instanceof HTMLSelectElement ||
				nextTarget?.closest?.(
					"[role='combobox'], [role='listbox'], [role='option']",
				)
			) {
				return;
			}

			requestAnimationFrame(() => {
				if (uiState.textEditState.isEditing) {
					textareaRef.current?.focus({ preventScroll: true });
				}
			});
		};

		// mousedown preventDefault prevents focus change on desktop browsers.
		// On iOS, PaplicoUI.handlePointerDown already skips canvas.focus() when
		// text editing is active, so touchstart preventDefault is not needed
		// (and would interfere with pointermove delivery for drag selection).
		document.addEventListener("mousedown", preventCanvasFocusLoss, true);
		document.addEventListener("focusout", handleFocusOut);

		return () => {
			document.removeEventListener("mousedown", preventCanvasFocusLoss, true);
			document.removeEventListener("focusout", handleFocusOut);
		};
	}, [textEditState.isEditing]);

	// IME composition state
	const isComposingRef = useRef(false);

	const handleInput = useEventCallback(
		(e: React.FormEvent<HTMLTextAreaElement>) => {
			if (isComposingRef.current) return;

			const textarea = e.currentTarget;
			const value = textarea.value;

			if (value) {
				const textTool = controller?.getTextTool();
				textTool?.insertText(value);
			}

			textarea.value = "";
		},
	);

	const handleKeyDown = useEventCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			const textTool = controller?.getTextTool();
			if (!textTool) return;

			const { altKey, shiftKey, ctrlKey, metaKey, key } = e;

			// Ignore during IME composition
			if (isComposingRef.current) {
				if (key === "Escape") {
					return;
				}
				return;
			}

			// Esc to end editing — commit through TextTool so its edit state
			// ends with the visible UI (controller.endTextEdit alone leaves the
			// tool "editing" and swallows subsequent canvas clicks)
			if (key === "Escape") {
				e.preventDefault();
				textTool.commitEditing();
				return;
			}

			// Cmd/Ctrl + Enter to end editing
			if ((ctrlKey || metaKey) && key === "Enter") {
				e.preventDefault();
				textTool.commitEditing();
				return;
			}

			// Copy/Cut/Paste (Cmd/Ctrl + C/X/V)
			if (ctrlKey || metaKey) {
				if (key === "c" || key === "C") {
					e.preventDefault();
					e.stopPropagation();
					textTool.copyToClipboard();
					return;
				}
				if (key === "x" || key === "X") {
					e.preventDefault();
					textTool.cutToClipboard();
					return;
				}
				if (key === "v" || key === "V") {
					e.preventDefault();
					textTool.pasteFromClipboard();
					return;
				}
				if (key === "a" || key === "A") {
					e.preventDefault();
					textTool.selectAll();
					return;
				}
			}

			// Cmd+Arrow: line/document navigation (Mac)
			if (metaKey && !altKey && !ctrlKey) {
				if (key === "ArrowLeft" || key === "ArrowRight") {
					e.preventDefault();
					if (key === "ArrowLeft") {
						textTool.moveToLineStart(shiftKey);
					} else {
						textTool.moveToLineEnd(shiftKey);
					}
					return;
				}
				if (key === "ArrowUp" || key === "ArrowDown") {
					e.preventDefault();
					if (key === "ArrowUp") {
						textTool.moveToDocumentStart(shiftKey);
					} else {
						textTool.moveToDocumentEnd(shiftKey);
					}
					return;
				}
			}

			// Alt + Arrow: kerning (inline) or line spacing (cross)
			if (altKey && !ctrlKey && !metaKey) {
				if (
					key === "ArrowLeft" ||
					key === "ArrowRight" ||
					key === "ArrowUp" ||
					key === "ArrowDown"
				) {
					e.preventDefault();
					const arrowKey = key as
						| "ArrowLeft"
						| "ArrowRight"
						| "ArrowUp"
						| "ArrowDown";
					const wm = textEditState.writingMode;
					const delta = shiftKey ? 0.1 : 0.02;

					if (isInlineDirection(arrowKey, wm)) {
						const direction = isPositiveInlineDirection(arrowKey, wm) ? 1 : -1;
						textTool.adjustKerning(delta * direction);
					} else {
						const direction = isPositiveCrossDirection(arrowKey, wm) ? 1 : -1;
						textTool.adjustLineSpacing(delta * direction);
					}
					return;
				}
			}

			// Font size adjustment: Ctrl/Cmd + Shift + > or <
			if ((ctrlKey || metaKey) && shiftKey) {
				if (key === ">" || key === "." || key === "<" || key === ",") {
					e.preventDefault();
					const multiplier = key === ">" || key === "." ? 1.1 : 0.9;
					textTool.adjustCharacterSize(multiplier);
					return;
				}
			}

			// Arrow keys for cursor movement (remapped for writing mode)
			if (
				key === "ArrowLeft" ||
				key === "ArrowRight" ||
				key === "ArrowUp" ||
				key === "ArrowDown"
			) {
				e.preventDefault();
				const direction = remapArrowToCursor(
					key as "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
					textEditState.writingMode,
				);
				textTool.moveCursor(direction, shiftKey);
				return;
			}

			// Home/End
			if (key === "Home") {
				e.preventDefault();
				textTool.moveToLineStart(shiftKey);
				return;
			}
			if (key === "End") {
				e.preventDefault();
				textTool.moveToLineEnd(shiftKey);
				return;
			}

			// Enter for newline
			if (key === "Enter" && !shiftKey) {
				e.preventDefault();
				textTool.insertNewline();
				return;
			}

			// Backspace/Delete
			if (key === "Backspace") {
				e.preventDefault();
				textTool.deleteText("backward");
				return;
			}
			if (key === "Delete") {
				e.preventDefault();
				textTool.deleteText("forward");
				return;
			}

			// Tab
			if (key === "Tab") {
				e.preventDefault();
				textTool.insertText("\t");
				return;
			}
		},
	);

	const handleCompositionStart = useEventCallback(() => {
		isComposingRef.current = true;
		const textTool = controller?.getTextTool();
		textTool?.startComposition();
	});

	const handleCompositionUpdate = useEventCallback(
		(e: React.CompositionEvent<HTMLTextAreaElement>) => {
			const textTool = controller?.getTextTool();
			textTool?.updateComposition(e.data);
		},
	);

	const handleCompositionEnd = useEventCallback(
		(e: React.CompositionEvent<HTMLTextAreaElement>) => {
			isComposingRef.current = false;
			const textTool = controller?.getTextTool();
			const finalText = e.data;

			textTool?.endComposition(finalText);

			e.currentTarget.value = "";
		},
	);

	// Textarea position (for IME window placement)
	const viewport = useTargetViewport();

	const screenPos = worldToScreen(
		textEditState.cursorX,
		textEditState.cursorY,
		viewport,
		canvasWidth,
		canvasHeight,
	);

	// Clamp into the canvas: an off-screen caret would place the textarea far
	// outside (e.g. top: 2000px) and focusing it scrolls the page, cutting the
	// canvas off. IME window placement only needs a nearby on-screen anchor.
	const textareaLeft = Math.min(Math.max(screenPos.x, 0), canvasWidth - 1);
	const textareaTop = Math.min(Math.max(screenPos.y, 0), canvasHeight - 1);

	const isVertical =
		textEditState.writingMode === "vertical-rl" ||
		textEditState.writingMode === "vertical-lr";

	return (
		<div className="pointer-events-none absolute inset-0">
			{/* Hidden textarea for keyboard/IME input only */}
			<textarea
				ref={textareaRef}
				className="pointer-events-auto absolute h-px w-px resize-none border-none bg-transparent opacity-0 outline-none"
				style={{
					left: textareaLeft,
					top: textareaTop,
					caretColor: "transparent",
					writingMode: isVertical ? textEditState.writingMode : undefined,
				}}
				onInput={handleInput}
				onKeyDown={handleKeyDown}
				onCompositionStart={handleCompositionStart}
				onCompositionUpdate={handleCompositionUpdate}
				onCompositionEnd={handleCompositionEnd}
			/>
		</div>
	);
}
