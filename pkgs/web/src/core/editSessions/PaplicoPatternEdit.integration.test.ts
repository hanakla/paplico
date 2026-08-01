import { describe, expect, it } from "vitest";
import { extractDocumentFromYDoc } from "../collaboration/extractDocumentFromYDoc";
import {
	YjsProvider,
	type YjsProviderCallbacks,
} from "../collaboration/YjsProvider";
import { createIdentityTransform } from "../document/factory";
import type { RendererState } from "../Paplico";
import type { DefEntry, Path } from "../schema";
import { PATTERN_EDIT_ORIGIN, PaplicoPatternEdit } from "./PaplicoPatternEdit";

/**
 * Integration tests for PaplicoPatternEdit against a *real* YjsProvider (no
 * mocks). These exist because the origin-tagging design (session edits under
 * PATTERN_EDIT_ORIGIN, main document edits under `null`) can only be verified
 * end-to-end: a mocked YjsProvider can't tell us whether the main
 * UndoManager's `trackedOrigins` filter actually excludes session edits, or
 * whether a commit()/cancel() genuinely leaves no trace in the main undo
 * stack.
 */
describe("PaplicoPatternEdit (integration, real YjsProvider)", () => {
	it("undoes and redoes an in-session edit via patternEdit.undo()/redo()", () => {
		const { provider, store, sync, patternEdit, defEntry } =
			setupSessionFixture();

		expect(patternEdit.enter(defEntry.id)).toBe(true);
		sync();
		const session = patternEdit.getSession();
		if (!session) throw new Error("session should be active");
		const workingId = session.rootWorkingElementIds[0];

		const before = store.document.objects[workingId].transform.x;
		provider.updateElement(
			session.transientLayerId,
			workingId,
			{
				transform: {
					...store.document.objects[workingId].transform,
					x: before + 50,
				},
			},
			PATTERN_EDIT_ORIGIN,
		);
		sync();
		expect(store.document.objects[workingId].transform.x).toBe(before + 50);

		expect(patternEdit.undo()).toBe(true);
		sync();
		expect(store.document.objects[workingId].transform.x).toBe(before);

		expect(patternEdit.redo()).toBe(true);
		sync();
		expect(store.document.objects[workingId].transform.x).toBe(before + 50);
	});

	it("keeps session edits out of the main undo history while a session is active", () => {
		const { provider, store, sync, patternEdit, defEntry } =
			setupSessionFixture();

		expect(patternEdit.enter(defEntry.id)).toBe(true);
		sync();
		// The expansion itself (addObjectOnly + addLayer) must not be visible
		// to the main undo stack either.
		expect(provider.canUndo()).toBe(false);

		const session = patternEdit.getSession();
		if (!session) throw new Error("session should be active");
		const workingId = session.rootWorkingElementIds[0];
		provider.updateElement(
			session.transientLayerId,
			workingId,
			{
				transform: { ...store.document.objects[workingId].transform, x: 999 },
			},
			PATTERN_EDIT_ORIGIN,
		);
		sync();

		expect(provider.canUndo()).toBe(false);
	});

	it("commit() records one main-undo step, and undoing it does not resurrect the transient layer", () => {
		const { provider, store, sync, patternEdit, defEntry } =
			setupSessionFixture();

		expect(patternEdit.enter(defEntry.id)).toBe(true);
		sync();
		const session = patternEdit.getSession();
		if (!session) throw new Error("session should be active");
		const transientLayerId = session.transientLayerId;

		expect(patternEdit.commit()).toBe(true);
		sync();
		expect(store.document.layers.some((l) => l.id === transientLayerId)).toBe(
			false,
		);
		expect(provider.canUndo()).toBe(true);

		provider.undo();
		sync();

		// The def is restored to its pre-session member list...
		expect(store.document.defs?.[defEntry.id]?.rootElementIds).toEqual(
			defEntry.rootElementIds,
		);
		// ...and the transient layer's teardown (tagged PATTERN_EDIT_ORIGIN,
		// outside the main undo stack) is not reverted by this undo.
		expect(store.document.layers.some((l) => l.id === transientLayerId)).toBe(
			false,
		);
	});

	it("cancel() removes the transient layer and its objects without touching the main undo history", () => {
		const { store, provider, sync, patternEdit, defEntry } =
			setupSessionFixture();

		expect(patternEdit.enter(defEntry.id)).toBe(true);
		sync();
		const session = patternEdit.getSession();
		if (!session) throw new Error("session should be active");
		const transientLayerId = session.transientLayerId;
		const workingIds = session.workingElementIds;

		expect(patternEdit.cancel()).toBe(true);
		sync();

		expect(store.document.layers.some((l) => l.id === transientLayerId)).toBe(
			false,
		);
		for (const id of workingIds) {
			expect(store.document.objects[id]).toBeUndefined();
		}
		expect(store.document.defs?.[defEntry.id]?.rootElementIds).toEqual(
			defEntry.rootElementIds,
		);
		expect(provider.canUndo()).toBe(false);
	});

	it("promotes an element added mid-session (not just the enter()-time snapshot) into the def on commit", () => {
		const { provider, store, sync, patternEdit, defEntry } =
			setupSessionFixture();

		expect(patternEdit.enter(defEntry.id)).toBe(true);
		sync();
		const session = patternEdit.getSession();
		if (!session) throw new Error("session should be active");

		// Simulates the pen tool drawing a brand-new stroke mid-session: once
		// getMutationOrigin is wired (PaplicoCommands -> Paplico), any new
		// element PaplicoCommands.addPath() adds during an active session is
		// tagged PATTERN_EDIT_ORIGIN, same as this direct provider call.
		const newStroke = createPath("mid-session-stroke", 500);
		provider.addElement(
			session.transientLayerId,
			newStroke,
			PATTERN_EDIT_ORIGIN,
		);
		sync();
		expect(
			store.document.layers.find((l) => l.id === session.transientLayerId)
				?.elementIds,
		).toContain(newStroke.id);

		expect(patternEdit.commit()).toBe(true);
		sync();

		const updatedDef = store.document.defs?.[defEntry.id];
		expect(updatedDef?.rootElementIds).toContain(newStroke.id);
		expect(store.document.objects[newStroke.id]).toBeDefined();
	});

	it("discards an element added mid-session on cancel", () => {
		const { provider, store, sync, patternEdit, defEntry } =
			setupSessionFixture();

		expect(patternEdit.enter(defEntry.id)).toBe(true);
		sync();
		const session = patternEdit.getSession();
		if (!session) throw new Error("session should be active");

		const newStroke = createPath("mid-session-stroke-2", 500);
		provider.addElement(
			session.transientLayerId,
			newStroke,
			PATTERN_EDIT_ORIGIN,
		);
		sync();

		expect(patternEdit.cancel()).toBe(true);
		sync();

		expect(store.document.objects[newStroke.id]).toBeUndefined();
		expect(store.document.defs?.[defEntry.id]?.rootElementIds).toEqual(
			defEntry.rootElementIds,
		);
	});
});

