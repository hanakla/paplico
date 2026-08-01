import type { WorldBBox } from "../../../utils/geometry/bounds";
import type { BlitUVRect } from "../CanvasLayerTypes";

/**
 * One cached post-filter bake: the element's full (viewport-independent)
 * textureBounds rendered through its filter chain at a bucketed density.
 * The texture is cache-owned; destruction is deferred to the frame boundary
 * (flushPendingDestroy) like AppearanceCache entries, because an evicted
 * texture may still be referenced by in-flight command buffers.
 */
export interface FilteredElementCacheEntry {
	/** Content hash (chain fingerprint + paint hash + density bucket + size).
	 *  Compared by the caller each frame — the cache itself never validates. */
	hash: string;
	texture: GPUTexture;
	/** World rect the texture covers (the plan's textureBounds at bake time). */
	bounds: WorldBBox;
	/** Crop rect for pool-padding, from the bake's placement. */
	uvRect: BlitUVRect;
	byteSize: number;
}

/**
 * Byte-budgeted LRU over per-element filter results, letting pans and other
 * viewport-only frames reuse a filtered bake instead of re-running the whole
 * filter chain. Keys are plain element ids so RenderCacheManager's stale-id
 * pruning applies as-is.
 */
export class FilteredElementCache {
	private cache = new Map<string, FilteredElementCacheEntry>();
	private pendingDestroy: GPUTexture[] = [];

	public constructor(private readonly maxBytes = 256 * 1024 * 1024) {}

	public get(elementId: string): FilteredElementCacheEntry | undefined {
		const entry = this.cache.get(elementId);
		if (!entry) return undefined;
		// Map iteration order doubles as the LRU order — re-insert to touch.
		this.cache.delete(elementId);
		this.cache.set(elementId, entry);
		return entry;
	}

	/** Insert an entry, evicting over-budget LRU entries — possibly the
	 *  inserted entry itself. Returns whether the entry was retained; a
	 *  non-retained entry's texture is already scheduled for deferred destroy,
	 *  so the caller must not keep using it past the frame. */
	public set(elementId: string, entry: FilteredElementCacheEntry): boolean {
		// An entry that alone dwarfs the budget would immediately evict the
		// whole working set for a single element — reject it outright.
		if (entry.byteSize > this.maxBytes / 4) {
			this.pendingDestroy.push(entry.texture);
			return false;
		}
		this.delete(elementId);
		this.cache.set(elementId, entry);
		this.evictOverBudget();
		return this.cache.has(elementId);
	}

	public deleteMany(ids: readonly string[]): void {
		for (const id of ids) this.delete(id);
	}

	public keys(): MapIterator<string> {
		return this.cache.keys();
	}

	public clear(): void {
		for (const entry of this.cache.values()) {
			this.pendingDestroy.push(entry.texture);
		}
		this.cache.clear();
	}

	/** Destroy evicted textures. Call once per frame after queue.submit(),
	 *  mirroring the AppearanceCache contract. */
	public flushPendingDestroy(): void {
		for (const texture of this.pendingDestroy) texture.destroy();
		this.pendingDestroy.length = 0;
	}

	private delete(id: string): void {
		const entry = this.cache.get(id);
		if (!entry) return;
		this.pendingDestroy.push(entry.texture);
		this.cache.delete(id);
	}

	private evictOverBudget(): void {
		let totalBytes = 0;
		for (const entry of this.cache.values()) totalBytes += entry.byteSize;
		while (totalBytes > this.maxBytes) {
			const oldest = this.cache.entries().next().value;
			if (!oldest) break;
			const [key, entry] = oldest;
			totalBytes -= entry.byteSize;
			this.delete(key);
		}
	}
}
