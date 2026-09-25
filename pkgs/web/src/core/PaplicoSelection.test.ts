import { describe, expect, it, vi } from "vitest";
import { createIdentityTransform } from "./document/factory";
import { createRendererState } from "./document/rendererState";
import { SpatialIndex } from "./document/SpatialIndex";
import type { RendererState } from "./Paplico";
import { PaplicoSelection } from "./PaplicoSelection";
import type { AnyArtObject } from "./schema";

/**
 * A session lends the tools a working layer and pushes it onto the editing
 * scope stack. Every route out of a scope has to let the session close itself
 * first — popping its entry from underneath leaves it believing it is open,
 * with its layer stranded in the document.
 */
describe("PaplicoSelection: leaving a scope a session owns", () => {
	it("should let the session close itself when exiting one level", () => {
		const { selection, closeSession, store } = setup(["group-1", "session-1"]);

		selection.exitEditingScopeOneLevel();

		expect(closeSession).toHaveBeenCalledWith("session-1");
		// The session popped its own entry; the caller must not pop a second.
		expect(store.editingScopeStack).toEqual(["group-1"]);
	});

	it("should pop normally when no session owns the entry", () => {
		const { selection, closeSession, store } = setup(["group-1", "group-2"]);

		selection.exitEditingScopeOneLevel();

		expect(closeSession).toHaveBeenCalledWith("group-2");
		expect(store.editingScopeStack).toEqual(["group-1"]);
	});

	it("should let the session close itself when exiting every level", () => {
		const { selection, closeSession, store } = setup(["group-1", "session-1"]);

		selection.exitEditingScope();

		expect(closeSession).toHaveBeenCalledWith("session-1");
		expect(store.editingScopeStack).toEqual([]);
	});

	it("should let the session close itself when the breadcrumb jumps below it", () => {
		const { selection, closeSession, store } = setup(["group-1", "session-1"]);

		selection.navigateToScopeLevel("group-1");

		expect(closeSession).toHaveBeenCalledWith("session-1");
		expect(store.editingScopeStack).toEqual(["group-1"]);
	});

	it("should leave a scope the breadcrumb keeps alone", () => {
		const { selection, closeSession, store } = setup([
			"group-1",
			"group-2",
			"session-1",
		]);

		selection.navigateToScopeLevel("group-2");

		expect(closeSession).toHaveBeenCalledWith("session-1");
		expect(store.editingScopeStack).toEqual(["group-1", "group-2"]);
	});
});

/**
 * Undo / redo selects what it changed so the user can see the effect of the
 * step, the same way a fresh edit leaves its result selected.
 */
describe("PaplicoSelection: selecting what an undo or redo changed", () => {
	it("should select the changed objects", () => {
		const { selection, store } = setupDocument();

		selection.selectChangedByHistory(new Set(["a1", "a2"]));

		expect(store.selectedElementIds).toEqual(["a1", "a2"]);
	});

	it("should select a changed child itself instead of its group", () => {
		const { selection, store } = setupDocument();

		// Restoring a deleted child also rewrites the group's child list.
		selection.selectChangedByHistory(new Set(["group", "child"]));

		expect(store.selectedElementIds).toEqual(["child"]);
	});

	it("should switch to the frontmost layer the changes span", () => {
		const { selection, store } = setupDocument();

		selection.selectChangedByHistory(new Set(["a1", "b1"]));

		expect(store.currentLayerId).toBe("layer-b");
		expect(store.selectedElementIds).toEqual(["a1", "b1"]);
	});

	it("should clear the selection when every changed object was deleted", () => {
		const { selection, store } = setupDocument();
		store.selectedElementIds = ["a1"];

		selection.selectChangedByHistory(new Set(["deleted"]));

		expect(store.selectedElementIds).toEqual([]);
	});

	it("should skip changed objects that are locked or hidden", () => {
		const { selection, store } = setupDocument();

		selection.selectChangedByHistory(new Set(["a1", "locked", "hidden"]));

		expect(store.selectedElementIds).toEqual(["a1"]);
	});
});

describe("PaplicoSelection: selecting one element", () => {
	it("should frame a child of a moved group where the group draws it", () => {
		const store = createRendererState();
		store.document.objects = {
			group: {
				type: "group",
				id: "group",
				childIds: ["child"],
				opacity: 1,
				blendMode: "normal",
				transform: { ...createIdentityTransform(), x: 300 },
			},
			child: {
				type: "image",
				id: "child",
				fileUid: "file-1",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			},
		} as Record<string, AnyArtObject>;
		store.document.layers = [
			{
				id: "layer",
				name: "layer",
				visible: true,
				locked: false,
				opacity: 1,
				blendMode: "normal",
				elementIds: ["group"],
			},
		];
		const spatial = new SpatialIndex(store);
		spatial.rebuildAllIndices();
		const selection = new PaplicoSelection(store, spatial);

		selection.selectElement("child");

		expect(store.selectionBounds).toMatchObject({ minX: 250, maxX: 350 });
	});
});

/** `session-*` ids stand for scope entries a session owns: closing one pops
 *  its own entry, exactly as the real sessions' teardown does. */
function setup(stack: string[]) {
	const store = {
		editingScopeStack: [...stack],
		selectedElementIds: [],
		selectionBounds: null,
		// clear() writes the selection overlay through this channel.
		uiOverlayState: { overlays: {} },
		document: { layers: [], objects: {} },
	} as unknown as RendererState;

	const closeSession = vi.fn((scopeId: string) => {
		if (!scopeId.startsWith("session-")) return false;
		const idx = store.editingScopeStack.lastIndexOf(scopeId);
		if (idx >= 0) store.editingScopeStack.splice(idx, 1);
		return true;
	});

	const selection = new PaplicoSelection(
		store,
		{} as unknown as SpatialIndex,
		closeSession,
	);
	return { selection, closeSession, store };
}

/** Back layer "layer-a" holds a1, a2, a group with one child, and a locked and
 *  a hidden path. Front layer "layer-b" holds b1. */
function setupDocument() {
	const store = createRendererState();
	const path = (id: string, extra?: object) =>
		({
			type: "path",
			id,
			opacity: 1,
			visible: true,
			blendMode: "normal",
			segments: [],
			filters: [],
			transform: createIdentityTransform(),
			...extra,
		}) as unknown as AnyArtObject;
	const layer = (id: string, elementIds: string[]) => ({
		id,
		name: id,
		visible: true,
		locked: false,
		opacity: 1,
		blendMode: "normal" as const,
		elementIds,
	});
	store.document.objects = {
		a1: path("a1"),
		a2: path("a2"),
		child: path("child"),
		group: { ...path("group"), type: "group", childIds: ["child"] },
		locked: path("locked", { locked: true }),
		hidden: path("hidden", { visible: false }),
		b1: path("b1"),
	} as Record<string, AnyArtObject>;
	store.document.layers = [
		layer("layer-a", ["a1", "a2", "group", "locked", "hidden"]),
		layer("layer-b", ["b1"]),
	];
	store.currentLayerId = "layer-a";

	const spatial = new SpatialIndex(store);
	spatial.rebuildAllIndices();
	return { selection: new PaplicoSelection(store, spatial), store };
}
