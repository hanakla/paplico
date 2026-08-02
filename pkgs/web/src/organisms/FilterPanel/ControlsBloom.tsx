import { memo, useMemo } from "react";
import { SimpleSelect } from "@/components/SimpleSelect";
import type { HKBloomFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const BLOOM_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.bloomThreshold",
		paramKey: "threshold",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.7,
		scale: 100,
	},
	{
		labelKey: "filterPanel.bloomIntensity",
		paramKey: "intensity",
		min: 0,
		max: 200,
		step: 1,
		defaultValue: 0.5,
		scale: 100,
	},
	{
		labelKey: "filterPanel.bloomRadius",
		paramKey: "radius",
		min: 0,
		max: 50,
		step: 0.5,
		defaultValue: 5,
		unit: "px",
	},
	{
		labelKey: "filterPanel.bloomBlurStrength",
		paramKey: "blurStrength",
		min: 0,
		max: 20,
		step: 0.5,
		defaultValue: 3,
	},
];

export const BloomFilterControls = memo(function BloomFilterControls({
	filter,
	onUpdate,
}: {
	filter: HKBloomFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const handleUpdate = useEventCallback(onUpdate);
	const params = filter.paramData.params;

	const blendModeItems = useMemo(
		() => [
			{ label: t("filterPanel.bloomBlendModeNormal"), value: "normal" },
			{ label: t("filterPanel.bloomBlendModeOverlay"), value: "overlay" },
		],
		[t],
	);

	const handleBlendModeChange = useEventCallback((value: string) => {
		handleUpdate({ blendMode: value });
	});

	return (
		<FilterSliders sliders={BLOOM_SLIDERS} params={params} onUpdate={onUpdate}>
			<div>
				<div className="text-muted-foreground text-xs mb-1">
					{t("filterPanel.blendMode")}
				</div>
				<SimpleSelect
					$size="sm"
					items={blendModeItems}
					value={params.blendMode}
					onValueChange={handleBlendModeChange}
				/>
			</div>
		</FilterSliders>
	);
});
