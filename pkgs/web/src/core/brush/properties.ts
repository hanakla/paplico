import type { BrushPropertyId } from "../schema";

/**
 * Evaluation domain of a brush property.
 * - scale:  value = base * clamp(1 + sum(curves), 0, MAX_SCALE_FACTOR)
 * - offset: value = base + sum(curves)
 * Both results are clamped to [min, max].
 */
export type BrushPropertyDomain = "scale" | "offset";

export type BrushPropertyGroup =
	| "size"
	| "ink"
	| "tip"
	| "stroke"
	| "scatter"
	| "color"
	| "grain"
	| "mixing"
	| "wet";

export interface BrushPropertySpec {
	domain: BrushPropertyDomain;
	base: number;
	min: number;
	max: number;
	group: BrushPropertyGroup;
}

/** Upper clamp of the scale-domain factor `1 + sum(curves)`. */
export const MAX_SCALE_FACTOR = 8;

const TWO_PI = Math.PI * 2;

/**
 * Single source of truth for property domains, default bases, clamp ranges
 * and UI grouping. Wet-group properties are evaluated only while wet.enabled
 * (the evaluator skips them entirely otherwise).
 */
export const BRUSH_PROPERTY_REGISTRY: Record<
	BrushPropertyId,
	BrushPropertySpec
> = {
	size: { domain: "scale", base: 10, min: 0, max: 10_000, group: "size" },
	ratio: { domain: "scale", base: 1, min: 0, max: 4, group: "tip" },
	angle: { domain: "offset", base: 0, min: -TWO_PI, max: TWO_PI, group: "tip" },
	flow: { domain: "scale", base: 1, min: 0, max: 1, group: "ink" },
	spacing: { domain: "scale", base: 0.1, min: 0.001, max: 10, group: "stroke" },
	scatterOffset: {
		domain: "offset",
		base: 0,
		min: -4,
		max: 4,
		group: "scatter",
	},
	scatterAlong: {
		domain: "offset",
		base: 0,
		min: -4,
		max: 4,
		group: "scatter",
	},
	hueShift: { domain: "offset", base: 0, min: -0.5, max: 0.5, group: "color" },
	satShift: { domain: "offset", base: 0, min: -1, max: 1, group: "color" },
	valShift: { domain: "offset", base: 0, min: -1, max: 1, group: "color" },
	grainStrength: { domain: "scale", base: 1, min: 0, max: 1, group: "grain" },
	hardness: { domain: "scale", base: 1, min: 0, max: 1, group: "tip" },
	colorRate: { domain: "scale", base: 0.5, min: 0, max: 1, group: "mixing" },
	alphaRate: { domain: "scale", base: 0.5, min: 0, max: 1, group: "mixing" },
	smudgeLength: { domain: "scale", base: 0.5, min: 0, max: 1, group: "mixing" },
	dabsPerSecond: {
		domain: "scale",
		base: 0,
		min: 0,
		max: 500,
		group: "stroke",
	},
	wetness: { domain: "offset", base: 0.7, min: 0, max: 1.5, group: "wet" },
	directionality: { domain: "offset", base: 0.4, min: 0, max: 1, group: "wet" },
	grainAmount: { domain: "offset", base: 0.2, min: 0, max: 1, group: "wet" },
	absorption: { domain: "offset", base: 0.35, min: 0, max: 1, group: "wet" },
	granulation: { domain: "offset", base: 0.25, min: 0, max: 1, group: "wet" },
	bleedSoftness: { domain: "offset", base: 0.35, min: 0, max: 1, group: "wet" },
	edgeDarkening: { domain: "offset", base: 0.4, min: 0, max: 1, group: "wet" },
	edgeRoughness: { domain: "offset", base: 0.3, min: 0, max: 1, group: "wet" },
};

export const BRUSH_PROPERTY_IDS = Object.keys(
	BRUSH_PROPERTY_REGISTRY,
) as BrushPropertyId[];

export function isBrushPropertyId(value: unknown): value is BrushPropertyId {
	return typeof value === "string" && value in BRUSH_PROPERTY_REGISTRY;
}
