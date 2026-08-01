import { proxy } from "valtio";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createIdentityTransform } from "../document/factory";
import type { SpatialIndex } from "../document/SpatialIndex";
import type { AnyArtObject } from "../schema";
import { loadTestDocument } from "../testUtils/loadTestDocument";
import {
	DocumentChangeSubscriber,
	type DocumentChangeSubscriberStore,
} from "./DocumentChangeSubscriber";

let testDoc: Awaited<ReturnType<typeof loadTestDocument>>;
beforeAll(async () => {
	testDoc = await loadTestDocument();
});

function createStore(): DocumentChangeSubscriberStore {
	return proxy<DocumentChangeSubscriberStore>({
		document: testDoc,
		elementOverrides: new Map(),
		transientElements: new Map(),
		uiOverlayState: {
			isArtboardEditMode: false,
			overlays: {},
		},
		selectedArtboardId: null,
		editingScopeStack: [],
	});
}

function createRuntimeMocks() {
	const spatialIndex = {
		rebuildAllIndices: vi.fn(),
		getParentGroupId: vi.fn(() => null),
		insertElement: vi.fn(),
		invalidateBounds: vi.fn(),
		clearBoundsCache: vi.fn(),
		removeElement: vi.fn(),
		updateElement: vi.fn(),
		rebuildParentGroupMap: vi.fn(),
		refreshContainerMappings: vi.fn(),
		clearContainerMappings: vi.fn(),
	} as unknown as SpatialIndex;

	const refreshSelectToolUI = vi.fn();
	const syncPathToolFromDocument = vi.fn();
	const isArtboardToolActive = vi.fn(() => false);

	return {
		spatialIndex,
		refreshSelectToolUI,
		syncPathToolFromDocument,
		isArtboardToolActive,
	};
}

