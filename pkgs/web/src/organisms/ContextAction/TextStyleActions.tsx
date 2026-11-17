import { createDefaultColor } from "@paplico/core/document";
import type { Color } from "@paplico/core/schema";
import { useSnapshot } from "valtio";
import { ColorPickerThin } from "@/components/ColorPicker2";
import { ColorSwatch } from "@/components/ColorSwatch";
import { IconButton } from "@/components/IconButton";
import { Input } from "@/components/Input";
import { Popover } from "@/components/Popover";
import { Separator } from "@/components/Separator";
import { Tooltip } from "@/components/Tooltip";
import { useActiveFontSettings } from "@/hooks/useCurrentFontSetting";
import { useFontPreview } from "@/hooks/useFontPreview";
import { useTranslation } from "@/locales";
import { FontCombobox } from "@/organisms/TextControls/FontCombobox";
import { uiState } from "@/stores/uiStore";
import { useEventCallback } from "@/utils/hooks";
import { FontVariationPopover } from "./FontVariationPopover";

export function TextStyleActions() {
	const t = useTranslation();
	const uiSnap = useSnapshot(uiState);
	const {
		fonts,
		isLoading: fontsLoading,
		currentFont,
		currentFontSize,
		isMixed: fontIsMixed,
		isMixedSize,
		handleFontChange,
		handleFontSizeChange,
		textStyles,
		applyTextStyle,
		handleFontVariationChange,
	} = useActiveFontSettings();
	const { previewReady, previewRef } = useFontPreview();
	const isEditing = uiSnap.textEditState.isEditing;
	const selectedFill = textStyles[0]?.fill;
	const fillsMatch = textStyles.every(
		(style) => JSON.stringify(style.fill) === JSON.stringify(selectedFill),
	);
	const textFill = isEditing
		? uiSnap.textEditState.selectionStyle?.style.fill
		: fillsMatch
			? { mixed: false as const, value: selectedFill }
			: undefined;
	const textFillColor =
		textFill && !textFill.mixed && textFill.value?.type === "solid"
			? (textFill.value.color as Color)
			: null;

	const handleTextFontSizeInput = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const newSize = Number.parseFloat(e.target.value);
			if (!Number.isNaN(newSize) && newSize > 0) {
				handleFontSizeChange(newSize);
			}
		},
	);
	const handleTextColorChange = useEventCallback((color: Color) => {
		applyTextStyle({ fill: { type: "solid", color } });
	});

	return (
		<>
			<div className="w-36 flex-none">
				<FontCombobox
					fonts={fonts}
					currentFont={currentFont}
					isLoading={fontsLoading}
					isMixed={fontIsMixed}
					onFontChange={handleFontChange}
					previewReady={previewReady}
					previewRef={previewRef}
					placeholder={
						fontsLoading
							? t("actionsPanel.loading")
							: fontIsMixed
								? t("actionsPanel.mixed")
								: undefined
					}
				/>
			</div>
			<Tooltip content={t("actionsPanel.size")} side="bottom">
				<Input
					type="number"
					$size="xs"
					min="1"
					max="1000"
					step="1"
					value={isMixedSize ? "" : currentFontSize}
					onChange={handleTextFontSizeInput}
					placeholder={isMixedSize ? t("actionsPanel.mixed") : undefined}
					className="w-14 flex-none"
				/>
			</Tooltip>
			<FontVariationPopover
				textStyles={isEditing ? undefined : textStyles}
				onVariationChange={handleFontVariationChange}
			/>
			<Popover.Root>
				<Tooltip content={t("contextActions.textColor")} side="bottom">
					<Popover.Trigger>
						<IconButton
							$size="md"
							$variant="ghost"
							className="text-foreground"
							aria-label={t("contextActions.textColor")}
						>
							<ColorSwatch
								color={
									textFillColor ? { type: "solid", color: textFillColor } : null
								}
								variant="fill"
								size={20}
							/>
						</IconButton>
					</Popover.Trigger>
				</Tooltip>
				<Popover.Content side="top" sideOffset={12} positionMethod="absolute">
					<div data-context-actions-popover>
						<ColorPickerThin
							color={textFillColor ?? createDefaultColor()}
							onColorChange={handleTextColorChange}
						/>
					</div>
				</Popover.Content>
			</Popover.Root>
			<Separator orientation="vertical" className="mx-0.5 h-5" />
		</>
	);
}
