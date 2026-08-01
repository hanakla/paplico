import {
	type CompoundPath,
	type CubicBezierSegment,
	getTransform,
	type Path,
} from "../../../schema";
import { computeBooleanOperation } from "../../../utils/geometry/pathOps";
import type { CompoundPathGeometryCacheEntry } from "../CanvasLayerTypes";

/**
 * Caches boolean operation results for compound paths. Self-validating
 * via JSON fingerprint of source paths' geometry and transforms.
 */
export class CompoundPathCache {
	private cache = new Map<string, CompoundPathGeometryCacheEntry>();

	public resolve(
		compoundPath: CompoundPath,
		pathMap: Map<string, Path>,
	): CubicBezierSegment[] {
		const fingerprint = createFingerprint(compoundPath, pathMap);
		const cached = this.cache.get(compoundPath.id);
		if (cached?.fingerprint === fingerprint) {
			return cached.segments;
		}

		const segments = computeBooleanOperation(compoundPath.sources, pathMap, {
			curveTolerance: 0.25,
		});
		this.cache.set(compoundPath.id, { fingerprint, segments });
		return segments;
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
	compoundPath: CompoundPath,
	pathMap: ReadonlyMap<string, Path>,
): string {
	const fingerprintSources = compoundPath.sources.map((source) => {
		const path = pathMap.get(source.id);
		if (!path) {
			return { id: source.id, op: source.op, missing: true };
		}
		return {
			id: source.id,
			op: source.op,
			filters: path.filters,
			transform: getTransform(path),
			segments: path.segments,
		};
	});
	return JSON.stringify({ id: compoundPath.id, sources: fingerprintSources });
}
