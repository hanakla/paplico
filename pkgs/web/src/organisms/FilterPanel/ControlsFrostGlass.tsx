import type { FrostGlassFilter } from "@paplico/core/filters";
import { memo } from "react";
import { Accordion } from "@/components/Accordion";
import { useTranslation } from "@/locales";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";
import { Section } from "./Material3DControls";

const FROST_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.radius",
		paramKey: "radius",
		min: 0,
		max: 50,
		step: 0.5,
		defaultValue: 0,
		unit: "px",
	},
	{
		labelKey: "filterPanel.saturation",
		paramKey: "saturation",
		min: 0,
		max: 200,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
	{
		labelKey: "filterPanel.tintOpacity",
		paramKey: "tintOpacity",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0,
		scale: 100,
	},
	{
		labelKey: "filterPanel.frostScatter",
		paramKey: "scatter",
		min: 0,
		max: 50,
		step: 0.5,
		defaultValue: 0,
		unit: "px",
	},
	{
		labelKey: "filterPanel.frostScatterGrain",
		paramKey: "scatterGrain",
		min: 1,
		max: 32,
		step: 1,
		defaultValue: 1,
		unit: "px",
		precision: 0,
	},
];

/** Shown only on the backdrop route, the only place the pane has a backdrop
 *  to sit above. */
const DISTANCE_SLIDER: FilterSliderDef = {
	labelKey: "filterPanel.frostDistance",
	paramKey: "distance",
	min: 0,
	max: 200,
	step: 1,
	defaultValue: 0,
	unit: "px",
};

const RIM_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.frostBevel",
		paramKey: "bevel",
		min: 0,
		max: 100,
		step: 0.5,
		defaultValue: 0,
		unit: "px",
	},
	{
		labelKey: "filterPanel.frostRefraction",
		paramKey: "refraction",
		min: 0,
		max: 100,
		step: 0.5,
		defaultValue: 0,
		unit: "px",
	},
	{
		labelKey: "filterPanel.frostAberration",
		paramKey: "aberration",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0,
		scale: 100,
	},
	{
		labelKey: "filterPanel.frostHighlight",
		paramKey: "highlight",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0,
		scale: 100,
	},
];

export const FrostGlassFilterControls = memo(function FrostGlassFilterControls({
	filter,
	onUpdate,
}: {
	filter: FrostGlassFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const params = filter.paramData.params;

	return (
		<div className="space-y-2">
			<FilterSliders
				sliders={FROST_SLIDERS}
				params={params}
				onUpdate={onUpdate}
			/>
			<Accordion.Root multiple defaultValue={[]}>
				<Section value="glass" label={t("filterPanel.frostGroupGlass")}>
					<FilterSliders
						sliders={
							filter.applyToBackdrop
								? [DISTANCE_SLIDER, ...RIM_SLIDERS]
								: RIM_SLIDERS
						}
						params={params}
						onUpdate={onUpdate}
					/>
				</Section>
			</Accordion.Root>
		</div>
	);
});
