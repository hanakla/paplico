import { memo } from "react";
import type { HKGlitchFilter } from "@/core/renderer/filters";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const GLITCH_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.glitchIntensity",
		paramKey: "intensity",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.3,
		scale: 100,
	},
	{
		labelKey: "filterPanel.glitchSlices",
		paramKey: "slices",
		min: 1,
		max: 50,
		step: 1,
		defaultValue: 10,
		precision: 0,
	},
	{
		labelKey: "filterPanel.glitchColorShift",
		paramKey: "colorShift",
		min: 0,
		max: 0.1,
		step: 0.001,
		defaultValue: 0.01,
		precision: 3,
	},
	{
		labelKey: "filterPanel.glitchAngle",
		paramKey: "angle",
		min: 0,
		max: 360,
		step: 1,
		defaultValue: 0,
		unit: "°",
	},
	{
		labelKey: "filterPanel.glitchBias",
		paramKey: "bias",
		min: -1,
		max: 1,
		step: 0.01,
		defaultValue: 0,
		precision: 2,
	},
	{
		labelKey: "filterPanel.glitchSeed",
		paramKey: "seed",
		min: 0,
		max: 1000,
		step: 1,
		defaultValue: 42,
		precision: 0,
	},
];

export const GlitchFilterControls = memo(function GlitchFilterControls({
	filter,
	onUpdate,
}: {
	filter: HKGlitchFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	return (
		<FilterSliders
			sliders={GLITCH_SLIDERS}
			params={filter.paramData.params}
			onUpdate={onUpdate}
		/>
	);
});
