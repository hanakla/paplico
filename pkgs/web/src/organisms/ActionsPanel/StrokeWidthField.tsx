import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FakeInput } from "@/components/FakeInput";
import { InfiniteSlider, Slider } from "@/components/Slider";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

export const StrokeWidthField = memo(function StrokeWidthField({
	label,
	value,
	isMixed = false,
	min,
	max,
	step,
	range,
	onValueChange,
}: {
	label: string;
	value: number;
	isMixed?: boolean;
	min: number;
	max: number;
	step: number;
	/** If set, renders an InfiniteSlider (delta-based, works with an unbounded max) with this half-width window instead of a plain linear Slider. */
	range?: number;
	onValueChange: (value: number) => void;
}) {
	const t = useTranslation();
	const [overlayOpen, setOverlayOpen] = useState(false);
	const overlayValueChanged = useRef(false);
	const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pointerStartPos = useRef<{ x: number; y: number } | null>(null);
	const anchorRef = useRef<HTMLDivElement>(null);

	const handleSliderChange = useEventCallback((val: number) => {
		onValueChange(roundToStep(val, step));
	});

	const handleInputChange = useEventCallback((val: string | undefined) => {
		if (!val) return;
		const parsed = Number.parseFloat(val);
		if (!Number.isNaN(parsed) && parsed > 0) {
			onValueChange(roundToStep(parsed, step));
		}
	});

	const clearLongPress = useEventCallback(() => {
		if (longPressTimer.current) {
			clearTimeout(longPressTimer.current);
			longPressTimer.current = null;
		}
		pointerStartPos.current = null;
	});

	const handlePointerUp = useEventCallback(() => {
		clearLongPress();
		if (overlayOpen && overlayValueChanged.current) {
			overlayValueChanged.current = false;
			setOverlayOpen(false);
		}
	});

	const handlePointerDown = useEventCallback((e: React.PointerEvent) => {
		clearLongPress();
		pointerStartPos.current = { x: e.clientX, y: e.clientY };
		longPressTimer.current = setTimeout(() => {
			longPressTimer.current = null;
			setOverlayOpen(true);
		}, 300);
	});

	const handlePointerMove = useEventCallback((e: React.PointerEvent) => {
		if (!pointerStartPos.current) return;
		const dx = e.clientX - pointerStartPos.current.x;
		const dy = e.clientY - pointerStartPos.current.y;
		if (Math.hypot(dx, dy) > 5) {
			clearLongPress();
		}
	});

	const formattedValue = isMixed ? "—" : value.toFixed(stepDecimals(step));

	return (
		<div className="flex flex-col gap-1 w-full">
			<div className="flex items-center justify-between gap-2 px-1">
				<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
					{label}
				</span>
				<FakeInput
					$size="xs"
					type="number"
					min={min}
					max={max}
					step={step}
					value={isMixed ? undefined : formattedValue}
					onChange={handleInputChange}
					placeholder={isMixed ? t("actionsPanel.mixedBracket") : undefined}
				/>
			</div>
			<div
				ref={anchorRef}
				className="px-1"
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerLeave={clearLongPress}
			>
				{range != null ? (
					<InfiniteSlider
						min={min}
						max={max}
						range={range}
						step={step}
						value={isMixed ? min : value}
						onValueChange={handleSliderChange}
						className="w-full"
					/>
				) : (
					<Slider
						min={min}
						max={max}
						step={step}
						value={isMixed ? min : value}
						onValueChange={handleSliderChange}
						className="w-full"
					/>
				)}
			</div>

			{overlayOpen && (
				<SliderOverlay
					anchorRef={anchorRef}
					min={min}
					max={max}
					step={step}
					range={range}
					value={isMixed ? min : value}
					formattedValue={formattedValue}
					onValueChange={(val: number) => {
						overlayValueChanged.current = true;
						handleSliderChange(val);
					}}
					onClose={() => setOverlayOpen(false)}
				/>
			)}
		</div>
	);
});

function SliderOverlay({
	anchorRef,
	min,
	max,
	step,
	range,
	value,
	formattedValue,
	onValueChange,
	onClose,
}: {
	anchorRef: React.RefObject<HTMLDivElement | null>;
	min: number;
	max: number;
	step: number;
	range?: number;
	value: number;
	formattedValue: string;
	onValueChange: (value: number) => void;
	onClose: () => void;
}) {
	const overlayRef = useRef<HTMLDivElement>(null);
	const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [rect, setRect] = useState<DOMRect | null>(null);

	useEffect(() => {
		if (anchorRef.current) {
			setRect(anchorRef.current.getBoundingClientRect());
		}
	}, [anchorRef]);

	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		const handlePointerDown = (e: PointerEvent) => {
			if (
				overlayRef.current &&
				!overlayRef.current.contains(e.target as Node)
			) {
				onCloseRef.current();
			}
		};
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") onCloseRef.current();
		};

		document.addEventListener("pointerdown", handlePointerDown);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown);
			document.removeEventListener("keydown", handleKeyDown);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		return () => {
			if (autoCloseTimer.current) clearTimeout(autoCloseTimer.current);
		};
	}, []);

	const handleOverlayValueChange = useEventCallback(
		(val: number | readonly number[]) => {
			onValueChange(val as number);
			if (autoCloseTimer.current) clearTimeout(autoCloseTimer.current);
			autoCloseTimer.current = setTimeout(onClose, 200);
		},
	);

	const handleOverlayInputChange = useEventCallback(
		(val: string | undefined) => {
			if (!val) return;
			const parsed = Number.parseFloat(val);
			if (!Number.isNaN(parsed)) {
				onValueChange(parsed);
				if (autoCloseTimer.current) clearTimeout(autoCloseTimer.current);
				autoCloseTimer.current = setTimeout(onClose, 200);
			}
		},
	);

	if (!rect) return null;

	return createPortal(
		<div
			ref={overlayRef}
			className="fixed z-50 flex items-center gap-3 rounded-lg border border-border/50 bg-background/90 backdrop-liquid px-3 py-2 shadow-lg"
			style={{
				top: rect.top + rect.height / 2,
				left: rect.left,
				width: Math.max(rect.width, 256),
				transform: "translateY(-50%)",
			}}
			onPointerDown={(e) => e.stopPropagation()}
		>
			{range != null ? (
				<InfiniteSlider
					$size="lg"
					min={min}
					max={max}
					range={range}
					step={step}
					value={value}
					onValueChange={handleOverlayValueChange}
					className="flex-1"
				/>
			) : (
				<Slider
					$size="lg"
					min={min}
					max={max}
					step={step}
					value={value}
					onValueChange={handleOverlayValueChange}
					className="flex-1"
				/>
			)}
			<FakeInput
				$size="lg"
				type="number"
				min={min}
				max={max}
				step={step}
				value={formattedValue}
				onChange={handleOverlayInputChange}
				className="min-w-10 font-medium tabular-nums text-right"
			/>
		</div>,
		document.body,
	);
}

/** Decimal places implied by `step` (e.g. 0.1 → 1, 0.01 → 2, 1 → 0). */
function stepDecimals(step: number): number {
	return step >= 1 ? 0 : Math.max(0, -Math.floor(Math.log10(step)));
}

/** Round a value to the precision implied by `step`. */
function roundToStep(value: number, step: number): number {
	return Number(value.toFixed(stepDecimals(step)));
}
