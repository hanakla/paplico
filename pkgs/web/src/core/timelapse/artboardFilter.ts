import { type Artboard, getArtboardBounds } from "../schema";
import type { TimelapseIndex } from "./types";

/**
 * Entry indices worth rendering for the given artboard.
 *
 * Filtering runs entirely on the recorded dirty rects, so nothing here touches
 * Yjs. Entries left out still have to be applied to the replay document — only
 * their document rebuild and their frame are skipped.
 *
 * Without an index, or without a target artboard, every entry is selected.
 */
export function selectEntriesForArtboard(
	entryCount: number,
	index: TimelapseIndex | undefined,
	artboard: Artboard | undefined,
): number[] {
	if (!index || !artboard) {
		return Array.from({ length: entryCount }, (_, i) => i);
	}

	const { minX, minY, maxX, maxY } = getArtboardBounds(artboard);
	const { rects } = index;
	const visible: number[] = [];

	for (let i = 0; i < entryCount; i++) {
		const rect = rects[i];
		// A missing rect means the affected area is unknown — never skip it.
		if (
			!rect ||
			(rect[0] <= maxX && rect[2] >= minX && rect[1] <= maxY && rect[3] >= minY)
		) {
			visible.push(i);
		}
	}

	return visible;
}
