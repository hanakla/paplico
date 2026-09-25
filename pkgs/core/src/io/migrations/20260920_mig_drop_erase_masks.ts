import type { Document } from "../../schema";
import type { Migration } from "./index";

/**
 * Drop the erase masks paths used to carry. Nothing renders them anymore, so
 * keeping them would only carry dead data through every save.
 */
export const migDropEraseMasks: Migration = {
	version: 20260920,
	migrate(doc: Document): void {
		for (const element of Object.values(doc.objects)) {
			delete (element as { eraseMasks?: unknown }).eraseMasks;
		}
	},
};
