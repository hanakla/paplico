import { memo } from "react";
import type { FrostGlassFilter } from "@/core/renderer/filters";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const FROST_GLASS_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.radius",
		paramKey: "radius",
		min: 0,
		max: 50,
		step: 0.5,
		defaultValue: 0,
		unit: "px",
	},
	{
		labelKey: "filterPanel.saturation",
		paramKey: "saturation",
		min: 0,
		max: 200,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
	{
		labelKey: "filterPanel.tintOpacity",
		paramKey: "tintOpacity",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0,
		scale: 100,
	},
	{
		labelKey: "filterPanel.frostScatter",
		paramKey: "scatter",
		min: 0,
		max: 50,
		step: 0.5,
		defaultValue: 0,
		unit: "px",
	},
	{
		labelKey: "filterPanel.frostScatterGrain",
		paramKey: "scatterGrain",
		min: 1,
		max: 32,
		step: 1,
		defaultValue: 1,
		unit: "px",
		precision: 0,
	},
];

export const FrostGlassFilterControls = memo(function FrostGlassFilterControls({
	filter,
	onUpdate,
}: {
	filter: FrostGlassFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	return (
		<FilterSliders
			sliders={FROST_GLASS_SLIDERS}
			params={filter.paramData.params}
			onUpdate={onUpdate}
		/>
	);
});
