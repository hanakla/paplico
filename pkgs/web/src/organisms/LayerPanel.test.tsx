import type { DragEndEvent } from "@dnd-kit/core";
import type { Paplico } from "@paplico/core";
import {
	createDefaultLayer,
	createRendererState,
} from "@paplico/core/document";
import type { AnyArtObject, CompoundPath, Group } from "@paplico/core/schema";
import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaplicoProvider } from "@/contexts/PaplicoContext";
import { setLayerPanelMode } from "@/hooks/useAppConfig";
import {
	type DragEndAction,
	filterLayerList,
	LayerPanel,
	type LayerPanelFilter,
	resolveDragEndAction,
} from "@/organisms/LayerPanel";

// -- Helpers --

const IDENTITY_TRANSFORM = {
	x: 0,
	y: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
} as const;

function createDragEndEvent(opts: {
	activeId: string;
	activeData?: Record<string, unknown>;
	overId?: string;
	overData?: Record<string, unknown>;
}): DragEndEvent {
	return {
		active: {
			id: opts.activeId,
			data: { current: opts.activeData },
			rect: { current: { initial: null, translated: null } },
		},
		over:
			opts.overId != null
				? {
						id: opts.overId,
						data: { current: opts.overData },
						rect: {
							width: 0,
							height: 0,
							top: 0,
							left: 0,
							bottom: 0,
							right: 0,
						},
						disabled: false,
					}
				: null,
		activatorEvent: new Event("pointer"),
		collisions: null,
		delta: { x: 0, y: 0 },
	} as unknown as DragEndEvent;
}

function createDocument(
	layers: { id: string; elementIds: string[] }[],
	objects: Record<string, AnyArtObject> = {},
) {
	return { layers, objects };
}

function createPath(id: string): AnyArtObject {
	return {
		type: "path",
		id,
		opacity: 1,
		blendMode: "normal",
		transform: { ...IDENTITY_TRANSFORM },
		segments: [],
	} as AnyArtObject;
}

function createCompoundPath(
	id: string,
	sources: { id: string; op: "union" | "subtract" | "intersect" | "exclude" }[],
): CompoundPath {
	return {
		type: "compound-path",
		id,
		opacity: 1,
		blendMode: "normal",
		transform: { ...IDENTITY_TRANSFORM },
		sources,
	} as CompoundPath;
}

function createBlend(
	id: string,
	objectIds: string[],
	spineSourceId?: string,
	renderOrder?: string[],
): AnyArtObject {
	return {
		type: "blend",
		id,
		opacity: 1,
		blendMode: "normal",
		transform: { ...IDENTITY_TRANSFORM },
		objectIds,
		renderOrder,
		spacing: { type: "steps", count: 5 },
		spineSourceId,
	} as AnyArtObject;
}

// -- Tests --

