import { memo } from "react";
import type { HKSmearFilter } from "@/core/renderer/filters";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const SMEAR_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.smearIntensity",
		paramKey: "intensity",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.5,
		scale: 100,
	},
	{
		labelKey: "filterPanel.smearAngle",
		paramKey: "angle",
		min: 0,
		max: 360,
		step: 1,
		defaultValue: 0,
		unit: "°",
	},
	{
		labelKey: "filterPanel.smearStreakLength",
		paramKey: "streakLength",
		min: 10,
		max: 300,
		step: 1,
		defaultValue: 90,
		unit: "px",
		precision: 0,
	},
	{
		labelKey: "filterPanel.smearStreakWidth",
		paramKey: "streakWidth",
		min: 1,
		max: 50,
		step: 0.5,
		defaultValue: 7,
		unit: "px",
	},
	{
		labelKey: "filterPanel.smearSoftness",
		paramKey: "softness",
		min: 0,
		max: 50,
		step: 1,
		defaultValue: 0.15,
		scale: 100,
	},
	{
		labelKey: "filterPanel.smearSeed",
		paramKey: "randomSeed",
		min: 0,
		max: 1000,
		step: 1,
		defaultValue: 42,
		precision: 0,
	},
];

export const SmearFilterControls = memo(function SmearFilterControls({
	filter,
	onUpdate,
}: {
	filter: HKSmearFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	return (
		<FilterSliders
			sliders={SMEAR_SLIDERS}
			params={filter.paramData.params}
			onUpdate={onUpdate}
		/>
	);
});
