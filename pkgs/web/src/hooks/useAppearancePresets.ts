import { useState } from "react";
import { usePaplico } from "@/contexts/PaplicoContext";
import type { AppearancePreset } from "@/core/schema";
import { deepClone } from "@/core/utils/lang";
import {
	parseAppearancePresetJson,
	serializeAppearancePresetJson,
} from "@/infra/appearancePresetJson";
import { FileSystem } from "@/infra/filesystem";
import {
	appearancePresetsRepo,
	createPersistedAppearancePreset,
	isPortableAppearancePreset,
	type PersistedAppearancePreset,
	toDocumentAppearancePreset,
} from "@/repos/appearancePresets";
import { useAsyncEffect, useEventCallback } from "@/utils/hooks";

/** App-wide appearance preset library plus JSON file import / export. */
export function useAppearancePresets() {
	const { commands } = usePaplico();
	const [persistedPresets, setPersistedPresets] = useState<
		PersistedAppearancePreset[]
	>([]);

	const refresh = useEventCallback(async () => {
		setPersistedPresets(await appearancePresetsRepo.list());
	});

	useAsyncEffect(async () => {
		await refresh();
	}, []);

	/** Returns false when the preset depends on document-local files or defs. */
	const saveToLibrary = useEventCallback(async (preset: AppearancePreset) => {
		if (!isPortableAppearancePreset(preset)) return false;
		await appearancePresetsRepo.save(createPersistedAppearancePreset(preset));
		await refresh();
		return true;
	});

	/** Copies a library preset into the document and returns the document uid. */
	const addToDocument = useEventCallback((libraryUid: string) => {
		const preset = persistedPresets.find((p) => p.uid === libraryUid);
		if (!preset) return null;
		return commands.addAppearancePreset(toDocumentAppearancePreset(preset));
	});

	/**
	 * Writes a document preset's name and filters back to its library entry.
	 * Presets edited in the panel keep their library uid, so this is what keeps
	 * the library from going stale while one of them is being edited.
	 */
	const updateInLibrary = useEventCallback(async (preset: AppearancePreset) => {
		const existing = persistedPresets.find((p) => p.uid === preset.uid);
		if (!existing || !isPortableAppearancePreset(preset)) return;
		if (
			existing.name === preset.name &&
			JSON.stringify(existing.filters) === JSON.stringify(preset.filters)
		) {
			return;
		}
		await appearancePresetsRepo.save({
			...existing,
			name: preset.name,
			filters: deepClone(preset.filters),
		});
		await refresh();
	});

	const renameInLibrary = useEventCallback(
		async (libraryUid: string, name: string) => {
			await appearancePresetsRepo.rename(libraryUid, name);
			await refresh();
		},
	);

	const deleteFromLibrary = useEventCallback(async (libraryUid: string) => {
		await appearancePresetsRepo.delete(libraryUid);
		await refresh();
	});

	const exportPresetJson = useEventCallback(
		async (preset: AppearancePreset) => {
			if (!isPortableAppearancePreset(preset)) return false;
			const blob = new Blob([serializeAppearancePresetJson(preset)], {
				type: "application/json",
			});
			await FileSystem.exportFile(
				blob,
				`${preset.name || "appearance-preset"}.json`,
			);
			return true;
		},
	);

	/** Adds the chosen file's preset to the document. Throws on an invalid file. */
	const importPresetJson = useEventCallback(async () => {
		const handle = await FileSystem.openFileDialog({
			id: "appearance-preset-import",
			types: [
				{
					description: "Paplico Appearance Preset",
					accept: { "application/json": [".json"] },
				},
			],
		});
		if (!handle) return null;
		const preset = parseAppearancePresetJson(await handle.file.text());
		return commands.addAppearancePreset(preset);
	});

	return {
		persistedPresets,
		saveToLibrary,
		updateInLibrary,
		addToDocument,
		renameInLibrary,
		deleteFromLibrary,
		exportPresetJson,
		importPresetJson,
	};
}
