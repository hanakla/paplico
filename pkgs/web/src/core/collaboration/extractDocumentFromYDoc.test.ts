import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createIdentityTransform } from "../document/factory";
import type {
	CompoundPath,
	Group,
	ImageObject,
	Path,
	Reference3DElement,
	TextElement,
} from "../schema";
import { TRANSIENT_LAYER_KIND } from "../schema";
import {
	extractDocumentFromYDoc,
	yMapToObject,
} from "./extractDocumentFromYDoc";
import {
	objectToStoredFields,
	YjsProvider,
	type YjsProviderCallbacks,
} from "./YjsProvider";

/**
 * server.js のデフォルトレイヤー初期化を再現するヘルパー。
 * server.js (line 120-131) と同じキー名・同じ構造で Y.Map を構築する。
 *
 * server.js のキー名を変更した場合、このヘルパーも同時に更新すること。
 * このテストが壊れた場合、server.js とクライアント側でキー名が食い違っている。
 */
function initializeRoomLikeServer(ydoc: Y.Doc): string {
	const yLayers = ydoc.getArray<Y.Map<unknown>>("layers");
	const yMeta = ydoc.getMap("meta");

	const layerId = "server-layer-1";

	const yLayer = new Y.Map<unknown>();
	yLayer.set("id", layerId);
	yLayer.set("name", "Layer 1");
	yLayer.set("visible", true);
	yLayer.set("locked", false);
	yLayer.set("opacity", 1);
	yLayer.set("elementIds", new Y.Array<string>());

	yLayers.push([yLayer]);

	yMeta.set("id", "doc-test");
	yMeta.set("name", "Test Document");

	return layerId;
}

describe("extractDocumentFromYDoc", () => {
	describe("server initialization compatibility", () => {
		it("server.js パターンで初期化したレイヤーを正しくパースできる", () => {
			const ydoc = new Y.Doc();

			ydoc.transact(() => {
				initializeRoomLikeServer(ydoc);
			});

			const doc = extractDocumentFromYDoc(ydoc);

			expect(doc.layers).toHaveLength(1);
			expect(doc.layers[0].id).toBe("server-layer-1");
			expect(doc.layers[0].name).toBe("Layer 1");
			expect(doc.layers[0].visible).toBe(true);
			expect(doc.layers[0].locked).toBe(false);
			expect(doc.layers[0].opacity).toBe(1);
			expect(doc.layers[0].blendMode).toBe("normal");
			expect(doc.layers[0].elementIds).toEqual([]);

			ydoc.destroy();
		});

		it("server.js パターンで初期化したレイヤーに対して addElement が動作する", () => {
			const mockOnDocumentUpdate = vi.fn();
			const callbacks: YjsProviderCallbacks = {
				onDocumentUpdate: mockOnDocumentUpdate,
				onLayersUpdate: vi.fn(),
				getCurrentLayerId: () => "server-layer-1",
				setCurrentLayerId: vi.fn(),
			};

			const provider = new YjsProvider({ callbacks });

			// server.js と同じ方法でレイヤーを初期化
			provider.ydoc.transact(() => {
				initializeRoomLikeServer(provider.ydoc);
			});

			provider.addElement("server-layer-1", {
				id: "path-1",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
			});

			provider.addElement("server-layer-1", {
				id: "path-transformed",
				type: "path" as const,
				segments: [],
				opacity: 1,
				blendMode: "normal" as const,
				transform: {
					x: 10,
					y: -20,
					rotation: Math.PI / 4,
					scaleX: 2,
					scaleY: 0.5,
				},
			});

			const doc = extractDocumentFromYDoc(provider.ydoc);

			// elementIds にパスIDが含まれること
			expect(doc.layers[0].elementIds).toContain("path-1");
			expect(doc.objects["path-1"]).toBeDefined();
			expect(doc.objects["path-1"].id).toBe("path-1");
			expect(doc.objects["path-1"].transform).toEqual({
				x: 0,
				y: 0,
				rotation: 0,
				scaleX: 1,
				scaleY: 1,
				skewX: 0,
				skewY: 0,
			});

			const obj = doc.objects["path-transformed"];
			expect(obj.transform).toBeDefined();
			expect(obj.transform?.x).toBe(10);
			expect(obj.transform?.y).toBe(-20);
			expect(obj.transform?.rotation).toBe(Math.PI / 4);
			expect(obj.transform?.scaleX).toBe(2);
			expect(obj.transform?.scaleY).toBe(0.5);

			provider.destroy();
		});
	});

	describe("embedded file bin validation", () => {
		it("number[] bin を Uint8Array に復元する", () => {
			const ydoc = new Y.Doc();
			const yFiles = ydoc.getMap("files");
			yFiles.set("file-legacy", {
				uid: "file-legacy",
				name: "legacy",
				type: "image/png",
				hash: "hash-legacy",
				bin: [1, 2, 3, 4],
			});

			const doc = extractDocumentFromYDoc(ydoc);
			expect(doc.files).toHaveLength(1);
			expect(doc.files[0].bin).toBeInstanceOf(Uint8Array);
			expect(Array.from(doc.files[0].bin)).toEqual([1, 2, 3, 4]);
		});

		it("Uint8Array bin は再変換せずに利用する", () => {
			const ydoc = new Y.Doc();
			const yFiles = ydoc.getMap("files");
			const bin = new Uint8Array([10, 20, 30]);
			yFiles.set("file-typed", {
				uid: "file-typed",
				name: "typed",
				type: "image/png",
				hash: "hash-typed",
				bin,
			});

			const stored = yFiles.get("file-typed") as { bin: Uint8Array };
			const doc = extractDocumentFromYDoc(ydoc);
			expect(doc.files).toHaveLength(1);
			expect(doc.files[0].bin).toBe(stored.bin);
			expect(Array.from(doc.files[0].bin)).toEqual([10, 20, 30]);
		});
	});
});

