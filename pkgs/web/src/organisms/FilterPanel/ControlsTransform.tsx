import { memo, useMemo } from "react";
import { Checkbox } from "@/components/Checkbox";
import type { TransformFilter, TransformOrigin } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";
import { SelectRow } from "./SelectRow";

const TRANSFORM_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.transformScaleX",
		paramKey: "scaleX",
		min: 0,
		max: 400,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
	{
		labelKey: "filterPanel.transformScaleY",
		paramKey: "scaleY",
		min: 0,
		max: 400,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
	{
		labelKey: "filterPanel.transformMoveX",
		paramKey: "moveX",
		min: -1000,
		max: 1000,
		step: 1,
		defaultValue: 0,
	},
	{
		labelKey: "filterPanel.transformMoveY",
		paramKey: "moveY",
		min: -1000,
		max: 1000,
		step: 1,
		defaultValue: 0,
	},
	{
		labelKey: "filterPanel.transformAngle",
		paramKey: "angle",
		min: -360,
		max: 360,
		step: 1,
		defaultValue: 0,
		unit: "°",
	},
	{
		labelKey: "filterPanel.transformCopies",
		paramKey: "copies",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0,
		precision: 0,
	},
];

const SEED_SLIDER: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.transformSeed",
		paramKey: "seed",
		min: 0,
		max: 1000,
		step: 1,
		defaultValue: 42,
		precision: 0,
	},
];

export const TransformFilterControls = memo(function TransformFilterControls({
	filter,
	onUpdate,
}: {
	filter: TransformFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const handleUpdate = useEventCallback(onUpdate);
	const params = filter.paramData.params;

	const originItems = useMemo(
		() =>
			(
				[
					["top-left", "filterPanel.transformOriginTopLeft"],
					["top", "filterPanel.transformOriginTop"],
					["top-right", "filterPanel.transformOriginTopRight"],
					["left", "filterPanel.transformOriginLeft"],
					["center", "filterPanel.transformOriginCenter"],
					["right", "filterPanel.transformOriginRight"],
					["bottom-left", "filterPanel.transformOriginBottomLeft"],
					["bottom", "filterPanel.transformOriginBottom"],
					["bottom-right", "filterPanel.transformOriginBottomRight"],
				] as const
			).map(([value, key]) => ({ value, label: t(key) })),
		[t],
	);

	return (
		<FilterSliders
			sliders={TRANSFORM_SLIDERS}
			params={params}
			onUpdate={handleUpdate}
		>
			<SelectRow
				label={t("filterPanel.transformOrigin")}
				items={originItems}
				value={params.origin}
				onValueChange={(value) =>
					handleUpdate({ origin: value as TransformOrigin })
				}
			/>
			<CheckboxRow
				label={t("filterPanel.transformReflectX")}
				checked={params.reflectX}
				onChange={(checked) => handleUpdate({ reflectX: checked })}
			/>
			<CheckboxRow
				label={t("filterPanel.transformReflectY")}
				checked={params.reflectY}
				onChange={(checked) => handleUpdate({ reflectY: checked })}
			/>
			<CheckboxRow
				label={t("filterPanel.transformPatterns")}
				checked={params.transformPatterns}
				onChange={(checked) => handleUpdate({ transformPatterns: checked })}
			/>
			<CheckboxRow
				label={t("filterPanel.transformScaleStrokes")}
				checked={params.scaleStrokes}
				onChange={(checked) => handleUpdate({ scaleStrokes: checked })}
			/>
			<CheckboxRow
				label={t("filterPanel.transformRandom")}
				checked={params.random}
				onChange={(checked) => handleUpdate({ random: checked })}
			/>
			{params.random && (
				<FilterSliders
					sliders={SEED_SLIDER}
					params={params}
					onUpdate={handleUpdate}
				/>
			)}
		</FilterSliders>
	);
});

function CheckboxRow({
	label,
	checked,
	onChange,
}: {
	label: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component
		<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
			<Checkbox checked={checked} onCheckedChange={onChange} />
			{label}
		</label>
	);
}
