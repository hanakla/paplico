import { beforeEach, describe, expect, it } from "vitest";
import { type BoundingBox, Quadtree, type QuadtreeItem } from "./Quadtree";

describe("Quadtree", () => {
	let quadtree: Quadtree<string>;
	const worldBounds: BoundingBox = {
		minX: -1000,
		minY: -1000,
		maxX: 1000,
		maxY: 1000,
	};

	beforeEach(() => {
		quadtree = new Quadtree(worldBounds, 4, 8);
	});

	const createItem = (
		id: string,
		minX: number,
		minY: number,
		maxX: number,
		maxY: number,
		data = "test",
	): QuadtreeItem<string> => ({
		id,
		bounds: {
			minX,
			minY,
			maxX,
			maxY,
		},
		data,
	});

	describe("insert and query", () => {
		it("should insert and retrieve a single item", () => {
			const item = createItem("1", 0, 0, 100, 100);
			quadtree.insert(item);

			const results = quadtree.query({
				minX: 0,
				minY: 0,
				maxX: 100,
				maxY: 100,
			});

			expect(results).toHaveLength(1);
			expect(results[0].id).toBe("1");
		});

		it("should retrieve multiple overlapping items", () => {
			quadtree.insert(createItem("1", 0, 0, 100, 100));
			quadtree.insert(createItem("2", 50, 50, 150, 150));
			quadtree.insert(createItem("3", 25, 25, 75, 75));

			const results = quadtree.query({
				minX: 0,
				minY: 0,
				maxX: 100,
				maxY: 100,
			});

			expect(results.length).toBeGreaterThanOrEqual(2);
		});

		it("should not retrieve items outside query bounds", () => {
			quadtree.insert(createItem("1", 0, 0, 100, 100));
			quadtree.insert(createItem("2", 500, 500, 600, 600));

			const results = quadtree.query({
				minX: 0,
				minY: 0,
				maxX: 100,
				maxY: 100,
			});

			expect(results).toHaveLength(1);
			expect(results[0].id).toBe("1");
		});

		it("should handle large numbers of items", () => {
			// Insert 100 items
			for (let i = 0; i < 100; i++) {
				const x = (i % 10) * 100 - 500;
				const y = Math.floor(i / 10) * 100 - 500;
				quadtree.insert(createItem(`item-${i}`, x, y, x + 50, y + 50));
			}

			expect(quadtree.size()).toBe(100);

			// Query should only return items in the specified area
			const results = quadtree.query({
				minX: 0,
				minY: 0,
				maxX: 200,
				maxY: 200,
			});

			expect(results.length).toBeLessThan(100);
			expect(results.length).toBeGreaterThan(0);
		});
	});

	describe("find", () => {
		it("should find an item by ID", () => {
			quadtree.insert(createItem("1", 0, 0, 100, 100));
			quadtree.insert(createItem("2", 200, 200, 300, 300));

			const found = quadtree.find("2");
			expect(found).not.toBeNull();
			expect(found?.id).toBe("2");
		});

		it("should return null for non-existent ID", () => {
			quadtree.insert(createItem("1", 0, 0, 100, 100));

			const found = quadtree.find("999");
			expect(found).toBeNull();
		});
	});

	describe("remove", () => {
		it("should remove an item by ID", () => {
			quadtree.insert(createItem("1", 0, 0, 100, 100));
			quadtree.insert(createItem("2", 200, 200, 300, 300));

			expect(quadtree.size()).toBe(2);

			const removed = quadtree.remove("1");
			expect(removed).toBe(true);
			expect(quadtree.size()).toBe(1);

			const found = quadtree.find("1");
			expect(found).toBeNull();
		});

		it("should return false when removing non-existent item", () => {
			quadtree.insert(createItem("1", 0, 0, 100, 100));

			const removed = quadtree.remove("999");
			expect(removed).toBe(false);
			expect(quadtree.size()).toBe(1);
		});
	});

	describe("clear", () => {
		it("should remove all items", () => {
			quadtree.insert(createItem("1", 0, 0, 100, 100));
			quadtree.insert(createItem("2", 200, 200, 300, 300));
			quadtree.insert(createItem("3", -100, -100, 0, 0));

			expect(quadtree.size()).toBe(3);

			quadtree.clear();

			expect(quadtree.size()).toBe(0);
			expect(quadtree.getAll()).toHaveLength(0);
		});
	});

	describe("getAll", () => {
		it("should return all items", () => {
			quadtree.insert(createItem("1", 0, 0, 100, 100));
			quadtree.insert(createItem("2", 200, 200, 300, 300));
			quadtree.insert(createItem("3", -100, -100, 0, 0));

			const all = quadtree.getAll();
			expect(all).toHaveLength(3);
			expect(all.map((item) => item.id).sort()).toEqual(["1", "2", "3"]);
		});
	});

	describe("edge cases", () => {
		it("should handle items at world bounds", () => {
			quadtree.insert(createItem("1", -1000, -1000, -900, -900));
			quadtree.insert(createItem("2", 900, 900, 1000, 1000));

			expect(quadtree.size()).toBe(2);

			const found1 = quadtree.find("1");
			const found2 = quadtree.find("2");

			expect(found1).not.toBeNull();
			expect(found2).not.toBeNull();
		});

		it("should handle items spanning multiple quadrants", () => {
			// Large item spanning center
			quadtree.insert(createItem("big", -500, -500, 500, 500));

			// Small items in different quadrants
			quadtree.insert(createItem("nw", -200, 200, -100, 300));
			quadtree.insert(createItem("ne", 100, 200, 200, 300));
			quadtree.insert(createItem("sw", -200, -300, -100, -200));
			quadtree.insert(createItem("se", 100, -300, 200, -200));

			expect(quadtree.size()).toBe(5);

			// Query each quadrant
			const nwResults = quadtree.query({
				minX: -500,
				minY: 0,
				maxX: 0,
				maxY: 500,
			});
			expect(nwResults.length).toBeGreaterThan(0);
		});
	});
});
