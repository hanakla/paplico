"use client";

import { RotateCcw } from "lucide-react";
import { FakeInput } from "@/components/FakeInput";
import { IconButton } from "@/components/IconButton";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { roundToStep, stepDecimals } from "@/utils/stepPrecision";

/** Shear input clamp: tan() blows up approaching ±90°. */
const MAX_SKEW_DEG = 89;
/** Field steps; values are shown and committed at each step's precision. */
const STEP = {
	fontSize: 1,
	kerningAdjust: 0.01,
	lineHeight: 0.05,
	scalePercent: 1,
	degrees: 1,
} as const;

/**
 * Touch-type context bar: absolute-value adjustments for the selected chars
 * (size multiplier, tracking, leading, width, height, angle, skew). Replaces the standard element
 * actions while the touch-type mode is active.
 */
export function CharTouchAdjustControls() {
	const t = useTranslation();
	const paplico = usePaplico();
	// The parent bar re-renders on overlay/store changes; read live values
	const selection =
		paplico.textToolController?.getTextTool()?.getCharTouchSelection() ?? null;
	const disabled = !selection || selection.count === 0;

	const apply = useEventCallback(
		(values: {
			fontSize?: number;
			kerningAdjust?: number;
			scaleX?: number;
			scaleY?: number;
			rotation?: number;
			skewX?: number;
			skewY?: number;
			lineHeight?: number;
		}) => {
			paplico.textToolController?.getTextTool()?.setCharTouchValues(values);
		},
	);
	const handleSizeChange = useEventCallback((input: string | undefined) => {
		const value = Number.parseFloat(input ?? "");
		if (!Number.isNaN(value) && value > 0)
			apply({ fontSize: roundToStep(value, STEP.fontSize) });
	});
	const handleKerningChange = useEventCallback((input: string | undefined) => {
		const value = Number.parseFloat(input ?? "");
		if (!Number.isNaN(value))
			apply({ kerningAdjust: roundToStep(value, STEP.kerningAdjust) });
	});
	const handleLineHeightChange = useEventCallback(
		(input: string | undefined) => {
			const value = Number.parseFloat(input ?? "");
			if (!Number.isNaN(value) && value > 0)
				apply({ lineHeight: roundToStep(value, STEP.lineHeight) });
		},
	);
	// The fields show percent; the tool takes a multiplier
	const handleScaleXChange = useEventCallback((value: string | undefined) => {
		const percent = Number.parseFloat(value ?? "");
		if (!Number.isNaN(percent) && percent > 0)
			apply({ scaleX: roundToStep(percent, STEP.scalePercent) / 100 });
	});
	const handleScaleYChange = useEventCallback((value: string | undefined) => {
		const percent = Number.parseFloat(value ?? "");
		if (!Number.isNaN(percent) && percent > 0)
			apply({ scaleY: roundToStep(percent, STEP.scalePercent) / 100 });
	});
	const handleRotationChange = useEventCallback((input: string | undefined) => {
		const value = Number.parseFloat(input ?? "");
		if (!Number.isNaN(value))
			apply({ rotation: roundToStep(value, STEP.degrees) });
	});
	const handleSkewXChange = useEventCallback((input: string | undefined) => {
		const value = Number.parseFloat(input ?? "");
		if (!Number.isNaN(value))
			apply({ skewX: clampSkew(roundToStep(value, STEP.degrees)) });
	});
	const handleSkewYChange = useEventCallback((input: string | undefined) => {
		const value = Number.parseFloat(input ?? "");
		if (!Number.isNaN(value))
			apply({ skewY: clampSkew(roundToStep(value, STEP.degrees)) });
	});
	const handleReset = useEventCallback(() => {
		paplico.textToolController?.getTextTool()?.resetCharTouchValues();
	});
	// Panel commits merge into the open undo step so a scrub stays one step.
	// Closing it when an edit starts and ends keeps that step apart from the
	// edits before and after, such as a handle drag a moment away.
	const closeUndoStep = useEventCallback(() => {
		paplico.commands.stopUndoCapture();
	});
	// A held arrow key repeats keydown; its steps stay in one undo step
	const handleKeyDownCapture = useEventCallback((e: React.KeyboardEvent) => {
		if (!e.repeat) closeUndoStep();
	});

	const format = (value: number | undefined, step: number) =>
		value?.toFixed(stepDecimals(step)) ?? "";
	const mixed = (value: number | undefined) =>
		selection && value === undefined ? t("actionsPanel.mixed") : undefined;

	const field = (label: string, input: React.ReactNode) => (
		<div
			className="flex items-center gap-1.5 px-1.5"
			onPointerDownCapture={closeUndoStep}
			onKeyDownCapture={handleKeyDownCapture}
		>
			<span className="text-[10px] whitespace-nowrap text-muted-foreground">
				{label}
			</span>
			{input}
		</div>
	);

	return (
		<>
			{field(
				t("actionsPanel.size"),
				<FakeInput
					type="number"
					$size="xs"
					aria-label={t("actionsPanel.size")}
					step={STEP.fontSize}
					min={1}
					value={format(selection?.fontSize, STEP.fontSize)}
					onChange={handleSizeChange}
					onValueCommitted={closeUndoStep}
					placeholder={mixed(selection?.fontSize) ?? "24"}
					className="tabular-nums"
					disabled={disabled}
				/>,
			)}
			{field(
				t("actionsPanel.letterSpacing"),
				<FakeInput
					type="number"
					$size="xs"
					aria-label={t("actionsPanel.letterSpacing")}
					step={STEP.kerningAdjust}
					value={format(selection?.kerningAdjust, STEP.kerningAdjust)}
					onChange={handleKerningChange}
					onValueCommitted={closeUndoStep}
					placeholder={mixed(selection?.kerningAdjust) ?? "0"}
					className="tabular-nums"
					disabled={disabled}
				/>,
			)}
			{field(
				t("actionsPanel.lineSpacing"),
				<FakeInput
					type="number"
					$size="xs"
					aria-label={t("actionsPanel.lineSpacing")}
					step={STEP.lineHeight}
					min={0.1}
					value={format(selection?.lineHeight, STEP.lineHeight)}
					onChange={handleLineHeightChange}
					onValueCommitted={closeUndoStep}
					placeholder={mixed(selection?.lineHeight) ?? "1.5"}
					className="tabular-nums"
					disabled={disabled}
				/>,
			)}
			{field(
				t("contextActions.charScaleX"),
				<FakeInput
					type="number"
					$size="xs"
					aria-label={t("contextActions.charScaleX")}
					step={STEP.scalePercent}
					min={10}
					max={1000}
					value={format(
						selection?.scaleX != null ? selection.scaleX * 100 : undefined,
						STEP.scalePercent,
					)}
					onChange={handleScaleXChange}
					onValueCommitted={closeUndoStep}
					placeholder={mixed(selection?.scaleX) ?? "100"}
					className="tabular-nums"
					disabled={disabled}
				/>,
			)}
			{field(
				t("contextActions.charScaleY"),
				<FakeInput
					type="number"
					$size="xs"
					aria-label={t("contextActions.charScaleY")}
					step={STEP.scalePercent}
					min={10}
					max={1000}
					value={format(
						selection?.scaleY != null ? selection.scaleY * 100 : undefined,
						STEP.scalePercent,
					)}
					onChange={handleScaleYChange}
					onValueCommitted={closeUndoStep}
					placeholder={mixed(selection?.scaleY) ?? "100"}
					className="tabular-nums"
					disabled={disabled}
				/>,
			)}
			{field(
				t("contextActions.charAngle"),
				<FakeInput
					type="number"
					$size="xs"
					aria-label={t("contextActions.charAngle")}
					step={STEP.degrees}
					value={format(selection?.rotation, STEP.degrees)}
					onChange={handleRotationChange}
					onValueCommitted={closeUndoStep}
					placeholder={mixed(selection?.rotation) ?? "0"}
					className="tabular-nums"
					disabled={disabled}
				/>,
			)}
			{field(
				t("contextActions.charSkewX"),
				<FakeInput
					type="number"
					$size="xs"
					aria-label={t("contextActions.charSkewX")}
					step={STEP.degrees}
					value={format(selection?.skewX, STEP.degrees)}
					onChange={handleSkewXChange}
					onValueCommitted={closeUndoStep}
					placeholder={mixed(selection?.skewX) ?? "0"}
					className="tabular-nums"
					disabled={disabled}
				/>,
			)}
			{field(
				t("contextActions.charSkewY"),
				<FakeInput
					type="number"
					$size="xs"
					aria-label={t("contextActions.charSkewY")}
					step={STEP.degrees}
					value={format(selection?.skewY, STEP.degrees)}
					onChange={handleSkewYChange}
					onValueCommitted={closeUndoStep}
					placeholder={mixed(selection?.skewY) ?? "0"}
					className="tabular-nums"
					disabled={disabled}
				/>,
			)}
			<Tooltip content={t("contextActions.resetCharStyle")} side="bottom">
				<IconButton
					$size="xs"
					$variant="ghost"
					aria-label={t("contextActions.resetCharStyle")}
					onClick={handleReset}
					disabled={disabled}
				>
					<RotateCcw size={14} />
				</IconButton>
			</Tooltip>
		</>
	);
}

function clampSkew(degrees: number): number {
	return Math.min(MAX_SKEW_DEG, Math.max(-MAX_SKEW_DEG, degrees));
}
