import { describe, expect, it, vi } from "vitest";
import type { YjsProvider } from "../collaboration/YjsProvider";
import { createIdentityTransform } from "../document/factory";
import type { RendererState } from "../Paplico";
import type { RectPrimitive, UIOverlay } from "../renderer/ui/primitives";
import type { AnyArtObject, DefEntry, Layer, Path } from "../schema";
import { TRANSIENT_LAYER_KIND } from "../schema";
import { PATTERN_EDIT_ORIGIN, PaplicoPatternEdit } from "./PaplicoPatternEdit";

describe("PaplicoPatternEdit", () => {
	it("returns false when entering a missing or empty def", () => {
		const { patternEdit } = setup();
		expect(patternEdit.enter("missing-def")).toBe(false);
		expect(patternEdit.isActive()).toBe(false);
	});

	it("clears the previous selection when entering a session", () => {
		const p = createPath("p1");
		const objects: Record<string, AnyArtObject> = { [p.id]: p };
		const defEntry: DefEntry = {
			id: "def-1",
			kind: "pattern",
			rootElementIds: [p.id],
			tile: { width: 100, height: 100 },
		};
		const { patternEdit, store } = setup({
			defs: { [defEntry.id]: defEntry },
			objects,
		});
		store.selectedElementIds = ["stale-selection"];
		store.selectionBounds = {
			minX: 0,
			minY: 0,
			maxX: 10,
			maxY: 10,
			width: 10,
			height: 10,
		};
		store.uiOverlayState.overlays = {
			"sys/selection": { primitives: [] },
		};

		expect(patternEdit.enter(defEntry.id)).toBe(true);
		expect(store.selectedElementIds).toEqual([]);
		expect(store.selectionBounds).toBeNull();
		expect(store.uiOverlayState.overlays["sys/selection"]).toBeUndefined();
	});

	it("enter() expands def members onto a transient layer, commit() replaces def members with the new ids", () => {
		const p = createPath("p1");
		const objects: Record<string, AnyArtObject> = { [p.id]: p };
		const defEntry: DefEntry = {
			id: "def-1",
			kind: "pattern",
			rootElementIds: [p.id],
			tile: { width: 100, height: 100 },
		};
		const {
			patternEdit,
			addObjectOnly,
			addLayer,
			replaceDefElements,
			deleteLayer,
			deleteElements,
			updateElement,
			store,
		} = setup({ defs: { [defEntry.id]: defEntry }, objects });

		expect(patternEdit.enter(defEntry.id)).toBe(true);
		expect(patternEdit.isActive()).toBe(true);
		expect(addObjectOnly).toHaveBeenCalled();
		expect(addLayer).toHaveBeenCalledTimes(1);
		const transientLayer = addLayer.mock.calls[0][0] as Layer;
		expect(transientLayer.transientKind).toBe(
			TRANSIENT_LAYER_KIND.PATTERN_EDIT,
		);
		expect(transientLayer.ownerClientId).toBe("42");
		expect(store.currentLayerId).toBe(transientLayer.id);
		// Editing-group stack was extended with the transient layer id.
		expect(store.editingScopeStack).toContain(transientLayer.id);

		// Sanity: working-copy ids must differ from the source def member id.
		const session = patternEdit.getSession();
		expect(session?.workingElementIds).not.toContain(p.id);
		if (!session) throw new Error("session should be active");

		expect(patternEdit.commit()).toBe(true);
		expect(updateElement).toHaveBeenCalled();
		expect(replaceDefElements).toHaveBeenCalledWith(
			defEntry.id,
			session.rootWorkingElementIds,
			null,
		);
		expect(deleteElements).not.toHaveBeenCalled();
		expect(deleteLayer).toHaveBeenCalledWith(
			transientLayer.id,
			{ deleteObjects: false },
			PATTERN_EDIT_ORIGIN,
		);
		expect(patternEdit.isActive()).toBe(false);
		expect(store.currentLayerId).toBe("layer-1");
		expect(store.editingScopeStack).not.toContain(transientLayer.id);
	});

	it("uses the active viewport center when expanding a pattern edit session", () => {
		const p = createPath("p1");
		const objects: Record<string, AnyArtObject> = { [p.id]: p };
		const defEntry: DefEntry = {
			id: "def-1",
			kind: "pattern",
			rootElementIds: [p.id],
			tile: { width: 100, height: 100 },
		};
		const viewportCenter = { x: 320, y: -180 };
		const { patternEdit, addObjectOnly } = setup({
			defs: { [defEntry.id]: defEntry },
			objects,
			viewportCenter,
		});

		expect(patternEdit.enter(defEntry.id)).toBe(true);

		const addedRoot = addObjectOnly.mock.calls[0]?.[0] as
			| AnyArtObject
			| undefined;
		expect(addedRoot?.transform.x).toBe(viewportCenter.x);
		expect(addedRoot?.transform.y).toBe(viewportCenter.y);
		expect(patternEdit.getSession()?.expansionOffset).toEqual(viewportCenter);
	});

	it("aligns the tile guide with the expanded working-copy bounds", () => {
		const p = createPath("p1");
		const objects: Record<string, AnyArtObject> = { [p.id]: p };
		const tile = { width: 100, height: 100 };
		const defEntry: DefEntry = {
			id: "def-1",
			kind: "pattern",
			rootElementIds: [p.id],
			tile,
		};
		const viewportCenter = { x: 320, y: -180 };
		const { patternEdit, overlays } = setup({
			defs: { [defEntry.id]: defEntry },
			objects,
			viewportCenter,
		});

		expect(patternEdit.enter(defEntry.id)).toBe(true);

		const rootBounds = patternEdit.getSessionRootBounds();
		// Tile guide renders as a center+size rect primitive in the overlay
		const tileGuide = overlays["pattern-edit/tile"]?.primitives.find(
			(p): p is RectPrimitive => p.kind === "rect",
		);
		expect(rootBounds).not.toBeNull();
		expect(tileGuide).toBeDefined();
		if (!rootBounds || !tileGuide) {
			throw new Error("pattern edit overlay should be available");
		}

		expect(tileGuide.cx).toBe((rootBounds.minX + rootBounds.maxX) / 2);
		expect(tileGuide.cy).toBe((rootBounds.minY + rootBounds.maxY) / 2);
		expect(tileGuide.width).toBe(tile.width);
		expect(tileGuide.height).toBe(tile.height);
	});

	it("adds non-editable neighboring tile previews as transient elements", () => {
		const p = createPath("p1");
		const objects: Record<string, AnyArtObject> = { [p.id]: p };
		const defEntry: DefEntry = {
			id: "def-1",
			kind: "pattern",
			rootElementIds: [p.id],
			tile: { width: 120, height: 80 },
		};
		const { patternEdit, store } = setup({
			defs: { [defEntry.id]: defEntry },
			objects,
		});

		expect(patternEdit.enter(defEntry.id)).toBe(true);

		expect(store.transientElements.size).toBe(8);
		const offsets = new Set<string>();
		for (const [, { layerId, element }] of store.transientElements) {
			expect(layerId).toBe(patternEdit.getSession()?.transientLayerId);
			expect(element.id).toContain("__pattern-edit-preview__:");
			expect(element.opacity).toBeCloseTo(p.opacity * 0.32);
			const [, , row, col] = element.id.split(":");
			offsets.add(`${row}:${col}`);
		}
		expect(offsets).toEqual(
			new Set(["-1:-1", "-1:0", "-1:1", "0:-1", "0:1", "1:-1", "1:0", "1:1"]),
		);
	});

	it("refreshSessionVisuals keeps neighboring tile previews in sync with root moves", () => {
		const p = createPath("p1");
		const objects: Record<string, AnyArtObject> = { [p.id]: p };
		const defEntry: DefEntry = {
			id: "def-1",
			kind: "pattern",
			rootElementIds: [p.id],
			tile: { width: 100, height: 60 },
		};
		const { patternEdit, store } = setup({
			defs: { [defEntry.id]: defEntry },
			objects,
		});

		expect(patternEdit.enter(defEntry.id)).toBe(true);
		const session = patternEdit.getSession();
		if (!session) throw new Error("session should be active");
		const movedRoot = store.document.objects[session.rootWorkingElementIds[0]];
		if (!movedRoot) throw new Error("root clone should exist");
		movedRoot.transform = {
			...movedRoot.transform,
			x: movedRoot.transform.x + 25,
			y: movedRoot.transform.y - 15,
		};

		patternEdit.refreshSessionVisuals();

		const preview = [...store.transientElements.values()].find(({ element }) =>
			element.id.includes(":0:1:"),
		);
		expect(preview?.element.transform.x).toBe(movedRoot.transform.x + 100);
		expect(preview?.element.transform.y).toBe(movedRoot.transform.y);
	});

	it("keeps only top-level working clones on the transient layer", () => {
		const child: Path = {
			...createPath("child"),
			transform: createIdentityTransform(),
		};
		const group: AnyArtObject = {
			id: "group-1",
			type: "group",
			childIds: [child.id],
			clipPathId: null,
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		} as AnyArtObject;
		const defEntry: DefEntry = {
			id: "def-1",
			kind: "pattern",
			rootElementIds: [group.id],
			tile: { width: 100, height: 100 },
		};
		const objects: Record<string, AnyArtObject> = {
			[group.id]: group,
			[child.id]: child,
		};
		const { patternEdit, addLayer } = setup({
			defs: { [defEntry.id]: defEntry },
			objects,
		});

		expect(patternEdit.enter(defEntry.id)).toBe(true);

		const transientLayer = addLayer.mock.calls[0]?.[0] as Layer | undefined;
		const session = patternEdit.getSession();
		expect(transientLayer?.elementIds).toEqual(session?.rootWorkingElementIds);
		expect(session?.workingElementIds.length).toBeGreaterThan(
			session?.rootWorkingElementIds.length ?? 0,
		);
	});

	it("can re-enter the same def after commit", () => {
		const p = createPath("p1");
		const objects: Record<string, AnyArtObject> = { [p.id]: p };
		const defEntry: DefEntry = {
			id: "def-1",
			kind: "pattern",
			rootElementIds: [p.id],
			tile: { width: 100, height: 100 },
		};
		const { patternEdit } = setup({
			defs: { [defEntry.id]: defEntry },
			objects,
		});

		expect(patternEdit.enter(defEntry.id)).toBe(true);
		expect(patternEdit.commit()).toBe(true);
		expect(patternEdit.enter(defEntry.id)).toBe(true);
	});

	it("cancel() removes the transient layer without committing", () => {
		const p = createPath("p1");
		const objects: Record<string, AnyArtObject> = { [p.id]: p };
		const defEntry: DefEntry = {
			id: "def-1",
			kind: "pattern",
			rootElementIds: [p.id],
			tile: { width: 100, height: 100 },
		};
		const {
			patternEdit,
			addLayer,
			replaceDefElements,
			deleteLayer,
			deleteElements,
			store,
		} = setup({ defs: { [defEntry.id]: defEntry }, objects });

		expect(patternEdit.enter(defEntry.id)).toBe(true);
		const session = patternEdit.getSession();
		expect(patternEdit.cancel()).toBe(true);

		// Cancel must not call replaceDefElements but must remove the layer.
		expect(replaceDefElements).not.toHaveBeenCalled();
		const transientLayer = addLayer.mock.calls[0][0] as Layer;
		expect(deleteElements).toHaveBeenCalledWith(
			{ [transientLayer.id]: session?.workingElementIds ?? [] },
			PATTERN_EDIT_ORIGIN,
		);
		expect(deleteLayer).toHaveBeenCalledWith(
			transientLayer.id,
			{ deleteObjects: false },
			PATTERN_EDIT_ORIGIN,
		);
		expect(store.currentLayerId).toBe("layer-1");
		expect(store.editingScopeStack).not.toContain(transientLayer.id);
		expect(patternEdit.isActive()).toBe(false);
	});

	it("garbageCollectStaleLayers removes pattern-edit layers from inactive clients", () => {
		const stale: Layer = {
			id: "stale-1",
			name: "stale",
			visible: true,
			locked: false,
			opacity: 1,
			elementIds: [],
			transientKind: "pattern-edit",
			ownerClientId: "999",
		};
		const active: Layer = {
			id: "active-1",
			name: "active",
			visible: true,
			locked: false,
			opacity: 1,
			elementIds: [],
			transientKind: "pattern-edit",
			ownerClientId: "42",
		};
		const { patternEdit, deleteLayer } = setup({
			extraLayers: [stale, active],
		});
		const removed = patternEdit.garbageCollectStaleLayers(new Set(["42"]));
		expect(removed).toBe(1);
		expect(deleteLayer).toHaveBeenCalledWith(stale.id);
		expect(deleteLayer).not.toHaveBeenCalledWith(active.id);
	});
});

