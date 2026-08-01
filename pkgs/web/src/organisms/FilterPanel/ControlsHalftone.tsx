import { memo } from "react";
import { Checkbox } from "@/components/Checkbox";
import { SimpleSelect } from "@/components/SimpleSelect";
import type { HKHalftoneFilter } from "@/core/renderer/filters";
import type { Color } from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { FilterColorSwatch } from "./FilterColorSwatch";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const HALFTONE_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.halftoneSize",
		paramKey: "size",
		min: 1,
		max: 32,
		step: 0.5,
		defaultValue: 4,
		unit: "px",
	},
	{
		labelKey: "filterPanel.halftoneAngle",
		paramKey: "angle",
		min: 0,
		max: 180,
		step: 1,
		defaultValue: 45,
		unit: "°",
	},
];

export const HalftoneFilterControls = memo(function HalftoneFilterControls({
	filter,
	onUpdate,
}: {
	filter: HKHalftoneFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const handleUpdate = useEventCallback(onUpdate);
	const params = filter.paramData.params;

	const handlePlacementChange = useEventCallback((value: string) => {
		handleUpdate({ placementPattern: value });
	});
	const handleInvertDotSizeChange = useEventCallback((checked: boolean) => {
		handleUpdate({ invertDotSize: checked });
	});
	const handleOpaqueOnlyChange = useEventCallback((checked: boolean) => {
		handleUpdate({ opaqueOnly: checked });
	});
	const handleColorChange = useEventCallback((c: Color) => {
		handleUpdate({ color: c });
	});

	return (
		<FilterSliders
			sliders={HALFTONE_SLIDERS}
			params={params}
			onUpdate={onUpdate}
		>
			<div>
				<div className="text-muted-foreground text-xs mb-1">
					{t("filterPanel.halftonePlacement")}
				</div>
				<SimpleSelect
					$size="sm"
					items={[
						{ label: t("filterPanel.halftonePlacementGrid"), value: "grid" },
						{
							label: t("filterPanel.halftonePlacementStaggered"),
							value: "staggered",
						},
					]}
					value={params.placementPattern}
					onValueChange={handlePlacementChange}
				/>
			</div>
			{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
			<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
				<Checkbox
					checked={params.invertDotSize ?? false}
					onCheckedChange={handleInvertDotSizeChange}
				/>
				{t("filterPanel.halftoneInvertDotSize")}
			</label>
			{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
			<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
				<Checkbox
					checked={params.opaqueOnly ?? false}
					onCheckedChange={handleOpaqueOnlyChange}
				/>
				{t("filterPanel.halftoneOpaqueOnly")}
			</label>
			<FilterColorSwatch
				label={t("filterPanel.halftoneColor")}
				color={params.color}
				onColorChange={handleColorChange}
			/>
		</FilterSliders>
	);
});
