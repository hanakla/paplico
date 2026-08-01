import { memo } from "react";
import { Checkbox } from "@/components/Checkbox";
import { SimpleSelect } from "@/components/SimpleSelect";
import type { PixelateFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const PIXELATE_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.pixelateBlockWidth",
		paramKey: "blockWidth",
		min: 1,
		max: 128,
		step: 1,
		defaultValue: 8,
		unit: "px",
		precision: 0,
	},
	{
		labelKey: "filterPanel.pixelateBlockHeight",
		paramKey: "blockHeight",
		min: 1,
		max: 128,
		step: 1,
		defaultValue: 8,
		unit: "px",
		precision: 0,
	},
];

export const PixelateFilterControls = memo(function PixelateFilterControls({
	filter,
	onUpdate,
}: {
	filter: PixelateFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const params = filter.paramData.params;

	// Mirror the changed axis onto the other one while axes are linked
	const handleSlidersUpdate = useEventCallback((p: Record<string, unknown>) => {
		if (params.linkAxes && "blockWidth" in p) {
			onUpdate({ ...p, blockHeight: p.blockWidth });
		} else if (params.linkAxes && "blockHeight" in p) {
			onUpdate({ ...p, blockWidth: p.blockHeight });
		} else {
			onUpdate(p);
		}
	});
	const handleModeChange = useEventCallback((value: string) => {
		onUpdate({ mode: value });
	});
	const handleLinkAxesChange = useEventCallback((checked: boolean) => {
		// Snap height to width the moment linking turns on
		onUpdate(
			checked
				? { linkAxes: true, blockHeight: params.blockWidth ?? 8 }
				: { linkAxes: false },
		);
	});
	return (
		<FilterSliders
			sliders={PIXELATE_SLIDERS}
			params={params}
			onUpdate={handleSlidersUpdate}
		>
			<div>
				<div className="text-muted-foreground text-xs mb-1">
					{t("filterPanel.pixelateMode")}
				</div>
				<SimpleSelect
					$size="sm"
					items={[
						{
							label: t("filterPanel.pixelateModeBilinear"),
							value: "bilinear",
						},
						{
							label: t("filterPanel.pixelateModeBicubic"),
							value: "bicubic",
						},
					]}
					value={params.mode ?? "bilinear"}
					onValueChange={handleModeChange}
				/>
			</div>
			{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
			<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
				<Checkbox
					checked={params.linkAxes ?? false}
					onCheckedChange={handleLinkAxesChange}
				/>
				{t("filterPanel.pixelateLinkAxes")}
			</label>
		</FilterSliders>
	);
});
