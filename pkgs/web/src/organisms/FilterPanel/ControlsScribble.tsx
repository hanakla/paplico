import type { ScribbleFilter } from "@paplico/core/filters";
import { memo } from "react";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const SCRIBBLE_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.scribbleAngle",
		paramKey: "angle",
		min: -180,
		max: 180,
		step: 1,
		defaultValue: 30,
	},
	{
		labelKey: "filterPanel.scribbleOverlap",
		paramKey: "overlap",
		min: -50,
		max: 50,
		step: 0.5,
		defaultValue: 0,
	},
	{
		labelKey: "filterPanel.scribbleOverlapVariation",
		paramKey: "overlapVariation",
		min: 0,
		max: 50,
		step: 0.5,
		defaultValue: 0.5,
	},
	{
		labelKey: "filterPanel.scribbleStrokeWidth",
		paramKey: "strokeWidth",
		min: 0.1,
		max: 50,
		step: 0.1,
		defaultValue: 3,
	},
	{
		labelKey: "filterPanel.scribbleCurviness",
		paramKey: "curviness",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 5,
	},
	{
		labelKey: "filterPanel.scribbleCurvinessVariation",
		paramKey: "curvinessVariation",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0,
	},
	{
		labelKey: "filterPanel.scribbleSpacing",
		paramKey: "spacing",
		min: 0.1,
		max: 50,
		step: 0.1,
		defaultValue: 5,
	},
	{
		labelKey: "filterPanel.scribbleSpacingVariation",
		paramKey: "spacingVariation",
		min: 0,
		max: 50,
		step: 0.1,
		defaultValue: 0.5,
	},
	{
		labelKey: "filterPanel.scribbleSeed",
		paramKey: "seed",
		min: 0,
		max: 999,
		step: 1,
		precision: 0,
		defaultValue: 0,
	},
];

export const ScribbleFilterControls = memo(function ScribbleFilterControls({
	filter,
	onUpdate,
}: {
	filter: ScribbleFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	return (
		<FilterSliders
			sliders={SCRIBBLE_SLIDERS}
			params={filter.paramData.params}
			onUpdate={onUpdate}
		/>
	);
});
