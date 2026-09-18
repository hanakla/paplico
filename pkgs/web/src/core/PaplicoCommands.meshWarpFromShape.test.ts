import { describe, expect, it } from "vitest";
import { extractDocumentFromYDoc } from "./collaboration/extractDocumentFromYDoc";
import {
	YjsProvider,
	type YjsProviderCallbacks,
} from "./collaboration/YjsProvider";
import { createIdentityTransform } from "./document/factory";
import { createRendererState } from "./document/rendererState";
import { SpatialIndex } from "./document/SpatialIndex";
import { PaplicoCommands } from "./PaplicoCommands";
import { PaplicoSelection } from "./PaplicoSelection";
import {
	type AnyArtObject,
	type BlendObject,
	type ElementTransform,
	getTransform,
	isMesh,
	type Layer,
	type MeshArtObject,
	type Point,
	type TextElement,
	type TextStyle,
} from "./schema";
import { rectPath } from "./testUtils/svgFixtures";
import { calculateLocalElementBounds } from "./utils/geometry/bounds";
import {
	applyTransformToPoint,
	computeTransformOrigin,
} from "./utils/geometry/geometry";

describe("PaplicoCommands.createMeshWarpFromShapeSelection", () => {
	it("should use the key object as the shape and the rest as content", () => {
		const f = createFixture();
		f.addElements([
			rectPath("a", { x: 10, y: 10 }, 20, 20, []),
			rectPath("shape", { x: 50, y: 50 }, 100, 100, []),
			rectPath("b", { x: 40, y: 40 }, 20, 20, []),
		]);
		f.select(["a", "shape", "b"], "shape");

		const result = f.commands.createMeshWarpFromShapeSelection();

		expect(result.ok).toBe(true);
		const meshId = result.ok ? result.meshId : "";
		expect(f.layerIds()).toEqual([meshId]);
		expect(f.mesh(meshId).childIds).toEqual(["a", "b"]);
		expect(f.store.document.objects.shape).toBeUndefined();
		expect(f.store.selectedElementIds).toEqual([meshId]);
		expect(f.store.keyObjectId).toBeNull();
	});

	it("should fall back to the first selected element as the shape", () => {
		const f = createFixture();
		f.addElements([
			rectPath("a", { x: 10, y: 10 }, 20, 20, []),
			rectPath("shape", { x: 50, y: 50 }, 100, 100, []),
		]);
		f.select(["shape", "a"], null);

		const result = f.commands.createMeshWarpFromShapeSelection();

		expect(result.ok).toBe(true);
		const meshId = result.ok ? result.meshId : "";
		expect(f.mesh(meshId).childIds).toEqual(["a"]);
		expect(f.store.document.objects.shape).toBeUndefined();
	});

	it("should keep the cage where the shape was drawn", () => {
		const f = createFixture();
		f.addElements([
			rectPath("a", { x: 15, y: 15 }, 10, 10, []),
			rectPath("shape", { x: 0, y: 0 }, 100, 50, []),
		]);
		f.select(["a", "shape"], "shape");

		const result = f.commands.createMeshWarpFromShapeSelection();

		const mesh = f.mesh(result.ok ? result.meshId : "");
		const corners = mesh.vertices.map((v) => `${v.x},${v.y}`).sort();
		expect(corners).toEqual(["-50,-25", "-50,25", "50,-25", "50,25"]);
		expect(getTransform(mesh)).toEqual(createIdentityTransform());
	});

	it("should bake the shape's transform into the cage", () => {
		const f = createFixture();
		f.addElements([
			rectPath("a", { x: 5, y: 5 }, 10, 10, []),
			{
				...rectPath("shape", { x: 0, y: 0 }, 100, 50, []),
				transform: {
					...createIdentityTransform(),
					x: 100,
					rotation: Math.PI / 2,
				},
			},
		]);
		f.select(["a", "shape"], "shape");

		const result = f.commands.createMeshWarpFromShapeSelection();

		const mesh = f.mesh(result.ok ? result.meshId : "");
		const xs = mesh.vertices.map((v) => v.x);
		const ys = mesh.vertices.map((v) => v.y);
		expect(Math.min(...xs)).toBeCloseTo(75, 6);
		expect(Math.max(...xs)).toBeCloseTo(125, 6);
		expect(Math.min(...ys)).toBeCloseTo(-50, 6);
		expect(Math.max(...ys)).toBeCloseTo(50, 6);
	});

	it("should keep the cage on canvas inside a rotated group", () => {
		const f = createFixture();
		f.addElements([
			rectPath("a", { x: 205, y: 205 }, 10, 10, []),
			rectPath("shape", { x: 50, y: 25 }, 100, 50, []),
			rectPath("b", { x: -100, y: -100 }, 10, 10, []),
		]);
		const groupId = f.provider.groupElements("layer", ["a", "shape", "b"]);
		if (!groupId) throw new Error("group not created");
		f.sync();
		const rotated: ElementTransform = {
			...createIdentityTransform(),
			rotation: 0.7,
			scaleX: 1.5,
		};
		f.provider.updateElement("layer", groupId, { transform: rotated });
		f.sync();
		const before = f.worldPointInGroup(groupId, { x: 0, y: 0 });
		const siblingBefore = f.worldPointOfElementCenter(groupId, "b");
		f.select(["a", "shape"], "shape");

		const result = f.commands.createMeshWarpFromShapeSelection();

		expect(result.ok).toBe(true);
		const siblingAfter = f.worldPointOfElementCenter(groupId, "b");
		expect(siblingAfter.x).toBeCloseTo(siblingBefore.x, 6);
		expect(siblingAfter.y).toBeCloseTo(siblingBefore.y, 6);
		const mesh = f.mesh(result.ok ? result.meshId : "");
		const origin = mesh.vertices.find(
			(v) =>
				v.src.x === Math.min(...mesh.vertices.map((w) => w.src.x)) &&
				v.src.y === Math.min(...mesh.vertices.map((w) => w.src.y)),
		);
		if (!origin) throw new Error("missing corner");
		const after = f.worldPointInGroup(groupId, origin);
		expect(after.x).toBeCloseTo(before.x, 6);
		expect(after.y).toBeCloseTo(before.y, 6);
	});

	it("should reuse an existing mesh as the shape and release its former content", () => {
		const f = createFixture();
		f.addElements([
			rectPath("old", { x: 5, y: 5 }, 10, 10, []),
			rectPath("a", { x: 25, y: 25 }, 10, 10, []),
			rectPath("shape", { x: 50, y: 50 }, 100, 100, []),
		]);
		f.select(["old", "shape"], "shape");
		const first = f.commands.createMeshWarpFromShapeSelection();
		const firstMeshId = first.ok ? first.meshId : "";
		const firstVertexCount = f.mesh(firstMeshId).vertices.length;
		f.select([firstMeshId, "a"], firstMeshId);

		const result = f.commands.createMeshWarpFromShapeSelection();

		expect(result.ok).toBe(true);
		const meshId = result.ok ? result.meshId : "";
		expect(f.layerIds()).toEqual(["old", meshId]);
		expect(f.mesh(meshId).childIds).toEqual(["a"]);
		expect(f.mesh(meshId).vertices).toHaveLength(firstVertexCount);
		expect(f.mesh(meshId).outlineOnRelease).toBe(true);
		expect(f.store.document.objects[firstMeshId]).toBeUndefined();
	});

	it("should keep a rotated mesh's former content where it was drawn when the mesh is reused as the shape", () => {
		const f = createFixture();
		f.addElements([
			rectPath("old", { x: 5, y: 5 }, 10, 10, []),
			rectPath("a", { x: 25, y: 25 }, 10, 10, []),
			rectPath("shape", { x: 50, y: 50 }, 100, 100, []),
		]);
		f.select(["old", "shape"], "shape");
		const first = f.commands.createMeshWarpFromShapeSelection();
		const firstMeshId = first.ok ? first.meshId : "";
		f.provider.updateElement("layer", firstMeshId, {
			transform: { ...createIdentityTransform(), x: 10, rotation: Math.PI / 2 },
		});
		f.sync();
		const before = f.worldPointInGroup(firstMeshId, f.localCenter("old"));
		f.select([firstMeshId, "a"], firstMeshId);

		const result = f.commands.createMeshWarpFromShapeSelection();

		expect(result.ok).toBe(true);
		const after = f.worldPointOfElement("old");
		expect(after.x).toBeCloseTo(before.x, 6);
		expect(after.y).toBeCloseTo(before.y, 6);
	});

	it("should drop a text's axis binding to the consumed shape", () => {
		const f = createFixture();
		f.addElements([
			rectPath("a", { x: 10, y: 10 }, 20, 20, []),
			rectPath("shape", { x: 0, y: 0 }, 100, 100, []),
			textOn("text", "shape"),
		]);
		f.select(["a", "shape"], "shape");

		const result = f.commands.createMeshWarpFromShapeSelection();

		expect(result.ok).toBe(true);
		const text = f.store.document.objects.text;
		if (!text || text.type !== "text") throw new Error("no text");
		expect(text.axisBinding).toBeUndefined();
	});

	it("should refuse a locked element instead of dropping it", () => {
		const f = createFixture();
		f.addElements([
			{ ...rectPath("a", { x: 10, y: 10 }, 20, 20, []), locked: true },
			rectPath("shape", { x: 50, y: 50 }, 100, 100, []),
		]);
		f.select(["a", "shape"], "shape");

		expect(f.commands.createMeshWarpFromShapeSelection()).toEqual({
			ok: false,
			reason: "locked",
		});
		expect(f.layerIds()).toEqual(["a", "shape"]);
		expect(f.store.selectedElementIds).toEqual(["a", "shape"]);
		expect(f.provider.canUndo()).toBe(false);
	});

	it("should refuse elements from different parents", () => {
		const f = createFixture();
		f.addElements([
			rectPath("a", { x: 10, y: 10 }, 20, 20, []),
			rectPath("shape", { x: 50, y: 50 }, 100, 100, []),
			rectPath("b", { x: 2.5, y: 2.5 }, 5, 5, []),
			rectPath("c", { x: 2.5, y: 2.5 }, 5, 5, []),
		]);
		f.provider.groupElements("layer", ["b", "c"]);
		f.sync();
		f.select(["a", "shape", "b"], "shape");

		expect(f.commands.createMeshWarpFromShapeSelection()).toEqual({
			ok: false,
			reason: "different-parent",
		});
	});

	it("should refuse when the parent's clip path is selected", () => {
		const f = createFixture();
		f.addElements([
			rectPath("clip", { x: 10, y: 10 }, 20, 20, []),
			rectPath("a", { x: 2.5, y: 2.5 }, 5, 5, []),
			rectPath("shape", { x: 50, y: 50 }, 100, 100, []),
		]);
		const groupId = f.provider.groupElements("layer", ["clip", "a", "shape"]);
		if (!groupId) throw new Error("group not created");
		f.provider.setClipPath("layer", groupId, "clip");
		f.sync();
		f.select(["clip", "shape"], "shape");

		expect(f.commands.createMeshWarpFromShapeSelection()).toEqual({
			ok: false,
			reason: "invalid-selection",
		});
	});

	it("should refuse content the warp cannot deform", () => {
		const f = createFixture();
		f.addElements([
			rectPath("a", { x: 10, y: 10 }, 20, 20, []),
			rectPath("b", { x: 10, y: 10 }, 20, 20, []),
			rectPath("shape", { x: 50, y: 50 }, 100, 100, []),
		]);
		const blend: BlendObject = {
			id: "blend",
			type: "blend",
			objectIds: ["a", "b"],
			spacing: { type: "steps", count: 2 },
			placementEasing: { type: "linear" },
			appearanceEasing: { type: "linear" },
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};
		f.provider.createBlend("layer", blend);
		f.sync();
		f.select(["blend", "shape"], "shape");

		expect(f.commands.createMeshWarpFromShapeSelection()).toEqual({
			ok: false,
			reason: "unsupported-content",
		});
	});

	it("should refuse an open shape", () => {
		const f = createFixture();
		const open = rectPath("shape", { x: 50, y: 50 }, 100, 100, []);
		open.segments = open.segments.slice(0, 2);
		f.addElements([rectPath("a", { x: 10, y: 10 }, 20, 20, []), open]);
		f.select(["a", "shape"], "shape");

		expect(f.commands.createMeshWarpFromShapeSelection()).toEqual({
			ok: false,
			reason: "invalid-shape",
		});
	});

	it("should refuse a selection without content", () => {
		const f = createFixture();
		f.addElements([rectPath("shape", { x: 50, y: 50 }, 100, 100, [])]);
		f.select(["shape"], "shape");

		expect(f.commands.createMeshWarpFromShapeSelection()).toEqual({
			ok: false,
			reason: "invalid-selection",
		});
	});

	it("should give the shape back as a path when the mesh is released", () => {
		const f = createFixture();
		f.addElements([
			rectPath("a", { x: 15, y: 15 }, 10, 10, []),
			rectPath("shape", { x: 0, y: 0 }, 100, 50, []),
		]);
		f.select(["a", "shape"], "shape");
		const result = f.commands.createMeshWarpFromShapeSelection();
		const meshId = result.ok ? result.meshId : "";
		f.provider.updateElement("layer", meshId, {
			transform: { ...createIdentityTransform(), x: 10 },
		});

		f.commands.releaseMeshWarp(meshId);

		const [outlineId, ...rest] = f.layerIds();
		expect(rest).toEqual(["a"]);
		const outline = f.store.document.objects[outlineId];
		if (!outline || outline.type !== "path") throw new Error("no outline");
		expect(outline.segments).toHaveLength(4);
		expect(outline.segments.at(-1)?.isClosed).toBe(true);
		const anchors = outline.segments.map((s) => `${s.end.x},${s.end.y}`).sort();
		expect(anchors).toEqual(["-40,-25", "-40,25", "60,-25", "60,25"]);
		expect(f.store.selectedElementIds).toEqual([outlineId, "a"]);
	});

	it("should keep a rectangle cage reused as the shape free of a release outline", () => {
		const f = createFixture();
		f.addElements([
			rectPath("a", { x: 10, y: 10 }, 20, 20, []),
			rectPath("b", { x: 60, y: 60 }, 20, 20, []),
		]);
		f.select(["a"], null);
		const rectMeshId = f.commands.createMeshWarpFromSelection();
		if (!rectMeshId) throw new Error("no mesh");
		f.select([rectMeshId, "b"], rectMeshId);

		const result = f.commands.createMeshWarpFromShapeSelection();

		const meshId = result.ok ? result.meshId : "";
		expect(f.mesh(meshId).outlineOnRelease).toBeUndefined();
		f.commands.releaseMeshWarp(meshId);
		expect(f.layerIds()).toEqual(["a", "b"]);
	});

	it("should not add a path when releasing a rectangle cage", () => {
		const f = createFixture();
		f.addElements([rectPath("a", { x: 15, y: 15 }, 10, 10, [])]);
		f.select(["a"], null);
		const meshId = f.commands.createMeshWarpFromSelection();
		if (!meshId) throw new Error("no mesh");

		f.commands.releaseMeshWarp(meshId);

		expect(f.layerIds()).toEqual(["a"]);
	});

	it("should undo the whole replacement in one step and leave earlier edits alone", () => {
		const f = createFixture();
		f.addElements([
			rectPath("a", { x: 10, y: 10 }, 20, 20, []),
			rectPath("shape", { x: 50, y: 50 }, 100, 100, []),
		]);
		f.provider.stopUndoCapture();
		f.addElements([rectPath("later", { x: 2.5, y: 2.5 }, 5, 5, [])]);
		f.select(["a", "shape"], "shape");
		const result = f.commands.createMeshWarpFromShapeSelection();
		const meshId = result.ok ? result.meshId : "";
		expect(f.layerIds()).toEqual([meshId, "later"]);

		f.provider.undo();
		f.sync();

		expect(f.layerIds()).toEqual(["a", "shape", "later"]);
		expect(f.store.document.objects[meshId]).toBeUndefined();
		f.provider.redo();
		f.sync();
		expect(f.layerIds()).toEqual([meshId, "later"]);
	});
});

