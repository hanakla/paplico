import type { ClipRect, StripBatch } from "../../geometry/strips/stripTypes";

/** Which pass family an entry was rasterized for; mask passes get their own. */
export type StripCacheVariant = "normal" | "mask";

/**
 * Everything the strips of one entry depend on besides the outline itself:
 * the linear part of the local → device transform, the sub-pixel phase of its
 * translation, and whether per-pixel params were rasterized.
 */
export interface StripRasterKey {
	geometryHash: number;
	scaleBucket: number;
	a: number;
	b: number;
	c: number;
	d: number;
	/** Fractional device translation, quantized to 1/256 px. */
	fracX: number;
	fracY: number;
	paramsMode: number;
}

interface StripCacheEntry {
	key: StripRasterKey;
	/**
	 * Anchor-relative rect the batch is valid for; a pass inside it reuses
	 * the batch. The anchor is the integer part of the outline's device
	 * translation, so it moves with the geometry.
	 */
	coverage: ClipRect;
	batch: StripBatch;
}

/**
 * Caches rasterized strips per (element, variant). Strips live in
 * anchor-relative device pixels, so a pan by whole texels only moves the
 * anchor; a zoom, rotation, transform edit or sub-pixel pan changes the key
 * and regenerates. Paint is applied per instance and is not part of the key.
 *
 * One element can be drawn into several passes per frame, each with its own
 * sub-pixel phase, so a variant holds several entries and a lookup picks the
 * one rasterized for the pass. Entries do not depend on the pass size: passes
 * of any size share an entry whose key and coverage fit them.
 */
export class StripCache {
	private static readonly MAX_ENTRIES_PER_ELEMENT = 6;

	/** Entries per element, least recently used first. */
	private cache = new Map<
		string,
		{ variantKey: string; entry: StripCacheEntry }[]
	>();

	/**
	 * The entry rasterized for `key` whose coverage holds `passRect`, marked as
	 * most recently used.
	 */
	public find(
		elementId: string,
		variantKey: string,
		key: StripRasterKey,
		passRect: ClipRect,
	): StripCacheEntry | undefined {
		const entries = this.cache.get(elementId);
		if (!entries) return undefined;
		const index = entries.findIndex(
			(slot) =>
				slot.variantKey === variantKey &&
				stripRasterKeyEquals(slot.entry.key, key) &&
				rectContains(slot.entry.coverage, passRect),
		);
		if (index < 0) return undefined;
		const [slot] = entries.splice(index, 1);
		entries.push(slot);
		return slot.entry;
	}

	public set(
		elementId: string,
		variantKey: string,
		entry: StripCacheEntry,
	): void {
		const entries = this.cache.get(elementId) ?? [];
		entries.push({ variantKey, entry });
		if (entries.length > StripCache.MAX_ENTRIES_PER_ELEMENT) entries.shift();
		this.cache.set(elementId, entries);
	}

	public delete(elementId: string): boolean {
		return this.cache.delete(elementId);
	}

	public deleteMany(ids: readonly string[]): void {
		for (const id of ids) this.delete(id);
	}

	public clear(): void {
		this.cache.clear();
	}

	public keys(): MapIterator<string> {
		return this.cache.keys();
	}
}

function stripRasterKeyEquals(a: StripRasterKey, b: StripRasterKey): boolean {
	return (
		a.geometryHash === b.geometryHash &&
		a.scaleBucket === b.scaleBucket &&
		a.a === b.a &&
		a.b === b.b &&
		a.c === b.c &&
		a.d === b.d &&
		a.fracX === b.fracX &&
		a.fracY === b.fracY &&
		a.paramsMode === b.paramsMode
	);
}

function rectContains(outer: ClipRect, inner: ClipRect): boolean {
	return (
		inner.x0 >= outer.x0 &&
		inner.y0 >= outer.y0 &&
		inner.x1 <= outer.x1 &&
		inner.y1 <= outer.y1
	);
}
