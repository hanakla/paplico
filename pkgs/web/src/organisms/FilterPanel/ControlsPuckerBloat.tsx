import { memo } from "react";
import type { PuckerBloatFilter } from "@/core/renderer/filters";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const PUCKER_BLOAT_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.puckerBloatAmount",
		paramKey: "amount",
		min: -200,
		max: 200,
		step: 1,
		defaultValue: 0,
		scale: 100,
	},
];

export const PuckerBloatFilterControls = memo(
	function PuckerBloatFilterControls({
		filter,
		onUpdate,
	}: {
		filter: PuckerBloatFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		return (
			<FilterSliders
				sliders={PUCKER_BLOAT_SLIDERS}
				params={filter.paramData.params}
				onUpdate={onUpdate}
			/>
		);
	},
);
