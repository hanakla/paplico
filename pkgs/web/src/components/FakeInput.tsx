import type React from "react";
import { memo, useEffect, useRef, useState } from "react";
import { tv } from "tailwind-variants";
import { useEventCallback } from "@/utils/hooks";
import { toHalfWidth } from "@/utils/string";
import { Clickable } from "./Clickable";
import { Input } from "./Input";
import { Portal } from "./Portal";

const fakeInputStyles = tv({
	slots: {
		root: "relative cursor-text w-fit text-inherit",
		display: "truncate underline decoration-dotted text-inherit",
		overlay: [
			"absolute top-0 z-10 w-fit h-auto p-1 bg-background text-foreground",
			"border-0 -translate-y-1/4 ring-2 ring-accent rounded shadow-2xl outline-none",
			"animate-overlay-in origin-center",
			"placeholder:text-foreground/40",
		],
	},
	variants: {
		$size: {
			xs: { root: "text-[11px]", overlay: "text-base" },
			sm: { root: "text-xs", overlay: "text-base" },
			md: { root: "text-sm", overlay: "text-base" },
			lg: { root: "text-base", overlay: "text-base" },
		},
		$side: {
			start: { display: "text-left", overlay: "left-0 text-left" },
			end: { display: "text-right", overlay: "right-0 text-right" },
		},
		$number: {
			true: { root: "cursor-ew-resize", display: "select-none" },
		},
	},
	defaultVariants: {
		$size: "md",
	},
});

/** Pixels of horizontal drag per `step` increment when scrubbing a number. */
const SCRUB_PX_PER_STEP = 3;
/** Scrub sensitivity + snap-resolution multiplier while Ctrl is held. */
const SCRUB_FINE_MULTIPLIER = 0.1;

type FakeInputProps = {
	value?: string | null;
	placeholder?: string;
	onChange: (value: string | undefined) => void;
	type?: React.HTMLInputTypeAttribute;
	step?: number | string;
	/** Clamp bounds applied to drag-scrubbing when type="number". */
	min?: number;
	max?: number;
	unit?: string;
	disabled?: boolean;
	$size?: "xs" | "sm" | "md" | "lg";
	$behaviour?: "default" | "click";
	$side?: "start" | "end";
	$delay?: number;
	className?: string;
};

export const FakeInput = memo(FakeInputRoot);

export namespace FakeInput {
	export type Props = FakeInputProps;
}

