/**
 * Wet macro projections for brush settings v2.
 *
 * Each macro maps one intuitive 0..1 knob onto a small, fixed set of base
 * values. Every value is written by exactly ONE macro, so macros never fight
 * each other, and no macro touches a curve: hand-shaped modulation survives
 * dragging a macro slider.
 *
 * Macro → base value projections (v = macro value):
 * - bleed:   wet.bleedRadius = v, bleedSoftness = 0.35 + 0.3v,
 *            directionality = 0.1 + 0.35v
 * - dryness: wetness = clamp(1 − 0.85v, 0.05, 1), absorption = 0.15 + 0.65v
 * - paper:   grainAmount = v, granulation = 0.8v,
 *            edgeRoughness = 0.1 + 0.6v
 *
 * Read-back policy: macros are stateless projections — nothing extra is
 * persisted. `readWetMacro` derives the macro value ONLY from its
 * representative value:
 * - bleed   → `wet.bleedRadius` (identity)
 * - dryness → `wetness` (inverted: `(1 − wetness) / 0.85`)
 * - paper   → `grainAmount` (identity)
 * The non-representative values a macro writes are ignored on read-back, so
 * editing them by hand does not shift the macro slider.
 *
 * Values untouched by any macro: edgeDarkening, grainScale, pigmentLoad.
 */

import type { BrushPropertyId, BrushSettingsV2 } from "../schema";
import { BRUSH_PROPERTY_REGISTRY } from "./properties";

export type WetMacroKey = "bleed" | "dryness" | "paper";

/** Apply a macro value (clamped to [0,1]) onto the base values it owns. */
export function applyWetMacro(
	current: BrushSettingsV2,
	macro: WetMacroKey,
	value: number,
): BrushSettingsV2 {
	const v = clamp01(value);
	switch (macro) {
		case "bleed":
			return withBases(
				{
					...current,
					wet: current.wet ? { ...current.wet, bleedRadius: v } : current.wet,
				},
				{ bleedSoftness: 0.35 + 0.3 * v, directionality: 0.1 + 0.35 * v },
			);
		case "dryness":
			return withBases(current, {
				wetness: clamp(1 - 0.85 * v, 0.05, 1),
				absorption: 0.15 + 0.65 * v,
			});
		case "paper":
			return withBases(current, {
				grainAmount: v,
				granulation: 0.8 * v,
				edgeRoughness: 0.1 + 0.6 * v,
			});
	}
}

/** Project the macro value back from the single value that represents it. */
export function readWetMacro(
	current: BrushSettingsV2,
	macro: WetMacroKey,
): number {
	switch (macro) {
		case "bleed":
			return clamp01(current.wet?.bleedRadius ?? baseOf(current, "wetness"));
		case "dryness":
			return clamp01((1 - baseOf(current, "wetness")) / 0.85);
		case "paper":
			return clamp01(baseOf(current, "grainAmount"));
	}
}

function withBases(
	current: BrushSettingsV2,
	bases: Partial<Record<BrushPropertyId, number>>,
): BrushSettingsV2 {
	const properties = { ...current.properties };
	for (const [id, base] of Object.entries(bases) as [
		BrushPropertyId,
		number,
	][]) {
		properties[id] = { ...properties[id], base };
	}
	return { ...current, properties };
}

function baseOf(current: BrushSettingsV2, id: BrushPropertyId): number {
	return current.properties[id]?.base ?? BRUSH_PROPERTY_REGISTRY[id].base;
}

function clamp01(v: number): number {
	return Math.min(1, Math.max(0, v));
}

function clamp(v: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, v));
}
