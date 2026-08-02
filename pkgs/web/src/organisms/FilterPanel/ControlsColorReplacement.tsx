import { memo } from "react";
import { Checkbox } from "@/components/Checkbox";
import type { HKColorReplacementFilter } from "@/core/renderer/filters";
import type { Color } from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { FilterColorSwatch } from "./FilterColorSwatch";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";
import { PreviewMaskCheckbox } from "./PreviewMaskCheckbox";

const MATCH_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.colorReplaceTolerance",
		paramKey: "tolerance",
		min: 1,
		max: 100,
		step: 1,
		defaultValue: 0.45,
		scale: 100,
	},
	{
		labelKey: "filterPanel.hkFeatherEdges",
		paramKey: "featherEdges",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.2,
		scale: 100,
	},
];

const MIX_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.hkMix",
		paramKey: "mix",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
];

export const ColorReplacementFilterControls = memo(
	function ColorReplacementFilterControls({
		filter,
		onUpdate,
	}: {
		filter: HKColorReplacementFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		const t = useTranslation();
		const handleUpdate = useEventCallback(onUpdate);
		const params = filter.paramData.params;

		const handleSourceColorChange = useEventCallback((color: Color) => {
			handleUpdate({ sourceColor: color });
		});
		const handleReplacementColorChange = useEventCallback((color: Color) => {
			handleUpdate({ replacementColor: color });
		});
		const handlePreserveLuminanceChange = useEventCallback(
			(checked: boolean) => {
				handleUpdate({ preserveLuminance: checked });
			},
		);
		const handlePreviewMaskChange = useEventCallback((checked: boolean) => {
			handleUpdate({ previewMask: checked });
		});

		return (
			<div className="space-y-2">
				<FilterColorSwatch
					label={t("filterPanel.colorReplaceSourceColor")}
					color={params.sourceColor}
					onColorChange={handleSourceColorChange}
				/>
				<FilterColorSwatch
					label={t("filterPanel.colorReplaceReplacementColor")}
					color={params.replacementColor}
					onColorChange={handleReplacementColorChange}
				/>
				<FilterSliders
					sliders={MATCH_SLIDERS}
					params={params}
					onUpdate={onUpdate}
				>
					{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
					<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
						<Checkbox
							checked={params.preserveLuminance}
							onCheckedChange={handlePreserveLuminanceChange}
						/>
						{t("filterPanel.colorReplacePreserveLuminance")}
					</label>
					<PreviewMaskCheckbox
						checked={params.previewMask}
						onCheckedChange={handlePreviewMaskChange}
					/>
				</FilterSliders>
				<FilterSliders
					sliders={MIX_SLIDERS}
					params={params}
					onUpdate={onUpdate}
				/>
			</div>
		);
	},
);
