import { ChevronDown } from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import { Accordion } from "@/components/Accordion";
import { Checkbox } from "@/components/Checkbox";
import { ColorPickerThin } from "@/components/ColorPicker2";
import { SimpleSelect } from "@/components/SimpleSelect";
import type {
	HKVhsInterlaceFilter,
	HKVhsInterlaceParams,
} from "@/core/renderer/filters";
import type { Color } from "@/core/schema";
import { type LocalizeKeys, useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

const TOP_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.vhsIntensity",
		paramKey: "intensity",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.5,
		scale: 100,
	},
	{
		labelKey: "filterPanel.vhsGeneration",
		paramKey: "generation",
		min: 1,
		max: 5,
		step: 1,
		defaultValue: 1,
		precision: 0,
	},
];

const SIGNAL_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.vhsChromaBleed",
		paramKey: "chromaBleed",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.3,
		scale: 100,
	},
	{
		labelKey: "filterPanel.vhsColorShift",
		paramKey: "colorShift",
		min: 0,
		max: 0.1,
		step: 0.001,
		defaultValue: 0.01,
		precision: 3,
	},
	{
		labelKey: "filterPanel.vhsLumaSoftness",
		paramKey: "lumaSoftness",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.15,
		scale: 100,
	},
	{
		labelKey: "filterPanel.vhsRinging",
		paramKey: "ringing",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.15,
		scale: 100,
	},
];

const TRANSPORT_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.vhsLineJitter",
		paramKey: "lineJitter",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.1,
		scale: 100,
	},
	{
		labelKey: "filterPanel.vhsVerticalJitter",
		paramKey: "verticalJitter",
		min: 0,
		max: 0.2,
		step: 0.01,
		defaultValue: 0.01,
		precision: 2,
	},
	{
		labelKey: "filterPanel.vhsTrackingError",
		paramKey: "trackingError",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.05,
		scale: 100,
	},
	{
		labelKey: "filterPanel.vhsHeadSwitching",
		paramKey: "headSwitching",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.25,
		scale: 100,
	},
	{
		labelKey: "filterPanel.vhsHeadSwitchingHeight",
		paramKey: "headSwitchingHeight",
		min: 0,
		max: 40,
		step: 1,
		defaultValue: 8,
		unit: "px",
		precision: 0,
	},
];

const TAPE_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.vhsNoise",
		paramKey: "noise",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.15,
		scale: 100,
	},
	{
		labelKey: "filterPanel.vhsNoiseDistortion",
		paramKey: "noiseDistortion",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.2,
		scale: 100,
	},
	{
		labelKey: "filterPanel.vhsChromaNoise",
		paramKey: "chromaNoise",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.15,
		scale: 100,
	},
	{
		labelKey: "filterPanel.vhsDropouts",
		paramKey: "dropouts",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.05,
		scale: 100,
	},
	{
		labelKey: "filterPanel.vhsDropoutLength",
		paramKey: "dropoutLength",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.25,
		scale: 100,
	},
	{
		labelKey: "filterPanel.vhsBrightnessJitter",
		paramKey: "brightnessJitter",
		min: 0,
		max: 0.5,
		step: 0.01,
		defaultValue: 0.03,
		precision: 2,
	},
];

const DISPLAY_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.vhsScanlines",
		paramKey: "scanlines",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.3,
		scale: 100,
	},
	{
		labelKey: "filterPanel.vhsInterlaceGap",
		paramKey: "interlaceGap",
		min: 1,
		max: 10,
		step: 1,
		defaultValue: 2,
		precision: 0,
	},
	{
		labelKey: "filterPanel.vhsCombing",
		paramKey: "combing",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.1,
		scale: 100,
	},
	{
		labelKey: "filterPanel.vhsTilt",
		paramKey: "tilt",
		min: -1,
		max: 1,
		step: 0.01,
		defaultValue: 0,
		precision: 2,
	},
	{
		labelKey: "filterPanel.vhsBlackLift",
		paramKey: "blackLift",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.12,
		scale: 100,
	},
	{
		labelKey: "filterPanel.vhsDesaturation",
		paramKey: "desaturation",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.1,
		scale: 100,
	},
];

const SEED_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.vhsSeed",
		paramKey: "randomSeed",
		min: 0,
		max: 1000,
		step: 1,
		defaultValue: 42,
		precision: 0,
	},
];

/** UI-only presets — they just batch-apply the degradation params.
 *  Intensity, seed, tilt and the color cast are left untouched. */
