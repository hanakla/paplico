import { type Document, isBlend } from "../../schema";
import type { Migration } from "./index";

/**
 * Fill the blend easings with linear, which keeps the even distribution
 * blends were drawn with before easing existed.
 */
export const migBlendEasing: Migration = {
	version: 20260921,
	migrate(doc: Document): void {
		for (const element of Object.values(doc.objects)) {
			if (!isBlend(element)) continue;
			element.placementEasing ??= { type: "linear" };
			element.appearanceEasing ??= { type: "linear" };
		}
	},
};
