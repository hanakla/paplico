import { type AnyArtObject, type Document, isCompoundPath } from "../../schema";
import { calculateLocalElementBounds } from "../../utils/geometry/bounds";
import { transformLinearMatrix } from "../../utils/geometry/geometry";
import type { Migration } from "./index";
import {
	convertLegacyPlacements,
	legacySourceUnionCenter,
} from "./legacyPlacement";

/**
 * Files older than this version pivot a compound path on the center of its
 * sources' bounds union rather than on its boolean result. Shift the
 * translation of every compound path so it stays where it was drawn.
 */
export const migCompoundPathPivot: Migration = {
	version: 20260918,
	wholeDocument: true,
	migrate(doc: Document): void {
		// The sources are still placed by the legacy rule; the current bounds
		// code reports their legacy extents only once they are re-expressed
		// under the current one.
		const converted = convertLegacyPlacements(
			doc.objects,
			"sources",
			undefined,
		);
		const shadow = new Map<string, AnyArtObject>(Object.entries(doc.objects));
		for (const [id, transform] of converted) {
			shadow.set(id, { ...shadow.get(id)!, transform });
		}
		for (const element of Object.values(doc.objects)) {
			if (!isCompoundPath(element) || !element.transform) continue;

			const legacy = legacySourceUnionCenter(element, shadow);
			if (!legacy) continue;
			const bounds = calculateLocalElementBounds(element, shadow);
			const dx = legacy.x - (bounds.minX + bounds.maxX) / 2;
			const dy = legacy.y - (bounds.minY + bounds.maxY) / 2;

			// Moving the pivot by -d moves the drawing by (I - M)·(-d), so the
			// translation takes (I - M)·d to cancel it.
			const m = transformLinearMatrix(element.transform);
			element.transform.x += dx - (m.m00 * dx + m.m01 * dy);
			element.transform.y += dy - (m.m10 * dx + m.m11 * dy);
		}
	},
};
