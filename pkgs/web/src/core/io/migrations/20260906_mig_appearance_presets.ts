import type { Document } from "../../schema";
import type { Migration } from "./index";

/**
 * Ensure every document has an explicit `appearancePresets` list. Older
 * documents lack the field, so initializing to `[]` keeps preset-aware code
 * paths from special-casing an absent list.
 */
export const migAppearancePresets: Migration = {
	version: 20260906,
	migrate(doc: Document): void {
		doc.appearancePresets ??= [];
	},
};
