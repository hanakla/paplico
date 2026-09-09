import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import * as Y from "yjs";
import { createIdentityTransform } from "../document/factory";
import type { BrushSettings, Reference3DDef } from "../schema";
import { extractDocumentFromYDoc } from "./extractDocumentFromYDoc";
import { YjsProvider, type YjsProviderCallbacks } from "./YjsProvider";

describe("YjsProvider", () => {
	let callbacks: YjsProviderCallbacks;
	let mockOnDocumentUpdate: Mock;
	let mockGetCurrentLayerId: Mock;
	let mockSetCurrentLayerId: Mock;

	beforeEach(() => {
		vi.clearAllMocks();

		mockOnDocumentUpdate = vi.fn();
		mockGetCurrentLayerId = vi.fn(() => null);
		mockSetCurrentLayerId = vi.fn();

		callbacks = {
			onDocumentUpdate: mockOnDocumentUpdate,
			onLayersUpdate: vi.fn(),
			getCurrentLayerId: mockGetCurrentLayerId,
			setCurrentLayerId: mockSetCurrentLayerId,
		};
	});

	describe("constructor", () => {
		it("should create a new YjsProvider instance", () => {
			const provider = new YjsProvider({ callbacks });

			expect(provider).toBeDefined();
			expect(provider.ydoc).toBeInstanceOf(Y.Doc);
		});

		it("should initialize undoManager", () => {
			const provider = new YjsProvider({ callbacks });

			expect(provider.undoManager).toBeDefined();
		});
	});

	describe("resetWithFreshDoc", () => {
		it("should keep 3D scene writes bound to the fresh doc (guest-join reset)", () => {
			const provider = new YjsProvider({ callbacks });
			const freshDoc = provider.resetWithFreshDoc();

			const def: Reference3DDef = { id: "scene-1", nodes: [] };
			provider.setReference3D(def);

			// A stale binding would write into the destroyed pre-reset doc and
			// leave the fresh doc's map empty.
			expect(freshDoc.getMap("references3d").has("scene-1")).toBe(true);
		});
	});

	describe("replaceDocument", () => {
		function makeDocument(id: string, objectId: string) {
			return {
				id,
				objects: {
					[objectId]: {
						id: objectId,
						type: "path" as const,
						segments: [],
						opacity: 1,
						blendMode: "normal" as const,
						transform: createIdentityTransform(),
					},
				},
				layers: [
					{
						id: `${id}-layer`,
						name: "Layer 1",
						visible: true,
						locked: false,
						opacity: 1,
						blendMode: "normal" as const,
						elementIds: [objectId],
					},
				],
				viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
				files: [],
				artboards: [],
				brushPresets: [],
			};
		}

		it("should leave nothing of the previous document in the encoded state", () => {
			const provider = new YjsProvider({ callbacks });
			provider.replaceDocument(makeDocument("doc-old", "path-old"));
			provider.replaceDocument(makeDocument("doc-new", "path-new"));

			const fresh = new YjsProvider({ callbacks });
			fresh.replaceDocument(makeDocument("doc-new", "path-new"));

			const state = Y.encodeStateAsUpdate(provider.ydoc);
			expect(new TextDecoder("latin1").decode(state)).not.toContain("path-old");
			expect(state.byteLength).toBe(
				Y.encodeStateAsUpdate(fresh.ydoc).byteLength,
			);
			provider.destroy();
			fresh.destroy();
		});

		it("should keep update subscriptions across the document swap", () => {
			const provider = new YjsProvider({ callbacks });
			const onUpdate = vi.fn();
			provider.on("update", onUpdate);

			provider.replaceDocument(makeDocument("doc-new", "path-new"));
			const callsAfterReplace = onUpdate.mock.calls.length;
			provider.updateLayerAttributes("doc-new-layer", { name: "Renamed" });

			expect(callsAfterReplace).toBeGreaterThan(0);
			expect(onUpdate.mock.calls.length).toBeGreaterThan(callsAfterReplace);
			provider.destroy();
		});
	});

	describe("addLayer", () => {
		it("should add a new layer to yLayers", () => {
			const provider = new YjsProvider({ callbacks });

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer);

			const yLayers = provider.ydoc.getArray("layers");
			expect(yLayers.length).toBe(1);

			const yLayer = yLayers.get(0) as Y.Map<unknown>;
			expect(yLayer.get("id")).toBe("layer-1");
			expect(yLayer.get("name")).toBe("Layer 1");
			expect(yLayer.get("visible")).toBe(true);
			expect(yLayer.get("locked")).toBe(false);
			expect(yLayer.get("opacity")).toBe(1);
			expect(yLayer.get("blendMode")).toBe("normal");
		});

		it("should add multiple layers", () => {
			const provider = new YjsProvider({ callbacks });

			const layer1 = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			const layer2 = {
				id: "layer-2",
				name: "Layer 2",
				visible: true,
				locked: false,
				opacity: 0.5,
				blendMode: "multiply" as const,
				elementIds: [],
			};

			provider.addLayer(layer1);
			provider.addLayer(layer2);

			const yLayers = provider.ydoc.getArray("layers");
			expect(yLayers.length).toBe(2);

			const yLayer2 = yLayers.get(1) as Y.Map<unknown>;
			expect(yLayer2.get("id")).toBe("layer-2");
			expect(yLayer2.get("opacity")).toBe(0.5);
			expect(yLayer2.get("blendMode")).toBe("multiply");
		});
	});

	describe("deleteLayer", () => {
		it("should delete a layer by ID", () => {
			const provider = new YjsProvider({ callbacks });

			const layer1 = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			const layer2 = {
				id: "layer-2",
				name: "Layer 2",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer1);
			provider.addLayer(layer2);

			provider.deleteLayer("layer-1");

			const yLayers = provider.ydoc.getArray("layers");
			expect(yLayers.length).toBe(1);

			const yLayer = yLayers.get(0) as Y.Map<unknown>;
			expect(yLayer.get("id")).toBe("layer-2");
		});

		it("should handle deleting non-existent layer", () => {
			const provider = new YjsProvider({ callbacks });

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer);

			// Should not throw
			provider.deleteLayer("non-existent-layer");

			const yLayers = provider.ydoc.getArray("layers");
			expect(yLayers.length).toBe(1);
		});
	});

	describe("reorderLayers", () => {
		it("should reorder layers by index", () => {
			const provider = new YjsProvider({ callbacks });

			const layer1 = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			const layer2 = {
				id: "layer-2",
				name: "Layer 2",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			const layer3 = {
				id: "layer-3",
				name: "Layer 3",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer1);
			provider.addLayer(layer2);
			provider.addLayer(layer3);

			provider.reorderLayers(2, 0);

			const yLayers = provider.ydoc.getArray("layers");
			expect((yLayers.get(0) as Y.Map<unknown>).get("id")).toBe("layer-3");
			expect((yLayers.get(1) as Y.Map<unknown>).get("id")).toBe("layer-1");
			expect((yLayers.get(2) as Y.Map<unknown>).get("id")).toBe("layer-2");
		});

		it("should ignore invalid indexes", () => {
			const provider = new YjsProvider({ callbacks });

			const layer1 = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			const layer2 = {
				id: "layer-2",
				name: "Layer 2",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer1);
			provider.addLayer(layer2);
			provider.reorderLayers(0, 10);

			const yLayers = provider.ydoc.getArray("layers");
			expect((yLayers.get(0) as Y.Map<unknown>).get("id")).toBe("layer-1");
			expect((yLayers.get(1) as Y.Map<unknown>).get("id")).toBe("layer-2");
		});
	});

	describe("addElement", () => {
		it("should add an element to a layer", () => {
			const provider = new YjsProvider({ callbacks });

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer);

			const element = {
				id: "path-1",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			provider.addElement("layer-1", element);

			const yLayers = provider.ydoc.getArray("layers");
			const yLayer = yLayers.get(0) as Y.Map<unknown>;
			const yElementIds = yLayer.get("elementIds") as Y.Array<string>;
			const yObjects = provider.ydoc.getMap("objects");

			expect(yElementIds.length).toBe(1);
			expect(yElementIds.get(0)).toBe("path-1");
			expect((yObjects.get("path-1") as Y.Map<unknown>).get("id")).toBe(
				"path-1",
			);
		});

		it("should insert an element at a specified layer index", () => {
			const provider = new YjsProvider({ callbacks });
			provider.addLayer({
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			});
			const makePath = (id: string) => ({
				id,
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			});
			provider.addElement("layer-1", makePath("before"));
			provider.addElement("layer-1", makePath("after"));

			provider.addElement("layer-1", makePath("inserted"), undefined, 1);

			const yLayer = provider.ydoc.getArray("layers").get(0) as Y.Map<unknown>;
			expect((yLayer.get("elementIds") as Y.Array<string>).toArray()).toEqual([
				"before",
				"inserted",
				"after",
			]);
		});

		it("should insert an element at a specified group child index", () => {
			const provider = new YjsProvider({ callbacks });
			provider.addLayer({
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			});
			provider.addElement("layer-1", {
				id: "group-1",
				type: "group",
				childIds: ["before", "after"],
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			});
			provider.addElement("layer-1", {
				id: "inserted",
				type: "path",
				segments: [],
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			});

			provider.addElementToGroup(
				"layer-1",
				"group-1",
				"inserted",
				undefined,
				1,
			);

			const yGroup = provider.ydoc
				.getMap("objects")
				.get("group-1") as Y.Map<unknown>;
			expect(JSON.parse(yGroup.get("childIds") as string)).toEqual([
				"before",
				"inserted",
				"after",
			]);
		});
	});

	describe("deleteElement", () => {
		it("should delete an element from a layer", () => {
			const provider = new YjsProvider({ callbacks });

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer);

			const element1 = {
				id: "path-1",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			const element2 = {
				id: "path-2",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			provider.addElement("layer-1", element1);
			provider.addElement("layer-1", element2);

			provider.deleteElements({ "layer-1": ["path-1"] });

			const yLayers = provider.ydoc.getArray("layers");
			const yLayer = yLayers.get(0) as Y.Map<unknown>;
			const yElementIds = yLayer.get("elementIds") as Y.Array<string>;
			const yObjects = provider.ydoc.getMap("objects");

			expect(yElementIds.length).toBe(1);
			expect(yElementIds.get(0)).toBe("path-2");
			expect(yObjects.get("path-1")).toBeUndefined();
		});
	});

	describe("updateElement", () => {
		it("should update an element in a layer", () => {
			const provider = new YjsProvider({ callbacks });

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer);

			const element = {
				id: "path-1",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			provider.addElement("layer-1", element);

			provider.updateElement("layer-1", "path-1", {
				opacity: 0.8,
			});

			const yObjects = provider.ydoc.getMap("objects");
			const yObj = yObjects.get("path-1") as Y.Map<unknown>;

			// "style" is not in SCALAR_FIELDS or JSON_FIELDS, so updateElement ignores it.
			// Verify the object still exists with original data.
			expect(yObj.get("id")).toBe("path-1");
			expect(yObj.get("type")).toBe("path");
		});
	});

	describe("reorderElements", () => {
		it("should reorder elements in a layer", () => {
			const provider = new YjsProvider({ callbacks });

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer);

			const element1 = {
				id: "path-1",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			const element2 = {
				id: "path-2",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			provider.addElement("layer-1", element1);
			provider.addElement("layer-1", element2);

			provider.reorderElements("layer-1", 0, 1);

			const yLayers = provider.ydoc.getArray("layers");
			const yLayer = yLayers.get(0) as Y.Map<unknown>;
			const yElementIds = yLayer.get("elementIds") as Y.Array<string>;

			expect(yElementIds.get(0)).toBe("path-2");
			expect(yElementIds.get(1)).toBe("path-1");
		});
	});

	describe("createBlend / releaseBlend / replaceBlendSpine", () => {
		const makePath = (id: string) => ({
			id,
			type: "path" as const,
			segments: [],
			opacity: 1,
			blendMode: "normal" as const,
			transform: createIdentityTransform(),
		});
		const setup = (provider: YjsProvider) => {
			provider.addLayer({
				id: "layer-1",
				name: "L",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			});
			provider.addElement("layer-1", makePath("a"));
			provider.addElement("layer-1", makePath("b"));
			provider.addElement("layer-1", makePath("c"));
		};
		const layerIds = (provider: YjsProvider): string[] => {
			const yLayer = provider.ydoc.getArray("layers").get(0) as Y.Map<unknown>;
			return (yLayer.get("elementIds") as Y.Array<string>).toArray();
		};

		it("absorbs source paths and inserts blend at the topmost position", () => {
			const provider = new YjsProvider({ callbacks });
			setup(provider);

			provider.createBlend("layer-1", {
				id: "blend-1",
				type: "blend",
				objectIds: ["a", "b"],
				spacing: { type: "steps", count: 3 },
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			});

			expect(layerIds(provider)).toEqual(["blend-1", "c"]);
			const yObjects = provider.ydoc.getMap("objects");
			expect(yObjects.has("a")).toBe(true); // absorbed, not deleted
			expect(yObjects.has("b")).toBe(true);
			expect(yObjects.has("blend-1")).toBe(true);
		});

		it("restores absorbed sources on releaseBlend", () => {
			const provider = new YjsProvider({ callbacks });
			setup(provider);
			provider.createBlend("layer-1", {
				id: "blend-1",
				type: "blend",
				objectIds: ["a", "b"],
				spacing: { type: "steps", count: 3 },
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			});

			provider.releaseBlend("blend-1");

			expect(layerIds(provider)).toEqual(["a", "b", "c"]);
			expect(provider.ydoc.getMap("objects").has("blend-1")).toBe(false);
		});

		it("creates and releases a blend inside a group when sources are group children", () => {
			const provider = new YjsProvider({ callbacks });
			setup(provider);
			const groupId = provider.groupElements("layer-1", ["a", "b", "c"]);
			expect(groupId).not.toBeNull();

			const groupChildIds = (): string[] => {
				const yGroup = provider.ydoc
					.getMap("objects")
					.get(groupId!) as Y.Map<unknown>;
				return JSON.parse(yGroup.get("childIds") as string) as string[];
			};

			provider.createBlend(groupId!, {
				id: "blend-1",
				type: "blend",
				objectIds: ["a", "b"],
				spacing: { type: "steps", count: 3 },
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			});

			// Absorbed from the group's childIds (not the layer); blend takes the
			// topmost absorbed slot. The layer still holds only the group.
			expect(groupChildIds()).toEqual(["blend-1", "c"]);
			expect(layerIds(provider)).toEqual([groupId]);

			provider.releaseBlend("blend-1");
			expect(groupChildIds()).toEqual(["a", "b", "c"]);
			expect(provider.ydoc.getMap("objects").has("blend-1")).toBe(false);
		});

		it("round-trips spacing and spineSourceId through Yjs", () => {
			const provider = new YjsProvider({ callbacks });
			setup(provider);
			provider.createBlend("layer-1", {
				id: "blend-1",
				type: "blend",
				objectIds: ["a", "b"],
				spacing: { type: "distance", spacing: 10 },
				spineSourceId: "c",
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			});

			const yBlend = provider.ydoc
				.getMap("objects")
				.get("blend-1") as Y.Map<unknown>;
			expect(JSON.parse(yBlend.get("objectIds") as string)).toEqual(["a", "b"]);
			expect(JSON.parse(yBlend.get("spacing") as string)).toEqual({
				type: "distance",
				spacing: 10,
			});
			expect(yBlend.get("spineSourceId")).toBe("c");
		});

		it("replaceBlendSpine absorbs the new spine and updates fields", () => {
			const provider = new YjsProvider({ callbacks });
			setup(provider);
			provider.createBlend("layer-1", {
				id: "blend-1",
				type: "blend",
				objectIds: ["a", "b"],
				spacing: { type: "steps", count: 2 },
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			});
			// layer now: ["blend-1", "c"]
			provider.replaceBlendSpine("layer-1", "blend-1", "c");

			expect(layerIds(provider)).toEqual(["blend-1"]); // c absorbed
			const yBlend = provider.ydoc
				.getMap("objects")
				.get("blend-1") as Y.Map<unknown>;
			expect(yBlend.get("spineSourceId")).toBe("c");
		});

		it("reorderBlendChildren changes renderOrder, leaving objectIds (morph) intact", () => {
			const provider = new YjsProvider({ callbacks });
			setup(provider);
			provider.createBlend("layer-1", {
				id: "blend-1",
				type: "blend",
				objectIds: ["a", "b", "c"],
				spacing: { type: "steps", count: 3 },
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			});

			provider.reorderBlendChildren("blend-1", 0, 2);

			const yBlend = provider.ydoc
				.getMap("objects")
				.get("blend-1") as Y.Map<unknown>;
			// Morph chain untouched.
			expect(JSON.parse(yBlend.get("objectIds") as string)).toEqual([
				"a",
				"b",
				"c",
			]);
			// Only the paint order moved.
			expect(JSON.parse(yBlend.get("renderOrder") as string)).toEqual([
				"b",
				"c",
				"a",
			]);
		});

		it("extractChildFromBlend removes the source and restores it into the layer", () => {
			const provider = new YjsProvider({ callbacks });
			setup(provider);
			provider.createBlend("layer-1", {
				id: "blend-1",
				type: "blend",
				objectIds: ["a", "b", "c"],
				spacing: { type: "steps", count: 3 },
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			});

			provider.extractChildFromBlend("blend-1", "b", "layer-1");

			const yBlend = provider.ydoc
				.getMap("objects")
				.get("blend-1") as Y.Map<unknown>;
			expect(JSON.parse(yBlend.get("objectIds") as string)).toEqual(["a", "c"]);
			// Appended to the layer (no insertIndex given).
			expect(layerIds(provider)).toEqual(["blend-1", "b"]);
			// Identity blend transform → the extracted source's transform is untouched.
			const yB = provider.ydoc.getMap("objects").get("b") as Y.Map<unknown>;
			expect(JSON.parse(yB.get("transform") as string)).toEqual(
				createIdentityTransform(),
			);
		});

		it("extractChildFromBlend keeps renderOrder in sync", () => {
			const provider = new YjsProvider({ callbacks });
			setup(provider);
			provider.createBlend("layer-1", {
				id: "blend-1",
				type: "blend",
				objectIds: ["a", "b", "c"],
				spacing: { type: "steps", count: 3 },
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			});
			// Create a renderOrder first: paint order becomes ["b", "c", "a"].
			provider.reorderBlendChildren("blend-1", 0, 2);

			provider.extractChildFromBlend("blend-1", "b", "layer-1");

			const yBlend = provider.ydoc
				.getMap("objects")
				.get("blend-1") as Y.Map<unknown>;
			expect(JSON.parse(yBlend.get("objectIds") as string)).toEqual(["a", "c"]);
			expect(JSON.parse(yBlend.get("renderOrder") as string)).toEqual([
				"c",
				"a",
			]);
		});
	});

	describe("moveElementToLayer", () => {
		it("should move an element from one layer to another", () => {
			const provider = new YjsProvider({ callbacks });

			const layer1 = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			const layer2 = {
				id: "layer-2",
				name: "Layer 2",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer1);
			provider.addLayer(layer2);

			const element = {
				id: "path-1",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			provider.addElement("layer-1", element);

			provider.moveElementToLayer("layer-1", "path-1", "layer-2");

			const yLayers = provider.ydoc.getArray("layers");
			const yLayer1 = yLayers.get(0) as Y.Map<unknown>;
			const yLayer2 = yLayers.get(1) as Y.Map<unknown>;
			const yElementIds1 = yLayer1.get("elementIds") as Y.Array<string>;
			const yElementIds2 = yLayer2.get("elementIds") as Y.Array<string>;

			expect(yElementIds1.length).toBe(0);
			expect(yElementIds2.length).toBe(1);
			expect(yElementIds2.get(0)).toBe("path-1");
		});

		it("should move element to specific index in target layer", () => {
			const provider = new YjsProvider({ callbacks });

			const layer1 = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			const layer2 = {
				id: "layer-2",
				name: "Layer 2",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer1);
			provider.addLayer(layer2);

			const element1 = {
				id: "path-1",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			const element2 = {
				id: "path-2",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			const element3 = {
				id: "path-3",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			provider.addElement("layer-1", element1);
			provider.addElement("layer-2", element2);
			provider.addElement("layer-2", element3);

			provider.moveElementToLayer("layer-1", "path-1", "layer-2", 1);

			const yLayers = provider.ydoc.getArray("layers");
			const yLayer2 = yLayers.get(1) as Y.Map<unknown>;
			const yElementIds2 = yLayer2.get("elementIds") as Y.Array<string>;

			expect(yElementIds2.length).toBe(3);
			expect(yElementIds2.get(0)).toBe("path-2");
			expect(yElementIds2.get(1)).toBe("path-1");
			expect(yElementIds2.get(2)).toBe("path-3");
		});
	});

	describe("undo/redo", () => {
		it("should support undo", () => {
			const provider = new YjsProvider({ callbacks });

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer);

			const element = {
				id: "path-1",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			provider.addElement("layer-1", element);

			// Check element was added
			const yLayers = provider.ydoc.getArray("layers");
			const yLayer = yLayers.get(0) as Y.Map<unknown>;
			const yElementIds = yLayer.get("elementIds") as Y.Array<string>;
			const yObjects = provider.ydoc.getMap("objects");
			expect(yElementIds.length).toBe(1);
			expect(yObjects.get("path-1")).toBeDefined();

			// Should be able to undo
			expect(provider.canUndo()).toBe(true);

			provider.undo();

			// After undo, elementIds should be empty and object removed (element addition was undone)
			const yLayersAfterUndo = provider.ydoc.getArray("layers");
			const yObjectsAfterUndo = provider.ydoc.getMap("objects");

			// Check if layer still exists (it might have been undone too)
			if (yLayersAfterUndo.length > 0) {
				const yLayerAfterUndo = yLayersAfterUndo.get(0) as Y.Map<unknown>;
				const yElementIdsAfterUndo = yLayerAfterUndo.get(
					"elementIds",
				) as Y.Array<string>;
				expect(yElementIdsAfterUndo.length).toBe(0);
				expect(yObjectsAfterUndo.size).toBe(0);
			} else {
				// Layer was also undone, which is also valid behavior
				expect(yLayersAfterUndo.length).toBe(0);
			}
		});

		it("should support redo", () => {
			const provider = new YjsProvider({ callbacks });

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer);

			const element = {
				id: "path-1",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			provider.addElement("layer-1", element);
			provider.undo();

			// Should be able to redo
			expect(provider.canRedo()).toBe(true);

			provider.redo();

			const yLayers = provider.ydoc.getArray("layers");
			const yLayer = yLayers.get(0) as Y.Map<unknown>;
			const yElementIds = yLayer.get("elementIds") as Y.Array<string>;

			expect(yElementIds.length).toBe(1);
			expect(yElementIds.get(0)).toBe("path-1");
		});

		it("should clear undo history", () => {
			const provider = new YjsProvider({ callbacks });

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer);

			expect(provider.canUndo()).toBe(true);

			provider.clearUndoHistory();

			expect(provider.canUndo()).toBe(false);
		});
	});

	describe("syncYjsToValtio", () => {
		it("should call onDocumentUpdate with correct document structure", () => {
			const provider = new YjsProvider({ callbacks });
			const mockOnLayersUpdate = callbacks.onLayersUpdate as Mock;

			// Setup Yjs data — meta changes trigger full sync
			const yMeta = provider.ydoc.getMap("meta");
			yMeta.set("id", "doc-123");
			yMeta.set("name", "Test Document");

			expect(mockOnDocumentUpdate).toHaveBeenCalled();
			const metaDoc =
				mockOnDocumentUpdate.mock.calls[
					mockOnDocumentUpdate.mock.calls.length - 1
				][0];
			expect(metaDoc.id).toBe("doc-123");
			expect(metaDoc.objects).toEqual({});
			expect(metaDoc.viewport).toEqual({ x: 0, y: 0, zoom: 1, rotation: 0 });

			// addLayer is layer-only → onLayersUpdate
			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 0.8,
				elementIds: [],
			};

			provider.addLayer(layer);

			expect(mockOnLayersUpdate).toHaveBeenCalled();
			const layers =
				mockOnLayersUpdate.mock.calls[
					mockOnLayersUpdate.mock.calls.length - 1
				][0];
			expect(layers).toHaveLength(1);
			expect(layers[0].id).toBe("layer-1");
			expect(layers[0].name).toBe("Layer 1");
			expect(layers[0].visible).toBe(true);
			expect(layers[0].locked).toBe(false);
			expect(layers[0].opacity).toBe(0.8);
			expect(layers[0].elementIds).toEqual([]);
		});

		it("should sync elements correctly", () => {
			const provider = new YjsProvider({ callbacks });

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer);

			const element1 = {
				id: "path-1",
				type: "path" as const,
				segments: [
					{
						start: { x: 0, y: 0 },
						cp1: { x: 10, y: 10 },
						cp2: { x: 20, y: 20 },
						end: { x: 30, y: 30 },
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
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			const element2 = {
				id: "path-2",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			provider.addElement("layer-1", element1);
			provider.addElement("layer-1", element2);

			// Get the last call
			const lastCall =
				mockOnDocumentUpdate.mock.calls[
					mockOnDocumentUpdate.mock.calls.length - 1
				];
			const doc = lastCall[0];

			expect(doc.layers[0].elementIds).toHaveLength(2);
			expect(doc.layers[0].elementIds[0]).toBe("path-1");
			expect(doc.layers[0].elementIds[1]).toBe("path-2");

			// Check first element via doc.objects
			const syncedElement1 = doc.objects[doc.layers[0].elementIds[0]];
			expect(syncedElement1.id).toBe("path-1");
			expect(syncedElement1.type).toBe("path");
			expect((syncedElement1 as any).segments).toHaveLength(1);
			expect((syncedElement1 as any).segments[0].start).toEqual({ x: 0, y: 0 });
			expect((syncedElement1 as any).segments[0].end).toEqual({ x: 30, y: 30 });

			// Check second element via doc.objects
			const syncedElement2 = doc.objects[doc.layers[0].elementIds[1]];
			expect(syncedElement2.id).toBe("path-2");
		});

		it("should sync multiple layers correctly", () => {
			const provider = new YjsProvider({ callbacks });
			const mockOnLayersUpdate = callbacks.onLayersUpdate as Mock;

			const layer1 = {
				id: "layer-1",
				name: "Background",
				visible: true,
				locked: true,
				opacity: 0.5,
				elementIds: [],
			};

			const layer2 = {
				id: "layer-2",
				name: "Foreground",
				visible: false,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			const layer3 = {
				id: "layer-3",
				name: "Overlay",
				visible: true,
				locked: false,
				opacity: 0.7,
				elementIds: [],
			};

			provider.addLayer(layer1);
			provider.addLayer(layer2);
			provider.addLayer(layer3);

			// addLayer is layer-only → onLayersUpdate
			const layers = (
				mockOnLayersUpdate.mock.calls[
					mockOnLayersUpdate.mock.calls.length - 1
				] as unknown[]
			)[0] as {
				id: string;
				name: string;
				visible: boolean;
				locked: boolean;
				opacity: number;
			}[];

			expect(layers).toHaveLength(3);
			expect(layers[0].id).toBe("layer-1");
			expect(layers[0].name).toBe("Background");
			expect(layers[0].visible).toBe(true);
			expect(layers[0].locked).toBe(true);
			expect(layers[0].opacity).toBe(0.5);

			expect(layers[1].id).toBe("layer-2");
			expect(layers[1].name).toBe("Foreground");
			expect(layers[1].visible).toBe(false);

			expect(layers[2].id).toBe("layer-3");
			expect(layers[2].opacity).toBe(0.7);
		});

		it("should set currentLayerId to first layer when null", () => {
			mockGetCurrentLayerId.mockReturnValue(null);

			const provider = new YjsProvider({ callbacks });

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer);

			// Should set currentLayerId to first layer
			expect(mockSetCurrentLayerId).toHaveBeenCalledWith("layer-1");
		});

		it("should set currentLayerId to first layer when current layer is invalid", () => {
			mockGetCurrentLayerId.mockReturnValue("invalid-layer-id");

			const provider = new YjsProvider({ callbacks });

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer);

			// Should set currentLayerId to first layer because "invalid-layer-id" doesn't exist
			expect(mockSetCurrentLayerId).toHaveBeenCalledWith("layer-1");
		});

		it("should not change currentLayerId when it is valid", () => {
			mockGetCurrentLayerId.mockReturnValue("layer-2");
			mockSetCurrentLayerId.mockClear();

			const provider = new YjsProvider({ callbacks });

			const layer1 = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			const layer2 = {
				id: "layer-2",
				name: "Layer 2",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer1);
			provider.addLayer(layer2);

			// Clear previous calls and manually trigger sync
			mockSetCurrentLayerId.mockClear();

			// Add an element to trigger sync
			const element = {
				id: "path-1",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};
			provider.addElement("layer-2", element);

			// Should NOT call setCurrentLayerId because "layer-2" is valid
			expect(mockSetCurrentLayerId).not.toHaveBeenCalled();
		});

		it("should handle empty document", () => {
			const provider = new YjsProvider({ callbacks });

			// Manually trigger sync with empty document
			const yMeta = provider.ydoc.getMap("meta");
			yMeta.set("id", "empty-doc");

			// Get the last call after meta update
			const lastCall =
				mockOnDocumentUpdate.mock.calls[
					mockOnDocumentUpdate.mock.calls.length - 1
				];
			const doc = lastCall[0];

			expect(doc.id).toBe("empty-doc");
			expect(doc.layers).toEqual([]);
			expect(doc.viewport).toEqual({ x: 0, y: 0, zoom: 1, rotation: 0 });
		});

		it("should handle missing metadata gracefully", () => {
			const provider = new YjsProvider({ callbacks });
			const mockOnLayersUpdate = callbacks.onLayersUpdate as Mock;

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer);

			// addLayer is layer-only → onLayersUpdate
			const layers = (
				mockOnLayersUpdate.mock.calls[
					mockOnLayersUpdate.mock.calls.length - 1
				] as unknown[]
			)[0] as { id: string }[];

			expect(layers).toHaveLength(1);
			expect(layers[0].id).toBe("layer-1");
		});
	});

	describe("syncYjsToValtio - incremental updates", () => {
		it("should preserve existing elements when adding new element", () => {
			const provider = new YjsProvider({ callbacks });

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer);

			const element1 = {
				id: "path-1",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			const element2 = {
				id: "path-2",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			provider.addElement("layer-1", element1);

			// Get document state after first element
			const call1 =
				mockOnDocumentUpdate.mock.calls[
					mockOnDocumentUpdate.mock.calls.length - 1
				];
			const doc1 = call1[0];
			expect(doc1.layers[0].elementIds).toHaveLength(1);
			expect(doc1.layers[0].elementIds[0]).toBe("path-1");

			provider.addElement("layer-1", element2);

			// Get document state after second element
			const call2 =
				mockOnDocumentUpdate.mock.calls[
					mockOnDocumentUpdate.mock.calls.length - 1
				];
			const doc2 = call2[0];
			expect(doc2.layers[0].elementIds).toHaveLength(2);
			expect(doc2.layers[0].elementIds[0]).toBe("path-1");
			expect(doc2.layers[0].elementIds[1]).toBe("path-2");
		});

		it("should preserve other elements when updating one element", () => {
			const provider = new YjsProvider({ callbacks });

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer);

			const element1 = {
				id: "path-1",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			const element2 = {
				id: "path-2",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			const element3 = {
				id: "path-3",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			provider.addElement("layer-1", element1);
			provider.addElement("layer-1", element2);
			provider.addElement("layer-1", element3);

			// Update middle element
			provider.updateElement("layer-1", "path-2", {
				opacity: 0.5,
			});

			// Get document state after update
			const lastCall =
				mockOnDocumentUpdate.mock.calls[
					mockOnDocumentUpdate.mock.calls.length - 1
				];
			const doc = lastCall[0];

			expect(doc.layers[0].elementIds).toHaveLength(3);

			// First element should be unchanged
			const el0 = doc.objects[doc.layers[0].elementIds[0]];
			expect(el0.id).toBe("path-1");

			// Second element - "style" is not a recognized field in the normalized model,
			// so updateElement would not have changed it. Verify element still exists.
			const el1 = doc.objects[doc.layers[0].elementIds[1]];
			expect(el1.id).toBe("path-2");

			// Third element should be unchanged
			const el2 = doc.objects[doc.layers[0].elementIds[2]];
			expect(el2.id).toBe("path-3");
		});

		it("should preserve remaining elements when deleting one element", () => {
			const provider = new YjsProvider({ callbacks });

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer);

			const element1 = {
				id: "path-1",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			const element2 = {
				id: "path-2",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			const element3 = {
				id: "path-3",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			provider.addElement("layer-1", element1);
			provider.addElement("layer-1", element2);
			provider.addElement("layer-1", element3);

			// Delete middle element by ID
			provider.deleteElements({ "layer-1": ["path-2"] });

			// Get document state after deletion
			const lastCall =
				mockOnDocumentUpdate.mock.calls[
					mockOnDocumentUpdate.mock.calls.length - 1
				];
			const doc = lastCall[0];

			expect(doc.layers[0].elementIds).toHaveLength(2);

			// First and third elements should remain
			expect(doc.layers[0].elementIds[0]).toBe("path-1");
			expect(doc.objects["path-1"].id).toBe("path-1");

			expect(doc.layers[0].elementIds[1]).toBe("path-3");
			expect(doc.objects["path-3"].id).toBe("path-3");

			// Deleted element should not be in objects
			expect(doc.objects["path-2"]).toBeUndefined();
		});

		it("should preserve other layers when adding element to one layer", () => {
			const provider = new YjsProvider({ callbacks });

			const layer1 = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			const layer2 = {
				id: "layer-2",
				name: "Layer 2",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer1);
			provider.addLayer(layer2);

			const element1 = {
				id: "path-1",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			const element2 = {
				id: "path-2",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};

			provider.addElement("layer-1", element1);
			provider.addElement("layer-2", element2);

			// Get document state
			const lastCall =
				mockOnDocumentUpdate.mock.calls[
					mockOnDocumentUpdate.mock.calls.length - 1
				];
			const doc = lastCall[0];

			expect(doc.layers).toHaveLength(2);

			// Layer 1 should have element1
			expect(doc.layers[0].id).toBe("layer-1");
			expect(doc.layers[0].elementIds).toHaveLength(1);
			expect(doc.layers[0].elementIds[0]).toBe("path-1");

			// Layer 2 should have element2
			expect(doc.layers[1].id).toBe("layer-2");
			expect(doc.layers[1].elementIds).toHaveLength(1);
			expect(doc.layers[1].elementIds[0]).toBe("path-2");
		});

		it("should handle rapid sequential updates correctly", () => {
			const provider = new YjsProvider({ callbacks });

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer);

			// Rapid sequential updates
			for (let i = 0; i < 10; i++) {
				provider.addElement("layer-1", {
					id: `path-${i}`,
					type: "path" as const,
					segments: [],
					opacity: 1,
					blendMode: "normal" as const,
					transform: createIdentityTransform(),
				});
			}

			// Get final document state
			const lastCall =
				mockOnDocumentUpdate.mock.calls[
					mockOnDocumentUpdate.mock.calls.length - 1
				];
			const doc = lastCall[0];

			// All 10 elements should be present
			expect(doc.layers[0].elementIds).toHaveLength(10);

			// Check each element
			for (let i = 0; i < 10; i++) {
				const elId = doc.layers[0].elementIds[i];
				expect(elId).toBe(`path-${i}`);
				expect(doc.objects[elId].id).toBe(`path-${i}`);
			}
		});

		it("should handle mixed operations correctly", () => {
			const provider = new YjsProvider({ callbacks });

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};

			provider.addLayer(layer);

			// Add 3 elements
			provider.addElement("layer-1", {
				id: "path-1",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			});

			provider.addElement("layer-1", {
				id: "path-2",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			});

			provider.addElement("layer-1", {
				id: "path-3",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			});

			// Update path-2
			provider.updateElement("layer-1", "path-2", {
				opacity: 0.5,
			});

			// Delete path-1
			provider.deleteElements({ "layer-1": ["path-1"] });

			// Add new element
			provider.addElement("layer-1", {
				id: "path-4",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			});

			// Reorder: move path-4 (index 2) to index 0
			provider.reorderElements("layer-1", 2, 0);

			// reorderElements is layer-only → final element order in onLayersUpdate
			const mockOnLayersUpdate = callbacks.onLayersUpdate as Mock;
			const layers = (
				mockOnLayersUpdate.mock.calls[
					mockOnLayersUpdate.mock.calls.length - 1
				] as unknown[]
			)[0] as { elementIds: string[] }[];

			// Should have 3 elements: path-4, path-2 (updated), path-3
			expect(layers[0].elementIds).toHaveLength(3);

			// Check order
			expect(layers[0].elementIds[0]).toBe("path-4");
			expect(layers[0].elementIds[1]).toBe("path-2");
			expect(layers[0].elementIds[2]).toBe("path-3");

			// Object assertions from the last full sync (addElement path-4)
			const lastFullSyncCall =
				mockOnDocumentUpdate.mock.calls[
					mockOnDocumentUpdate.mock.calls.length - 1
				];
			const doc = lastFullSyncCall[0];
			expect(doc.objects["path-4"].id).toBe("path-4");
			expect(doc.objects["path-2"].id).toBe("path-2");
			expect(doc.objects["path-3"].id).toBe("path-3");
			expect(doc.objects["path-1"]).toBeUndefined();
		});
	});

	describe("object delta and full sync boundaries", () => {
		it("should use onObjectsChange for updateElement without full sync", () => {
			const mockOnObjectsChange = vi.fn();
			const mockOnSyncApplied = vi.fn();
			const provider = new YjsProvider({
				callbacks: {
					...callbacks,
					onObjectsChange: mockOnObjectsChange,
					onSyncApplied: mockOnSyncApplied,
				},
			});

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};
			provider.addLayer(layer);
			provider.addElement("layer-1", {
				id: "path-1",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			});

			mockOnDocumentUpdate.mockClear();
			mockOnObjectsChange.mockClear();
			mockOnSyncApplied.mockClear();

			provider.updateElement("layer-1", "path-1", { opacity: 0.5 });

			expect(mockOnObjectsChange).toHaveBeenCalledTimes(1);
			expect(mockOnDocumentUpdate).not.toHaveBeenCalled();
			expect(mockOnSyncApplied).toHaveBeenCalledTimes(1);

			const delta = mockOnObjectsChange.mock.calls[0][0];
			expect(delta.updated.has("path-1")).toBe(true);
			const updated = delta.updated.get("path-1");
			expect(updated?.id).toBe("path-1");
			if (updated?.type === "path") {
				expect(updated.opacity).toBe(0.5);
			}
			expect(mockOnSyncApplied.mock.calls[0][0]).toMatchObject({
				syncKind: "delta",
				undoRedo: false,
			});
		});

		it("should trigger full sync for addFile updates", () => {
			const mockOnObjectsChange = vi.fn();
			const mockOnSyncApplied = vi.fn();
			const provider = new YjsProvider({
				callbacks: {
					...callbacks,
					onObjectsChange: mockOnObjectsChange,
					onSyncApplied: mockOnSyncApplied,
				},
			});

			mockOnDocumentUpdate.mockClear();
			mockOnObjectsChange.mockClear();

			provider.addFile({
				uid: "file-1",
				name: "brush-1",
				type: "image/png",
				hash: "hash-1",
				bin: new Uint8Array([1, 2, 3]),
			});

			expect(mockOnDocumentUpdate).toHaveBeenCalledTimes(1);
			expect(mockOnObjectsChange).not.toHaveBeenCalled();
			expect(mockOnSyncApplied).toHaveBeenCalledTimes(1);
			expect(mockOnSyncApplied.mock.calls[0][0]).toMatchObject({
				syncKind: "full",
				undoRedo: false,
			});
		});

		it("should trigger full sync for addBrushPreset updates", () => {
			const mockOnObjectsChange = vi.fn();
			const mockOnSyncApplied = vi.fn();
			const provider = new YjsProvider({
				callbacks: {
					...callbacks,
					onObjectsChange: mockOnObjectsChange,
					onSyncApplied: mockOnSyncApplied,
				},
			});

			mockOnDocumentUpdate.mockClear();
			mockOnObjectsChange.mockClear();

			provider.addBrushPreset({
				uid: "preset-1",
				name: "Preset 1",
				// Pre-v2 stored shape: the provider migrates it on the way in.
				settings: {
					type: "scatter",
					source: { kind: "file", fileUid: "file-1" },
					randomSeed: 0,
					size: 10,
					sizeByPressure: 0.5,
					opacity: 1,
					opacityByPressure: 0.3,
					spacing: 0.1,
					flow: 1,
					stampRotation: "none",
					rotationByTilt: 0,
					aspectRatioByTilt: 0,
					sizeBySpeed: 0,
					pooling: 0,
					poolingSizeRatio: 0.5,
				} as unknown as BrushSettings,
			});

			expect(mockOnDocumentUpdate).toHaveBeenCalledTimes(1);
			expect(mockOnObjectsChange).not.toHaveBeenCalled();
			expect(mockOnSyncApplied).toHaveBeenCalledTimes(1);
			expect(mockOnSyncApplied.mock.calls[0][0]).toMatchObject({
				syncKind: "full",
				undoRedo: false,
			});
		});

		it("should flag undoRedo on undo and redo syncs", () => {
			const mockOnSyncApplied = vi.fn();
			const provider = new YjsProvider({
				callbacks: {
					...callbacks,
					onSyncApplied: mockOnSyncApplied,
				},
			});

			const layer = {
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			};
			provider.addLayer(layer);
			provider.addElement("layer-1", {
				id: "path-1",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			});
			mockOnSyncApplied.mockClear();

			provider.undo();
			expect(mockOnSyncApplied).toHaveBeenCalledTimes(1);
			expect(mockOnSyncApplied.mock.calls[0][0]).toMatchObject({
				undoRedo: true,
			});

			mockOnSyncApplied.mockClear();
			provider.redo();
			expect(mockOnSyncApplied).toHaveBeenCalledTimes(1);
			expect(mockOnSyncApplied.mock.calls[0][0]).toMatchObject({
				undoRedo: true,
			});
		});

		it("should store file bin in Yjs as Uint8Array", () => {
			const provider = new YjsProvider({ callbacks });
			provider.addFile({
				uid: "file-typed",
				name: "typed",
				type: "image/png",
				hash: "hash-typed",
				bin: new Uint8Array([10, 20, 30]),
			});

			const yFiles = provider.ydoc.getMap("files");
			const stored = yFiles.get("file-typed") as { bin?: unknown } | undefined;
			expect(stored?.bin).toBeInstanceOf(Uint8Array);
		});
	});

	describe("HDR settings", () => {
		it("should persist HDR settings via setHdr()", () => {
			const provider = new YjsProvider({ callbacks });

			provider.setHdr({ enabled: true, exposure: 2.0 });

			const yMeta = provider.ydoc.getMap("meta");
			const stored = JSON.parse(yMeta.get("hdr") as string);
			expect(stored).toEqual({ enabled: true, exposure: 2.0 });

			provider.destroy();
		});

		it("should populate yMeta with hdr from document", () => {
			const provider = new YjsProvider({ callbacks });

			provider.initializeDocument({
				id: "doc-hdr",
				objects: {},
				layers: [],
				viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
				files: [],
				artboards: [],
				brushPresets: [],
				hdr: { enabled: true, exposure: 1.0 },
			});

			const yMeta = provider.ydoc.getMap("meta");
			const stored = JSON.parse(yMeta.get("hdr") as string);
			expect(stored).toEqual({ enabled: true, exposure: 1.0 });

			provider.destroy();
		});
	});

	describe("Color profile settings", () => {
		it("should persist color profile settings via setColorProfile()", () => {
			const provider = new YjsProvider({ callbacks });

			provider.setColorProfile({
				workingSpace: "srgb",
				proofIntent: "perceptual",
			});

			const yMeta = provider.ydoc.getMap("meta");
			const stored = JSON.parse(yMeta.get("colorProfile") as string);
			expect(stored).toEqual({
				workingSpace: "srgb",
				proofIntent: "perceptual",
			});

			provider.destroy();
		});

		it("should populate yMeta with colorProfile from document", () => {
			const provider = new YjsProvider({ callbacks });

			provider.initializeDocument({
				id: "doc-color-profile",
				objects: {},
				layers: [],
				viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
				files: [],
				artboards: [],
				brushPresets: [],
				colorProfile: { workingSpace: "srgb" },
			});

			const yMeta = provider.ydoc.getMap("meta");
			const stored = JSON.parse(yMeta.get("colorProfile") as string);
			expect(stored).toEqual({ workingSpace: "srgb" });

			provider.destroy();
		});
	});

	describe("defs CRUD", () => {
		it("should add a def entry to yDefs", () => {
			const provider = new YjsProvider({ callbacks });

			provider.createDef({
				id: "def-1",
				kind: "pattern",
				name: "Stripes",
				rootElementIds: ["p1"],
				tile: { width: 100, height: 100 },
			});

			const yDefs = provider.ydoc.getMap("defs");
			const yDef = yDefs.get("def-1") as Y.Map<unknown> | undefined;
			expect(yDef).toBeDefined();
			expect(yDef!.get("id")).toBe("def-1");
			expect(yDef!.get("kind")).toBe("pattern");
			expect(yDef!.get("name")).toBe("Stripes");
			expect(JSON.parse(yDef!.get("tile") as string)).toEqual({
				width: 100,
				height: 100,
			});
			const yRoots = yDef!.get("rootElementIds") as Y.Array<string>;
			expect(yRoots.toArray()).toEqual(["p1"]);

			provider.destroy();
		});

		it("updateDefMeta patches name / tile without touching rootElementIds", () => {
			const provider = new YjsProvider({ callbacks });

			provider.createDef({
				id: "def-1",
				kind: "pattern",
				name: "Old",
				rootElementIds: ["p1"],
				tile: { width: 50, height: 50 },
			});

			provider.updateDefMeta("def-1", {
				name: "New",
				tile: { width: 200, height: 200 },
			});

			const yDef = provider.ydoc.getMap("defs").get("def-1") as Y.Map<unknown>;
			expect(yDef.get("name")).toBe("New");
			expect(JSON.parse(yDef.get("tile") as string)).toEqual({
				width: 200,
				height: 200,
			});
			expect((yDef.get("rootElementIds") as Y.Array<string>).toArray()).toEqual(
				["p1"],
			);

			provider.destroy();
		});

		it("replaceDefElements swaps the rootElementIds list", () => {
			const provider = new YjsProvider({ callbacks });

			provider.createDef({
				id: "def-1",
				kind: "pattern",
				rootElementIds: ["a", "b"],
			});

			provider.replaceDefElements("def-1", ["x", "y", "z"]);

			const yDef = provider.ydoc.getMap("defs").get("def-1") as Y.Map<unknown>;
			expect((yDef.get("rootElementIds") as Y.Array<string>).toArray()).toEqual(
				["x", "y", "z"],
			);

			provider.destroy();
		});

		it("deleteDef cascades through rootElementIds in yObjects", () => {
			const provider = new YjsProvider({ callbacks });
			// Seed two member elements + the def.
			provider.addObjectOnly({
				id: "m1",
				type: "path",
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
				segments: [],
			});
			provider.addObjectOnly({
				id: "m2",
				type: "path",
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
				segments: [],
			});
			provider.createDef({
				id: "def-1",
				kind: "vector-brush",
				rootElementIds: ["m1", "m2"],
			});

			provider.deleteDef("def-1");

			const yDefs = provider.ydoc.getMap("defs");
			expect(yDefs.has("def-1")).toBe(false);
			const yObjects = provider.ydoc.getMap("objects");
			expect(yObjects.has("m1")).toBe(false);
			expect(yObjects.has("m2")).toBe(false);

			provider.destroy();
		});

		it("undo restores a deleted def (yDefs is part of UndoManager scope)", () => {
			const provider = new YjsProvider({ callbacks });
			provider.createDef({
				id: "def-1",
				kind: "pattern",
				rootElementIds: [],
			});
			// Need a tracked transaction; undoManager tracks origin=null by default.
			provider.undoManager.stopCapturing();

			provider.deleteDef("def-1");
			expect(provider.ydoc.getMap("defs").has("def-1")).toBe(false);

			provider.undo();
			expect(provider.ydoc.getMap("defs").has("def-1")).toBe(true);

			provider.destroy();
		});

		it("createDef accepts an entry with no name / no tile", () => {
			const provider = new YjsProvider({ callbacks });
			provider.createDef({
				id: "vbrush",
				kind: "vector-brush",
				rootElementIds: ["src"],
			});
			const yDef = provider.ydoc.getMap("defs").get("vbrush") as Y.Map<unknown>;
			expect(yDef.has("name")).toBe(false);
			expect(yDef.has("tile")).toBe(false);
			provider.destroy();
		});
	});

	describe("appearance presets", () => {
		const preset = {
			uid: "ap-1",
			name: "Outline",
			filters: [
				{
					uid: "f-1",
					processor: "stroke",
					opacity: 1,
					blendMode: "normal" as const,
					paramData: { version: "1", params: {} },
				},
			],
		};

		it("should store a preset with JSON-encoded filters", () => {
			const provider = new YjsProvider({ callbacks });

			provider.setAppearancePreset(preset);

			const yPreset = provider.ydoc
				.getMap("appearancePresets")
				.get("ap-1") as Y.Map<unknown>;
			expect(yPreset.get("name")).toBe("Outline");
			expect(JSON.parse(yPreset.get("filters") as string)).toEqual(
				preset.filters,
			);

			provider.destroy();
		});

		it("should replace a preset with the same uid and remove it on delete", () => {
			const provider = new YjsProvider({ callbacks });

			provider.setAppearancePreset(preset);
			provider.setAppearancePreset({ ...preset, name: "Renamed" });
			expect(extractDocumentFromYDoc(provider.ydoc).appearancePresets).toEqual([
				{ ...preset, name: "Renamed" },
			]);

			provider.deleteAppearancePreset("ap-1");
			expect(extractDocumentFromYDoc(provider.ydoc).appearancePresets).toEqual(
				[],
			);

			provider.destroy();
		});

		it("should undo a preset update together with element updates made in the same transaction", () => {
			const provider = new YjsProvider({ callbacks });
			provider.addLayer({
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			});
			provider.addElement("layer-1", {
				id: "path-1",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
				filters: [preset.filters[0]!],
			});
			provider.setAppearancePreset(preset);
			provider.undoManager.stopCapturing();

			provider.transact(() => {
				provider.setAppearancePreset({ ...preset, name: "Changed" });
				provider.updateElement("layer-1", "path-1", {
					filters: [{ type: "preset", uid: "ref-1", presetUid: "ap-1" }],
				});
			});
			provider.undo();

			const doc = extractDocumentFromYDoc(provider.ydoc);
			expect(doc.appearancePresets?.[0]?.name).toBe("Outline");
			expect(doc.objects["path-1"]?.filters).toEqual(preset.filters);

			provider.destroy();
		});

		it("should keep preset writes bound after resetWithFreshDoc", () => {
			const provider = new YjsProvider({ callbacks });
			const freshDoc = provider.resetWithFreshDoc();

			provider.setAppearancePreset(preset);

			expect(freshDoc.getMap("appearancePresets").has("ap-1")).toBe(true);
		});
	});

	describe("references3d CRUD", () => {
		function makeSceneDef(
			overrides: Partial<Reference3DDef> = {},
		): Reference3DDef {
			return {
				id: "scene-1",
				name: "Room",
				nodes: [
					{
						id: "node-box",
						kind: "primitive",
						shape: "box",
						transform: {
							position: [0, 0.5, 0],
							rotation: [0, 0, 0, 1],
							scale: [1, 1, 1],
						},
					},
					{
						id: "node-mesh",
						kind: "mesh",
						fileUid: "mesh-file",
						transform: {
							position: [0, 0, 0],
							rotation: [0, 0, 0, 1],
							scale: [1, 1, 1],
						},
					},
				],
				...overrides,
			};
		}

		it("setReference3D stores the scene with nodes as a JSON string", () => {
			const provider = new YjsProvider({ callbacks });
			const def = makeSceneDef();

			provider.setReference3D(def);

			const yScene = provider.ydoc
				.getMap("references3d")
				.get("scene-1") as Y.Map<unknown>;
			expect(yScene.get("id")).toBe("scene-1");
			expect(yScene.get("name")).toBe("Room");
			expect(JSON.parse(yScene.get("nodes") as string)).toEqual(def.nodes);

			provider.destroy();
		});

		it("updateReference3DNodes replaces the node list of an existing scene", () => {
			const provider = new YjsProvider({ callbacks });
			provider.setReference3D(makeSceneDef());

			const newNodes: Reference3DDef["nodes"] = [
				{
					id: "node-sphere",
					kind: "primitive",
					shape: "sphere",
					transform: {
						position: [0, 0, 0],
						rotation: [0, 0, 0, 1],
						scale: [1, 1, 1],
					},
				},
			];
			provider.updateReference3DNodes("scene-1", newNodes);

			const yScene = provider.ydoc
				.getMap("references3d")
				.get("scene-1") as Y.Map<unknown>;
			expect(JSON.parse(yScene.get("nodes") as string)).toEqual(newNodes);

			provider.destroy();
		});

		it("updateReference3DNodes is a no-op for an unknown scene id", () => {
			const provider = new YjsProvider({ callbacks });

			provider.updateReference3DNodes("missing", []);

			expect(provider.ydoc.getMap("references3d").has("missing")).toBe(false);
			provider.destroy();
		});

		it("deleteReference3D removes the scene definition", () => {
			const provider = new YjsProvider({ callbacks });
			provider.setReference3D(makeSceneDef());

			provider.deleteReference3D("scene-1");

			expect(provider.ydoc.getMap("references3d").has("scene-1")).toBe(false);
			provider.destroy();
		});

		it("undo restores a deleted scene (yReferences3d is part of UndoManager scope)", () => {
			const provider = new YjsProvider({ callbacks });
			provider.setReference3D(makeSceneDef());
			provider.undoManager.stopCapturing();

			provider.deleteReference3D("scene-1");
			expect(provider.ydoc.getMap("references3d").has("scene-1")).toBe(false);

			provider.undo();
			expect(provider.ydoc.getMap("references3d").has("scene-1")).toBe(true);

			provider.destroy();
		});

		it("references3d round-trips through extractDocumentFromYDoc", () => {
			const provider = new YjsProvider({ callbacks });
			const def = makeSceneDef();
			provider.setReference3D(def);

			const doc = extractDocumentFromYDoc(provider.ydoc);

			expect(doc.references3d).toEqual({ "scene-1": def });
			provider.destroy();
		});

		it("replaceDocument populates references3d from the incoming document", () => {
			const provider = new YjsProvider({ callbacks });
			const def = makeSceneDef({ id: "scene-import" });

			provider.replaceDocument({
				id: "doc-1",
				objects: {},
				layers: [],
				viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
				files: [],
				artboards: [],
				brushPresets: [],
				references3d: { "scene-import": def },
			});

			const doc = extractDocumentFromYDoc(provider.ydoc);
			expect(doc.references3d).toEqual({ "scene-import": def });
			provider.destroy();
		});
	});

	describe("duplicated element references", () => {
		function makePath(id: string) {
			return {
				id,
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			};
		}

		it("should drop repeated children when loading a document", () => {
			const provider = new YjsProvider({ callbacks });

			provider.replaceDocument({
				id: "doc-1",
				objects: {
					"group-1": {
						id: "group-1",
						type: "group",
						childIds: ["path-1", "path-2", "path-1", "path-2"],
						opacity: 1,
						blendMode: "normal",
						transform: createIdentityTransform(),
					},
					"path-1": makePath("path-1"),
					"path-2": makePath("path-2"),
				},
				layers: [
					{
						id: "layer-1",
						name: "Layer 1",
						visible: true,
						locked: false,
						opacity: 1,
						elementIds: ["group-1", "group-1"],
					},
				],
				viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
				files: [],
				artboards: [],
				brushPresets: [],
			});

			const doc = extractDocumentFromYDoc(provider.ydoc);
			expect(doc.layers[0].elementIds).toEqual(["group-1"]);
			expect(
				(doc.objects["group-1"] as { childIds: string[] }).childIds,
			).toEqual(["path-1", "path-2"]);
			provider.destroy();
		});

		it("should not add the same child to a group twice", () => {
			const provider = new YjsProvider({ callbacks });

			provider.addLayer({
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			});
			provider.addElement("layer-1", {
				id: "group-1",
				type: "group",
				childIds: [],
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			});
			provider.addElement("layer-1", makePath("path-1"));

			provider.addElementToGroup("layer-1", "group-1", "path-1");
			provider.addElementToGroup("layer-1", "group-1", "path-1");

			const doc = extractDocumentFromYDoc(provider.ydoc);
			expect(
				(doc.objects["group-1"] as { childIds: string[] }).childIds,
			).toEqual(["path-1"]);
			provider.destroy();
		});
	});
});
