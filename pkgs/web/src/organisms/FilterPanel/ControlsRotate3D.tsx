import { memo } from "react";
import type { Rotate3DFilter } from "@/core/renderer/filters";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const ROTATE3D_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.rotateX",
		paramKey: "rotateX",
		min: -180,
		max: 180,
		step: 1,
		defaultValue: 0,
		unit: "°",
	},
	{
		labelKey: "filterPanel.rotateY",
		paramKey: "rotateY",
		min: -180,
		max: 180,
		step: 1,
		defaultValue: 0,
		unit: "°",
	},
	{
		labelKey: "filterPanel.rotateZ",
		paramKey: "rotateZ",
		min: -180,
		max: 180,
		step: 1,
		defaultValue: 0,
		unit: "°",
	},
	{
		labelKey: "filterPanel.perspective",
		paramKey: "perspective",
		min: 1,
		max: 179,
		step: 1,
		defaultValue: 60,
		unit: "°",
	},
];

export const Rotate3DFilterControls = memo(function Rotate3DFilterControls({
	filter,
	onUpdate,
}: {
	filter: Rotate3DFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	return (
		<FilterSliders
			sliders={ROTATE3D_SLIDERS}
			params={filter.paramData.params}
			onUpdate={onUpdate}
		/>
	);
});
