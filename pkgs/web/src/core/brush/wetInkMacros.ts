/**
 * Wet-ink macro projections.
 *
 * Each macro maps one intuitive 0..1 knob onto a small, fixed set of raw
 * WetInkSettings parameters. Every raw parameter is written by exactly ONE
 * macro, so macros never fight each other.
 *
 * Macro → raw parameter projections (v = macro value):
 * - bleed:   bleedWidth = v, diffusion = 0.35 + 0.3v,
 *            directionality = 0.1 + 0.35v
 * - dryness: wetness = clamp(1 − 0.85v, 0.05, 1),
 *            speedInfluence = 0.2 + 0.7v, absorption = 0.15 + 0.65v
 * - paper:   paperGrain = v, granulation = 0.8v,
 *            edgeRoughness = 0.1 + 0.6v
 *
 * Read-back policy: macros are stateless projections — nothing new is
 * persisted. `readWetInkMacro` derives the macro value ONLY from its
 * representative raw parameter:
 * - bleed   → `bleedWidth` (identity)
 * - dryness → `wetness` (inverted: `(1 − wetness) / 0.85`)
 * - paper   → `paperGrain` (identity)
 * The non-representative parameters written by a macro are ignored on
 * read-back, so manual edits to them in the advanced panel do not shift the
 * macro slider.
 *
 * Parameters untouched by any macro: edgeDarkening, paperScale,
 * accelInfluence, pigmentLoad, and the pickup group.
 */

import type { WetInkSettings } from "../schema";

export type WetInkMacroKey = "bleed" | "dryness" | "paper";

/** Apply a macro value (clamped to [0,1]) onto the raw wet-ink parameters. */
export function applyWetInkMacro(
	current: WetInkSettings,
	macro: WetInkMacroKey,
	value: number,
): WetInkSettings {
	const v = clamp01(value);
	switch (macro) {
		case "bleed":
			return {
				...current,
				bleedWidth: v,
				diffusion: 0.35 + 0.3 * v,
				directionality: 0.1 + 0.35 * v,
			};
		case "dryness":
			return {
				...current,
				wetness: clamp(1 - 0.85 * v, 0.05, 1),
				speedInfluence: 0.2 + 0.7 * v,
				absorption: 0.15 + 0.65 * v,
			};
		case "paper":
			return {
				...current,
				paperGrain: v,
				granulation: 0.8 * v,
				edgeRoughness: 0.1 + 0.6 * v,
			};
	}
}

/** Project the macro value back from its representative raw parameter. */
export function readWetInkMacro(
	current: WetInkSettings,
	macro: WetInkMacroKey,
): number {
	switch (macro) {
		case "bleed":
			return clamp01(current.bleedWidth);
		case "dryness":
			return clamp01((1 - current.wetness) / 0.85);
		case "paper":
			return clamp01(current.paperGrain);
	}
}

function clamp01(v: number): number {
	return Math.min(1, Math.max(0, v));
}

function clamp(v: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, v));
}
