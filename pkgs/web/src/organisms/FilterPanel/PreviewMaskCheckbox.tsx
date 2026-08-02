import { Info } from "lucide-react";
import { Checkbox } from "@/components/Checkbox";
import { Tooltip } from "@/components/Tooltip";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/** "Preview mask" checkbox with an info tooltip explaining how to read the mask. */
export function PreviewMaskCheckbox({
	checked,
	onCheckedChange,
}: {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	const t = useTranslation();
	const handleChange = useEventCallback(onCheckedChange);

	return (
		<div className="flex items-center gap-2 text-muted-foreground text-xs">
			{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
			<label className="flex items-center gap-2 cursor-pointer">
				<Checkbox checked={checked} onCheckedChange={handleChange} />
				{t("filterPanel.hkPreviewMask")}
			</label>
			<Tooltip content={t("filterPanel.hkPreviewMaskHint")}>
				<Info className="size-3.5" />
			</Tooltip>
		</div>
	);
}
