import {
	Check,
	ClipboardPaste,
	Copy,
	Scissors,
	TextSelect,
} from "lucide-react";
import { IconButton } from "@/components/IconButton";
import { Separator } from "@/components/Separator";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { TextCharTouchModeToggle } from "@/organisms/TextControls/TextCharTouchModeToggle";
import { TextTateChuYokoToggle } from "@/organisms/TextControls/TextTateChuYokoToggle";
import { useEventCallback } from "@/utils/hooks";
import { TextStyleActions } from "./TextStyleActions";

/**
 * Actions available while a text element is being edited: style controls
 * (font / size / color) for the selection — or, with a caret only, for the
 * characters typed next (pendingCaretStyle in TextTool) — plus clipboard
 * operations and edit confirmation.
 */
export function TextEditActions() {
	const t = useTranslation();
	const paplico = usePaplico();

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
		// The clicked button holds focus and unmounts with the edit UI
		paplico.ui?.focusCanvas();
	});

	return (
		<>
			<TextStyleActions />
			<TextTateChuYokoToggle />
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
