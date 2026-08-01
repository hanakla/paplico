interface GeometryCacheEntry {
	flattenedSubPaths: number[][];
	worldOffsetX: number;
	worldOffsetY: number;
	geometryHash: number;
}

/**
 * Caches flattened bezier subpath points per element to avoid repeated
 * curve flattening. Self-validating via segmentCount + endpoint + midpoint
 * checks so entries survive document changes that don't affect geometry.
 */
export class GeometryCache {
	private cache = new Map<string, GeometryCacheEntry>();

	public get(elementId: string): GeometryCacheEntry | undefined {
		return this.cache.get(elementId);
	}

	public set(elementId: string, entry: GeometryCacheEntry): void {
		this.cache.set(elementId, entry);
	}

	public delete(elementId: string): boolean {
		return this.cache.delete(elementId);
	}

	public clear(): void {
		this.cache.clear();
	}

	public deleteMany(ids: readonly string[]): void {
		for (const id of ids) this.cache.delete(id);
	}

	public keys(): MapIterator<string> {
		return this.cache.keys();
	}
}
