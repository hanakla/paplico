/**
 * Display length unit for document dimensions. Coordinates are always stored
 * in world units; 1 world unit = 1 pt = 1/72 inch, which is also what the
 * 72-DPI rasterization baseline assumes. Units only affect UI display/parsing.
 */
export type LengthUnit = "px" | "pt" | "mm" | "cm" | "in";

export const LENGTH_UNITS: readonly LengthUnit[] = [
	"px",
	"pt",
	"mm",
	"cm",
	"in",
];

export const DEFAULT_LENGTH_UNIT: LengthUnit = "px";

const WORLD_UNITS_PER: Record<LengthUnit, number> = {
	px: 1,
	pt: 1,
	in: 72,
	cm: 72 / 2.54,
	mm: 72 / 25.4,
};

export function isLengthUnit(value: unknown): value is LengthUnit {
	return LENGTH_UNITS.includes(value as LengthUnit);
}

export function worldToUnit(world: number, unit: LengthUnit): number {
	return world / WORLD_UNITS_PER[unit];
}

export function unitToWorld(value: number, unit: LengthUnit): number {
	return value * WORLD_UNITS_PER[unit];
}

/** Format a world-unit length as a fixed-point string in the given unit. */
export function formatLength(
	world: number,
	unit: LengthUnit,
	fractionDigits = 2,
): string {
	return worldToUnit(world, unit).toFixed(fractionDigits);
}