interface SetupOptions {
	defs?: Record<string, DefEntry>;
	objects?: Record<string, AnyArtObject>;
	extraLayers?: Layer[];
	viewportCenter?: { x: number; y: number } | null;
}

/**
 * Builds a store + YjsProvider mock whose mutating methods actually update
 * `store.document` (mirroring what a real Yjs sync round-trip would produce).
 * This is required for commit()/cancel()/getSessionRootBounds() to see the
 * transient layer via `getLiveRootElementIds` — a bare `vi.fn()` with no
 * implementation would leave `store.document.layers` without the transient
 * layer the code under test looks up.
 */
function setup(options: SetupOptions = {}) {
	const store = {
		currentLayerId: "layer-1",
		editingScopeStack: [] as string[],
		document: {
			id: "doc",
			layers: [
				{
					id: "layer-1",
					name: "Layer 1",
					visible: true,
					locked: false,
					opacity: 1,
					elementIds: [],
				},
				...(options.extraLayers ?? []),
			],
			objects: { ...(options.objects ?? {}) },
			defs: structuredClone(options.defs ?? {}),
			viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
			files: [],
			artboards: [],
			brushPresets: [],
		},
		transientElements: new Map(),
		uiOverlayState: {} as Record<string, unknown>,
		patternEditSession: null,
		canUndo: false,
		canRedo: false,
	} as unknown as RendererState;

	// Records tile-guide overlays written through the generic channel.
	const overlays: Record<string, UIOverlay> = {};
	const setOverlay = (key: string, overlay: UIOverlay | null) => {
		if (overlay) overlays[key] = overlay;
		else delete overlays[key];
	};

	const addObjectOnly = vi.fn((obj: AnyArtObject) => {
		store.document.objects[obj.id] = obj;
	});
	const addLayer = vi.fn((layer: Layer) => {
		store.document.layers.push(layer);
	});
	const deleteElements = vi.fn((elementsByLayer: Record<string, string[]>) => {
		for (const [layerId, ids] of Object.entries(elementsByLayer)) {
			for (const id of ids) delete store.document.objects[id];
			const layer = store.document.layers.find((entry) => entry.id === layerId);
			if (!layer) continue;
			layer.elementIds = layer.elementIds.filter((id) => !ids.includes(id));
		}
	});
	const deleteLayer = vi.fn(
		(layerId: string, opts?: { deleteObjects?: boolean }) => {
			const idx = store.document.layers.findIndex(
				(layer) => layer.id === layerId,
			);
			if (idx < 0) return;
			const layer = store.document.layers[idx];
			if (opts?.deleteObjects !== false) {
				for (const id of layer.elementIds) delete store.document.objects[id];
			}
			store.document.layers.splice(idx, 1);
		},
	);
	const updateElement = vi.fn(
		(_layerId: string, elementId: string, updates: Partial<AnyArtObject>) => {
			const existing = store.document.objects[elementId];
			if (!existing) return;
			store.document.objects[elementId] = {
				...existing,
				...updates,
			} as AnyArtObject;
		},
	);
	const replaceDefElements = vi.fn(
		(defId: string, rootElementIds: string[]) => {
			const entry = store.document.defs?.[defId];
			if (!entry) return;
			entry.rootElementIds = [...rootElementIds];
		},
	);

	// Minimal stand-in for the session UndoManager — enter() registers
	// stack-item-added/-popped listeners and reads canUndo()/canRedo() to
	// mirror session undo availability into store.canUndo/canRedo.
	const sessionUndoStub = {
		destroy: vi.fn(),
		clear: vi.fn(),
		undo: vi.fn(),
		redo: vi.fn(),
		canUndo: vi.fn(() => false),
		canRedo: vi.fn(() => false),
		on: vi.fn(),
	};
	const yjsProvider = {
		addObjectOnly,
		addLayer,
		deleteElements,
		deleteLayer,
		updateElement,
		replaceDefElements,
		transact: vi.fn((fn: () => void) => fn()),
		createSessionUndoManager: vi.fn(() => sessionUndoStub),
		stopUndoCapture: vi.fn(),
		canUndo: vi.fn(() => false),
		canRedo: vi.fn(() => false),
		ydoc: { clientID: 42 },
	} as unknown as YjsProvider;

	const patternEdit = new PaplicoPatternEdit({
		store,
		yjsProvider,
		getViewportCenter: () => options.viewportCenter ?? null,
		setOverlay,
	});
	return {
		patternEdit,
		store,
		overlays,
		addObjectOnly,
		addLayer,
		deleteElements,
		deleteLayer,
		updateElement,
		replaceDefElements,
	};
}

function createPath(id: string): Path {
	return {
		type: "path",
		id,
		segments: [
			{
				start: { x: 0, y: 0 },
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: 100, y: 0 },
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
	} as Path;
}
