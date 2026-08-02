import { describe, expect, it, vi } from "vitest";
import type { YjsProvider } from "../collaboration/YjsProvider";
import { createIdentityTransform } from "../document/factory";
import type { RendererState } from "../Paplico";
import type {
	AnyArtObject,
	ElementTransform,
	Layer,
	ObjectMask,
	Path,
} from "../schema";
import { TRANSIENT_LAYER_KIND } from "../schema";
import { PaplicoMaskEdit } from "./PaplicoMaskEdit";

describe("PaplicoMaskEdit", () => {
	it("should refuse to enter an element that has no mask", () => {
		const { maskEdit } = setup({ objects: { owner: createPath("owner") } });

		expect(maskEdit.enter("owner")).toBe(false);
		expect(maskEdit.isActive()).toBe(false);
	});

	it("should refuse to enter a missing element", () => {
		const { maskEdit } = setup();

		expect(maskEdit.enter("nope")).toBe(false);
	});

	it("should list the mask content on a transient layer scoped for editing", () => {
		const { maskEdit, store } = setupWithMask({ elementIds: ["m1"] });

		expect(maskEdit.enter("owner")).toBe(true);

		const layer = store.document.layers.at(-1)!;
		expect(layer.transientKind).toBe(TRANSIENT_LAYER_KIND.MASK_EDIT);
		expect(layer.elementIds).toEqual(["m1"]);
		expect(store.editingScopeStack).toEqual([layer.id]);
		expect(store.currentLayerId).toBe(layer.id);
		expect(store.maskEditSession).toEqual({ ownerId: "owner" });
	});

	it("should lift the content into world space on entry", () => {
		const { maskEdit, store } = setupScaledOwner();

		maskEdit.enter("owner");

		// Stored at (10,0) in an owner scaled 2x and offset by (40,25): the tools
		// work in world space, so that is where the shape has to be while editing.
		expect(store.document.objects.m1?.transform).toMatchObject({
			x: 60,
			y: 25,
			scaleX: 2,
			scaleY: 2,
		});
	});

	it("should put the content back into the owner's frame on leaving", () => {
		const { maskEdit, store } = setupScaledOwner();
		maskEdit.enter("owner");

		maskEdit.leave();

		expect(store.document.objects.m1?.transform).toMatchObject({
			x: 10,
			y: 0,
			scaleX: 1,
			scaleY: 1,
		});
	});

	it("should convert shapes added mid-session the same way", () => {
		const { maskEdit, store } = setupScaledOwner();
		maskEdit.enter("owner");
		// A tool drops a shape at a world position, as tools always do.
		drawInto(store, maskEdit, "m2", {
			x: 60,
			y: 25,
			rotation: 0,
			scaleX: 2,
			scaleY: 2,
		});

		maskEdit.leave();

		// Same world position as m1, so it must land on the same stored transform
		// — this is what used to jump by the owner's transform at commit.
		expect(store.document.objects.m2?.transform).toMatchObject({
			x: 10,
			y: 0,
			scaleX: 1,
			scaleY: 1,
		});
	});

	it("should unmask the owner while the session is open", () => {
		const { maskEdit, store } = setupWithMask({ elementIds: ["m1"] });

		maskEdit.enter("owner");

		// An empty mask hides nothing, which is how the owner stays visible to
		// draw against.
		expect(store.document.objects.owner?.mask?.elementIds).toEqual([]);
	});

	it("should not rewrite a mask that is already empty", () => {
		const { maskEdit, updateElement } = setupWithMask({ elementIds: [] });

		maskEdit.enter("owner");

		// Entering a freshly created mask must not touch the field again: an
		// untracked write discards what the tracked write that created it left
		// there, and creating the mask stops being undoable.
		expect(
			updateElement.mock.calls.filter((call) => call[2].mask != null),
		).toHaveLength(0);
	});

	it("should leave when the mask it is editing disappears", () => {
		const { maskEdit, store } = setupWithMask({ elementIds: ["m1"] });
		maskEdit.enter("owner");

		// Undo reaches the document while a session is open, so the mask being
		// edited can be taken away underneath it.
		const owner = store.document.objects.owner;
		if (owner) owner.mask = undefined;
		maskEdit.leaveIfMaskGone();

		expect(maskEdit.isActive()).toBe(false);
		expect(store.maskEditSession).toBeNull();
		expect(store.editingScopeStack).toEqual([]);
	});

	it("should stay open while its mask is still there", () => {
		const { maskEdit } = setupWithMask({ elementIds: ["m1"] });
		maskEdit.enter("owner");

		maskEdit.leaveIfMaskGone();

		expect(maskEdit.isActive()).toBe(true);
	});

	it("should clear the previous selection when entering", () => {
		const { maskEdit, store } = setupWithMask({ elementIds: ["m1"] });
		store.selectedElementIds = ["stale"];

		maskEdit.enter("owner");

		expect(store.selectedElementIds).toEqual([]);
		expect(store.selectionBounds).toBeNull();
	});

	it("should refuse a second session while one is open", () => {
		const { maskEdit } = setupWithMask({ elementIds: ["m1"] });
		maskEdit.enter("owner");

		expect(maskEdit.enter("owner")).toBe(false);
	});

	it("should promote elements drawn during the session on leaving", () => {
		const { maskEdit, store } = setupWithMask({ elementIds: ["m1"] });
		maskEdit.enter("owner");

		drawInto(store, maskEdit, "m2");

		expect(maskEdit.leave()).toBe(true);
		expect(store.document.objects.owner?.mask?.elementIds).toEqual([
			"m1",
			"m2",
		]);
	});

	it("should keep the mask's other settings on leaving", () => {
		const { maskEdit, store } = setupWithMask({
			elementIds: ["m1"],
			inverted: true,
			enabled: false,
		});
		maskEdit.enter("owner");

		maskEdit.leave();

		expect(store.document.objects.owner?.mask).toEqual({
			elementIds: ["m1"],
			inverted: true,
			enabled: false,
		});
	});

	it("should drop elements deleted during the session on leaving", () => {
		const { maskEdit, store } = setupWithMask({ elementIds: ["m1", "m2"] });
		maskEdit.enter("owner");

		delete store.document.objects.m2;

		maskEdit.leave();

		expect(store.document.objects.owner?.mask?.elementIds).toEqual(["m1"]);
	});

	it("should tear the working layer down and restore the editing scope", () => {
		const { maskEdit, store } = setupWithMask({ elementIds: ["m1"] });
		const layerCountBefore = store.document.layers.length;
		maskEdit.enter("owner");

		maskEdit.leave();

		expect(store.document.layers).toHaveLength(layerCountBefore);
		expect(store.editingScopeStack).toEqual([]);
		expect(store.currentLayerId).toBe("layer-1");
		expect(store.maskEditSession).toBeNull();
		expect(maskEdit.isActive()).toBe(false);
	});

	it("should leave the edited element selected", () => {
		const { maskEdit, store, selectElement } = setupWithMask({
			elementIds: ["m1"],
		});
		maskEdit.enter("owner");

		maskEdit.leave();

		// The element whose mask was edited is what the user was working on, and
		// the only thing left to reach now that the working layer is gone.
		expect(selectElement).toHaveBeenCalledWith("owner");
		expect(store.selectedElementIds).toEqual(["owner"]);
	});

	it("should not select an owner that is gone", () => {
		const { maskEdit, store, selectElement } = setupWithMask({
			elementIds: ["m1"],
		});
		maskEdit.enter("owner");
		// The owner itself was deleted — undo, or a peer — so there is nothing to
		// select, and reaching for it would revive a stale id.
		delete store.document.objects.owner;

		maskEdit.leave();

		expect(selectElement).not.toHaveBeenCalled();
		expect(store.selectedElementIds).toEqual([]);
	});

	it("should keep the mask content alive when the working layer is removed", () => {
		const { maskEdit, store } = setupWithMask({ elementIds: ["m1"] });
		maskEdit.enter("owner");

		maskEdit.leave();

		expect(store.document.objects.m1).toBeDefined();
	});

	it("should collect mask-edit layers left behind by other clients", () => {
		const { maskEdit, store } = setupWithMask({ elementIds: ["m1"] });
		store.document.layers.push({
			id: "stale",
			name: "Mask: gone",
			visible: true,
			locked: false,
			opacity: 1,
			elementIds: [],
			transientKind: TRANSIENT_LAYER_KIND.MASK_EDIT,
			ownerClientId: "999",
		});

		expect(maskEdit.garbageCollectStaleLayers(new Set(["42"]))).toBe(1);
		expect(store.document.layers.some((l) => l.id === "stale")).toBe(false);
	});

	it("should leave mask-edit layers of live clients alone", () => {
		const { maskEdit, store } = setupWithMask({ elementIds: ["m1"] });
		store.document.layers.push({
			id: "live",
			name: "Mask: peer",
			visible: true,
			locked: false,
			opacity: 1,
			elementIds: [],
			transientKind: TRANSIENT_LAYER_KIND.MASK_EDIT,
			ownerClientId: "7",
		});

		expect(maskEdit.garbageCollectStaleLayers(new Set(["7"]))).toBe(0);
	});
});

