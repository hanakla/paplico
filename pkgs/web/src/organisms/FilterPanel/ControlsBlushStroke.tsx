import { memo } from "react";
import type { HKBlushStrokeFilter } from "@/core/renderer/filters";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const BLUSH_STROKE_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.blushStrokeAngle",
		paramKey: "angle",
		min: 0,
		max: 360,
		step: 1,
		defaultValue: 45,
		unit: "°",
	},
	{
		labelKey: "filterPanel.blushStrokeBrushSize",
		paramKey: "brushSize",
		min: 1,
		max: 50,
		step: 1,
		defaultValue: 8,
		unit: "px",
	},
	{
		labelKey: "filterPanel.blushStrokeLength",
		paramKey: "strokeLength",
		min: 1,
		max: 50,
		step: 1,
		defaultValue: 10,
		unit: "px",
	},
	{
		labelKey: "filterPanel.blushStrokeDensity",
		paramKey: "strokeDensity",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.5,
		scale: 100,
	},
	{
		labelKey: "filterPanel.blushStrokeRandomStrength",
		paramKey: "randomStrength",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.3,
		scale: 100,
	},
	{
		labelKey: "filterPanel.blushStrokeSeed",
		paramKey: "randomSeed",
		min: 0,
		max: 1000,
		step: 1,
		defaultValue: 42,
		precision: 0,
	},
	{
		labelKey: "filterPanel.blushStrokeBlend",
		paramKey: "blendWithOriginal",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.5,
		scale: 100,
	},
];

export const BlushStrokeFilterControls = memo(
	function BlushStrokeFilterControls({
		filter,
		onUpdate,
	}: {
		filter: HKBlushStrokeFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		return (
			<FilterSliders
				sliders={BLUSH_STROKE_SLIDERS}
				params={filter.paramData.params}
				onUpdate={onUpdate}
			/>
		);
	},
);
