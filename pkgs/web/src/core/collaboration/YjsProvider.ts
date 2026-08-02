import * as Y from "yjs";
import { UndoManager } from "yjs";
import { normalizeBrushPreset } from "../brush/normalize";
import { createIdentityTransform } from "../document/factory";
import {
	type AnyArtObject,
	type Artboard,
	type BlendObject,
	type BrushPreset,
	type ColorProfileSettings,
	type CompoundPath,
	type CubicBezierSegment,
	createDefaultContentAppearance,
	type DefEntry,
	type Document,
	type ElementTransform,
	type EmbeddedFile,
	type Group,
	isIdentityTransform,
	type Layer,
	type MeshArtObject,
	type Path,
	type Reference3DDef,
	type Reference3DNode,
	type RepeatObject,
} from "../schema";
import { composeTransforms } from "../utils/geometry/geometry";
import {
	createPathsFromSegmentLists,
	mergePathsAtEndpoints,
	splitPathAtAnchor,
} from "../utils/geometry/pathOps";
import { neverReached } from "../utils/lang";
import {
	extractDocumentFromYDoc,
	extractLayersFromYDoc,
	yMapToObject,
} from "./extractDocumentFromYDoc";

// --- Y.Map serialization constants ---

/**
 * Scalar fields stored as direct Y.Map keys.
 *
 * These two sets are what `updateElement` matches mutated keys against, and a
 * key in neither is dropped without a word. They therefore have to cover
 * everything `objectToStoredFields` can write — `yjsFieldCoverage.test.ts`
 * holds them to it.
 */
export const SCALAR_FIELDS = new Set([
	"id",
	"type",
	"opacity",
	"blendMode",
	"compositionMode",
	"visible",
	"locked",
	"width",
	"height",
	"x",
	"y",
	"name",
	"fileUid",
	"operation",
	"collapsed",
	"pathStart",
	"pathEnd",
	"isGuide",
	"spineSourceId",
	"tiltToSpine",
	"sceneId",
	"displayMode",
	"includeInExport",
	"mode",
]);

/** Complex fields stored as JSON strings. @see SCALAR_FIELDS */
export const JSON_FIELDS = new Set([
	"segments",
	"filters",
	"childIds",
	"clipPathId",
	"sources",
	"content",
	"defaultStyle",
	"layout",
	"axisBinding",
	"flow",
	"transform",
	"mask",
	"strokeWidths",
	"eraseMasks",
	"vertices",
	"faces",
	"corners",
	"objectIds",
	"renderOrder",
	"spacing",
	"camera",
	"lineart",
	"lightDir",
	"sourceIds",
	"grid",
	"radial",
	"mirror",
]);

// Serializable version of EmbeddedFile in Yjs storage.
interface SerializedEmbeddedFile {
	uid: string;
	name: string;
	type: string;
	hash: string;
	bin: Uint8Array | number[];
}

/** Delta change information for objects */
export interface ObjectsChangeDelta {
	added: Map<string, AnyArtObject>;
	updated: Map<string, AnyArtObject>;
	deleted: Set<string>;
}

export interface YjsSyncAppliedMeta {
	syncKind: "full" | "delta";
	undoRedo: boolean;
}

export interface YjsProviderCallbacks {
	onDocumentUpdate: (document: Document) => void;
	/** Delta callback when only objects changed. Avoids full sync. */
	onObjectsChange?: (delta: ObjectsChangeDelta) => void;
	onLayersUpdate: (layers: Layer[]) => void;
	onSyncApplied?: (meta: YjsSyncAppliedMeta) => void;
	getCurrentLayerId: () => string | null;
	setCurrentLayerId: (layerId: string) => void;
	onUndoRedoStateChange?: (canUndo: boolean, canRedo: boolean) => void;
	onArtboardsUpdate?: (artboards: Artboard[]) => void;
	/**
	 * Fired when undo/redo pops a stack item carrying stashed UndoStackMeta
	 * (see stashUndoMeta) so destroyed state (selection etc.) can be restored.
	 */
	onUndoStackMetaPopped?: (meta: UndoStackMeta, type: "undo" | "redo") => void;
}

/**
 * Typed metadata attached to undo stack items. Each key holds state that the
 * captured mutation destroys; popping the item replays it through
 * onUndoStackMetaPopped so the owner can restore it. Add keys here as more
 * commands need undo-time restoration.
 */
export interface UndoStackMeta {
	/** Path-edit anchor handle keys destroyed by a vertex deletion. */
	pathEditSelection?: string[];
}

/** Single stack-item meta key under which the UndoStackMeta object is stored. */
const UNDO_META_KEY = "undoStackMeta";

interface YjsProviderOptions {
	callbacks: YjsProviderCallbacks;
}

/**
 * Yjs Collaboration Provider
 * Manages document state with Yjs CRDT
 *
 * Normalized data model:
 * - yObjects: Y.Map<Y.Map<unknown>> — All ArtObjects stored by ID, each as individual Y.Map
 * - layer.elementIds: Y.Array<string> — Layers hold only ordered ID lists
 * - Group.childIds — Groups reference children by ID (children NOT in layer.elementIds)
 *
 * Room connection flow — 3 scenarios:
 *
 * 1. Publish new room (handlePublishRoom):
 *    Local Y.Doc → WebSocket → synced to remote.
 *    Save reconnectInfo for future tab-reload reconnection.
 *
 * 2. Connect to existing room (no reconnectInfo for this room):
 *    Confirm document discard → resetWithFreshDoc() → WebSocket connect.
 *    Remote state is adopted entirely (fresh doc has no state to merge).
 *    Save reconnectInfo.
 *
 * 3. Reconnect to last-connected room (reconnectInfo matches):
 *    Keep local Y.Doc → WebSocket connect → Yjs CRDT merge.
 *    After sync, deduplicateLayers() merges any duplicate layers
 *    caused by Y.Array append-both-sides merge.
 *    yObjects (Y.Map) auto-deduplicates via last-write-wins.
 *
 * Disconnect: Toast with reconnect action.
 * Explicit leave (handleDisconnectRoom): clears reconnectInfo.
 */
export class YjsProvider {
	public ydoc: Y.Doc;
	// Bound by bindSharedTypes() (constructor + resetWithFreshDoc).
	private yLayers!: Y.Array<Y.Map<unknown>>;
	private yObjects!: Y.Map<Y.Map<unknown>>;
	private yMeta!: Y.Map<unknown>;
	private yArtboards!: Y.Array<Artboard>;
	private yFiles!: Y.Map<SerializedEmbeddedFile>;
	private yBrushPresets!: Y.Map<Y.Map<unknown>>;
	private yDefs!: Y.Map<Y.Map<unknown>>;
	private yReferences3d!: Y.Map<Y.Map<unknown>>;
	private callbacks: YjsProviderCallbacks;
	/** Meta stash consumed by the next captured undo stack item. */
	private pendingUndoMeta: UndoStackMeta | null = null;

	/**
	 * Delta sync tracking: accumulates changes within the current transaction.
	 * yObjects-only changes → delta patch via onObjectsChange.
	 * yLayers / yArtboards / files / brushPresets / meta changes → full sync via onDocumentUpdate.
	 */
	private pendingObjectChanges: ObjectsChangeDelta | null = null;
	private needsFullSync = false;
	private needsLayerSync = false;

	/** Suppress object tracking during replaceDocument to avoid wasted yMapToObject calls */
	private suppressObjectTracking = false;
	/** Suppress syncYjsToValtio during replaceDocument (caller handles sync directly) */
	private suppressSync = false;

	private isUndoRedoInProgress = false;

	// Undo/Redo manager
	public undoManager: UndoManager;
	private objectsSnapshot: Record<string, AnyArtObject> | null = null;
	private layerElementIdsSnapshot: Record<string, string[]> | null = null;

	// Valtio subscription cleanup function
	private valtioUnsubscribe: (() => void) | null = null;

	public constructor(options: YjsProviderOptions) {
		this.callbacks = options.callbacks;
		try {
			this.ydoc = new Y.Doc();
			this.bindSharedTypes();

			this.attachObservers();
			this.undoManager = this.createUndoManager();
		} catch (error) {
			console.error("Error in YjsProvider constructor:", error);
			if (error instanceof Error) {
				console.error("Stack trace:", error.stack);
			}
			throw error;
		}
	}

	private attachObservers(): void {
		// Delta detection: track nested updates within yObjects
		this.yObjects.observeDeep((events) => {
			for (const event of events) {
				// Multiple bundled Yjs instances can make `instanceof` brittle.
				if (!("path" in event) || !("changes" in event)) continue;
				const mapEvent = event as Y.YMapEvent<unknown>;

				// path=[]: top-level yObjects key changes (add/update/delete)
				if (mapEvent.path.length === 0) {
					for (const [key, change] of mapEvent.changes.keys) {
						if (typeof key !== "string") continue;
						if (change.action === "add") {
							this.trackObjectAdded(key);
						} else if (change.action === "update") {
							this.trackObjectUpdated(key);
						} else if (change.action === "delete") {
							this.trackObjectDeleted(key);
						}
					}
					continue;
				}

				// path=[objectId, ...]: nested update within an individual object
				const objectId = mapEvent.path[0];
				if (typeof objectId !== "string") continue;
				this.trackObjectUpdated(objectId);
			}
		});

		// Layer/artboard changes use layer-only sync.
		// observeDeep: also detects nested Y.Array changes (e.g. elementIds)
		this.yLayers.observeDeep(() => {
			this.needsLayerSync = true;
		});
		this.yArtboards.observe(() => {
			this.needsFullSync = true;
		});
		this.yFiles.observe(() => {
			this.needsFullSync = true;
		});
		this.yBrushPresets.observe(() => {
			this.needsFullSync = true;
		});
		this.yDefs.observeDeep(() => {
			// def CRUD is rare; route through the full-sync path (same flow as
			// yArtboards / yMeta). Element-level edits to def members live in
			// yObjects and continue to use the per-object delta path.
			this.needsFullSync = true;
		});
		this.yReferences3d.observeDeep(() => {
			// Scene definition edits are committed on pointer-up (drag previews
			// bypass Yjs), so the full-sync path is cheap enough here.
			this.needsFullSync = true;
		});
		this.yMeta.observe(() => {
			this.needsFullSync = true;
		});

		// Listen to Yjs changes and sync to Valtio
		this.ydoc.on("update", (_update: Uint8Array, _origin: unknown) => {
			try {
				// Sync all updates to Valtio (both local and remote)
				// No circular update risk since Valtio->Yjs sync is disabled
				this.syncYjsToValtio();
			} catch (error) {
				console.error("Error in update handler:", error);
				if (error instanceof Error) {
					console.error("Stack trace:", error.stack);
				}
			}
		});
	}

	/**
	 * Stash metadata for the next captured undo stack item — state that the
	 * upcoming mutation destroys and that should be restored when the item is
	 * popped (see UndoStackMeta / onUndoStackMetaPopped).
	 */
	public stashUndoMeta<K extends keyof UndoStackMeta>(
		key: K,
		value: UndoStackMeta[K],
	): void {
		this.pendingUndoMeta = { ...this.pendingUndoMeta, [key]: value };
	}