describe("resolveDragEndAction", () => {
	it("returns null when over target is null", () => {
		const event = createDragEndEvent({
			activeId: "layer-1",
			activeData: { type: "layer", layerId: "layer-1" },
		});
		const doc = createDocument([{ id: "layer-1", elementIds: [] }]);

		expect(resolveDragEndAction(event, doc)).toBeNull();
	});

	it("returns null when active.id === over.id", () => {
		const event = createDragEndEvent({
			activeId: "layer-1",
			activeData: { type: "layer", layerId: "layer-1" },
			overId: "layer-1",
			overData: { type: "layer", layerId: "layer-1" },
		});
		const doc = createDocument([{ id: "layer-1", elementIds: [] }]);

		expect(resolveDragEndAction(event, doc)).toBeNull();
	});

	describe("layer reorder", () => {
		it("returns reorderLayers when dragging a layer to a different layer position", () => {
			const event = createDragEndEvent({
				activeId: "drag-layer-1",
				activeData: { type: "layer", layerId: "layer-1" },
				overId: "drag-layer-2",
				overData: { type: "layer", layerId: "layer-2" },
			});
			const doc = createDocument([
				{ id: "layer-1", elementIds: [] },
				{ id: "layer-2", elementIds: [] },
			]);

			const result = resolveDragEndAction(event, doc);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("reorderLayers");
			const action = result as Extract<
				DragEndAction,
				{ type: "reorderLayers" }
			>;
			expect(action.oldIndex).toBe(0);
			expect(action.newIndex).toBe(1);
		});

		it("returns null when source and target layer are the same", () => {
			const event = createDragEndEvent({
				activeId: "drag-layer-1",
				activeData: { type: "layer", layerId: "layer-1" },
				overId: "drag-layer-1-over",
				overData: { type: "layer", layerId: "layer-1" },
			});
			const doc = createDocument([
				{ id: "layer-1", elementIds: [] },
				{ id: "layer-2", elementIds: [] },
			]);

			expect(resolveDragEndAction(event, doc)).toBeNull();
		});
	});

	describe("element -> layer header", () => {
		it("moves element to a different layer", () => {
			const event = createDragEndEvent({
				activeId: "elem-a",
				activeData: { type: "element", layerId: "layer-1", index: 0 },
				overId: "layer-header-2",
				overData: { type: "layer", layerId: "layer-2" },
			});
			const doc = createDocument([
				{ id: "layer-1", elementIds: ["elem-a"] },
				{ id: "layer-2", elementIds: [] },
			]);

			const result = resolveDragEndAction(event, doc);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("moveElementToLayer");
			const action = result as Extract<
				DragEndAction,
				{ type: "moveElementToLayer" }
			>;
			expect(action.sourceLayerId).toBe("layer-1");
			expect(action.elementIndex).toBe(0);
			expect(action.targetLayerId).toBe("layer-2");
		});

		it("returns null when element is dragged to its own layer header", () => {
			const event = createDragEndEvent({
				activeId: "elem-a",
				activeData: { type: "element", layerId: "layer-1", index: 0 },
				overId: "layer-header-1",
				overData: { type: "layer", layerId: "layer-1" },
			});
			const doc = createDocument([{ id: "layer-1", elementIds: ["elem-a"] }]);

			expect(resolveDragEndAction(event, doc)).toBeNull();
		});

		it("extracts source from compound path when dragged to layer header", () => {
			const cp = createCompoundPath("cp-1", [
				{ id: "src-a", op: "union" },
				{ id: "src-b", op: "subtract" },
			]);

			const event = createDragEndEvent({
				activeId: "src-b",
				activeData: {
					type: "element",
					layerId: "layer-1",
					index: 1,
					parentContainerId: "cp-1",
				},
				overId: "layer-header-2",
				overData: { type: "layer", layerId: "layer-2" },
			});
			const doc = createDocument(
				[
					{ id: "layer-1", elementIds: ["cp-1"] },
					{ id: "layer-2", elementIds: [] },
				],
				{ "cp-1": cp },
			);

			const result = resolveDragEndAction(event, doc);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("extractSourceFromCompoundPath");
			const action = result as Extract<
				DragEndAction,
				{ type: "extractSourceFromCompoundPath" }
			>;
			expect(action.compoundPathId).toBe("cp-1");
			expect(action.sourceId).toBe("src-b");
			expect(action.targetLayerId).toBe("layer-2");
		});
	});

	describe("element -> element (same layer)", () => {
		it("reorders elements within the same layer", () => {
			const event = createDragEndEvent({
				activeId: "elem-a",
				activeData: { type: "element", layerId: "layer-1", index: 0 },
				overId: "elem-c",
				overData: { type: "element", layerId: "layer-1", index: 2 },
			});
			const doc = createDocument([
				{ id: "layer-1", elementIds: ["elem-a", "elem-b", "elem-c"] },
			]);

			const result = resolveDragEndAction(event, doc);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("reorderElements");
			const action = result as Extract<
				DragEndAction,
				{ type: "reorderElements" }
			>;
			expect(action.layerId).toBe("layer-1");
			expect(action.oldIndex).toBe(0);
			expect(action.newIndex).toBe(2);
		});
	});

	describe("element -> element (cross-layer)", () => {
		it("moves element to a different layer at the target position", () => {
			const event = createDragEndEvent({
				activeId: "elem-a",
				activeData: { type: "element", layerId: "layer-1", index: 0 },
				overId: "elem-x",
				overData: { type: "element", layerId: "layer-2", index: 1 },
			});
			const doc = createDocument([
				{ id: "layer-1", elementIds: ["elem-a"] },
				{ id: "layer-2", elementIds: ["elem-w", "elem-x"] },
			]);

			const result = resolveDragEndAction(event, doc);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("moveElementToLayer");
			const action = result as Extract<
				DragEndAction,
				{ type: "moveElementToLayer" }
			>;
			expect(action.sourceLayerId).toBe("layer-1");
			expect(action.elementIndex).toBe(0);
			expect(action.targetLayerId).toBe("layer-2");
			expect(action.targetIndex).toBe(1);
		});
	});

	describe("compound path source reorder", () => {
		it("reorders sources within the same compound path", () => {
			const cp = createCompoundPath("cp-1", [
				{ id: "src-a", op: "union" },
				{ id: "src-b", op: "subtract" },
				{ id: "src-c", op: "intersect" },
			]);

			const event = createDragEndEvent({
				activeId: "src-a",
				activeData: {
					type: "element",
					layerId: "layer-1",
					index: 0,
					parentContainerId: "cp-1",
				},
				overId: "src-c",
				overData: {
					type: "element",
					layerId: "layer-1",
					index: 2,
					parentContainerId: "cp-1",
				},
			});
			const doc = createDocument([{ id: "layer-1", elementIds: ["cp-1"] }], {
				"cp-1": cp,
			});

			const result = resolveDragEndAction(event, doc);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("reorderCompoundPathSource");
			const action = result as Extract<
				DragEndAction,
				{ type: "reorderCompoundPathSource" }
			>;
			expect(action.compoundPathId).toBe("cp-1");
			expect(action.fromIndex).toBe(0);
			expect(action.toIndex).toBe(2);
		});
	});

	describe("drag out of compound path to top-level element", () => {
		it("extracts source from compound path with target index", () => {
			const cp = createCompoundPath("cp-1", [
				{ id: "src-a", op: "union" },
				{ id: "src-b", op: "subtract" },
			]);

			const event = createDragEndEvent({
				activeId: "src-b",
				activeData: {
					type: "element",
					layerId: "layer-1",
					index: 1,
					parentContainerId: "cp-1",
				},
				overId: "elem-top",
				overData: { type: "element", layerId: "layer-1", index: 0 },
			});
			const doc = createDocument(
				[{ id: "layer-1", elementIds: ["cp-1", "elem-top"] }],
				{
					"cp-1": cp,
					"elem-top": createPath("elem-top"),
				},
			);

			const result = resolveDragEndAction(event, doc);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("extractSourceFromCompoundPath");
			const action = result as Extract<
				DragEndAction,
				{ type: "extractSourceFromCompoundPath" }
			>;
			expect(action.compoundPathId).toBe("cp-1");
			expect(action.sourceId).toBe("src-b");
			expect(action.targetLayerId).toBe("layer-1");
			expect(action.targetIndex).toBe(1);
		});
	});

	describe("blend children", () => {
		it("reorders sources within the same blend", () => {
			const blend = createBlend("b-1", ["a", "b", "c"]);
			const event = createDragEndEvent({
				activeId: "a",
				activeData: {
					type: "element",
					layerId: "layer-1",
					index: 0,
					parentContainerId: "b-1",
				},
				overId: "c",
				overData: {
					type: "element",
					layerId: "layer-1",
					index: 2,
					parentContainerId: "b-1",
				},
			});
			const doc = createDocument([{ id: "layer-1", elementIds: ["b-1"] }], {
				"b-1": blend,
			});

			const result = resolveDragEndAction(event, doc);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("reorderBlendChildren");
			const action = result as Extract<
				DragEndAction,
				{ type: "reorderBlendChildren" }
			>;
			expect(action.blendId).toBe("b-1");
			expect(action.fromIndex).toBe(0);
			expect(action.toIndex).toBe(2);
		});

		it("derives reorder indices from renderOrder when present", () => {
			// objectIds (morph) is [a,b,c] but the paint order is [c,b,a].
			const blend = createBlend("b-1", ["a", "b", "c"], undefined, [
				"c",
				"b",
				"a",
			]);
			const event = createDragEndEvent({
				activeId: "c",
				activeData: {
					type: "element",
					layerId: "layer-1",
					index: 0,
					parentContainerId: "b-1",
				},
				overId: "a",
				overData: {
					type: "element",
					layerId: "layer-1",
					index: 2,
					parentContainerId: "b-1",
				},
			});
			const doc = createDocument([{ id: "layer-1", elementIds: ["b-1"] }], {
				"b-1": blend,
			});

			const result = resolveDragEndAction(event, doc);
			expect(result).not.toBeNull();
			const action = result as Extract<
				DragEndAction,
				{ type: "reorderBlendChildren" }
			>;
			expect(action.type).toBe("reorderBlendChildren");
			// c is at renderOrder[0], a is at renderOrder[2].
			expect(action.fromIndex).toBe(0);
			expect(action.toIndex).toBe(2);
		});

		it("extracts a source from a blend when dragged to a layer header", () => {
			const blend = createBlend("b-1", ["a", "b", "c"]);
			const event = createDragEndEvent({
				activeId: "b",
				activeData: {
					type: "element",
					layerId: "layer-1",
					index: 1,
					parentContainerId: "b-1",
				},
				overId: "layer-header-2",
				overData: { type: "layer", layerId: "layer-2" },
			});
			const doc = createDocument(
				[
					{ id: "layer-1", elementIds: ["b-1"] },
					{ id: "layer-2", elementIds: [] },
				],
				{ "b-1": blend },
			);

			const result = resolveDragEndAction(event, doc);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("extractChildFromBlend");
			const action = result as Extract<
				DragEndAction,
				{ type: "extractChildFromBlend" }
			>;
			expect(action.blendId).toBe("b-1");
			expect(action.childId).toBe("b");
			expect(action.targetLayerId).toBe("layer-2");
			expect(action.targetIndex).toBeUndefined();
		});

		it("extracts a source from a blend to a top-level element with target index", () => {
			const blend = createBlend("b-1", ["a", "b", "c"]);
			const event = createDragEndEvent({
				activeId: "b",
				activeData: {
					type: "element",
					layerId: "layer-1",
					index: 1,
					parentContainerId: "b-1",
				},
				overId: "elem-top",
				overData: { type: "element", layerId: "layer-1", index: 1 },
			});
			const doc = createDocument(
				[{ id: "layer-1", elementIds: ["b-1", "elem-top"] }],
				{ "b-1": blend, "elem-top": createPath("elem-top") },
			);

			const result = resolveDragEndAction(event, doc);
			expect(result).not.toBeNull();
			expect(result!.type).toBe("extractChildFromBlend");
			const action = result as Extract<
				DragEndAction,
				{ type: "extractChildFromBlend" }
			>;
			expect(action.blendId).toBe("b-1");
			expect(action.childId).toBe("b");
			expect(action.targetLayerId).toBe("layer-1");
			expect(action.targetIndex).toBe(1);
		});

		it("returns null when dragging the spine row", () => {
			const blend = createBlend("b-1", ["a", "b"], "sp");
			const event = createDragEndEvent({
				activeId: "sp",
				activeData: {
					type: "element",
					layerId: "layer-1",
					index: 2,
					parentContainerId: "b-1",
				},
				overId: "layer-header-2",
				overData: { type: "layer", layerId: "layer-2" },
			});
			const doc = createDocument(
				[
					{ id: "layer-1", elementIds: ["b-1"] },
					{ id: "layer-2", elementIds: [] },
				],
				{ "b-1": blend },
			);

			expect(resolveDragEndAction(event, doc)).toBeNull();
		});

		it("returns null when dropping a key onto the spine row", () => {
			const blend = createBlend("b-1", ["a", "b"], "sp");
			const event = createDragEndEvent({
				activeId: "a",
				activeData: {
					type: "element",
					layerId: "layer-1",
					index: 0,
					parentContainerId: "b-1",
				},
				overId: "sp",
				overData: {
					type: "element",
					layerId: "layer-1",
					index: 2,
					parentContainerId: "b-1",
				},
			});
			const doc = createDocument([{ id: "layer-1", elementIds: ["b-1"] }], {
				"b-1": blend,
			});

			expect(resolveDragEndAction(event, doc)).toBeNull();
		});

		it("returns null when dropping a foreign element onto a blend child", () => {
			const blend = createBlend("b-1", ["a", "b"]);
			const event = createDragEndEvent({
				activeId: "elem-top",
				activeData: { type: "element", layerId: "layer-1", index: 0 },
				overId: "a",
				overData: {
					type: "element",
					layerId: "layer-1",
					index: 0,
					parentContainerId: "b-1",
				},
			});
			const doc = createDocument(
				[{ id: "layer-1", elementIds: ["elem-top", "b-1"] }],
				{ "b-1": blend, "elem-top": createPath("elem-top") },
			);

			expect(resolveDragEndAction(event, doc)).toBeNull();
		});
	});

	describe("unknown active type", () => {
		it("reorders a mesh container's children like a group's", () => {
			const mesh = {
				type: "mesh",
				id: "mesh-1",
				opacity: 1,
				blendMode: "normal",
				transform: { ...IDENTITY_TRANSFORM },
				childIds: ["child-a", "child-b"],
				vertices: [],
				faces: [],
			} as unknown as AnyArtObject;
			const document = createDocument(
				[{ id: "layer-1", elementIds: ["mesh-1"] }],
				{
					"mesh-1": mesh,
					"child-a": createPath("child-a"),
					"child-b": createPath("child-b"),
				},
			);
			const event = createDragEndEvent({
				activeId: "child-a",
				activeData: {
					type: "element",
					layerId: "layer-1",
					index: 0,
					parentContainerId: "mesh-1",
				},
				overId: "child-b",
				overData: {
					type: "element",
					layerId: "layer-1",
					index: 1,
					parentContainerId: "mesh-1",
				},
			});

			expect(resolveDragEndAction(event, document)).toEqual({
				type: "reorderGroupChildren",
				groupId: "mesh-1",
				fromIndex: 0,
				toIndex: 1,
			} satisfies DragEndAction);
		});

		it("extracts a mesh child to a layer header", () => {
			const mesh = {
				type: "mesh",
				id: "mesh-1",
				opacity: 1,
				blendMode: "normal",
				transform: { ...IDENTITY_TRANSFORM },
				childIds: ["child-a"],
				vertices: [],
				faces: [],
			} as unknown as AnyArtObject;
			const document = createDocument(
				[{ id: "layer-1", elementIds: ["mesh-1"] }],
				{
					"mesh-1": mesh,
					"child-a": createPath("child-a"),
				},
			);
			const event = createDragEndEvent({
				activeId: "child-a",
				activeData: {
					type: "element",
					layerId: "layer-1",
					index: 0,
					parentContainerId: "mesh-1",
				},
				overId: "layer-1",
				overData: { type: "layer", layerId: "layer-1" },
			});

			expect(resolveDragEndAction(event, document)).toEqual({
				type: "extractChildFromGroup",
				groupId: "mesh-1",
				childId: "child-a",
				targetLayerId: "layer-1",
			} satisfies DragEndAction);
		});

		it("returns null for an unrecognized active data type", () => {
			const event = createDragEndEvent({
				activeId: "unknown-1",
				activeData: { type: "something-else", layerId: "layer-1" },
				overId: "elem-a",
				overData: { type: "element", layerId: "layer-1", index: 0 },
			});
			const doc = createDocument([{ id: "layer-1", elementIds: ["elem-a"] }]);

			expect(resolveDragEndAction(event, doc)).toBeNull();
		});

		it("returns null when active data is undefined", () => {
			const event = createDragEndEvent({
				activeId: "no-data",
				overId: "elem-a",
				overData: { type: "element", layerId: "layer-1", index: 0 },
			});
			const doc = createDocument([{ id: "layer-1", elementIds: ["elem-a"] }]);

			expect(resolveDragEndAction(event, doc)).toBeNull();
		});
	});
});

