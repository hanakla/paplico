import { memo } from "react";
import type { SvgGaussianBlurFilter } from "@/core/renderer/filters";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";
import { SvgInputSelect } from "./SvgInputSelect";

const SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.svgStdDeviationX",
		paramKey: "stdDeviationX",
		min: 0,
		max: 50,
		step: 0.1,
		defaultValue: 3,
		unit: "px",
	},
	{
		labelKey: "filterPanel.svgStdDeviationY",
		paramKey: "stdDeviationY",
		min: 0,
		max: 50,
		step: 0.1,
		defaultValue: 3,
		unit: "px",
	},
];

export const SvgGaussianBlurFilterControls = memo(
	function SvgGaussianBlurFilterControls({
		filter,
		onUpdate,
	}: {
		filter: SvgGaussianBlurFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		const handleUpdate = useEventCallback(onUpdate);
		const params = filter.paramData.params;
		return (
			<FilterSliders sliders={SLIDERS} params={params} onUpdate={onUpdate}>
				<SvgInputSelect
					labelKey="filterPanel.svgInput"
					value={params.in}
					onChange={(input) => handleUpdate({ in: input })}
				/>
			</FilterSliders>
		);
	},
);
