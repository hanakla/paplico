import { describe, expect, it, vi } from "vitest";
import { brandWorldBBox } from "../../../utils/geometry/bounds";
import { FULL_BLIT_UV_RECT } from "../CanvasLayerTypes";
import {
	FilteredElementCache,
	type FilteredElementCacheEntry,
} from "./FilteredElementCache";

describe("FilteredElementCache", () => {
	describe("LRU byte budget", () => {
		it("should evict the least recently used entry when over budget", () => {
			const cache = new FilteredElementCache(100);
			for (const id of ["a", "b", "c", "d"]) cache.set(id, entry(22));

			cache.set("e", entry(22));

			expect(cache.get("a")).toBeUndefined();
			expect(cache.get("b")).toBeDefined();
			expect(cache.get("e")).toBeDefined();
		});

		it("should treat get() as a touch that protects the entry from eviction", () => {
			const cache = new FilteredElementCache(100);
			for (const id of ["a", "b", "c", "d"]) cache.set(id, entry(22));
			cache.get("a");

			cache.set("e", entry(22));

			expect(cache.get("a")).toBeDefined();
			expect(cache.get("b")).toBeUndefined();
		});

		it("should not evict other entries when replacing an element's own entry", () => {
			const cache = new FilteredElementCache(100);
			for (const id of ["a", "b", "c", "d"]) cache.set(id, entry(22));

			cache.set("d", entry(22));

			expect(cache.get("a")).toBeDefined();
			expect(cache.get("b")).toBeDefined();
			expect(cache.get("c")).toBeDefined();
			expect(cache.get("d")).toBeDefined();
		});

		it("should reject an entry that alone exceeds a quarter of the budget", () => {
			const cache = new FilteredElementCache(100);
			const rejected = entry(26);

			const retained = cache.set("big", rejected);

			expect(retained).toBe(false);
			expect(cache.get("big")).toBeUndefined();
			// The rejected texture is still scheduled for deferred destroy.
			cache.flushPendingDestroy();
			expect(rejected.texture.destroy).toHaveBeenCalledTimes(1);
		});
	});

	describe("deferred destroy", () => {
		it("should not destroy an evicted texture before flushPendingDestroy", () => {
			const cache = new FilteredElementCache(100);
			const evicted = entry(22);
			cache.set("a", evicted);
			for (const id of ["b", "c", "d", "e"]) cache.set(id, entry(22));

			expect(evicted.texture.destroy).not.toHaveBeenCalled();

			cache.flushPendingDestroy();
			expect(evicted.texture.destroy).toHaveBeenCalledTimes(1);
		});

		it("should defer the replaced entry's texture when a key is overwritten", () => {
			const cache = new FilteredElementCache(100);
			const old = entry(22);
			cache.set("a", old);

			cache.set("a", entry(22));
			cache.flushPendingDestroy();

			expect(old.texture.destroy).toHaveBeenCalledTimes(1);
		});

		it("should defer every texture on clear", () => {
			const cache = new FilteredElementCache(100);
			const a = entry(22);
			const b = entry(22);
			cache.set("a", a);
			cache.set("b", b);

			cache.clear();
			expect(a.texture.destroy).not.toHaveBeenCalled();
			cache.flushPendingDestroy();

			expect(a.texture.destroy).toHaveBeenCalledTimes(1);
			expect(b.texture.destroy).toHaveBeenCalledTimes(1);
		});
	});

	describe("stale-id pruning interface", () => {
		it("should expose plain element-id keys and delete them via deleteMany", () => {
			const cache = new FilteredElementCache(100);
			cache.set("alive", entry(10));
			cache.set("gone", entry(10));

			expect([...cache.keys()]).toEqual(["alive", "gone"]);
			cache.deleteMany(["gone"]);

			expect(cache.get("gone")).toBeUndefined();
			expect(cache.get("alive")).toBeDefined();
		});
	});
});

function entry(byteSize: number): FilteredElementCacheEntry {
	return {
		hash: "h",
		texture: { destroy: vi.fn() } as unknown as GPUTexture,
		bounds: brandWorldBBox({
			minX: 0,
			minY: 0,
			maxX: 1,
			maxY: 1,
			width: 1,
			height: 1,
		}),
		uvRect: FULL_BLIT_UV_RECT,
		byteSize,
	};
}
