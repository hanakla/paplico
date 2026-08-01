import {
	AlignCenter,
	AlignLeft,
	AlignRight,
	Bold,
	Check,
	Italic,
	MoveHorizontal,
	Pointer,
	Strikethrough,
	Underline,
} from "lucide-react";
import { memo } from "react";
import { useSnapshot } from "valtio";
import { IconButton } from "@/components/IconButton";
import { Input } from "@/components/Input";
import { InfiniteSlider } from "@/components/Slider";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import type { TextStyle } from "@/core/schema";
import { useActiveFontSettings } from "@/hooks/useCurrentFontSetting";
import { useFontPreview } from "@/hooks/useFontPreview";
import { useTranslation } from "@/locales";
import { uiState } from "@/stores/uiStore";
import { useEventCallback } from "@/utils/hooks";
import { FontCombobox } from "./FontCombobox";

export const TextEditingControls = memo(function TextEditingControls() {
	const uiSnap = useSnapshot(uiState);

	const displayStyle = uiSnap.textEditState
		.selectionStyle as Partial<TextStyle> | null;

	return (
		<div className="flex flex-col gap-3">
			<TextEditFontFamilyControl />
			<TextEditFontSizeControl />
			<TextEditTextDecorationControl currentStyle={displayStyle} />
			<TextEditLetterSpacingControl currentStyle={displayStyle} />
			<TextEditLineSpacingControl currentStyle={displayStyle} />
			<TextEditAlignmentControl />
			<TextCharTouchModeToggle />
		</div>
	);
});

/**
 * Touch-type mode toggle (per-char move/rotate/scale). Shared between the
 * editing controls and the text tool's idle panel.
 */
export function TextCharTouchModeToggle() {
	const t = useTranslation();
	const paplico = usePaplico();
	const touchOn = useSnapshot(paplico.tools.state).textCharTouchMode;

	const handleToggle = useEventCallback(() => {
		if (touchOn) {
			// End char-touch by returning to text editing on the same element,
			// not just flipping the mode off.
			paplico.textToolController?.getTextTool()?.endCharTouchToEdit();
		} else {
			paplico.tools.state.textCharTouchMode = true;
		}
	});

	return (
		<div className="flex px-1">
			<Tooltip
				content={
					touchOn
						? t("actionsPanel.charTouchBackToEdit")
						: t("actionsPanel.charTouchMode")
				}
				side="bottom"
			>
				<IconButton
					$size="xs"
					$variant="ghost"
					$pressed={touchOn}
					onClick={handleToggle}
				>
					{touchOn ? <Check size={14} /> : <Pointer size={14} />}
				</IconButton>
			</Tooltip>
		</div>
	);
}

function TextEditFontFamilyControl() {
	const t = useTranslation();
	const { fonts, isLoading, currentFont, isMixed, handleFontChange } =
		useActiveFontSettings();
	const { previewReady, previewRef } = useFontPreview();

	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
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
		</div>
	);
}

function TextEditFontSizeControl() {
	const t = useTranslation();
	const { currentFontSize, isMixedSize, handleFontSizeChange } =
		useActiveFontSettings();

	const handleSliderChange = useEventCallback((value: number) => {
		handleFontSizeChange(value);
	});

	const handleInputChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const newSize = Number.parseFloat(e.target.value);
			if (!Number.isNaN(newSize) && newSize > 0) {
				handleFontSizeChange(newSize);
			}
		},
	);

	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
				{t("actionsPanel.size")}
			</span>
			<div className="flex items-center gap-2 px-1">
				<div className="relative flex-1">
					<InfiniteSlider
						min={1}
						max={1000}
						range={50}
						step={1}
						value={currentFontSize}
						onValueChange={handleSliderChange}
					/>
					{isMixedSize && (
						<span className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground pointer-events-none">
							{t("actionsPanel.mixed")}
						</span>
					)}
				</div>
				<Input
					type="number"
					$size="xs"
					min="1"
					max="1000"
					step="1"
					value={isMixedSize ? "" : currentFontSize}
					onChange={handleInputChange}
					placeholder={isMixedSize ? t("actionsPanel.mixed") : undefined}
					className="w-14"
				/>
			</div>
		</div>
	);
}

