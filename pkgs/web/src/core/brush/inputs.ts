import type { BrushInputId } from "../schema";

/**
 * All curve-matrix inputs in registry order. Values handed to curve
 * evaluation are already normalized to 0..1:
 * - pressure/speedFine/speedGross/accel/tiltMagnitude/strokeT/fade/distance/
 *   randomPerDab/randomPerStroke are 0..1 by construction
 * - tiltAzimuth maps -PI..PI to 0..1, twist and direction map 0..2PI to 0..1
 */
export const BRUSH_INPUT_IDS: readonly BrushInputId[] = [
	"pressure",
	"speedFine",
	"speedGross",
	"accel",
	"tiltMagnitude",
	"tiltAzimuth",
	"twist",
	"direction",
	"strokeT",
	"fade",
	"distance",
	"randomPerDab",
	"randomPerStroke",
];

export function isBrushInputId(value: unknown): value is BrushInputId {
	return BRUSH_INPUT_IDS.includes(value as BrushInputId);
}