describe("yMapToObject: missing optional Yjs keys", () => {
	it("falls back to identity transform when transform key is missing", () => {
		const ydoc = new Y.Doc();
		const root = ydoc.getMap("test");
		const yMap = new Y.Map<unknown>();

		ydoc.transact(() => {
			root.set("el", yMap);
			yMap.set("type", "path");
			yMap.set("id", "path-no-transform");
			yMap.set("opacity", 1);
			yMap.set("blendMode", "normal");
			yMap.set("segments", JSON.stringify([]));
			// transform is intentionally not set
		});

		const result = yMapToObject(yMap);
		expect(result.transform).toEqual(createIdentityTransform());

		ydoc.destroy();
	});

	it("returns undefined filters when filters key is missing", () => {
		const ydoc = new Y.Doc();
		const root = ydoc.getMap("test");
		const yMap = new Y.Map<unknown>();

		ydoc.transact(() => {
			root.set("el", yMap);
			yMap.set("type", "path");
			yMap.set("id", "path-no-filters");
			yMap.set("opacity", 1);
			yMap.set("blendMode", "normal");
			yMap.set("segments", JSON.stringify([]));
			yMap.set("transform", JSON.stringify(createIdentityTransform()));
		});

		const result = yMapToObject(yMap);
		expect(result.filters).toBeUndefined();

		ydoc.destroy();
	});
});

// --- Round-trip serialization tests ---
//
// These tests ensure objectToStoredFields and yMapToObject stay in sync.
// When a schema type gains a new field:
// 1. `satisfies` forces the fixture to include it (compile error if missing).
// 2. If objectToStoredFields skips it → Y.Map lacks it → round-trip loses it → test fails.
// 3. If yMapToObject skips it → result lacks it → round-trip loses it → test fails.

const IDENTITY_TRANSFORM = {
	x: 0,
	y: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
};

/** Populate a Y.Map from objectToStoredFields output inside a Y.Doc transaction */
function storedFieldsToYMap(fields: Record<string, unknown>): Y.Map<unknown> {
	const yMap = new Y.Map<unknown>();
	const ydoc = new Y.Doc();
	const root = ydoc.getMap("test");
	root.set("el", yMap);

	ydoc.transact(() => {
		for (const [key, value] of Object.entries(fields)) {
			yMap.set(key, value);
		}
	});

	return yMap;
}

