import { ChevronDown } from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import { Accordion } from "@/components/Accordion";
import { Checkbox } from "@/components/Checkbox";
import { SimpleSelect } from "@/components/SimpleSelect";
import type { HKPaperV2Filter, HKPaperV2Params } from "@/core/renderer/filters";
import { type LocalizeKeys, useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { type FilterSliderDef, FilterSliders } from "./FilterSliders";

// Grouped for illustrators unfamiliar with papermaking terms: pick a preset
// or a paper type first, then fine-tune inside the accordion groups.

const TEXTURE_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.paperFormation",
		paramKey: "formationStrength",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
	{
		labelKey: "filterPanel.paperLaidLine",
		paramKey: "laidLineStrength",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
	{
		labelKey: "filterPanel.paperDepthEffect",
		paramKey: "depthEffect",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.3,
		scale: 100,
	},
	{
		labelKey: "filterPanel.paperSurfaceRoughness",
		paramKey: "surfaceRoughness",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.5,
		scale: 100,
	},
	{
		labelKey: "filterPanel.paperSheerness",
		paramKey: "sheerness",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 1,
		scale: 100,
	},
];

const FIBER_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.paperBeating",
		paramKey: "beatingDegree",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.5,
		scale: 100,
	},
	{
		labelKey: "filterPanel.paperFiberAmount",
		paramKey: "fiberAmount",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.5,
		scale: 100,
	},
	{
		labelKey: "filterPanel.paperFiberDarkness",
		paramKey: "fiberDarkness",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.3,
		scale: 100,
	},
	{
		labelKey: "filterPanel.paperMaxFiberLength",
		paramKey: "maxFiberLength",
		min: 10,
		max: 500,
		step: 10,
		defaultValue: 100,
		unit: "px",
	},
];

const LIGHTING_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.paperLightIntensity",
		paramKey: "lightIntensity",
		min: 0,
		max: 100,
		step: 1,
		defaultValue: 0.5,
		scale: 100,
	},
	{
		labelKey: "filterPanel.paperLightAngle",
		paramKey: "lightAngle",
		min: 0,
		max: 360,
		step: 1,
		defaultValue: 135,
		unit: "°",
	},
];

const SEED_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.paperSeed",
		paramKey: "seed",
		min: 0,
		max: 1000,
		step: 1,
		defaultValue: 42,
		precision: 0,
	},
];

/** UI-only presets: batch-apply a recognizable paper. Seed and invert are
 *  left untouched so re-picking a preset never reshuffles the fibers. */
const PRESETS: {
	value: string;
	labelKey: LocalizeKeys;
	params: Partial<HKPaperV2Params>;
}[] = [
	{
		value: "copy",
		labelKey: "filterPanel.paperPresetCopy",
		params: {
			paperType: "woodfree",
			beatingDegree: 0.8,
			fiberAmount: 0.6,
			fiberDarkness: 0.15,
			maxFiberLength: 60,
			formationStrength: 0.6,
			laidLineStrength: 1,
			sheerness: 1,
			lightingEnabled: true,
			lightIntensity: 0.4,
			lightAngle: 135,
			depthEffect: 0.25,
			surfaceRoughness: 0.4,
		},
	},
	{
		value: "sketch",
		labelKey: "filterPanel.paperPresetSketch",
		params: {
			paperType: "woodfree",
			beatingDegree: 0.4,
			fiberAmount: 1.2,
			fiberDarkness: 0.3,
			maxFiberLength: 100,
			formationStrength: 1,
			laidLineStrength: 1,
			sheerness: 1,
			lightingEnabled: true,
			lightIntensity: 0.55,
			lightAngle: 135,
			depthEffect: 0.55,
			surfaceRoughness: 0.7,
		},
	},
	{
		value: "newsprint",
		labelKey: "filterPanel.paperPresetNewsprint",
		params: {
			paperType: "machine",
			beatingDegree: 0.3,
			fiberAmount: 1.4,
			fiberDarkness: 0.45,
			maxFiberLength: 120,
			formationStrength: 1,
			laidLineStrength: 1,
			sheerness: 1,
			lightingEnabled: true,
			lightIntensity: 0.5,
			lightAngle: 135,
			depthEffect: 0.5,
			surfaceRoughness: 0.8,
		},
	},
	{
		value: "washi",
		labelKey: "filterPanel.paperPresetWashi",
		params: {
			paperType: "kouzo",
			beatingDegree: 0.3,
			fiberAmount: 1.2,
			fiberDarkness: 0.35,
			maxFiberLength: 150,
			formationStrength: 1,
			laidLineStrength: 1,
			sheerness: 1,
			lightingEnabled: true,
			lightIntensity: 0.55,
			lightAngle: 135,
			depthEffect: 0.5,
			surfaceRoughness: 0.7,
		},
	},
	{
		value: "sheer",
		labelKey: "filterPanel.paperPresetSheer",
		params: {
			paperType: "tengujou",
			beatingDegree: 0.5,
			fiberAmount: 1,
			fiberDarkness: 0.3,
			maxFiberLength: 150,
			formationStrength: 1,
			laidLineStrength: 1,
			sheerness: 1,
			lightingEnabled: true,
			lightIntensity: 0.4,
			lightAngle: 135,
			depthEffect: 0.35,
			surfaceRoughness: 0.4,
		},
	},
	{
		value: "glossy",
		labelKey: "filterPanel.paperPresetGlossy",
		params: {
			paperType: "art",
			beatingDegree: 0.9,
			fiberAmount: 0.4,
			fiberDarkness: 0.1,
			maxFiberLength: 60,
			formationStrength: 0.3,
			laidLineStrength: 1,
			sheerness: 1,
			lightingEnabled: true,
			lightIntensity: 0.6,
			lightAngle: 135,
			depthEffect: 0.15,
			surfaceRoughness: 0.2,
		},
	},
];

