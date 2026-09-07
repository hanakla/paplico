import type {
	BrushEngineKind,
	BrushPropertyConfig,
	BrushSettings,
	BrushSettingsPatch,
	BrushStroking,
	WetEdgeConfig,
} from "../schema";
import { BRUSH_PROPERTY_REGISTRY } from "./properties";

/**
 * Lightweight readers/writers for stored brush settings, for hot paths
 * (bounds, hit testing) and cheap write sites.
 */

/** Read the effective brush size off stored settings. */
export function readStoredBrushSize(raw: unknown): number | undefined {
	if (!isRecord(raw)) return undefined;
	const size = (raw as unknown as BrushSettings).properties?.size;
	return size?.base ?? BRUSH_PROPERTY_REGISTRY.size.base;
}

/** Return a copy with the size replaced. */
export function withStoredBrushSize<T>(settings: T, size: number): T {
	if (!isRecord(settings)) return settings;
	const v2 = settings as unknown as BrushSettings;
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
	const wet = (raw as unknown as BrushSettings).wet;
	return wet?.enabled === true ? wet.bleedRadius : 0;
}

/**
 * Settings with the stored width deleted, for persistence. Presets and papb
 * files must not record the user's working width; readers fall back to the
 * registry default for the missing base. Size curves stay — they are the
 * brush's dynamics, not a width.
 */
export function withoutStoredBrushSize(settings: BrushSettings): BrushSettings {
	// Callers may hand in raw pre-v2 records; those carry no properties bag.
	if (!settings.properties?.size) return settings;
	const { size, ...rest } = settings.properties;
	if (!size.curves?.length) return { ...settings, properties: rest };
	return {
		...settings,
		// The stored form intentionally omits `base`; normalize restores it.
		properties: {
			...rest,
			size: { curves: size.curves } as BrushPropertyConfig,
		},
	};
}

/**
 * Settings with the size curves dropped. Paths flagged strokeWidthsBaked
 * carry the curves' evaluation in their strokeWidths profile, so renderers
 * evaluate size from this neutralized view to avoid applying width twice.
 */
export function neutralizeSizeCurves(settings: BrushSettings): BrushSettings {
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
 * over a complete BrushSettings, so a patch can never silently flatten one.
 */
export function applyBrushPatch(
	current: BrushSettings,
	patch: BrushSettingsPatch,
): BrushSettings {
	const next: BrushSettings = { ...current };

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

interface BrushRenderRequirements {
	engine: BrushEngineKind;
	/** Wash strokes accumulate flow in an isolated texture and apply
	 *  strokeOpacity once at composite time. Ribbons wash too: the isolation
	 *  is engine-independent, and a ribbon that doubles back over itself
	 *  darkens exactly like a dab stroke does. */
	requiresIsolation: boolean;
	/** The wet layer simulation; dab strokes only. */
	wetEnabled: boolean;
	/** Colour pick-up from the composite below; dab strokes only. */
	mixingEnabled: boolean;
	strokeOpacity: number;
	/** The watercolor rim. Suppressed whenever the stored wet config is on,
	 *  whichever engine the settings name. */
	wetEdge: WetEdgeConfig | undefined;
}

export function resolveBrushRenderRequirements(
	settings: BrushSettings,
): BrushRenderRequirements {
	const wetEnabled =
		settings.engine === "dab" && settings.wet?.enabled === true;
	return {
		engine: settings.engine,
		requiresIsolation:
			settings.engine !== "geometric" && settings.paintMode === "wash",
		wetEnabled,
		mixingEnabled:
			settings.engine === "dab" && settings.mixing?.enabled === true,
		strokeOpacity: settings.strokeOpacity,
		wetEdge: settings.wet?.enabled === true ? undefined : settings.wetEdge,
	};
}
