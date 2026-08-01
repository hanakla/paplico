import { memo, useMemo } from "react";
import { SimpleSelect } from "@/components/SimpleSelect";
import type { PathOffsetFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const PATH_OFFSET_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.offset",
		paramKey: "offset",
		min: -200,
		max: 200,
		step: 0.5,
		defaultValue: 5,
		unit: "px",
	},
];

export const PathOffsetFilterControls = memo(function PathOffsetFilterControls({
	filter,
	onUpdate,
}: {
	filter: PathOffsetFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const handleUpdate = useEventCallback(onUpdate);

	const joinTypeItems = useMemo(
		() => [
			{ label: t("filterPanel.joinMiter"), value: "miter" },
			{ label: t("filterPanel.joinRound"), value: "round" },
			{ label: t("filterPanel.joinBevel"), value: "bevel" },
		],
		[t],
	);

	return (
		<FilterSliders
			sliders={PATH_OFFSET_SLIDERS}
			params={filter.paramData.params}
			onUpdate={onUpdate}
		>
			<div>
				<div className="text-muted-foreground text-xs mb-1">
					{t("filterPanel.joinType")}
				</div>
				<SimpleSelect
					$size="sm"
					items={joinTypeItems}
					value={filter.paramData.params.joinType ?? "miter"}
					onValueChange={(value) =>
						handleUpdate({ joinType: value as "miter" | "round" | "bevel" })
					}
				/>
			</div>
		</FilterSliders>
	);
});
