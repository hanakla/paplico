import {
	Check,
	ClipboardPaste,
	Copy,
	Scissors,
	TextSelect,
} from "lucide-react";
import { useSnapshot } from "valtio";
import { ColorPickerThin } from "@/components/ColorPicker2";
import { ColorSwatch } from "@/components/ColorSwatch";
import { IconButton } from "@/components/IconButton";
import { Input } from "@/components/Input";
import { Popover } from "@/components/Popover";
import { Separator } from "@/components/Separator";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { createDefaultColor } from "@/core/document/factory";
import type { Color, TextStyle } from "@/core/schema";
import { useActiveFontSettings } from "@/hooks/useCurrentFontSetting";
import { useFontPreview } from "@/hooks/useFontPreview";
import { useTranslation } from "@/locales";
import { FontCombobox } from "@/organisms/ActionsPanel/FontCombobox";
import { TextCharTouchModeToggle } from "@/organisms/ActionsPanel/TextEditingControls";
import { uiState } from "@/stores/uiStore";
import { useEventCallback } from "@/utils/hooks";

/**
 * Actions available while a text element is being edited: style controls
 * (font / size / color) for the selection — or, with a caret only, for the
 * characters typed next (pendingCaretStyle in TextTool) — plus clipboard
 * operations and edit confirmation.
 */
export function TextEditActions() {
	const t = useTranslation();
	const paplico = usePaplico();
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
	} = useActiveFontSettings();
	const { previewReady, previewRef } = useFontPreview();
	const textSelectionStyle = uiSnap.textEditState
		.selectionStyle as Partial<TextStyle> | null;
	const textFillColor =
		textSelectionStyle?.fill?.type === "solid"
			? (textSelectionStyle.fill.color as Color)
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
		paplico.tools.state.textDefaultStyle.fill = { type: "solid", color };
		paplico.textToolController
			?.getTextTool()
			?.applyStyleToSelection({ fill: { type: "solid", color } });
	});
	const handleTextCopy = useEventCallback(() => {
		paplico.textToolController?.getTextTool()?.copyToClipboard();
	});
	const handleTextCut = useEventCallback(() => {
		paplico.textToolController?.getTextTool()?.cutToClipboard();
	});
	const handleTextPaste = useEventCallback(() => {
		paplico.textToolController?.getTextTool()?.pasteFromClipboard();
	});
	const handleTextSelectAll = useEventCallback(() => {
		paplico.textToolController?.getTextTool()?.selectAll();
	});
	const handleConfirmTextEdit = useEventCallback(() => {
		paplico.textToolController?.getTextTool()?.onCancel();
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
			<TextCharTouchModeToggle />
			<Separator orientation="vertical" className="mx-0.5 h-5" />
			<Tooltip content={t("common.cut")} side="bottom">
				<IconButton
					$size="md"
					$variant="ghost"
					className="text-foreground"
					aria-label={t("common.cut")}
					onClick={handleTextCut}
				>
					<Scissors size={18} />
				</IconButton>
			</Tooltip>
			<Tooltip content={t("common.copy")} side="bottom">
				<IconButton
					$size="md"
					$variant="ghost"
					className="text-foreground"
					aria-label={t("common.copy")}
					onClick={handleTextCopy}
				>
					<Copy size={18} />
				</IconButton>
			</Tooltip>
			<Tooltip content={t("common.paste")} side="bottom">
				<IconButton
					$size="md"
					$variant="ghost"
					className="text-foreground"
					aria-label={t("common.paste")}
					onClick={handleTextPaste}
				>
					<ClipboardPaste size={18} />
				</IconButton>
			</Tooltip>
			<Tooltip content={t("common.selectAll")} side="bottom">
				<IconButton
					$size="md"
					$variant="ghost"
					className="text-foreground"
					aria-label={t("common.selectAll")}
					onClick={handleTextSelectAll}
				>
					<TextSelect size={18} />
				</IconButton>
			</Tooltip>
			<Tooltip content={t("contextActions.confirmTextEdit")} side="bottom">
				<IconButton
					$size="md"
					$variant="ghost"
					className="text-green-600"
					aria-label={t("contextActions.confirmTextEdit")}
					onClick={handleConfirmTextEdit}
				>
					<Check size={18} />
				</IconButton>
			</Tooltip>
		</>
	);
}
