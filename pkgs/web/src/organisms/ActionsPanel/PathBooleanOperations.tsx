import { Combine, Copy, Minus, Plus } from "lucide-react";
import { memo } from "react";
import { IconButton } from "@/components/IconButton";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import type { BooleanOperation } from "@/core/schema";
import { useTranslation } from "@/locales";

export const PathBooleanOperations = memo(function PathBooleanOperations() {
	const t = useTranslation();
	const { commands } = usePaplico();
	const handleBooleanOperation = (operation: BooleanOperation) => {
		commands.createCompoundPathFromSelection(operation);
	};

	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
				{t("actionsPanel.booleanOperations")}
			</span>
			<div className="flex gap-1">
				<Tooltip content={t("actionsPanel.union")} side="bottom">
					<IconButton
						$size="xs"
						$variant="ghost"
						onClick={() => handleBooleanOperation("union")}
					>
						<Plus size={14} />
					</IconButton>
				</Tooltip>
				<Tooltip content={t("actionsPanel.subtract")} side="bottom">
					<IconButton
						$size="xs"
						$variant="ghost"
						onClick={() => handleBooleanOperation("subtract")}
					>
						<Minus size={14} />
					</IconButton>
				</Tooltip>
				<Tooltip content={t("actionsPanel.intersect")} side="bottom">
					<IconButton
						$size="xs"
						$variant="ghost"
						onClick={() => handleBooleanOperation("intersect")}
					>
						<Copy size={14} />
					</IconButton>
				</Tooltip>
				<Tooltip content={t("actionsPanel.exclude")} side="bottom">
					<IconButton
						$size="xs"
						$variant="ghost"
						onClick={() => handleBooleanOperation("exclude")}
					>
						<Combine size={14} />
					</IconButton>
				</Tooltip>
			</div>
		</div>
	);
});
