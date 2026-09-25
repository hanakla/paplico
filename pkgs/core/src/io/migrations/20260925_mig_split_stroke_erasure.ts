import type { Document } from "../../schema";
import type { Migration } from "./index";

/**
 * Move the eraser's cuts out of strokeWidths into strokeErasure. A profile
 * that was not baked from the brush's size curves came from the eraser or a
 * hand edit, and renderers drew it as a cut, so it keeps drawing the same as
 * an erasure. Baked profiles stay widths.
 */
export const migSplitStrokeErasure: Migration = {
	version: 20260925,
	migrate(doc: Document): void {
		for (const element of Object.values(doc.objects)) {
			if (element?.type !== "path") continue;
			if (!element.strokeWidths?.length || element.strokeWidthsBaked) continue;

			element.strokeErasure = element.strokeWidths;
			delete element.strokeWidths;
		}
	},
};
