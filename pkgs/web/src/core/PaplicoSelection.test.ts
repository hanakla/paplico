import { describe, expect, it, vi } from "vitest";
import type { SpatialIndex } from "./document/SpatialIndex";
import type { RendererState } from "./Paplico";
import { PaplicoSelection } from "./PaplicoSelection";

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
