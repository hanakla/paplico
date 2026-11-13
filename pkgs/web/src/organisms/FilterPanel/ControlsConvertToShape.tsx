import type { ConvertToShapeFilter } from "@paplico/core/filters";
import { memo, useMemo } from "react";
import { SimpleSelect } from "@/components/SimpleSelect";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

export const ConvertToShapeFilterControls = memo(
	function ConvertToShapeFilterControls({
		filter,
		onUpdate,
	}: {
		filter: ConvertToShapeFilter;
		onUpdate: (params: Record<string, unknown>) => void;
	}) {
		const t = useTranslation();
		const update = useEventCallback(onUpdate);
		const { shape, sizeMode } = filter.paramData.params;
		const shapes = useMemo(
			() => [
				{ label: t("filterPanel.convertToShapeRectangle"), value: "rectangle" },
				{ label: t("filterPanel.convertToShapeEllipse"), value: "ellipse" },
			],
			[t],
		);
		const modes = useMemo(
			() => [
				{ label: t("filterPanel.convertToShapeRelative"), value: "relative" },
				{ label: t("filterPanel.convertToShapeAbsolute"), value: "absolute" },
			],
			[t],
		);
		const sliders: FilterSliderDef[] = [
			{
				labelKey:
					sizeMode === "absolute"
						? "filterPanel.convertToShapeWidth"
						: "filterPanel.convertToShapeExtraWidth",
				paramKey: "width",
				min: sizeMode === "absolute" ? 0 : -500,
				max: 1000,
				step: 1,
				defaultValue: 0,
				unit: "px",
			},
			{
				labelKey:
					sizeMode === "absolute"
						? "filterPanel.convertToShapeHeight"
						: "filterPanel.convertToShapeExtraHeight",
				paramKey: "height",
				min: sizeMode === "absolute" ? 0 : -500,
				max: 1000,
				step: 1,
				defaultValue: 0,
				unit: "px",
			},
			...(shape === "rectangle"
				? [
						{
							labelKey: "filterPanel.convertToShapeRadius" as const,
							paramKey: "cornerRadius",
							min: 0,
							max: 500,
							step: 1,
							defaultValue: 0,
							unit: "px",
						},
					]
				: []),
		];
		return (
			<div className="space-y-2">
				<div>
					<div className="text-muted-foreground type-label mb-1">
						{t("filterPanel.convertToShapeShape")}
					</div>
					<SimpleSelect
						$size="sm"
						items={shapes}
						value={shape}
						onValueChange={(value) => update({ shape: value })}
					/>
				</div>
				<div>
					<div className="text-muted-foreground type-label mb-1">
						{t("filterPanel.convertToShapeSize")}
					</div>
					<SimpleSelect
						$size="sm"
						items={modes}
						value={sizeMode}
						onValueChange={(value) =>
							update({
								sizeMode: value,
								width: value === "absolute" ? 100 : 0,
								height: value === "absolute" ? 100 : 0,
							})
						}
					/>
				</div>
				<FilterSliders
					sliders={sliders}
					params={filter.paramData.params}
					onUpdate={onUpdate}
				/>
			</div>
		);
	},
);
