"use client";

import { RotateCcw } from "lucide-react";
import { IconButton } from "@/components/IconButton";
import { Input } from "@/components/Input";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/**
 * Touch-type context bar: absolute-value adjustments for the selected chars
 * (size multiplier, tracking, leading, angle). Replaces the standard element
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
			rotation?: number;
			skewX?: number;
			skewY?: number;
			lineHeight?: number;
		}) => {
			paplico.textToolController?.getTextTool()?.setCharTouchValues(values);
		},
	);
	const handleSizeChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const value = Number.parseFloat(e.target.value);
			if (!Number.isNaN(value) && value > 0) apply({ fontSize: value });
		},
	);
	const handleKerningChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const value = Number.parseFloat(e.target.value);
			if (!Number.isNaN(value)) apply({ kerningAdjust: value });
		},
	);
	const handleLineHeightChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const value = Number.parseFloat(e.target.value);
			if (!Number.isNaN(value) && value > 0) apply({ lineHeight: value });
		},
	);
	const handleRotationChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const value = Number.parseFloat(e.target.value);
			if (!Number.isNaN(value)) apply({ rotation: value });
		},
	);
	const handleSkewXChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const value = Number.parseFloat(e.target.value);
			if (!Number.isNaN(value)) apply({ skewX: value });
		},
	);
	const handleSkewYChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const value = Number.parseFloat(e.target.value);
			if (!Number.isNaN(value)) apply({ skewY: value });
		},
	);
	const handleReset = useEventCallback(() => {
		paplico.textToolController?.getTextTool()?.resetCharTouchValues();
	});

	const round3 = (value: number) => Math.round(value * 1000) / 1000;
	const mixed = (value: number | undefined) =>
		selection && value === undefined ? t("actionsPanel.mixed") : undefined;

	const field = (label: string, input: React.ReactNode) => (
		<div className="flex items-center gap-1 px-0.5">
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
				<Input
					type="number"
					$size="xs"
					aria-label={t("actionsPanel.size")}
					step="1"
					value={selection?.fontSize != null ? round3(selection.fontSize) : ""}
					onChange={handleSizeChange}
					placeholder={mixed(selection?.fontSize) ?? "24"}
					className="w-14"
					disabled={disabled}
				/>,
			)}
			{field(
				t("actionsPanel.letterSpacing"),
				<Input
					type="number"
					$size="xs"
					aria-label={t("actionsPanel.letterSpacing")}
					step="0.01"
					value={selection?.kerningAdjust ?? ""}
					onChange={handleKerningChange}
					placeholder={mixed(selection?.kerningAdjust) ?? "0"}
					className="w-14"
					disabled={disabled}
				/>,
			)}
			{field(
				t("actionsPanel.lineSpacing"),
				<Input
					type="number"
					$size="xs"
					aria-label={t("actionsPanel.lineSpacing")}
					step="0.05"
					value={selection?.lineHeight ?? ""}
					onChange={handleLineHeightChange}
					placeholder={mixed(selection?.lineHeight) ?? "1.5"}
					className="w-14"
					disabled={disabled}
				/>,
			)}
			{field(
				t("contextActions.charAngle"),
				<Input
					type="number"
					$size="xs"
					aria-label={t("contextActions.charAngle")}
					step="1"
					value={selection?.rotation ?? ""}
					onChange={handleRotationChange}
					placeholder={mixed(selection?.rotation) ?? "0"}
					className="w-14"
					disabled={disabled}
				/>,
			)}
			{field(
				t("contextActions.charSkewX"),
				<Input
					type="number"
					$size="xs"
					aria-label={t("contextActions.charSkewX")}
					step="1"
					value={selection?.skewX ?? ""}
					onChange={handleSkewXChange}
					placeholder={mixed(selection?.skewX) ?? "0"}
					className="w-14"
					disabled={disabled}
				/>,
			)}
			{field(
				t("contextActions.charSkewY"),
				<Input
					type="number"
					$size="xs"
					aria-label={t("contextActions.charSkewY")}
					step="1"
					value={selection?.skewY ?? ""}
					onChange={handleSkewYChange}
					placeholder={mixed(selection?.skewY) ?? "0"}
					className="w-14"
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
