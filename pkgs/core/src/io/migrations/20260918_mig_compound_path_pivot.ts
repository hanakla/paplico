import {
	type AnyArtObject,
	type CompoundPath,
	type Document,
	isCompoundPath,
} from "../../schema";
import {
	calculateElementBounds,
	calculateLocalElementBounds,
} from "../../utils/geometry/bounds";
import { transformLinearMatrix } from "../../utils/geometry/geometry";
import type { Migration } from "./index";

/**
 * Files older than this version pivot a compound path on the center of its
 * sources' bounds union rather than on its boolean result. Shift the
 * translation of every compound path so it stays where it was drawn.
 */
export const migCompoundPathPivot: Migration = {
	version: 20260918,
	migrate(doc: Document): void {
		const elementsMap = new Map(Object.entries(doc.objects));
		for (const element of elementsMap.values()) {
			if (!isCompoundPath(element) || !element.transform) continue;

			const legacy = legacySourceUnionCenter(element, elementsMap);
			if (!legacy) continue;
			const bounds = calculateLocalElementBounds(element, elementsMap);
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

function legacySourceUnionCenter(
	compound: CompoundPath,
	elementsMap: ReadonlyMap<string, AnyArtObject>,
): { x: number; y: number } | null {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const { id } of compound.sources) {
		const source = elementsMap.get(id);
		if (!source) continue;
		const b = calculateElementBounds(source, elementsMap);
		minX = Math.min(minX, b.minX);
		minY = Math.min(minY, b.minY);
		maxX = Math.max(maxX, b.maxX);
		maxY = Math.max(maxY, b.maxY);
	}
	if (minX === Number.POSITIVE_INFINITY) return null;
	return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}
