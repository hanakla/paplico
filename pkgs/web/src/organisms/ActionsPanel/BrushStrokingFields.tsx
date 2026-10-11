import { mergeBrushStroking } from "@paplico/core/brush";
import type { BrushStroking } from "@paplico/core/schema";
import { memo } from "react";
import { useSnapshot } from "valtio";
import { DashPatternControls } from "@/components/DashPatternControls";
import { StrokeGeometryFields } from "@/components/StrokeGeometryFields";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useEventCallback } from "@/utils/hooks";

/** Caps, joins and dashes of the strokes the drawing tools create, shown only for a geometric brush. */
export const BrushStrokingFields = memo(function BrushStrokingFields() {
	const { tools, commands } = usePaplico();
	const toolSnap = useSnapshot(tools.state);

	const normalizedBrush =
		toolSnap.strokeAppearance?.paramData.params.brushSettings;

	const updateStroking = useEventCallback((patch: Partial<BrushStroking>) => {
		const current = tools.storedBrushSettings;
		if (current.engine !== "geometric") return;
		const stroking = mergeBrushStroking(current.stroking, patch);
		tools.setBrushSettings({ stroking });
		// Keep the selected element in sync: drawing resolves its appearance
		// from the selection when one exists, and stroke completion syncs the
		// selection's appearance back into the tool settings.
		commands.updateSelectedElementsBrushSettings({ ...current, stroking });
	});

	if (normalizedBrush?.engine !== "geometric") return null;

	return (
		<>
			<StrokeGeometryFields
				stroking={normalizedBrush.stroking}
				onChange={updateStroking}
			/>

			<DashPatternControls
				stroking={normalizedBrush.stroking}
				strokeWidth={normalizedBrush.properties.size?.base ?? 2}
				onChange={updateStroking}
			/>
		</>
	);
});
