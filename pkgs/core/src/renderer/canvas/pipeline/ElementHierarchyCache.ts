import { type AnyArtObject, isGroup, isMesh } from "../../../schema";
import type { LocalBoundsCache } from "../../../utils/geometry/bounds";
import type { ChangedElements } from "../../types";

/**
 * Per-canvas caches derived from the element hierarchy: local (pre-transform)
 * bounds by element id, and the child → parent edges the transforms buffer
 * composes through. Neither depends on the viewport.
 *
 * Every consumer in a frame — the frame plan, the transforms buffer, filters,
 * clip masks — reads this one instance, so a frame must evict the entries its
 * changes made stale before the frame plan reads them.
 */
export class ElementHierarchyCache {
	/** Local bounds by element id. Consumers fill missing entries on demand. */
	public readonly localBounds: LocalBoundsCache = new Map();
	private readonly parents = new Map<string, string>();
	/** False between clearParents and ensureParents: the edges are unknown, not absent. */
	private parentsKnown = false;

	public get parentMap(): ReadonlyMap<string, string> {
		return this.parents;
	}

	/**
	 * Evict the local bounds of a frame's changed elements and of their
	 * ancestors, whose bounds aggregate them.
	 */
	public applyChanges(changes: ChangedElements): void {
		this.invalidateBounds([...changes.upserted, ...changes.deleted]);
	}

	/**
	 * Evict the local bounds of `ids` and of their ancestors. While the edges
	 * are unknown the ancestors cannot be found, so every entry is evicted.
	 *
	 * @returns the ids found stale — world-bounds consumers must treat them as
	 * stale too.
	 */
	public invalidateBounds(ids: Iterable<string>): ReadonlySet<string> {
		const evicted = new Set<string>();
		for (const id of ids) {
			let current: string | undefined = id;
			while (current !== undefined && !evicted.has(current)) {
				evicted.add(current);
				this.localBounds.delete(current);
				current = this.parents.get(current);
			}
		}
		if (!this.parentsKnown) this.localBounds.clear();
		return evicted;
	}

	public clear(): void {
		this.localBounds.clear();
		this.clearParents();
	}

	/** Forget the edges; the next ensureParents re-derives them. */
	public clearParents(): void {
		this.parents.clear();
		this.parentsKnown = false;
	}

	/**
	 * Derive the edges from `elementsMap` when they are unknown.
	 *
	 * @returns true when the edges were rebuilt.
	 */
	public ensureParents(
		elementsMap: ReadonlyMap<string, AnyArtObject>,
	): boolean {
		if (this.parentsKnown) return false;
		for (const element of elementsMap.values()) {
			for (const childId of parentedChildIds(element) ?? []) {
				this.parents.set(childId, element.id);
			}
		}
		this.parentsKnown = true;
		return true;
	}

	/**
	 * Re-sync the edges below each of `ids` from `elementsMap`: children that
	 * left one of them lose their edge, children that joined gain one.
	 *
	 * Plain elements are skipped, which means an owner that keeps existing
	 * while its mask is cleared would leave stale edges behind. Clearing a mask
	 * always deletes its content (see PaplicoCommands.removeMaskFromElement),
	 * and deleted ids drop their own edge through removeParent, so that
	 * combination does not arise.
	 *
	 * @returns the children whose parent changed.
	 */
	public syncChildrenOf(
		ids: Iterable<string>,
		elementsMap: ReadonlyMap<string, AnyArtObject>,
	): Set<string> {
		const reparented = new Set<string>();
		for (const id of ids) {
			const element = elementsMap.get(id);
			const currentChildren =
				element != null ? parentedChildIds(element) : null;
			if (element != null && !currentChildren) continue;
			const currentChildSet = currentChildren ? new Set(currentChildren) : null;
			for (const [childId, parentId] of this.parents) {
				if (parentId !== id) continue;
				if (currentChildSet?.has(childId)) continue;
				this.parents.delete(childId);
				reparented.add(childId);
			}
			if (!currentChildren) continue;
			for (const childId of currentChildren) {
				if (this.parents.get(childId) !== id) {
					this.parents.set(childId, id);
					reparented.add(childId);
				}
			}
		}
		return reparented;
	}

	/** Drop the edge of a deleted element. */
	public removeParent(childId: string): void {
		this.parents.delete(childId);
	}
}

/** Child → parent edges of every element that parents others, as the
 *  transform buffer composes them. */
export function buildParentedMap(
	elementsMap: ReadonlyMap<string, AnyArtObject>,
): Map<string, string> {
	const parentById = new Map<string, string>();
	for (const element of elementsMap.values()) {
		for (const childId of parentedChildIds(element) ?? []) {
			parentById.set(childId, element.id);
		}
	}
	return parentById;
}

/**
 * Ids whose composed transform is parented to `element`: a group's children,
 * plus object-mask content. Mask elements are stored in owner-local space so
 * the mask follows the element it hides, and they keep composing through the
 * owner even while a mask-edit session has them sitting on a transient layer
 * (the edges are derived from the reference, not from layer membership).
 *
 * Returns null when the element parents nothing, so callers can skip work.
 */
export function parentedChildIds(
	element: AnyArtObject,
): readonly string[] | null {
	const maskIds = element.mask?.elementIds;
	// A mesh container holds its children in its own space just as a group
	// does — their stored coordinates are what the cage is built around.
	const childIds =
		isGroup(element) || isMesh(element) ? element.childIds : undefined;
	if (!childIds) return maskIds?.length ? maskIds : null;
	return maskIds?.length ? [...childIds, ...maskIds] : childIds;
}
