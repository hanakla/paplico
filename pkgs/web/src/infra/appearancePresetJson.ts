import {
	type AppearancePreset,
	type Filter,
	normalizeAppearanceFields,
} from "@/core/schema";

export const APPEARANCE_PRESET_JSON_FORMAT = "paplico-appearance-preset";
export const APPEARANCE_PRESET_JSON_VERSION = 1;

interface AppearancePresetJson {
	format: typeof APPEARANCE_PRESET_JSON_FORMAT;
	version: typeof APPEARANCE_PRESET_JSON_VERSION;
	preset: AppearancePreset;
}

export function serializeAppearancePresetJson(
	preset: AppearancePreset,
): string {
	const payload: AppearancePresetJson = {
		format: APPEARANCE_PRESET_JSON_FORMAT,
		version: APPEARANCE_PRESET_JSON_VERSION,
		preset: { uid: preset.uid, name: preset.name, filters: preset.filters },
	};
	return JSON.stringify(payload, null, 2);
}

/** Throws on anything that is not a preset file this build understands. */
export function parseAppearancePresetJson(text: string): AppearancePreset {
	let decoded: unknown;
	try {
		decoded = JSON.parse(text);
	} catch {
		throw new Error("Invalid appearance preset JSON: not JSON");
	}
	if (!isRecord(decoded)) {
		throw new Error("Invalid appearance preset JSON: not an object");
	}
	if (decoded.format !== APPEARANCE_PRESET_JSON_FORMAT) {
		throw new Error("Invalid appearance preset JSON: unknown format");
	}
	if (decoded.version !== APPEARANCE_PRESET_JSON_VERSION) {
		throw new Error(
			`Unsupported appearance preset version: ${String(decoded.version)}`,
		);
	}
	const preset = decoded.preset;
	if (
		!isRecord(preset) ||
		typeof preset.uid !== "string" ||
		typeof preset.name !== "string" ||
		!Array.isArray(preset.filters) ||
		!preset.filters.every(isFilterLike)
	) {
		throw new Error("Invalid appearance preset JSON: preset shape is invalid");
	}
	return {
		uid: preset.uid,
		name: preset.name,
		filters: normalizeAppearanceFields(preset.filters as Filter[]),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFilterLike(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.uid === "string" &&
		typeof value.processor === "string" &&
		isRecord(value.paramData)
	);
}
