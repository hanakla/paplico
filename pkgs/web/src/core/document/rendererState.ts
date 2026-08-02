import { nanoid } from "nanoid";
import { proxy, ref } from "valtio";
import type { RendererState } from "../Paplico";
import type { Document } from "../schema";

/**
 * Create a new RendererState instance as Valtio proxy.
 * Called by Paplico.create() to create the store.
 */
export function createRendererState(): RendererState {
	const store = proxy<RendererState>({
		document: {
			id: nanoid(),
			objects: ref({} as Document["objects"]),
			layers: [
				{
					id: nanoid(),
					name: "Layer 1",
					elementIds: [],
					visible: true,
					locked: false,
					opacity: 1.0,
				},
			],
			viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
			files: [],
			artboards: [],
			brushPresets: [],
		},
		currentLayerId: null,
		canUndo: false,
		canRedo: false,
		elementOverrides: ref(new Map()),
		transientElements: ref(new Map()),
		selectedElementIds: [],
		selectionBounds: null,
		keyObjectId: null,
		uiOverlayState: {
			isArtboardEditMode: false,
			overlays: {},
		},
		patternEditSession: null,
		maskEditSession: null,
		toolSession: null,
		reference3dEditingElementId: null,
		reference3dSelectedNodeId: null,
		editingScopeStack: [],
		selectedArtboardId: null,
		hdrSupported: false,
		viewports: {},
	});

	if (store.document.layers.length > 0) {
		store.currentLayerId = store.document.layers[0].id;
	}

	return store;
}

export async function loadDevDocument(): Promise<Document | null> {
	if (process.env.NODE_ENV !== "development") return null;

	const { openPapf } = await import("../io/papf/reader");
	const res = await fetch("/api/dev/test-document");
	const blob = await res.blob();
	const papf = await openPapf(blob);
	return papf.toDocument();
}
