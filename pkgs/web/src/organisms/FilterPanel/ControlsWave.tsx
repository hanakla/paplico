import { memo } from "react";
import { Checkbox } from "@/components/Checkbox";
import type { HKWaveFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const WAVE_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.waveAmplitude",
		paramKey: "amplitude",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 10,
		unit: "px",
	},
	{
		labelKey: "filterPanel.waveFrequency",
		paramKey: "frequency",
		min: 0.1,
		max: 20,
		step: 0.1,
		defaultValue: 5,
	},
	{
		labelKey: "filterPanel.waveAngle",
		paramKey: "angleValue",
		min: 0,
		max: 360,
		step: 1,
		defaultValue: 0,
		unit: "°",
	},
	{
		labelKey: "filterPanel.waveTime",
		paramKey: "time",
		min: 0,
		max: 100,
		step: 0.1,
		defaultValue: 0,
	},
];

export const WaveFilterControls = memo(function WaveFilterControls({
	filter,
	onUpdate,
}: {
	filter: HKWaveFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const handleUpdate = useEventCallback(onUpdate);
	const params = filter.paramData.params;

	const handleCrossWaveChange = useEventCallback((checked: boolean) => {
		handleUpdate({ crossWave: checked });
	});

	return (
		<FilterSliders sliders={WAVE_SLIDERS} params={params} onUpdate={onUpdate}>
			{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
			<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
				<Checkbox
					checked={params.crossWave}
					onCheckedChange={handleCrossWaveChange}
				/>
				{t("filterPanel.waveCrossWave")}
			</label>
		</FilterSliders>
	);
});