describe("filterLayerList", () => {
	const LOCKED: LayerPanelFilter = { locked: true, hidden: false };

	it("keeps a locked top-level element without its siblings", () => {
		const document = createFilterDocument({ "rect-b": { locked: true } });

		const { shownIds, openRootIds } = filterLayerList(document, LOCKED, true);

		expect([...shownIds]).toEqual(["rect-b", "layer-1"]);
		expect([...openRootIds]).toEqual(["layer-1"]);
	});

	it("keeps the top-level container of a nested match and opens every container on the way", () => {
		const document = createFilterDocument({ "path-p3": { locked: true } });

		const { shownIds, openElementIds } = filterLayerList(
			document,
			LOCKED,
			true,
		);

		expect([...shownIds]).toEqual(["group-g", "layer-1"]);
		expect([...openElementIds].sort()).toEqual(["group-g", "group-h"]);
	});

	it("keeps entries matching either enabled flag", () => {
		const document = createFilterDocument({
			"rect-a": { visible: false },
			"rect-b": { locked: true },
		});

		const { shownIds } = filterLayerList(
			document,
			{ locked: true, hidden: true },
			true,
		);

		expect([...shownIds]).toEqual(["rect-a", "rect-b", "layer-1"]);
	});

	it("ignores a flag whose condition is off", () => {
		const document = createFilterDocument({ "rect-b": { locked: true } });

		const { shownIds } = filterLayerList(
			document,
			{ locked: false, hidden: true },
			true,
		);

		expect(shownIds.size).toBe(0);
	});

	it("keeps a locked layer without listing its unmatched elements", () => {
		const document = createFilterDocument({ "layer-2": { locked: true } });

		const { shownIds, openRootIds } = filterLayerList(document, LOCKED, true);

		expect([...shownIds]).toEqual(["layer-2"]);
		expect(openRootIds.size).toBe(0);
	});

	it("leaves a matched container closed when nothing inside it matches", () => {
		const document = createFilterDocument({ "group-g": { locked: true } });

		const { shownIds, openElementIds } = filterLayerList(
			document,
			LOCKED,
			true,
		);

		expect([...shownIds]).toEqual(["group-g", "layer-1"]);
		expect(openElementIds.size).toBe(0);
	});

	it("narrows an editing scope's direct children like a layer's", () => {
		const { objects } = createFilterDocument({ "path-p3": { locked: true } });

		const { shownIds, openElementIds } = filterLayerList(
			{
				roots: [{ id: "group-g", elementIds: ["path-p1", "group-h"] }],
				objects,
			},
			LOCKED,
			true,
		);

		expect([...shownIds]).toEqual(["group-h", "group-g"]);
		expect([...openElementIds]).toEqual(["group-h"]);
	});

	it("matches layers by their own flags only when element rows are not drawn", () => {
		const document = createFilterDocument({
			"rect-b": { locked: true },
			"layer-2": { locked: true },
		});

		const { shownIds } = filterLayerList(document, LOCKED, false);

		expect([...shownIds]).toEqual(["layer-2"]);
	});
});

