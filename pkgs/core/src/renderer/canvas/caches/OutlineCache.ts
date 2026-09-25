/** Axis-aligned bounds in element-local space: minX, minY, maxX, maxY. */
export type LocalBounds = [number, number, number, number];

interface OutlineEntryBase {
	geometryHash: number;
	/** Scale bucket the flattening tolerance was chosen for. */
	scaleBucket: number;
	localBounds: LocalBounds;
}

export interface FillOutline extends OutlineEntryBase {
	kind: "fill";
	/** Closed polylines as [x, y, ...]; subpath `i` spans points `[subpathOffsets[i], subpathOffsets[i + 1])`. */
	points: Float32Array;
	subpathOffsets: Int32Array;
}

export interface StrokeOutline extends OutlineEntryBase {
	kind: "stroke";
	/** Body triangles as [x, y, ...], 3 vertices each. */
	triangles: Float32Array;
	/** Per-vertex (t, u) gradient params aligned with `triangles`, when requested. */
	params: Float32Array | null;
}

export type OutlineEntry = FillOutline | StrokeOutline;

/**
 * Caches an element's device-independent outline — flattened fill polylines
 * or stroke body triangles in local space — per (element, variant). Entries
 * self-validate through geometryHash and the scale bucket, so zooming within
 * a bucket and every pan reuse them; only the strip stage depends on the
 * pass. One element can hold several variants (pre-filter uids, several
 * stroke appearances), capped per element and evicted oldest-first.
 */
export class OutlineCache {
	private static readonly MAX_ENTRIES_PER_ELEMENT = 6;

	private cache = new Map<string, Map<string, OutlineEntry>>();

	public get(elementId: string, variantKey: string): OutlineEntry | undefined {
		return this.cache.get(elementId)?.get(variantKey);
	}

	public set(elementId: string, variantKey: string, entry: OutlineEntry): void {
		const entries = this.cache.get(elementId) ?? new Map();
		entries.delete(variantKey);
		entries.set(variantKey, entry);
		while (entries.size > OutlineCache.MAX_ENTRIES_PER_ELEMENT) {
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
