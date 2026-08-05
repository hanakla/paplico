import { memo } from "react";
import { Slider } from "@/components/Slider";
import { Switch } from "@/components/Switch";
import { ToggleGroup } from "@/components/ToggleGroup";
import {
	BRUSH_PROPERTY_IDS,
	BRUSH_PROPERTY_REGISTRY,
	type BrushPropertyGroup,
} from "@/core/brush/properties";
import { applyWetMacro, readWetMacro } from "@/core/brush/wetMacros";
import type {
	BrushEngineKind,
	BrushPropertyConfig,
	BrushPropertyId,
	BrushSettingsV2,
} from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { BrushPropertyRow } from "./BrushPropertyRow";

/**
 * The brush's curve matrix, one row per property: its base value and the
 * inputs that bend it while drawing.
 *
 * Watercolour and colour mixing sit here too because both are switched on as
 * a whole and then shaped property by property, exactly like the rest of the
 * matrix. Their gates are explicit switches — turning every wet property to
 * zero is not the same as turning wet off, and only the switch decides
 * whether the simulation runs at all.
 */
export const BrushMatrixSection = memo(function BrushMatrixSection({
	settings,
	onChange,
}: {
	settings: BrushSettingsV2;
	onChange: (next: BrushSettingsV2) => void;
}) {
	const t = useTranslation();
	const wetEnabled = settings.wet?.enabled === true;
	const mixingEnabled = settings.mixing?.enabled === true;

	const handlePropertyChange = useEventCallback(
		(propertyId: BrushPropertyId, next: BrushPropertyConfig) => {
			onChange({
				...settings,
				properties: { ...settings.properties, [propertyId]: next },
			});
		},
	);

	const handleWetToggle = useEventCallback((checked: boolean) => {
		const wet = { ...DEFAULT_WET_CONFIG, ...settings.wet, enabled: checked };
		// Wet strokes are composited as a single wash, and the wet layer draws
		// the stroke's edge itself, so the plain wet-edge effect steps aside.
		onChange({
			...settings,
			wet,
			paintMode: checked ? "wash" : settings.paintMode,
			wetEdge: checked ? undefined : settings.wetEdge,
		});
	});

	const handleMixingToggle = useEventCallback((checked: boolean) => {
		onChange({
			...settings,
			mixing: {
				...DEFAULT_MIXING_CONFIG,
				...settings.mixing,
				enabled: checked,
			},
		});
	});

	const handleWetValueChange = useEventCallback(
		(key: "bleedRadius" | "pigmentLoad" | "grainScale", value: number) => {
			onChange({
				...settings,
				wet: { ...DEFAULT_WET_CONFIG, ...settings.wet, [key]: value },
			});
		},
	);

	const handleMixingValueChange = useEventCallback(
		(key: "sampleRadius" | "sampleTrail" | "blendStyle", value: number) => {
			onChange({
				...settings,
				mixing: {
					...DEFAULT_MIXING_CONFIG,
					...settings.mixing,
					[key]: value,
				},
			});
		},
	);

	const handleMacroChange = useEventCallback(
		(macro: "bleed" | "dryness" | "paper", value: number) => {
			onChange(applyWetMacro(settings, macro, value));
		},
	);

	const handleStrokeOpacityChange = useEventCallback(
		(_key: string, value: number) => {
			onChange({ ...settings, strokeOpacity: value });
		},
	);

	const handlePaintModeChange = useEventCallback((value: string[]) => {
		const mode = value[0];
		if (mode !== "buildup" && mode !== "wash") return;
		onChange({ ...settings, paintMode: mode });
	});

	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-col">
				<PlainRow
					label={t("toolbar.opacity")}
					min={0}
					max={1}
					step={0.01}
					value={settings.strokeOpacity}
					valueKey="strokeOpacity"
					onValueChange={handleStrokeOpacityChange}
				/>
				<div className="flex items-center gap-3 px-3 py-1.5">
					<span className="w-20 shrink-0 truncate text-xs text-muted-foreground">
						{t("toolbar.paintMode")}
					</span>
					<ToggleGroup.Root
						value={[settings.paintMode]}
						onValueChange={handlePaintModeChange}
						disabled={wetEnabled}
					>
						<ToggleGroup.Item
							value="buildup"
							className="h-5 w-auto px-1.5 text-[10px]"
						>
							{t("toolbar.paintModeBuildup")}
						</ToggleGroup.Item>
						<ToggleGroup.Item
							value="wash"
							className="h-5 w-auto px-1.5 text-[10px]"
						>
							{t("toolbar.paintModeWash")}
						</ToggleGroup.Item>
					</ToggleGroup.Root>
				</div>
			</div>

			{groupsForEngine(settings.engine).map((group) => (
				<div key={group} className="flex flex-col">
					<p className="px-3 py-1 text-[11px] font-medium text-muted-foreground">
						{t(`brushGroup.${group}`)}
					</p>
					{propertiesOfGroup(group).map((propertyId) => (
						<BrushPropertyRow
							key={propertyId}
							propertyId={propertyId}
							config={settings.properties[propertyId]}
							onChange={handlePropertyChange}
						/>
					))}
				</div>
			))}

			{/* Only the dab engine runs the mix pass and the wet layer: the
			    solid-line and ribbon renderers ignore both, so their switches
			    would do nothing. */}
			{settings.engine !== "dab" ? null : (
				<>
					<GatedSection
						title={t("brushGroup.mixing")}
						enabled={mixingEnabled}
						onToggle={handleMixingToggle}
					>
						{propertiesOfGroup("mixing").map((propertyId) => (
							<BrushPropertyRow
								key={propertyId}
								propertyId={propertyId}
								config={settings.properties[propertyId]}
								onChange={handlePropertyChange}
							/>
						))}
						<PlainRow
							label={t("toolbar.mixingSampleRadius")}
							min={0.25}
							max={4}
							step={0.05}
							value={
								settings.mixing?.sampleRadius ??
								DEFAULT_MIXING_CONFIG.sampleRadius
							}
							valueKey="sampleRadius"
							onValueChange={handleMixingValueChange}
						/>
						<PlainRow
							label={t("toolbar.mixingSampleTrail")}
							min={-2}
							max={2}
							step={0.05}
							value={
								settings.mixing?.sampleTrail ??
								DEFAULT_MIXING_CONFIG.sampleTrail
							}
							valueKey="sampleTrail"
							onValueChange={handleMixingValueChange}
						/>
						<PlainRow
							label={t("toolbar.mixingBlendStyle")}
							min={0}
							max={1}
							step={0.01}
							value={
								settings.mixing?.blendStyle ?? DEFAULT_MIXING_CONFIG.blendStyle
							}
							valueKey="blendStyle"
							onValueChange={handleMixingValueChange}
						/>
					</GatedSection>

					<GatedSection
						title={t("brushGroup.wet")}
						enabled={wetEnabled}
						onToggle={handleWetToggle}
					>
						<PlainRow
							label={t("toolbar.wetMacroBleed")}
							min={0}
							max={1}
							step={0.01}
							value={readWetMacro(settings, "bleed")}
							valueKey="bleed"
							onValueChange={handleMacroChange}
						/>
						<PlainRow
							label={t("toolbar.wetMacroDryness")}
							min={0}
							max={1}
							step={0.01}
							value={readWetMacro(settings, "dryness")}
							valueKey="dryness"
							onValueChange={handleMacroChange}
						/>
						<PlainRow
							label={t("toolbar.wetMacroPaper")}
							min={0}
							max={1}
							step={0.01}
							value={readWetMacro(settings, "paper")}
							valueKey="paper"
							onValueChange={handleMacroChange}
						/>

						{propertiesOfGroup("wet").map((propertyId) => (
							<BrushPropertyRow
								key={propertyId}
								propertyId={propertyId}
								config={settings.properties[propertyId]}
								onChange={handlePropertyChange}
							/>
						))}
						<PlainRow
							label={t("toolbar.wetPigmentLoad")}
							min={0}
							max={2}
							step={0.01}
							value={
								settings.wet?.pigmentLoad ?? DEFAULT_WET_CONFIG.pigmentLoad
							}
							valueKey="pigmentLoad"
							onValueChange={handleWetValueChange}
						/>
						<PlainRow
							label={t("toolbar.wetGrainScale")}
							min={0.25}
							max={4}
							step={0.05}
							value={settings.wet?.grainScale ?? DEFAULT_WET_CONFIG.grainScale}
							valueKey="grainScale"
							onValueChange={handleWetValueChange}
						/>
					</GatedSection>
				</>
			)}
		</div>
	);
});

