import { subscribe } from "valtio";
import { subscribeKey } from "valtio/utils";
import type {
	ObjectsChangeDelta,
	YjsSyncAppliedMeta,
} from "../collaboration/YjsProvider";
import type { SpatialIndex } from "../document/SpatialIndex";
import type { RendererState } from "../Paplico";
import {
	type AnyArtObject,
	getArtboardBounds,
	getContainerChildIds,
	isContainer,
	type Layer,
} from "../schema";
import { createResizeHandles } from "../tools/resizeHandleHelper";
import type { DirtyReason } from "./RenderScheduler";
import type { ChangedElements } from "./types";
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
		// or syncLayersOnly — pass an empty change set so this second "document"
		// dirty doesn't void the frame's tracking. A full sync has no ids and
		// must void it.
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

		if (this.store.selectedArtboardId) {
			const artboard = this.store.document.artboards.find(
				(a) => a.id === this.store.selectedArtboardId,
			);
			if (artboard && hooks.isArtboardToolActive()) {
				const bounds = getArtboardBounds(artboard);
				setArtboardSelectionOverlay(this.store.uiOverlayState, {
					bounds,
					handles: createResizeHandles(bounds),
				});
			}
		}

		hooks.refreshToolUI();
		hooks.syncPathToolFromDocument();
	}

	public syncLayersOnly(): void {
		const hooks = this.requireRuntimeHooks();
		hooks
			.getSpatialIndex()
			.syncLayerIndices(new Set(this.store.document.layers.map((l) => l.id)));
		hooks.refreshToolUI();
		// Layer structure changed but no element content did — keep tracking.
		this.invalidate("document", "yjs-sync", EMPTY_CHANGES);
	}

	public syncObjectsDelta(
		delta: ObjectsChangeDelta,
		layers: Layer[],
		deletedSnapshot: Record<string, AnyArtObject>,
	): void {
		const hooks = this.requireRuntimeHooks();
		const spatialIndex = hooks.getSpatialIndex();
		const objects = this.store.document.objects;

		const topLevelOwners = buildTopLevelOwners(layers);
		const resolveTopLevelOwner = (
			objectId: string,
		): { topLevelId: string; layerId: string } | null => {
			const seen = new Set<string>();
			let currentId: string | undefined = objectId;

			while (currentId && !seen.has(currentId)) {
				seen.add(currentId);

				const layerId = topLevelOwners.get(currentId);
				if (layerId) {
					return { topLevelId: currentId, layerId };
				}

				currentId = spatialIndex.getParentGroupId(currentId) ?? undefined;
			}

			return resolveTopLevelOwnerByTraversal(objectId, layers, objects);
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
			spatialIndex.clearBoundsCacheWithAncestors(id);

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

			spatialIndex.updateElement(layerId, topLevelObject);
		}

		if (hasContainerMutation(delta, deletedSnapshot)) {
			for (const [, obj] of delta.added) {
				if (isContainer(obj)) spatialIndex.refreshContainerMappings(obj);
			}
			for (const [, obj] of delta.updated) {
				if (isContainer(obj)) spatialIndex.refreshContainerMappings(obj);
			}
			for (const id of delta.deleted) {
				const del = deletedSnapshot[id];
				if (del && isContainer(del)) spatialIndex.clearContainerMappings(del);
			}
		}

		hooks.refreshToolUI();
		hooks.syncPathToolFromDocument();
		this.invalidate("document", "yjs-sync", {
			upserted: new Set([...delta.added.keys(), ...delta.updated.keys()]),
			deleted: new Set(delta.deleted),
		});
	}

	private requireRuntimeHooks(): RuntimeHooks {
		if (!this.runtimeHooks) {
			throw new Error("DocumentChangeSubscriber runtime hooks are not set");
		}
		return this.runtimeHooks;
	}
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

function hasContainerMutation(
	delta: ObjectsChangeDelta,
	deletedSnapshot: Record<string, AnyArtObject>,
): boolean {
	for (const [, obj] of delta.added) {
		if (isContainer(obj)) return true;
	}
	for (const [, obj] of delta.updated) {
		if (isContainer(obj)) return true;
	}
	for (const id of delta.deleted) {
		const deletedObject = deletedSnapshot[id];
		if (deletedObject && isContainer(deletedObject)) return true;
	}
	return false;
}

function resolveTopLevelOwnerByTraversal(
	objectId: string,
	layers: Layer[],
	objects: Record<string, AnyArtObject>,
): { topLevelId: string; layerId: string } | null {
	for (const layer of layers) {
		for (const topLevelId of layer.elementIds) {
			if (topLevelId === objectId) {
				return { topLevelId, layerId: layer.id };
			}
			if (
				containerContainsObject(
					topLevelId,
					objectId,
					objects,
					new Set<string>(),
				)
			) {
				return { topLevelId, layerId: layer.id };
			}
		}
	}
	return null;
}

function containerContainsObject(
	candidateId: string,
	targetId: string,
	objects: Record<string, AnyArtObject>,
	visitedIds: Set<string>,
): boolean {
	if (visitedIds.has(candidateId)) return false;
	visitedIds.add(candidateId);

	const candidate = objects[candidateId];
	if (!candidate || !isContainer(candidate)) return false;

	// Containers include groups, compound-paths and blends — a blend's absorbed
	// keys/spine live here, so editing one must resolve up to the blend or the
	// blend never re-renders.
	const childIds = getContainerChildIds(candidate);
	if (!childIds) return false;

	for (const childId of childIds) {
		if (childId === targetId) return true;
		if (containerContainsObject(childId, targetId, objects, visitedIds)) {
			return true;
		}
	}

	return false;
}
