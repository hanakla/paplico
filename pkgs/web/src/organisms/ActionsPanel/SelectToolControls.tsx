import { BoxSelect, LassoSelect } from "lucide-react";
import { memo } from "react";
import { useSnapshot } from "valtio";
import { ToggleGroup } from "@/components/ToggleGroup";
import { usePaplico } from "@/contexts/PaplicoContext";
import { appConfig } from "@/hooks/useAppConfig";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

export const SelectToolControls = memo(function SelectToolControls() {
	const t = useTranslation();
	const { tools } = usePaplico();
	const toolSnap = useSnapshot(tools.state);

	const selectionMode = toolSnap.selectSelectionMode;

	const handleSelectionModeChange = useEventCallback((value: string[]) => {
		if (value.length > 0) {
			const mode = value[0] as "lasso" | "rectangle";
			tools.setSelectSelectionMode(mode);
			appConfig.selectSelectionMode = mode;
		}
	});

	return (
		<div className="flex flex-col gap-2 w-full">
			<div className="flex flex-col gap-1">
				<span className="text-[10px] text-muted-foreground">
					{t("actionsPanel.pathEditSelectionMode")}
				</span>
				<ToggleGroup.Root
					value={[selectionMode]}
					onValueChange={handleSelectionModeChange}
				>
					<ToggleGroup.Item
						value="rectangle"
						className="h-5 w-auto px-1.5 text-[10px] gap-0.5"
					>
						<BoxSelect size={12} />
						{t("actionsPanel.pathEditRectangle")}
					</ToggleGroup.Item>
					<ToggleGroup.Item
						value="lasso"
						className="h-5 w-auto px-1.5 text-[10px] gap-0.5"
					>
						<LassoSelect size={12} />
						{t("actionsPanel.pathEditLasso")}
					</ToggleGroup.Item>
				</ToggleGroup.Root>
			</div>
		</div>
	);
});