describe("DocumentChangeSubscriber", () => {
	it("subscribes store keys and maps them to dirty reasons", async () => {
		const store = createStore();
		const onInvalidate = vi.fn();
		const hub = new DocumentChangeSubscriber(store, onInvalidate);
		hub.start();

		const updates: Array<{
			key: keyof DocumentChangeSubscriberStore;
			value: unknown;
			expectedReason:
				| "document"
				| "preview"
				| "selection"
				| "cursor"
				| "editingScope";
		}> = [
			{ key: "document", value: { updated: true }, expectedReason: "document" },
			{
				key: "elementOverrides",
				value: new Map([["test", { id: "test" }]]),
				expectedReason: "preview",
			},
			{
				key: "transientElements",
				value: new Map([
					["test", { layerId: "layer-1", element: { id: "test" } }],
				]),
				expectedReason: "preview",
			},
			{
				key: "uiOverlayState",
				value: { "sys/selection": { zIndex: 10, primitives: [] } },
				expectedReason: "selection",
			},
			{
				key: "editingScopeStack",
				value: ["group-1"],
				expectedReason: "editingScope",
			},
		];

		for (const { key, value, expectedReason } of updates) {
			onInvalidate.mockClear();

			if (key === "uiOverlayState") {
				// uiOverlayState uses deep subscribe, so mutate a nested property
				store.uiOverlayState.overlays = value as any;
			} else {
				(store as Record<string, unknown>)[key] = value;
			}

			await Promise.resolve();
			expect(onInvalidate).toHaveBeenCalledTimes(1);
			expect(onInvalidate.mock.calls[0][0]).toBe(expectedReason);
			expect(onInvalidate.mock.calls[0][1]).toBe("store-subscription");
		}
	});

	it("stops subscriptions when stop() is called", async () => {
		const store = createStore();
		const onInvalidate = vi.fn();
		const hub = new DocumentChangeSubscriber(store, onInvalidate);
		hub.start();
		hub.stop();

		store.uiOverlayState.isArtboardEditMode = true;
		await Promise.resolve();

		expect(onInvalidate).not.toHaveBeenCalled();
		expect(hub.isStarted()).toBe(false);
	});

	it("maps onSyncApplied undo/redo meta to yjs source", () => {
		const store = createStore();
		const onInvalidate = vi.fn();
		const hub = new DocumentChangeSubscriber(store, onInvalidate);

		hub.onSyncApplied({ syncKind: "delta", undoRedo: false });
		hub.onSyncApplied({ syncKind: "full", undoRedo: true });

		expect(onInvalidate).toHaveBeenCalledTimes(2);
		// A delta sync's ids were already reported by syncObjectsDelta /
		// syncLayersOnly — the echo carries an empty change set so it doesn't
		// void tracking. A full sync has no ids and must void it (undefined).
		expect(onInvalidate.mock.calls[0]).toEqual([
			"document",
			"yjs-sync",
			{ upserted: new Set(), deleted: new Set() },
		]);
		expect(onInvalidate.mock.calls[1]).toEqual([
			"document",
			"yjs-undo-redo",
			undefined,
		]);
	});

	it("refreshes tool UI on undo/redo sync when runtime hooks exist", () => {
		const store = createStore();
		const onInvalidate = vi.fn();
		const runtime = createRuntimeMocks();
		const coordinator = new DocumentChangeSubscriber(store, onInvalidate, {
			getSpatialIndex: () => runtime.spatialIndex,
			refreshToolUI: runtime.refreshSelectToolUI,
			syncPathToolFromDocument: runtime.syncPathToolFromDocument,
			isArtboardToolActive: runtime.isArtboardToolActive,
		});

		coordinator.onSyncApplied({ syncKind: "delta", undoRedo: true });

		expect(runtime.refreshSelectToolUI).toHaveBeenCalledTimes(1);
		expect(runtime.syncPathToolFromDocument).toHaveBeenCalledTimes(1);
		expect(onInvalidate.mock.calls[0]).toEqual([
			"selection",
			"yjs-undo-redo",
			undefined,
		]);
		expect(onInvalidate.mock.calls[1]).toEqual([
			"document",
			"yjs-undo-redo",
			{ upserted: new Set(), deleted: new Set() },
		]);
	});

	it("syncFullDocument rebuilds indices and refreshes tool UIs", async () => {
		const store = createStore();
		const onInvalidate = vi.fn();
		const runtime = createRuntimeMocks();

		const coordinator = new DocumentChangeSubscriber(store, onInvalidate, {
			getSpatialIndex: () => runtime.spatialIndex,
			refreshToolUI: runtime.refreshSelectToolUI,
			syncPathToolFromDocument: runtime.syncPathToolFromDocument,
			isArtboardToolActive: runtime.isArtboardToolActive,
		});

		// Store mutation is caller's responsibility (simulating Paplico)
		store.document = await loadTestDocument();

		coordinator.syncFullDocument();

		expect(runtime.spatialIndex.rebuildAllIndices).not.toHaveBeenCalled();
		expect(runtime.refreshSelectToolUI).toHaveBeenCalledTimes(1);
		expect(runtime.syncPathToolFromDocument).toHaveBeenCalledTimes(1);
	});

	it("syncObjectsDelta updates spatial index and refreshes tool UIs", () => {
		const store = createStore();
		const onInvalidate = vi.fn();
		const runtime = createRuntimeMocks();
		const coordinator = new DocumentChangeSubscriber(store, onInvalidate, {
			getSpatialIndex: () => runtime.spatialIndex,
			refreshToolUI: runtime.refreshSelectToolUI,
			syncPathToolFromDocument: runtime.syncPathToolFromDocument,
			isArtboardToolActive: runtime.isArtboardToolActive,
		});

		const layer = store.document.layers[0];
		const updatedId = layer.elementIds[0];
		const deletedId = layer.elementIds[1];
		const baseObject = store.document.objects[updatedId];
		const updatedObject = { ...baseObject, opacity: 0.42 } as AnyArtObject;

		const delta = {
			added: new Map<string, AnyArtObject>(),
			updated: new Map([[updatedId, updatedObject]]),
			deleted: new Set([deletedId]),
		};

		// Store mutation is caller's responsibility (simulating Paplico)
		const deletedSnapshot: Record<string, AnyArtObject> = {};
		if (store.document.objects[deletedId])
			deletedSnapshot[deletedId] = store.document.objects[deletedId];
		const nextObjects = { ...store.document.objects };
		for (const [id, obj] of delta.updated) nextObjects[id] = obj;
		for (const id of delta.deleted) delete nextObjects[id];
		store.document.objects = nextObjects;

		coordinator.syncObjectsDelta(delta, store.document.layers, deletedSnapshot);

		expect(runtime.spatialIndex.insertElement).not.toHaveBeenCalled();
		expect(runtime.spatialIndex.clearBoundsCache).toHaveBeenCalledWith(
			updatedId,
		);
		expect(runtime.spatialIndex.updateElement).toHaveBeenCalledWith(
			layer.id,
			updatedObject,
		);
		expect(runtime.spatialIndex.removeElement).toHaveBeenCalledTimes(
			store.document.layers.length,
		);
		expect(runtime.spatialIndex.rebuildParentGroupMap).not.toHaveBeenCalled();
		expect(runtime.refreshSelectToolUI).toHaveBeenCalledTimes(1);
		expect(runtime.syncPathToolFromDocument).toHaveBeenCalledTimes(1);
		// The delta's element ids ride the invalidation so the dirty pipeline
		// can track per-element changes (updated → upserted, deleted separate).
		expect(onInvalidate.mock.calls[0]).toEqual([
			"document",
			"yjs-sync",
			{ upserted: new Set([updatedId]), deleted: new Set([deletedId]) },
		]);
	});

	it("syncObjectsDelta rebuilds parent group map on group mutation", () => {
		const store = createStore();
		const onInvalidate = vi.fn();
		const runtime = createRuntimeMocks();
		const coordinator = new DocumentChangeSubscriber(store, onInvalidate, {
			getSpatialIndex: () => runtime.spatialIndex,
			refreshToolUI: runtime.refreshSelectToolUI,
			syncPathToolFromDocument: runtime.syncPathToolFromDocument,
			isArtboardToolActive: runtime.isArtboardToolActive,
		});

		const layer = store.document.layers[0];
		const groupObject: AnyArtObject = {
			type: "group",
			id: "delta-group",
			opacity: 1,
			blendMode: "normal",
			childIds: [layer.elementIds[0]],
			transform: createIdentityTransform(),
		};

		const delta = {
			added: new Map<string, AnyArtObject>(),
			updated: new Map([[groupObject.id, groupObject]]),
			deleted: new Set<string>(),
		};

		store.document.objects = {
			...store.document.objects,
			[groupObject.id]: groupObject,
		};

		coordinator.syncObjectsDelta(delta, store.document.layers, {});

		expect(runtime.spatialIndex.refreshContainerMappings).toHaveBeenCalledTimes(
			1,
		);
		expect(runtime.spatialIndex.refreshContainerMappings).toHaveBeenCalledWith(
			groupObject,
		);
	});

	it("syncObjectsDelta falls back to document traversal when parent map is stale", () => {
		const store = createStore();
		const onInvalidate = vi.fn();
		const runtime = createRuntimeMocks();
		const coordinator = new DocumentChangeSubscriber(store, onInvalidate, {
			getSpatialIndex: () => runtime.spatialIndex,
			refreshToolUI: runtime.refreshSelectToolUI,
			syncPathToolFromDocument: runtime.syncPathToolFromDocument,
			isArtboardToolActive: runtime.isArtboardToolActive,
		});

		const layer = store.document.layers[0];
		const childId = layer.elementIds[0];
		const childObject = store.document.objects[childId];
		const groupId = "stale-map-group";
		const groupObject: AnyArtObject = {
			type: "group",
			id: groupId,
			opacity: 1,
			blendMode: "normal",
			childIds: [childId],
			transform: createIdentityTransform(),
		};
		store.document.objects[groupId] = groupObject;
		layer.elementIds = [groupId];

		const updatedChild = { ...childObject, opacity: 0.11 } as AnyArtObject;
		const delta = {
			added: new Map<string, AnyArtObject>(),
			updated: new Map([[childId, updatedChild]]),
			deleted: new Set<string>(),
		};

		store.document.objects = {
			...store.document.objects,
			[childId]: updatedChild,
		};

		coordinator.syncObjectsDelta(delta, store.document.layers, {});

		expect(runtime.spatialIndex.updateElement).toHaveBeenCalledWith(
			layer.id,
			expect.objectContaining({ id: groupId, type: "group" }),
		);
	});

	it("syncObjectsDelta rebuilds parent group map when a group is deleted", () => {
		const store = createStore();
		const onInvalidate = vi.fn();
		const runtime = createRuntimeMocks();
		const coordinator = new DocumentChangeSubscriber(store, onInvalidate, {
			getSpatialIndex: () => runtime.spatialIndex,
			refreshToolUI: runtime.refreshSelectToolUI,
			syncPathToolFromDocument: runtime.syncPathToolFromDocument,
			isArtboardToolActive: runtime.isArtboardToolActive,
		});

		const layer = store.document.layers[0];
		const childId = layer.elementIds[0];
		const groupId = "deleted-group";
		const groupObject: AnyArtObject = {
			type: "group",
			id: groupId,
			opacity: 1,
			blendMode: "normal",
			childIds: [childId],
			transform: createIdentityTransform(),
		};
		store.document.objects[groupId] = groupObject;
		layer.elementIds = [groupId];

		const delta = {
			added: new Map<string, AnyArtObject>(),
			updated: new Map<string, AnyArtObject>(),
			deleted: new Set([groupId]),
		};

		// deletedSnapshot must include the group so hasGroupMutation() can detect it
		const deletedSnapshot: Record<string, AnyArtObject> = {
			[groupId]: groupObject,
		};
		const nextObjects = { ...store.document.objects };
		delete nextObjects[groupId];
		store.document.objects = nextObjects;

		coordinator.syncObjectsDelta(delta, store.document.layers, deletedSnapshot);

		expect(runtime.spatialIndex.clearContainerMappings).toHaveBeenCalledTimes(
			1,
		);
		expect(runtime.spatialIndex.clearContainerMappings).toHaveBeenCalledWith(
			groupObject,
		);
	});
});
