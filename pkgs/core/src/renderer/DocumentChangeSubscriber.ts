import { subscribe } from "valtio";
import { subscribeKey } from "valtio/utils";
import type { YjsSyncAppliedMeta } from "../collaboration/YjsProvider";
import type { ObjectsChangeDelta } from "../document/objectsChangeDelta";
import type { SpatialIndex } from "../document/SpatialIndex";
import {
	type AnyArtObject,
	getArtboardBounds,
	getContainerChildIds,
	isContainer,
	type Layer,
} from "../schema";
import type { DirtyReason } from "./RenderScheduler";
import type { ChangedElements, RendererState } from "./types";
import { createResizeHandles } from "./ui/builders/resizeHandles";
import { setArtboardSelectionOverlay } from "./ui/overlaySink";

type DocumentChangeSubscriberStoreKey =
	| "document"
	| "elementOverrides"
	| "transientElements"
	| "uiOverlayState"
	| "editingScopeStack"
	| "selectedArtboardId";

export type DocumentChangeSubscriberStore = Pick<
	RendererState,
	DocumentChangeSubscriberStoreKey
>;

type RenderChangeSource =
	| "store-subscription"
	| "yjs-sync"
	| "yjs-undo-redo"
	| "tool-context"
	| "renderer"
	| "animation"
	| "system";

type StoreWatchEntry = {
	key: DocumentChangeSubscriberStoreKey;
	reason: DirtyReason;
};

type RuntimeHooks = {
	getSpatialIndex: () => SpatialIndex;
	refreshToolUI: () => void;
	syncPathToolFromDocument: () => void;
	isArtboardToolActive: () => boolean;
};

const STORE_WATCH_ENTRIES: readonly StoreWatchEntry[] = [
	{ key: "document", reason: "document" },
	{ key: "elementOverrides", reason: "preview" },
	{ key: "transientElements", reason: "preview" },

	{ key: "editingScopeStack", reason: "editingScope" },
];

/** "Document content unchanged" marker for dirt that must not void the
 *  frame's element-change tracking (layer reordering, delta-sync echoes). */
const EMPTY_CHANGES: ChangedElements = {
	upserted: new Set(),
	deleted: new Set(),
};

/**
 * Detects document updates and issues re-render invalidations.
 *
 * This class does NOT own store mutations (writing to RendererState.document).
 * Store writes are the caller's responsibility (typically Paplico).
 * SpatialIndex updates remain here because the spatial index is treated
 * as a derived rendering structure, not as primary document state.
 */
export class DocumentChangeSubscriber {
	private started = false;
	private unsubscribes: Array<() => void> = [];
	private transformOnlyChangeActive = false;

	public constructor(
		private readonly store: DocumentChangeSubscriberStore,
		private readonly onInvalidate: (
			reason: DirtyReason,
			source: RenderChangeSource,
			changes?: ChangedElements,
		) => void,
		private readonly runtimeHooks?: RuntimeHooks,
	) {}

	public start(): void {
		if (this.started) return;
		this.started = true;

		for (const entry of STORE_WATCH_ENTRIES) {
			this.unsubscribes.push(
				subscribeKey(this.store, entry.key, () => {
					this.invalidate(entry.reason, "store-subscription");
				}),
			);
		}

		// uiOverlayState uses deep subscribe instead of subscribeKey
		// because subscribeKey only detects top-level reference changes,
		// missing nested mutations like `store.uiOverlayState.overlays = {...}`.
		this.unsubscribes.push(
			subscribe(this.store.uiOverlayState, () => {
				this.invalidate("selection", "store-subscription");
			}),
		);
	}

	public stop(): void {
		for (const unsubscribe of this.unsubscribes) {
			unsubscribe();
		}
		this.unsubscribes = [];
		this.started = false;
	}

	public isStarted(): boolean {
		return this.started;
	}

	/** Run `fn` with transform-only mode active so document invalidations emit "elementMove" instead of "document". */
	public withTransformOnlyChange(fn: () => void): void {
		this.transformOnlyChangeActive = true;
		try {
			fn();
		} finally {
			this.transformOnlyChangeActive = false;
		}
	}

	private invalidate(
		reason: DirtyReason,
		source: RenderChangeSource,
		changes?: ChangedElements,
	): void {
		if (this.transformOnlyChangeActive && reason === "document") {
			this.onInvalidate("elementMove", source, changes);
		} else {
			this.onInvalidate(reason, source, changes);
		}
	}

