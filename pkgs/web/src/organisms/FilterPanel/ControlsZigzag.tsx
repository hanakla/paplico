import { memo } from "react";
import type { ZigzagFilter } from "@/core/renderer/filters";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const ZIGZAG_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.frequency",
		paramKey: "frequency",
		min: 1,
		max: 100,
		step: 1,
		precision: 0,
		defaultValue: 10,
	},
	{
		labelKey: "filterPanel.amplitude",
		paramKey: "amplitude",
		min: 0,
		max: 50,
		step: 0.5,
		defaultValue: 5,
		unit: "px",
	},
	{
		labelKey: "filterPanel.phase",
		paramKey: "phase",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0,
		scale: 100,
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
];

export const ZigzagFilterControls = memo(function ZigzagFilterControls({
	filter,
	onUpdate,
}: {
	filter: ZigzagFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	return (
		<FilterSliders
			sliders={ZIGZAG_SLIDERS}
			params={filter.paramData.params}
			onUpdate={onUpdate}
		/>
	);
});
