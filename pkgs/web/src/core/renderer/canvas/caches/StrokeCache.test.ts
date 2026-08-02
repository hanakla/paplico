import { describe, expect, it, vi } from "vitest";
import { StrokeCache } from "./StrokeCache";

type CacheEntry = Parameters<StrokeCache["set"]>[2];

describe("StrokeCache", () => {
	it("should keep entries separated by paint so an opacity change does not reuse the previous alpha", () => {
		const cache = new StrokeCache();
		const opaque = makeEntry();
		const halfTransparent = makeEntry();

		cache.set("path-1", "path-1:stroke:s:0,0,0,1.0000", opaque.entry);
		cache.set("path-1", "path-1:stroke:s:0,0,0,0.5000", halfTransparent.entry);

		expect(cache.get("path-1", "path-1:stroke:s:0,0,0,1.0000")).toBe(
			opaque.entry,
		);
		expect(cache.get("path-1", "path-1:stroke:s:0,0,0,0.5000")).toBe(
			halfTransparent.entry,
		);
		expect(opaque.release).not.toHaveBeenCalled();
	});

	it("should release the store lease of an entry it replaces", () => {
		const cache = new StrokeCache();
		const stale = makeEntry();
		const fresh = makeEntry();

		cache.set("path-1", "path-1:stroke:g:1.0000", stale.entry);
		cache.set("path-1", "path-1:stroke:g:1.0000", fresh.entry);

		expect(stale.release).toHaveBeenCalledTimes(1);
		expect(cache.get("path-1", "path-1:stroke:g:1.0000")).toBe(fresh.entry);
	});

	it("should evict the oldest paint entries past the per-element cap", () => {
		const cache = new StrokeCache();
		const entries = Array.from({ length: 7 }, () => makeEntry());

		for (const [i, e] of entries.entries()) {
			cache.set("path-1", `path-1:stroke:s:0,0,0,0.${i}`, e.entry);
		}

		expect(entries[0].release).toHaveBeenCalledTimes(1);
		expect(cache.get("path-1", "path-1:stroke:s:0,0,0,0.0")).toBeUndefined();
		expect(cache.get("path-1", "path-1:stroke:s:0,0,0,0.6")).toBe(
			entries[6].entry,
		);
	});

	it("should release every paint of an element when the element is pruned", () => {
		const cache = new StrokeCache();
		const first = makeEntry();
		const second = makeEntry();
		const other = makeEntry();

		cache.set("path-1", "path-1:stroke:s:a", first.entry);
		cache.set("path-1", "path-1:stroke:s:b", second.entry);
		cache.set("path-2", "path-2:stroke:s:a", other.entry);

		cache.deleteMany(["path-1"]);

		expect(first.release).toHaveBeenCalledTimes(1);
		expect(second.release).toHaveBeenCalledTimes(1);
		expect(other.release).not.toHaveBeenCalled();
		expect([...cache.keys()]).toEqual(["path-2"]);
	});
});

function makeEntry(): {
	entry: CacheEntry;
	release: ReturnType<typeof vi.fn>;
} {
	const release = vi.fn();
	return {
		entry: {
			gpuData: new Float32Array(),
			vertexCount: 3,
			geometryHash: 1,
			strokeColorHash: 2,
			gradientBounds: null,
			geometry: {
				byteOffset: 0,
				firstVertex: 0,
				vertexCount: 3,
				write: vi.fn(),
				release,
			},
			transformIndex: 0,
		},
		release,
	};
}
