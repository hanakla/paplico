import type { ChangedElements } from "./types";

/** A ChangedElements whose sets can still grow. */
export interface ChangedElementsAccumulator {
	upserted: Set<string>;
	deleted: Set<string>;
}

export function emptyChanges(): ChangedElementsAccumulator {
	return { upserted: new Set(), deleted: new Set() };
}

/**
 * Fold a later change set into `acc`. The latest change to an id wins, so an
 * element deleted and then re-added reads as upserted, and vice versa.
 */
export function accumulateChanges(
	acc: ChangedElementsAccumulator,
	changes: ChangedElements,
): void {
	for (const id of changes.upserted) {
		acc.deleted.delete(id);
		acc.upserted.add(id);
	}
	for (const id of changes.deleted) {
		acc.upserted.delete(id);
		acc.deleted.add(id);
	}
}
