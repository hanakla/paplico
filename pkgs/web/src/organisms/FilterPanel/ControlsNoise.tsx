import { memo } from "react";
import { SimpleSelect } from "@/components/SimpleSelect";
import type { NoiseFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const NOISE_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.noiseMixRate",
		paramKey: "mixRate",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
	{
		labelKey: "filterPanel.noiseSeed",
		paramKey: "seed",
		min: 0,
		max: 1000,
		step: 1,
		defaultValue: 42,
		precision: 0,
	},
];

export const NoiseFilterControls = memo(function NoiseFilterControls({
	filter,
	onUpdate,
}: {
	filter: NoiseFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const params = filter.paramData.params;

	const handleColorModeChange = useEventCallback((value: string) => {
		onUpdate({ colorMode: value });
	});

	return (
		<FilterSliders sliders={NOISE_SLIDERS} params={params} onUpdate={onUpdate}>
			<div>
				<div className="text-muted-foreground text-xs mb-1">
					{t("filterPanel.noiseColorMode")}
				</div>
				<SimpleSelect
					$size="sm"
					items={[
						{
							label: t("filterPanel.noiseColorModeMonochrome"),
							value: "monochrome",
						},
						{
							label: t("filterPanel.noiseColorModeColor"),
							value: "color",
						},
					]}
					value={params.colorMode}
					onValueChange={handleColorModeChange}
				/>
			</div>
		</FilterSliders>
	);
});