	private createUndoManager(): UndoManager {
		const undoManager = new UndoManager(
			[
				this.yObjects,
				this.yLayers,
				this.yArtboards,
				this.yDefs,
				this.yReferences3d,
			],
			{
				captureTimeout: 500,
			},
		);

		// The mutation may merge into the previous stack item (captureTimeout),
		// in which case only "stack-item-updated" fires.
		const attachPendingMeta = (event: {
			stackItem: { meta: Map<unknown, unknown> };
		}) => {
			if (!this.pendingUndoMeta) return;
			const existing = event.stackItem.meta.get(UNDO_META_KEY) as
				| UndoStackMeta
				| undefined;
			event.stackItem.meta.set(UNDO_META_KEY, {
				...existing,
				...this.pendingUndoMeta,
			});
			this.pendingUndoMeta = null;
		};

		undoManager.on("stack-item-added", (event) => {
			attachPendingMeta(event);
			this.notifyUndoRedoStateChange();
		});
		undoManager.on("stack-item-updated", attachPendingMeta);
		undoManager.on("stack-item-popped", (event) => {
			const stored = event.stackItem.meta.get(UNDO_META_KEY) as
				| UndoStackMeta
				| undefined;
			if (stored) {
				this.callbacks.onUndoStackMetaPopped?.(stored, event.type);
			}
			this.notifyUndoRedoStateChange();
		});

		return undoManager;
	}

	// --- Y.Map helpers ---

	/** Convert AnyArtObject to Y.Map for storage */
	private objectToYMap(element: AnyArtObject): Y.Map<unknown> {
		const yMap = new Y.Map<unknown>();
		const fields = this.objectToStoredFields(element);
		for (const [key, value] of Object.entries(fields)) {
			yMap.set(key, value);
		}
		return yMap;
	}

	private objectToStoredFields(element: AnyArtObject): Record<string, unknown> {
		return objectToStoredFields(element);
	}

	/** Find a yLayer Y.Map by layer ID */
	private findYLayer(layerId: string): Y.Map<unknown> | null {
		for (let i = 0; i < this.yLayers.length; i++) {
			const yLayer = this.yLayers.get(i);
			if (yLayer?.get("id") === layerId) return yLayer;
		}
		return null;
	}

	/** Get the elementIds Y.Array from a yLayer */
	private getYElementIds(yLayer: Y.Map<unknown>): Y.Array<string> {
		return yLayer.get("elementIds") as Y.Array<string>;
	}

	/** Ensure pending object change container exists */
	private ensurePendingObjectChanges(): ObjectsChangeDelta {
		if (!this.pendingObjectChanges) {
			this.pendingObjectChanges = {
				added: new Map(),
				updated: new Map(),
				deleted: new Set(),
			};
		}
		return this.pendingObjectChanges;
	}

	/** Track object add in current transaction */
	private trackObjectAdded(objectId: string): void {
		if (this.suppressObjectTracking) return;
		const yMap = this.yObjects.get(objectId);
		if (!yMap) return;

		const changes = this.ensurePendingObjectChanges();
		changes.deleted.delete(objectId);
		changes.updated.delete(objectId);
		changes.added.set(objectId, yMapToObject(yMap as Y.Map<unknown>));
	}

	/** Track object update in current transaction */
	private trackObjectUpdated(objectId: string): void {
		if (this.suppressObjectTracking) return;
		const yMap = this.yObjects.get(objectId);
		if (!yMap) return;

		const changes = this.ensurePendingObjectChanges();
		if (changes.deleted.has(objectId)) return;
		if (changes.added.has(objectId)) {
			changes.added.set(objectId, yMapToObject(yMap as Y.Map<unknown>));
			return;
		}
		changes.updated.set(objectId, yMapToObject(yMap as Y.Map<unknown>));
	}

	/** Track object delete in current transaction */
	private trackObjectDeleted(objectId: string): void {
		if (this.suppressObjectTracking) return;
		const changes = this.ensurePendingObjectChanges();
		changes.added.delete(objectId);
		changes.updated.delete(objectId);
		changes.deleted.add(objectId);
	}

	// --- Sync ---

	/**
	 * Sync Yjs state to Valtio rendererState
	 */
	private syncYjsToValtio(): void {
		if (this.suppressSync) return;

		try {
			const objectChanges = this.pendingObjectChanges;
			const needsFull = this.needsFullSync;
			const needsLayers = this.needsLayerSync;
			const undoRedo = this.isUndoRedoInProgress;

			// Reset pending state
			this.pendingObjectChanges = null;
			this.needsFullSync = false;
			this.needsLayerSync = false;

			// Full sync when explicitly requested OR when layers + objects change together
			// (e.g. addElement modifies both yObjects and yLayers in one transaction)
			if (needsFull || (needsLayers && objectChanges)) {
				const document = extractDocumentFromYDoc(this.ydoc);
				this.callbacks.onDocumentUpdate(document);

				// Set current layer to first layer if not set or invalid
				const currentLayerId = this.callbacks.getCurrentLayerId();
				if (
					!currentLayerId ||
					!document.layers.find((l) => l.id === currentLayerId)
				) {
					if (document.layers.length > 0) {
						this.callbacks.setCurrentLayerId(document.layers[0].id);
					}
				}

				this.callbacks.onSyncApplied?.({ syncKind: "full", undoRedo });
				return;
			}

			if (needsLayers) {
				const layers = extractLayersFromYDoc(this.ydoc);
				this.callbacks.onLayersUpdate(layers);

				// Validate currentLayerId against updated layers
				const currentLayerId = this.callbacks.getCurrentLayerId();
				if (!currentLayerId || !layers.find((l) => l.id === currentLayerId)) {
					if (layers.length > 0) {
						this.callbacks.setCurrentLayerId(layers[0].id);
					}
				}

				this.callbacks.onSyncApplied?.({ syncKind: "delta", undoRedo });
			}

			// Delta application: apply objects independently
			const hasObjectChanges =
				objectChanges &&
				this.callbacks.onObjectsChange &&
				(objectChanges.added.size > 0 ||
					objectChanges.updated.size > 0 ||
					objectChanges.deleted.size > 0);

			if (!hasObjectChanges) return;

			this.callbacks.onObjectsChange!(objectChanges);

			this.callbacks.onSyncApplied?.({ syncKind: "delta", undoRedo });
		} catch (error) {
			console.error(
				"syncYjsToValtio threw — spatial index may be corrupt",
				error,
			);
		}
	}

	// --- Element Operations ---

	/**
	 * Add an element to a layer
	 */
	public addElement(
		layerId: string,
		element: AnyArtObject,
		origin?: unknown,
		insertIndex?: number,
	): void {
		this.ydoc.transact(() => {
			// Store object in yObjects
			this.yObjects.set(element.id, this.objectToYMap(element));

			// Add ID to layer's elementIds
			const yLayer = this.findYLayer(layerId);
			if (!yLayer) {
				console.warn("addElement: layer not found in Yjs", layerId);
				return;
			}

			const yElementIds = this.getYElementIds(yLayer);
			if (yElementIds) {
				if (insertIndex === undefined) {
					yElementIds.push([element.id]);
				} else {
					yElementIds.insert(
						Math.max(0, Math.min(insertIndex, yElementIds.length)),
						[element.id],
					);
				}
			}
		}, origin);
	}

	/** Add an object to the document's object map without inserting it into any layer. */
	public addObjectOnly(element: AnyArtObject, origin?: unknown): void {
		this.ydoc.transact(() => {
			this.yObjects.set(element.id, this.objectToYMap(element));
		}, origin);
	}

	/**
	 * Delete elements from layers in a single transaction.
	 * @param elementsByLayer - Map of layerId to array of elementIds to delete
	 */
	public deleteElements(
		elementsByLayer: Record<string, string[]>,
		origin?: unknown,
	): void {
		this.ydoc.transact(() => {
			const allDeletedIds: string[] = [];

			for (const ids of Object.values(elementsByLayer)) {
				for (const id of ids) {
					this.yObjects.delete(id);
					allDeletedIds.push(id);
				}
			}

			for (const [layerId, ids] of Object.entries(elementsByLayer)) {
				const yLayer = this.findYLayer(layerId);
				if (!yLayer) continue;

				const yElementIds = this.getYElementIds(yLayer);
				if (!yElementIds) continue;

				const deleteSet = new Set(ids);
				for (let i = yElementIds.length - 1; i >= 0; i--) {
					if (deleteSet.has(yElementIds.get(i))) {
						yElementIds.delete(i, 1);
					}
				}
			}
		}, origin);
	}

	/**
	 * Reorder elements in a layer
	 */
	public reorderElements(
		layerId: string,
		oldIndex: number,
		newIndex: number,
		origin?: unknown,
	): void {
		this.ydoc.transact(() => {
			const yLayer = this.findYLayer(layerId);
			if (!yLayer) return;

			const yElementIds = this.getYElementIds(yLayer);
			if (!yElementIds) return;

			const id = yElementIds.get(oldIndex);
			if (id == null) return;

			yElementIds.delete(oldIndex, 1);
			yElementIds.insert(newIndex, [id]);
		}, origin);
	}

	/**
	 * Move an element from one layer to another (by ID)
	 */
	public moveElementToLayer(
		sourceLayerId: string,
		elementId: string,
		targetLayerId: string,
		targetIndex?: number,
		origin?: unknown,
	): void {
		this.ydoc.transact(() => {
			const sourceYLayer = this.findYLayer(sourceLayerId);
			const targetYLayer = this.findYLayer(targetLayerId);
			if (!sourceYLayer || !targetYLayer) {
				console.error("Source or target layer not found");
				return;
			}

			const sourceIds = this.getYElementIds(sourceYLayer);
			const targetIds = this.getYElementIds(targetYLayer);
			if (!sourceIds || !targetIds) {
				console.error("Source or target elementIds array not found");
				return;
			}

			// Remove from source
			for (let i = 0; i < sourceIds.length; i++) {
				if (sourceIds.get(i) === elementId) {
					sourceIds.delete(i, 1);
					break;
				}
			}

			// Insert into target
			if (targetIndex !== undefined && targetIndex >= 0) {
				targetIds.insert(targetIndex, [elementId]);
			} else {
				targetIds.push([elementId]);
			}
			// Object stays in yObjects unchanged
		}, origin);
	}

	/**
	 * Clear all document data from Yjs.
	 * Used before connecting to a collaboration room to discard local document state.
	 */
	public clearDocument(): void {
		this.ydoc.transact(() => {
			this.yObjects.forEach((_, key) => {
				this.yObjects.delete(key);
			});
			while (this.yLayers.length > 0) this.yLayers.delete(0);
			while (this.yArtboards.length > 0) this.yArtboards.delete(0);
			this.yFiles.forEach((_, key) => {
				this.yFiles.delete(key);
			});
			this.yBrushPresets.forEach((_, key) => {
				this.yBrushPresets.delete(key);
			});
			this.yDefs.forEach((_, key) => {
				this.yDefs.delete(key);
			});
			this.yReferences3d.forEach((_, key) => {
				this.yReferences3d.delete(key);
			});
		});

		this.clearUndoHistory();
	}

	/**
	 * Initialize Yjs from a complete Document (objects + layers).
	 * Used for local-only mode to sync the initial document into Yjs in a single transaction.
	 */
	public initializeDocument(doc: Document): void {
		this.ydoc.transact(() => {
			this.populateYjsFromDocument(doc);
		});
	}