const PRESETS: {
	value: string;
	labelKey: LocalizeKeys;
	params: Partial<HKVhsInterlaceParams>;
}[] = [
	{
		// The exaggerated look of the pre-rework defaults: strong scanlines
		// and grain, none of the newer signal-accurate degradations.
		value: "stylized",
		labelKey: "filterPanel.vhsPresetStylized",
		params: {
			generation: 1,
			chromaBleed: 0,
			colorShift: 0.004,
			lumaSoftness: 0,
			ringing: 0,
			lineJitter: 0,
			verticalJitter: 0,
			trackingError: 0.04,
			headSwitching: 0,
			headSwitchingHeight: 8,
			noise: 0,
			noiseDistortion: 0.2,
			chromaNoise: 0,
			dropouts: 0,
			dropoutLength: 0.25,
			brightnessJitter: 0.05,
			scanlines: 0,
			interlaceGap: 2,
			combing: 0,
			blackLift: 0,
			desaturation: 0,
		},
	},
	{
		value: "sp",
		labelKey: "filterPanel.vhsPresetSp",
		params: {
			generation: 1,
			chromaBleed: 0.3,
			colorShift: 0.01,
			lumaSoftness: 0.15,
			ringing: 0.15,
			lineJitter: 0.1,
			verticalJitter: 0.01,
			trackingError: 0.05,
			headSwitching: 0.25,
			headSwitchingHeight: 8,
			noise: 0.15,
			noiseDistortion: 0.2,
			chromaNoise: 0.15,
			dropouts: 0.05,
			dropoutLength: 0.25,
			brightnessJitter: 0.03,
			scanlines: 0.3,
			interlaceGap: 2,
			combing: 0.1,
			blackLift: 0.12,
			desaturation: 0.1,
		},
	},
	{
		value: "ep",
		labelKey: "filterPanel.vhsPresetEp",
		params: {
			generation: 1,
			chromaBleed: 0.6,
			colorShift: 0.015,
			lumaSoftness: 0.45,
			ringing: 0.2,
			lineJitter: 0.25,
			verticalJitter: 0.02,
			trackingError: 0.15,
			headSwitching: 0.35,
			headSwitchingHeight: 10,
			noise: 0.35,
			noiseDistortion: 0.25,
			chromaNoise: 0.4,
			dropouts: 0.15,
			dropoutLength: 0.3,
			brightnessJitter: 0.06,
			scanlines: 0.35,
			interlaceGap: 2,
			combing: 0.2,
			blackLift: 0.18,
			desaturation: 0.18,
		},
	},
	{
		value: "rental",
		labelKey: "filterPanel.vhsPresetRental",
		params: {
			generation: 2,
			chromaBleed: 0.45,
			colorShift: 0.012,
			lumaSoftness: 0.3,
			ringing: 0.25,
			lineJitter: 0.3,
			verticalJitter: 0.04,
			trackingError: 0.4,
			headSwitching: 0.55,
			headSwitchingHeight: 12,
			noise: 0.5,
			noiseDistortion: 0.35,
			chromaNoise: 0.45,
			dropouts: 0.55,
			dropoutLength: 0.45,
			brightnessJitter: 0.12,
			scanlines: 0.4,
			interlaceGap: 2,
			combing: 0.25,
			blackLift: 0.22,
			desaturation: 0.2,
		},
	},
	{
		value: "dub5",
		labelKey: "filterPanel.vhsPresetDub5",
		params: {
			generation: 5,
			chromaBleed: 0.5,
			colorShift: 0.02,
			lumaSoftness: 0.4,
			ringing: 0.4,
			lineJitter: 0.2,
			verticalJitter: 0.02,
			trackingError: 0.2,
			headSwitching: 0.3,
			headSwitchingHeight: 8,
			noise: 0.3,
			noiseDistortion: 0.3,
			chromaNoise: 0.35,
			dropouts: 0.2,
			dropoutLength: 0.3,
			brightnessJitter: 0.08,
			scanlines: 0.3,
			interlaceGap: 2,
			combing: 0.15,
			blackLift: 0.3,
			desaturation: 0.35,
		},
	},
	{
		value: "badDeck",
		labelKey: "filterPanel.vhsPresetBadDeck",
		params: {
			generation: 1,
			chromaBleed: 0.35,
			colorShift: 0.015,
			lumaSoftness: 0.2,
			ringing: 0.2,
			lineJitter: 0.7,
			verticalJitter: 0.09,
			trackingError: 0.8,
			headSwitching: 0.85,
			headSwitchingHeight: 16,
			noise: 0.35,
			noiseDistortion: 0.4,
			chromaNoise: 0.3,
			dropouts: 0.35,
			dropoutLength: 0.5,
			brightnessJitter: 0.2,
			scanlines: 0.35,
			interlaceGap: 2,
			combing: 0.45,
			blackLift: 0.15,
			desaturation: 0.12,
		},
	},
];

