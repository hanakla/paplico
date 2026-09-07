import type { StampHandle } from "../pipeline/brush/BoundedStampStore";

/** One stroke's evaluated dab instances, ready to upload. */
export interface StampBuffer {
	/** Dab instance floats. Once `residentDab` is attached this is the run
	 *  SHARED with the store's regrow mirror — never mutate it. */
	data: Float32Array;
	count: number;
	/** Lease in the resident dab store; released with the cache entry. */
	residentDab?: { handle: StampHandle };
}

/**
 * Caches per-element dab evaluation results to avoid repeated computation
 * for unchanged strokes. Entries may carry a resident GPU lease; eviction
 * releases it — the store defers reuse to its frame-boundary flush, so
 * in-flight draws stay valid.
 */
export class StampCache {
	private cache = new Map<string, StampBuffer>();
	private readonly owners = new Map<string, string>();
	/** Reverse index of `owners` (each owner holds at most one key, enforced
	 *  by set()), so evicting an owner's previous fingerprint is O(1). */
	private readonly keyByOwner = new Map<string, string>();

	public constructor(private readonly maxBytes = 96 * 1024 * 1024) {}

	public get(elementId: string): StampBuffer | undefined {
		const entry = this.cache.get(elementId);
		if (!entry) return undefined;
		this.cache.delete(elementId);
		this.cache.set(elementId, entry);
		return entry;
	}

	/** Insert an entry, evicting over-budget LRU entries — possibly the
	 *  inserted entry itself when it alone exceeds the budget. Returns whether
	 *  the entry was retained: a non-retained entry must NOT be resident-ized
	 *  afterwards, because no cache entry would own (and eventually release)
	 *  the store leases. */
	public set(elementId: string, entry: StampBuffer, ownerId?: string): boolean {
		const separator = elementId.indexOf(":");
		const owner =
			ownerId ?? (separator < 0 ? elementId : elementId.slice(0, separator));
		// Editing a path yields a NEW composite key (geometry hash / brush
		// fingerprint), so evict the same owner's previous key here — its
		// resident stamp/meta/stops leases would otherwise leak until the
		// element leaves the document.
		const previousKey = this.keyByOwner.get(owner);
		if (previousKey !== undefined && previousKey !== elementId) {
			this.delete(previousKey);
		}
		releaseResident(this.cache.get(elementId));
		this.cache.set(elementId, entry);
		this.owners.set(elementId, owner);
		this.keyByOwner.set(owner, elementId);
		this.evictOverBudget();
		return this.cache.has(elementId);
	}

	/** Re-account an entry after lazy GPU residency was attached. */
	public commitResident(elementId: string): void {
		const entry = this.cache.get(elementId);
		if (!entry) return;
		this.cache.delete(elementId);
		this.cache.set(elementId, entry);
		this.evictOverBudget();
	}

	public clear(): void {
		for (const entry of this.cache.values()) releaseResident(entry);
		this.cache.clear();
		this.owners.clear();
		this.keyByOwner.clear();
	}

	public deleteMany(ids: readonly string[]): void {
		for (const id of ids) this.delete(id);
	}

	public keys(): MapIterator<string> {
		return this.cache.keys();
	}

	private delete(id: string): void {
		releaseResident(this.cache.get(id));
		this.cache.delete(id);
		const owner = this.owners.get(id);
		if (owner !== undefined && this.keyByOwner.get(owner) === id) {
			this.keyByOwner.delete(owner);
		}
		this.owners.delete(id);
	}

	private evictOverBudget(): void {
		let totalBytes = 0;
		for (const entry of this.cache.values()) totalBytes += entryByteSize(entry);
		while (totalBytes > this.maxBytes) {
			const oldest = this.cache.entries().next().value;
			if (!oldest) break;
			const [key, entry] = oldest;
			totalBytes -= entryByteSize(entry);
			this.delete(key);
		}
	}
}

// Helpers

function releaseResident(entry: StampBuffer | undefined): void {
	if (!entry) return;
	if (entry.residentDab) {
		entry.residentDab.handle.release();
		entry.residentDab = undefined;
	}
}

function entryByteSize(entry: StampBuffer): number {
	return entry.data.byteLength;
}
