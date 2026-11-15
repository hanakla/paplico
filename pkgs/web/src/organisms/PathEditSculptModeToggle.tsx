import { Hammer } from "lucide-react";
import { useSnapshot } from "valtio";
import { IconButton } from "@/components/IconButton";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/** Turns canvas drags into strokes that add to or carve the selected paths. */
export function PathEditSculptModeToggle() {
	const t = useTranslation();
	const { tools } = usePaplico();
	const sculptMode = useSnapshot(tools.state).pathEditMode === "sculpt";

	const handleToggle = useEventCallback(() => {
		tools.setPathEditMode(sculptMode ? "edit" : "sculpt");
	});

	return (
		<Tooltip content={t("actionsPanel.pathEditSculptMode")} side="bottom">
			<IconButton
				$size="md"
				$variant="ghost"
				$pressed={sculptMode}
				onClick={handleToggle}
			>
				<Hammer size={18} />
			</IconButton>
		</Tooltip>
	);
}
