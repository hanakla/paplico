import type { Document } from "../../schema";
import type { Migration } from "./index";

/**
 * Ensure every document has an explicit filter rasterization DPI.
 * Old documents default to 72 (1 texel per world px).
 */
export const migRasterizationDpi: Migration = {
	version: 20260705,
	migrate(doc: Document): void {
		doc.rasterizationDpi ??= 72;
	},
};
