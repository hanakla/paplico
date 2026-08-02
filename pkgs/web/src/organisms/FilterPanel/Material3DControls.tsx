import { ChevronRight } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { Accordion } from "@/components/Accordion";
import { ColorSwatch } from "@/components/ColorSwatch";
import { PatternEditor } from "@/components/GradientPicker";
import { Popover } from "@/components/Popover";
import type { Color, FillColor, PatternFill, Vec3 } from "@/core/schema";
import { useEventCallback } from "@/utils/hooks";
import type { FilterSliderDef } from "./FilterSliders";

/**
 * Shared Material3D control pieces for the 3D solid appearance panels
 * (ControlsExtrude3D / ControlsRevolve3D): the collapsible Section shell, the
 * material pattern swatch row, the slider definitions for the shared
 * Solid3DBaseParams fields (rotation, lighting, PBR, glass, fresnel, surface
 * texture), and the light-direction angle helpers. Each panel keeps its own
 * geometry sliders and update handlers.
 */

/** Virtual slider params mapped onto the `rotationDeg` Vec3. */
export const ROTATION_SLIDERS: FilterSliderDef[] = (
	[
		["filterPanel.rotateX", "rotateX"],
		["filterPanel.rotateY", "rotateY"],
		["filterPanel.rotateZ", "rotateZ"],
	] as const
).map(([labelKey, paramKey]) => ({
	labelKey,
	paramKey,
	min: -180,
	max: 180,
	step: 1,
	defaultValue: 0,
	unit: "°",
	precision: 0,
}));

/** Virtual slider params mapped onto `material.lightDir` / `material.specularPower`. */
export const LIGHT_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.extrudeLightAzimuth",
		paramKey: "lightAzimuth",
		min: -180,
		max: 180,
		step: 1,
		defaultValue: 0,
		unit: "°",
		precision: 0,
	},
	{
		labelKey: "filterPanel.extrudeLightElevation",
		paramKey: "lightElevation",
		min: -90,
		max: 90,
		step: 1,
		defaultValue: 0,
		unit: "°",
		precision: 0,
	},
];

export const LIGHT_AND_SPECULAR_SLIDERS: FilterSliderDef[] = [
	...LIGHT_SLIDERS,
	{
		labelKey: "filterPanel.extrudeSpecularPower",
		paramKey: "specularPower",
		min: 1,
		max: 128,
		step: 1,
		defaultValue: 32,
		precision: 0,
	},
];

/** Direct `material.*` sliders (paramKey === material field name). */
export const PBR_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.extrudeRoughness",
		paramKey: "roughness",
		min: 0,
		max: 1,
		step: 0.01,
		defaultValue: 0.5,
		precision: 2,
	},
	{
		labelKey: "filterPanel.extrudeMetalness",
		paramKey: "metalness",
		min: 0,
		max: 1,
		step: 0.01,
		defaultValue: 0,
		precision: 2,
	},
	{
		labelKey: "filterPanel.extrudeReflectivity",
		paramKey: "reflectivity",
		min: 0,
		max: 2,
		step: 0.01,
		defaultValue: 0,
		precision: 2,
	},
	{
		labelKey: "filterPanel.extrudeGlass",
		paramKey: "glass",
		min: 0,
		max: 1,
		step: 0.01,
		defaultValue: 0,
		precision: 2,
	},
];

/** Surface pattern opacity — independent of the object/fill alpha. */
export const SURFACE_TEXTURE_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.extrudeSurfaceTextureOpacity",
		paramKey: "patternOpacity",
		min: 0,
		max: 1,
		step: 0.01,
		defaultValue: 1,
		precision: 2,
	},
];

/** Backdrop-distorting glass params (need the composited backdrop). */
export const GLASS_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.extrudeRefraction",
		paramKey: "refraction",
		min: 1,
		max: 2,
		step: 0.01,
		defaultValue: 1,
		precision: 2,
	},
	{
		labelKey: "filterPanel.extrudeThickness",
		paramKey: "thickness",
		min: 0,
		max: 50,
		step: 0.5,
		defaultValue: 10,
		precision: 1,
	},
	{
		labelKey: "filterPanel.extrudeAberration",
		paramKey: "aberration",
		min: 0,
		max: 1,
		step: 0.01,
		defaultValue: 0,
		precision: 2,
	},
	{
		labelKey: "filterPanel.extrudeBlur",
		paramKey: "blur",
		min: 0,
		max: 20,
		step: 0.1,
		defaultValue: 0,
		precision: 1,
		// World px, like every other spatial appearance slider: the blur keeps
		// its size on the artboard across zoom and export scale.
		unit: "px",
	},
];