/** Strip undefined values for deep-equal comparison */
function stripUndefined<T>(obj: T): T {
	return JSON.parse(JSON.stringify(obj));
}

describe("objectToStoredFields ↔ yMapToObject round-trip", () => {
	it("Path: all fields survive round-trip", () => {
		const path = {
			type: "path",
			id: "path-1",
			opacity: 0.8,
			blendMode: "multiply",
			visible: true,
			locked: false,
			segments: [
				{
					cp1: { x: 0, y: 0 },
					cp2: { x: 10, y: 10 },
					end: { x: 20, y: 0 },
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
					isMoved: false,
				},
			],
			filters: [
				{
					uid: "filter-1",
					processor: "fill",
					opacity: 1,
					blendMode: "normal",
					paramData: {
						version: "1",
						params: {
							fill: {
								type: "solid",
								color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
							},
						},
					},
				},
			],
			transform: IDENTITY_TRANSFORM,
		} satisfies Path;

		const fields = objectToStoredFields(path);
		const yMap = storedFieldsToYMap(fields);
		const result = yMapToObject(yMap);

		expect(stripUndefined(result)).toEqual(stripUndefined(path));
	});

	it("Group: all fields survive round-trip", () => {
		const group = {
			type: "group",
			id: "group-1",
			opacity: 1,
			blendMode: "normal",
			visible: true,
			locked: false,
			childIds: ["child-1", "child-2"],
			name: "My Group",
			collapsed: true,
			clipPathId: "clip-1",
			transform: IDENTITY_TRANSFORM,
		} satisfies Group;

		const fields = objectToStoredFields(group);
		const yMap = storedFieldsToYMap(fields);
		const result = yMapToObject(yMap);

		expect(stripUndefined(result)).toEqual(stripUndefined(group));
	});

	it("should carry ArtObject.mask through the round-trip", () => {
		const image = {
			type: "image",
			id: "img-masked",
			opacity: 1,
			blendMode: "normal",
			fileUid: "file-abc",
			x: 0,
			y: 0,
			width: 100,
			height: 100,
			transform: IDENTITY_TRANSFORM,
			mask: {
				elementIds: ["mask-1", "mask-2"],
				enabled: true,
				inverted: true,
			},
		} satisfies ImageObject;

		const result = yMapToObject(
			storedFieldsToYMap(objectToStoredFields(image)),
		);

		expect(stripUndefined(result)).toEqual(stripUndefined(image));
	});

	it("should leave mask undefined when the element has none", () => {
		const image = {
			type: "image",
			id: "img-plain",
			opacity: 1,
			blendMode: "normal",
			fileUid: "file-abc",
			x: 0,
			y: 0,
			width: 100,
			height: 100,
			transform: IDENTITY_TRANSFORM,
		} satisfies ImageObject;

		const result = yMapToObject(
			storedFieldsToYMap(objectToStoredFields(image)),
		);

		expect(result.mask).toBeUndefined();
	});

	it("ImageObject: all fields survive round-trip", () => {
		const image = {
			type: "image",
			id: "img-1",
			opacity: 1,
			blendMode: "normal",
			fileUid: "file-abc",
			x: 100,
			y: 200,
			width: 300,
			height: 400,
			transform: IDENTITY_TRANSFORM,
		} satisfies ImageObject;

		const fields = objectToStoredFields(image);
		const yMap = storedFieldsToYMap(fields);
		const result = yMapToObject(yMap);

		expect(stripUndefined(result)).toEqual(stripUndefined(image));
	});

	it("Reference3DElement: all fields survive round-trip", () => {
		const reference3d = {
			type: "reference3d",
			id: "reference3d-1",
			opacity: 0.9,
			blendMode: "normal",
			sceneId: "scene-1",
			camera: {
				projection: "perspective" as const,
				position: [4, 3, 6] as [number, number, number],
				target: [0, 1, 0] as [number, number, number],
				fovDeg: 50,
			},
			x: 100,
			y: -50,
			width: 400,
			height: 300,
			displayMode: "lineart" as const,
			lineart: {
				lineWidthPx: 1.5,
				depthEdgeThreshold: 0.02,
				normalEdgeThreshold: 0.4,
				creaseAngleDeg: 40,
				color: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 },
			},
			transform: IDENTITY_TRANSFORM,
		} satisfies Reference3DElement;

		const fields = objectToStoredFields(reference3d);
		const yMap = storedFieldsToYMap(fields);
		const result = yMapToObject(yMap);

		expect(stripUndefined(result)).toEqual(stripUndefined(reference3d));
	});

	it("CompoundPath: all fields survive round-trip", () => {
		const compoundPath = {
			type: "compound-path",
			id: "cp-1",
			opacity: 1,
			blendMode: "normal",
			sources: [
				{ id: "src-1", op: "union" as const },
				{ id: "src-2", op: "subtract" as const },
			],
			filters: [
				{
					uid: "filter-2",
					processor: "stroke",
					opacity: 1,
					blendMode: "normal",
					paramData: {
						version: "1",
						params: {
							strokeColor: {
								type: "solid",
								color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
							},
						},
					},
				},
			],
			transform: IDENTITY_TRANSFORM,
		} satisfies CompoundPath;

		const fields = objectToStoredFields(compoundPath);
		const yMap = storedFieldsToYMap(fields);
		const result = yMapToObject(yMap);

		expect(stripUndefined(result)).toEqual(stripUndefined(compoundPath));
	});

	it("TextElement: all fields survive round-trip", () => {
		const text = {
			type: "text",
			id: "text-1",
			opacity: 1,
			blendMode: "normal",
			x: 50,
			y: 60,
			content: {
				paragraphs: [
					{
						runs: [
							{
								text: "Hello",
								style: {
									fontFamily: "Arial",
									fontSource: { type: "local", postScriptName: "ArialMT" },
									fontSize: 16,
									fontWeight: 400,
									fontStyle: "normal",
									fill: {
										type: "solid",
										color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
									},
									underline: false,
									strikethrough: false,
									letterSpacing: 0,
									baselineShift: 0,
									lineHeight: 1.2,
								},
							},
						],
						alignment: "left",
						lineHeight: 1.2,
						indent: 0,
						spacing: { before: 0, after: 0 },
					},
				],
			},
			defaultStyle: {
				fontFamily: "Arial",
				fontSource: { type: "local", postScriptName: "ArialMT" },
				fontSize: 16,
				fontWeight: 400,
				fontStyle: "normal" as const,
				fill: {
					type: "solid" as const,
					color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
				},
				underline: false,
				strikethrough: false,
				letterSpacing: 0,
				baselineShift: 0,
				lineHeight: 1.2,
			},
			layout: {
				writingMode: "horizontal-tb",
				boxWidth: 200,
				boxHeight: "auto",
				overflow: "visible",
				wordWrap: true,
			},
			axisBinding: {
				mode: "onPath",
				pathObjectId: "path-1",
				startOffset: 0,
				offset: 0,
				alignment: "left",
				offsetDistance: 0,
				orientation: "upright",
			},
			flow: { nextTextElementId: "text-next" },
			clipPathId: "clip-text",
			transform: IDENTITY_TRANSFORM,
		} satisfies TextElement;

		const fields = objectToStoredFields(text);
		const yMap = storedFieldsToYMap(fields);
		const result = yMapToObject(yMap);

		expect(stripUndefined(result)).toEqual(stripUndefined(text));
	});

	it("Path without optional fields survives round-trip", () => {
		const path = {
			type: "path",
			id: "path-minimal",
			opacity: 1,
			blendMode: "normal",
			segments: [],
			transform: IDENTITY_TRANSFORM,
		} satisfies Path;

		const fields = objectToStoredFields(path);
		const yMap = storedFieldsToYMap(fields);
		const result = yMapToObject(yMap);

		expect(stripUndefined(result)).toEqual(stripUndefined(path));
	});

	it("Group without optional fields survives round-trip", () => {
		const group = {
			type: "group",
			id: "group-minimal",
			opacity: 1,
			blendMode: "normal",
			childIds: [],
			transform: IDENTITY_TRANSFORM,
		} satisfies Group;

		const fields = objectToStoredFields(group);
		const yMap = storedFieldsToYMap(fields);
		const result = yMapToObject(yMap);

		expect(stripUndefined(result)).toEqual(stripUndefined(group));
	});
});

