import {
	getContainerChildIds,
	getTransform,
	type MeshArtObject,
} from "../../../schema";
import {
	type MeshWarpResolution,
	type WarpChildrenDeps,
	warpMeshChildren,
} from "../../../utils/geometry/meshWarp";

interface MeshWarpCacheEntry {
	fingerprint: string;
	resolution: MeshWarpResolution;
}

/**
 * Caches a mesh container's warped transient children. Self-validating via a
 * JSON fingerprint of the cage geometry plus every descendant's data (and, for
 * text descendants, whether their async glyph layout is available). Mirrors
 * BlendCache.
 */
export class MeshWarpCache {
	private cache = new Map<string, MeshWarpCacheEntry>();

	public resolve(
		mesh: MeshArtObject,
		deps: WarpChildrenDeps,
	): MeshWarpResolution {
		const fingerprint = createFingerprint(mesh, deps);
		const cached = this.cache.get(mesh.id);
		if (cached?.fingerprint === fingerprint) {
			return cached.resolution;
		}

		const resolution = warpMeshChildren(mesh, deps);
		this.cache.set(mesh.id, { fingerprint, resolution });
		return resolution;
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

function createFingerprint(
	mesh: MeshArtObject,
	deps: WarpChildrenDeps,
): string {
	const descendants: unknown[] = [];
	const visited = new Set<string>([mesh.id]);
	const stack = [...mesh.childIds];
	while (stack.length > 0) {
		const id = stack.pop();
		if (!id || visited.has(id)) continue;
		visited.add(id);
		const el = deps.resolve(id);
		if (!el) continue;
		descendants.push(el);
		if (el.type === "text") {
			// Async glyph availability flips the fingerprint once the layout
			// lands, so the pending-skip resolve gets replaced.
			descendants.push(deps.getTextGlyphPaths(el) !== null);
		}
		const childIds = getContainerChildIds(el);
		if (childIds) stack.push(...childIds);
	}
	return JSON.stringify({
		id: mesh.id,
		transform: getTransform(mesh),
		vertices: mesh.vertices,
		faces: mesh.faces,
		descendants,
	});
}