describe("LayerPanel", () => {
	beforeEach(() => {
		renderedRowNames.length = 0;
	});

	it("re-renders only the changed row when an element is renamed", async () => {
		const { store } = renderLayerPanel();
		renderedRowNames.length = 0;

		await act(async () => {
			commitObjectsDelta(store, [
				{ ...store.document.objects["rect-b"], name: "renamed" },
			]);
		});

		expect(renderedElementRows()).toEqual(["renamed"]);
	});

	it("re-renders only the added row when an element is added to a layer", async () => {
		const { store } = renderLayerPanel();
		renderedRowNames.length = 0;

		await act(async () => {
			const added = createNamedPath("path-new");
			const layer = store.document.layers[0];
			store.document.layers = [
				{ ...layer, elementIds: [...layer.elementIds, added.id] },
			];
			commitObjectsDelta(store, [added]);
		});

		expect(renderedElementRows()).toEqual(["path-new"]);
	});

	it("re-renders only the added row and its parent when an element is added to a group", async () => {
		const { store, result } = renderLayerPanel();
		const expandButton = result.container.querySelector(
			'[data-element-id="group-g"] button',
		);
		if (!expandButton) throw new Error("group-g has no expand button");
		await act(async () => {
			fireEvent.click(expandButton);
		});
		renderedRowNames.length = 0;

		await act(async () => {
			const added = createNamedPath("path-new");
			const group = store.document.objects["group-g"] as Group;
			commitObjectsDelta(store, [
				{ ...group, childIds: [...group.childIds, added.id] },
				added,
			]);
		});

		expect(renderedElementRows().toSorted()).toEqual(["group-g", "path-new"]);
	});
});

