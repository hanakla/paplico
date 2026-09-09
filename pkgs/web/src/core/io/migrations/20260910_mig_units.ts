import type { Document } from "../../schema";
import type { Migration } from "./index";

/**
 * Ensure every document carries a display length unit.
 * Documents from before the setting existed showed bare world units, which
 * is what "px" means, so they keep looking the same.
 */
export const migUnits: Migration = {
	version: 20260910,
	migrate(doc: Document): void {
		doc.units ??= "px";
	},
};
