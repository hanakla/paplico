import type { TextStyle } from "@paplico/core/schema";
import type { SelectionStyleSummary } from "@paplico/core/tools";
import {
	AlignCenter,
	AlignLeft,
	AlignRight,
	MoveHorizontal,
	Strikethrough,
	Underline,
} from "lucide-react";
import { memo } from "react";
import { useSnapshot } from "valtio";
import { IconButton } from "@/components/IconButton";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useActiveFontSettings } from "@/hooks/useCurrentFontSetting";
import { useFontPreview } from "@/hooks/useFontPreview";
import { useTranslation } from "@/locales";
import { FontCombobox } from "@/organisms/TextControls/FontCombobox";
import { FontWeightControl } from "@/organisms/TextControls/FontWeightControl";
import { TextCharTouchModeToggle } from "@/organisms/TextControls/TextCharTouchModeToggle";
import { uiState } from "@/stores/uiStore";
import { useEventCallback } from "@/utils/hooks";
import { StrokeWidthField } from "./StrokeWidthField";

export const TextEditingControls = memo(function TextEditingControls() {
	const uiSnap = useSnapshot(uiState);

	const displayStyle = (uiSnap.textEditState.selectionStyle?.style ?? null) as
		| SelectionStyleSummary["style"]
		| null;

	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-col gap-1.5">
				<TextEditFontFamilyControl />
				<TextEditFontSizeControl />
			</div>
			<TextEditTextDecorationControl currentStyle={displayStyle} />
			<div className="flex flex-col gap-1.5">
				<TextEditLetterSpacingControl currentStyle={displayStyle} />
				<TextEditLineSpacingControl currentStyle={displayStyle} />
			</div>
			<TextEditAlignmentControl />
			<TextCharTouchModeToggle />
		</div>
	);
});

function TextEditFontFamilyControl() {
	const t = useTranslation();
	const { fonts, isLoading, currentFont, isMixed, handleFontChange } =
		useActiveFontSettings();
	const { previewReady, previewRef } = useFontPreview();

	return (
		<div className="flex flex-col gap-1.5">
			<span className="type-section text-muted-foreground">
				{t("actionsPanel.font")}
			</span>
			<FontCombobox
				fonts={fonts}
				currentFont={currentFont}
				isLoading={isLoading}
				onFontChange={handleFontChange}
				previewReady={previewReady}
				previewRef={previewRef}
				placeholder={
					isLoading
						? t("actionsPanel.loading")
						: isMixed
							? t("actionsPanel.mixed")
							: undefined
				}
			/>
			<FontWeightControl showLabel={false} slider={false} />
		</div>
	);
}

function TextEditFontSizeControl() {
	const t = useTranslation();
	const { currentFontSize, isMixedSize, handleFontSizeChange } =
		useActiveFontSettings();

	return (
		<StrokeWidthField
			label={t("actionsPanel.size")}
			value={currentFontSize}
			isMixed={isMixedSize}
			min={1}
			max={1000}
			step={1}
			slider={false}
			onValueChange={handleFontSizeChange}
		/>
	);
}

function TextEditTextDecorationControl({
	currentStyle,
}: {
	currentStyle: SelectionStyleSummary["style"] | null;
}) {
	const t = useTranslation();
	const paplico = usePaplico();

	const isUnderline =
		!!currentStyle &&
		!currentStyle.underline.mixed &&
		currentStyle.underline.value;
	const isStrikethrough =
		!!currentStyle &&
		!currentStyle.strikethrough.mixed &&
		currentStyle.strikethrough.value;
	const isTateChuYoko =
		!!currentStyle &&
		!currentStyle.tateChuYoko.mixed &&
		!!currentStyle.tateChuYoko.value;

	const handleToggle = useEventCallback((updates: Partial<TextStyle>) => {
		const textTool = paplico.textToolController?.getTextTool();
		textTool?.applyStyleToSelection(updates);
	});
	const handleTateChuYokoToggle = useEventCallback(() => {
		handleToggle({ tateChuYoko: !isTateChuYoko });
	});

	return (
		<div className="flex gap-1 px-1">
			<Tooltip content={t("actionsPanel.underline")} side="bottom">
				<IconButton
					$size="xs"
					$variant={isUnderline ? "default" : "ghost"}
					onClick={() => handleToggle({ underline: !isUnderline })}
				>
					<Underline size={14} />
				</IconButton>
			</Tooltip>
			<Tooltip content={t("actionsPanel.strikethrough")} side="bottom">
				<IconButton
					$size="xs"
					$variant={isStrikethrough ? "default" : "ghost"}
					onClick={() => handleToggle({ strikethrough: !isStrikethrough })}
				>
					<Strikethrough size={14} />
				</IconButton>
			</Tooltip>
			<Tooltip content={t("actionsPanel.tateChuYoko")} side="bottom">
				<IconButton
					$size="xs"
					$variant={isTateChuYoko ? "default" : "ghost"}
					onClick={handleTateChuYokoToggle}
				>
					<MoveHorizontal size={14} />
				</IconButton>
			</Tooltip>
		</div>
	);
}