	/**
	 * Replace all Yjs document data with a new Document in a single transaction.
	 * Clears existing data, populates new data, and resets undo history.
	 * Used by importDocument to keep Yjs in sync with Valtio.
	 */
	public replaceDocument(doc: Document): void {
		// Suppress object tracking and syncYjsToValtio during the transaction.
		// The caller already has the Document — re-extracting from Yjs is redundant.
		this.suppressObjectTracking = true;
		this.suppressSync = true;

		this.ydoc.transact(() => {
			// Clear existing data
			this.yObjects.forEach((_, key) => {
				this.yObjects.delete(key);
			});
			while (this.yLayers.length > 0) this.yLayers.delete(0);
			while (this.yArtboards.length > 0) this.yArtboards.delete(0);
			this.yFiles.forEach((_, key) => {
				this.yFiles.delete(key);
			});
			this.yBrushPresets.forEach((_, key) => {
				this.yBrushPresets.delete(key);
			});
			this.yDefs.forEach((_, key) => {
				this.yDefs.delete(key);
			});
			this.yReferences3d.forEach((_, key) => {
				this.yReferences3d.delete(key);
			});
			this.yMeta.delete("hdr");
			this.yMeta.delete("colorProfile");
			this.yMeta.delete("rasterizationDpi");

			// Populate with new document
			this.populateYjsFromDocument(doc);
		});

		this.suppressObjectTracking = false;
		this.suppressSync = false;

		// Discard any accumulated state from observers that fired before guards took effect
		this.pendingObjectChanges = null;
		this.needsFullSync = false;

		// Directly sync the document to Valtio (bypassing extractDocumentFromYDoc)
		this.callbacks.onDocumentUpdate(doc);

		// Set current layer
		const currentLayerId = this.callbacks.getCurrentLayerId();
		if (!currentLayerId || !doc.layers.find((l) => l.id === currentLayerId)) {
			if (doc.layers.length > 0) {
				this.callbacks.setCurrentLayerId(doc.layers[0].id);
			}
		}

		this.callbacks.onSyncApplied?.({ syncKind: "full", undoRedo: false });

		this.clearUndoHistory();
	}

	private populateYjsFromDocument(doc: Document): void {
		for (const [id, obj] of Object.entries(doc.objects)) {
			this.yObjects.set(id, this.objectToYMap(obj));
		}

		for (const layer of doc.layers) {
			const yLayer = new Y.Map<unknown>();
			yLayer.set("id", layer.id);
			yLayer.set("name", layer.name);
			yLayer.set("visible", layer.visible);
			yLayer.set("locked", layer.locked);
			yLayer.set("opacity", layer.opacity);
			yLayer.set("blendMode", layer.blendMode ?? "normal");
			if (layer.transientKind !== undefined) {
				yLayer.set("transientKind", layer.transientKind);
			}
			if (layer.ownerClientId !== undefined) {
				yLayer.set("ownerClientId", layer.ownerClientId);
			}

			const yElementIds = new Y.Array<string>();
			for (const id of layer.elementIds) {
				yElementIds.push([id]);
			}
			yLayer.set("elementIds", yElementIds);

			this.yLayers.push([yLayer]);
		}

		for (const artboard of doc.artboards) {
			this.yArtboards.push([artboard]);
		}

		for (const file of doc.files) {
			this.yFiles.set(file.uid, {
				uid: file.uid,
				name: file.name,
				type: file.type,
				hash: file.hash,
				bin: new Uint8Array(file.bin),
			});
		}

		for (const preset of doc.brushPresets) {
			// Defense-in-depth: normalize in case doc.brushPresets carries a
			// legacy v1 shape (textureFileUid + defaultSettings) from a caller
			// other than the papf reader (which already normalizes).
			const normalized = normalizeBrushPreset(preset);
			const yPreset = new Y.Map<unknown>();
			yPreset.set("uid", normalized.uid);
			yPreset.set("name", normalized.name);
			yPreset.set("settings", JSON.stringify(normalized.settings));
			this.yBrushPresets.set(normalized.uid, yPreset);
		}

		const defs = doc.defs ?? {};
		for (const [defId, entry] of Object.entries(defs)) {
			this.yDefs.set(defId, this.defEntryToYMap(entry));
		}

		const references3d = doc.references3d ?? {};
		for (const [sceneId, def] of Object.entries(references3d)) {
			this.yReferences3d.set(sceneId, this.reference3DDefToYMap(def));
		}

		this.yMeta.set(
			"hdr",
			JSON.stringify(doc.hdr ?? { enabled: false, exposure: 0 }),
		);
		this.yMeta.set(
			"colorProfile",
			JSON.stringify(doc.colorProfile ?? { workingSpace: "display-p3" }),
		);
		this.yMeta.set("rasterizationDpi", doc.rasterizationDpi ?? 72);
	}

	/**
	 * Add a new layer
	 */
	public addLayer(layer: Layer): void {
		this.ydoc.transact(() => {
			const yLayer = new Y.Map<unknown>();
			yLayer.set("id", layer.id);
			yLayer.set("name", layer.name);
			yLayer.set("visible", layer.visible);
			yLayer.set("locked", layer.locked);
			yLayer.set("opacity", layer.opacity);
			yLayer.set("blendMode", layer.blendMode ?? "normal");
			if (layer.transientKind !== undefined) {
				yLayer.set("transientKind", layer.transientKind);
			}
			if (layer.ownerClientId !== undefined) {
				yLayer.set("ownerClientId", layer.ownerClientId);
			}

			const yElementIds = new Y.Array<string>();
			for (const id of layer.elementIds) {
				yElementIds.push([id]);
			}
			yLayer.set("elementIds", yElementIds);

			this.yLayers.push([yLayer]);
		});
	}

	/**
	 * Delete a layer by ID
	 */
	public deleteLayer(
		layerId: string,
		options?: { deleteObjects?: boolean },
		origin?: unknown,
	): void {
		const shouldDeleteObjects = options?.deleteObjects !== false;
		this.ydoc.transact(() => {
			for (let i = 0; i < this.yLayers.length; i++) {
				const yLayer = this.yLayers.get(i);
				if (yLayer && yLayer.get("id") === layerId) {
					// Also remove all objects referenced by this layer's elementIds
					if (shouldDeleteObjects) {
						const yElementIds = this.getYElementIds(yLayer);
						if (yElementIds) {
							for (let j = 0; j < yElementIds.length; j++) {
								const objId = yElementIds.get(j);
								if (objId) this.yObjects.delete(objId);
							}
						}
					}

					this.yLayers.delete(i, 1);
					return;
				}
			}
		}, origin);
	}

	/**
	 * Reorder layers by index.
	 */
	public reorderLayers(oldIndex: number, newIndex: number): void {
		this.ydoc.transact(() => {
			if (
				oldIndex < 0 ||
				newIndex < 0 ||
				oldIndex >= this.yLayers.length ||
				newIndex >= this.yLayers.length
			) {
				return;
			}
			if (oldIndex === newIndex) return;

			const yLayer = this.yLayers.get(oldIndex);
			if (!yLayer) return;
			const clonedLayer = yLayer.clone();

			this.yLayers.delete(oldIndex, 1);
			this.yLayers.insert(newIndex, [clonedLayer]);
		});
	}

	/**
	 * Update layer attributes (name, visible, locked, opacity)
	 */
	public updateLayerAttributes(
		layerId: string,
		updates: Partial<Omit<Layer, "id" | "elementIds">>,
	): void {
		this.ydoc.transact(() => {
			const yLayer = this.findYLayer(layerId);
			if (!yLayer) {
				console.warn(`Layer not found for attribute update: ${layerId}`);
				return;
			}

			for (const [key, value] of Object.entries(updates)) {
				yLayer.set(key, value);
			}
		});
	}

	/**
	 * Update an element's properties
	 */
	public updateElement(
		_layerId: string,
		elementId: string,
		updates: Partial<AnyArtObject>,
		origin?: unknown,
	): void {
		this.ydoc.transact(() => {
			const yObj = this.yObjects.get(elementId);
			if (!yObj) {
				console.warn(`Object not found in yObjects: ${elementId}`);
				return;
			}

			for (const [key, value] of Object.entries(updates)) {
				if (key === "id" || key === "type") continue; // immutable fields

				if (JSON_FIELDS.has(key)) {
					if (value === undefined || value === null) {
						yObj.delete(key);
					} else {
						yObj.set(key, JSON.stringify(value));
					}
				} else if (SCALAR_FIELDS.has(key)) {
					if (value === undefined) {
						yObj.delete(key);
					} else {
						yObj.set(key, value);
					}
				}
			}
		}, origin);
	}

	/**
	 * Batch update multiple elements in a single Yjs transaction.
	 * Used to ensure multi-element operations (move, rotate) are sent atomically to collaborators.
	 */
	public batchUpdateElements(
		elementUpdates: Array<{
			elementId: string;
			updates: Partial<AnyArtObject>;
		}>,
		origin?: unknown,
	): void {
		this.ydoc.transact(() => {
			for (const { elementId, updates } of elementUpdates) {
				const yObj = this.yObjects.get(elementId);
				if (!yObj) continue;

				for (const [key, value] of Object.entries(updates)) {
					if (key === "id" || key === "type") continue;

					if (JSON_FIELDS.has(key)) {
						if (value === undefined || value === null) {
							yObj.delete(key);
						} else {
							yObj.set(key, JSON.stringify(value));
						}
					} else if (SCALAR_FIELDS.has(key)) {
						if (value === undefined) {
							yObj.delete(key);
						} else {
							yObj.set(key, value);
						}
					}
				}
			}
		}, origin);
	}

	/**
	 * Split a path at a specific anchor point
	 * Deletes the original path and creates two new paths
	 */
	public splitPath(
		layerId: string,
		pathId: string,
		segmentIndex: number,
		pointType: "start" | "end",
		origin?: unknown,
	): void {
		this.ydoc.transact(() => {
			// Get path object from yObjects
			const yPath = this.yObjects.get(pathId);
			if (!yPath) {
				console.warn(`Path not found in yObjects: ${pathId}`);
				return;
			}

			const path = yMapToObject(yPath) as Path;
			if (path.type !== "path") {
				console.warn(`Object ${pathId} is not a path`);
				return;
			}

			// Split the path
			const result = splitPathAtAnchor(path, segmentIndex, pointType);
			if (!result) {
				console.warn(
					`Cannot split path at segment ${segmentIndex} (${pointType})`,
				);
				return;
			}

			const [firstPath, secondPath] = result;

			// Add both new paths to yObjects
			this.yObjects.set(firstPath.id, this.objectToYMap(firstPath));
			this.yObjects.set(secondPath.id, this.objectToYMap(secondPath));

			this.replacePathElementIds(layerId, pathId, [
				firstPath.id,
				secondPath.id,
			]);

			// Remove old path from yObjects
			this.yObjects.delete(pathId);
		}, origin);
	}