function setup() {
	let store!: RendererState;
	const callbacks: YjsProviderCallbacks = {
		onDocumentUpdate: (doc) => {
			store.document = doc;
		},
		onLayersUpdate: () => {},
		getCurrentLayerId: () => store.currentLayerId,
		setCurrentLayerId: (layerId) => {
			store.currentLayerId = layerId;
		},
	};
	const provider = new YjsProvider({ callbacks });

	store = {
		currentLayerId: null,
		editingScopeStack: [] as string[],
		selectedElementIds: [] as string[],
		selectionBounds: null,
		document: extractDocumentFromYDoc(provider.ydoc),
		transientElements: new Map(),
		uiOverlayState: {},
		patternEditSession: null,
		canUndo: false,
		canRedo: false,
	} as unknown as RendererState;

	// Explicit re-sync after every provider call — syncYjsToValtio only fires
	// onDocumentUpdate on a "full sync" (layers + objects changed together);
	// object-only or defs-only transactions may take a narrower delta path.
	// Pulling a fresh extractDocumentFromYDoc() snapshot after each action
	// keeps `store.document` correct regardless of which internal path fired.
	const sync = () => {
		store.document = extractDocumentFromYDoc(provider.ydoc);
	};

	const patternEdit = new PaplicoPatternEdit({
		store,
		yjsProvider: provider,
		setOverlay: () => {},
	});

	return { provider, store, sync, patternEdit };
}

/** setup() plus a single-Path pattern def, with a clean main-undo baseline. */
function setupSessionFixture() {
	const { provider, store, sync, patternEdit } = setup();

	const original = createPath("p1");
	provider.addObjectOnly(original);
	const defEntry: DefEntry = {
		id: "def-1",
		kind: "pattern",
		rootElementIds: [original.id],
		tile: { width: 100, height: 100 },
	};
	provider.createDef(defEntry);
	sync();

	// Baseline: the initial-document setup itself must not count as
	// undoable session work.
	provider.clearUndoHistory();
	sync();

	return { provider, store, sync, patternEdit, original, defEntry };
}

function createPath(id: string, x = 0): Path {
	return {
		type: "path",
		id,
		segments: [
			{
				start: { x, y: 0 },
				cp1: { x, y: 0 },
				cp2: { x, y: 0 },
				end: { x: x + 100, y: 0 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: true,
			},
		],
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}
