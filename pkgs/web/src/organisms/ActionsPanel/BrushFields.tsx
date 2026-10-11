import { readStoredBrushSize } from "@paplico/core/brush";
import { memo } from "react";
import { useSnapshot } from "valtio";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useBrushEdits } from "@/hooks/useBrushEdits";
import { useBrushPresets } from "@/hooks/useBrushPresets";
import { useTranslation } from "@/locales";
import { PresetSelect } from "@/organisms/Toolbar/BrushTools";
import { useEventCallback } from "@/utils/hooks";
import { StrokeWidthField } from "./StrokeWidthField";
import { BRUSH_WIDTH_STEP } from "./utils";

/** Brush preset and width of the strokes the drawing tools create. */
export const BrushFields = memo(function BrushFields() {
	const t = useTranslation();
	const { tools } = usePaplico();
	const brushEdits = useBrushEdits();
	const brushPresets = useBrushPresets();
	const toolSnap = useSnapshot(tools.state);

	const handleWidthChange = useEventCallback((value: number) => {
		brushEdits.setBrushSize(value);
	});

	const handlePresetSelect = useEventCallback((presetUid: string) => {
		void brushPresets.applyBrushPreset(presetUid);
	});

	return (
		<>
			<PresetSelect
				persistedPresets={brushPresets.persistedPresets}
				builtinPresets={brushPresets.builtinPresets}
				selectedUid={brushPresets.selectedBrushPresetUid}
				onSelect={handlePresetSelect}
				getPersistedPreview={brushPresets.getPersistedPresetPreviewSource}
				getBuiltinPreview={brushPresets.getBuiltinPresetPreviewSource}
			/>
			<StrokeWidthField
				label={t("actionsPanel.brushWidth")}
				value={
					readStoredBrushSize(
						toolSnap.strokeAppearance?.paramData.params.brushSettings,
					) ?? 2
				}
				min={0.01}
				max={Infinity}
				range={50}
				step={BRUSH_WIDTH_STEP}
				onValueChange={handleWidthChange}
			/>
		</>
	);
});
