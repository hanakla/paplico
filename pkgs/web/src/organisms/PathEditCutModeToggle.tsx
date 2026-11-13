import { Scissors } from "lucide-react";
import type { ComponentProps } from "react";
import { useSnapshot } from "valtio";
import { IconButton } from "@/components/IconButton";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/** Arms the next canvas click to cut the path under it. */
export function PathEditCutModeToggle({
	$size = "xs",
}: {
	$size?: ComponentProps<typeof IconButton>["$size"];
}) {
	const t = useTranslation();
	const { tools } = usePaplico();
	const cutMode = useSnapshot(tools.state).pathEditCutMode;

	const handleToggle = useEventCallback(() => {
		tools.setPathEditCutMode(!cutMode);
	});

	return (
		<Tooltip content={t("actionsPanel.pathEditCutMode")} side="bottom">
			<IconButton
				$size={$size}
				$variant="ghost"
				$pressed={cutMode}
				onClick={handleToggle}
			>
				<Scissors size={CUT_ICON_SIZE[$size]} />
			</IconButton>
		</Tooltip>
	);
}

const CUT_ICON_SIZE = { xs: 14, sm: 16, md: 18, lg: 20 } as const;
