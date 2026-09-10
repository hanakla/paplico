import { memo } from "react";
import type { SvgDisplacementMapFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";
import { SelectRow } from "./SelectRow";
import { SvgInputSelect } from "./SvgInputSelect";

const CHANNEL_ITEMS = ["R", "G", "B", "A"].map((c) => ({ value: c, label: c }));

const SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.svgDisplacementScale",
		paramKey: "scale",
		min: -200,
		max: 200,
		step: 1,
		defaultValue: 20,
		unit: "px",
		precision: 0,
	},
];

export const SvgDisplacementMapFilterControls = memo(
	function SvgDisplacementMapFilterControls({
		filter,
		onUpdate,
	}: {
		filter: SvgDisplacementMapFilter;
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
					excludePrevious={params.in2 === "previous"}
					onChange={(input) => handleUpdate({ in: input })}
				/>
				<SvgInputSelect
					labelKey="filterPanel.svgInput2"
					value={params.in2}
					excludePrevious={params.in === "previous"}
					onChange={(input) => handleUpdate({ in2: input })}
				/>
				<SelectRow
					label={t("filterPanel.svgXChannel")}
					items={CHANNEL_ITEMS}
					value={params.xChannelSelector}
					onValueChange={(xChannelSelector) =>
						handleUpdate({ xChannelSelector })
					}
				/>
				<SelectRow
					label={t("filterPanel.svgYChannel")}
					items={CHANNEL_ITEMS}
					value={params.yChannelSelector}
					onValueChange={(yChannelSelector) =>
						handleUpdate({ yChannelSelector })
					}
				/>
			</FilterSliders>
		);
	},
);
