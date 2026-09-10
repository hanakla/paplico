import { memo } from "react";
import type {
	SvgColorFunction,
	SvgColorFunctionFilter,
} from "@/core/renderer/filters";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";
import { SvgInputSelect } from "./SvgInputSelect";

/** Slider range per CSS function: degrees for hue-rotate, 0..1 for the clamped ones. */
const AMOUNT_SLIDERS: Record<SvgColorFunction, FilterSliderDef> = {
	saturate: amountSlider(0, 3, 0.01, 1),
	"hue-rotate": {
		labelKey: "filterPanel.svgAmount",
		paramKey: "amount",
		min: 0,
		max: 360,
		step: 1,
		defaultValue: 0,
		unit: "°",
		precision: 0,
	},
	grayscale: amountSlider(0, 1, 0.01, 0),
	sepia: amountSlider(0, 1, 0.01, 0),
	invert: amountSlider(0, 1, 0.01, 0),
	brightness: amountSlider(0, 3, 0.01, 1),
	contrast: amountSlider(0, 3, 0.01, 1),
};

export const SvgColorFunctionFilterControls = memo(
	function SvgColorFunctionFilterControls({
		filter,
		onUpdate,
	}: {
		filter: SvgColorFunctionFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		const handleUpdate = useEventCallback(onUpdate);
		const params = filter.paramData.params;
		const fn = filter.processor.slice("svg:".length) as SvgColorFunction;
		return (
			<FilterSliders
				sliders={[AMOUNT_SLIDERS[fn]]}
				params={params}
				onUpdate={onUpdate}
			>
				<SvgInputSelect
					labelKey="filterPanel.svgInput"
					value={params.in}
					onChange={(input) => handleUpdate({ in: input })}
				/>
			</FilterSliders>
		);
	},
);

function amountSlider(
	min: number,
	max: number,
	step: number,
	defaultValue: number,
): FilterSliderDef {
	return {
		labelKey: "filterPanel.svgAmount",
		paramKey: "amount",
		min,
		max,
		step,
		defaultValue,
		precision: 2,
	};
}
