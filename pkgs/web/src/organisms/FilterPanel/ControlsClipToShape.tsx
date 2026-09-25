import type { ClipToShapeFilter } from "@paplico/core/filters";
import { memo } from "react";
import { Checkbox } from "@/components/Checkbox";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

export const ClipToShapeFilterControls = memo(
	function ClipToShapeFilterControls({
		filter,
		onUpdate,
	}: {
		filter: ClipToShapeFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		const t = useTranslation();
		const handleInvertChange = useEventCallback((checked: boolean) => {
			onUpdate({ invert: checked });
		});

		return (
			// biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component
			<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
				<Checkbox
					checked={filter.paramData.params.invert}
					onCheckedChange={handleInvertChange}
				/>
				{t("filterPanel.clipToShapeInvert")}
			</label>
		);
	},
);
