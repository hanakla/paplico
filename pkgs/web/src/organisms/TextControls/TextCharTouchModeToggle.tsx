import { Check, Pointer } from "lucide-react";
import { useSnapshot } from "valtio";
import { IconButton } from "@/components/IconButton";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/** Toggles per-character move, rotate, and scale mode. */
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
