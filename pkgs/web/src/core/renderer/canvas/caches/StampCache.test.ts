import { describe, expect, it, vi } from "vitest";
import type { StampBuffer } from "../pipeline/brush/StampGenerator";
import type { GeometryHandle } from "../pipeline/GeometryStore";
import { StampCache } from "./StampCache";

describe("StampCache", () => {
	describe("owner reverse index", () => {
		it("should release the same owner's previous fingerprint when a new key is inserted", () => {
			const cache = new StampCache();
			const first = residentEntry(64);
			const second = residentEntry(64);
			cache.set("p1:fpA", first.entry, "p1");

			cache.set("p1:fpB", second.entry, "p1");

			expect(first.stampsRelease).toHaveBeenCalledTimes(1);
			expect(cache.get("p1:fpA")).toBeUndefined();
			expect(cache.get("p1:fpB")).toBe(second.entry);
			expect(second.stampsRelease).not.toHaveBeenCalled();
		});

		it("should keep entries of other owners untouched when a key is inserted", () => {
			const cache = new StampCache();
			const other = residentEntry(64);
			cache.set("p2:fpX", other.entry, "p2");

			cache.set("p1:fpA", residentEntry(64).entry, "p1");
			cache.set("p1:fpB", residentEntry(64).entry, "p1");

			expect(other.stampsRelease).not.toHaveBeenCalled();
			expect(cache.get("p2:fpX")).toBe(other.entry);
		});

		it("should drop the owner mapping when the key is deleted", () => {
			const cache = new StampCache();
			const first = residentEntry(64);
			cache.set("p1:fpA", first.entry, "p1");
			cache.deleteMany(["p1:fpA"]);
			expect(first.stampsRelease).toHaveBeenCalledTimes(1);

			// A later insert for the owner starts from a clean mapping: it must
			// neither re-release the deleted entry nor evict the new one.
			const second = residentEntry(64);
			cache.set("p1:fpB", second.entry, "p1");

			expect(first.stampsRelease).toHaveBeenCalledTimes(1);
			expect(cache.get("p1:fpB")).toBe(second.entry);
			expect(second.stampsRelease).not.toHaveBeenCalled();
		});

		it("should drop every owner mapping on clear", () => {
			const cache = new StampCache();
			const first = residentEntry(64);
			cache.set("p1:fpA", first.entry, "p1");
			cache.clear();
			expect(first.stampsRelease).toHaveBeenCalledTimes(1);

			const second = residentEntry(64);
			cache.set("p1:fpB", second.entry, "p1");

			expect(first.stampsRelease).toHaveBeenCalledTimes(1);
			expect(cache.get("p1:fpB")).toBe(second.entry);
		});

		it("should not evict the entry when the same key is re-set", () => {
			const cache = new StampCache();
			const first = residentEntry(64);
			cache.set("p1:fpA", first.entry, "p1");

			const second = residentEntry(64);
			cache.set("p1:fpA", second.entry, "p1");

			// The old entry under the SAME key releases its leases; the new
			// entry stays resident.
			expect(first.stampsRelease).toHaveBeenCalledTimes(1);
			expect(cache.get("p1:fpA")).toBe(second.entry);
			expect(second.stampsRelease).not.toHaveBeenCalled();
		});
	});

	describe("budget accounting", () => {
		it("should count a resident entry's shared CPU array once against the budget", () => {
			const cache = new StampCache(100);
			// data (60 bytes) IS the store's regrow mirror; byteSize already
			// covers it. Double-counting (60 + 60 > 100) would self-evict.
			const { entry } = residentEntry(60);

			cache.set("p1:fpA", entry, "p1");

			expect(cache.get("p1:fpA")).toBe(entry);
		});

		it("should still evict when the single-counted total exceeds the budget", () => {
			const cache = new StampCache(100);
			const oldest = residentEntry(60);
			cache.set("p1:fpA", oldest.entry, "p1");

			cache.set("p2:fpB", residentEntry(60).entry, "p2");

			expect(oldest.stampsRelease).toHaveBeenCalledTimes(1);
			expect(cache.get("p1:fpA")).toBeUndefined();
		});

		it("should budget a non-resident entry by its data bytes", () => {
			const cache = new StampCache(100);
			const entry = plainEntry(120);

			cache.set("p1:fpA", entry, "p1");

			expect(cache.get("p1:fpA")).toBeUndefined();
		});
	});

	describe("set() retention contract", () => {
		it("should return true when the inserted entry stays within the budget", () => {
			const cache = new StampCache(100);

			expect(cache.set("p1:fpA", plainEntry(60), "p1")).toBe(true);
			expect(cache.get("p1:fpA")).toBeDefined();
		});

		it("should return false when the inserted entry alone exceeds the budget and self-evicts", () => {
			const cache = new StampCache(100);

			// The caller must NOT resident-ize a non-retained entry: no cache
			// entry would own (and eventually release) the store leases.
			expect(cache.set("p1:fpA", plainEntry(120), "p1")).toBe(false);
			expect(cache.get("p1:fpA")).toBeUndefined();
		});
	});

	describe("commitResident re-accounting", () => {
		it("should release the lease when commitResident evicts the just-resident-ized entry itself", () => {
			const cache = new StampCache(100);
			const entry = plainEntry(60);
			expect(cache.set("p1:fpA", entry, "p1")).toBe(true);

			// Residency attached lazily, with accounting above the budget —
			// the eviction must run through the lease-releasing delete path.
			const stampsRelease = vi.fn();
			entry.resident = {
				stamps: { firstStamp: 0, stampCount: 1, release: stampsRelease },
				meta: fakeGeometryHandle(),
				stops: null,
				metaSnapshot: new Float32Array(16),
				stopsSnapshot: null,
				syncedFrame: 0,
				byteSize: 120,
			};
			cache.commitResident("p1:fpA");

			expect(stampsRelease).toHaveBeenCalledTimes(1);
			expect(entry.resident).toBeUndefined();
			expect(cache.get("p1:fpA")).toBeUndefined();
		});
	});
});

// Helpers

function plainEntry(dataBytes: number): StampBuffer {
	return { data: new Float32Array(dataBytes / 4), count: 1 };
}

/** A resident entry whose `data` plays the store-shared mirror: byteSize
 *  covers it, mirroring StrokeBatchContext's single-ownership accounting. */
function residentEntry(dataBytes: number) {
	const stampsRelease = vi.fn();
	const data = new Float32Array(dataBytes / 4);
	const entry: StampBuffer = {
		data,
		count: 1,
		resident: {
			stamps: { firstStamp: 0, stampCount: 1, release: stampsRelease },
			meta: fakeGeometryHandle(),
			stops: null,
			metaSnapshot: new Float32Array(16),
			stopsSnapshot: null,
			syncedFrame: 0,
			byteSize: dataBytes,
		},
	};
	return { entry, stampsRelease };
}

function fakeGeometryHandle(): GeometryHandle {
	return {
		byteOffset: 0,
		firstVertex: 0,
		vertexCount: 1,
		write() {},
		release() {},
	};
}
