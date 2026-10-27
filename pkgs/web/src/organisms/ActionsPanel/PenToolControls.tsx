import { memo } from "react";
import { useSnapshot } from "valtio";
import { Checkbox } from "@/components/Checkbox";
import { ToggleGroup } from "@/components/ToggleGroup";
import { usePaplico } from "@/contexts/PaplicoContext";
import { appConfig } from "@/hooks/useAppConfig";
import { useBrushEdits } from "@/hooks/useBrushEdits";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { BrushFields } from "./BrushFields";
import { BrushStrokingFields } from "./BrushStrokingFields";
import { StrokeWidthField } from "./StrokeWidthField";

export const PenToolControls = memo(function PenToolControls() {
	const t = useTranslation();
	const { tools } = usePaplico();
	const brushEdits = useBrushEdits();
	const toolSnap = useSnapshot(tools.state);

	const handleStabilizationChange = useEventCallback((value: number) => {
		tools.setStabilization(value);
	});

	const handleSmoothingMethodChange = useEventCallback((value: string[]) => {
		if (value.length > 0) {
			tools.setSmoothingMethod(
				value[0] as "smooth" | "pulled-string" | "inertia",
			);
		}
	});

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
			<StrokeWidthField
				label={t("actionsPanel.stabilization")}
				value={toolSnap.stabilization}
				min={0}
				max={1}
				step={0.01}
				onValueChange={handleStabilizationChange}
			/>
			<div className="flex flex-col gap-1">
				<span className="type-label text-muted-foreground">
					{t("actionsPanel.smoothingMethod")}
				</span>
				<ToggleGroup.Root
					className="w-full"
					value={[toolSnap.smoothingMethod]}
					onValueChange={handleSmoothingMethodChange}
				>
					<ToggleGroup.Item
						value="smooth"
						className="h-5 w-auto flex-1 px-1.5 type-value"
					>
						{t("actionsPanel.smoothingSmooth")}
					</ToggleGroup.Item>
					<ToggleGroup.Item
						value="pulled-string"
						className="h-5 w-auto flex-1 px-1.5 type-value"
					>
						{t("actionsPanel.smoothingPulledString")}
					</ToggleGroup.Item>
					<ToggleGroup.Item
						value="inertia"
						className="h-5 w-auto flex-1 px-1.5 type-value"
					>
						{t("actionsPanel.smoothingInertia")}
					</ToggleGroup.Item>
				</ToggleGroup.Root>
			</div>

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