function TextEditLetterSpacingControl({
	currentStyle,
}: {
	currentStyle: SelectionStyleSummary["style"] | null;
}) {
	const t = useTranslation();
	const currentSpacing =
		currentStyle && !currentStyle.letterSpacing.mixed
			? currentStyle.letterSpacing.value
			: undefined;

	const paplico = usePaplico();

	const handleSpacingChange = useEventCallback((value: number) => {
		paplico.textToolController
			?.getTextTool()
			?.applyStyleToSelection({ letterSpacing: value });
	});

	return (
		<StrokeWidthField
			label={t("actionsPanel.letterSpacing")}
			value={currentSpacing ?? 0}
			isMixed={currentStyle?.letterSpacing.mixed}
			min={Number.NEGATIVE_INFINITY}
			max={Number.POSITIVE_INFINITY}
			step={0.01}
			slider={false}
			onValueChange={handleSpacingChange}
		/>
	);
}

function TextEditLineSpacingControl({
	currentStyle,
}: {
	currentStyle: SelectionStyleSummary["style"] | null;
}) {
	const t = useTranslation();
	const currentLineHeight =
		currentStyle && !currentStyle.lineHeight.mixed
			? currentStyle.lineHeight.value
			: undefined;

	const paplico = usePaplico();

	// Applies to the selection, or to the caret's visual line when nothing is
	// selected (same targeting as the Alt+Arrow shortcut)
	const handleLineHeightChange = useEventCallback((value: number) => {
		paplico.textToolController?.getTextTool()?.setLineSpacing(value);
	});

	return (
		<StrokeWidthField
			label={t("actionsPanel.lineSpacing")}
			value={currentLineHeight ?? 1.5}
			isMixed={currentStyle?.lineHeight.mixed}
			min={0.1}
			max={10}
			step={0.05}
			slider={false}
			onValueChange={handleLineHeightChange}
		/>
	);
}

function TextEditAlignmentControl() {
	const t = useTranslation();
	const paplico = usePaplico();
	const textTool = paplico.textToolController?.getTextTool() ?? null;
	useSnapshot(uiState);

	const currentAlignment = textTool?.getCurrentParagraphAlignment() ?? "left";

	const handleChange = useEventCallback(
		(alignment: "left" | "center" | "right") => {
			textTool?.changeParagraphAlignment(alignment);
		},
	);

	return (
		<div className="flex flex-col gap-1.5">
			<span className="type-section text-muted-foreground">
				{t("actionsPanel.align")}
			</span>
			<div className="flex gap-1 px-1">
				<Tooltip content={t("actionsPanel.left")} side="bottom">
					<IconButton
						$size="xs"
						$variant={currentAlignment === "left" ? "default" : "ghost"}
						onClick={() => handleChange("left")}
					>
						<AlignLeft size={14} />
					</IconButton>
				</Tooltip>
				<Tooltip content={t("actionsPanel.center")} side="bottom">
					<IconButton
						$size="xs"
						$variant={currentAlignment === "center" ? "default" : "ghost"}
						onClick={() => handleChange("center")}
					>
						<AlignCenter size={14} />
					</IconButton>
				</Tooltip>
				<Tooltip content={t("actionsPanel.right")} side="bottom">
					<IconButton
						$size="xs"
						$variant={currentAlignment === "right" ? "default" : "ghost"}
						onClick={() => handleChange("right")}
					>
						<AlignRight size={14} />
					</IconButton>
				</Tooltip>
			</div>
		</div>
	);
}
