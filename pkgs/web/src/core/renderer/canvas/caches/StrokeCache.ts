import type { GeometryHandle } from "../pipeline/GeometryStore";

interface StrokeCacheEntry {
	gpuData: Float32Array;
	vertexCount: number;
	geometryHash: number;
	/** Hash of strokeColor to detect color/gradient changes without re-tessellation. */
	strokeColorHash: number;
	gradientBounds: [number, number, number, number] | null;
	/** Solid strokes' lease in the shared GeometryStore (null for gradients,
	 *  which keep gpuData and render through the gradient pipeline). */
	geometry: GeometryHandle | null;
	transformIndex: number;
}

/**
 * Caches GPU-ready stroke tessellation vertex data per element + variant.
 * Variant keys follow the format "<elementId>[:preFilterUIDs]:stroke[:appearanceUID:subFilterUIDs]:<paintKey>".
 *
 * Vertices bake the resolved paint (solid RGBA × alphaMultiplier, or just
 * alphaMultiplier for gradients), so entries are keyed by that paint on top of
 * the geometry variant — without it, changing an appearance's opacity reuses
 * vertices still carrying the previous alpha, and the change never appears.
 * One element can hold several paints (two stroke appearances, an opacity
 * being dragged), so entries are capped per element and evicted oldest-first.
 * Each entry additionally self-validates via geometryHash / strokeColorHash /
 * transformIndex.
 */
export class StrokeCache {
	private static readonly MAX_ENTRIES_PER_ELEMENT = 6;

	private cache = new Map<string, Map<string, StrokeCacheEntry>>();

	public get(
		elementId: string,
		variantKey: string,
	): StrokeCacheEntry | undefined {
		return this.cache.get(elementId)?.get(variantKey);
	}

	public set(
		elementId: string,
		variantKey: string,
		entry: StrokeCacheEntry,
	): void {
		const entries = this.cache.get(elementId) ?? new Map();
		this.destroyEntry(entries.get(variantKey));
		entries.delete(variantKey);
		entries.set(variantKey, entry);
		while (entries.size > StrokeCache.MAX_ENTRIES_PER_ELEMENT) {
			const oldest = entries.keys().next().value as string;
			this.destroyEntry(entries.get(oldest));
			entries.delete(oldest);
		}
		this.cache.set(elementId, entries);
	}

	public delete(elementId: string): boolean {
		const entries = this.cache.get(elementId);
		if (entries) {
			for (const entry of entries.values()) this.destroyEntry(entry);
		}
		return this.cache.delete(elementId);
	}

	public deleteMany(ids: readonly string[]): void {
		for (const id of ids) this.delete(id);
	}

	public clear(): void {
		for (const entries of this.cache.values()) {
			for (const entry of entries.values()) this.destroyEntry(entry);
		}
		this.cache.clear();
	}

	public keys(): MapIterator<string> {
		return this.cache.keys();
	}

	private destroyEntry(entry: StrokeCacheEntry | undefined): void {
		if (!entry) return;
		// Release is deferred inside the store until its frame-boundary flush,
		// so in-flight draws keep their vertices.
		entry.geometry?.release();
	}
}
