import { memo, useMemo } from "react";
import type { SvgMorphologyFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";
import { SelectRow } from "./SelectRow";
import { SvgInputSelect } from "./SvgInputSelect";

const SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.svgRadiusX",
		paramKey: "radiusX",
		min: 0,
		max: 50,
		step: 0.5,
		defaultValue: 1,
		unit: "px",
	},
	{
		labelKey: "filterPanel.svgRadiusY",
		paramKey: "radiusY",
		min: 0,
		max: 50,
		step: 0.5,
		defaultValue: 1,
		unit: "px",
	},
];

export const SvgMorphologyFilterControls = memo(
	function SvgMorphologyFilterControls({
		filter,
		onUpdate,
	}: {
		filter: SvgMorphologyFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		const t = useTranslation();
		const handleUpdate = useEventCallback(onUpdate);
		const params = filter.paramData.params;
		const operatorItems = useMemo(
			() => [
				{ value: "erode", label: t("filterPanel.svgMorphologyErode") },
				{ value: "dilate", label: t("filterPanel.svgMorphologyDilate") },
			],
			[t],
		);
		return (
			<FilterSliders sliders={SLIDERS} params={params} onUpdate={onUpdate}>
				<SvgInputSelect
					labelKey="filterPanel.svgInput"
					value={params.in}
					onChange={(input) => handleUpdate({ in: input })}
				/>
				<SelectRow
					label={t("filterPanel.svgMorphologyOperator")}
					items={operatorItems}
					value={params.operator}
					onValueChange={(operator) => handleUpdate({ operator })}
				/>
			</FilterSliders>
		);
	},
);