export const FRESNEL_SLIDERS: FilterSliderDef[] = [
	{
		labelKey: "filterPanel.extrudeFresnelBias",
		paramKey: "fresnelBias",
		min: -1,
		max: 1,
		step: 0.01,
		defaultValue: 0,
		precision: 2,
	},
	{
		labelKey: "filterPanel.extrudeFresnelScale",
		paramKey: "fresnelScale",
		min: 0,
		max: 4,
		step: 0.01,
		defaultValue: 1,
		precision: 2,
	},
	{
		labelKey: "filterPanel.extrudeFresnelIntensity",
		paramKey: "fresnelIntensity",
		min: 0,
		max: 4,
		step: 0.01,
		defaultValue: 1,
		precision: 2,
	},
	{
		labelKey: "filterPanel.extrudeFresnelFactor",
		paramKey: "fresnelFactor",
		min: 0,
		max: 8,
		step: 0.1,
		defaultValue: 5,
		precision: 1,
	},
];

export const WHITE_LIGHT: Color = { type: "rgb", r: 1, g: 1, b: 1, a: 1 };
/** Mirrors the shader's neutral ambient default. */
export const NEUTRAL_SHADOW: Color = {
	type: "rgb",
	r: 0.25,
	g: 0.25,
	b: 0.25,
	a: 1,
};

/** One collapsible parameter group in a 3D solid appearance panel. */
export function Section({
	value,
	label,
	headerRight,
	children,
}: {
	value: string;
	label: string;
	headerRight?: ReactNode;
	children: ReactNode;
}) {
	return (
		<Accordion.Item value={value} className="border-t border-border/40">
			<Accordion.Header className="flex items-center justify-between">
				<Accordion.Trigger className="group flex items-center gap-1 flex-1 py-1.5 text-xs font-medium text-muted-foreground">
					<ChevronRight
						size={12}
						className="shrink-0 transition-transform group-data-panel-open:rotate-90"
					/>
					{label}
				</Accordion.Trigger>
				{headerRight}
			</Accordion.Header>
			<Accordion.Panel>
				<div className="space-y-2 pb-2">{children}</div>
			</Accordion.Panel>
		</Accordion.Item>
	);
}

/** "Label …… swatch" row for the material surface pattern (Illustrator-style
 *  tiled texture). Clicking the swatch opens the shared PatternEditor. */
export function MaterialPatternSwatch({
	label,
	pattern,
	onPatternChange,
}: {
	label: string;
	pattern: PatternFill | null;
	onPatternChange: (fill: FillColor | null) => void;
}) {
	const [open, setOpen] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const handleToggle = useEventCallback(() => setOpen((value) => !value));
	const swatchColor: FillColor = pattern ?? EMPTY_PATTERN;

	return (
		<div className="flex items-center justify-between">
			<span className="text-muted-foreground text-xs">{label}</span>
			<Popover.Root open={open} onOpenChange={setOpen}>
				<button
					ref={buttonRef}
					type="button"
					aria-label={label}
					className="rounded-sm border border-border p-0.5 hover:bg-accent"
					onClick={handleToggle}
				>
					<ColorSwatch color={swatchColor} size={16} />
				</button>
				<Popover.Content
					side="bottom"
					sideOffset={8}
					align="end"
					anchor={buttonRef}
				>
					<div className="w-64">
						<PatternEditor fill={pattern} onFillChange={onPatternChange} />
					</div>
				</Popover.Content>
			</Popover.Root>
		</div>
	);
}

/** Placeholder swatch value when no surface pattern is selected. */
const EMPTY_PATTERN: PatternFill = {
	type: "pattern",
	defId: null,
	scaleX: 1,
	scaleY: 1,
	rotation: 0,
	offsetX: 0,
	offsetY: 0,
};

const DEG_PER_RAD = 180 / Math.PI;

export function azimuthDegOf(lightDir: Vec3): number {
	return Math.atan2(lightDir[0], lightDir[2]) * DEG_PER_RAD;
}

export function elevationDegOf(lightDir: Vec3): number {
	return Math.asin(Math.min(1, Math.max(-1, lightDir[1]))) * DEG_PER_RAD;
}

export function lightDirFromAngles(
	azimuthDeg: number,
	elevationDeg: number,
): Vec3 {
	const azimuth = azimuthDeg / DEG_PER_RAD;
	const elevation = elevationDeg / DEG_PER_RAD;
	return [
		Math.cos(elevation) * Math.sin(azimuth),
		Math.sin(elevation),
		Math.cos(elevation) * Math.cos(azimuth),
	];
}
