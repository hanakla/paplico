import { memo } from "react";
import { Checkbox } from "@/components/Checkbox";
import { ColorPickerThin } from "@/components/ColorPicker2";
import { SimpleSelect } from "@/components/SimpleSelect";
import type { HKComicToneFilter } from "@/core/renderer/filters";
import type { Color } from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const COMIC_TONE_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.comicToneSize",
		paramKey: "size",
		min: 1,
		max: 32,
		step: 0.5,
		defaultValue: 4,
		unit: "px",
	},
	{
		labelKey: "filterPanel.comicToneSpacing",
		paramKey: "spacing",
		min: 0.1,
		max: 5,
		step: 0.1,
		defaultValue: 1,
	},
	{
		labelKey: "filterPanel.comicToneAngle",
		paramKey: "angle",
		min: 0,
		max: 180,
		step: 1,
		defaultValue: 45,
		unit: "°",
	},
	{
		labelKey: "filterPanel.comicToneThreshold",
		paramKey: "threshold",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.5,
		scale: 100,
	},
	{
		labelKey: "filterPanel.comicToneLuminanceStrength",
		paramKey: "luminanceStrength",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
];

export const ComicToneFilterControls = memo(function ComicToneFilterControls({
	filter,
	onUpdate,
}: {
	filter: HKComicToneFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const handleUpdate = useEventCallback(onUpdate);
	const params = filter.paramData.params;

	const handleToneTypeChange = useEventCallback((value: string) => {
		handleUpdate({ toneType: value });
	});
	const handleColorModeChange = useEventCallback((value: string) => {
		handleUpdate({ colorMode: value });
	});
	const handleReversePatternChange = useEventCallback((checked: boolean) => {
		handleUpdate({ reversePattern: checked });
	});
	const handleShowOriginalChange = useEventCallback((checked: boolean) => {
		handleUpdate({ showOriginalUnderDots: checked });
	});
	const handleUseLuminanceChange = useEventCallback((checked: boolean) => {
		handleUpdate({ useLuminance: checked });
	});
	const handleInvertDotSizeChange = useEventCallback((checked: boolean) => {
		handleUpdate({ invertDotSize: checked });
	});
	const handleToneColorChange = useEventCallback((c: Color) => {
		handleUpdate({ toneColor: c });
	});

	return (
		<FilterSliders
			sliders={COMIC_TONE_SLIDERS}
			params={params}
			onUpdate={onUpdate}
		>
			<div>
				<div className="text-muted-foreground text-xs mb-1">
					{t("filterPanel.comicToneType")}
				</div>
				<SimpleSelect
					$size="sm"
					items={[
						{ label: t("filterPanel.comicToneTypeDot"), value: "dot" },
						{ label: t("filterPanel.comicToneTypeLine"), value: "line" },
						{
							label: t("filterPanel.comicToneTypeCrosshatch"),
							value: "crosshatch",
						},
					]}
					value={params.toneType}
					onValueChange={handleToneTypeChange}
				/>
			</div>
			<div>
				<div className="text-muted-foreground text-xs mb-1">
					{t("filterPanel.comicToneColorMode")}
				</div>
				<SimpleSelect
					$size="sm"
					items={[
						{
							label: t("filterPanel.comicToneColorModeOriginal"),
							value: "original",
						},
						{
							label: t("filterPanel.comicToneColorModeMonochrome"),
							value: "monochrome",
						},
					]}
					value={params.colorMode}
					onValueChange={handleColorModeChange}
				/>
			</div>
			{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
			<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
				<Checkbox
					checked={params.reversePattern}
					onCheckedChange={handleReversePatternChange}
				/>
				{t("filterPanel.comicToneReversePattern")}
			</label>
			{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
			<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
				<Checkbox
					checked={params.showOriginalUnderDots}
					onCheckedChange={handleShowOriginalChange}
				/>
				{t("filterPanel.comicToneShowOriginalUnderDots")}
			</label>
			{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
			<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
				<Checkbox
					checked={params.useLuminance}
					onCheckedChange={handleUseLuminanceChange}
				/>
				{t("filterPanel.comicToneUseLuminance")}
			</label>
			{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
			<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
				<Checkbox
					checked={params.invertDotSize}
					onCheckedChange={handleInvertDotSizeChange}
				/>
				{t("filterPanel.comicToneInvertDotSize")}
			</label>
			<div>
				<div className="text-muted-foreground text-xs mb-1">
					{t("filterPanel.comicToneColor")}
				</div>
				<ColorPickerThin
					color={params.toneColor}
					onColorChange={handleToneColorChange}
				/>
			</div>
		</FilterSliders>
	);
});
