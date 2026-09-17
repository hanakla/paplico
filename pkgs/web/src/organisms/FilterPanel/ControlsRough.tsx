import { memo } from "react";
import type { RoughFilter } from "@/core/renderer/filters";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const ROUGH_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.roughSize",
		paramKey: "size",
		min: 0,
		max: 50,
		step: 0.5,
		defaultValue: 5,
	},
	{
		labelKey: "filterPanel.roughDetail",
		paramKey: "detail",
		min: 1,
		max: 200,
		step: 1,
		precision: 0,
		defaultValue: 10,
	},
	{
		labelKey: "filterPanel.roundCorners",
		paramKey: "roundCorners",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0,
		scale: 100,
	},
	{
		labelKey: "filterPanel.roughSeed",
		paramKey: "seed",
		min: 0,
		max: 999,
		step: 1,
		precision: 0,
		defaultValue: 0,
	},
];

export const RoughFilterControls = memo(function RoughFilterControls({
	filter,
	onUpdate,
}: {
	filter: RoughFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	return (
		<FilterSliders
			sliders={ROUGH_SLIDERS}
			params={filter.paramData.params}
			onUpdate={onUpdate}
		/>
	);
});
