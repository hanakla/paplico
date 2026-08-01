import { memo } from "react";
import { ColorPickerThin } from "@/components/ColorPicker2";
import type { HKOutlineFilter } from "@/core/renderer/filters";
import type { Color } from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const OUTLINE_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.outlineThickness",
		paramKey: "thickness",
		min: 0.5,
		max: 20,
		step: 0.5,
		defaultValue: 2,
		unit: "px",
	},
	{
		labelKey: "filterPanel.outlineOpacity",
		paramKey: "opacity",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
];

export const OutlineFilterControls = memo(function OutlineFilterControls({
	filter,
	onUpdate,
}: {
	filter: HKOutlineFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const handleUpdate = useEventCallback(onUpdate);
	const params = filter.paramData.params;

	const handleColorChange = useEventCallback((c: Color) => {
		handleUpdate({ color: c });
	});

	return (
		<FilterSliders
			sliders={OUTLINE_SLIDERS}
			params={params}
			onUpdate={onUpdate}
		>
			<div>
				<div className="text-muted-foreground text-xs mb-1">
					{t("filterPanel.outlineColor")}
				</div>
				<ColorPickerThin
					color={params.color}
					onColorChange={handleColorChange}
				/>
			</div>
		</FilterSliders>
	);
});
