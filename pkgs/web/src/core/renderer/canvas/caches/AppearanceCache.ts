/**
 * Opaque cache entry produced by an appearance handler. The stored payload
 * (GPU buffers etc.) is the handler's concern; the engine only drives the
 * lifecycle (eviction, document-change pruning, teardown).
 */
export interface AppearanceCacheEntry {
	/** Content hash computed by the owning appearance handler; the engine only compares it. */
	hash: string;
	/** Releases GPU resources. Called by the engine on eviction/clear. */
	destroy(): void;
}

/**
 * Engine-generic cache for per-element appearance intermediates (e.g. GPU
 * buffers built by an extrude appearance). Keys are
 * `${elementId}::${appearanceUid}`, so RenderCacheManager's base-id liveness
 * pruning applies to them as-is.
 */
export class AppearanceCache {
	private cache = new Map<string, AppearanceCacheEntry>();
	private pendingDestroy: AppearanceCacheEntry[] = [];
	/** Last live instance count seen per `elementId::baseUid`, so a steady
	 *  frame costs a lookup instead of a scan. See pruneInstances. */
	private instanceCounts = new Map<string, number>();

	public get(
		elementId: string,
		appearanceUid: string,
	): AppearanceCacheEntry | undefined {
		return this.cache.get(cacheKey(elementId, appearanceUid));
	}

	public set(
		elementId: string,
		appearanceUid: string,
		entry: AppearanceCacheEntry,
	): void {
		const key = cacheKey(elementId, appearanceUid);
		this.deferDestroy(this.cache.get(key));
		this.cache.set(key, entry);
	}

	/** @param key - Full internal key as yielded by keys(). */
	public delete(key: string): void {
		this.deferDestroy(this.cache.get(key));
		this.cache.delete(key);
	}

	/** Drop one element's entry for a single appearance uid. */
	public deleteEntry(elementId: string, appearanceUid: string): void {
		this.delete(cacheKey(elementId, appearanceUid));
	}

	/**
	 * Drop the entries an element's per-instance appearances left behind when
	 * their count shrank.
	 *
	 * A blend bakes one solid — and one shadow — PER interpolated instance, each
	 * under a synthetic `<baseUid>:instance-<n>` appearance uid. Lowering the
	 * blend's step count simply stops asking for the high indices, and the
	 * engine's stale-entry pruning only checks whether the ELEMENT is still
	 * alive, so those GPU textures would sit in the cache until the element was
	 * deleted. Call this with the instance count that is actually live.
	 *
	 * Producers call this every frame, so the steady state must be free: the
	 * last count is remembered per appearance and only a DECREASE walks the
	 * indices that disappeared. The whole cache is scanned once — the first
	 * time an appearance is seen — to catch instances that predate the
	 * bookkeeping.
	 */
	public pruneInstances(
		elementId: string,
		baseUid: string,
		liveCount: number,
	): void {
		const countKey = cacheKey(elementId, baseUid);
		const previous = this.instanceCounts.get(countKey);
		this.instanceCounts.set(countKey, liveCount);
		if (previous === undefined) {
			const prefix = `${countKey}${INSTANCE_SEPARATOR}`;
			for (const key of [...this.cache.keys()]) {
				if (!key.startsWith(prefix)) continue;
				const index = Number(key.slice(prefix.length));
				if (Number.isInteger(index) && index >= liveCount) this.delete(key);
			}
			return;
		}
		for (let index = liveCount; index < previous; index++) {
			this.delete(cacheKey(elementId, instanceAppearanceUid(baseUid, index)));
		}
	}

	public deleteMany(keys: readonly string[]): void {
		for (const key of keys) this.delete(key);
	}

	public keys(): IterableIterator<string> {
		return this.cache.keys();
	}

	public clear(): void {
		for (const entry of this.cache.values()) this.deferDestroy(entry);
		this.cache.clear();
		this.instanceCounts.clear();
		this.flushPendingDestroy();
	}

	/**
	 * Destroy entries evicted by set/delete/deleteMany. Must be called once per
	 * frame AFTER the previous frame's queue.submit() has completed, so
	 * in-flight command buffers no longer reference their GPU resources.
	 * Destroying synchronously on eviction is unsafe: a set() while the frame's
	 * encoder is still recording would destroy resources an earlier draw in the
	 * same encoder already referenced (same rationale as StencilFillCache).
	 */
	public flushPendingDestroy(): void {
		for (const entry of this.pendingDestroy) entry.destroy();
		this.pendingDestroy.length = 0;
	}

	private deferDestroy(entry: AppearanceCacheEntry | undefined): void {
		if (!entry) return;
		this.pendingDestroy.push(entry);
	}
}

function cacheKey(elementId: string, appearanceUid: string): string {
	return `${elementId}::${appearanceUid}`;
}

/**
 * Separator between a per-instance appearance's base uid and its instance
 * index. Every producer of instance-scoped appearance uids must build them
 * with `instanceAppearanceUid` so `pruneInstances` can find them again.
 */
const INSTANCE_SEPARATOR = ":instance-";

/** The appearance uid one interpolated instance of a blend renders under. */
export function instanceAppearanceUid(baseUid: string, index: number): string {
	return `${baseUid}${INSTANCE_SEPARATOR}${index}`;
}
