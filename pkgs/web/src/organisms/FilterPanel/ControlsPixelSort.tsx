import { memo } from "react";
import { Checkbox } from "@/components/Checkbox";
import { SimpleSelect } from "@/components/SimpleSelect";
import { Slider } from "@/components/Slider";
import type { HKPixelSortFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const PIXEL_SORT_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.pixelSortStrength",
		paramKey: "strength",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
	{
		labelKey: "filterPanel.pixelSortAngle",
		paramKey: "angle",
		min: -180,
		max: 180,
		step: 1,
		defaultValue: 0,
		precision: 0,
		unit: "°",
	},
];

export const PixelSortFilterControls = memo(function PixelSortFilterControls({
	filter,
	onUpdate,
}: {
	filter: HKPixelSortFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const params = filter.paramData.params;

	const minPct = Math.round((params.thresholdMin ?? 0) * 100);
	const maxPct = Math.round((params.thresholdMax ?? 1) * 100);

	const handleBrightnessChange = useEventCallback((value: number[]) => {
		onUpdate({ thresholdMin: value[0] / 100, thresholdMax: value[1] / 100 });
	});
	const handleOrderChange = useEventCallback((value: string) => {
		onUpdate({ ascending: value === "dark-to-bright" });
	});
	const handleApplyToBackdropChange = useEventCallback((checked: boolean) => {
		onUpdate({ applyToBackdrop: checked });
	});

	return (
		<FilterSliders
			sliders={PIXEL_SORT_SLIDERS}
			params={params}
			onUpdate={onUpdate}
		>
			<div className="text-muted-foreground text-xs">
				<div className="flex items-center justify-between">
					<span>{t("filterPanel.pixelSortBrightness")}</span>
					<span>
						{minPct}% – {maxPct}%
					</span>
				</div>
				<Slider
					min={0}
					max={100}
					step={1}
					value={[minPct, maxPct]}
					onValueChange={handleBrightnessChange}
				/>
			</div>
			<div>
				<div className="text-muted-foreground text-xs mb-1">
					{t("filterPanel.pixelSortOrder")}
				</div>
				<SimpleSelect
					$size="sm"
					items={[
						{
							label: t("filterPanel.pixelSortOrderDarkToBright"),
							value: "dark-to-bright",
						},
						{
							label: t("filterPanel.pixelSortOrderBrightToDark"),
							value: "bright-to-dark",
						},
					]}
					value={
						(params.ascending ?? true) ? "dark-to-bright" : "bright-to-dark"
					}
					onValueChange={handleOrderChange}
				/>
			</div>
			{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
			<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
				<Checkbox
					checked={params.applyToBackdrop ?? false}
					onCheckedChange={handleApplyToBackdropChange}
				/>
				{t("filterPanel.pixelSortApplyToBackdrop")}
			</label>
		</FilterSliders>
	);
});
