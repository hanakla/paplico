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
 */
export class StripCache {
	private static readonly MAX_ENTRIES_PER_ELEMENT = 6;

	private cache = new Map<string, Map<string, StripCacheEntry>>();

	public get(
		elementId: string,
		variantKey: string,
	): StripCacheEntry | undefined {
		return this.cache.get(elementId)?.get(variantKey);
	}

	public set(
		elementId: string,
		variantKey: string,
		entry: StripCacheEntry,
	): void {
		const entries = this.cache.get(elementId) ?? new Map();
		entries.delete(variantKey);
		entries.set(variantKey, entry);
		while (entries.size > StripCache.MAX_ENTRIES_PER_ELEMENT) {
			entries.delete(entries.keys().next().value as string);
		}
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

export function stripRasterKeyEquals(
	a: StripRasterKey,
	b: StripRasterKey,
): boolean {
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
