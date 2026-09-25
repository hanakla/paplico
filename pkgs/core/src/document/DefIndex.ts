import type { ObjectsChangeDelta } from "../collaboration/YjsProvider";
import type { DefEntry, Document } from "../schema";
import { getContainerChildIds } from "../schema";

/**
 * Reverse index of def members: elementId → defId, with a per-def revision
 * counter that is bumped whenever a member element changes.
 *
 * DefRasterizer uses {@link getRevision} as part of its cache key so a cached
 * texture for `def:${defId}:${rev}:${w}x${h}` is automatically invalidated
 * once `rev` advances. The same revision number also lets stamp/gradient
 * caches that depend on a def-sourced brush self-invalidate.
 *
 * `rebuild` walks the def graph transitively through container members
 * (Group.childIds, BlendObject.objectIds/spineSourceId, CompoundPath.sources)
 * so nested edits invalidate the right def.
 */
export class DefIndex {
	/** elementId → defId. */
	private byElementId = new Map<string, string>();
	/** defId → revision counter. Incremented whenever a member changes. */
	private revisions = new Map<string, number>();
	/** defId → last structural fingerprint used during rebuild(). */
	private fingerprints = new Map<string, string>();
	/** Bumped whenever any def revision advances. An O(1) "did any def change"
	 *  signal for consumers (e.g. the tile cache) that render def-sourced fills
	 *  without re-checking every element's per-def revision each frame. */
	private globalRevision = 0;

	/**
	 * Rebuild the reverse map from a document's defs structure. Called on full
	 * sync (yDefs structural change or document replace). Preserves existing
	 * revisions for defs that still exist, drops entries for removed defs, and
	 * starts new defs at revision 1.
	 */
	public rebuild(document: Document): void {
		const defs = document.defs ?? {};
		const objects = document.objects;

		const nextByElementId = new Map<string, string>();
		const nextRevisions = new Map<string, number>();
		const nextFingerprints = new Map<string, string>();

		let changed = false;
		for (const [defId, entry] of Object.entries(defs)) {
			const memberIds = collectDefMemberIds(entry, objects);
			for (const id of memberIds) {
				nextByElementId.set(id, defId);
			}
			const fingerprint = fingerprintDefEntry(entry);
			nextFingerprints.set(defId, fingerprint);
			const prevRev = this.revisions.get(defId);
			const prevFingerprint = this.fingerprints.get(defId);
			if (prevRev == null) {
				nextRevisions.set(defId, 1);
				changed = true;
				continue;
			}
			if (prevFingerprint !== fingerprint) changed = true;
			nextRevisions.set(
				defId,
				prevFingerprint === fingerprint ? prevRev : prevRev + 1,
			);
		}
		// A removed def also changes the output of anything that referenced it.
		if (nextRevisions.size !== this.revisions.size) changed = true;

		this.byElementId = nextByElementId;
		this.revisions = nextRevisions;
		this.fingerprints = nextFingerprints;
		if (changed) this.globalRevision++;
	}

	/**
	 * Apply a delta from the per-object change stream. Returns the set of def
	 * IDs whose revision was bumped (caller can use this to invalidate
	 * DefRasterizer / stamp caches).
	 *
	 * Adds and deletes only affect the index if the touched element was a
	 * known def member (the byElementId map is built by {@link rebuild} on
	 * structural changes — single object updates do not need to mutate it).
	 */
	public notifyDelta(delta: ObjectsChangeDelta): Set<string> {
		const touched = new Set<string>();
		const visit = (id: string) => {
			const defId = this.byElementId.get(id);
			if (defId) touched.add(defId);
		};
		for (const [id] of delta.added) visit(id);
		for (const [id] of delta.updated) visit(id);
		for (const id of delta.deleted) visit(id);
		for (const defId of touched) {
			this.revisions.set(defId, (this.revisions.get(defId) ?? 0) + 1);
		}
		if (touched.size > 0) this.globalRevision++;
		return touched;
	}

	/** Current revision for a def. Returns 0 if the def is unknown. */
	public getRevision(defId: string): number {
		return this.revisions.get(defId) ?? 0;
	}

	/** Monotonic counter bumped whenever any def revision advances. */
	public getGlobalRevision(): number {
		return this.globalRevision;
	}

	/** Reverse lookup: which def (if any) owns this element. */
	public getDefIdOf(elementId: string): string | null {
		return this.byElementId.get(elementId) ?? null;
	}

	/** Drop all state (e.g. before reloading a document). */
	public clear(): void {
		this.byElementId.clear();
		this.revisions.clear();
		this.fingerprints.clear();
	}
}

// Helpers

/**
 * Collect every element ID transitively reachable from a def's
 * rootElementIds, walking container members (groups, blends, compound
 * paths). Skips cycles defensively though defs / objects should be a DAG.
 */
function collectDefMemberIds(
	entry: DefEntry,
	objects: Record<string, unknown>,
): Set<string> {
	const out = new Set<string>();
	const stack = [...entry.rootElementIds];
	while (stack.length > 0) {
		const id = stack.pop();
		if (!id) continue;
		if (out.has(id)) continue;
		out.add(id);
		const obj = objects[id];
		if (!obj || typeof obj !== "object") continue;
		const childIds = getContainerChildIds(
			obj as Parameters<typeof getContainerChildIds>[0],
		);
		if (!childIds) continue;
		for (const cid of childIds) stack.push(cid);
	}
	return out;
}

function fingerprintDefEntry(entry: DefEntry): string {
	const tile = entry.tile;
	return JSON.stringify({
		kind: entry.kind,
		rootElementIds: entry.rootElementIds,
		tile: tile ? { width: tile.width, height: tile.height } : null,
	});
}
