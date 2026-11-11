import { proxy, ref } from "valtio";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { YjsProvider } from "../collaboration/YjsProvider";
import { createArtboard, createIdentityTransform } from "../document/factory";
import type { ObjectsChangeDelta } from "../document/objectsChangeDelta";
import { SpatialIndex } from "../document/SpatialIndex";
import type { AnyArtObject, BlendObject, Layer } from "../schema";
import { loadTestDocument } from "../testUtils/loadTestDocument";
import {
	mockCompoundPath,
	mockGroup,
	mockLayer,
} from "../testUtils/mockElements";
import { rectPath, solidFillAppearance } from "../testUtils/svgFixtures";
import { brandWorldBBox } from "../utils/geometry/primitives/box";
import {
	DocumentChangeSubscriber,
	type DocumentChangeSubscriberStore,
} from "./DocumentChangeSubscriber";
import type { RendererState } from "./types";
import { OVERLAY_KEYS } from "./ui/overlayKeys";

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
			overlays: {},
		},
		selectedArtboardId: null,
		editingScopeStack: [],
	});
}

function createRuntimeMocks() {
	const spatialIndex = {
		rebuildAllIndices: vi.fn(),
		rebuildArtboardIndex: vi.fn(),
		getParentGroupId: vi.fn(() => null),
		insertElement: vi.fn(),
		invalidateBounds: vi.fn(),
		clearBoundsCacheWithAncestors: vi.fn(),
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

		store.uiOverlayState.overlays = {};
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

	it("syncArtboardsOnly rebuilds the artboard index and redraws the selected artboard", () => {
		const store = createStore();
		const onInvalidate = vi.fn();
		const runtime = createRuntimeMocks();
		runtime.isArtboardToolActive.mockReturnValue(true);
		const coordinator = new DocumentChangeSubscriber(store, onInvalidate, {
			getSpatialIndex: () => runtime.spatialIndex,
			refreshToolUI: runtime.refreshSelectToolUI,
			syncPathToolFromDocument: runtime.syncPathToolFromDocument,
			isArtboardToolActive: runtime.isArtboardToolActive,
		});

		// Store mutation is caller's responsibility (simulating Paplico)
		store.document.artboards = [createArtboard("ab", "Main", 10, 0, 100, 100)];
		store.selectedArtboardId = "ab";

		coordinator.syncArtboardsOnly();

		expect(runtime.spatialIndex.rebuildArtboardIndex).toHaveBeenCalledTimes(1);
		expect(runtime.spatialIndex.rebuildAllIndices).not.toHaveBeenCalled();
		expect(
			store.uiOverlayState.overlays?.[OVERLAY_KEYS.sysArtboardSelection],
		).toBeDefined();
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
		expect(
			runtime.spatialIndex.clearBoundsCacheWithAncestors,
		).toHaveBeenCalledWith(updatedId, false);
		expect(runtime.spatialIndex.updateElement).toHaveBeenCalledWith(
			layer.id,
			updatedObject,
			false,
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

	describe("layer membership changes synced from Yjs", () => {
		it("hits only the group, not its children, after grouping", () => {
			const { provider, spatialIndex } = createYjsSyncedIndex();

			const groupId = provider.groupElements("layer-1", ["a", "b"]);

			const candidates = spatialIndex.queryElements(
				"layer-1",
				brandWorldBBox({
					minX: -50,
					minY: -50,
					maxX: 150,
					maxY: 50,
					width: 200,
					height: 100,
				}),
			);
			expect(candidates.map((element) => element.id)).toEqual([groupId]);
		});

		it("hits the children again after ungrouping", () => {
			const { provider, spatialIndex } = createYjsSyncedIndex();
			const groupId = provider.groupElements("layer-1", ["a", "b"]);
			if (!groupId) throw new Error("group should be created");

			provider.ungroupElements("layer-1", groupId);

			expect(spatialIndex.findElementAtPoint("layer-1", 0, 0)?.id).toBe("a");
			expect(spatialIndex.findElementAtPoint("layer-1", 100, 0)?.id).toBe("b");
		});

		it("hits a moved element only in its new layer", () => {
			const { provider, spatialIndex } = createYjsSyncedIndex();

			provider.moveElementToLayer("layer-1", "a", "layer-2");

			expect(spatialIndex.findElementAtPoint("layer-1", 0, 0)).toBeNull();
			expect(spatialIndex.findElementAtPoint("layer-2", 0, 0)?.id).toBe("a");
		});

		it("reports moved elements as upserted", () => {
			const { provider, onInvalidate } = createYjsSyncedIndex();

			provider.moveElementToLayer("layer-1", "a", "layer-2");

			const reported = onInvalidate.mock.calls.flatMap(([, , changes]) => [
				...(changes?.upserted ?? []),
			]);
			expect(reported).toContain("a");
		});
	});

	describe("transform-only changes synced from Yjs", () => {
		it("keeps a moved element's local bounds and moves its hit area", () => {
			const { provider, spatialIndex, subscriber } = createYjsSyncedIndex();
			const localBounds = spatialIndex.getLocalBounds("a");

			subscriber.withTransformOnlyChange(() => {
				provider.updateElement("layer-1", "a", {
					transform: { ...createIdentityTransform(), x: 50 },
				});
			});

			expect(spatialIndex.getLocalBounds("a")).toBe(localBounds);
			expect(spatialIndex.findElementAtPoint("layer-1", 50, 0)?.id).toBe("a");
			expect(spatialIndex.findElementAtPoint("layer-1", 0, 0)).toBeNull();
		});

		it("recomputes the local bounds of a group whose child moved", () => {
			const { provider, spatialIndex, subscriber } = createYjsSyncedIndex();
			const groupId = provider.groupElements("layer-1", ["a", "b"]);
			if (!groupId) throw new Error("group should be created");

			subscriber.withTransformOnlyChange(() => {
				provider.updateElement("layer-1", "a", {
					transform: { ...createIdentityTransform(), x: -50 },
				});
			});

			expect(spatialIndex.getLocalBounds(groupId)?.minX).toBe(-60);
		});

		it("recomputes a changed element's local bounds outside a transform-only change", () => {
			const { provider, spatialIndex } = createYjsSyncedIndex();
			const localBounds = spatialIndex.getLocalBounds("a");

			provider.updateElement("layer-1", "a", {
				transform: { ...createIdentityTransform(), x: 50 },
			});

			expect(spatialIndex.getLocalBounds("a")).not.toBe(localBounds);
		});
	});

	describe("top-level owners of nested changes", () => {
		it("should update the top-level group when an object is added deep inside it", () => {
			const { spatialIndex, applyChange, updatedOwners } = createNestedIndex(
				[
					mockGroup("top", ["inner"]),
					mockGroup("inner", ["a"]),
					square("a", 0),
				],
				[mockLayer("layer-1", ["top"])],
			);

			applyChange({
				added: [square("n", 500)],
				updated: [mockGroup("inner", ["a", "n"])],
			});

			expect(updatedOwners()).toEqual([["layer-1", "top"]]);
			expect(spatialIndex.getParentGroupId("n")).toBe("inner");
			expect(
				spatialIndex
					.queryElements("layer-1", areaAround(500))
					.map((element) => element.id),
			).toEqual(["top"]);
		});

		it("should resolve every object of an added nested subtree to the group it joined", () => {
			const { spatialIndex, applyChange, updatedOwners } = createNestedIndex(
				[mockGroup("top", ["a"]), square("a", 0)],
				[mockLayer("layer-1", ["top"])],
			);

			applyChange({
				added: [
					square("leaf", 500),
					mockGroup("sub", ["leaf"]),
					mockGroup("copy", ["sub"]),
				],
				updated: [mockGroup("top", ["a", "copy"])],
			});

			expect(updatedOwners()).toEqual([["layer-1", "top"]]);
			expect(spatialIndex.getParentGroupId("leaf")).toBe("sub");
			expect(spatialIndex.getParentGroupId("sub")).toBe("copy");
			expect(spatialIndex.getParentGroupId("copy")).toBe("top");
		});

		it("should update the top-level group when an object deep inside it is deleted", () => {
			const { spatialIndex, applyChange, updatedOwners } = createNestedIndex(
				[
					mockGroup("top", ["inner"]),
					mockGroup("inner", ["a", "far"]),
					square("a", 0),
					square("far", 500),
				],
				[mockLayer("layer-1", ["top"])],
			);

			applyChange({
				updated: [mockGroup("inner", ["a"])],
				deleted: ["far"],
			});

			expect(updatedOwners()).toEqual([["layer-1", "top"]]);
			expect(spatialIndex.getParentGroupId("far")).toBeNull();
			expect(spatialIndex.queryElements("layer-1", areaAround(500))).toEqual(
				[],
			);
		});

		it("should drop a deleted top-level group and everything inside it", () => {
			const { spatialIndex, applyChange, updatedOwners } = createNestedIndex(
				[
					mockGroup("top", ["inner"]),
					mockGroup("inner", ["a"]),
					square("a", 0),
					square("other", 500),
				],
				[mockLayer("layer-1", ["top", "other"])],
			);

			applyChange({
				layers: [mockLayer("layer-1", ["other"])],
				deleted: ["top", "inner", "a"],
			});

			expect(updatedOwners()).toEqual([]);
			expect(spatialIndex.getParentGroupId("a")).toBeNull();
			expect(spatialIndex.getParentGroupId("inner")).toBeNull();
			expect(spatialIndex.queryElements("layer-1", areaAround(0))).toEqual([]);
		});

		it("should update the blend that absorbed a changed key", () => {
			const blend: BlendObject = {
				type: "blend",
				id: "blend",
				objectIds: ["key-1", "key-2"],
				spacing: { type: "steps", count: 2 },
				placementEasing: { type: "linear" },
				appearanceEasing: { type: "linear" },
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			};
			const { applyChange, updatedOwners } = createNestedIndex(
				[blend, square("key-1", 0), square("key-2", 100)],
				[mockLayer("layer-1", ["blend"])],
			);

			applyChange({ updated: [square("key-1", -50)] });

			expect(updatedOwners()).toEqual([["layer-1", "blend"]]);
		});

		it("should update the compound path that absorbed a changed source", () => {
			const { applyChange, updatedOwners } = createNestedIndex(
				[
					mockCompoundPath("compound", ["source-1", "source-2"]),
					square("source-1", 0),
					square("source-2", 10),
				],
				[mockLayer("layer-1", ["compound"])],
			);

			applyChange({ updated: [square("source-2", 15)] });

			expect(updatedOwners()).toEqual([["layer-1", "compound"]]);
		});

		it("should update both top-level groups when an object moves between their inner groups", () => {
			const { spatialIndex, applyChange, updatedOwners } = createNestedIndex(
				[
					mockGroup("top-1", ["inner-1"]),
					mockGroup("inner-1", ["a", "x"]),
					mockGroup("top-2", ["inner-2"]),
					mockGroup("inner-2", ["b"]),
					square("a", 0),
					square("x", 50),
					square("b", 300),
				],
				[mockLayer("layer-1", ["top-1"]), mockLayer("layer-2", ["top-2"])],
			);

			applyChange({
				updated: [
					mockGroup("inner-1", ["a"]),
					mockGroup("inner-2", ["b", "x"]),
					square("x", 350),
				],
			});

			expect(updatedOwners().toSorted()).toEqual([
				["layer-1", "top-1"],
				["layer-2", "top-2"],
			]);
			expect(spatialIndex.getParentGroupId("x")).toBe("inner-2");
		});

		it("should find the top-level group from the document when the index has no parent for a changed object", () => {
			const { spatialIndex, applyChange, updatedOwners } = createNestedIndex(
				[
					mockGroup("top", ["inner"]),
					mockGroup("inner", ["a"]),
					square("a", 0),
				],
				[mockLayer("layer-1", ["top"])],
			);
			spatialIndex.clearContainerMappings(mockGroup("inner", ["a"]));

			applyChange({ updated: [square("a", 20)] });

			expect(updatedOwners()).toEqual([["layer-1", "top"]]);
		});

		it("should keep the new parent of children that a deleted container hands to its own parent", () => {
			const { spatialIndex, applyChange, updatedOwners } = createNestedIndex(
				[
					mockGroup("top", ["inner"]),
					mockGroup("inner", ["a", "b"]),
					square("a", 0),
					square("b", 100),
				],
				[mockLayer("layer-1", ["top"])],
			);

			applyChange({
				updated: [mockGroup("top", ["a", "b"])],
				deleted: ["inner"],
			});

			expect(updatedOwners()).toEqual([["layer-1", "top"]]);
			expect(spatialIndex.getParentGroupId("a")).toBe("top");
			expect(spatialIndex.getParentGroupId("b")).toBe("top");
		});

		it("should read the document once for a change to several objects that sit in no layer", () => {
			const detachedIds = ["mask-1", "mask-2", "mask-3", "mask-4", "mask-5"];
			const fillerIds = Array.from({ length: 40 }, (_, i) => `filler-${i}`);
			const objects = [
				mockGroup("top", fillerIds),
				...fillerIds.map((id) => square(id, 0)),
				...detachedIds.map((id) => square(id, 300)),
			];
			const { applyChange, updatedOwners, objectReadsDuringSync } =
				createNestedIndex(objects, [mockLayer("layer-1", ["top"])]);

			applyChange({ updated: detachedIds.map((id) => square(id, 320)) });

			expect(updatedOwners()).toEqual([]);
			expect(objectReadsDuringSync()).toBeLessThan(objects.length * 2);
		});

		it("should not read more of the document for a nested add or delete as the document grows", () => {
			const readsFor = (fillerGroups: number) => {
				const objects: AnyArtObject[] = [];
				const elementIds: string[] = [];
				for (let i = 0; i < fillerGroups; i++) {
					objects.push(
						mockGroup(`filler-${i}`, [`filler-${i}-child`]),
						square(`filler-${i}-child`, i * 30),
					);
					elementIds.push(`filler-${i}`);
				}
				const { applyChange, objectReadsDuringSync } = createNestedIndex(
					objects,
					[mockLayer("layer-1", elementIds)],
				);

				const copy: AnyArtObject[] = [mockGroup("copy", [])];
				const subIds: string[] = [];
				for (let i = 0; i < 5; i++) {
					const leafIds = [0, 1, 2, 3].map((j) => `copy-${i}-${j}`);
					copy.push(...leafIds.map((id) => square(id, -500)));
					copy.push(mockGroup(`copy-${i}`, leafIds));
					subIds.push(`copy-${i}`);
				}
				copy[0] = mockGroup("copy", subIds);

				applyChange({
					layers: [mockLayer("layer-1", [...elementIds, "copy"])],
					added: copy,
				});
				const addReads = objectReadsDuringSync();
				applyChange({
					layers: [mockLayer("layer-1", elementIds)],
					deleted: copy.map((object) => object.id),
				});
				return { addReads, deleteReads: objectReadsDuringSync() };
			};

			const small = readsFor(20);
			const large = readsFor(400);

			expect(large.addReads).toBeLessThanOrEqual(small.addReads * 2);
			expect(large.deleteReads).toBeLessThanOrEqual(small.deleteReads * 2);
		});
	});
});

/**
 * A YjsProvider whose syncs reach a real SpatialIndex through the subscriber,
 * applied the way Paplico applies them. "layer-1" holds filled 20x20 squares "a" at
 * (0, 0) and "b" at (100, 0); "layer-2" is empty.
 */
function createYjsSyncedIndex() {
	const store = createStore();
	store.document = {
		...testDoc,
		layers: [],
		objects: ref<Record<string, AnyArtObject>>({}),
	};
	const spatialIndex = new SpatialIndex(store as unknown as RendererState);
	const onInvalidate = vi.fn();
	const subscriber = new DocumentChangeSubscriber(store, onInvalidate, {
		getSpatialIndex: () => spatialIndex,
		refreshToolUI: () => {},
		syncPathToolFromDocument: () => {},
		isArtboardToolActive: () => false,
	});
	const provider = new YjsProvider({
		callbacks: {
			onDocumentUpdate: () => {},
			onLayersUpdate: (layers) => {
				const previousLayers = store.document.layers;
				store.document.layers = layers;
				subscriber.syncLayersOnly(previousLayers);
			},
			onObjectsChange: (delta) => {
				applyObjectsChange(store, spatialIndex, subscriber, delta);
			},
			getCurrentLayerId: () => "layer-1",
			setCurrentLayerId: () => {},
		},
	});

	for (const id of ["layer-1", "layer-2"]) {
		provider.addLayer({
			id,
			name: id,
			visible: true,
			locked: false,
			opacity: 1,
			elementIds: [],
		});
	}
	provider.addElement("layer-1", square("a", 0));
	provider.addElement("layer-1", square("b", 100));
	onInvalidate.mockClear();

	return { provider, spatialIndex, subscriber, onInvalidate };
}

/** A filled 20x20 square centred at (`x`, 0). */
function square(id: string, x: number): AnyArtObject {
	return rectPath(id, { x, y: 0 }, 20, 20, [solidFillAppearance(0, 0, 0)]);
}

/** The 40x40 world area centred at (`x`, 0). */
function areaAround(x: number) {
	return brandWorldBBox({
		minX: x - 20,
		minY: -20,
		maxX: x + 20,
		maxY: 20,
		width: 40,
		height: 40,
	});
}

/**
 * A real SpatialIndex over the given document, with changes applied in the
 * order Paplico applies a Yjs sync: layers first, then the object delta.
 */
function createNestedIndex(objectList: AnyArtObject[], layers: Layer[]) {
	let objectReads = 0;
	let objectReadsDuringSync = 0;
	const objects = new Proxy<Record<string, AnyArtObject>>(
		Object.fromEntries(objectList.map((object) => [object.id, object])),
		{
			get: (target, key, receiver) => {
				objectReads++;
				return Reflect.get(target, key, receiver);
			},
		},
	);
	const store = createStore();
	store.document = { ...testDoc, layers, objects: ref(objects) };
	const spatialIndex = new SpatialIndex(store as unknown as RendererState);
	spatialIndex.rebuildAllIndices();
	const updateElement = vi.spyOn(spatialIndex, "updateElement");
	const subscriber = new DocumentChangeSubscriber(store, vi.fn(), {
		getSpatialIndex: () => spatialIndex,
		refreshToolUI: () => {},
		syncPathToolFromDocument: () => {},
		isArtboardToolActive: () => false,
	});

	const applyChange = (change: {
		layers?: Layer[];
		added?: AnyArtObject[];
		updated?: AnyArtObject[];
		deleted?: string[];
	}) => {
		updateElement.mockClear();
		if (change.layers) {
			const previousLayers = store.document.layers;
			store.document.layers = change.layers;
			subscriber.syncLayersOnly(previousLayers);
		}
		const toEntries = (list: AnyArtObject[] = []) =>
			new Map(list.map((object) => [object.id, object]));
		const delta = {
			added: toEntries(change.added),
			updated: toEntries(change.updated),
			deleted: new Set(change.deleted),
		};
		objectReadsDuringSync = applyObjectsChange(
			store,
			spatialIndex,
			subscriber,
			delta,
			() => objectReads,
		);
	};

	return {
		spatialIndex,
		applyChange,
		/** The `[layerId, elementId]` pairs the last change re-indexed. */
		updatedOwners: () =>
			updateElement.mock.calls.map(([layerId, element]) => [
				layerId,
				element.id,
			]),
		objectReadsDuringSync: () => objectReadsDuringSync,
	};
}

/**
 * Apply an object delta the way Paplico applies it: write the objects, patch
 * the index's object cache, then sync the subscriber. Returns how far
 * `readCount` advanced during the subscriber's sync.
 */
function applyObjectsChange(
	store: DocumentChangeSubscriberStore,
	spatialIndex: SpatialIndex,
	subscriber: DocumentChangeSubscriber,
	delta: ObjectsChangeDelta,
	readCount: () => number = () => 0,
): number {
	const objects = store.document.objects;
	const deletedSnapshot: Record<string, AnyArtObject> = {};
	for (const id of delta.deleted) deletedSnapshot[id] = objects[id];
	for (const [id, obj] of [...delta.added, ...delta.updated]) {
		objects[id] = obj;
	}
	for (const id of delta.deleted) delete objects[id];
	spatialIndex.applyObjectsDelta(delta);
	const readsBefore = readCount();
	subscriber.syncObjectsDelta(delta, store.document.layers, deletedSnapshot);
	return readCount() - readsBefore;
}
