import { memo } from "react";
import { Checkbox } from "@/components/Checkbox";
import type { HKKirakiraFilter } from "@/core/renderer/filters";
import type { Color } from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { FilterColorSwatch } from "./FilterColorSwatch";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const KIRAKIRA_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.kirakiraRadius",
		paramKey: "radius",
		min: 1,
		max: 200,
		step: 1,
		defaultValue: 50,
		unit: "px",
		precision: 0,
	},
	{
		labelKey: "filterPanel.kirakiraStrength",
		paramKey: "strength",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.5,
		scale: 100,
	},
	{
		labelKey: "filterPanel.kirakiraSparkle",
		paramKey: "sparkle",
		min: 0,
		max: 200,
		step: 1,
		defaultValue: 0.5,
		scale: 100,
	},
	{
		labelKey: "filterPanel.kirakiraBlendOpacity",
		paramKey: "blendOpacity",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
];

export const KirakiraFilterControls = memo(function KirakiraFilterControls({
	filter,
	onUpdate,
}: {
	filter: HKKirakiraFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const handleUpdate = useEventCallback(onUpdate);
	const params = filter.paramData.params;

	const handleSparkleAlphaChange = useEventCallback((checked: boolean) => {
		handleUpdate({ sparkleAlpha: checked });
	});
	const handleMakeOriginalTransparentChange = useEventCallback(
		(checked: boolean) => {
			handleUpdate({ makeOriginalTransparent: checked });
		},
	);
	const handleUseCustomColorChange = useEventCallback((checked: boolean) => {
		handleUpdate({ useCustomColor: checked });
	});
	const handleCustomColorChange = useEventCallback((color: Color) => {
		handleUpdate({ customColor: color });
	});

	return (
		<FilterSliders
			sliders={KIRAKIRA_SLIDERS}
			params={params}
			onUpdate={onUpdate}
		>
			{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
			<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
				<Checkbox
					checked={params.sparkleAlpha}
					onCheckedChange={handleSparkleAlphaChange}
				/>
				{t("filterPanel.kirakiraSparkleAlpha")}
			</label>
			{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
			<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
				<Checkbox
					checked={params.makeOriginalTransparent}
					onCheckedChange={handleMakeOriginalTransparentChange}
				/>
				{t("filterPanel.kirakiraMakeOriginalTransparent")}
			</label>
			{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
			<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
				<Checkbox
					checked={params.useCustomColor}
					onCheckedChange={handleUseCustomColorChange}
				/>
				{t("filterPanel.kirakiraUseCustomColor")}
			</label>
			{params.useCustomColor && (
				<FilterColorSwatch
					label={t("filterPanel.kirakiraCustomColor")}
					color={params.customColor}
					onColorChange={handleCustomColorChange}
				/>
			)}
		</FilterSliders>
	);
});
