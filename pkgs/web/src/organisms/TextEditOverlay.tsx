"use client";

import {
	isInlineDirection,
	isPositiveCrossDirection,
	isPositiveInlineDirection,
	remapArrowToCursor,
	worldToScreen,
} from "@paplico/core/utils";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSnapshot } from "valtio";
import { usePaplico, usePaplicoMaybe } from "@/contexts/PaplicoContext";
import { useTargetViewport } from "@/contexts/ViewIdContext";
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
	const editContextElementRef = useRef<HTMLDivElement>(null);
	const editContextRef = useRef<EditContextLike | null>(null);
	const [useEditContext, setUseEditContext] = useState(false);

	const ui = useSnapshot(uiState);
	const paplico = usePaplico();
	const { textEditState } = ui;
	const controller = paplico.textToolController;
	const isComposingRef = useRef(false);
	const compositionEndingRef = useRef(false);
	const compositionEndTimer = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const markCompositionEnd = useEventCallback(() => {
		isComposingRef.current = false;
		compositionEndingRef.current = true;
		if (compositionEndTimer.current !== null)
			clearTimeout(compositionEndTimer.current);
		compositionEndTimer.current = setTimeout(() => {
			compositionEndingRef.current = false;
			compositionEndTimer.current = null;
		}, 0);
	});

	useEffect(
		() => () => {
			if (compositionEndTimer.current !== null)
				clearTimeout(compositionEndTimer.current);
		},
		[],
	);

	useEffect(() => {
		setUseEditContext("EditContext" in window);
	}, []);

	useLayoutEffect(() => {
		const element = editContextElementRef.current;
		if (!useEditContext || !element) return;
		const Constructor = (
			window as unknown as { EditContext: new () => EditContextLike }
		).EditContext;
		const context = new Constructor();
		editContextRef.current = context;
		(
			element as HTMLDivElement & { editContext: EditContextLike | null }
		).editContext = context;
		const onStart = () => {
			isComposingRef.current = true;
			controller?.getTextTool()?.startComposition();
		};
		const onUpdate = (event: Event) => {
			const update = event as Event & { text: string };
			const tool = controller?.getTextTool();
			if (isComposingRef.current) {
				tool?.updateComposition(context.text);
			} else {
				if (update.text) tool?.insertText(update.text);
				context.updateText(0, context.text.length, "");
				context.updateSelection(0, 0);
			}
		};
		const onFormat = (event: Event) => {
			const formats = (
				event as Event & { getTextFormats(): EditContextFormat[] }
			).getTextFormats();
			controller?.getTextTool()?.updateCompositionFormats(
				formats
					.filter(
						(format) =>
							format.underlineStyle !== "none" &&
							format.underlineThickness !== "none",
					)
					.map((format) => ({
						start: format.rangeStart,
						end: format.rangeEnd,
						thick: format.underlineThickness === "thick",
					})),
			);
		};
		const onEnd = () => {
			markCompositionEnd();
			controller?.getTextTool()?.endComposition(context.text);
			context.updateText(0, context.text.length, "");
			context.updateSelection(0, 0);
		};
		context.addEventListener("compositionstart", onStart);
		context.addEventListener("textupdate", onUpdate);
		context.addEventListener("textformatupdate", onFormat);
		context.addEventListener("compositionend", onEnd);
		return () => {
			context.removeEventListener("compositionstart", onStart);
			context.removeEventListener("textupdate", onUpdate);
			context.removeEventListener("textformatupdate", onFormat);
			context.removeEventListener("compositionend", onEnd);
			(
				element as HTMLDivElement & { editContext: EditContextLike | null }
			).editContext = null;
			editContextRef.current = null;
		};
	}, [controller, useEditContext, markCompositionEnd]);

	// Prevent focus from leaving the textarea when interacting with the canvas
	// during text editing. On desktop, mousedown preventDefault suppresses the
	// browser's default focus-move behaviour. On iOS, PaplicoUI.handlePointerDown
	// skips canvas.focus() when isTextEditing is true. The focusout handler is
	// a fallback for edge cases (programmatic blur, non-canvas elements).
	useEffect(() => {
		if (!textEditState.isEditing) return;

		// Initial focus (preventScroll: focusing the off-canvas 1px textarea
		// must not scroll the page — see PaplicoUI.canvas.focus for the same)
		(useEditContext
			? editContextElementRef.current
			: textareaRef.current
		)?.focus({ preventScroll: true });

		const preventCanvasFocusLoss = (e: Event) => {
			const target = e.target as HTMLElement;
			// Only suppress focus change for canvas clicks — let UI controls
			// (font combobox, size input, etc.) receive focus normally.
			if (target instanceof HTMLCanvasElement) {
				e.preventDefault();
				// Focus may sit on a UI control (color picker, size input) after
				// styling: clicking back onto the canvas must return typing focus
				// to the hidden textarea, or keystrokes keep going to the control
				(useEditContext
					? editContextElementRef.current
					: textareaRef.current
				)?.focus({ preventScroll: true });
			}
		};

		// Fallback: if focusout still fires (e.g. programmatic blur, or a
		// non-canvas element that isn't a UI control), re-focus the textarea.
		const handleFocusOut = (e: FocusEvent) => {
			if (
				e.target !==
				(useEditContext ? editContextElementRef.current : textareaRef.current)
			)
				return;
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
					(useEditContext
						? editContextElementRef.current
						: textareaRef.current
					)?.focus({ preventScroll: true });
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
	}, [textEditState.isEditing, useEditContext]);

	// Removing the focused textarea drops focus to <body>, where no canvas
	// keybinding fires. Layout-effect cleanup runs before the textarea leaves the
	// DOM, so it can still tell whether typing focus was here or on a UI control
	useLayoutEffect(() => {
		const textarea = useEditContext
			? editContextElementRef.current
			: textareaRef.current;
		return () => {
			if (document.activeElement === textarea) paplico.ui?.focusCanvas();
		};
	}, [paplico, useEditContext]);

	// IME composition state
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
		(e: React.KeyboardEvent<HTMLElement>) => {
			const textTool = controller?.getTextTool();
			if (!textTool) return;

			const { altKey, shiftKey, ctrlKey, metaKey, key } = e;

			// Ignore during IME composition
			if (
				isComposingRef.current ||
				e.nativeEvent.isComposing ||
				e.nativeEvent.keyCode === 229 ||
				(key === "Enter" && compositionEndingRef.current)
			) {
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
			markCompositionEnd();
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

	useLayoutEffect(() => {
		const element = editContextElementRef.current;
		const context = editContextRef.current;
		if (!element || !context) return;
		const bounds = element.getBoundingClientRect();
		context.updateControlBounds(bounds);
		context.updateSelectionBounds(bounds);
	});

	const isVertical =
		textEditState.writingMode === "vertical-rl" ||
		textEditState.writingMode === "vertical-lr";

	return (
		<div className="pointer-events-none absolute inset-0">
			{useEditContext ? (
				// biome-ignore lint/a11y/useSemanticElements: EditContext cannot attach to a textarea.
				<div
					ref={editContextElementRef}
					role="textbox"
					aria-label="Text editor"
					tabIndex={-1}
					onKeyDown={handleKeyDown}
					className="pointer-events-auto absolute h-px w-px outline-none"
					style={{ left: textareaLeft, top: textareaTop }}
				/>
			) : (
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
			)}
		</div>
	);
}

interface EditContextFormat {
	rangeStart: number;
	rangeEnd: number;
	underlineStyle: string;
	underlineThickness: string;
}

interface EditContextLike extends EventTarget {
	readonly text: string;
	updateText(start: number, end: number, text: string): void;
	updateSelection(start: number, end: number): void;
	updateControlBounds(bounds: DOMRect): void;
	updateSelectionBounds(bounds: DOMRect): void;
}
