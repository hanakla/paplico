import { memo } from "react";
import type { SvgBlendFilter } from "@/core/renderer/filters";
import { useBlendModeItems } from "@/hooks/useBlendModeItems";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { SelectRow } from "./SelectRow";
import { SvgInputSelect } from "./SvgInputSelect";

export const SvgBlendFilterControls = memo(function SvgBlendFilterControls({
	filter,
	onUpdate,
}: {
	filter: SvgBlendFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const handleUpdate = useEventCallback(onUpdate);
	const params = filter.paramData.params;
	const modeItems = useBlendModeItems();
	return (
		<div className="space-y-2">
			<SvgInputSelect
				labelKey="filterPanel.svgInput"
				value={params.in}
				excludePrevious={params.in2 === "previous"}
				onChange={(input) => handleUpdate({ in: input })}
			/>
			<SvgInputSelect
				labelKey="filterPanel.svgInput2"
				value={params.in2}
				excludePrevious={params.in === "previous"}
				onChange={(input) => handleUpdate({ in2: input })}
			/>
			<SelectRow
				label={t("filterPanel.svgBlendMode")}
				items={modeItems}
				value={params.mode}
				onValueChange={(mode) => handleUpdate({ mode })}
			/>
		</div>
	);
});
