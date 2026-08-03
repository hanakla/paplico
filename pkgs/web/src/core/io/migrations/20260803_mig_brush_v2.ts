import { normalizeBrushSettingsV2 } from "../../brush/migrate";
import type { BrushSettings, Document } from "../../schema";
import type { Migration } from "./index";

/**
 * Brush engine v2: convert every stored brush settings value (element stroke
 * appearances and document presets) into BrushSettingsV2.
 *
 * papf does not persist schemaVersion, so this runs on every load and must be
 * idempotent — normalizeBrushSettingsV2 returns v2 input unchanged. Wet ink
 * settings are preserved verbatim in `wetV1` (the wet switchover migration,
 * keyed on wetV1 presence, performs the final conversion later).
 */
export const migBrushV2: Migration = {
	version: 20260803,
	migrate(doc: Document): void {
		for (const element of Object.values(doc.objects)) {
			if (!element.filters) continue;
			for (const filter of element.filters) {
				const params = filter.paramData?.params as
					| Record<string, unknown>
					| undefined;
				if (filter.processor !== "stroke" || !params?.brushSettings) continue;
				params.brushSettings = normalizeBrushSettingsV2(params.brushSettings);
			}
		}

		for (const preset of doc.brushPresets ?? []) {
			const legacy = preset as unknown as {
				settings?: unknown;
				defaultSettings?: Record<string, unknown>;
				textureFileUid?: string;
			};
			const source =
				legacy.settings ??
				({
					...(legacy.defaultSettings ?? {}),
					...(legacy.textureFileUid != null
						? { textureFileUid: legacy.textureFileUid }
						: {}),
				} as Record<string, unknown>);
			// Boundary cast: stored data moves to v2 ahead of the declared type.
			// BrushPreset.settings switches to BrushSettingsV2 in the phase 1
			// runtime switchover; until then this migration is unregistered.
			preset.settings = normalizeBrushSettingsV2(
				source,
			) as unknown as BrushSettings;
			delete legacy.defaultSettings;
			delete legacy.textureFileUid;
		}
	},
};
