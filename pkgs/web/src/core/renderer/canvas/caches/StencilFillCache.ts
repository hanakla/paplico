import type { GeometryHandle } from "../pipeline/GeometryStore";

interface StencilFillCacheEntry {
	/** Fan triangles' lease in the shared GeometryStore. */
	fanGeometry: GeometryHandle;
	fanVertexCount: number;
	/** AA fringe's lease (null when the path produced no fringe). */
	fringeGeometry: GeometryHandle | null;
	fringeData: Float32Array;
	fringeVertexCount: number;
	bounds: [number, number, number, number];
	isSolidFill: boolean;
	transformIndex: number;
	geometryHash: number;
}

export type StencilFillVariant = "normal" | "mask";

/**
 * Caches pre-computed stencil fill vertex data (fan triangles + AA fringe)
 * per element. Fringe vertices bake the resolved paint (solid RGBA ×
 * alphaMultiplier), so entries are additionally keyed by a paint key — one
 * element painted by several fills (e.g. a text glyph's intrinsic color plus
 * a fill appearance) holds one entry per paint, oldest-first evicted past a
 * small cap. Each entry stores a fingerprint (transformIndex + geometryHash)
 * for self-validation at cache-hit time. Vertices live in the shared
 * GeometryStore; eviction releases the leases, and the store itself defers
 * reusing the ranges until its frame-boundary flush — so re-rendering the
 * same element twice in one encoder (editing-group dim overlay) never
 * invalidates data an earlier draw already recorded.
 */
export class StencilFillCache {
	private static readonly MAX_ENTRIES_PER_ELEMENT = 6;

	private cache = new Map<string, Map<string, StencilFillCacheEntry>>();

	public get(
		elementId: string,
		variant: StencilFillVariant,
		paintKey: string,
	): StencilFillCacheEntry | undefined {
		return this.cache.get(elementId)?.get(`${variant}:${paintKey}`);
	}

	public set(
		elementId: string,
		variant: StencilFillVariant,
		paintKey: string,
		entry: StencilFillCacheEntry,
	): void {
		const key = `${variant}:${paintKey}`;
		const entries = this.cache.get(elementId) ?? new Map();
		this.destroyEntry(entries.get(key));
		entries.delete(key);
		entries.set(key, entry);
		while (entries.size > StencilFillCache.MAX_ENTRIES_PER_ELEMENT) {
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

	public clear(): void {
		for (const entries of this.cache.values()) {
			for (const entry of entries.values()) this.destroyEntry(entry);
		}
		this.cache.clear();
	}

	public deleteMany(ids: readonly string[]): void {
		for (const id of ids) this.delete(id);
	}

	public keys(): MapIterator<string> {
		return this.cache.keys();
	}

	private destroyEntry(entry: StencilFillCacheEntry | undefined): void {
		if (!entry) return;
		entry.fanGeometry.release();
		entry.fringeGeometry?.release();
	}
}