	/**
	 * Replace a path element with several new paths built from the given
	 * segment runs (style copied from the original). Used when break-deleting
	 * anchors, which can cut one path into multiple.
	 */
	public replacePathWithPaths(
		layerId: string,
		pathId: string,
		segmentLists: CubicBezierSegment[][],
		origin?: unknown,
	): void {
		if (segmentLists.length === 0) return;
		this.ydoc.transact(() => {
			const yPath = this.yObjects.get(pathId);
			if (!yPath) {
				console.warn(`Path not found in yObjects: ${pathId}`);
				return;
			}

			const path = yMapToObject(yPath) as Path;
			if (path.type !== "path") {
				console.warn(`Object ${pathId} is not a path`);
				return;
			}

			const newPaths = createPathsFromSegmentLists(path, segmentLists);
			for (const newPath of newPaths) {
				this.yObjects.set(newPath.id, this.objectToYMap(newPath));
			}

			this.replacePathElementIds(
				layerId,
				pathId,
				newPaths.map((p) => p.id),
			);

			this.yObjects.delete(pathId);
		}, origin);
	}

	/** Swap pathId for newIds in the layer's elementIds and any group childIds. */
	private replacePathElementIds(
		layerId: string,
		pathId: string,
		newIds: string[],
	): void {
		// Find pathId in layer's elementIds and replace
		const yLayer = this.findYLayer(layerId);
		if (yLayer) {
			const yElementIds = this.getYElementIds(yLayer);
			if (yElementIds) {
				for (let i = 0; i < yElementIds.length; i++) {
					if (yElementIds.get(i) === pathId) {
						yElementIds.delete(i, 1);
						yElementIds.insert(i, [...newIds]);
						break;
					}
				}
			}
		}

		// Check if path is in any group's childIds and update
		for (const [_id, yObj] of this.yObjects.entries()) {
			const childIdsJson =
				yObj.get("type") === "group"
					? (yObj.get("childIds") as string | undefined)
					: undefined;
			if (childIdsJson) {
				const childIds = JSON.parse(childIdsJson) as string[];
				const idx = childIds.indexOf(pathId);
				if (idx !== -1) {
					childIds.splice(idx, 1, ...newIds);
					yObj.set("childIds", JSON.stringify(childIds));
				}
			}

			// A clip mask that got replaced keeps clipping through its leading
			// run; the remaining runs become ordinary siblings. Without this the
			// reference dangles and the clip silently stops applying.
			const clipPathIdJson = yObj.get("clipPathId") as string | undefined;
			if (clipPathIdJson) {
				const clipPathId = JSON.parse(clipPathIdJson) as string | null;
				if (clipPathId === pathId) {
					yObj.set("clipPathId", JSON.stringify(newIds[0] ?? null));
				}
			}
		}
	}

	/**
	 * Merge two paths at their endpoints into a single continuous path.
	 * Deletes both original paths and creates one merged path.
	 */
	public mergePaths(
		layerId: string,
		pathIdA: string,
		endpointA: "start" | "end",
		pathIdB: string,
		endpointB: "start" | "end",
		origin?: unknown,
	): void {
		this.ydoc.transact(() => {
			const yPathA = this.yObjects.get(pathIdA);
			const yPathB = this.yObjects.get(pathIdB);
			if (!yPathA || !yPathB) {
				console.warn(
					`Path not found in yObjects: ${!yPathA ? pathIdA : pathIdB}`,
				);
				return;
			}

			const pathA = yMapToObject(yPathA) as Path;
			const pathB = yMapToObject(yPathB) as Path;
			if (pathA.type !== "path" || pathB.type !== "path") {
				console.warn("One or both objects are not paths");
				return;
			}

			// Determine which path is frontmost (higher index = rendered on top)
			const yLayer = this.findYLayer(layerId);
			let frontmostPath: Path | undefined;
			let frontId: string | undefined;
			let backId: string | undefined;

			if (yLayer) {
				const yElementIds = this.getYElementIds(yLayer);
				if (yElementIds) {
					let idxA = -1;
					let idxB = -1;
					for (let i = 0; i < yElementIds.length; i++) {
						const eid = yElementIds.get(i);
						if (eid === pathIdA) idxA = i;
						if (eid === pathIdB) idxB = i;
					}
					if (idxA >= 0 && idxB >= 0) {
						frontmostPath = idxA > idxB ? pathA : pathB;
						frontId = idxA > idxB ? pathIdA : pathIdB;
						backId = idxA > idxB ? pathIdB : pathIdA;
					}
				}
			}

			const merged = mergePathsAtEndpoints(
				pathA,
				endpointA,
				pathB,
				endpointB,
				frontmostPath,
			);

			// Add merged path to yObjects
			this.yObjects.set(merged.id, this.objectToYMap(merged));

			// Place merged path at the frontmost path's position in elementIds
			if (yLayer) {
				const yElementIds = this.getYElementIds(yLayer);
				if (yElementIds) {
					const replaceId = frontId ?? pathIdA;
					const removeId = backId ?? pathIdB;

					// Replace frontmost with merged
					for (let i = 0; i < yElementIds.length; i++) {
						if (yElementIds.get(i) === replaceId) {
							yElementIds.delete(i, 1);
							yElementIds.insert(i, [merged.id]);
							break;
						}
					}
					// Remove the other path
					for (let i = 0; i < yElementIds.length; i++) {
						if (yElementIds.get(i) === removeId) {
							yElementIds.delete(i, 1);
							break;
						}
					}
				}
			}

			// Update group childIds for both paths
			const replaceInGroupId = frontId ?? pathIdA;
			const removeFromGroupId = backId ?? pathIdB;
			for (const [_id, yObj] of this.yObjects.entries()) {
				if (yObj.get("type") === "group") {
					const childIdsJson = yObj.get("childIds") as string | undefined;
					if (!childIdsJson) continue;

					const childIds = JSON.parse(childIdsJson) as string[];
					const idxReplace = childIds.indexOf(replaceInGroupId);
					const idxRemove = childIds.indexOf(removeFromGroupId);

					if (idxReplace !== -1 || idxRemove !== -1) {
						if (idxReplace !== -1) {
							childIds[idxReplace] = merged.id;
						}
						if (idxRemove !== -1) {
							childIds.splice(idxRemove, 1);
						}
						yObj.set("childIds", JSON.stringify(childIds));
					}
				}
			}

			// Remove both original paths
			this.yObjects.delete(pathIdA);
			this.yObjects.delete(pathIdB);
		}, origin);
	}

	// --- Group Operations ---