// ---------------------------------------------------------------------------
// extractDocumentFromYDoc: full document extraction
// ---------------------------------------------------------------------------

/** Populate a Y.Doc with a complete document structure for testing. */
function populateFullDocument(ydoc: Y.Doc) {
	const yLayers = ydoc.getArray<Y.Map<unknown>>("layers");
	const yObjects = ydoc.getMap<Y.Map<unknown>>("objects");
	const yMeta = ydoc.getMap("meta");
	const yArtboards = ydoc.getArray("artboards");
	const yFiles = ydoc.getMap("files");
	const yBrushPresets = ydoc.getMap<Y.Map<unknown>>("brushPresets");

	ydoc.transact(() => {
		// Meta
		yMeta.set("id", "doc-full");
		yMeta.set("name", "Full Test Document");

		// Layer 1 with two elements
		const yLayer1 = new Y.Map<unknown>();
		yLayer1.set("id", "layer-1");
		yLayer1.set("name", "Background");
		yLayer1.set("visible", true);
		yLayer1.set("locked", false);
		yLayer1.set("opacity", 1);
		yLayer1.set("blendMode", "normal");
		const elementIds1 = new Y.Array<string>();
		elementIds1.push(["path-1", "img-1"]);
		yLayer1.set("elementIds", elementIds1);
		yLayers.push([yLayer1]);

		// Layer 2 with one element
		const yLayer2 = new Y.Map<unknown>();
		yLayer2.set("id", "layer-2");
		yLayer2.set("name", "Foreground");
		yLayer2.set("visible", false);
		yLayer2.set("locked", true);
		yLayer2.set("opacity", 0.5);
		yLayer2.set("blendMode", "multiply");
		const elementIds2 = new Y.Array<string>();
		elementIds2.push(["text-1"]);
		yLayer2.set("elementIds", elementIds2);
		yLayers.push([yLayer2]);

		// Objects
		const yPath = new Y.Map<unknown>();
		yPath.set("type", "path");
		yPath.set("id", "path-1");
		yPath.set("opacity", 1);
		yPath.set("blendMode", "normal");
		yPath.set("segments", JSON.stringify([]));
		yPath.set("transform", JSON.stringify(createIdentityTransform()));
		yObjects.set("path-1", yPath);

		const yImg = new Y.Map<unknown>();
		yImg.set("type", "image");
		yImg.set("id", "img-1");
		yImg.set("opacity", 0.9);
		yImg.set("blendMode", "normal");
		yImg.set("fileUid", "file-1");
		yImg.set("x", 10);
		yImg.set("y", 20);
		yImg.set("width", 100);
		yImg.set("height", 200);
		yImg.set("transform", JSON.stringify(createIdentityTransform()));
		yObjects.set("img-1", yImg);

		const yText = new Y.Map<unknown>();
		yText.set("type", "text");
		yText.set("id", "text-1");
		yText.set("opacity", 1);
		yText.set("blendMode", "normal");
		yText.set("x", 50);
		yText.set("y", 60);
		yText.set(
			"content",
			JSON.stringify({ paragraphs: [{ runs: [{ text: "Hi", style: {} }] }] }),
		);
		yText.set(
			"defaultStyle",
			JSON.stringify({
				fontFamily: "Arial",
				fontSource: { type: "local", postScriptName: "ArialMT" },
				fontSize: 16,
				fontWeight: 400,
				fontStyle: "normal",
				fill: { type: "solid", color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 } },
				letterSpacing: 0,
				lineHeight: 1.2,
			}),
		);
		yText.set(
			"layout",
			JSON.stringify({ type: "fixed-width", width: 200, textAlign: "left" }),
		);
		yText.set("transform", JSON.stringify(createIdentityTransform()));
		yObjects.set("text-1", yText);

		// Artboards
		yArtboards.push([
			{
				id: "ab-1",
				name: "Main",
				x: 0,
				y: 0,
				width: 1920,
				height: 1080,
			},
		]);

		// Embedded files
		yFiles.set("file-1", {
			uid: "file-1",
			name: "photo.png",
			type: "image/png",
			hash: "abc123",
			bin: new Uint8Array([1, 2, 3]),
		});

		// Brush presets
		const yPreset = new Y.Map<unknown>();
		yPreset.set("uid", "preset-1");
		yPreset.set("name", "Soft Brush");
		yPreset.set("textureFileUid", "file-1");
		yPreset.set(
			"defaultSettings",
			JSON.stringify({ size: 10, opacity: 0.8, spacing: 0.2 }),
		);
		yBrushPresets.set("preset-1", yPreset);
	});
}

