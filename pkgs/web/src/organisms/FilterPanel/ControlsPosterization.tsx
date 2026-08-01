import { memo } from "react";
import type { HKPosterizationFilter } from "@/core/renderer/filters";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const POSTERIZATION_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.posterizeLevels",
		paramKey: "levels",
		min: 2,
		max: 32,
		step: 1,
		defaultValue: 4,
		precision: 0,
	},
	{
		labelKey: "filterPanel.posterizeStrength",
		paramKey: "strength",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
];

export const PosterizationFilterControls = memo(
	function PosterizationFilterControls({
		filter,
		onUpdate,
	}: {
		filter: HKPosterizationFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		return (
			<FilterSliders
				sliders={POSTERIZATION_SLIDERS}
				params={filter.paramData.params}
				onUpdate={onUpdate}
			/>
		);
	},
);
