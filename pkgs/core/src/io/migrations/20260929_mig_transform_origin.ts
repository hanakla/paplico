import type { Document } from "../../schema";
import type { MigrationContext } from "./context";
import type { Migration } from "./index";
import { convertLegacyPlacements } from "./legacyPlacement";

/**
 * Files older than this version turned every element around a pivot of its
 * own, the centre of its bounds for most types, and turned a group's
 * children each around their own pivot. A transform is now a matrix on the
 * element's local origin, so the pivots are folded into every element's
 * translation to keep it drawn where it was.
 */
export const migTransformOrigin: Migration = {
	version: 20260929,
	wholeDocument: true,
	migrate(doc: Document, context?: MigrationContext): void {
		const converted = convertLegacyPlacements(doc.objects, "result", context);
		for (const [id, transform] of converted) {
			doc.objects[id].transform = transform;
		}
	},
};
