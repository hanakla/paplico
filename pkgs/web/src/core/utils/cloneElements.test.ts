import { describe, expect, it } from "vitest";
import type {
	BlendObject,
	CompoundPath,
	Group,
	MeshArtObject,
	Path,
	Reference3DElement,
	TextElement,
} from "../schema";
import { cloneElementsWithIdRemap } from "./cloneElements";

const IDENTITY_TRANSFORM = {
	x: 0,
	y: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
};

function basePath(id: string, overrides: Partial<Path> = {}): Path {
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

describe("cloneElementsWithIdRemap", () => {
	it("should mint new IDs for every input element", () => {
		const input: Path[] = [basePath("p1"), basePath("p2")];
		const { cloned, idMap } = cloneElementsWithIdRemap(input);
		expect(cloned).toHaveLength(2);
		expect(cloned[0]!.id).not.toBe("p1");
		expect(cloned[1]!.id).not.toBe("p2");
		expect(idMap.get("p1")).toBe(cloned[0]!.id);
		expect(idMap.get("p2")).toBe(cloned[1]!.id);
	});

	it("should remap Group.childIds and Group.clipPathId within the input set", () => {
		const group: Group = {
			id: "g1",
			type: "group",
			opacity: 1,
			blendMode: "normal",
			transform: IDENTITY_TRANSFORM,
			childIds: ["c1", "c2"],
			clipPathId: "c1",
		};
		const c1 = basePath("c1");
		const c2 = basePath("c2");

		const { cloned } = cloneElementsWithIdRemap([group, c1, c2]);
		const clonedGroup = cloned[0] as Group;
		const clonedC1 = cloned[1]!;
		const clonedC2 = cloned[2]!;

		expect(clonedGroup.childIds).toEqual([clonedC1.id, clonedC2.id]);
		expect(clonedGroup.clipPathId).toBe(clonedC1.id);
	});

	it("should remap MeshArtObject.childIds within the input set", () => {
		const mesh: MeshArtObject = {
			id: "m1",
			type: "mesh",
			opacity: 1,
			blendMode: "normal",
			transform: IDENTITY_TRANSFORM,
			childIds: ["c1", "c2"],
			vertices: [
				{ x: 0, y: 0, src: { x: 0, y: 0 }, handles: {} },
				{ x: 100, y: 0, src: { x: 100, y: 0 }, handles: {} },
				{ x: 100, y: 100, src: { x: 100, y: 100 }, handles: {} },
				{ x: 0, y: 100, src: { x: 0, y: 100 }, handles: {} },
			],
			faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
		};
		const c1 = basePath("c1");
		const c2 = basePath("c2");

		const { cloned } = cloneElementsWithIdRemap([mesh, c1, c2]);
		const clonedMesh = cloned[0] as MeshArtObject;
		const clonedC1 = cloned[1]!;
		const clonedC2 = cloned[2]!;

		expect(clonedMesh.childIds).toEqual([clonedC1.id, clonedC2.id]);
		// The cage geometry (incl. src) survives the clone untouched.
		expect(clonedMesh.vertices).toEqual(mesh.vertices);
	});

	it("should remap ArtObject.mask.elementIds within the input set", () => {
		const owner = basePath("owner", {
			mask: { elementIds: ["m1", "m2"], inverted: true },
		});
		const m1 = basePath("m1");
		const m2 = basePath("m2");

		const { cloned } = cloneElementsWithIdRemap([owner, m1, m2]);

		expect(cloned[0]!.mask).toEqual({
			elementIds: [cloned[1]!.id, cloned[2]!.id],
			inverted: true,
		});
	});

	it("should leave the source element's mask untouched when cloning", () => {
		const owner = basePath("owner", { mask: { elementIds: ["m1"] } });
		const m1 = basePath("m1");

		cloneElementsWithIdRemap([owner, m1]);

		expect(owner.mask).toEqual({ elementIds: ["m1"] });
	});

	it("should remap BlendObject.objectIds and spineSourceId", () => {
		const blend: BlendObject = {
			id: "b1",
			type: "blend",
			opacity: 1,
			blendMode: "normal",
			transform: IDENTITY_TRANSFORM,
			objectIds: ["s1", "s2"],
			spacing: { type: "smooth" },
			spineSourceId: "spine",
		};
		const s1 = basePath("s1");
		const s2 = basePath("s2");
		const spine = basePath("spine");

		const { cloned } = cloneElementsWithIdRemap([blend, s1, s2, spine]);
		const clonedBlend = cloned[0] as BlendObject;
		expect(clonedBlend.objectIds).toEqual([cloned[1]!.id, cloned[2]!.id]);
		expect(clonedBlend.spineSourceId).toBe(cloned[3]!.id);
	});

	it("should remap CompoundPath.sources[].id", () => {
		const cp: CompoundPath = {
			id: "cp1",
			type: "compound-path",
			opacity: 1,
			blendMode: "normal",
			transform: IDENTITY_TRANSFORM,
			sources: [
				{ id: "s1", op: "union" },
				{ id: "s2", op: "subtract" },
			],
		};
		const s1 = basePath("s1");
		const s2 = basePath("s2");

		const { cloned } = cloneElementsWithIdRemap([cp, s1, s2]);
		const clonedCp = cloned[0] as CompoundPath;
		expect(clonedCp.sources.map((s) => s.id)).toEqual([
			cloned[1]!.id,
			cloned[2]!.id,
		]);
		// op preserved
		expect(clonedCp.sources[0]!.op).toBe("union");
		expect(clonedCp.sources[1]!.op).toBe("subtract");
	});

	it("should remap TextElement.axisBinding.pathObjectId and clipPathId", () => {
		const text: TextElement = {
			id: "t1",
			type: "text",
			opacity: 1,
			blendMode: "normal",
			transform: IDENTITY_TRANSFORM,
			x: 0,
			y: 0,
			content: { paragraphs: [] },
			defaultStyle: {} as any,
			layout: {} as any,
			axisBinding: {
				mode: "onPath",
				pathObjectId: "bind",
				startOffset: 0,
				alignment: "left",
				offsetDistance: 0,
				orientation: "upright",
			},
			clipPathId: "clip",
		};
		const bind = basePath("bind");
		const clip = basePath("clip");

		const { cloned } = cloneElementsWithIdRemap([text, bind, clip]);
		const clonedText = cloned[0] as TextElement;
		expect(clonedText.axisBinding?.pathObjectId).toBe(cloned[1]!.id);
		expect(clonedText.clipPathId).toBe(cloned[2]!.id);
	});

	it("should remap TextElement.flow.nextTextElementId within the input set", () => {
		const makeText = (id: string, next?: string): TextElement => ({
			id,
			type: "text",
			opacity: 1,
			blendMode: "normal",
			transform: IDENTITY_TRANSFORM,
			x: 0,
			y: 0,
			content: { paragraphs: [] },
			defaultStyle: {} as any,
			layout: {} as any,
			flow: next ? { nextTextElementId: next } : undefined,
		});
		const head = makeText("head", "tail");
		const tail = makeText("tail");

		const { cloned } = cloneElementsWithIdRemap([head, tail]);
		const clonedHead = cloned[0] as TextElement;
		expect(clonedHead.flow?.nextTextElementId).toBe(cloned[1]!.id);
	});

	it("should clear flow when the target is outside the input set", () => {
		const makeText = (id: string, next?: string): TextElement => ({
			id,
			type: "text",
			opacity: 1,
			blendMode: "normal",
			transform: IDENTITY_TRANSFORM,
			x: 0,
			y: 0,
			content: { paragraphs: [] },
			defaultStyle: {} as any,
			layout: {} as any,
			flow: next ? { nextTextElementId: next } : undefined,
		});
		const head = makeText("head", "tail-not-in-set");

		const { cloned } = cloneElementsWithIdRemap([head]);
		// A cloned head must not feed the original tail a second head
		expect((cloned[0] as TextElement).flow).toBeUndefined();
	});

	it("should pass-through references that point outside the input set", () => {
		// childId pointing at an element that is NOT in the input
		const group: Group = {
			id: "g1",
			type: "group",
			opacity: 1,
			blendMode: "normal",
			transform: IDENTITY_TRANSFORM,
			childIds: ["external", "c1"],
			clipPathId: null,
		};
		const c1 = basePath("c1");
		const { cloned, idMap } = cloneElementsWithIdRemap([group, c1]);
		const clonedGroup = cloned[0] as Group;
		// external stays as-is (no remap entry)
		expect(clonedGroup.childIds[0]).toBe("external");
		expect(clonedGroup.childIds[1]).toBe(idMap.get("c1"));
	});

	it("should keep Reference3DElement.sceneId unchanged (duplicate = same shared scene, own camera)", () => {
		// Intent: references3d defs are document-level shared resources. Duplicating
		// a Reference3DElement must reference the SAME scene with an independent
		// camera, so a copied manga panel shows the same room from its own angle.
		const reference3d: Reference3DElement = {
			id: "s1",
			type: "reference3d",
			opacity: 1,
			blendMode: "normal",
			transform: IDENTITY_TRANSFORM,
			sceneId: "scene-room",
			camera: {
				projection: "perspective",
				position: [4, 3, 6],
				target: [0, 1, 0],
				fovDeg: 50,
			},
			x: 0,
			y: 0,
			width: 400,
			height: 300,
			displayMode: "lineart",
		};

		const { cloned } = cloneElementsWithIdRemap([reference3d]);
		const clonedScene = cloned[0] as Reference3DElement;

		expect(clonedScene.id).not.toBe("s1");
		expect(clonedScene.sceneId).toBe("scene-room");
		// Camera is deep-cloned, not aliased — the copy pans independently.
		clonedScene.camera.position[0] = 99;
		expect(reference3d.camera.position[0]).toBe(4);
	});

	it("honors the mintId option", () => {
		const input = [basePath("p1"), basePath("p2")];
		let n = 0;
		const { cloned } = cloneElementsWithIdRemap(input, {
			mintId: () => `custom-${++n}`,
		});
		expect(cloned.map((e) => e.id)).toEqual(["custom-1", "custom-2"]);
	});

	it("deep-clones so source segments are not aliased", () => {
		const seg = {
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			end: { x: 0, y: 0 },
			isMoved: true,
		};
		const p = basePath("p1", { segments: [seg as any] });
		const { cloned } = cloneElementsWithIdRemap([p]);
		const clonedPath = cloned[0] as Path;
		// mutating clone must not affect original
		(clonedPath.segments[0] as any).end.x = 999;
		expect(seg.end.x).toBe(0);
	});
});