	/**
	 * Create a group from elements at specified IDs
	 * Normalized: children are removed from layer.elementIds, stored in group.childIds
	 */
	public groupElements(
		layerId: string,
		elementIds: string[],
		origin?: unknown,
	): string | null {
		let groupId: string | null = null;

		this.ydoc.transact(() => {
			const yLayer = this.findYLayer(layerId);
			if (!yLayer) return;

			const yElementIds = this.getYElementIds(yLayer);
			if (!yElementIds) return;

			if (elementIds.length < 2) return;

			// Find the minimum index among elementIds in yElementIds
			let minIndex = Number.MAX_SAFE_INTEGER;
			for (let i = 0; i < yElementIds.length; i++) {
				if (elementIds.includes(yElementIds.get(i))) {
					minIndex = Math.min(minIndex, i);
				}
			}

			if (minIndex === Number.MAX_SAFE_INTEGER) return;

			// Create group object
			groupId = `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			const group: Group = {
				type: "group",
				id: groupId,
				childIds: elementIds,
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
				filters: [createDefaultContentAppearance()],
			};

			// Add group to yObjects
			this.yObjects.set(groupId, this.objectToYMap(group));

			// Remove all elementIds from yElementIds (reverse order for safe deletion)
			const indicesToRemove: number[] = [];
			for (let i = 0; i < yElementIds.length; i++) {
				if (elementIds.includes(yElementIds.get(i))) {
					indicesToRemove.push(i);
				}
			}
			for (let i = indicesToRemove.length - 1; i >= 0; i--) {
				yElementIds.delete(indicesToRemove[i], 1);
			}

			// Insert groupId at the minimum position
			// After deletions, the insertion index shifts down by the number of deleted items before minIndex
			const deletedBefore = indicesToRemove.filter(
				(idx) => idx < minIndex,
			).length;
			const insertAt = minIndex - deletedBefore;
			yElementIds.insert(insertAt, [groupId]);
		}, origin);

		return groupId;
	}

	/**
	 * Convert a text element into an outlined group in a single transaction.
	 * Adds all paths to yObjects (not layer.elementIds), creates the group,
	 * hides the original text element, and replaces the text element's position
	 * in the layer with the group.
	 */
	public outlineTextElement(
		layerId: string,
		textElementId: string,
		paths: AnyArtObject[],
		group: Group,
	): void {
		this.ydoc.transact(() => {
			const yLayer = this.findYLayer(layerId);
			if (!yLayer) return;

			const yElementIds = this.getYElementIds(yLayer);
			if (!yElementIds) return;

			// Find text element's index in layer
			let textIndex = -1;
			for (let i = 0; i < yElementIds.length; i++) {
				if (yElementIds.get(i) === textElementId) {
					textIndex = i;
					break;
				}
			}
			if (textIndex === -1) return;

			// Add all paths to yObjects (NOT to layer.elementIds)
			for (const path of paths) {
				this.yObjects.set(path.id, this.objectToYMap(path));
			}

			// Add group to yObjects
			this.yObjects.set(group.id, this.objectToYMap(group));

			// Hide original text element
			const yText = this.yObjects.get(textElementId);
			if (yText) {
				yText.set("visible", false);
			}

			// Replace text element in layer.elementIds with group
			yElementIds.delete(textIndex, 1);
			yElementIds.insert(textIndex, [group.id]);
		});
	}

	/**
	 * Ungroup a group - restore children to layer elementIds
	 * Normalized: children are moved back from group.childIds to layer.elementIds
	 */
	public ungroupElements(layerId: string, groupId: string): void {
		this.ydoc.transact(() => {
			// Get group from yObjects
			const yGroup = this.yObjects.get(groupId);
			if (!yGroup) return;

			const childIdsJson = yGroup.get("childIds") as string | undefined;
			const childIds: string[] = childIdsJson ? JSON.parse(childIdsJson) : [];

			// Find groupId's index in layer elementIds
			const yLayer = this.findYLayer(layerId);
			if (!yLayer) return;

			const yElementIds = this.getYElementIds(yLayer);
			if (!yElementIds) return;

			let groupIndex = -1;
			for (let i = 0; i < yElementIds.length; i++) {
				if (yElementIds.get(i) === groupId) {
					groupIndex = i;
					break;
				}
			}

			if (groupIndex === -1) return;

			// Remove groupId from elementIds
			yElementIds.delete(groupIndex, 1);

			// Insert all childIds at that position
			if (childIds.length > 0) {
				yElementIds.insert(groupIndex, childIds);
			}

			// Delete group from yObjects
			this.yObjects.delete(groupId);
		});
	}

	/**
	 * Extract a child element from a group and add it back to layer elementIds.
	 */
	public extractChildFromGroup(
		groupId: string,
		childId: string,
		layerId: string,
		insertIndex?: number,
	): void {
		this.ydoc.transact(() => {
			const yGroup = this.yObjects.get(groupId);
			if (!yGroup) return;

			const childIdsJson = yGroup.get("childIds") as string | undefined;
			const childIds: string[] = childIdsJson ? JSON.parse(childIdsJson) : [];
			const newChildIds = childIds.filter((id) => id !== childId);
			yGroup.set("childIds", JSON.stringify(newChildIds));

			const yLayer = this.findYLayer(layerId);
			if (!yLayer) return;

			const elementIds = this.getYElementIds(yLayer);
			if (!elementIds) return;

			if (insertIndex != null) {
				elementIds.insert(insertIndex, [childId]);
			} else {
				elementIds.push([childId]);
			}
		});
	}

	/**
	 * Reorder children within a group's childIds.
	 */
	public reorderGroupChildren(
		groupId: string,
		fromIndex: number,
		toIndex: number,
	): void {
		this.ydoc.transact(() => {
			const yGroup = this.yObjects.get(groupId);
			if (!yGroup) return;

			const childIdsJson = yGroup.get("childIds") as string | undefined;
			const childIds: string[] = childIdsJson ? JSON.parse(childIdsJson) : [];
			if (fromIndex < 0 || fromIndex >= childIds.length) return;
			if (toIndex < 0 || toIndex >= childIds.length) return;

			const [moved] = childIds.splice(fromIndex, 1);
			childIds.splice(toIndex, 0, moved);
			yGroup.set("childIds", JSON.stringify(childIds));
		});
	}

	/**
	 * Extract a source out of a blend and restore it into a layer's elementIds.
	 * The caller guarantees >= 2 sources remain (otherwise it uses releaseBlend
	 * instead). Bakes the blend's transform into the extracted source only when
	 * non-identity, mirroring releaseBlend, so it lands where it was drawn.
	 */
	public extractChildFromBlend(
		blendId: string,
		childId: string,
		layerId: string,
		insertIndex?: number,
	): void {
		this.ydoc.transact(() => {
			const yBlend = this.yObjects.get(blendId);
			if (!yBlend) return;

			const objectIdsJson = yBlend.get("objectIds") as string | undefined;
			const objectIds: string[] = objectIdsJson
				? JSON.parse(objectIdsJson)
				: [];
			const newObjectIds = objectIds.filter((id) => id !== childId);
			if (newObjectIds.length === objectIds.length) return;
			yBlend.set("objectIds", JSON.stringify(newObjectIds));

			// Keep the paint order (renderOrder) in sync when present.
			const renderOrderJson = yBlend.get("renderOrder") as string | undefined;
			if (renderOrderJson) {
				const renderOrder: string[] = JSON.parse(renderOrderJson);
				yBlend.set(
					"renderOrder",
					JSON.stringify(renderOrder.filter((id) => id !== childId)),
				);
			}

			const blendTransform = yBlend.has("transform")
				? (JSON.parse(yBlend.get("transform") as string) as ElementTransform)
				: null;
			if (blendTransform && !isIdentityTransform(blendTransform)) {
				const yObj = this.yObjects.get(childId);
				if (yObj) {
					const st = yObj.has("transform")
						? (JSON.parse(yObj.get("transform") as string) as ElementTransform)
						: createIdentityTransform();
					yObj.set(
						"transform",
						JSON.stringify(composeTransforms(blendTransform, st)),
					);
				}
			}

			const yLayer = this.findYLayer(layerId);
			if (!yLayer) return;
			const elementIds = this.getYElementIds(yLayer);
			if (!elementIds) return;
			if (insertIndex != null) {
				elementIds.insert(insertIndex, [childId]);
			} else {
				elementIds.push([childId]);
			}
		});
	}

	/**
	 * Reorder a blend's front-to-back paint order (renderOrder). Only the paint
	 * stacking changes; objectIds (the morph chain, key positions and intermediate
	 * geometry) is untouched. renderOrder defaults to objectIds order when unset.
	 */
	public reorderBlendChildren(
		blendId: string,
		fromIndex: number,
		toIndex: number,
	): void {
		this.ydoc.transact(() => {
			const yBlend = this.yObjects.get(blendId);
			if (!yBlend) return;

			const objectIdsJson = yBlend.get("objectIds") as string | undefined;
			const objectIds: string[] = objectIdsJson
				? JSON.parse(objectIdsJson)
				: [];
			const renderOrderJson = yBlend.get("renderOrder") as string | undefined;
			const order: string[] = renderOrderJson
				? JSON.parse(renderOrderJson)
				: [...objectIds];
			if (fromIndex < 0 || fromIndex >= order.length) return;
			if (toIndex < 0 || toIndex >= order.length) return;

			const [moved] = order.splice(fromIndex, 1);
			order.splice(toIndex, 0, moved);
			yBlend.set("renderOrder", JSON.stringify(order));
		});
	}

	/**
	 * Add element to a group's childIds and remove from layer elementIds
	 */
	public addElementToGroup(
		layerId: string,
		groupId: string,
		elementId: string,
		origin?: unknown,
		insertIndex?: number,
	): void {
		this.ydoc.transact(() => {
			// Update group's childIds
			const yGroup = this.yObjects.get(groupId);
			if (!yGroup) return;

			const childIdsJson = yGroup.get("childIds") as string | undefined;
			const childIds: string[] = childIdsJson ? JSON.parse(childIdsJson) : [];
			if (insertIndex === undefined) {
				childIds.push(elementId);
			} else {
				childIds.splice(
					Math.max(0, Math.min(insertIndex, childIds.length)),
					0,
					elementId,
				);
			}
			yGroup.set("childIds", JSON.stringify(childIds));

			// Remove elementId from layer's elementIds
			const yLayer = this.findYLayer(layerId);
			if (!yLayer) return;

			const yElementIds = this.getYElementIds(yLayer);
			if (!yElementIds) return;

			for (let i = 0; i < yElementIds.length; i++) {
				if (yElementIds.get(i) === elementId) {
					yElementIds.delete(i, 1);
					break;
				}
			}
		}, origin);
	}

	/**
	 * Add an element as a source to a CompoundPath.
	 * Appends to sources with default op="union" and removes the element from
	 * the layer's elementIds.
	 */
	public addSourceToCompoundPath(
		layerId: string,
		compoundPathId: string,
		elementId: string,
		op: string = "union",
		origin?: unknown,
	): void {
		this.ydoc.transact(() => {
			const yCompound = this.yObjects.get(compoundPathId);
			if (!yCompound) return;

			const sourcesJson = yCompound.get("sources") as string | undefined;
			const sources: Array<{ id: string; op: string }> = sourcesJson
				? JSON.parse(sourcesJson)
				: [];
			sources.push({ id: elementId, op });
			yCompound.set("sources", JSON.stringify(sources));

			// Remove elementId from layer's elementIds
			const yLayer = this.findYLayer(layerId);
			if (!yLayer) return;

			const yElementIds = this.getYElementIds(yLayer);
			if (!yElementIds) return;

			for (let i = 0; i < yElementIds.length; i++) {
				if (yElementIds.get(i) === elementId) {
					yElementIds.delete(i, 1);
					break;
				}
			}
		}, origin);
	}

	/**
	 * Extract a source from a CompoundPath back to the layer's top-level elements.
	 * Unlike removeSourceFromCompoundPath, this preserves the element in yObjects.
	 */
	public extractSourceFromCompoundPath(
		compoundPathId: string,
		elementId: string,
		layerId: string,
		insertIndex?: number,
		origin?: unknown,
	): void {
		this.ydoc.transact(() => {
			const yCompound = this.yObjects.get(compoundPathId);
			if (!yCompound) return;

			const sourcesJson = yCompound.get("sources") as string | undefined;
			const sources: Array<{ id: string; op: string }> = sourcesJson
				? JSON.parse(sourcesJson)
				: [];
			const filtered = sources.filter((s) => s.id !== elementId);
			yCompound.set("sources", JSON.stringify(filtered));
			yCompound.set("computedSegments", "[]");

			// Add element back to layer's elementIds
			const yLayer = this.findYLayer(layerId);
			if (!yLayer) return;

			const elementIds = this.getYElementIds(yLayer);
			if (!elementIds) return;

			if (insertIndex != null) {
				elementIds.insert(insertIndex, [elementId]);
			} else {
				elementIds.push([elementId]);
			}
		}, origin);
	}

	/**
	 * Reorder sources in a CompoundPath by swapping two indices.
	 */
	public reorderCompoundPathSource(
		compoundPathId: string,
		fromIndex: number,
		toIndex: number,
		origin?: unknown,
	): void {
		this.ydoc.transact(() => {
			const yCompound = this.yObjects.get(compoundPathId);
			if (!yCompound) return;

			const sourcesJson = yCompound.get("sources") as string | undefined;
			const sources: Array<{ id: string; op: string }> = sourcesJson
				? JSON.parse(sourcesJson)
				: [];

			if (
				fromIndex < 0 ||
				fromIndex >= sources.length ||
				toIndex < 0 ||
				toIndex >= sources.length
			)
				return;

			const temp = sources[fromIndex];
			sources[fromIndex] = sources[toIndex];
			sources[toIndex] = temp;
			yCompound.set("sources", JSON.stringify(sources));
		}, origin);
	}

	/**
	 * Create a group from elements that are children of a parent group.
	 * Normalized: children are removed from parentGroup.childIds, stored in new group.childIds.
	 * The new group is inserted into parentGroup.childIds at the minimum index of the selected elements.
	 */
	public groupElementsInGroup(
		parentGroupId: string,
		elementIds: string[],
		origin?: unknown,
	): string | null {
		let groupId: string | null = null;

		this.ydoc.transact(() => {
			const yParent = this.yObjects.get(parentGroupId);
			if (!yParent) return;

			const childIdsJson = yParent.get("childIds") as string | undefined;
			const childIds: string[] = childIdsJson ? JSON.parse(childIdsJson) : [];

			if (elementIds.length < 2) return;

			// Find the minimum index among elementIds in childIds
			let minIndex = Number.MAX_SAFE_INTEGER;
			for (let i = 0; i < childIds.length; i++) {
				if (elementIds.includes(childIds[i])) {
					minIndex = Math.min(minIndex, i);
				}
			}
			if (minIndex === Number.MAX_SAFE_INTEGER) return;

			// Create new group object
			groupId = `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			const group: Group = {
				type: "group",
				id: groupId,
				childIds: elementIds,
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
				filters: [createDefaultContentAppearance()],
			};
			this.yObjects.set(groupId, this.objectToYMap(group));

			// Remove selected elements from parent childIds and insert new group
			const indicesToRemove: number[] = [];
			for (let i = 0; i < childIds.length; i++) {
				if (elementIds.includes(childIds[i])) {
					indicesToRemove.push(i);
				}
			}
			const newChildIds = childIds.filter(
				(_, i) => !indicesToRemove.includes(i),
			);
			const deletedBefore = indicesToRemove.filter(
				(idx) => idx < minIndex,
			).length;
			const insertAt = minIndex - deletedBefore;
			newChildIds.splice(insertAt, 0, groupId);
			yParent.set("childIds", JSON.stringify(newChildIds));
		}, origin);

		return groupId;
	}

	/**
	 * Set clip path for a group
	 */
	public setClipPath(
		_layerId: string,
		groupId: string,
		clipPathId: string | null,
	): void {
		this.ydoc.transact(() => {
			const yGroup = this.yObjects.get(groupId);
			if (!yGroup) return;

			if (clipPathId === null) {
				yGroup.delete("clipPathId");
			} else {
				yGroup.set("clipPathId", clipPathId);
			}
		});
	}

	// --- Compound Path Operations ---

