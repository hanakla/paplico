import type {
	BrushSettingsPatch,
	BrushSettingsV2,
	BrushStroking,
	WetInkSettings,
} from "../schema";
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
 * How far past its own width a wet stroke bleeds, as a ratio of the brush
 * size, from either settings shape. Bounds needs this without normalizing.
 */
export function readStoredWetBleedRatio(raw: unknown): number {
	if (!isRecord(raw)) return 0;
	if (raw.version === 2) {
		const wet = (raw as unknown as BrushSettingsV2).wet;
		return wet?.enabled === true ? wet.bleedRadius : 0;
	}
	if (raw.type !== "scatter" && raw.type !== "calligraphy") return 0;
	const wetInk = isRecord(raw.wetInk)
		? (raw.wetInk as unknown as WetInkSettings)
		: undefined;
	return wetInk?.enabled === true ? wetInk.bleedWidth : 0;
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

/**
 * Apply a small edit to stored settings. Only values with no curve behind
 * them are patchable this way — anything a curve can shape is set by handing
 * over a complete BrushSettingsV2, so a patch can never silently flatten one.
 */
export function applyBrushPatch(
	current: BrushSettingsV2,
	patch: BrushSettingsPatch,
): BrushSettingsV2 {
	const next: BrushSettingsV2 = { ...current };

	if (patch.size !== undefined) {
		next.properties = {
			...next.properties,
			size: { ...next.properties.size, base: patch.size },
		};
	}
	if (patch.taperStart !== undefined) next.taperStart = patch.taperStart;
	if (patch.taperEnd !== undefined) next.taperEnd = patch.taperEnd;
	if (patch.colorMode !== undefined) next.colorMode = patch.colorMode;
	if (patch.stroking !== undefined) {
		next.stroking = { ...next.stroking, ...patch.stroking };
	}
	if (patch.tipSource !== undefined) {
		next.tip =
			next.tip?.kind === "image"
				? {
						...next.tip,
						sources: [patch.tipSource, ...next.tip.sources.slice(1)],
					}
				: {
						kind: "image",
						sources: [patch.tipSource],
						selection: "random",
						angleMode: "fixed",
					};
		next.ribbon = next.ribbon
			? { ...next.ribbon, source: patch.tipSource }
			: undefined;
	}
	return next;
}
