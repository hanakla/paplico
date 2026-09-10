import { memo } from "react";
import type { SvgDropShadowFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { FilterColorSwatch } from "./FilterColorSwatch";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";
import { SvgInputSelect } from "./SvgInputSelect";

const SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.offsetX",
		paramKey: "dx",
		min: -100,
		max: 100,
		step: 0.5,
		defaultValue: 4,
		unit: "px",
	},
	{
		labelKey: "filterPanel.offsetY",
		paramKey: "dy",
		min: -100,
		max: 100,
		step: 0.5,
		defaultValue: -4,
		unit: "px",
	},
	{
		labelKey: "filterPanel.svgStdDeviation",
		paramKey: "stdDeviation",
		min: 0,
		max: 50,
		step: 0.1,
		defaultValue: 3,
		unit: "px",
	},
	{
		labelKey: "filterPanel.svgOpacity",
		paramKey: "opacity",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.5,
		scale: 100,
	},
];

export const SvgDropShadowFilterControls = memo(
	function SvgDropShadowFilterControls({
		filter,
		onUpdate,
	}: {
		filter: SvgDropShadowFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		const t = useTranslation();
		const handleUpdate = useEventCallback(onUpdate);
		const params = filter.paramData.params;
		return (
			<FilterSliders sliders={SLIDERS} params={params} onUpdate={onUpdate}>
				<SvgInputSelect
					labelKey="filterPanel.svgInput"
					value={params.in}
					onChange={(input) => handleUpdate({ in: input })}
				/>
				<FilterColorSwatch
					label={t("filterPanel.svgColor")}
					color={params.color}
					onColorChange={(color) => handleUpdate({ color })}
				/>
			</FilterSliders>
		);
	},
);