function TextEditTextDecorationControl({
	currentStyle,
}: {
	currentStyle: Partial<TextStyle> | null;
}) {
	const t = useTranslation();
	const paplico = usePaplico();

	const isBold = (currentStyle?.fontWeight ?? 400) >= 700;
	const isItalic = currentStyle?.fontStyle === "italic";
	const isUnderline = currentStyle?.underline ?? false;
	const isStrikethrough = currentStyle?.strikethrough ?? false;
	const isTateChuYoko = currentStyle?.tateChuYoko ?? false;

	const handleToggle = useEventCallback((updates: Partial<TextStyle>) => {
		const textTool = paplico.textToolController?.getTextTool();
		textTool?.applyStyleToSelection(updates);
	});
	const handleTateChuYokoToggle = useEventCallback(() => {
		handleToggle({ tateChuYoko: !isTateChuYoko });
	});

	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
				{t("actionsPanel.style")}
			</span>
			<div className="flex gap-1 px-1">
				<Tooltip content={t("actionsPanel.bold")} side="bottom">
					<IconButton
						$size="xs"
						$variant={isBold ? "default" : "ghost"}
						onClick={() => handleToggle({ fontWeight: isBold ? 400 : 700 })}
					>
						<Bold size={14} />
					</IconButton>
				</Tooltip>
				<Tooltip content={t("actionsPanel.italic")} side="bottom">
					<IconButton
						$size="xs"
						$variant={isItalic ? "default" : "ghost"}
						onClick={() =>
							handleToggle({
								fontStyle: isItalic ? "normal" : "italic",
							})
						}
					>
						<Italic size={14} />
					</IconButton>
				</Tooltip>
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
		</div>
	);
}

function TextEditLetterSpacingControl({
	currentStyle,
}: {
	currentStyle: Partial<TextStyle> | null;
}) {
	const t = useTranslation();
	const currentSpacing = currentStyle?.letterSpacing;

	const paplico = usePaplico();

	const handleSpacingChange = useEventCallback((value: number) => {
		if (!Number.isNaN(value)) {
			const textTool = paplico.textToolController?.getTextTool();
			textTool?.applyStyleToSelection({ letterSpacing: value });
		}
	});

	const handleSpacingInputChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			handleSpacingChange(Number.parseFloat(e.target.value));
		},
	);

	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
				{t("actionsPanel.letterSpacing")}
			</span>
			<div className="flex items-center gap-2 px-1">
				<InfiniteSlider
					min={Number.NEGATIVE_INFINITY}
					max={Number.POSITIVE_INFINITY}
					range={0.25}
					step={0.01}
					value={currentSpacing ?? 0}
					onValueChange={handleSpacingChange}
					className="flex-1"
				/>
				<Input
					type="number"
					$size="xs"
					step="0.01"
					value={currentSpacing ?? ""}
					onChange={handleSpacingInputChange}
					placeholder="0"
					className="w-14"
				/>
			</div>
		</div>
	);
}

function TextEditLineSpacingControl({
	currentStyle,
}: {
	currentStyle: Partial<TextStyle> | null;
}) {
	const t = useTranslation();
	const currentLineHeight = currentStyle?.lineHeight;

	const paplico = usePaplico();

	// Applies to the selection, or to the caret's visual line when nothing is
	// selected (same targeting as the Alt+Arrow shortcut)
	const handleLineHeightChange = useEventCallback((value: number) => {
		if (!Number.isNaN(value)) {
			const textTool = paplico.textToolController?.getTextTool();
			textTool?.setLineSpacing(value);
		}
	});

	const handleLineHeightInputChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			handleLineHeightChange(Number.parseFloat(e.target.value));
		},
	);

	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
				{t("actionsPanel.lineSpacing")}
			</span>
			<div className="flex items-center gap-2 px-1">
				<InfiniteSlider
					min={0.1}
					max={10}
					range={0.5}
					step={0.05}
					value={currentLineHeight ?? 1.5}
					onValueChange={handleLineHeightChange}
					className="flex-1"
				/>
				<Input
					type="number"
					$size="xs"
					min="0.1"
					max="10"
					step="0.1"
					value={currentLineHeight ?? ""}
					onChange={handleLineHeightInputChange}
					placeholder="1.5"
					className="w-14"
				/>
			</div>
		</div>
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
			<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
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
