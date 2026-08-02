import { memo, useMemo } from "react";
import { Checkbox } from "@/components/Checkbox";
import { Separator } from "@/components/Separator";
import { SimpleSelect } from "@/components/SimpleSelect";
import type { HKSelectiveCorrectionFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";
import { HSVConditionControls } from "./HSVConditionControls";
import { PreviewMaskCheckbox } from "./PreviewMaskCheckbox";

const CORRECTION_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.colorCorrHueShift",
		paramKey: "hueShift",
		min: -180,
		max: 180,
		step: 1,
		defaultValue: 0,
		unit: "°",
		precision: 0,
	},
	{
		labelKey: "filterPanel.colorCorrSaturationScale",
		paramKey: "saturationScale",
		min: 0,
		max: 200,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
	{
		labelKey: "filterPanel.colorCorrVibrance",
		paramKey: "vibrance",
		min: -100,
		max: 100,
		step: 1,
		defaultValue: 0,
		scale: 100,
	},
	{
		labelKey: "filterPanel.colorCorrBrightnessScale",
		paramKey: "brightnessScale",
		min: 0,
		max: 200,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
	{
		labelKey: "filterPanel.colorCorrContrast",
		paramKey: "contrast",
		min: -1,
		max: 1,
		step: 0.01,
		defaultValue: 0,
		precision: 2,
	},
	{
		labelKey: "filterPanel.hkMix",
		paramKey: "mix",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
	{
		labelKey: "filterPanel.hkFeatherEdges",
		paramKey: "featherEdges",
		min: 0,
		max: 0.5,
		step: 0.01,
		defaultValue: 0.05,
		precision: 2,
	},
];

export const SelectiveCorrectionFilterControls = memo(
	function SelectiveCorrectionFilterControls({
		filter,
		onUpdate,
	}: {
		filter: HKSelectiveCorrectionFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		const t = useTranslation();
		const handleUpdate = useEventCallback(onUpdate);
		const params = filter.paramData.params;

		const blendModeItems = useMemo(
			() => [
				{ label: t("filterPanel.colorCorrBlendModeNormal"), value: "normal" },
				{
					label: t("filterPanel.colorCorrBlendModeMultiply"),
					value: "multiply",
				},
			],
			[t],
		);

		const handleBlendModeChange = useEventCallback((value: string) => {
			handleUpdate({ blendMode: value });
		});
		const handleUseConditionChange = useEventCallback((checked: boolean) => {
			handleUpdate({ useCondition: checked });
		});
		const handlePreviewMaskChange = useEventCallback((checked: boolean) => {
			handleUpdate({ previewMask: checked });
		});

		return (
			<FilterSliders
				sliders={CORRECTION_SLIDERS}
				params={params}
				onUpdate={onUpdate}
			>
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
				<Separator />
				{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
				<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
					<Checkbox
						checked={params.useCondition}
						onCheckedChange={handleUseConditionChange}
					/>
					{t("filterPanel.colorCorrUseCondition")}
				</label>
				{params.useCondition && (
					<HSVConditionControls params={params} onUpdate={onUpdate} />
				)}
				<PreviewMaskCheckbox
					checked={params.previewMask}
					onCheckedChange={handlePreviewMaskChange}
				/>
			</FilterSliders>
		);
	},
);
