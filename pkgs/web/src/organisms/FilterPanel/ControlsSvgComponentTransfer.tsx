import { memo } from "react";
import type {
	SvgComponentTransferFilter,
	SvgTransferFunction,
} from "@/core/renderer/filters";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { ChannelFnEditor } from "./ChannelFnEditor";
import { SvgInputSelect } from "./SvgInputSelect";

export const SvgComponentTransferFilterControls = memo(
	function SvgComponentTransferFilterControls({
		filter,
		onUpdate,
	}: {
		filter: SvgComponentTransferFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		const t = useTranslation();
		const handleUpdate = useEventCallback(onUpdate);
		const params = filter.paramData.params;
		// Param updates shallow-merge, so each channel function is written whole.
		const handleChannel = useEventCallback(
			(channel: "r" | "g" | "b" | "a", fn: SvgTransferFunction) =>
				handleUpdate({ [channel]: fn }),
		);
		return (
			<div className="space-y-3">
				<SvgInputSelect
					labelKey="filterPanel.svgInput"
					value={params.in}
					onChange={(input) => handleUpdate({ in: input })}
				/>
				<ChannelFnEditor
					label={t("filterPanel.svgChannelR")}
					value={params.r}
					onChange={(fn) => handleChannel("r", fn)}
				/>
				<ChannelFnEditor
					label={t("filterPanel.svgChannelG")}
					value={params.g}
					onChange={(fn) => handleChannel("g", fn)}
				/>
				<ChannelFnEditor
					label={t("filterPanel.svgChannelB")}
					value={params.b}
					onChange={(fn) => handleChannel("b", fn)}
				/>
				<ChannelFnEditor
					label={t("filterPanel.svgChannelA")}
					value={params.a}
					onChange={(fn) => handleChannel("a", fn)}
				/>
			</div>
		);
	},
);