export const PaperTextureFilterControls = memo(
	function PaperTextureFilterControls({
		filter,
		onUpdate,
	}: {
		filter: HKPaperV2Filter;
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
		const handlePaperTypeChange = useEventCallback((value: string) => {
			handleUpdate({ paperType: value });
		});
		const handleInvertChange = useEventCallback((checked: boolean) => {
			handleUpdate({ invert: checked });
		});
		const handleLightingChange = useEventCallback((checked: boolean) => {
			handleUpdate({ lightingEnabled: checked });
		});

		return (
			<div className="space-y-2">
				<div>
					<div className="text-muted-foreground text-xs mb-1">
						{t("filterPanel.paperPresets")}
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

				<div>
					<div className="text-muted-foreground text-xs mb-1">
						{t("filterPanel.paperType")}
					</div>
					<SimpleSelect
						$size="sm"
						items={[
							{ label: t("filterPanel.paperTypeWoodfree"), value: "woodfree" },
							{ label: t("filterPanel.paperTypeArt"), value: "art" },
							{ label: t("filterPanel.paperTypeCoated"), value: "coated" },
							{ label: t("filterPanel.paperTypeMachine"), value: "machine" },
							{
								label: t("filterPanel.paperTypeLightCoated"),
								value: "lightCoated",
							},
							{ label: t("filterPanel.paperTypeKouzo"), value: "kouzo" },
							{
								label: t("filterPanel.paperTypeMitsumata"),
								value: "mitsumata",
							},
							{ label: t("filterPanel.paperTypeGanpi"), value: "ganpi" },
							{ label: t("filterPanel.paperTypeTengujou"), value: "tengujou" },
							{
								label: t("filterPanel.paperTypeTousagami"),
								value: "tousagami",
							},
						]}
						value={params.paperType}
						onValueChange={handlePaperTypeChange}
					/>
				</div>

				<Accordion.Root multiple defaultValue={["lighting"]}>
					<ParamGroup
						value="lighting"
						titleKey="filterPanel.paperGroupLighting"
					>
						{/* biome-ignore lint/a11y/noLabelWithoutControl: custom checkbox component */}
						<label className="flex items-center gap-2 text-muted-foreground text-xs cursor-pointer">
							<Checkbox
								checked={params.lightingEnabled}
								onCheckedChange={handleLightingChange}
							/>
							{t("filterPanel.paperLighting")}
						</label>
						<FilterSliders
							sliders={LIGHTING_SLIDERS}
							params={params}
							onUpdate={onUpdate}
						/>
					</ParamGroup>

					<ParamGroup value="texture" titleKey="filterPanel.paperGroupTexture">
						<FilterSliders
							sliders={TEXTURE_SLIDERS}
							params={params}
							onUpdate={onUpdate}
						/>
					</ParamGroup>

					<ParamGroup value="fibers" titleKey="filterPanel.paperGroupFibers">
						<FilterSliders
							sliders={FIBER_SLIDERS}
							params={params}
							onUpdate={onUpdate}
						/>
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
						checked={params.invert}
						onCheckedChange={handleInvertChange}
					/>
					{t("filterPanel.paperInvert")}
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
