import { usePaplico } from "@/contexts/PaplicoContext";
import { setSelectedBrushPresetUid } from "@/stores/uiStore";
import { useEventCallback } from "@/utils/hooks";

/**
 * What changing the brush width or opacity means, wherever it is changed from.
 *
 * The brush panel, the actions panel and a companion device were each doing a
 * different subset of it — one cleared the preset the settings had drifted
 * from, another carried the change onto the selection, none did both — so the
 * same gesture landed differently depending on where it was made.
 */
export function useBrushEdits(): {
	setBrushSize: (size: number) => void;
	setOpacity: (value: number) => void;
} {
	const { tools, commands, uiState } = usePaplico();

	const setBrushSize = useEventCallback((size: number) => {
		// Edited settings are no longer the preset they came from, so nothing
		// should still be shown as selected in the preset list.
		setSelectedBrushPresetUid(null);
		tools.setBrushSettings({ size });

		// The brush panel syncs settings onto the selection through an effect of
		// its own, so this repeats that while the panel is open. It writes the
		// same value either way, and without it a change made with the panel
		// closed would leave the selection behind.
		commands.updateSelectedElementsBrushSettings({
			...tools.brushSettings,
			size,
		});
	});

	const setOpacity = useEventCallback((value: number) => {
		tools.setOpacity(value);
		commands.batchUpdateElements(
			uiState.selectedElementIds.map((elementId) => ({
				elementId,
				updates: { opacity: value },
			})),
		);
	});

	return { setBrushSize, setOpacity };
}
