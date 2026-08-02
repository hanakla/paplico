import { Copy, Trash2 } from "lucide-react";
import { IconButton } from "@/components/IconButton";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/** Actions for the node selected inside an edited 3D scene. */
export function Reference3DNodeActions() {
	const t = useTranslation();
	const paplico = usePaplico();

	const handleDuplicateReference3DNode = useEventCallback(() => {
		paplico.reference3dDuplicateSelectedNode();
	});

	const handleDeleteReference3DNode = useEventCallback(() => {
		paplico.reference3dDeleteSelectedNode();
	});

	return (
		<>
			<Tooltip
				content={t("contextActions.reference3dDuplicateNode")}
				side="bottom"
			>
				<IconButton
					$size="md"
					$variant="ghost"
					className="text-foreground"
					onClick={handleDuplicateReference3DNode}
				>
					<Copy size={18} />
				</IconButton>
			</Tooltip>
			<Tooltip
				content={t("contextActions.reference3dDeleteNode")}
				side="bottom"
			>
				<IconButton
					$size="md"
					$variant="ghost"
					className="text-danger"
					onClick={handleDeleteReference3DNode}
				>
					<Trash2 size={18} />
				</IconButton>
			</Tooltip>
		</>
	);
}