export const VhsInterlaceFilterControls = memo(
	function VhsInterlaceFilterControls({
		filter,
		onUpdate,
	}: {
		filter: HKVhsInterlaceFilter;
		onUpdate: (p: Record<string, unknown>) => void;
	}) {
		const t = useTranslation();
		const handleUpdate = useEventCallback(onUpdate);
		const params = filter.paramData.params;

		// Presets live only in the UI; the selection isn't part of the saved
		// params, so it resets when the controls remount.
		const [presetValue, setPresetValue] = useState("");
		const handlePresetChange = useEventCallback((value: string) => {
			const preset = PRESETS.find((p) => p.value === value);
			if (!preset) return;
			setPresetValue(value);
			handleUpdate(preset.params);
		});
		const handleEnableColorChange = useEventCallback((checked: boolean) => {
			handleUpdate({ enableVHSColor: checked });
		});
		const handleApplyToTransparentChange = useEventCallback(
			(checked: boolean) => {
				handleUpdate({ applyToTransparent: checked });
			},
		);
		const handleColorChange = useEventCallback((c: Color) => {
			handleUpdate({ vhsColor: c });
		});

		return (
			<div className="space-y-2">
				<FilterSliders
					sliders={TOP_SLIDERS}
					params={params}
					onUpdate={onUpdate}
				/>

				<div>
					<div className="text-muted-foreground text-xs mb-1">
						{t("filterPanel.vhsPresets")}
					</div>
					<SimpleSelect
						$size="sm"
						items={[
							{ label: "—", value: "" },
							...PRESETS.map((preset) => ({
								label: t(preset.labelKey),
								value: preset.value,
							})),
						]}
						value={presetValue}
						onValueChange={handlePresetChange}
					/>
				</div>

				<Accordion.Root multiple>
					<ParamGroup value="signal" titleKey="filterPanel.vhsGroupSignal">
						<FilterSliders
							sliders={SIGNAL_SLIDERS}
							params={params}
							onUpdate={onUpdate}
						/>
					</ParamGroup>

					<ParamGroup
						value="transport"
						titleKey="filterPanel.vhsGroupTransport"
					>
						<FilterSliders
							sliders={TRANSPORT_SLIDERS}
							params={params}
							onUpdate={onUpdate}
						/>
					</ParamGroup>

					<ParamGroup value="tape" titleKey="filterPanel.vhsGroupTape">
						<FilterSliders
							sliders={TAPE_SLIDERS}
							params={params}
							onUpdate={onUpdate}
						/>
					</ParamGroup>

					<ParamGroup value="display" titleKey="filterPanel.vhsGroupDisplay">
						<FilterSliders
							sliders={DISPLAY_SLIDERS}
							params={params}
							onUpdate={onUpdate}
						>
							{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
							<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
								<Checkbox
									checked={params.enableVHSColor}
									onCheckedChange={handleEnableColorChange}
								/>
								{t("filterPanel.vhsEnableColor")}
							</label>
							<div>
								<div className="text-muted-foreground text-xs mb-1">
									{t("filterPanel.vhsColorLabel")}
								</div>
								<ColorPickerThin
									color={params.vhsColor}
									onColorChange={handleColorChange}
								/>
							</div>
						</FilterSliders>
					</ParamGroup>
				</Accordion.Root>

				<FilterSliders
					sliders={SEED_SLIDERS}
					params={params}
					onUpdate={onUpdate}
				/>
				{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
				<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
					<Checkbox
						checked={params.applyToTransparent}
						onCheckedChange={handleApplyToTransparentChange}
					/>
					{t("filterPanel.vhsApplyToTransparent")}
				</label>
			</div>
		);
	},
);

function ParamGroup({
	value,
	titleKey,
	children,
}: {
	value: string;
	titleKey: LocalizeKeys;
	children: ReactNode;
}) {
	const t = useTranslation();

	return (
		<Accordion.Item value={value} className="border-t border-border/50">
			<Accordion.Header>
				<Accordion.Trigger className="group flex items-center justify-between py-1.5 text-muted-foreground text-xs font-medium">
					{t(titleKey)}
					<ChevronDown
						size={12}
						className="transition-transform group-data-panel-open:rotate-180"
					/>
				</Accordion.Trigger>
			</Accordion.Header>
			<Accordion.Panel>
				<div className="space-y-2 pb-2">{children}</div>
			</Accordion.Panel>
		</Accordion.Item>
	);
}
