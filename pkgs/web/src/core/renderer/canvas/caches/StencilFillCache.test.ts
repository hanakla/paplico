import { describe, expect, it, vi } from "vitest";
import { StencilFillCache } from "./StencilFillCache";

type CacheEntry = Parameters<StencilFillCache["set"]>[3];

describe("StencilFillCache", () => {
	it("should keep normal and mask entries isolated across a normal-mask-normal round trip", () => {
		const cache = new StencilFillCache();
		const normal = makeEntry();
		const mask = makeEntry();
		const nextNormal = makeEntry();

		cache.set("path-1", "normal", "s:1", normal.entry);
		cache.set("path-1", "mask", "s:1", mask.entry);

		expect(cache.get("path-1", "normal", "s:1")).toBe(normal.entry);
		expect(cache.get("path-1", "mask", "s:1")).toBe(mask.entry);

		cache.set("path-1", "normal", "s:1", nextNormal.entry);

		expect(normal.fanRelease).toHaveBeenCalledTimes(1);
		expect(mask.fanRelease).not.toHaveBeenCalled();
		expect(cache.get("path-1", "normal", "s:1")).toBe(nextNormal.entry);
		expect(cache.get("path-1", "mask", "s:1")).toBe(mask.entry);

		cache.delete("path-1");

		expect(nextNormal.fanRelease).toHaveBeenCalledTimes(1);
		expect(mask.fanRelease).toHaveBeenCalledTimes(1);
	});

	it("should keep entries per paint so multi-fill elements don't reuse another paint's fringe", () => {
		const cache = new StencilFillCache();
		const intrinsic = makeEntry();
		const appearance = makeEntry();

		cache.set("glyph-1", "normal", "s:red", intrinsic.entry);
		cache.set("glyph-1", "normal", "s:blue", appearance.entry);

		expect(cache.get("glyph-1", "normal", "s:red")).toBe(intrinsic.entry);
		expect(cache.get("glyph-1", "normal", "s:blue")).toBe(appearance.entry);
		expect(intrinsic.fanRelease).not.toHaveBeenCalled();
		expect(cache.get("glyph-1", "normal", "s:green")).toBeUndefined();
	});

	it("should evict the oldest paint entries past the per-element cap", () => {
		const cache = new StencilFillCache();
		const entries = Array.from({ length: 7 }, () => makeEntry());

		for (const [i, e] of entries.entries()) {
			cache.set("path-1", "normal", `s:${i}`, e.entry);
		}

		expect(entries[0].fanRelease).toHaveBeenCalledTimes(1);
		expect(cache.get("path-1", "normal", "s:0")).toBeUndefined();
		expect(cache.get("path-1", "normal", "s:6")).toBe(entries[6].entry);
	});
});

function makeEntry(): {
	entry: CacheEntry;
	fanRelease: ReturnType<typeof vi.fn>;
} {
	const fanRelease = vi.fn();
	return {
		entry: {
			fanGeometry: {
				byteOffset: 0,
				firstVertex: 0,
				vertexCount: 3,
				write: vi.fn(),
				release: fanRelease,
			},
			fanVertexCount: 3,
			fringeGeometry: null,
			fringeData: new Float32Array(),
			fringeVertexCount: 0,
			bounds: [0, 0, 10, 10],
			isSolidFill: true,
			transformIndex: 0,
			geometryHash: 1,
		},
		fanRelease,
	};
}
