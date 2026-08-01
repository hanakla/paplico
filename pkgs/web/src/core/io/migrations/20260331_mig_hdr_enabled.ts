import type { Document } from "../../schema";
import type { Migration } from "./index";

/**
 * Ensure every document has an explicit hdr settings object.
 * Old documents default to SDR (enabled: false, exposure: 0).
 */
export const migHdrEnabled: Migration = {
	version: 20260331,
	migrate(doc: Document): void {
		doc.hdr ??= { enabled: false, exposure: 0 };
	},
};
