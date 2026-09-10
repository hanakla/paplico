import { memo, useMemo } from "react";
import { Checkbox } from "@/components/Checkbox";
import type { SvgTurbulenceFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";
import { SelectRow } from "./SelectRow";

const SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.svgBaseFrequencyX",
		paramKey: "baseFrequencyX",
		min: 0,
		max: 0.5,
		step: 0.001,
		defaultValue: 0.05,
		precision: 3,
	},
	{
		labelKey: "filterPanel.svgBaseFrequencyY",
		paramKey: "baseFrequencyY",
		min: 0,
		max: 0.5,
		step: 0.001,
		defaultValue: 0.05,
		precision: 3,
	},
	{
		labelKey: "filterPanel.svgNumOctaves",
		paramKey: "numOctaves",
		min: 1,
		max: 8,
		step: 1,
		defaultValue: 2,
		precision: 0,
	},
	{
		labelKey: "filterPanel.svgSeed",
		paramKey: "seed",
		min: 0,
		max: 1000,
		step: 1,
		defaultValue: 0,
		precision: 0,
	},
];

export const SvgTurbulenceFilterControls = memo(
	function SvgTurbulenceFilterControls({
		filter,
		onUpdate,
	}: {
		filter: SvgTurbulenceFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		const t = useTranslation();
		const handleUpdate = useEventCallback(onUpdate);
		const params = filter.paramData.params;
		const typeItems = useMemo(
			() => [
				{ value: "fractalNoise", label: t("filterPanel.svgNoiseFractal") },
				{ value: "turbulence", label: t("filterPanel.svgNoiseTurbulence") },
			],
			[t],
		);
		return (
			<FilterSliders sliders={SLIDERS} params={params} onUpdate={onUpdate}>
				<SelectRow
					label={t("filterPanel.svgNoiseType")}
					items={typeItems}
					value={params.type}
					onValueChange={(type) => handleUpdate({ type })}
				/>
				{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
				<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
					<Checkbox
						checked={params.stitchTiles}
						onCheckedChange={(stitchTiles) => handleUpdate({ stitchTiles })}
					/>
					{t("filterPanel.svgStitchTiles")}
				</label>
			</FilterSliders>
		);
	},
);
