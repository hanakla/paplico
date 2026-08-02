import { describe, expect, it, vi } from "vitest";
import { brandWorldBBox } from "../../../utils/geometry/bounds";
import { FULL_BLIT_UV_RECT } from "../CanvasLayerTypes";
import {
	FilteredElementCache,
	type FilteredElementCacheEntry,
} from "./FilteredElementCache";

describe("FilteredElementCache", () => {
	describe("LRU byte budget", () => {
		it("should evict the least recently used entry of a previous frame when over budget", () => {
			const cache = new FilteredElementCache(100);
			for (const id of ["a", "b", "c", "d"]) cache.set(id, entry(22));
			cache.beginFrame();

			cache.set("e", entry(22));

			expect(cache.get("a")).toBeUndefined();
			expect(cache.get("b")).toBeDefined();
			expect(cache.get("e")).toBeDefined();
		});

		it("should treat get() as a touch that protects the entry from eviction", () => {
			const cache = new FilteredElementCache(100);
			for (const id of ["a", "b", "c", "d"]) cache.set(id, entry(22));
			cache.beginFrame();
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
			cache.beginFrame();
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

	describe("frame pinning", () => {
		it("should not evict an entry the current frame already used", () => {
			const cache = new FilteredElementCache(100);
			for (const id of ["a", "b", "c", "d"]) cache.set(id, entry(22));
			cache.beginFrame();
			cache.get("a");

			// Storing more than the budget in one frame must not evict this
			// frame's own hits — only unpinned (older) entries.
			cache.set("e", entry(22));
			cache.set("f", entry(22));

			expect(cache.get("a")).toBeDefined();
			expect(cache.get("e")).toBeDefined();
			expect(cache.get("f")).toBeDefined();
		});

		it("should allow a transient overshoot when every entry is pinned", () => {
			const cache = new FilteredElementCache(50);
			cache.set("a", entry(12));
			cache.set("b", entry(12));
			cache.set("c", entry(12));
			cache.set("d", entry(12));

			cache.set("e", entry(12));

			for (const id of ["a", "b", "c", "d", "e"]) {
				expect(cache.get(id)).toBeDefined();
			}
		});

		it("should make previous-frame entries evictable again after beginFrame", () => {
			const cache = new FilteredElementCache(50);
			cache.set("a", entry(12));
			cache.set("b", entry(12));
			cache.set("c", entry(12));
			cache.set("d", entry(12));
			cache.beginFrame();

			cache.set("e", entry(12));

			expect(cache.get("a")).toBeUndefined();
			expect(cache.get("e")).toBeDefined();
		});
	});

	describe("evictChanged", () => {
		it("should evict an entry relocated by an edited ancestor container", () => {
			const cache = new FilteredElementCache(100);
			cache.set("child", entry(10, ["child"]));

			// The moved group's render closure includes its descendants.
			cache.evictChanged(new Set(["group"]), new Set(["group", "child"]));

			expect(cache.get("child")).toBeUndefined();
		});

		it("should evict a container entry whose dependency was edited", () => {
			const cache = new FilteredElementCache(100);
			cache.set("blend", entry(10, ["blend", "source-1"]));

			// A blend source edit reports only the source id; the closure of a
			// non-container leaf is itself.
			cache.evictChanged(new Set(["source-1"]), new Set(["source-1"]));

			expect(cache.get("blend")).toBeUndefined();
		});

		it("should keep entries unrelated to the change set", () => {
			const cache = new FilteredElementCache(100);
			cache.set("bystander", entry(10, ["bystander"]));

			cache.evictChanged(new Set(["other"]), new Set(["other", "other-child"]));

			expect(cache.get("bystander")).toBeDefined();
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

function entry(
	byteSize: number,
	dependencyIds: readonly string[] = [],
): FilteredElementCacheEntry {
	return {
		hash: "h",
		dependencyIds: new Set(dependencyIds),
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
