import { memo } from "react";
import type { HKFluidFilter } from "@/core/renderer/filters";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const FLUID_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.fluidIntensity",
		paramKey: "intensity",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 20,
	},
	{
		labelKey: "filterPanel.fluidSpeed",
		paramKey: "speed",
		min: 0,
		max: 5,
		step: 0.1,
		defaultValue: 1,
	},
	{
		labelKey: "filterPanel.fluidScale",
		paramKey: "scale",
		min: 0.1,
		max: 10,
		step: 0.1,
		defaultValue: 1,
	},
	{
		labelKey: "filterPanel.fluidTurbulence",
		paramKey: "turbulence",
		min: 0,
		max: 5,
		step: 0.1,
		defaultValue: 1,
	},
	{
		labelKey: "filterPanel.fluidColorShift",
		paramKey: "colorShift",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0,
		scale: 100,
	},
	{
		labelKey: "filterPanel.fluidPadding",
		paramKey: "padding",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0,
		unit: "px",
	},
	{
		labelKey: "filterPanel.fluidTimeSeed",
		paramKey: "timeSeed",
		min: 0,
		max: 1000,
		step: 1,
		defaultValue: 0,
		precision: 0,
	},
];

export const FluidFilterControls = memo(function FluidFilterControls({
	filter,
	onUpdate,
}: {
	filter: HKFluidFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	return (
		<FilterSliders
			sliders={FLUID_SLIDERS}
			params={filter.paramData.params}
			onUpdate={onUpdate}
		/>
	);
});
