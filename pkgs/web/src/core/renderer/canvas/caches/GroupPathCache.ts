import {
	type AnyArtObject,
	type CubicBezierSegment,
	type Group,
	getTransform,
	isCompoundPath,
	isGroup,
	isPath,
} from "../../../schema";
import { collectGroupSegments } from "../pipeline/GroupAppearanceCollector";
import type { CompoundPathCache } from "./CompoundPathCache";

/**
 * Caches combined path segments for groups with fill/stroke appearances.
 * Self-validating via JSON fingerprint of child paths' geometry and transforms.
 */
export class GroupPathCache {
	private cache = new Map<
		string,
		{ fingerprint: string; segments: CubicBezierSegment[] }
	>();

	public resolve(
		group: Group,
		elementsMap: Map<string, AnyArtObject>,
		compoundPathCache: CompoundPathCache,
	): CubicBezierSegment[] {
		const fingerprint = createGroupFingerprint(group, elementsMap);
		const cached = this.cache.get(group.id);
		if (cached?.fingerprint === fingerprint) {
			return cached.segments;
		}

		const segments = collectGroupSegments(
			group,
			elementsMap,
			compoundPathCache,
		);
		this.cache.set(group.id, { fingerprint, segments });
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

function createGroupFingerprint(
	group: Group,
	elementsMap: ReadonlyMap<string, AnyArtObject>,
): string {
	return JSON.stringify({
		id: group.id,
		children: buildChildFingerprints(group, elementsMap),
	});
}

function buildChildFingerprints(
	group: Group,
	elementsMap: ReadonlyMap<string, AnyArtObject>,
): unknown[] {
	return group.childIds.map((childId) => {
		const child = elementsMap.get(childId);
		if (!child) return { id: childId, missing: true };

		if (isPath(child)) {
			return {
				id: child.id,
				type: "path",
				segments: child.segments,
				transform: getTransform(child),
			};
		}

		if (isCompoundPath(child)) {
			return {
				id: child.id,
				type: "compound-path",
				sources: child.sources,
				transform: getTransform(child),
			};
		}

		if (isGroup(child)) {
			return {
				id: child.id,
				type: "group",
				transform: getTransform(child),
				children: buildChildFingerprints(child, elementsMap),
			};
		}

		// ImageObject, TextElement — not contributing to path cache
		return { id: child.id, type: child.type, skipped: true };
	});
}
