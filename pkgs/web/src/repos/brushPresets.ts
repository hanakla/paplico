import { withoutStoredBrushSize } from "@/core/brush/access";
import { withTextureFileUid } from "@/core/brush/brushSource";
import {
	createBuiltinBrushFiles,
	createBuiltinBrushPresets,
} from "@/core/brush/presets";
import {
	type BrushPreset,
	type BrushSettings,
	type EmbeddedFile,
	generateUid,
} from "@/core/schema";
import { deepClone } from "@/core/utils/lang";
import { tauriBrushPresetsRepo } from "@/infra/brushPresetsDB.tauri";
import { webBrushPresetsRepo } from "@/infra/brushPresetsDB.web";
import { IS_TAURI_ENV } from "@/utils/platform";

export interface PersistedBrushPreset {
	uid: string;
	name: string;
	/** Stored brush settings. The texture is stored separately as a bin. */
	defaultSettings: BrushSettings;
	textureName: string;
	textureMime: string;
	textureHash: string;
	textureBin: Uint8Array;
	sourceBuiltinUid?: string;
	createdAt: number;
	updatedAt: number;
}

export interface BrushPresetsRepo {
	list(): Promise<PersistedBrushPreset[]>;
	get(uid: string): Promise<PersistedBrushPreset | null>;
	save(preset: PersistedBrushPreset): Promise<void>;
	rename(uid: string, name: string): Promise<void>;
	delete(uid: string): Promise<void>;
}

export interface BrushStrokePreviewSource {
	brushSettings: BrushSettings;
	textureFile: EmbeddedFile | null;
}

export const brushPresetsRepo: BrushPresetsRepo = IS_TAURI_ENV
	? tauriBrushPresetsRepo
	: webBrushPresetsRepo;

const BUILTIN_BRUSH_PRESETS = createBuiltinBrushPresets();
const BRUSH_PREVIEW_RANDOM_SEED = 0x41c6_4e6d;
let builtinBrushFilesPromise: Promise<EmbeddedFile[]> | null = null;

export function getBuiltinBrushPresets(): BrushPreset[] {
	return BUILTIN_BRUSH_PRESETS.map((preset) => ({
		...preset,
		settings: deepClone(preset.settings),
	}));
}

export function getBuiltinBrushFiles(): Promise<EmbeddedFile[]> {
	builtinBrushFilesPromise ??= createBuiltinBrushFiles();
	return builtinBrushFilesPromise.then((files) =>
		files.map((file) => ({
			...file,
			bin: new Uint8Array(file.bin),
		})),
	);
}

export function createBrushPresetDefaults(
	settings: BrushSettings,
): BrushSettings {
	// Reset the random seed so the preset renders reproducibly; the texture is
	// captured separately as a bin, so the source is left as-is here.
	return deepClone({ ...settings, randomSeed: 0 });
}

export function createPersistedBrushPreset({
	uid = generateUid("brush-preset"),
	name,
	defaultSettings,
	file,
	sourceBuiltinUid,
	createdAt = Date.now(),
	updatedAt = createdAt,
}: {
	uid?: string;
	name: string;
	defaultSettings: BrushSettings;
	file: EmbeddedFile;
	sourceBuiltinUid?: string;
	createdAt?: number;
	updatedAt?: number;
}): PersistedBrushPreset {
	return {
		uid,
		name,
		// Presets never record the user's working width — see withoutStoredBrushSize.
		defaultSettings: deepClone(withoutStoredBrushSize(defaultSettings)),
		textureName: file.name,
		textureMime: file.type,
		textureHash: file.hash,
		textureBin: new Uint8Array(file.bin),
		...(sourceBuiltinUid ? { sourceBuiltinUid } : {}),
		createdAt,
		updatedAt,
	};
}

export function clonePersistedBrushPreset(
	preset: PersistedBrushPreset,
	name: string,
	uid = generateUid("brush-preset"),
): PersistedBrushPreset {
	const now = Date.now();
	return {
		...snapshotPersistedBrushPreset(preset),
		uid,
		name,
		createdAt: now,
		updatedAt: now,
	};
}

