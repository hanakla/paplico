import type { Document } from "../../schema";
import type { Migration } from "./index";

/**
 * Ensure every document has an explicit color profile settings object.
 * Old documents default to the display-p3 working space.
 */
export const migColorProfile: Migration = {
	version: 20260613,
	migrate(doc: Document): void {
		doc.colorProfile ??= { workingSpace: "display-p3" };
	},
};
