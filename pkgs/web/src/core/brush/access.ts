import type {
	BrushSettingsPatch,
	BrushSettingsV2,
	BrushStroking,
} from "../schema";
import { BRUSH_PROPERTY_REGISTRY } from "./properties";

/**
 * Lightweight readers/writers for stored brush settings. They avoid a full
 * normalize pass in hot paths (bounds, hit testing) and keep write sites
 * cheap. Anything richer goes through normalizeBrushSettingsV2.
 */

/** Read the effective brush size off stored settings. */
export function readStoredBrushSize(raw: unknown): number | undefined {
	if (!isRecord(raw)) return undefined;
	const size = (raw as unknown as BrushSettingsV2).properties?.size;
	return size?.base ?? BRUSH_PROPERTY_REGISTRY.size.base;
}

/** Return a copy with the size replaced. */
export function withStoredBrushSize<T>(settings: T, size: number): T {
	if (!isRecord(settings)) return settings;
	const v2 = settings as unknown as BrushSettingsV2;
	return {
		...v2,
		properties: {
			...v2.properties,
			size: { ...v2.properties?.size, base: size },
		},
	} as unknown as T;
}

/**
 * How far past its own width a wet stroke bleeds, as a ratio of the brush
 * size. Bounds needs this without normalizing.
 */
export function readStoredWetBleedRatio(raw: unknown): number {
	if (!isRecord(raw)) return 0;
	const wet = (raw as unknown as BrushSettingsV2).wet;
	return wet?.enabled === true ? wet.bleedRadius : 0;
}

/**
 * Settings with the size curves dropped. Paths flagged strokeWidthsBaked
 * carry the curves' evaluation in their strokeWidths profile, so renderers
 * evaluate size from this neutralized view to avoid applying width twice.
 */
export function neutralizeSizeCurves(
	settings: BrushSettingsV2,
): BrushSettingsV2 {
	const size = settings.properties.size;
	if (!size?.curves?.length) return settings;
	return {
		...settings,
		properties: { ...settings.properties, size: { base: size.base } },
	};
}

/** Read geometric stroking config (line cap/join, miter, dash). */
export function readStoredBrushStroking(
	raw: unknown,
): BrushStroking | undefined {
	if (!isRecord(raw)) return undefined;
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