export function snapshotPersistedBrushPreset(
	preset: PersistedBrushPreset,
): PersistedBrushPreset {
	return {
		...preset,
		defaultSettings: deepClone(preset.defaultSettings),
		textureBin: new Uint8Array(preset.textureBin),
	};
}

export function createEmbeddedFileFromBrushPreset(
	preset: PersistedBrushPreset,
	uid = generateUid("file"),
): EmbeddedFile {
	return {
		uid,
		name: preset.textureName,
		type: preset.textureMime,
		hash: preset.textureHash,
		bin: new Uint8Array(preset.textureBin),
	};
}

export function createBuiltinBrushPreviewSource(
	preset: BrushPreset,
	textureFile: EmbeddedFile | null,
): BrushStrokePreviewSource {
	const base = {
		...deepClone(preset.settings),
		randomSeed: BRUSH_PREVIEW_RANDOM_SEED,
	};
	return {
		brushSettings: textureFile
			? withTextureFileUid(base, textureFile.uid)
			: base,
		textureFile: textureFile
			? {
					...textureFile,
					bin: new Uint8Array(textureFile.bin),
				}
			: null,
	};
}

export function createPersistedBrushPreviewSource(
	preset: PersistedBrushPreset,
): BrushStrokePreviewSource {
	const textureFile = createEmbeddedFileFromBrushPreset(
		preset,
		"brush-preview-texture",
	);

	return {
		brushSettings: withTextureFileUid(
			{
				...deepClone(preset.defaultSettings),
				randomSeed: BRUSH_PREVIEW_RANDOM_SEED,
			},
			textureFile.uid,
		),
		textureFile,
	};
}

export function isSamePersistedBrushPreset(
	left: PersistedBrushPreset,
	right: PersistedBrushPreset,
): boolean {
	return (
		left.name === right.name &&
		left.textureName === right.textureName &&
		left.textureMime === right.textureMime &&
		left.textureHash === right.textureHash &&
		left.sourceBuiltinUid === right.sourceBuiltinUid &&
		JSON.stringify(left.defaultSettings) ===
			JSON.stringify(right.defaultSettings) &&
		left.textureBin.length === right.textureBin.length &&
		left.textureBin.every((value, index) => value === right.textureBin[index])
	);
}

/**
 * The preset the given brush settings came from, or null when they match none.
 * The working width is left out of the comparison: a preset records no width,
 * so widening a brush does not turn it into a different preset.
 *
 * A persisted preset carries its texture as a bin. That texture reaches the
 * document as an embedded file under a uid the preset cannot know, so the file
 * is found back by hash and the preset is compared holding the uid the current
 * settings actually carry.
 */
export function findMatchingBrushPresetUid({
	brushSettings,
	builtinPresets,
	persistedPresets,
	documentFiles,
}: {
	brushSettings: BrushSettings;
	builtinPresets: readonly BrushPreset[];
	persistedPresets: readonly PersistedBrushPreset[];
	documentFiles: readonly EmbeddedFile[];
}): string | null {
	const current = comparableBrushSettings(brushSettings);

	const persisted = persistedPresets.find((preset) => {
		const textureFile = documentFiles.find(
			(file) => file.hash === preset.textureHash,
		);
		if (!textureFile) return false;
		return (
			comparableBrushSettings(
				withTextureFileUid(preset.defaultSettings, textureFile.uid),
			) === current
		);
	});
	if (persisted) return persisted.uid;

	return (
		builtinPresets.find(
			(preset) => comparableBrushSettings(preset.settings) === current,
		)?.uid ?? null
	);
}

/** A brush reduced to what makes it one preset rather than another. */
function comparableBrushSettings(settings: BrushSettings): string {
	return stableStringify(
		withoutStoredBrushSize({ ...settings, randomSeed: 0 }),
	);
}

/** JSON with object keys in a fixed order, so two equal brushes built in a
 *  different order still produce the same string. */
function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value)
			.filter(([, entryValue]) => entryValue !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : 1))
			.map(([key, entryValue]) => `${key}:${stableStringify(entryValue)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
