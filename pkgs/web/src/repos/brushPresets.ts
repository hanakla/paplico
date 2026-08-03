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
	/** Full brush settings union. The texture is stored separately as a bin. */
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
		defaultSettings: deepClone(defaultSettings),
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