const renderedRowNames = vi.hoisted((): (string | undefined)[] => []);

vi.mock("@/components/FakeInput", () => ({
	// Every row draws exactly one name field, so its renders count the row's.
	FakeInput: ({ value }: { value?: string }) => {
		renderedRowNames.push(value);
		return null;
	},
}));

const LAYER_NAME = "Layer 1";

/**
 * layer-1: rect-a, group-g (path-p1), rect-b — rect-a selected
 */
function renderLayerPanel() {
	const store = createRendererState();
	const elements = [
		createNamedPath("rect-a"),
		{ ...createNamedPath("group-g"), type: "group", childIds: ["path-p1"] },
		createNamedPath("path-p1"),
		createNamedPath("rect-b"),
	] as AnyArtObject[];
	store.document.layers = [
		{
			...createDefaultLayer("layer-1", LAYER_NAME),
			elementIds: ["rect-a", "group-g", "rect-b"],
		},
	];
	store.document.objects = Object.fromEntries(elements.map((e) => [e.id, e]));
	store.currentLayerId = "layer-1";
	store.selectedElementIds = ["rect-a"];
	// Element rows are drawn only in the detailed mode.
	setLayerPanelMode("detailed");

	const paplico = {
		uiState: store,
		commands: {},
		selection: {},
		isReadonly: false,
		setHoveredElement: () => {},
		clearHoveredElement: () => {},
	} as unknown as Paplico;

	const result = render(
		<PaplicoProvider paplico={paplico}>
			<LayerPanel />
		</PaplicoProvider>,
	);
	return { store, result };
}

