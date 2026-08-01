import { memo } from "react";
import type { BlurFilter } from "@/core/renderer/filters";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const BLUR_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.radius",
		paramKey: "radius",
		min: 0,
		max: 50,
		step: 0.5,
		defaultValue: 0,
		unit: "px",
	},
];

export const BlurFilterControls = memo(function BlurFilterControls({
	filter,
	onUpdate,
}: {
	filter: BlurFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	return (
		<FilterSliders
			sliders={BLUR_SLIDERS}
			params={filter.paramData.params}
			onUpdate={onUpdate}
		/>
	);
});
