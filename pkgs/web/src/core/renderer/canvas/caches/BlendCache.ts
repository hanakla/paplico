import { type BlendObject, getTransform, type Path } from "../../../schema";
import { computeBlendIntermediates } from "../../../utils/geometry/blendInterpolation";

interface BlendCacheEntry {
	fingerprint: string;
	/** Intermediates grouped per adjacent pair (result[i] = between objects[i] and [i+1]). */
	intermediates: Path[][];
}

/**
 * Caches computed blend intermediates. Self-validating via JSON fingerprint of
 * blend params + source objects' geometry/transform/filters. Mirrors
 * CompoundPathCache.
 */
export class BlendCache {
	private cache = new Map<string, BlendCacheEntry>();

	public resolve(
		blend: BlendObject,
		objects: Path[],
		spineSource?: Path | null,
	): Path[][] {
		const fingerprint = createFingerprint(blend, objects, spineSource);
		const cached = this.cache.get(blend.id);
		if (cached?.fingerprint === fingerprint) {
			return cached.intermediates;
		}

		const intermediates = computeBlendIntermediates(
			blend,
			objects,
			spineSource,
		);
		this.cache.set(blend.id, { fingerprint, intermediates });
		return intermediates;
	}

	public clear(): void {
		this.cache.clear();
	}

	public size(): number {
		return this.cache.size;
	}

	public deleteMany(ids: readonly string[]): void {
		for (const id of ids) this.cache.delete(id);
	}

	public keys(): MapIterator<string> {
		return this.cache.keys();
	}
}

function createFingerprint(
	blend: BlendObject,
	objects: Path[],
	spineSource?: Path | null,
): string {
	const fingerprintObjects = objects.map((obj) => ({
		id: obj.id,
		filters: obj.filters,
		transform: getTransform(obj),
		segments: obj.segments,
		opacity: obj.opacity,
	}));
	return JSON.stringify({
		id: blend.id,
		objectIds: blend.objectIds,
		spacing: blend.spacing,
		spineSourceId: blend.spineSourceId,
		tiltToSpine: blend.tiltToSpine,
		// Spine geometry so editing the spine source invalidates the cache.
		spine: spineSource
			? { transform: getTransform(spineSource), segments: spineSource.segments }
			: null,
		objects: fingerprintObjects,
	});
}
