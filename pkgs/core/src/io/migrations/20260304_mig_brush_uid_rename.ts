import { localAppearances } from "../../document/appearancePresets";
import type { Document } from "../../schema";
import type { Migration } from "./index";

const UID_MAP: Record<string, string> = {
	"builtin-brush-line": "builtin-brush-hard-circle",
	"builtin-brush-solid": "builtin-brush-soft-circle",
};

/**
 * Rename legacy brush UIDs:
 *   builtin-brush-line  → builtin-brush-hard-circle
 *   builtin-brush-solid → builtin-brush-soft-circle
 *
 * Updates textureFileUid in brush settings and embedded file UIDs.
 */
export const migBrushUidRename: Migration = {
	version: 20260304,
	migrate(doc: Document): void {
		// Rename embedded file UIDs
		for (const file of doc.files ?? []) {
			if (file.uid in UID_MAP) {
				file.uid = UID_MAP[file.uid];
			}
		}

		// Rename textureFileUid in brush settings on every element
		for (const element of Object.values(doc.objects)) {
			if (!element.filters) continue;

			for (const filter of localAppearances(element.filters)) {
				const params = filter.paramData?.params as Record<string, any>;
				if (!params?.brushSettings?.textureFileUid) continue;

				const mapped = UID_MAP[params.brushSettings.textureFileUid];
				if (mapped) params.brushSettings.textureFileUid = mapped;
			}
		}

		// Rename textureFileUid in document-level brush presets
		// (legacy presets stored a flat `textureFileUid`).
		for (const preset of doc.brushPresets ?? []) {
			const legacy = preset as unknown as { textureFileUid?: string };
			if (legacy.textureFileUid != null && legacy.textureFileUid in UID_MAP) {
				legacy.textureFileUid = UID_MAP[legacy.textureFileUid];
			}
			if (preset.uid in UID_MAP) {
				preset.uid = UID_MAP[preset.uid];
			}
		}
	},
};
