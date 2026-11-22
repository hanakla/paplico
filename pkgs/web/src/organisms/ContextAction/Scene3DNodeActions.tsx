import { Copy, Trash2 } from "lucide-react";
import { IconButton } from "@/components/IconButton";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/** Actions for the node selected inside an edited 3D scene. */
export function Scene3DNodeActions() {
	const t = useTranslation();
	const paplico = usePaplico();

	const handleDuplicateScene3DNode = useEventCallback(() => {
		paplico.scene3dDuplicateSelectedNode();
	});

	const handleDeleteScene3DNode = useEventCallback(() => {
		paplico.scene3dDeleteSelectedNode();
	});

	return (
		<>
			<Tooltip content={t("contextActions.scene3dDuplicateNode")} side="bottom">
				<IconButton
					$size="md"
					$variant="ghost"
					className="text-foreground"
					onClick={handleDuplicateScene3DNode}
				>
					<Copy size={18} />
				</IconButton>
			</Tooltip>
			<Tooltip content={t("contextActions.scene3dDeleteNode")} side="bottom">
				<IconButton
					$size="md"
					$variant="ghost"
					className="text-danger"
					onClick={handleDeleteScene3DNode}
				>
					<Trash2 size={18} />
				</IconButton>
			</Tooltip>
		</>
	);
}
