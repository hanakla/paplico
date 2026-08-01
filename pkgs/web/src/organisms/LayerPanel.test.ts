import type { DragEndEvent } from "@dnd-kit/core";
import { describe, expect, it } from "vitest";
import type { AnyArtObject, CompoundPath } from "@/core/schema";
import {
	type DragEndAction,
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
