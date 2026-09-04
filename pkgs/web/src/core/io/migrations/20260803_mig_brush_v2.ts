import type { Document } from "../../schema";
import { migrateBrushSettingsToV2 } from "./brushV2/convert";
import type { Migration } from "./index";

/**
 * Brush engine v2: convert every stored brush settings value (element stroke
 * appearances and document presets) into BrushSettings.
 *
 * papf does not persist schemaVersion, so this runs on every load and must be
 * idempotent — migrateBrushSettingsToV2 returns v2 input unchanged.
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
				params.brushSettings = migrateBrushSettingsToV2(params.brushSettings, {
					fullCoverageFlow: true,
				});
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
			preset.settings = migrateBrushSettingsToV2(source);
			delete legacy.defaultSettings;
			delete legacy.textureFileUid;
		}
	},
};
