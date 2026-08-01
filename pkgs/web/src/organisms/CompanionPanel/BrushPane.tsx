import { memo } from "react";
import type {
	CompanionCommand,
	CompanionState,
} from "@/companion/companionProtocol";

import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";
import { SliderRow } from "./SliderRow";

/**
 * The host allows any width, but a remote has no canvas to judge against, so
 * the slider covers the range you would reach for by hand and nothing beyond.
 */
const MAX_BRUSH_SIZE = 100;

export const BrushPane = memo(function BrushPane({
	state,
	onCommand,
}: {
	state: CompanionState;
	onCommand: (command: CompanionCommand) => void;
}) {
	const t = useTranslation();

	const handlePresetClick = useEventCallback(
		(e: React.MouseEvent<HTMLButtonElement>) => {
			const presetUid = e.currentTarget.dataset.presetUid;
			if (presetUid) onCommand({ type: "applyBrushPreset", presetUid });
		},
	);

	const handleSizeChange = useEventCallback((size: number) => {
		onCommand({ type: "setBrushSize", size });
	});

	const handleOpacityChange = useEventCallback((value: number) => {
		onCommand({ type: "setOpacity", value });
	});

	const handleStabilizationChange = useEventCallback((value: number) => {
		onCommand({ type: "setStabilization", value });
	});

	// Shelved apart the way the host's own brush panel shelves them: what ships
	// with the app, and what the user saved. An empty saved shelf is left out
	// rather than shown bare.
	const savedPresets = state.presets.filter((preset) => !preset.builtin);
	const builtinPresets = state.presets.filter((preset) => preset.builtin);

	return (
		<div className="flex flex-col gap-4 p-3">
			{savedPresets.length > 0 && (
				<PresetSection
					heading={t("toolbar.savedPresets")}
					presets={savedPresets}
					selectedPresetUid={state.selectedPresetUid}
					onPresetClick={handlePresetClick}
				/>
			)}
			<PresetSection
				heading={t("toolbar.factoryPresets")}
				presets={builtinPresets}
				selectedPresetUid={state.selectedPresetUid}
				onPresetClick={handlePresetClick}
			/>

			<SliderRow
				label={t("companion.brushSize")}
				value={Math.min(state.brushSize, MAX_BRUSH_SIZE)}
				display={state.brushSize.toFixed(1)}
				min={0.5}
				max={MAX_BRUSH_SIZE}
				step={0.5}
				onValueChange={handleSizeChange}
			/>
			<SliderRow
				label={t("companion.opacity")}
				value={state.opacity}
				display={`${Math.round(state.opacity * 100)}%`}
				min={0}
				max={1}
				step={0.01}
				onValueChange={handleOpacityChange}
			/>
			<SliderRow
				label={t("companion.stabilization")}
				value={state.stabilization}
				display={`${Math.round(state.stabilization * 100)}%`}
				min={0}
				max={1}
				step={0.01}
				onValueChange={handleStabilizationChange}
			/>
		</div>
	);
});

function PresetSection({
	heading,
	presets,
	selectedPresetUid,
	onPresetClick,
}: {
	heading: string;
	presets: CompanionState["presets"];
	selectedPresetUid: string | null;
	onPresetClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
	return (
		<section className="flex flex-col gap-2">
			<h2 className="text-xs text-muted-foreground">{heading}</h2>
			<div className="grid grid-cols-2 gap-2">
				{presets.map((preset) => (
					<button
						key={preset.uid}
						type="button"
						data-preset-uid={preset.uid}
						onClick={onPresetClick}
						className={twm(
							"min-h-11 px-3 rounded-lg border text-sm text-left truncate transition-colors",
							preset.uid === selectedPresetUid
								? "bg-accent text-accent-foreground border-accent"
								: "bg-muted/30 border-border",
						)}
					>
						{preset.name}
					</button>
				))}
			</div>
		</section>
	);
}
