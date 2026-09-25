import type { Document } from "../../schema";
import type { Migration } from "./index";

/**
 * Ensure every document has an explicit `defs` map for off-canvas ArtObject
 * definitions (patterns / vector brushes). Older documents simply lack the
 * field, so initializing to `{}` keeps def-aware code paths from special-casing
 * absent maps.
 */
export const migDefs: Migration = {
	version: 20260617,
	migrate(doc: Document): void {
		doc.defs ??= {};
	},
};
