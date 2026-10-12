import { type Document, normalizeAppearanceFields } from "../../schema";
import type { Migration } from "./index";

/**
 * Backfill opacity and blendMode on every Appearance (fill/stroke/content
 * and their sub-filters).  These fields are now required on the Appearance
 * interface; documents saved before this migration may omit them.
 */
export const migAppearanceOpacityBlendMode: Migration = {
	version: 20260301,
	migrate(doc: Document): void {
		for (const element of Object.values(doc.objects)) {
			if (!element.filters) continue;
			normalizeAppearanceFields(element.filters);
		}
	},
};
