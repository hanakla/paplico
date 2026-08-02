import { beforeEach, describe, expect, it, vi } from "vitest";
import type { YjsProvider } from "./collaboration/YjsProvider";
import { createIdentityTransform } from "./document/factory";
import type { SpatialIndex } from "./document/SpatialIndex";
import type { RendererState } from "./Paplico";
import { PaplicoCommands } from "./PaplicoCommands";
import type { AnyArtObject, Layer } from "./schema";

function createPath(id: string): AnyArtObject {
	return {
		type: "path",
		id,
		segments: [],
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}

function createLayer(id: string, elementIds: string[]): Layer {
	return {
		id,
		name: id,
		visible: true,
		locked: false,
		opacity: 1,
		elementIds,
	};
}

describe("PaplicoCommands.groupSelectedElements", () => {
	let store: RendererState;
	let moveElementToLayer: ReturnType<typeof vi.fn>;
	let groupElements: ReturnType<typeof vi.fn>;
	let groupElementsInGroup: ReturnType<typeof vi.fn>;
	let removeElement: ReturnType<typeof vi.fn>;
	let insertElement: ReturnType<typeof vi.fn>;
	let commands: PaplicoCommands;

	beforeEach(() => {
		moveElementToLayer = vi.fn();
		groupElements = vi.fn().mockReturnValue("group-1");
		groupElementsInGroup = vi.fn().mockReturnValue("group-1");
		removeElement = vi.fn();
		insertElement = vi.fn();

		store = {
			currentLayerId: "layer-0",
			selectedElementIds: [],
			editingScopeStack: [],
			document: {
				layers: [
					createLayer("layer-0", ["a0", "a1", "parent-group"]),
					createLayer("layer-1", ["b0", "b1"]),
				],
				objects: {
					a0: createPath("a0"),
					a1: createPath("a1"),
					b0: createPath("b0"),
					b1: createPath("b1"),
					"parent-group": {
						type: "group",
						id: "parent-group",
						childIds: ["c0", "c1", "c2"],
						opacity: 1,
						blendMode: "normal",
						transform: createIdentityTransform(),
					} as unknown as AnyArtObject,
					c0: createPath("c0"),
					c1: createPath("c1"),
					c2: createPath("c2"),
				},
			},
		} as unknown as RendererState;

		commands = new PaplicoCommands({
			store,
			yjsProvider: {
				moveElementToLayer,
				groupElements,
				groupElementsInGroup,
			} as unknown as YjsProvider,
			spatial: {
				removeElement,
				insertElement,
				isElementLocked: () => false,
			} as unknown as SpatialIndex,
			isReadonly: () => false,
		});
	});

	it("moves cross-layer selection to the topmost layer and preserves global order", () => {
		const groupId = commands.groupSelectedElements(["b0", "a1", "a0"]);

		expect(groupId).toBe("group-1");
		expect(moveElementToLayer.mock.calls).toEqual([
			["layer-0", "a0", "layer-1", undefined, undefined],
			["layer-0", "a1", "layer-1", undefined, undefined],
		]);
		expect(groupElements).toHaveBeenCalledTimes(1);
		expect(groupElements.mock.calls[0]).toEqual([
			"layer-1",
			["a0", "a1", "b0"],
			undefined,
		]);
		expect(store.currentLayerId).toBe("layer-1");
		expect(store.selectedElementIds).toEqual(["group-1"]);
	});

	it("preserves order in same-layer grouping regardless of selection order", () => {
		const groupId = commands.groupSelectedElements(["a1", "a0"]);

		expect(groupId).toBe("group-1");
		expect(moveElementToLayer).not.toHaveBeenCalled();
		expect(groupElements).toHaveBeenCalledTimes(1);
		expect(groupElements.mock.calls[0]).toEqual([
			"layer-0",
			["a0", "a1"],
			undefined,
		]);
		expect(store.currentLayerId).toBe("layer-0");
		expect(store.selectedElementIds).toEqual(["group-1"]);
	});

	it("returns null when there are fewer than two valid selected elements", () => {
		expect(commands.groupSelectedElements(["a0"])).toBeNull();
		expect(commands.groupSelectedElements(["a0", "missing"])).toBeNull();
		expect(groupElements).not.toHaveBeenCalled();
	});

	it("groups inside the editing scope preserving childIds stacking order", () => {
		store.editingScopeStack = ["parent-group"];

		// Selection order scrambled vs. the parent's childIds order (c0, c1, c2).
		const groupId = commands.groupSelectedElements(["c2", "c0"]);

		expect(groupId).toBe("group-1");
		expect(groupElementsInGroup).toHaveBeenCalledTimes(1);
		expect(groupElementsInGroup.mock.calls[0]).toEqual([
			"parent-group",
			["c0", "c2"],
			undefined,
		]);
		expect(groupElements).not.toHaveBeenCalled();
		expect(moveElementToLayer).not.toHaveBeenCalled();
		expect(store.selectedElementIds).toEqual(["group-1"]);
	});

	it("returns null in an editing scope when fewer than two selected elements are scope children", () => {
		store.editingScopeStack = ["parent-group"];

		// a0 lives at the layer root, not in the editing scope's childIds.
		expect(commands.groupSelectedElements(["c0", "a0"])).toBeNull();
		expect(groupElementsInGroup).not.toHaveBeenCalled();
		expect(groupElements).not.toHaveBeenCalled();
	});
});