	public onSyncApplied(meta: YjsSyncAppliedMeta): void {
		const source = meta.undoRedo ? "yjs-undo-redo" : "yjs-sync";

		if (meta.undoRedo && this.runtimeHooks) {
			// Undo/redo can keep stale transient UI state unless tools are refreshed
			// after the document snapshot is applied.
			this.runtimeHooks.refreshToolUI();
			this.runtimeHooks.syncPathToolFromDocument();
			this.invalidate("selection", source);
		}

		// A delta sync already reported its element ids through syncObjectsDelta
		// or syncLayersOnly, and an artboard-only sync changes no element — pass
		// an empty change set so this second "document" dirty doesn't void the
		// frame's tracking. A full sync has no ids and must void it.
		this.invalidate(
			"document",
			source,
			meta.syncKind === "delta" ? EMPTY_CHANGES : undefined,
		);
	}

	public syncFullDocument(): void {
		const hooks = this.requireRuntimeHooks();

		// rebuildAllIndices is triggered automatically by SpatialIndex's
		// subscription when store.document reference changes.

		this.refreshArtboardSelectionOverlay(hooks);
		hooks.refreshToolUI();
		hooks.syncPathToolFromDocument();
	}

	/**
	 * Apply an artboard-only change. No element changed, so the element
	 * indices stay as they are.
	 */
	public syncArtboardsOnly(): void {
		const hooks = this.requireRuntimeHooks();
		hooks.getSpatialIndex().rebuildArtboardIndex();
		this.refreshArtboardSelectionOverlay(hooks);
	}

	/**
	 * Apply a layer structure change. Grouping, ungrouping and moving between
	 * layers change which layer an element sits directly in without always
	 * changing the element itself, so those elements are moved between layer
	 * indices here. An id not in the objects yet is a new element that
	 * syncObjectsDelta inserts.
	 */
	public syncLayersOnly(previousLayers: Layer[]): void {
		const hooks = this.requireRuntimeHooks();
		const spatialIndex = hooks.getSpatialIndex();
		const { layers, objects } = this.store.document;
		spatialIndex.syncLayerIndices(new Set(layers.map((l) => l.id)));

		const previousOwners = buildTopLevelOwners(previousLayers);
		const nextOwners = buildTopLevelOwners(layers);
		const movedIds = new Set<string>();
		for (const [id, layerId] of previousOwners) {
			if (nextOwners.get(id) === layerId) continue;
			spatialIndex.removeFromLayerQuadtreeKeepingBounds(layerId, id);
			movedIds.add(id);
		}
		for (const [id, layerId] of nextOwners) {
			if (previousOwners.get(id) === layerId) continue;
			const element = objects[id];
			if (!element) continue;
			spatialIndex.addToLayerQuadtreeWithCachedBounds(layerId, element);
			movedIds.add(id);
		}

		hooks.refreshToolUI();
		// A moved element redraws both where it was and where it is now, so it
		// is reported as upserted even when it left the layer. Reporting it as
		// deleted would make the renderer scan every cache for deletions.
		this.invalidate("document", "yjs-sync", {
			upserted: movedIds,
			deleted: new Set(),
		});
	}

