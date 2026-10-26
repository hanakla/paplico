import { describe, expect, it } from "vitest";
import type { AnyArtObject, BlendObject } from "../../../schema";
import { mockGroup, mockPath } from "../../../testUtils/mockElements";
import { brandLocalBBox } from "../../../utils/geometry/primitives/box";
import { ElementHierarchyCache } from "./ElementHierarchyCache";

describe("ElementHierarchyCache", () => {
	describe("invalidateAncestorBounds", () => {
		it("should keep a moved element's local bounds and evict its ancestors'", () => {
			const objects = objectsOf(
				mockGroup("outer", ["g"]),
				mockGroup("g", ["a"]),
				mockPath("a"),
			);
			const hierarchy = cachedHierarchy(objects);

			hierarchy.invalidateAncestorBounds(new Set(["a"]), (id) => objects[id]);

			expect([...hierarchy.localBounds.keys()]).toEqual(["a"]);
		});

		it("should evict a changed blend whose key changed with it", () => {
			const objects = objectsOf(
				{
					...mockPath("bl"),
					type: "blend",
					objectIds: ["k1", "k2"],
				} as unknown as BlendObject,
				mockPath("k1"),
				mockPath("k2"),
			);
			const hierarchy = cachedHierarchy(objects);

			hierarchy.invalidateAncestorBounds(
				new Set(["bl", "k1", "k2"]),
				(id) => objects[id],
			);

			expect(hierarchy.localBounds.has("bl")).toBe(false);
			expect(hierarchy.localBounds.has("k1")).toBe(true);
		});

		it("should evict a group a duplicate joined before the edge exists", () => {
			const before = objectsOf(mockGroup("g", ["a"]), mockPath("a"));
			const hierarchy = cachedHierarchy(before);
			const after = objectsOf(
				mockGroup("g", ["a", "copy"]),
				mockPath("a"),
				mockPath("copy"),
			);

			hierarchy.invalidateAncestorBounds(
				new Set(["g", "copy"]),
				(id) => after[id],
			);

			expect(hierarchy.localBounds.has("g")).toBe(false);
		});
	});
});

// Helpers

function objectsOf(...elements: AnyArtObject[]): Record<string, AnyArtObject> {
	return Object.fromEntries(elements.map((element) => [element.id, element]));
}

/** A hierarchy with known edges and a local bounds entry for every element. */
function cachedHierarchy(
	objects: Record<string, AnyArtObject>,
): ElementHierarchyCache {
	const hierarchy = new ElementHierarchyCache();
	hierarchy.ensureParents(new Map(Object.entries(objects)));
	for (const id of Object.keys(objects)) {
		hierarchy.localBounds.set(
			id,
			brandLocalBBox({
				minX: 0,
				minY: 0,
				maxX: 1,
				maxY: 1,
				width: 1,
				height: 1,
			}),
		);
	}
	return hierarchy;
}