// Helpers

function createPath(id: string): Path {
	return {
		id,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		segments: [],
	};
}

const IDENTITY: ElementTransform = {
	x: 0,
	y: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
};

/** Stand in for a tool adding a shape to the session's working layer. */
function drawInto(
	store: RendererState,
	maskEdit: PaplicoMaskEdit,
	id: string,
	transform: ElementTransform = IDENTITY,
): void {
	const transientLayerId = maskEdit.getSession()!.transientLayerId;
	const layer = store.document.layers.find((l) => l.id === transientLayerId)!;
	store.document.objects[id] = { ...createPath(id), transform };
	layer.elementIds.push(id);
}

/** Owner offset by (40,25) and scaled 2x, with one mask shape stored at (10,0). */
function setupScaledOwner() {
	const objects: Record<string, AnyArtObject> = {
		owner: { ...createPath("owner"), mask: { elementIds: ["m1"] } },
		m1: {
			...createPath("m1"),
			transform: { x: 10, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		},
	};
	return setup({
		objects,
		ownerWorldTransform: {
			x: 40,
			y: 25,
			rotation: 0,
			scaleX: 2,
			scaleY: 2,
		},
	});
}

function setupWithMask(mask: ObjectMask) {
	const objects: Record<string, AnyArtObject> = {
		owner: { ...createPath("owner"), mask },
	};
	for (const id of mask.elementIds) objects[id] = createPath(id);
	return setup({ objects });
}

function setup(
	options: {
		objects?: Record<string, AnyArtObject>;
		ownerWorldTransform?: ElementTransform;
	} = {},
) {
	const store = {
		currentLayerId: "layer-1",
		editingScopeStack: [] as string[],
		selectedElementIds: [] as string[],
		selectionBounds: null,
		document: {
			id: "doc",
			layers: [
				{
					id: "layer-1",
					name: "Layer 1",
					visible: true,
					locked: false,
					opacity: 1,
					elementIds: ["owner"],
				},
			],
			objects: { ...(options.objects ?? {}) },
			viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
			files: [],
			artboards: [],
			brushPresets: [],
		},
		maskEditSession: null,
		canUndo: false,
		canRedo: false,
	} as unknown as RendererState;

	const addLayer = vi.fn((layer: Layer) => {
		store.document.layers.push(layer);
	});
	const deleteLayer = vi.fn(
		(layerId: string, opts?: { deleteObjects?: boolean }) => {
			const idx = store.document.layers.findIndex((l) => l.id === layerId);
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

	const addObjectOnly = vi.fn((element: AnyArtObject) => {
		store.document.objects[element.id] = element;
	});
	const deleteElements = vi.fn((byLayer: Record<string, string[]>) => {
		for (const ids of Object.values(byLayer)) {
			for (const id of ids) delete store.document.objects[id];
		}
	});

	const yjsProvider = {
		addLayer,
		deleteLayer,
		updateElement,
		addObjectOnly,
		deleteElements,
		transact: vi.fn((fn: () => void) => fn()),
		canUndo: vi.fn(() => false),
		canRedo: vi.fn(() => false),
		ydoc: { clientID: 42 },
	} as unknown as YjsProvider;

	const selectElement = vi.fn((id: string) => {
		store.selectedElementIds = [id];
	});
	const maskEdit = new PaplicoMaskEdit({
		store,
		yjsProvider,
		getWorldTransform: () => options.ownerWorldTransform ?? IDENTITY,
		selectElement,
	});

	return {
		maskEdit,
		store,
		addLayer,
		deleteLayer,
		updateElement,
		addObjectOnly,
		deleteElements,
		selectElement,
	};
}
