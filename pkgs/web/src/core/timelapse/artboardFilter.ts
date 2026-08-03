import * as Y from "yjs";
import type { Artboard, Document } from "../schema";
import {
	boundsIntersect,
	calculateElementBounds,
} from "../utils/geometry/bounds";

/**
 * Extract changed object IDs from a Yjs update.
 * Creates temporary documents to compare before/after state.
 */
export function extractChangedObjectIds(
	update: Uint8Array,
	currentDoc: Y.Doc,
): string[] {
	const changedIds = new Set<string>();

	// Create a copy of current state (before the update)
	const tempBefore = new Y.Doc();
	Y.applyUpdate(tempBefore, Y.encodeStateAsUpdate(currentDoc));

	// Create a copy with the update applied (after the update)
	const tempAfter = new Y.Doc();
	Y.applyUpdate(tempAfter, Y.encodeStateAsUpdate(currentDoc));
	Y.applyUpdate(tempAfter, update);

	const yObjectsBefore = tempBefore.getMap("objects");
	const yObjectsAfter = tempAfter.getMap("objects");

	// Check for added or modified objects
	for (const id of yObjectsAfter.keys()) {
		const before = yObjectsBefore.get(id);
		const after = yObjectsAfter.get(id);
		if (!yObjectsBefore.has(id) || before !== after) {
			changedIds.add(id);
		}
	}

	// Check for deleted objects
	for (const id of yObjectsBefore.keys()) {
		if (!yObjectsAfter.has(id)) {
			changedIds.add(id);
		}
	}

	tempBefore.destroy();
	tempAfter.destroy();

	return Array.from(changedIds);
}

/**
 * Check if any changed object intersects with the target artboard.
 * Returns true if at least one changed object is within the artboard bounds.
 */
export function changedObjectsIntersectArtboard(
	changedIds: string[],
	document: Document,
	artboard: Artboard,
): boolean {
	if (changedIds.length === 0) return false;

	const artboardBounds = {
		minX: artboard.x - artboard.width / 2,
		minY: artboard.y - artboard.height / 2,
		maxX: artboard.x + artboard.width / 2,
		maxY: artboard.y + artboard.height / 2,
		width: artboard.width,
		height: artboard.height,
	};

	const elementsMap = new Map(Object.entries(document.objects));

	for (const id of changedIds) {
		const element = document.objects[id];
		if (!element) continue;

		const elementBounds = calculateElementBounds(element, elementsMap);

		if (boundsIntersect(elementBounds, artboardBounds)) {
			return true;
		}
	}

	return false;
}