/** Applies changed elements the way the engine's per-object sync does, including its selection prune. */
function commitObjectsDelta(
	store: ReturnType<typeof createRendererState>,
	changed: AnyArtObject[],
) {
	store.document.objects = {
		...store.document.objects,
		...Object.fromEntries(changed.map((e) => [e.id, e])),
	};
	store.selectedElementIds = store.selectedElementIds.filter(
		(id) => store.document.objects[id],
	);
}

function renderedElementRows() {
	return renderedRowNames.filter((name) => name !== LAYER_NAME);
}

function createNamedPath(id: string): AnyArtObject {
	return { ...createPath(id), name: id } as AnyArtObject;
}

/**
 * layer-1: rect-a, group-g (path-p1, group-h (path-p2, path-p3)), rect-b
 * layer-2: circle-c
 */
function createFilterDocument(
	flags: Record<string, { locked?: boolean; visible?: boolean }>,
) {
	const createGroup = (id: string, childIds: string[]) =>
		({ ...createPath(id), type: "group", childIds }) as AnyArtObject;
	const objects: Record<string, AnyArtObject> = Object.fromEntries(
		[
			createPath("rect-a"),
			createGroup("group-g", ["path-p1", "group-h"]),
			createPath("path-p1"),
			createGroup("group-h", ["path-p2", "path-p3"]),
			createPath("path-p2"),
			createPath("path-p3"),
			createPath("rect-b"),
			createPath("circle-c"),
		].map((element) => [element.id, { ...element, ...flags[element.id] }]),
	);
	const layers = [
		{ id: "layer-1", elementIds: ["rect-a", "group-g", "rect-b"] },
		{ id: "layer-2", elementIds: ["circle-c"] },
	].map((layer) => ({
		locked: false,
		visible: true,
		...layer,
		...flags[layer.id],
	}));

	return { roots: layers, objects };
}
