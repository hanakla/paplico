import { memo } from "react";
import { useSnapshot } from "valtio";
import { Checkbox } from "@/components/Checkbox";
import { usePaplico } from "@/contexts/PaplicoContext";
import { appConfig } from "@/hooks/useAppConfig";
import { useBrushEdits } from "@/hooks/useBrushEdits";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { BrushFields } from "./BrushFields";
import { BrushStrokingFields } from "./BrushStrokingFields";
import { StrokeSmoothingFields } from "./StrokeSmoothingFields";
import { StrokeWidthField } from "./StrokeWidthField";

export const PenToolControls = memo(function PenToolControls() {
	const t = useTranslation();
	const { tools } = usePaplico();
	const brushEdits = useBrushEdits();
	const toolSnap = useSnapshot(tools.state);

	const handleOpacityChange = useEventCallback((value: number) => {
		brushEdits.setOpacity(value);
	});

	const handleSelectStrokeToggle = useEventCallback((checked: boolean) => {
		tools.state.selectStrokeAfterDraw = checked;
		appConfig.selectStrokeAfterDraw = checked;
	});

	return (
		<div className="flex flex-col gap-2 w-full">
			<BrushFields />
			<StrokeSmoothingFields />

			<StrokeWidthField
				label={t("actionsPanel.opacity")}
				value={toolSnap.opacity}
				min={0}
				max={1}
				step={0.01}
				onValueChange={handleOpacityChange}
			/>

			<span className="flex items-center gap-2 text-muted-foreground type-label">
				<Checkbox
					id="select-stroke-after-draw"
					checked={toolSnap.selectStrokeAfterDraw}
					onCheckedChange={(v) => handleSelectStrokeToggle(!!v)}
				/>
				<label htmlFor="select-stroke-after-draw" className="cursor-pointer">
					{t("actionsPanel.selectStrokeAfterDraw")}
				</label>
			</span>

			<BrushStrokingFields />
		</div>
	);
});
