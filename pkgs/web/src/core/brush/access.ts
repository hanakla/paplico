import type { BrushSettingsV2, BrushStroking, WetInkSettings } from "../schema";
import { BRUSH_PROPERTY_REGISTRY } from "./properties";

/**
 * Lightweight readers/writers for stored brush settings (v1 union, legacy
 * flat shape, or v2). They avoid a full normalize pass in hot paths (bounds,
 * hit testing) and keep write sites format-preserving. Anything richer must
 * go through normalizeBrushSettings / normalizeBrushSettingsV2.
 */

/** Read the effective brush size from a stored value in any format. */
export function readStoredBrushSize(raw: unknown): number | undefined {
	if (!isRecord(raw)) return undefined;
	if (raw.version === 2) {
		const size = (raw as unknown as BrushSettingsV2).properties?.size;
		return size?.base ?? BRUSH_PROPERTY_REGISTRY.size.base;
	}
	return typeof raw.size === "number" && Number.isFinite(raw.size)
		? raw.size
		: undefined;
}

/** Return a copy with the size replaced, preserving the stored format. */
export function withStoredBrushSize<T>(settings: T, size: number): T {
	if (!isRecord(settings)) return settings;
	if (settings.version === 2) {
		const v2 = settings as unknown as BrushSettingsV2;
		return {
			...v2,
			properties: {
				...v2.properties,
				size: { ...v2.properties.size, base: size },
			},
		} as unknown as T;
	}
	return { ...settings, size } as T;
}

/**
 * Read the wet ink settings that are authoritative for the stored value:
 * `wetInk` on v1 scatter/calligraphy brushes, `wetV1` on v2 (design §13-7).
 */
export function readStoredWetInk(raw: unknown): WetInkSettings | undefined {
	if (!isRecord(raw)) return undefined;
	if (raw.version === 2) {
		return (raw as unknown as BrushSettingsV2).wetV1;
	}
	if (raw.type !== "scatter" && raw.type !== "calligraphy") return undefined;
	return isRecord(raw.wetInk)
		? (raw.wetInk as unknown as WetInkSettings)
		: undefined;
}

/** Read geometric stroking config: v1 stroke brushes and v2 both carry it. */
export function readStoredBrushStroking(
	raw: unknown,
): BrushStroking | undefined {
	if (!isRecord(raw)) return undefined;
	if (raw.version !== 2 && raw.type !== "stroke") return undefined;
	return isRecord(raw.stroking)
		? (raw.stroking as unknown as BrushStroking)
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
