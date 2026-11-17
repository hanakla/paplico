import { MoveHorizontal } from "lucide-react";
import { useSnapshot } from "valtio";
import { IconButton } from "@/components/IconButton";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { uiState } from "@/stores/uiStore";
import { useEventCallback } from "@/utils/hooks";

export function TextTateChuYokoToggle() {
	const t = useTranslation();
	const paplico = usePaplico();
	const style =
		useSnapshot(uiState).textEditState.selectionStyle?.style.tateChuYoko;
	const active = !!style && !style.mixed && !!style.value;
	const handleToggle = useEventCallback(() => {
		paplico.textToolController
			?.getTextTool()
			?.applyStyleToSelection({ tateChuYoko: !active });
	});

	return (
		<Tooltip content={t("actionsPanel.tateChuYoko")} side="bottom">
			<IconButton
				$size="xs"
				$variant={active ? "default" : "ghost"}
				aria-label={t("actionsPanel.tateChuYoko")}
				aria-pressed={active}
				onClick={handleToggle}
			>
				<MoveHorizontal size={14} />
			</IconButton>
		</Tooltip>
	);
}
