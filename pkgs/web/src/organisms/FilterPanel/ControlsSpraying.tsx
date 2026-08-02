import { memo } from "react";
import type { HKSprayingFilter } from "@/core/renderer/filters";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const SPRAYING_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.sprayStrength",
		paramKey: "strength",
		min: 0,
		max: 50,
		step: 1,
		defaultValue: 10,
		unit: "px",
	},
	{
		labelKey: "filterPanel.spraySeed",
		paramKey: "seed",
		min: 0,
		max: 1000,
		step: 1,
		defaultValue: 42,
		precision: 0,
	},
	{
		labelKey: "filterPanel.sprayBlockSize",
		paramKey: "blockSize",
		min: 1,
		max: 32,
		step: 1,
		defaultValue: 4,
		unit: "px",
		precision: 0,
	},
];

export const SprayingFilterControls = memo(function SprayingFilterControls({
	filter,
	onUpdate,
}: {
	filter: HKSprayingFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	return (
		<FilterSliders
			sliders={SPRAYING_SLIDERS}
			params={filter.paramData.params}
			onUpdate={onUpdate}
		/>
	);
});
