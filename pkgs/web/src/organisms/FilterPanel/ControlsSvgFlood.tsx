import { memo } from "react";
import type { SvgFloodFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { FilterColorSwatch } from "./FilterColorSwatch";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.svgOpacity",
		paramKey: "opacity",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
];

export const SvgFloodFilterControls = memo(function SvgFloodFilterControls({
	filter,
	onUpdate,
}: {
	filter: SvgFloodFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const handleUpdate = useEventCallback(onUpdate);
	const params = filter.paramData.params;
	return (
		<FilterSliders sliders={SLIDERS} params={params} onUpdate={onUpdate}>
			<FilterColorSwatch
				label={t("filterPanel.svgColor")}
				color={params.color}
				onColorChange={(color) => handleUpdate({ color })}
			/>
		</FilterSliders>
	);
});
