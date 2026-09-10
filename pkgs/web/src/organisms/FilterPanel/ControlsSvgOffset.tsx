import { memo } from "react";
import type { SvgOffsetFilter } from "@/core/renderer/filters";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";
import { SvgInputSelect } from "./SvgInputSelect";

const SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.offsetX",
		paramKey: "dx",
		min: -100,
		max: 100,
		step: 0.5,
		defaultValue: 0,
		unit: "px",
	},
	{
		labelKey: "filterPanel.offsetY",
		paramKey: "dy",
		min: -100,
		max: 100,
		step: 0.5,
		defaultValue: 0,
		unit: "px",
	},
];

export const SvgOffsetFilterControls = memo(function SvgOffsetFilterControls({
	filter,
	onUpdate,
}: {
	filter: SvgOffsetFilter;
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
});