function FakeInputRoot({
	value,
	placeholder,
	onChange,
	type,
	step,
	min,
	max,
	unit,
	disabled,
	$size,
	$behaviour = "default",
	$side,
	$delay = 500,
	className,
}: FakeInputProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const [isEditing, setIsEditing] = useState(false);
	// Screen rect of the root, captured when editing starts. The portal host
	// replicates this box so the overlay's absolute positioning keeps anchoring
	// to the same spot as the inline version did.
	const [overlayRect, setOverlayRect] = useState<{
		top: number;
		left: number;
		width: number;
		height: number;
	} | null>(null);
	const [editValue, setEditValue] = useState(value ?? "");
	const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const scrubStart = useRef<{ x: number; value: number; fine: boolean } | null>(
		null,
	);
	const didScrub = useRef(false);

	const isNumber = type === "number";

	const displayText = value || placeholder || "";

	const finishEdit = useEventCallback(() => {
		setIsEditing(false);
		const trimmed = editValue.trim();
		if (trimmed && trimmed !== value) {
			onChange(trimmed);
		} else if (!trimmed && value) {
			onChange(undefined);
		}
		setEditValue(trimmed || value || "");
	});

	const startEdit = useEventCallback(() => {
		const rect = rootRef.current?.getBoundingClientRect();
		if (rect) {
			setOverlayRect({
				top: rect.top,
				left: rect.left,
				width: rect.width,
				height: rect.height,
			});
		}
		setEditValue(value ?? "");
		setIsEditing(true);
	});

	const clearLongPress = useEventCallback(() => {
		if (longPressTimer.current) {
			clearTimeout(longPressTimer.current);
			longPressTimer.current = null;
		}
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: clearLongPress is stable (useEventCallback)
	useEffect(() => {
		if (disabled && isEditing) {
			setIsEditing(false);
			clearLongPress();
		}
	}, [disabled]);

	const handlePointerDown = useEventCallback(() => {
		clearLongPress();

		longPressTimer.current = setTimeout(() => {
			longPressTimer.current = null;
			startEdit();
		}, $delay);
	});

	// type="number": drag horizontally to scrub the value. A move past the
	// threshold becomes a scrub (and cancels the long-press edit); a stationary
	// press still long-presses / double-clicks into the text editor.
	const handleNumberPointerDown = useEventCallback((e: React.PointerEvent) => {
		if (isNumber) {
			const base = Number(value);
			scrubStart.current = {
				x: e.clientX,
				value: Number.isFinite(base) ? base : 0,
				fine: e.ctrlKey,
			};
			didScrub.current = false;
			try {
				(e.currentTarget as Element).setPointerCapture(e.pointerId);
			} catch {}
		}
		handlePointerDown();
	});

	const handlePointerMove = useEventCallback((e: React.PointerEvent) => {
		if (!isNumber || !scrubStart.current) return;
		// Holding Ctrl scrubs finer (0.1× sensitivity and snap resolution).
		// Rebase the anchor when Ctrl toggles mid-drag so the value doesn't jump
		// from re-scaling the whole delta.
		if (e.ctrlKey !== scrubStart.current.fine) {
			const base = Number(value);
			scrubStart.current = {
				x: e.clientX,
				value: Number.isFinite(base) ? base : 0,
				fine: e.ctrlKey,
			};
		}
		const dx = e.clientX - scrubStart.current.x;
		if (!didScrub.current && Math.abs(dx) < 3) return;
		didScrub.current = true;
		clearLongPress();
		const stepNum = Number(step) || 1;
		const fine = scrubStart.current.fine ? SCRUB_FINE_MULTIPLIER : 1;
		const raw =
			scrubStart.current.value + (dx / SCRUB_PX_PER_STEP) * stepNum * fine;
		const snap = stepNum * fine;
		let next = Math.round(raw / snap) * snap;
		if (min != null) next = Math.max(min, next);
		if (max != null) next = Math.min(max, next);
		onChange(String(Number(next.toFixed(6))));
	});

	const handleNumberPointerUp = useEventCallback((e: React.PointerEvent) => {
		if (isNumber && scrubStart.current) {
			try {
				(e.currentTarget as Element).releasePointerCapture(e.pointerId);
			} catch {}
			scrubStart.current = null;
		}
		clearLongPress();
	});

	const handleDoubleClick = useEventCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		clearLongPress();
		startEdit();
	});

	const handleClickPointerUp = useEventCallback(
		(e: React.MouseEvent | React.PointerEvent) => {
			e.stopPropagation();
			startEdit();
		},
	);

	const handleChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			setEditValue(isNumber ? toHalfWidth(e.target.value) : e.target.value);
		},
	);

	const handleInputKeydown = useEventCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			e.stopPropagation();

			if (e.key === "Enter") finishEdit();
			if (e.key === "Escape") {
				setEditValue(value ?? "");
				setIsEditing(false);
			}
		},
	);

	const handleKeydown = useEventCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			e.stopPropagation();
			e.preventDefault();

			if (e.target === inputRef.current) return;

			if ((!e.nativeEvent.isComposing && e.key === "Enter") || e.key === " ") {
				setEditValue(value ?? "");
				setIsEditing(true);
			}
		},
	);

	const stopPropagation = useEventCallback((e: React.SyntheticEvent) => {
		e.stopPropagation();
	});

	const onInputMount = useEventCallback((el: HTMLInputElement | null) => {
		inputRef.current = el;

		if (!el) return;
		el.focus();
		el.select();
	});

	const isClickMode = $behaviour === "click";
	const { root, display, overlay } = fakeInputStyles({
		$size,
		$side,
		$number: isNumber,
	});

	return (
		<Clickable
			ref={rootRef}
			className={root({ className })}
			onClick={disabled || isClickMode ? handleClickPointerUp : undefined}
			onKeyDown={handleKeydown}
			onDoubleClick={disabled || isClickMode ? undefined : handleDoubleClick}
			onPointerDown={
				disabled || isClickMode ? undefined : handleNumberPointerDown
			}
			onPointerMove={
				disabled || isClickMode || !isNumber ? undefined : handlePointerMove
			}
			onPointerUp={disabled ? undefined : handleNumberPointerUp}
			onPointerLeave={disabled || isClickMode ? undefined : clearLongPress}
		>
			<span className={display()}>
				{displayText}
				{unit && <span className="text-muted-foreground">{unit}</span>}
			</span>

			{isEditing && !disabled && (
				<Portal>
					<div
						className="fixed z-10 pointer-events-none"
						style={overlayRect ?? undefined}
					>
						<Input
							ref={onInputMount}
							type={isNumber ? "text" : type}
							inputMode={isNumber ? "decimal" : undefined}
							step={step}
							min={min}
							max={max}
							unit={unit}
							className={overlay({ className: "pointer-events-auto" })}
							value={editValue}
							placeholder={placeholder}
							onChange={handleChange}
							onBlur={finishEdit}
							onClick={stopPropagation}
							onPointerDown={stopPropagation}
							onKeyDown={handleInputKeydown}
						/>
					</div>
				</Portal>
			)}
		</Clickable>
	);
}