	/**
	 * Create a compound path
	 */
	public createCompoundPath(layerId: string, compoundPath: CompoundPath): void {
		this.ydoc.transact(() => {
			this.yObjects.set(compoundPath.id, this.objectToYMap(compoundPath));

			const yLayer = this.findYLayer(layerId);
			if (!yLayer) return;

			const yElementIds = this.getYElementIds(yLayer);
			if (yElementIds) {
				yElementIds.push([compoundPath.id]);
			}
		});
	}

	// --- Blend Operations ---

	/**
	 * Create a blend. Absorbs source objects (and an optional spine source) from
	 * their parent container — they stay in yObjects so release can restore them —
	 * and inserts the blend at the topmost absorbed element's position. `parentId`
	 * is either a layer id (sources are top-level) or a group id (sources are that
	 * group's children).
	 */
	public createBlend(parentId: string, blend: BlendObject): void {
		this.ydoc.transact(() => {
			this.yObjects.set(blend.id, this.objectToYMap(blend));

			const absorbed = new Set<string>(blend.objectIds);
			if (blend.spineSourceId) absorbed.add(blend.spineSourceId);
			this.absorbIntoContainer(parentId, absorbed, blend.id);
		});
	}

	/**
	 * Splice `absorbed` out of the parent container (layer elementIds Y.Array or
	 * group childIds JSON scalar) and insert `containerId` at the first absorbed
	 * slot. `parentId` is the validated common container. Shared by blend/repeat.
	 */
	private absorbIntoContainer(
		parentId: string,
		absorbed: ReadonlySet<string>,
		containerId: string,
	): void {
		const yLayer = this.findYLayer(parentId);
		if (yLayer) {
			const yElementIds = this.getYElementIds(yLayer);
			if (yElementIds)
				spliceAbsorbedIntoYArray(yElementIds, absorbed, containerId);
			return;
		}

		const yGroup = this.yObjects.get(parentId);
		if (!yGroup) return;
		const childIds: string[] = JSON.parse(
			(yGroup.get("childIds") as string | undefined) ?? "[]",
		);
		yGroup.set(
			"childIds",
			JSON.stringify(spliceAbsorbedIntoArray(childIds, absorbed, containerId)),
		);
	}

	/**
	 * Absorb the source elements into a Repeat and add it, mirroring createBlend.
	 * The sources stay in document.objects but leave the parent container, so the
	 * repeat is the only thing that renders them.
	 */
	public createRepeat(parentId: string, repeat: RepeatObject): void {
		this.ydoc.transact(() => {
			this.yObjects.set(repeat.id, this.objectToYMap(repeat));
			this.absorbIntoContainer(parentId, new Set(repeat.sourceIds), repeat.id);
		});
	}

	/** Create a mesh warp container: absorb its children and insert it in their place. */
	public createMeshWarp(parentId: string, mesh: MeshArtObject): void {
		this.ydoc.transact(() => {
			this.yObjects.set(mesh.id, this.objectToYMap(mesh));
			this.absorbIntoContainer(parentId, new Set(mesh.childIds), mesh.id);
		});
	}

	/**
	 * Release a mesh warp container: restore its absorbed children (untouched —
	 * the warp is non-destructive) and delete the container, mirroring
	 * releaseRepeat.
	 */
	public releaseMeshWarp(meshId: string): void {
		this.ydoc.transact(() => {
			const yMesh = this.yObjects.get(meshId);
			if (!yMesh) return;
			const childIdsRaw = yMesh.get("childIds") as string | undefined;
			const restoreIds: string[] = childIdsRaw ? JSON.parse(childIdsRaw) : [];
			const meshTransform = yMesh.has("transform")
				? (JSON.parse(yMesh.get("transform") as string) as ElementTransform)
				: null;
			this.restoreAbsorbedAndDeleteContainer(meshId, restoreIds, meshTransform);
		});
	}

	/**
	 * Release a repeat: restore its absorbed source objects at the repeat's
	 * position and delete the repeat, mirroring releaseBlend.
	 */
	public releaseRepeat(repeatId: string): void {
		this.ydoc.transact(() => {
			const yRepeat = this.yObjects.get(repeatId);
			if (!yRepeat) return;
			const sourceIdsRaw = yRepeat.get("sourceIds") as string | undefined;
			const restoreIds: string[] = sourceIdsRaw ? JSON.parse(sourceIdsRaw) : [];
			const repeatTransform = yRepeat.has("transform")
				? (JSON.parse(yRepeat.get("transform") as string) as ElementTransform)
				: null;
			this.restoreAbsorbedAndDeleteContainer(
				repeatId,
				restoreIds,
				repeatTransform,
			);
		});
	}

	/**
	 * Release a blend: delete the blend object and restore its absorbed source
	 * objects (and spine source) at the blend's position, into whichever container
	 * holds the blend (layer elementIds or group childIds).
	 */
	public releaseBlend(blendId: string): void {
		this.ydoc.transact(() => {
			const yBlend = this.yObjects.get(blendId);
			if (!yBlend) return;
			const objectIdsRaw = yBlend.get("objectIds") as string | undefined;
			const spineSourceId = yBlend.get("spineSourceId") as string | undefined;
			const objectIds: string[] = objectIdsRaw ? JSON.parse(objectIdsRaw) : [];
			const restoreIds = spineSourceId
				? [...objectIds, spineSourceId]
				: objectIds;
			const blendTransform = yBlend.has("transform")
				? (JSON.parse(yBlend.get("transform") as string) as ElementTransform)
				: null;
			this.restoreAbsorbedAndDeleteContainer(
				blendId,
				restoreIds,
				blendTransform,
			);
		});
	}

	/**
	 * Restore a container's absorbed source objects at the container's slot in
	 * whichever parent holds it (layer elementIds Y.Array or group childIds JSON
	 * scalar), then delete the container. Shared by releaseBlend/releaseRepeat.
	 *
	 * `containerTransform` is baked into the restored sources so they land where
	 * the container was drawn: the container's transform is applied at render time
	 * (via its transform index or, for repeat, its instance blit), but the
	 * absorbed sources' stored transforms do not include it — without this,
	 * releasing a moved container snaps the sources back to their pre-absorb spot.
	 */
	private restoreAbsorbedAndDeleteContainer(
		containerId: string,
		restoreIds: string[],
		containerTransform: ElementTransform | null,
	): void {
		if (containerTransform && !isIdentityTransform(containerTransform)) {
			for (const id of restoreIds) {
				const yObj = this.yObjects.get(id);
				if (!yObj) continue;
				const st = yObj.has("transform")
					? (JSON.parse(yObj.get("transform") as string) as ElementTransform)
					: createIdentityTransform();
				yObj.set(
					"transform",
					JSON.stringify(composeTransforms(containerTransform, st)),
				);
			}
		}

		// Layer parent: restore into elementIds (Y.Array).
		for (let li = 0; li < this.yLayers.length; li++) {
			const yLayer = this.yLayers.get(li);
			const yElementIds = yLayer ? this.getYElementIds(yLayer) : null;
			if (!yElementIds) continue;
			for (let i = 0; i < yElementIds.length; i++) {
				if (yElementIds.get(i) === containerId) {
					yElementIds.delete(i, 1);
					yElementIds.insert(i, restoreIds);
					this.yObjects.delete(containerId);
					return;
				}
			}
		}

		// Group parent: restore into childIds (JSON scalar). Locate first,
		// then mutate, to avoid editing yObjects mid-iteration.
		let targetGroup: Y.Map<unknown> | null = null;
		let targetChildIds: string[] | null = null;
		let targetIndex = -1;
		for (const [, yObj] of this.yObjects.entries()) {
			if (yObj.get("type") !== "group") continue;
			const childIds: string[] = JSON.parse(
				(yObj.get("childIds") as string | undefined) ?? "[]",
			);
			const idx = childIds.indexOf(containerId);
			if (idx !== -1) {
				targetGroup = yObj;
				targetChildIds = childIds;
				targetIndex = idx;
				break;
			}
		}
		if (targetGroup && targetChildIds && targetIndex !== -1) {
			targetChildIds.splice(targetIndex, 1, ...restoreIds);
			targetGroup.set("childIds", JSON.stringify(targetChildIds));
			this.yObjects.delete(containerId);
		}
	}

	/**
	 * Replace a blend's spine. Absorbs the new spine source from the layer and
	 * drops the previous spine (an absorbed guide — restoring it to the layer
	 * would draw it as content; keeping it would accumulate orphans on re-replace).
	 */
	public replaceBlendSpine(
		layerId: string,
		blendId: string,
		newSpineSourceId: string,
	): void {
		this.ydoc.transact(() => {
			const yBlend = this.yObjects.get(blendId);
			if (!yBlend) return;

			const yLayer = this.findYLayer(layerId);
			if (!yLayer) return;
			const yElementIds = this.getYElementIds(yLayer);
			if (!yElementIds) return;

			const previousSpineSourceId = yBlend.get("spineSourceId") as
				| string
				| undefined;

			for (let i = 0; i < yElementIds.length; i++) {
				if (yElementIds.get(i) === newSpineSourceId) {
					yElementIds.delete(i, 1);
					break;
				}
			}

			if (previousSpineSourceId && previousSpineSourceId !== newSpineSourceId) {
				this.yObjects.delete(previousSpineSourceId);
			}

			yBlend.set("spineSourceId", newSpineSourceId);
		});
	}

	// --- Undo/Redo ---

	/**
	 * Undo the last change
	 */
	public undo(): void {
		this.isUndoRedoInProgress = true;

		try {
			this.undoManager.undo();
		} finally {
			queueMicrotask(() => {
				this.isUndoRedoInProgress = false;
			});
		}
	}

	/**
	 * Redo the last undone change
	 */
	public redo(): void {
		this.isUndoRedoInProgress = true;
		try {
			this.undoManager.redo();
		} finally {
			queueMicrotask(() => {
				this.isUndoRedoInProgress = false;
			});
		}
	}

	/**
	 * Stop undo capture grouping so subsequent edits become a new stack item.
	 */
	public stopUndoCapture(): void {
		this.undoManager.stopCapturing();
	}

	/**
	 * Check if undo is available
	 */
	public canUndo(): boolean {
		return this.undoManager.canUndo();
	}

	/**
	 * Check if redo is available
	 */
	public canRedo(): boolean {
		return this.undoManager.canRedo();
	}

	/**
	 * Clear undo/redo history
	 */
	public clearUndoHistory(): void {
		this.undoManager.clear();
		this.notifyUndoRedoStateChange();
	}

	/**
	 * Build a session-scoped UndoManager that tracks only the supplied origin
	 * markers and ignores `null`-origin (main-document) operations. The main
	 * UndoManager — which only tracks `null` — therefore never records the
	 * session's edits, and the returned manager never records edits outside
	 * the session.
	 *
	 * Used by PaplicoPatternEdit: every transient operation runs under
	 * `PATTERN_EDIT_ORIGIN`, this manager observes them, and gets destroyed
	 * (clear()'d) on commit / cancel.
	 */
	public createSessionUndoManager(
		trackedOrigins: ReadonlySet<unknown>,
	): UndoManager {
		return new UndoManager(
			[this.yObjects, this.yLayers, this.yArtboards, this.yDefs],
			{
				captureTimeout: 500,
				trackedOrigins: new Set(trackedOrigins),
			},
		);
	}

