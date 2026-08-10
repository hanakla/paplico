import { proxy, snapshot } from "valtio";
import { describe, expect, it } from "vitest";
import {
	type AnyArtObject,
	type DefEntry,
	type Document,
	type EmbeddedFile,
	type Group,
	IDENTITY_TRANSFORM,
	type ImageObject,
	type Layer,
	type Path,
	type Viewport,
} from "../../schema";
import type { TimelapseData } from "../../timelapse/types";
import { gcDocument } from "./gc";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultViewport: Viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

function makeMinimalDoc(overrides: Partial<Document> = {}): Document {
	return {
		id: "test-doc-id",
		objects: {},
		layers: [],
		viewport: defaultViewport,
		files: [],
		artboards: [],
		brushPresets: [],
		...overrides,
	};
}

function makeLayer(id: string, elementIds: string[]): Layer {
	return {
		id,
		name: id,
		elementIds,
		opacity: 1,
		blendMode: "normal",
		visible: true,
		locked: false,
	};
}

function makePath(id: string, overrides: Partial<Path> = {}): Path {
	return {
		id,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: IDENTITY_TRANSFORM,
		segments: [],
		...overrides,
	};
}

function makeGroup(
	id: string,
	childIds: string[],
	overrides: Partial<Group> = {},
): Group {
	return {
		id,
		type: "group",
		opacity: 1,
		blendMode: "normal",
		transform: IDENTITY_TRANSFORM,
		childIds,
		...overrides,
	};
}

function makeImage(
	id: string,
	fileUid: string,
	overrides: Partial<ImageObject> = {},
): ImageObject {
	return {
		id,
		type: "image",
		opacity: 1,
		blendMode: "normal",
		transform: IDENTITY_TRANSFORM,
		fileUid,
		x: 0,
		y: 0,
		width: 1,
		height: 1,
		...overrides,
	};
}

function makeFile(
	uid: string,
	data: Uint8Array,
	mime = "application/octet-stream",
): EmbeddedFile {
	return {
		uid,
		name: `${uid}.bin`,
		type: mime,
		hash: `sha256-${uid}`,
		bin: data,
	};
}

function makeTimelapse(count: number): TimelapseData {
	return {
		version: 2,
		entries: Array.from({ length: count }, (_, i) => ({
			t: i * 100,
			u: new Uint8Array([i & 0xff, (i >> 8) & 0xff]),
		})),
	};
}

function objectsMap(...objs: AnyArtObject[]): Record<string, AnyArtObject> {
	return Object.fromEntries(objs.map((o) => [o.id, o]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("gcDocument", () => {
	it("removes ArtObjects unreachable from layer/def roots", () => {
		const reachable = makePath("reachable");
		const orphan = makePath("orphan");
		const doc = makeMinimalDoc({
			objects: objectsMap(reachable, orphan),
			layers: [makeLayer("layer-1", ["reachable"])],
		});

		const result = gcDocument(doc);

		expect(result.document.objects).toEqual({ reachable });
		expect(result.deletedObjectIds).toEqual(["orphan"]);
	});

	it("removes embedded files not referenced by any surviving fileUid", () => {
		const usedFile = makeFile("used", new Uint8Array([1]));
		const orphanFile = makeFile("orphan-file", new Uint8Array([2]));
		const image = makeImage("img-1", "used");
		const doc = makeMinimalDoc({
			objects: objectsMap(image),
			layers: [makeLayer("layer-1", ["img-1"])],
			files: [usedFile, orphanFile],
		});

		const result = gcDocument(doc);

		expect(result.document.files).toEqual([usedFile]);
		expect(result.deletedFileUids).toEqual(["orphan-file"]);
	});

	it("keeps objects reachable only via mask.elementIds", () => {
		const maskContent = makePath("mask-content");
		const owner = makePath("owner", {
			mask: { elementIds: ["mask-content"] },
		});
		const doc = makeMinimalDoc({
			objects: objectsMap(owner, maskContent),
			layers: [makeLayer("layer-1", ["owner"])],
		});

		const result = gcDocument(doc);

		expect(Object.keys(result.document.objects).sort()).toEqual([
			"mask-content",
			"owner",
		]);
		expect(result.deletedObjectIds).toEqual([]);
	});

	it("keeps objects reachable only via defs[].rootElementIds", () => {
		const defRoot = makePath("def-root");
		const defEntry: DefEntry = {
			id: "def-1",
			kind: "pattern",
			rootElementIds: ["def-root"],
		};
		const doc = makeMinimalDoc({
			objects: objectsMap(defRoot),
			defs: { "def-1": defEntry },
		});

		const result = gcDocument(doc);

		expect(result.document.objects).toEqual({ "def-root": defRoot });
		expect(result.deletedObjectIds).toEqual([]);
	});

	it("is a no-op when nothing is garbage", () => {
		const path1 = makePath("path-1");
		const group = makeGroup("group-1", ["path-1"]);
		const file = makeFile("file-1", new Uint8Array([1, 2, 3]));
		const image = makeImage("img-1", "file-1");
		const doc = makeMinimalDoc({
			objects: objectsMap(path1, group, image),
			layers: [makeLayer("layer-1", ["group-1", "img-1"])],
			files: [file],
		});

		const result = gcDocument(doc);

		expect(result.deletedObjectIds).toEqual([]);
		expect(result.deletedFileUids).toEqual([]);
		expect(result.document.objects).toEqual(doc.objects);
		expect(result.document.files).toEqual(doc.files);
	});

	it("passes timelapse data through untouched while sweeping garbage", () => {
		const orphan = makePath("orphan");
		const timelapse = makeTimelapse(3);
		const doc = makeMinimalDoc({
			objects: objectsMap(orphan),
			timelapse,
		});

		const result = gcDocument(doc);

		expect(result.deletedObjectIds).toEqual(["orphan"]);
		expect(result.document.timelapse).toBe(timelapse);
	});

	it("handles a Valtio-proxied document via snapshot (matches exportDocument path)", () => {
		const reachable = makePath("reachable");
		const orphan = makePath("orphan");
		const store = proxy({
			document: makeMinimalDoc({
				objects: objectsMap(reachable, orphan),
				layers: [makeLayer("layer-1", ["reachable"])],
			}),
		});

		const doc = snapshot(store).document as Document;
		const result = gcDocument(doc);

		expect(Object.keys(result.document.objects)).toEqual(["reachable"]);
		expect(result.deletedObjectIds).toEqual(["orphan"]);
	});
});
