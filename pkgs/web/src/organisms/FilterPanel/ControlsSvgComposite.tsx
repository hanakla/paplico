import { memo, useMemo } from "react";
import type { SvgCompositeFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";
import { SelectRow } from "./SelectRow";
import { SvgInputSelect } from "./SvgInputSelect";

const K_SLIDERS: FilterSliderDef[] = (
	[
		["filterPanel.svgK1", "k1"],
		["filterPanel.svgK2", "k2"],
		["filterPanel.svgK3", "k3"],
		["filterPanel.svgK4", "k4"],
	] as const
).map(([labelKey, paramKey]) => ({
	labelKey,
	paramKey,
	min: -2,
	max: 2,
	step: 0.01,
	defaultValue: 0,
	precision: 2,
}));

export const SvgCompositeFilterControls = memo(
	function SvgCompositeFilterControls({
		filter,
		onUpdate,
	}: {
		filter: SvgCompositeFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		const t = useTranslation();
		const handleUpdate = useEventCallback(onUpdate);
		const params = filter.paramData.params;
		const operatorItems = useMemo(
			() => [
				{ value: "over", label: t("filterPanel.svgCompositeOver") },
				{ value: "in", label: t("filterPanel.svgCompositeIn") },
				{ value: "out", label: t("filterPanel.svgCompositeOut") },
				{ value: "atop", label: t("filterPanel.svgCompositeAtop") },
				{ value: "xor", label: t("filterPanel.svgCompositeXor") },
				{
					value: "arithmetic",
					label: t("filterPanel.svgCompositeArithmetic"),
				},
			],
			[t],
		);
		return (
			<div className="space-y-2">
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
					label={t("filterPanel.svgCompositeOperator")}
					items={operatorItems}
					value={params.operator}
					onValueChange={(operator) => handleUpdate({ operator })}
				/>
				{params.operator === "arithmetic" && (
					<FilterSliders
						sliders={K_SLIDERS}
						params={params}
						onUpdate={onUpdate}
					/>
				)}
			</div>
		);
	},
);
