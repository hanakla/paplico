import { memo } from "react";
import { SimpleSelect } from "@/components/SimpleSelect";
import type { HKTurbulenceFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const TURBULENCE_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.turbulenceScale",
		paramKey: "scale",
		min: 1,
		max: 500,
		step: 1,
		defaultValue: 100,
	},
	{
		labelKey: "filterPanel.turbulenceOctaves",
		paramKey: "octaves",
		min: 1,
		max: 8,
		step: 1,
		defaultValue: 4,
		precision: 0,
	},
	{
		labelKey: "filterPanel.turbulenceSeed",
		paramKey: "seed",
		min: 0,
		max: 1000,
		step: 1,
		defaultValue: 42,
		precision: 0,
	},
	{
		labelKey: "filterPanel.turbulenceDisplacementX",
		paramKey: "displacementX",
		min: 0,
		max: 200,
		step: 1,
		defaultValue: 30,
		unit: "px",
	},
	{
		labelKey: "filterPanel.turbulenceDisplacementY",
		paramKey: "displacementY",
		min: 0,
		max: 200,
		step: 1,
		defaultValue: 30,
		unit: "px",
	},
	{
		labelKey: "filterPanel.turbulenceOpacity",
		paramKey: "opacity",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
];

export const TurbulenceFilterControls = memo(function TurbulenceFilterControls({
	filter,
	onUpdate,
}: {
	filter: HKTurbulenceFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const handleUpdate = useEventCallback(onUpdate);
	const params = filter.paramData.params;

	const handleDisplacementModeChange = useEventCallback((value: string) => {
		handleUpdate({ displacementMode: value });
	});
	const handleEdgeModeChange = useEventCallback((value: string) => {
		handleUpdate({ edgeMode: value });
	});

	return (
		<FilterSliders
			sliders={TURBULENCE_SLIDERS}
			params={params}
			onUpdate={onUpdate}
		>
			<div>
				<div className="text-muted-foreground text-xs mb-1">
					{t("filterPanel.turbulenceDisplacementMode")}
				</div>
				<SimpleSelect
					$size="sm"
					items={[
						{
							label: t("filterPanel.turbulenceDisplacementModeCartesian"),
							value: "cartesian",
						},
						{
							label: t("filterPanel.turbulenceDisplacementModeRadial"),
							value: "radial",
						},
						{
							label: t("filterPanel.turbulenceDisplacementModeTwist"),
							value: "twist",
						},
					]}
					value={params.displacementMode}
					onValueChange={handleDisplacementModeChange}
				/>
			</div>
			<div>
				<div className="text-muted-foreground text-xs mb-1">
					{t("filterPanel.turbulenceEdgeMode")}
				</div>
				<SimpleSelect
					$size="sm"
					items={[
						{
							label: t("filterPanel.turbulenceEdgeModeClamp"),
							value: "clamp",
						},
						{ label: t("filterPanel.turbulenceEdgeModeWrap"), value: "wrap" },
						{
							label: t("filterPanel.turbulenceEdgeModeMirror"),
							value: "mirror",
						},
					]}
					value={params.edgeMode}
					onValueChange={handleEdgeModeChange}
				/>
			</div>
		</FilterSliders>
	);
});
