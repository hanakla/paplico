import { Eraser, GripVertical } from "lucide-react";
import { useSnapshot } from "valtio";
import { ToggleGroup } from "@/components/ToggleGroup";
import { Tooltip } from "@/components/Tooltip";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/**
 * Switches what the stroke width tool edits: the stroke's width or how far
 * the eraser cut into it.
 */
export function StrokeWidthEditTargetToggle() {
	const t = useTranslation();
	const { tools } = usePaplico();
	const target = useSnapshot(tools.state).strokeWidthEditTarget;

	const handleValueChange = useEventCallback((value: string[]) => {
		const next = value[0];
		if (next === "width" || next === "erasure") {
			tools.setStrokeWidthEditTarget(next);
		}
	});

	return (
		<ToggleGroup.Root value={[target]} onValueChange={handleValueChange}>
			<Tooltip content={t("contextActions.strokeWidthEditWidth")} side="bottom">
				<ToggleGroup.Item value="width">
					<GripVertical size={16} />
				</ToggleGroup.Item>
			</Tooltip>
			<Tooltip
				content={t("contextActions.strokeWidthEditErasure")}
				side="bottom"
			>
				<ToggleGroup.Item value="erasure">
					<Eraser size={16} />
				</ToggleGroup.Item>
			</Tooltip>
		</ToggleGroup.Root>
	);
}