	/**
	 * Notify callback of undo/redo state change
	 */
	private notifyUndoRedoStateChange(): void {
		this.callbacks.onUndoRedoStateChange?.(this.canUndo(), this.canRedo());
	}

	// --- Artboard Operations ---

	/**
	 * Add an artboard
	 */
	public addArtboard(artboard: Artboard): void {
		this.ydoc.transact(() => {
			this.yArtboards.push([artboard]);
		});
	}

	/**
	 * Update an artboard
	 */
	public updateArtboard(id: string, updates: Partial<Artboard>): void {
		this.ydoc.transact(() => {
			const artboards = this.yArtboards.toArray();
			const index = artboards.findIndex((a) => a.id === id);
			if (index !== -1) {
				const current = artboards[index];
				const updated = { ...current, ...updates };
				this.yArtboards.delete(index, 1);
				this.yArtboards.insert(index, [updated]);
			} else {
				console.warn(`Artboard not found: ${id}`);
			}
		});
	}

	/**
	 * Commit artboard move + element moves in a single Yjs transaction.
	 * Used by ArtboardTool on pointer up to batch all changes at once.
	 */
	public commitArtboardMove(
		artboardId: string,
		artboardUpdates: Partial<Artboard>,
		elementMoves: Array<{
			elementId: string;
			updates: Partial<AnyArtObject>;
		}>,
	): void {
		this.ydoc.transact(() => {
			// Update artboard
			const artboards = this.yArtboards.toArray();
			const index = artboards.findIndex((a) => a.id === artboardId);
			if (index !== -1) {
				const current = artboards[index];
				const updated = { ...current, ...artboardUpdates };
				this.yArtboards.delete(index, 1);
				this.yArtboards.insert(index, [updated]);
			}

			// Update all elements
			for (const { elementId, updates } of elementMoves) {
				const yObj = this.yObjects.get(elementId);
				if (!yObj) continue;

				for (const [key, value] of Object.entries(updates)) {
					if (key === "id" || key === "type") continue;

					if (JSON_FIELDS.has(key)) {
						if (value === undefined || value === null) {
							yObj.delete(key);
						} else {
							yObj.set(key, JSON.stringify(value));
						}
					} else if (SCALAR_FIELDS.has(key)) {
						if (value === undefined) {
							yObj.delete(key);
						} else {
							yObj.set(key, value);
						}
					}
				}
			}
		});
	}

	/**
	 * Delete an artboard
	 */
	public deleteArtboard(id: string): void {
		this.ydoc.transact(() => {
			const artboards = this.yArtboards.toArray();
			const index = artboards.findIndex((a) => a.id === id);
			if (index !== -1) {
				this.yArtboards.delete(index, 1);
			} else {
				console.warn(`Artboard not found for deletion: ${id}`);
			}
		});
	}

	// --- File Operations ---

	/**
	 * Add an embedded file.
	 * Returns the uid if already exists (by hash), or the new uid
	 */
	public addFile(file: EmbeddedFile): string {
		// Check for existing file with same hash
		for (const [uid, existing] of this.yFiles.entries()) {
			if (existing.hash === file.hash) {
				return uid;
			}
		}

		const serialized: SerializedEmbeddedFile = {
			uid: file.uid,
			name: file.name,
			type: file.type,
			hash: file.hash,
			// Store a detached copy so external mutation cannot corrupt Yjs payload.
			bin: new Uint8Array(file.bin),
		};

		this.yFiles.set(file.uid, serialized);
		return file.uid;
	}

	public addSvgImport(
		layerId: string,
		objects: Map<string, AnyArtObject>,
		files: EmbeddedFile[],
		topLevelIds: string[],
		defs: DefEntry[],
	): void {
		if (topLevelIds.length === 0) return;
		this.ydoc.transact(() => {
			for (const file of files) {
				this.yFiles.set(file.uid, {
					uid: file.uid,
					name: file.name,
					type: file.type,
					hash: file.hash,
					bin: new Uint8Array(file.bin),
				});
			}
			for (const [, obj] of objects) {
				this.yObjects.set(obj.id, this.objectToYMap(obj));
			}
			// Pattern defs materialized from <pattern>. Their member elements are
			// already written to yObjects above (createDef's precondition), so
			// register the DefEntry metadata directly within this transaction.
			for (const def of defs) {
				this.yDefs.set(def.id, this.defEntryToYMap(def));
			}
			const yLayer = this.findYLayer(layerId);
			if (!yLayer) return;
			const yElementIds = this.getYElementIds(yLayer);
			if (yElementIds) {
				yElementIds.push(topLevelIds);
			}
		});
	}

	// --- Brush Preset Operations ---

	public addBrushPreset(preset: BrushPreset): void {
		this.ydoc.transact(() => {
			const yPreset = new Y.Map<unknown>();
			yPreset.set("uid", preset.uid);
			yPreset.set("name", preset.name);
			yPreset.set("settings", JSON.stringify(preset.settings));
			this.yBrushPresets.set(preset.uid, yPreset);
		});
	}

	/** Wrap multiple operations in a single undo step. */
	public transact(fn: () => void, origin?: unknown): void {
		this.ydoc.transact(fn, origin);
	}

	/**
	 * (Re)bind every shared Y structure to the current Y.Doc. Called from the
	 * constructor and resetWithFreshDoc — a structure bound in only one of
	 * the two would keep pointing at the destroyed doc after a guest-join
	 * reset, silently dropping its writes and remote updates.
	 */
	private bindSharedTypes(): void {
		this.yLayers = this.ydoc.getArray("layers");
		this.yObjects = this.ydoc.getMap("objects");
		this.yMeta = this.ydoc.getMap("meta");
		this.yArtboards = this.ydoc.getArray("artboards");
		this.yFiles = this.ydoc.getMap("files");
		this.yBrushPresets = this.ydoc.getMap("brushPresets");
		this.yDefs = this.ydoc.getMap("defs");
		this.yReferences3d = this.ydoc.getMap("references3d");
	}

	/**
	 * Replace the current Y.Doc with a fresh, empty one.
	 * Used when connecting to an existing room (non-reconnect) so that
	 * the Yjs merge produces no duplicates — the fresh doc has no state.
	 */
	public resetWithFreshDoc(): Y.Doc {
		// Tear down old state
		this.objectsSnapshot = null;
		this.layerElementIdsSnapshot = null;
		this.undoManager.destroy();
		this.ydoc.destroy();

		// Create fresh Y.Doc
		this.ydoc = new Y.Doc();
		this.bindSharedTypes();

		// Reset pending sync state
		this.pendingObjectChanges = null;
		this.needsFullSync = false;
		this.needsLayerSync = false;
		this.suppressObjectTracking = false;
		this.suppressSync = false;

		// Re-attach observers and recreate UndoManager
		this.attachObservers();
		this.undoManager = this.createUndoManager();

		return this.ydoc;
	}

	/**
	 * Merge duplicate layers that result from Yjs Y.Array CRDT merge on reconnect.
	 * For each duplicate layer.id, merge elementIds into the first occurrence
	 * and delete subsequent duplicates.
	 * Must be called after sync completes.
	 * @returns true if any duplicates were found and merged
	 */
	/** Write documentId into yMeta so the server-side Y.Doc exposes it via HTTP API. */
	public setDocumentId(documentId: string): void {
		this.yMeta.set("documentId", documentId);
	}

	/** Update the HDR settings on the document. */
	public setHdr(hdr: { enabled: boolean; exposure: number }): void {
		this.yMeta.set("hdr", JSON.stringify(hdr));
	}

	/** Update the color profile settings on the document. */
	public setColorProfile(settings: ColorProfileSettings): void {
		this.yMeta.set("colorProfile", JSON.stringify(settings));
	}

	/** Update the filter rasterization DPI on the document. */
	public setRasterizationDpi(dpi: number): void {
		this.yMeta.set("rasterizationDpi", dpi);
	}

	// --- Defs (off-canvas ArtObject definitions) ---
	//
	// yDefs holds DefEntry metadata (id, kind, name, tile, rootElementIds). The
	// def's member elements live in yObjects under the IDs in rootElementIds —
	// same absorbed-reference pattern as BlendObject.spineSourceId. Element
	// edits to def members continue to flow through the per-object delta path
	// in yObjects; only structural CRUD of DefEntry routes through yDefs.

	/** Serialize a DefEntry into a Y.Map with rootElementIds as Y.Array. */
	private defEntryToYMap(entry: DefEntry): Y.Map<unknown> {
		const yMap = new Y.Map<unknown>();
		yMap.set("id", entry.id);
		yMap.set("kind", entry.kind);
		if (entry.name !== undefined) yMap.set("name", entry.name);
		if (entry.tile !== undefined) yMap.set("tile", JSON.stringify(entry.tile));
		const yRoots = new Y.Array<string>();
		for (const id of entry.rootElementIds) yRoots.push([id]);
		yMap.set("rootElementIds", yRoots);
		return yMap;
	}

	/** Create a new def entry. Member elements must already exist in yObjects. */
	public createDef(entry: DefEntry, origin?: unknown): void {
		this.ydoc.transact(() => {
			this.yDefs.set(entry.id, this.defEntryToYMap(entry));
		}, origin);
	}

	/**
	 * Delete a def entry and recursively delete all elements it owns (its
	 * rootElementIds plus all descendants reachable via getContainerChildIds).
	 * Mirrors how deleteElements cascades through containers.
	 */
	public deleteDef(defId: string, origin?: unknown): void {
		this.ydoc.transact(() => {
			const yDef = this.yDefs.get(defId);
			if (!yDef) return;
			const yRoots = yDef.get("rootElementIds") as Y.Array<string> | undefined;
			const roots: string[] = yRoots ? yRoots.toArray() : [];

			// Cascade-delete all member elements and their descendants.
			const stack = [...roots];
			const visited = new Set<string>();
			while (stack.length > 0) {
				const id = stack.pop()!;
				if (visited.has(id)) continue;
				visited.add(id);
				const yObj = this.yObjects.get(id);
				if (!yObj) continue;
				// childIds (group/clip), sources (compound-path), objectIds (blend), spineSourceId (blend), sourceIds (repeat)
				const childIdsRaw = yObj.get("childIds") as string | undefined;
				if (childIdsRaw) {
					try {
						for (const c of JSON.parse(childIdsRaw) as string[]) stack.push(c);
					} catch {}
				}
				const clipPathIdRaw = yObj.get("clipPathId") as string | undefined;
				if (clipPathIdRaw) {
					try {
						const v = JSON.parse(clipPathIdRaw) as string | null;
						if (v) stack.push(v);
					} catch {}
				}
				const sourcesRaw = yObj.get("sources") as string | undefined;
				if (sourcesRaw) {
					try {
						for (const s of JSON.parse(sourcesRaw) as { id: string }[]) {
							stack.push(s.id);
						}
					} catch {}
				}
				const objectIdsRaw = yObj.get("objectIds") as string | undefined;
				if (objectIdsRaw) {
					try {
						for (const c of JSON.parse(objectIdsRaw) as string[]) stack.push(c);
					} catch {}
				}
				const spineSourceId = yObj.get("spineSourceId") as string | undefined;
				if (spineSourceId) stack.push(spineSourceId);
				const sourceIdsRaw = yObj.get("sourceIds") as string | undefined;
				if (sourceIdsRaw) {
					try {
						for (const c of JSON.parse(sourceIdsRaw) as string[]) stack.push(c);
					} catch {}
				}
				this.yObjects.delete(id);
			}

			this.yDefs.delete(defId);
		}, origin);
	}

