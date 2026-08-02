import { X } from "lucide-react";
import { memo } from "react";
import { useSnapshot } from "valtio";
import { Checkbox } from "@/components/Checkbox";
import { IconButton } from "@/components/IconButton";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { StrokeWidthField } from "./StrokeWidthField";
import { BRUSH_WIDTH_STEP } from "./utils";

export const EraserToolControls = memo(function EraserToolControls() {
	const t = useTranslation();
	const { tools, selection, uiState: store } = usePaplico();
	const toolSnap = useSnapshot(tools.state);
	const snap = useSnapshot(store);

	const hasSelection = snap.selectedElementIds.length >= 1;

	const handleWidthChange = useEventCallback((value: number) => {
		tools.setEraserSize(value);
	});

	const handlePierceAllLayersChange = useEventCallback((checked: boolean) => {
		tools.setEraserPierceAllLayers(checked);
	});

	const handleClearSelection = useEventCallback(() => {
		selection.clear();
	});

	return (
		<div className="flex flex-col gap-2 w-full">
			<StrokeWidthField
				label={t("actionsPanel.eraserSize")}
				value={toolSnap.eraserSize}
				min={1}
				max={100}
				range={100}
				step={BRUSH_WIDTH_STEP}
				onValueChange={handleWidthChange}
			/>
			<span className="flex items-center gap-2 text-muted-foreground text-xs">
				<Checkbox
					id="eraser-pierce-all-layers"
					checked={toolSnap.eraserPierceAllLayers}
					onCheckedChange={(v) => handlePierceAllLayersChange(!!v)}
				/>
				<label htmlFor="eraser-pierce-all-layers" className="cursor-pointer">
					{t("actionsPanel.eraserPierceAllLayers")}
				</label>
			</span>
			<div className="flex flex-col gap-1.5">
				<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
					{t("actionsPanel.clearSelection")}
				</span>
				<Tooltip content={t("actionsPanel.clearSelection")} side="bottom">
					<IconButton
						$size="xs"
						$variant="ghost"
						onClick={handleClearSelection}
						disabled={!hasSelection}
					>
						<X size={14} />
					</IconButton>
				</Tooltip>
			</div>
		</div>
	);
});
