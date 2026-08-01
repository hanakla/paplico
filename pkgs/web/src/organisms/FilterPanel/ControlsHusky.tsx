import { memo } from "react";
import type { HKHuskyFilter } from "@/core/renderer/filters";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const HUSKY_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.huskyBlur",
		paramKey: "blurIntensity",
		min: 0,
		max: 50,
		step: 0.5,
		defaultValue: 5,
	},
	{
		labelKey: "filterPanel.huskyBleed",
		paramKey: "bleedIntensity",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.3,
		scale: 100,
	},
	{
		labelKey: "filterPanel.huskyBreathiness",
		paramKey: "breathiness",
		min: 0,
		max: 100,
		step: 1,
		// Documents saved before this param existed render with 0 (no veil).
		defaultValue: 0,
		scale: 100,
	},
	{
		labelKey: "filterPanel.huskyMelt",
		paramKey: "melt",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0,
		scale: 100,
	},
	{
		labelKey: "filterPanel.huskyMaxOffset",
		paramKey: "maxOffset",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 20,
		unit: "px",
	},
	{
		labelKey: "filterPanel.huskySeed",
		paramKey: "randomSeed",
		min: 0,
		max: 1000,
		step: 1,
		defaultValue: 42,
		precision: 0,
	},
];

export const HuskyFilterControls = memo(function HuskyFilterControls({
	filter,
	onUpdate,
}: {
	filter: HKHuskyFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const params = filter.paramData.params;

	return (
		<FilterSliders
			sliders={HUSKY_SLIDERS}
			params={params}
			onUpdate={onUpdate}
		/>
	);
});