	public syncObjectsDelta(
		delta: ObjectsChangeDelta,
		layers: Layer[],
		deletedSnapshot: Record<string, AnyArtObject>,
	): void {
		const hooks = this.requireRuntimeHooks();
		const spatialIndex = hooks.getSpatialIndex();
		const objects = this.store.document.objects;

		// Read before the parent mapping is refreshed: a container that lost a
		// child is found through the child's previous parent.
		const movedIds = this.transformOnlyChangeActive
			? collectMovedIds(delta, spatialIndex)
			: new Set<string>();

		// Owners are resolved by walking up the parent mapping, so it has to
		// know the children this delta attached before the first lookup.
		for (const [, obj] of delta.added) {
			if (isContainer(obj)) spatialIndex.refreshContainerMappings(obj);
		}
		for (const [, obj] of delta.updated) {
			if (isContainer(obj)) spatialIndex.refreshContainerMappings(obj);
		}

		const topLevelOwners = buildTopLevelOwners(layers);
		const findTopLevelOwner = (
			objectId: string,
		): { topLevelId: string; layerId: string } | null => {
			const seen = new Set<string>();
			for (
				let id: string | null = objectId;
				id && !seen.has(id);
				id = spatialIndex.getParentGroupId(id)
			) {
				seen.add(id);
				const layerId = topLevelOwners.get(id);
				if (layerId) return { topLevelId: id, layerId };
			}
			return null;
		};

		let parentMappingRebuilt = false;
		const resolveTopLevelOwner = (objectId: string) => {
			const owner = findTopLevelOwner(objectId);
			// An object that left the document has no owner to look for.
			if (owner || !objects[objectId] || parentMappingRebuilt) return owner;

			// The parent mapping does not reach a layer. Rebuild it from the
			// document, once per delta, in case it is stale.
			spatialIndex.rebuildParentGroupMap();
			parentMappingRebuilt = true;
			return findTopLevelOwner(objectId);
		};

		const affectedTopLevelOwners = new Map<string, string>();

		for (const [id, obj] of delta.added) {
			const owner = resolveTopLevelOwner(id);
			if (!owner) continue;

			if (owner.topLevelId === id) {
				spatialIndex.insertElement(owner.layerId, obj);
				continue;
			}

			affectedTopLevelOwners.set(owner.topLevelId, owner.layerId);
		}

		for (const [id] of delta.updated) {
			spatialIndex.clearBoundsCacheWithAncestors(id, movedIds.has(id));

			const owner = resolveTopLevelOwner(id);
			if (!owner) continue;

			affectedTopLevelOwners.set(owner.topLevelId, owner.layerId);
		}

		for (const id of delta.deleted) {
			const owner = resolveTopLevelOwner(id);
			if (owner) {
				affectedTopLevelOwners.set(owner.topLevelId, owner.layerId);
			}

			for (const layer of layers) {
				spatialIndex.removeElement(layer.id, id);
			}
		}

		for (const [topLevelId, layerId] of affectedTopLevelOwners) {
			const topLevelObject = objects[topLevelId];
			if (!topLevelObject) continue;

			spatialIndex.updateElement(
				layerId,
				topLevelObject,
				movedIds.has(topLevelId),
			);
		}

		for (const id of delta.deleted) {
			const del = deletedSnapshot[id];
			if (del && isContainer(del)) spatialIndex.clearContainerMappings(del);
		}

		hooks.refreshToolUI();
		hooks.syncPathToolFromDocument();
		this.invalidate("document", "yjs-sync", {
			upserted: new Set([...delta.added.keys(), ...delta.updated.keys()]),
			deleted: new Set(delta.deleted),
		});
	}

	private refreshArtboardSelectionOverlay(hooks: RuntimeHooks): void {
		if (!this.store.selectedArtboardId) return;
		const artboard = this.store.document.artboards.find(
			(a) => a.id === this.store.selectedArtboardId,
		);
		if (!artboard || !hooks.isArtboardToolActive()) return;
		const bounds = getArtboardBounds(artboard);
		setArtboardSelectionOverlay(this.store.uiOverlayState, {
			bounds,
			handles: createResizeHandles(bounds),
		});
	}

	private requireRuntimeHooks(): RuntimeHooks {
		if (!this.runtimeHooks) {
			throw new Error("DocumentChangeSubscriber runtime hooks are not set");
		}
		return this.runtimeHooks;
	}
}

/**
 * The updated ids of a transform-only change that only moved, keeping their
 * own local bounds. A container that holds another changed id, or held one
 * that went away, changed shape: a duplicate joining a group, a blend whose
 * keys moved with it.
 */
function collectMovedIds(
	delta: ObjectsChangeDelta,
	spatialIndex: SpatialIndex,
): Set<string> {
	const changedIds = new Set([
		...delta.added.keys(),
		...delta.updated.keys(),
		...delta.deleted,
	]);
	const reshapedIds = new Set<string>();
	for (const id of changedIds) {
		const parentId = spatialIndex.getParentGroupId(id);
		if (parentId) reshapedIds.add(parentId);
	}
	const movedIds = new Set<string>();
	for (const [id, obj] of delta.updated) {
		if (reshapedIds.has(id)) continue;
		if (getContainerChildIds(obj)?.some((childId) => changedIds.has(childId))) {
			continue;
		}
		movedIds.add(id);
	}
	return movedIds;
}

function buildTopLevelOwners(layers: Layer[]): Map<string, string> {
	const topLevelOwners = new Map<string, string>();
	for (const layer of layers) {
		for (const elementId of layer.elementIds) {
			topLevelOwners.set(elementId, layer.id);
		}
	}
	return topLevelOwners;
}
