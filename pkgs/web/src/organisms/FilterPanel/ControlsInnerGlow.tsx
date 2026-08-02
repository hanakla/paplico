import { memo } from "react";
import { ColorPickerThin } from "@/components/ColorPicker2";
import { SimpleSelect } from "@/components/SimpleSelect";
import type { HKInnerGlowFilter } from "@/core/renderer/filters";
import type { Color } from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const INNER_GLOW_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.innerGlowWeight",
		paramKey: "weight",
		min: 0,
		max: 50,
		step: 0.5,
		defaultValue: 5,
		unit: "px",
	},
];

export const InnerGlowFilterControls = memo(function InnerGlowFilterControls({
	filter,
	onUpdate,
}: {
	filter: HKInnerGlowFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const handleUpdate = useEventCallback(onUpdate);
	const params = filter.paramData.params;

	const handleGlowTypeChange = useEventCallback((value: string) => {
		handleUpdate({ glowType: value });
	});
	const handleGlowColorChange = useEventCallback((c: Color) => {
		handleUpdate({ glowColor: c });
	});

	return (
		<FilterSliders
			sliders={INNER_GLOW_SLIDERS}
			params={params}
			onUpdate={onUpdate}
		>
			<div>
				<div className="text-muted-foreground text-xs mb-1">
					{t("filterPanel.innerGlowType")}
				</div>
				<SimpleSelect
					$size="sm"
					items={[
						{ label: t("filterPanel.innerGlowTypeInner"), value: "inner" },
						{ label: t("filterPanel.innerGlowTypeOuter"), value: "outer" },
					]}
					value={params.glowType}
					onValueChange={handleGlowTypeChange}
				/>
			</div>
			<div>
				<div className="text-muted-foreground text-xs mb-1">
					{t("filterPanel.innerGlowColor")}
				</div>
				<ColorPickerThin
					color={params.glowColor}
					onColorChange={handleGlowColorChange}
				/>
			</div>
		</FilterSliders>
	);
});