	/** Update non-structural def metadata (name / tile / kind). */
	public updateDefMeta(
		defId: string,
		patch: Partial<Pick<DefEntry, "name" | "tile" | "kind">>,
		origin?: unknown,
	): void {
		this.ydoc.transact(() => {
			const yDef = this.yDefs.get(defId);
			if (!yDef) return;
			if (patch.kind !== undefined) yDef.set("kind", patch.kind);
			if (patch.name !== undefined) yDef.set("name", patch.name);
			if (patch.tile !== undefined) {
				yDef.set("tile", JSON.stringify(patch.tile));
			}
		}, origin);
	}

	/**
	 * Replace the rootElementIds list of a def. Does not add or remove the
	 * underlying yObjects entries — the caller is responsible for any
	 * orphan cleanup, the same way createBlend / releaseBlend handle their
	 * absorbed-element lifecycle.
	 */
	public replaceDefElements(
		defId: string,
		newRootElementIds: string[],
		origin?: unknown,
	): void {
		this.ydoc.transact(() => {
			const yDef = this.yDefs.get(defId);
			if (!yDef) return;
			const yRoots = yDef.get("rootElementIds") as Y.Array<string> | undefined;
			if (!yRoots) return;
			if (yRoots.length > 0) yRoots.delete(0, yRoots.length);
			if (newRootElementIds.length > 0) yRoots.push(newRootElementIds);
		}, origin);
	}

	// --- References3D (shared 3D scene definitions) ---
	//
	// yReferences3d holds Reference3DDef entries keyed by scene id. Nodes are stored
	// as a single JSON string per scene (scene-level last-write-wins). If
	// concurrent node edits become a real problem, the upgrade path is to
	// store nodes as per-node Y.Maps — same granularity shift yObjects made.

	/** Serialize a Reference3DDef into a Y.Map (nodes as JSON string). */
	private reference3DDefToYMap(def: Reference3DDef): Y.Map<unknown> {
		const yMap = new Y.Map<unknown>();
		yMap.set("id", def.id);
		if (def.name !== undefined) yMap.set("name", def.name);
		yMap.set("nodes", JSON.stringify(def.nodes));
		return yMap;
	}

	/** Create or replace a shared 3D scene definition. */
	public setReference3D(def: Reference3DDef, origin?: unknown): void {
		this.ydoc.transact(() => {
			this.yReferences3d.set(def.id, this.reference3DDefToYMap(def));
		}, origin);
	}

	/** Replace the node list of an existing scene definition. */
	public updateReference3DNodes(
		sceneId: string,
		nodes: readonly Reference3DNode[],
		origin?: unknown,
	): void {
		this.ydoc.transact(() => {
			const yScene = this.yReferences3d.get(sceneId);
			if (!yScene) return;
			yScene.set("nodes", JSON.stringify(nodes));
		}, origin);
	}

	/**
	 * Delete a scene definition. Reference3DElements referencing the id are left
	 * untouched (they render nothing until repointed or deleted), and figure
	 * VRM binaries stay in document.files — EmbeddedFiles are shared assets.
	 */
	public deleteReference3D(sceneId: string, origin?: unknown): void {
		this.ydoc.transact(() => {
			this.yReferences3d.delete(sceneId);
		}, origin);
	}

	public deduplicateLayers(): boolean {
		const seenIds = new Map<string, number>();
		const duplicateIndices: number[] = [];

		// First pass: identify duplicates
		for (let i = 0; i < this.yLayers.length; i++) {
			const yLayer = this.yLayers.get(i);
			const layerId = yLayer?.get("id");
			if (typeof layerId !== "string") continue;

			if (seenIds.has(layerId)) {
				duplicateIndices.push(i);
			} else {
				seenIds.set(layerId, i);
			}
		}

		if (duplicateIndices.length === 0) return false;

		this.ydoc.transact(() => {
			// Merge elementIds from duplicates into first occurrences
			for (const dupIdx of duplicateIndices) {
				const yLayer = this.yLayers.get(dupIdx);
				const layerId = yLayer?.get("id");
				if (typeof layerId !== "string") continue;

				const firstIdx = seenIds.get(layerId)!;
				const firstYLayer = this.yLayers.get(firstIdx);
				const firstElementIds = this.getYElementIds(firstYLayer);
				const dupElementIds = this.getYElementIds(yLayer);

				if (firstElementIds && dupElementIds) {
					const existingIds = new Set(firstElementIds.toArray());
					const newIds: string[] = [];
					for (const id of dupElementIds.toArray()) {
						if (!existingIds.has(id)) {
							newIds.push(id);
						}
					}
					if (newIds.length > 0) {
						firstElementIds.push(newIds);
					}
				}
			}

			// Delete duplicates in reverse order to preserve indices
			for (let i = duplicateIndices.length - 1; i >= 0; i--) {
				this.yLayers.delete(duplicateIndices[i], 1);
			}
		});

		return true;
	}

	/**
	 * Disconnect and cleanup
	 */
	public destroy(): void {
		if (this.valtioUnsubscribe) {
			this.valtioUnsubscribe();
			this.valtioUnsubscribe = null;
		}

		this.objectsSnapshot = null;
		this.layerElementIdsSnapshot = null;
		this.undoManager.destroy();
		this.ydoc.destroy();
	}
}

/** Convert AnyArtObject to serializable key/value fields for Y.Map storage */
export function objectToStoredFields(
	element: AnyArtObject,
): Record<string, unknown> {
	const fields: Record<string, unknown> = {};

	// Common ArtObject fields
	fields.id = element.id;
	fields.type = element.type;
	fields.opacity = element.opacity;
	fields.blendMode = element.blendMode;
	if (element.compositionMode !== undefined)
		fields.compositionMode = element.compositionMode;
	if (element.visible !== undefined) fields.visible = element.visible;
	if (element.locked !== undefined) fields.locked = element.locked;
	if (element.filters?.length) fields.filters = JSON.stringify(element.filters);
	if (element.transform) fields.transform = JSON.stringify(element.transform);
	if (element.mask) fields.mask = JSON.stringify(element.mask);

	// Type-specific fields
	switch (element.type) {
		case "path":
			fields.segments = JSON.stringify(element.segments);
			if (element.strokeWidths?.length)
				fields.strokeWidths = JSON.stringify(element.strokeWidths);
			if (element.eraseMasks?.length)
				fields.eraseMasks = JSON.stringify(element.eraseMasks);
			if (element.pathStart !== undefined) fields.pathStart = element.pathStart;
			if (element.pathEnd !== undefined) fields.pathEnd = element.pathEnd;
			if (element.isGuide !== undefined) fields.isGuide = element.isGuide;
			break;
		case "group":
			fields.childIds = JSON.stringify(element.childIds);
			if (element.name) fields.name = element.name;
			if (element.collapsed !== undefined) fields.collapsed = element.collapsed;
			if (element.clipPathId !== undefined)
				fields.clipPathId = element.clipPathId;
			break;
		case "image":
			fields.fileUid = element.fileUid;
			fields.x = element.x;
			fields.y = element.y;
			fields.width = element.width;
			fields.height = element.height;
			if (element.corners) fields.corners = JSON.stringify(element.corners);
			break;
		case "compound-path":
			fields.sources = JSON.stringify(element.sources);
			break;
		case "text":
			fields.x = element.x;
			fields.y = element.y;
			fields.content = JSON.stringify(element.content);
			fields.defaultStyle = JSON.stringify(element.defaultStyle);
			fields.layout = JSON.stringify(element.layout);
			if (element.axisBinding)
				fields.axisBinding = JSON.stringify(element.axisBinding);
			if (element.flow) fields.flow = JSON.stringify(element.flow);
			if (element.clipPathId !== undefined)
				fields.clipPathId = element.clipPathId;
			break;
		case "mesh":
			fields.childIds = JSON.stringify(element.childIds);
			fields.vertices = JSON.stringify(element.vertices);
			fields.faces = JSON.stringify(element.faces);
			if (element.name) fields.name = element.name;
			break;
		case "blend":
			fields.objectIds = JSON.stringify(element.objectIds);
			if (element.renderOrder !== undefined)
				fields.renderOrder = JSON.stringify(element.renderOrder);
			fields.spacing = JSON.stringify(element.spacing);
			if (element.spineSourceId !== undefined)
				fields.spineSourceId = element.spineSourceId;
			if (element.tiltToSpine !== undefined)
				fields.tiltToSpine = element.tiltToSpine;
			break;
		case "reference3d":
			fields.sceneId = element.sceneId;
			fields.x = element.x;
			fields.y = element.y;
			fields.width = element.width;
			fields.height = element.height;
			fields.displayMode = element.displayMode;
			fields.camera = JSON.stringify(element.camera);
			if (element.lineart) fields.lineart = JSON.stringify(element.lineart);
			if (element.lightDir) fields.lightDir = JSON.stringify(element.lightDir);
			if (element.includeInExport !== undefined)
				fields.includeInExport = element.includeInExport;
			break;
		case "repeat":
			fields.sourceIds = JSON.stringify(element.sourceIds);
			fields.mode = element.mode;
			fields.grid = JSON.stringify(element.grid);
			fields.radial = JSON.stringify(element.radial);
			fields.mirror = JSON.stringify(element.mirror);
			break;
		default:
			// An element type added without a case here would sync and persist
			// as its common fields alone, losing everything type-specific.
			neverReached(element, "unhandled element type in Yjs serializer");
	}

	return fields;
}

/**
 * Remove every `absorbed` id from a layer's elementIds Y.Array and insert
 * `containerId` at the first absorbed slot (or append when none were present).
 * Shared by blend and repeat absorption.
 */
function spliceAbsorbedIntoYArray(
	yArr: Y.Array<string>,
	absorbed: ReadonlySet<string>,
	containerId: string,
): void {
	let minIndex = -1;
	const indicesToRemove: number[] = [];
	for (let i = 0; i < yArr.length; i++) {
		if (absorbed.has(yArr.get(i))) {
			indicesToRemove.push(i);
			if (minIndex === -1) minIndex = i;
		}
	}
	if (minIndex === -1) {
		yArr.push([containerId]);
		return;
	}
	for (let i = indicesToRemove.length - 1; i >= 0; i--) {
		yArr.delete(indicesToRemove[i], 1);
	}
	// minIndex is the smallest absorbed index, so no absorbed element precedes
	// it; inserting at minIndex restores the container to that slot.
	yArr.insert(minIndex, [containerId]);
}

/**
 * Plain-array counterpart of spliceAbsorbedIntoYArray for a group's childIds
 * (stored as a JSON scalar): returns a new order with `absorbed` removed and
 * `containerId` placed at the first absorbed slot (or appended).
 */
function spliceAbsorbedIntoArray(
	ids: readonly string[],
	absorbed: ReadonlySet<string>,
	containerId: string,
): string[] {
	const firstIndex = ids.findIndex((id) => absorbed.has(id));
	const kept = ids.filter((id) => !absorbed.has(id));
	if (firstIndex === -1) {
		kept.push(containerId);
		return kept;
	}
	kept.splice(firstIndex, 0, containerId);
	return kept;
}
