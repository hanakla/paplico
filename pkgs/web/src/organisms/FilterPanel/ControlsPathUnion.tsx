import { memo, useMemo } from "react";
import { SimpleSelect } from "@/components/SimpleSelect";
import type { PathUnionFilter } from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

export const PathUnionFilterControls = memo(function PathUnionFilterControls({
	filter,
	onUpdate,
}: {
	filter: PathUnionFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const handleUpdate = useEventCallback(onUpdate);

	const modeItems = useMemo(
		() => [
			{ label: t("filterPanel.pathUnionModeUnion"), value: "union" },
			{
				label: t("filterPanel.pathUnionModeIntersection"),
				value: "intersection",
			},
			{
				label: t("filterPanel.pathUnionModeDifference"),
				value: "difference",
			},
			{ label: t("filterPanel.pathUnionModeXor"), value: "xor" },
		],
		[t],
	);

	return (
		<div>
			<div className="text-muted-foreground text-xs mb-1">
				{t("filterPanel.pathUnionMode")}
			</div>
			<SimpleSelect
				$size="sm"
				items={modeItems}
				value={filter.paramData.params.mode ?? "union"}
				onValueChange={(value) =>
					handleUpdate({
						mode: value as "union" | "intersection" | "difference" | "xor",
					})
				}
			/>
		</div>
	);
});