const DEFAULT_WET_CONFIG = {
	enabled: false,
	bleedRadius: 0.5,
	pigmentLoad: 0.85,
	grainScale: 1,
} as const;

const DEFAULT_MIXING_CONFIG = {
	enabled: false,
	mode: "dulling",
	sampleRadius: 1,
	sampleTrail: 1,
	blendStyle: 0,
} as const;

/** Property groups an engine can actually act on. */
function groupsForEngine(engine: BrushEngineKind): BrushPropertyGroup[] {
	switch (engine) {
		case "dab":
			return ["size", "tip", "ink", "stroke", "scatter", "color", "grain"];
		case "ribbon":
			return ["size", "ink", "stroke", "color"];
		case "geometric":
			return ["size", "ink"];
	}
}

function propertiesOfGroup(group: BrushPropertyGroup): BrushPropertyId[] {
	return BRUSH_PROPERTY_IDS.filter(
		(id) => BRUSH_PROPERTY_REGISTRY[id].group === group,
	);
}

/** A switched-off section keeps its settings but hides them until it is on. */
const GatedSection = memo(function GatedSection({
	title,
	enabled,
	onToggle,
	children,
}: {
	title: string;
	enabled: boolean;
	onToggle: (checked: boolean) => void;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col rounded-md border border-border-dim py-1">
			<div className="flex items-center justify-between px-3 py-1">
				<span className="text-[11px] font-medium text-foreground">{title}</span>
				<Switch
					aria-label={title}
					checked={enabled}
					onCheckedChange={onToggle}
				/>
			</div>
			{enabled ? children : null}
		</div>
	);
});

/** One value with no curve behind it: stroke-wide settings and macros. */
function PlainRow<Key extends string>({
	label,
	min,
	max,
	step,
	value,
	valueKey,
	onValueChange,
}: {
	label: string;
	min: number;
	max: number;
	step: number;
	value: number;
	valueKey: Key;
	onValueChange: (key: Key, value: number) => void;
}) {
	const handleValueChange = useEventCallback((next: number) => {
		onValueChange(valueKey, next);
	});

	return (
		<div className="flex items-center gap-3 px-3 py-1.5">
			<span className="w-20 shrink-0 truncate text-xs text-muted-foreground">
				{label}
			</span>
			<Slider
				min={min}
				max={max}
				step={step}
				value={value}
				onValueChange={handleValueChange}
				className="flex-1"
			/>
			<span className="w-9 shrink-0 text-right font-mono text-xs tabular-nums text-foreground">
				{value.toFixed(2)}
			</span>
		</div>
	);
}
