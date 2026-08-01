import { memo } from "react";
import { ColorPickerThin } from "@/components/ColorPicker2";
import { createDefaultColor } from "@/core/document/factory";
import type { DropShadowFilter } from "@/core/renderer/filters";
import type { Color } from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const DROP_SHADOW_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.offsetX",
		paramKey: "offsetX",
		min: -100,
		max: 100,
		step: 0.5,
		defaultValue: 0,
		unit: "px",
	},
	{
		labelKey: "filterPanel.offsetY",
		paramKey: "offsetY",
		min: -100,
		max: 100,
		step: 0.5,
		defaultValue: 0,
		unit: "px",
	},
	{
		labelKey: "filterPanel.radius",
		paramKey: "blurRadius",
		min: 0,
		max: 50,
		step: 0.5,
		defaultValue: 0,
		unit: "px",
	},
	{
		labelKey: "filterPanel.spreadRadius",
		paramKey: "spreadRadius",
		min: -50,
		max: 50,
		step: 0.5,
		defaultValue: 0,
		unit: "px",
	},
	{
		labelKey: "filterPanel.shadowOpacity",
		paramKey: "shadowOpacity",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.5,
		scale: 100,
	},
];

export const DropShadowFilterControls = memo(function DropShadowFilterControls({
	filter,
	onUpdate,
}: {
	filter: DropShadowFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const handleUpdate = useEventCallback(onUpdate);
	const params = filter.paramData.params;

	// Store the picker's color as-is (rgb or hsv) so the HSVA mode sticks;
	// the handler consumes it via colorToRawRGBA, which handles both.
	const handleColorChange = useEventCallback((c: Color) => {
		handleUpdate({ shadowColor: c });
	});

	return (
		<FilterSliders
			sliders={DROP_SHADOW_SLIDERS}
			params={params}
			onUpdate={onUpdate}
		>
			<div>
				<div className="text-muted-foreground text-xs mb-1">
					{t("filterPanel.shadowColor")}
				</div>
				<ColorPickerThin
					color={params.shadowColor ?? createDefaultColor()}
					onColorChange={handleColorChange}
				/>
			</div>
		</FilterSliders>
	);
});
