import { collectDocumentLocalRefs } from "@/core/document/appearancePresets";
import type { AppearancePreset } from "@/core/schema";
import { deepClone } from "@/core/utils/lang";
import { tauriAppearancePresetsRepo } from "@/infra/appearancePresetsDB.tauri";
import { webAppearancePresetsRepo } from "@/infra/appearancePresetsDB.web";
import { IS_TAURI_ENV } from "@/utils/platform";

export interface PersistedAppearancePreset extends AppearancePreset {
	createdAt: number;
	updatedAt: number;
}

export interface AppearancePresetsRepo {
	list(): Promise<PersistedAppearancePreset[]>;
	get(uid: string): Promise<PersistedAppearancePreset | null>;
	save(preset: PersistedAppearancePreset): Promise<void>;
	rename(uid: string, name: string): Promise<void>;
	delete(uid: string): Promise<void>;
}

export const appearancePresetsRepo: AppearancePresetsRepo = IS_TAURI_ENV
	? tauriAppearancePresetsRepo
	: webAppearancePresetsRepo;

/**
 * Whether the preset can leave its document. A preset that points at a custom
 * embedded file or a def has nothing to point at in another document.
 */
export function isPortableAppearancePreset(preset: AppearancePreset): boolean {
	const refs = collectDocumentLocalRefs(preset);
	return refs.fileUids.length === 0 && refs.defIds.length === 0;
}

export function createPersistedAppearancePreset(
	preset: AppearancePreset,
	now = Date.now(),
): PersistedAppearancePreset {
	return {
		uid: preset.uid,
		name: preset.name,
		filters: deepClone(preset.filters),
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * Document copy of a library preset. The uid is shared with the library so
 * adding the same library preset twice reuses the document's copy instead of
 * growing the list.
 */
export function toDocumentAppearancePreset(
	preset: PersistedAppearancePreset,
): AppearancePreset {
	return {
		uid: preset.uid,
		name: preset.name,
		filters: deepClone(preset.filters),
	};
}

export function clonePersistedAppearancePreset(
	preset: PersistedAppearancePreset,
): PersistedAppearancePreset {
	return { ...preset, filters: deepClone(preset.filters) };
}
