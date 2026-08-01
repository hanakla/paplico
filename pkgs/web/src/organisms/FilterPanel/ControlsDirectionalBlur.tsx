import { memo, useMemo } from "react";
import { SimpleSelect } from "@/components/SimpleSelect";
import type { HKDirectionalBlurFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const DIRECTIONAL_BLUR_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.dirBlurStrength",
		paramKey: "strength",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 10,
		unit: "px",
		precision: 0,
	},
	{
		labelKey: "filterPanel.dirBlurAngle",
		paramKey: "angle",
		min: 0,
		max: 360,
		step: 1,
		defaultValue: 0,
		unit: "°",
		precision: 0,
	},
	{
		labelKey: "filterPanel.opacity",
		paramKey: "opacity",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
	{
		labelKey: "filterPanel.dirBlurOriginalEmphasis",
		paramKey: "originalEmphasis",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0,
		scale: 100,
	},
	{
		labelKey: "filterPanel.dirBlurFadeOut",
		paramKey: "fadeOut",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0,
		scale: 100,
	},
	{
		labelKey: "filterPanel.dirBlurFadeDirection",
		paramKey: "fadeDirection",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.5,
		scale: 100,
	},
];

export const DirectionalBlurFilterControls = memo(
	function DirectionalBlurFilterControls({
		filter,
		onUpdate,
	}: {
		filter: HKDirectionalBlurFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		const t = useTranslation();
		const handleUpdate = useEventCallback(onUpdate);
		const params = filter.paramData.params;

		const blurModeItems = useMemo(
			() => [
				{ label: t("filterPanel.dirBlurModeBoth"), value: "both" },
				{ label: t("filterPanel.dirBlurModeBehind"), value: "behind" },
				{ label: t("filterPanel.dirBlurModeFront"), value: "front" },
			],
			[t],
		);

		const handleBlurModeChange = useEventCallback((value: string) => {
			handleUpdate({ blurMode: value });
		});

		return (
			<FilterSliders
				sliders={DIRECTIONAL_BLUR_SLIDERS}
				params={params}
				onUpdate={onUpdate}
			>
				<div>
					<div className="text-muted-foreground text-xs mb-1">
						{t("filterPanel.dirBlurMode")}
					</div>
					<SimpleSelect
						$size="sm"
						items={blurModeItems}
						value={params.blurMode}
						onValueChange={handleBlurModeChange}
					/>
				</div>
			</FilterSliders>
		);
	},
);
