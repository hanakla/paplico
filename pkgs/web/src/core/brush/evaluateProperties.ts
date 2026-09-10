import type { BrushInputId, BrushPropertyId, BrushSettings } from "../schema";
import { buildCurveLut, sampleCurveLut } from "./curves";
import {
	BRUSH_PROPERTY_REGISTRY,
	type BrushPropertySpec,
	MAX_SCALE_FACTOR,
} from "./properties";

/**
 * Curve-matrix evaluation of brush properties. Every engine that
 * modulates a property — dabs per sample, ribbons at their segment endpoints
 * — resolves it through here, so a property's domain and clamping behave the
 * same whichever engine draws the stroke.
 */

interface BakedProperty {
	spec: BrushPropertySpec;
	base: number;
	curves: { input: BrushInputId; lut: Float32Array }[];
}

type BakedBrushProperties = Partial<Record<BrushPropertyId, BakedProperty>>;

/** Bake each configured property's curves into sampling LUTs, once per stroke. */
export function bakeBrushProperties(
	settings: BrushSettings,
): BakedBrushProperties {
	const out: BakedBrushProperties = {};
	for (const [id, config] of Object.entries(settings.properties)) {
		const spec = BRUSH_PROPERTY_REGISTRY[id as BrushPropertyId];
		if (!spec || !config) continue;
		out[id as BrushPropertyId] = {
			spec,
			base: config.base,
			curves: (config.curves ?? []).map((curve) => ({
				input: curve.input,
				lut: buildCurveLut(curve.points),
			})),
		};
	}
	return out;
}

/**
 * The property's value for the given inputs: curve contributions sum, then
 * apply as a factor (scale domain) or an offset, clamped to the spec range.
 * Unconfigured properties fall back to the registry's base.
 */
export function evalBrushProperty(
	baked: BakedBrushProperties,
	id: BrushPropertyId,
	inputs: Record<BrushInputId, number>,
): number {
	const entry = baked[id];
	const spec = entry?.spec ?? BRUSH_PROPERTY_REGISTRY[id];
	const base = entry?.base ?? spec.base;
	let sum = 0;
	if (entry) {
		for (const curve of entry.curves) {
			sum += sampleCurveLut(curve.lut, inputs[curve.input]);
		}
	}
	if (spec.domain === "scale") {
		const factor = Math.min(Math.max(1 + sum, 0), MAX_SCALE_FACTOR);
		return Math.min(Math.max(base * factor, spec.min), spec.max);
	}
	return Math.min(Math.max(base + sum, spec.min), spec.max);
}

/** Neutral input set; callers fill in what their engine actually samples. */
export function createBrushInputs(): Record<BrushInputId, number> {
	return {
		pressure: 0,
		speedFine: 0,
		speedGross: 0,
		accel: 0,
		tiltMagnitude: 0,
		tiltAzimuth: 0.5,
		twist: 0,
		direction: 0.5,
		strokeT: 0,
		fade: 0,
		distance: 0,
		randomPerDab: 0,
		randomPerStroke: 0,
	};
}
