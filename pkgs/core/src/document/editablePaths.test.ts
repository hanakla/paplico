import { describe, expect, it } from "vitest";
import type { MeshArtObject } from "../schema";
import {
	mockCompoundPath,
	mockDocument,
	mockGroup,
	mockLayer,
	mockPath,
} from "../testUtils/mockElements";
import { collectEditablePaths } from "./editablePaths";

describe("collectEditablePaths", () => {
	describe("without an editing group", () => {
		it("should return every path across all layers", () => {
			const doc = mockDocument(
				[mockPath("p1"), mockPath("p2"), mockPath("p3")],
				[mockLayer("layer-0", ["p1", "p2"]), mockLayer("layer-1", ["p3"])],
			);

			const ids = collectEditablePaths(doc, null).map((r) => r.path.id);

			expect(ids).toEqual(["p1", "p2", "p3"]);
		});

		it("should recurse into groups and collect their descendant paths", () => {
			const doc = mockDocument(
				[
					mockGroup("g1", ["p1", "p2"]),
					mockPath("p1"),
					mockPath("p2"),
					mockPath("p3"),
				],
				[mockLayer("layer-0", ["g1", "p3"])],
			);

			const ids = collectEditablePaths(doc, null).map((r) => r.path.id);

			expect(ids).toEqual(["p1", "p2", "p3"]);
		});

		it("should skip invisible and locked layers", () => {
			const doc = mockDocument(
				[mockPath("visible"), mockPath("hidden"), mockPath("locked")],
				[
					mockLayer("layer-0", ["visible"]),
					mockLayer("layer-1", ["hidden"], { visible: false }),
					mockLayer("layer-2", ["locked"], { locked: true }),
				],
			);

			const ids = collectEditablePaths(doc, null).map((r) => r.path.id);

			expect(ids).toEqual(["visible"]);
		});
	});

	describe("in group edit mode", () => {
		it("should exclude paths outside the editing group", () => {
			const doc = mockDocument(
				[mockGroup("g1", ["inside"]), mockPath("inside"), mockPath("outside")],
				[mockLayer("layer-0", ["g1", "outside"])],
			);

			const ids = collectEditablePaths(doc, "g1").map((r) => r.path.id);

			expect(ids).toEqual(["inside"]);
		});

		it("should recurse into sub-groups within the editing group", () => {
			const doc = mockDocument(
				[
					mockGroup("g1", ["sub", "directChild"]),
					mockGroup("sub", ["nested"]),
					mockPath("directChild"),
					mockPath("nested"),
					mockPath("outside"),
				],
				[mockLayer("layer-0", ["g1", "outside"])],
			);

			const ids = collectEditablePaths(doc, "g1")
				.map((r) => r.path.id)
				.sort();

			expect(ids).toEqual(["directChild", "nested"]);
		});

		it("should include compound-path sources inside the editing group", () => {
			const doc = mockDocument(
				[
					mockGroup("g1", ["cp"]),
					mockCompoundPath("cp", ["src1", "src2"]),
					mockPath("src1"),
					mockPath("src2"),
					mockPath("outside"),
				],
				[mockLayer("layer-0", ["g1", "outside"])],
			);

			const ids = collectEditablePaths(doc, "g1")
				.map((r) => r.path.id)
				.sort();

			expect(ids).toEqual(["src1", "src2"]);
		});

		it("should scope to the deepest group when groups are nested", () => {
			const doc = mockDocument(
				[
					mockGroup("outer", ["inner", "outerPath"]),
					mockGroup("inner", ["innerPath"]),
					mockPath("outerPath"),
					mockPath("innerPath"),
				],
				[mockLayer("layer-0", ["outer"])],
			);

			const ids = collectEditablePaths(doc, "inner").map((r) => r.path.id);

			expect(ids).toEqual(["innerPath"]);
		});
	});

	describe("in a single-element scope", () => {
		it("should return only the scoped path itself", () => {
			const doc = mockDocument(
				[mockPath("scoped"), mockPath("outside")],
				[mockLayer("layer-0", ["scoped", "outside"])],
			);

			const ids = collectEditablePaths(doc, "scoped").map((r) => r.path.id);

			expect(ids).toEqual(["scoped"]);
		});

		it("should carry the ancestor transform of a scoped path inside a group", () => {
			const doc = mockDocument(
				[mockGroup("g1", ["scoped"], { x: 10, y: 20 }), mockPath("scoped")],
				[mockLayer("layer-0", ["g1"])],
			);

			const results = collectEditablePaths(doc, "scoped");

			expect(results).toHaveLength(1);
			expect(results[0].path.id).toBe("scoped");
			expect(results[0].ancestorTransform).toMatchObject({ x: 10, y: 20 });
		});
	});

	describe("mesh warp container scope barrier", () => {
		it("should exclude mesh children until the mesh's own scope is entered", () => {
			const doc = mockDocument(
				[mockMesh("m1", ["inside"]), mockPath("inside"), mockPath("outside")],
				[mockLayer("layer-0", ["m1", "outside"])],
			);

			// Children render warped; their stored (unwarped) vertices stay
			// unreachable without entering the mesh's editing scope.
			expect(collectEditablePaths(doc, null).map((r) => r.path.id)).toEqual([
				"outside",
			]);
			expect(collectEditablePaths(doc, "m1").map((r) => r.path.id)).toEqual([
				"inside",
			]);
		});

		it("should not expose mesh children through an ancestor group's scope", () => {
			const doc = mockDocument(
				[
					mockGroup("g1", ["m1"]),
					mockMesh("m1", ["inside"]),
					mockPath("inside"),
				],
				[mockLayer("layer-0", ["g1"])],
			);

			expect(collectEditablePaths(doc, "g1").map((r) => r.path.id)).toEqual([]);
		});
	});

	describe("ancestor transform composition", () => {
		it("should propagate a non-identity group transform to its child paths", () => {
			const doc = mockDocument(
				[mockGroup("g1", ["p1"], { x: 10, y: 20 }), mockPath("p1")],
				[mockLayer("layer-0", ["g1"])],
			);

			const [result] = collectEditablePaths(doc, null);

			expect(result.path.id).toBe("p1");
			expect(result.ancestorTransform).toMatchObject({ x: 10, y: 20 });
		});

		it("should give a null ancestor transform when the chain is identity", () => {
			const doc = mockDocument(
				[mockGroup("g1", ["p1"]), mockPath("p1")],
				[mockLayer("layer-0", ["g1"])],
			);

			const [result] = collectEditablePaths(doc, null);

			expect(result.ancestorTransform).toBeNull();
		});
	});
});

// --- Test helpers ---

function mockMesh(id: string, childIds: string[]): MeshArtObject {
	return {
		id,
		type: "mesh",
		opacity: 1,
		blendMode: "normal",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		childIds,
		vertices: [
			{ x: 0, y: 0, src: { x: 0, y: 0 }, handles: {} },
			{ x: 100, y: 0, src: { x: 100, y: 0 }, handles: {} },
			{ x: 100, y: 100, src: { x: 100, y: 100 }, handles: {} },
			{ x: 0, y: 100, src: { x: 0, y: 100 }, handles: {} },
		],
		faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
	};
}