function createFixture() {
	const store = createRendererState();
	const callbacks: YjsProviderCallbacks = {
		onDocumentUpdate: (doc) => {
			store.document = doc;
		},
		onObjectsChange: () => sync(),
		onLayersUpdate: () => {},
		getCurrentLayerId: () => store.currentLayerId,
		setCurrentLayerId: (id) => {
			store.currentLayerId = id;
		},
	};
	const provider = new YjsProvider({ callbacks });
	const spatial = new SpatialIndex(store);
	const selection = new PaplicoSelection(store, spatial);
	const sync = (): void => {
		store.document = extractDocumentFromYDoc(provider.ydoc);
		spatial.rebuildAllIndices();
		spatial.rebuildParentGroupMap();
	};
	const commands = new PaplicoCommands({
		store,
		yjsProvider: provider,
		spatial,
		selection,
		isReadonly: () => false,
	});
	const layer: Layer = {
		id: "layer",
		name: "layer",
		visible: true,
		locked: false,
		opacity: 1,
		elementIds: [],
	};
	provider.addLayer(layer);
	store.currentLayerId = "layer";
	sync();
	provider.clearUndoHistory();

	const objects = (): Record<string, AnyArtObject> => store.document.objects;
	return {
		store,
		provider,
		commands,
		sync,
		addElements(elements: AnyArtObject[]): void {
			for (const element of elements) provider.addElement("layer", element);
			sync();
			provider.clearUndoHistory();
		},
		select(ids: string[], keyObjectId: string | null): void {
			store.selectedElementIds = ids;
			store.keyObjectId = keyObjectId;
		},
		layerIds: (): string[] => store.document.layers[0].elementIds,
		mesh(id: string): MeshArtObject {
			const el = objects()[id];
			if (!el || !isMesh(el)) throw new Error(`mesh ${id} not found`);
			return el;
		},
		localCenter(id: string): Point {
			const el = objects()[id];
			if (!el) throw new Error("element not found");
			return computeTransformOrigin(
				calculateLocalElementBounds(el, new Map(Object.entries(objects()))),
			);
		},
		worldPointOfElement(id: string): Point {
			const el = objects()[id];
			if (!el) throw new Error("element not found");
			const center = this.localCenter(id);
			return applyTransformToPoint(
				center.x,
				center.y,
				getTransform(el),
				center.x,
				center.y,
			);
		},
		worldPointOfElementCenter(groupId: string, id: string): Point {
			return this.worldPointInGroup(groupId, this.localCenter(id));
		},
		worldPointInGroup(groupId: string, p: Point): Point {
			const group = objects()[groupId];
			if (!group) throw new Error("group not found");
			const origin = computeTransformOrigin(
				calculateLocalElementBounds(group, new Map(Object.entries(objects()))),
			);
			return applyTransformToPoint(
				p.x,
				p.y,
				getTransform(group),
				origin.x,
				origin.y,
			);
		},
	};
}

function textOn(id: string, pathObjectId: string): TextElement {
	const style: TextStyle = {
		fontFamily: "sans-serif",
		fontSource: { type: "local", postScriptName: "sans-serif" },
		fontSize: 16,
		fontWeight: 400,
		fontStyle: "normal",
		fill: null,
		underline: false,
		strikethrough: false,
		letterSpacing: 0,
		baselineShift: 0,
	};
	return {
		type: "text",
		id,
		x: 0,
		y: 0,
		content: {
			paragraphs: [
				{
					runs: [{ text: "Hi", style }],
					alignment: "left",
					lineHeight: 1.5,
					indent: 0,
					spacing: { before: 0, after: 0 },
				},
			],
		},
		defaultStyle: style,
		layout: {
			writingMode: "horizontal-tb",
			boxWidth: "auto",
			boxHeight: "auto",
			overflow: "visible",
			wordWrap: true,
		},
		axisBinding: { mode: "inShape", pathObjectId },
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}
