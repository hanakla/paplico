import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createIdentityTransform } from "../document/factory";
import type { Artboard, Document, Path } from "../schema";
import {
	changedObjectsIntersectArtboard,
	extractChangedObjectIds,
} from "./artboardFilter";

describe("artboardFilter", () => {
	describe("extractChangedObjectIds", () => {
		it("should detect newly added objects", () => {
			const doc = new Y.Doc();
			const yObjects = doc.getMap("objects");

			const path: Path = {
				id: "path-1",
				type: "path",
				segments: [],
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			};

			yObjects.set("path-1", path);

			const update = Y.encodeStateAsUpdate(doc);
			const beforeDoc = new Y.Doc();

			const changedIds = extractChangedObjectIds(update, beforeDoc);

			expect(changedIds).toContain("path-1");
			doc.destroy();
			beforeDoc.destroy();
		});

		it("should detect modified objects", () => {
			const beforeDoc = new Y.Doc();
			const yObjects = beforeDoc.getMap("objects");

			const path1: Path = {
				id: "path-1",
				type: "path",
				segments: [],
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			};

			yObjects.set("path-1", path1);

			const afterDoc = new Y.Doc();
			Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(beforeDoc));

			const yObjectsAfter = afterDoc.getMap("objects");
			yObjectsAfter.set("path-1", { ...path1, opacity: 0.5 });

			const update = Y.encodeStateAsUpdate(afterDoc);
			Y.applyUpdate(beforeDoc, update);

			const changedIds = extractChangedObjectIds(update, beforeDoc);

			expect(changedIds).toContain("path-1");

			beforeDoc.destroy();
			afterDoc.destroy();
		});
	});

	describe("changedObjectsIntersectArtboard", () => {
		it("should return true when object is inside artboard", () => {
			const artboard: Artboard = {
				id: "artboard-1",
				name: "Artboard 1",
				x: 0,
				y: 0,
				width: 1000,
				height: 800,
			};

			const path: Path = {
				id: "path-1",
				type: "path",
				segments: [
					{
						start: { x: 100, y: 100 },
						cp1: { x: 150, y: 100 },
						cp2: { x: 150, y: 200 },
						end: { x: 200, y: 200 },
						startTiltX: 0,
						startTiltY: 0,
						endTiltX: 0,
						endTiltY: 0,
						startDeltaTime: 0,
						endDeltaTime: 0,
						isMoved: false,
					},
				],
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			};

			const document: Document = {
				id: "test-doc",
				objects: {
					"path-1": path,
				},
				layers: [],
				artboards: [artboard],
				files: [],
				viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
				brushPresets: [],
			};

			const result = changedObjectsIntersectArtboard(
				["path-1"],
				document,
				artboard,
			);

			expect(result).toBe(true);
		});

		it("should return false when object is outside artboard", () => {
			const artboard: Artboard = {
				id: "artboard-1",
				name: "Artboard 1",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
			};

			const path: Path = {
				id: "path-1",
				type: "path",
				segments: [
					{
						start: { x: 1000, y: 1000 },
						cp1: { x: 1050, y: 1000 },
						cp2: { x: 1050, y: 1100 },
						end: { x: 1100, y: 1100 },
						startTiltX: 0,
						startTiltY: 0,
						endTiltX: 0,
						endTiltY: 0,
						startDeltaTime: 0,
						endDeltaTime: 0,
						isMoved: false,
					},
				],
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			};

			const document: Document = {
				id: "test-doc",
				objects: {
					"path-1": path,
				},
				layers: [],
				artboards: [artboard],
				files: [],
				viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
				brushPresets: [],
			};

			const result = changedObjectsIntersectArtboard(
				["path-1"],
				document,
				artboard,
			);

			expect(result).toBe(false);
		});

		it("should return true when object partially intersects artboard", () => {
			const artboard: Artboard = {
				id: "artboard-1",
				name: "Artboard 1",
				x: 0,
				y: 0,
				width: 200,
				height: 200,
			};

			const path: Path = {
				id: "path-1",
				type: "path",
				segments: [
					{
						start: { x: 50, y: 50 },
						cp1: { x: 150, y: 50 },
						cp2: { x: 150, y: 150 },
						end: { x: 250, y: 250 },
						startTiltX: 0,
						startTiltY: 0,
						endTiltX: 0,
						endTiltY: 0,
						startDeltaTime: 0,
						endDeltaTime: 0,
						isMoved: false,
					},
				],
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			};

			const document: Document = {
				id: "test-doc",
				objects: {
					"path-1": path,
				},
				layers: [],
				artboards: [artboard],
				files: [],
				viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
				brushPresets: [],
			};

			const result = changedObjectsIntersectArtboard(
				["path-1"],
				document,
				artboard,
			);

			expect(result).toBe(true);
		});

		it("should return false when object does not exist", () => {
			const artboard: Artboard = {
				id: "artboard-1",
				name: "Artboard 1",
				x: 0,
				y: 0,
				width: 200,
				height: 200,
			};

			const document: Document = {
				id: "test-doc",
				objects: {},
				layers: [],
				artboards: [artboard],
				files: [],
				viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
				brushPresets: [],
			};

			const result = changedObjectsIntersectArtboard(
				["nonexistent"],
				document,
				artboard,
			);

			expect(result).toBe(false);
		});

		it("should return false when no changed IDs provided", () => {
			const artboard: Artboard = {
				id: "artboard-1",
				name: "Artboard 1",
				x: 0,
				y: 0,
				width: 200,
				height: 200,
			};

			const document: Document = {
				id: "test-doc",
				objects: {},
				layers: [],
				artboards: [artboard],
				files: [],
				viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
				brushPresets: [],
			};

			const result = changedObjectsIntersectArtboard([], document, artboard);

			expect(result).toBe(false);
		});
	});
});