describe("extractDocumentFromYDoc: full document extraction", () => {
	it("extracts meta, layers, objects, artboards, files, and brushPresets", () => {
		const ydoc = new Y.Doc();
		populateFullDocument(ydoc);

		const doc = extractDocumentFromYDoc(ydoc);

		// Meta
		expect(doc.id).toBe("doc-full");

		// Layers
		expect(doc.layers).toHaveLength(2);
		expect(doc.layers[0]).toMatchObject({
			id: "layer-1",
			name: "Background",
			visible: true,
			locked: false,
			opacity: 1,
			blendMode: "normal",
			elementIds: ["path-1", "img-1"],
		});
		expect(doc.layers[1]).toMatchObject({
			id: "layer-2",
			name: "Foreground",
			visible: false,
			locked: true,
			opacity: 0.5,
			blendMode: "multiply",
			elementIds: ["text-1"],
		});

		// Objects
		expect(Object.keys(doc.objects)).toHaveLength(3);
		expect(doc.objects["path-1"].type).toBe("path");
		expect(doc.objects["img-1"].type).toBe("image");
		expect(doc.objects["text-1"].type).toBe("text");

		const img = doc.objects["img-1"] as ImageObject;
		expect(img.fileUid).toBe("file-1");
		expect(img.x).toBe(10);
		expect(img.width).toBe(100);

		// Viewport is always default
		expect(doc.viewport).toEqual({ x: 0, y: 0, zoom: 1, rotation: 0 });

		// Artboards
		expect(doc.artboards).toHaveLength(1);
		expect(doc.artboards[0]).toMatchObject({
			id: "ab-1",
			name: "Main",
			width: 1920,
			height: 1080,
		});

		// Files
		expect(doc.files).toHaveLength(1);
		expect(doc.files[0].uid).toBe("file-1");
		expect(doc.files[0].bin).toBeInstanceOf(Uint8Array);

		// Brush presets: a pre-v2 preset arrives as textureFileUid +
		// defaultSettings and is migrated to v2 on extraction.
		expect(doc.brushPresets).toHaveLength(1);
		expect(doc.brushPresets[0]).toMatchObject({
			uid: "preset-1",
			name: "Soft Brush",
		});
		const presetSettings = doc.brushPresets[0].settings;
		expect(presetSettings.version).toBe(2);
		expect(presetSettings.engine).toBe("dab");
		expect(presetSettings.properties.size?.base).toBe(10);
		expect(presetSettings.properties.spacing?.base).toBe(0.2);
		if (presetSettings.tip?.kind !== "image")
			throw new Error("expected an image tip");
		expect(presetSettings.tip.sources[0]).toEqual({
			kind: "file",
			fileUid: "file-1",
		});

		ydoc.destroy();
	});

	it("returns empty arrays and default meta for an empty Y.Doc", () => {
		const ydoc = new Y.Doc();
		const doc = extractDocumentFromYDoc(ydoc);

		expect(doc.id).toBe("");
		expect(doc.layers).toEqual([]);
		expect(doc.objects).toEqual({});
		expect(doc.artboards).toEqual([]);
		expect(doc.files).toEqual([]);
		expect(doc.brushPresets).toEqual([]);

		ydoc.destroy();
	});

	it("should default to disabled HDR when meta.hdr is missing", () => {
		const ydoc = new Y.Doc();
		ydoc.transact(() => {
			const yMeta = ydoc.getMap("meta");
			yMeta.set("id", "doc-no-hdr");
			yMeta.set("name", "No HDR");
		});

		const doc = extractDocumentFromYDoc(ydoc);
		expect(doc.hdr).toEqual({ enabled: false, exposure: 0 });

		ydoc.destroy();
	});

	it("should parse valid HDR JSON from meta", () => {
		const ydoc = new Y.Doc();
		ydoc.transact(() => {
			const yMeta = ydoc.getMap("meta");
			yMeta.set("id", "doc-hdr");
			yMeta.set("hdr", JSON.stringify({ enabled: true, exposure: 1.5 }));
		});

		const doc = extractDocumentFromYDoc(ydoc);
		expect(doc.hdr).toEqual({ enabled: true, exposure: 1.5 });

		ydoc.destroy();
	});

	it("should fall back to default on invalid HDR JSON", () => {
		const ydoc = new Y.Doc();
		ydoc.transact(() => {
			const yMeta = ydoc.getMap("meta");
			yMeta.set("id", "doc-bad-hdr");
			yMeta.set("hdr", "not valid json{{{");
		});

		const doc = extractDocumentFromYDoc(ydoc);
		expect(doc.hdr).toEqual({ enabled: false, exposure: 0 });

		ydoc.destroy();
	});

	it("should restore color profile settings from meta", () => {
		const ydoc = new Y.Doc();
		ydoc.transact(() => {
			const yMeta = ydoc.getMap("meta");
			yMeta.set("id", "doc-color-profile");
			yMeta.set(
				"colorProfile",
				JSON.stringify({
					workingSpace: "srgb",
					proofProfile: { kind: "builtin", id: "display-p3" },
					proofIntent: "perceptual",
				}),
			);
		});

		const doc = extractDocumentFromYDoc(ydoc);
		expect(doc.colorProfile).toEqual({
			workingSpace: "srgb",
			proofProfile: { kind: "builtin", id: "display-p3" },
			proofIntent: "perceptual",
		});

		ydoc.destroy();
	});

	it("should fall back to undefined on invalid color profile JSON", () => {
		const ydoc = new Y.Doc();
		ydoc.transact(() => {
			const yMeta = ydoc.getMap("meta");
			yMeta.set("id", "doc-bad-color-profile");
			yMeta.set("colorProfile", "not valid json{{{");
		});

		const doc = extractDocumentFromYDoc(ydoc);
		expect(doc.colorProfile).toBeUndefined();

		ydoc.destroy();
	});

	it("should drop an invalid proofIntent while keeping workingSpace", () => {
		const ydoc = new Y.Doc();
		ydoc.transact(() => {
			const yMeta = ydoc.getMap("meta");
			yMeta.set("id", "doc-bad-proof-intent");
			yMeta.set(
				"colorProfile",
				JSON.stringify({
					workingSpace: "srgb",
					proofIntent: "not-a-real-intent",
				}),
			);
		});

		const doc = extractDocumentFromYDoc(ydoc);
		expect(doc.colorProfile).toEqual({ workingSpace: "srgb" });
		expect(doc.colorProfile?.proofIntent).toBeUndefined();

		ydoc.destroy();
	});

	it("should drop a malformed proofProfile while keeping workingSpace", () => {
		const ydoc = new Y.Doc();
		ydoc.transact(() => {
			const yMeta = ydoc.getMap("meta");
			yMeta.set("id", "doc-bad-proof-profile");
			yMeta.set(
				"colorProfile",
				JSON.stringify({
					workingSpace: "display-p3",
					proofProfile: { kind: "builtin", id: "cmyk" },
				}),
			);
		});

		const doc = extractDocumentFromYDoc(ydoc);
		expect(doc.colorProfile).toEqual({ workingSpace: "display-p3" });
		expect(doc.colorProfile?.proofProfile).toBeUndefined();

		ydoc.destroy();
	});

	it("should keep a valid proofIntent and proofProfile", () => {
		const ydoc = new Y.Doc();
		ydoc.transact(() => {
			const yMeta = ydoc.getMap("meta");
			yMeta.set("id", "doc-valid-proof");
			yMeta.set(
				"colorProfile",
				JSON.stringify({
					workingSpace: "srgb",
					proofProfile: { kind: "embedded", fileUid: "file-icc-1" },
					proofIntent: "absolute-colorimetric",
				}),
			);
		});

		const doc = extractDocumentFromYDoc(ydoc);
		expect(doc.colorProfile).toEqual({
			workingSpace: "srgb",
			proofProfile: { kind: "embedded", fileUid: "file-icc-1" },
			proofIntent: "absolute-colorimetric",
		});

		ydoc.destroy();
	});

	it("extracts defs entries from yDefs (round-trip via YjsProvider)", async () => {
		const { YjsProvider } = await import("./YjsProvider");
		const provider = new YjsProvider({
			callbacks: {
				onDocumentUpdate: () => {},
				onLayersUpdate: () => {},
				getCurrentLayerId: () => null,
				setCurrentLayerId: () => {},
			},
		});

		provider.createDef({
			id: "def-1",
			kind: "pattern",
			name: "Stripes",
			rootElementIds: ["p1", "p2"],
			tile: { width: 64, height: 64 },
		});
		provider.createDef({
			id: "def-2",
			kind: "vector-brush",
			rootElementIds: [],
		});

		const doc = extractDocumentFromYDoc(provider.ydoc);
		expect(doc.defs).toEqual({
			"def-1": {
				id: "def-1",
				kind: "pattern",
				name: "Stripes",
				rootElementIds: ["p1", "p2"],
				tile: { width: 64, height: 64 },
			},
			"def-2": {
				id: "def-2",
				kind: "vector-brush",
				rootElementIds: [],
			},
		});

		provider.destroy();
	});

	it("extracts Layer.transientKind and ownerClientId when set", async () => {
		const { YjsProvider } = await import("./YjsProvider");
		const provider = new YjsProvider({
			callbacks: {
				onDocumentUpdate: () => {},
				onLayersUpdate: () => {},
				getCurrentLayerId: () => null,
				setCurrentLayerId: () => {},
			},
		});

		provider.addLayer({
			id: "transient-1",
			name: "pattern-edit-working",
			visible: true,
			locked: false,
			opacity: 1,
			elementIds: [],
			transientKind: TRANSIENT_LAYER_KIND.PATTERN_EDIT,
			ownerClientId: "client-123",
		});

		const doc = extractDocumentFromYDoc(provider.ydoc);
		const layer = doc.layers.find((l) => l.id === "transient-1");
		expect(layer?.transientKind).toBe(TRANSIENT_LAYER_KIND.PATTERN_EDIT);
		expect(layer?.ownerClientId).toBe("client-123");

		provider.destroy();
	});

	it.each(
		Object.values(TRANSIENT_LAYER_KIND),
	)("reads back a %s layer as transient", async (kind) => {
		const { YjsProvider } = await import("./YjsProvider");
		const provider = new YjsProvider({
			callbacks: {
				onDocumentUpdate: () => {},
				onLayersUpdate: () => {},
				getCurrentLayerId: () => null,
				setCurrentLayerId: () => {},
			},
		});

		provider.addLayer({
			id: "transient-1",
			name: "working",
			visible: true,
			locked: false,
			opacity: 1,
			elementIds: [],
			transientKind: kind,
		});

		// A kind that survives the write but not the read comes back as an
		// ordinary layer, and a working layer read as ordinary puts the content
		// it was lending the tools onto the canvas as ordinary objects. Every
		// kind is covered, so adding one cannot reintroduce that.
		const doc = extractDocumentFromYDoc(provider.ydoc);
		expect(doc.layers.find((l) => l.id === "transient-1")?.transientKind).toBe(
			kind,
		);

		provider.destroy();
	});

	it("returns empty defs object for legacy y-docs with no defs map populated", () => {
		const ydoc = new Y.Doc();
		// no yDefs writes — emulate a legacy doc
		const doc = extractDocumentFromYDoc(ydoc);
		expect(doc.defs).toEqual({});
		ydoc.destroy();
	});
});
