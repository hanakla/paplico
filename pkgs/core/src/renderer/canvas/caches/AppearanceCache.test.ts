import { describe, expect, it, type Mock, vi } from "vitest";
import type { Filter } from "../../../schema";
import {
	type FilterProcessorContext,
	FilterRenderer,
	type RegisterableFilterHandler,
} from "../pipeline/FilterRenderer";
import {
	AppearanceCache,
	type AppearanceCacheEntry,
	instanceAppearanceUid,
} from "./AppearanceCache";
import { RenderCacheManager } from "./RenderCacheManager";

type MockEntry = AppearanceCacheEntry & { destroy: Mock };

describe("AppearanceCache", () => {
	it("should return the stored entry for the same elementId and appearanceUid", () => {
		const cache = new AppearanceCache();
		const entry = makeEntry();

		cache.set("el-1", "extrude", entry);

		expect(cache.get("el-1", "extrude")).toBe(entry);
		expect(cache.get("el-1", "other-uid")).toBeUndefined();
		expect(cache.get("el-2", "extrude")).toBeUndefined();
	});

	it("should defer destroying the replaced entry until flushPendingDestroy when overwriting the same key", () => {
		const cache = new AppearanceCache();
		const oldEntry = makeEntry("old");
		const newEntry = makeEntry("new");

		cache.set("el-1", "extrude", oldEntry);
		cache.set("el-1", "extrude", newEntry);

		expect(oldEntry.destroy).not.toHaveBeenCalled();
		expect(cache.get("el-1", "extrude")).toBe(newEntry);

		cache.flushPendingDestroy();

		expect(oldEntry.destroy).toHaveBeenCalledTimes(1);
		expect(newEntry.destroy).not.toHaveBeenCalled();
	});

	it("should destroy a deleted entry only after flushPendingDestroy", () => {
		const cache = new AppearanceCache();
		const entry = makeEntry();
		cache.set("el-1", "extrude", entry);

		cache.delete("el-1::extrude");

		expect(cache.get("el-1", "extrude")).toBeUndefined();
		expect(entry.destroy).not.toHaveBeenCalled();

		cache.flushPendingDestroy();

		expect(entry.destroy).toHaveBeenCalledTimes(1);
	});

	it("should destroy entries removed via deleteMany after flushPendingDestroy", () => {
		const cache = new AppearanceCache();
		const entryA = makeEntry("a");
		const entryB = makeEntry("b");
		cache.set("el-1", "extrude", entryA);
		cache.set("el-2", "extrude", entryB);

		cache.deleteMany(["el-1::extrude", "el-2::extrude"]);

		expect(cache.get("el-1", "extrude")).toBeUndefined();
		expect(cache.get("el-2", "extrude")).toBeUndefined();
		expect(entryA.destroy).not.toHaveBeenCalled();
		expect(entryB.destroy).not.toHaveBeenCalled();

		cache.flushPendingDestroy();

		expect(entryA.destroy).toHaveBeenCalledTimes(1);
		expect(entryB.destroy).toHaveBeenCalledTimes(1);
	});

	it("should destroy all entries, including pending ones, on clear", () => {
		const cache = new AppearanceCache();
		const replacedEntry = makeEntry("replaced");
		const currentEntry = makeEntry("current");
		const otherEntry = makeEntry("other");
		cache.set("el-1", "extrude", replacedEntry);
		cache.set("el-1", "extrude", currentEntry);
		cache.set("el-2", "extrude", otherEntry);

		cache.clear();

		expect(replacedEntry.destroy).toHaveBeenCalledTimes(1);
		expect(currentEntry.destroy).toHaveBeenCalledTimes(1);
		expect(otherEntry.destroy).toHaveBeenCalledTimes(1);
		expect([...cache.keys()]).toEqual([]);
	});

	it("should expose keys in `elementId::appearanceUid` format", () => {
		const cache = new AppearanceCache();
		cache.set("el-1", "fx-a", makeEntry());
		cache.set("el-2", "fx-b", makeEntry());

		expect([...cache.keys()]).toEqual(["el-1::fx-a", "el-2::fx-b"]);
	});

	describe("pruneInstances", () => {
		it("should destroy the entries of instances beyond the live count", () => {
			// A blend that dropped from 3 interpolated instances to 1: nothing ever
			// asks for the high indices again, and element-liveness pruning cannot
			// see them because the blend itself is still there.
			const cache = new AppearanceCache();
			const kept = makeEntry("instance-0");
			const dropped1 = makeEntry("instance-1");
			const dropped2 = makeEntry("instance-2");
			cache.set("blend-1", instanceAppearanceUid("extrude", 0), kept);
			cache.set("blend-1", instanceAppearanceUid("extrude", 1), dropped1);
			cache.set("blend-1", instanceAppearanceUid("extrude", 2), dropped2);

			cache.pruneInstances("blend-1", "extrude", 1);

			expect(cache.get("blend-1", instanceAppearanceUid("extrude", 0))).toBe(
				kept,
			);
			expect(
				cache.get("blend-1", instanceAppearanceUid("extrude", 1)),
			).toBeUndefined();
			expect(
				cache.get("blend-1", instanceAppearanceUid("extrude", 2)),
			).toBeUndefined();

			cache.flushPendingDestroy();

			expect(dropped1.destroy).toHaveBeenCalledTimes(1);
			expect(dropped2.destroy).toHaveBeenCalledTimes(1);
			expect(kept.destroy).not.toHaveBeenCalled();
		});

		it("should walk only the vanished indices, and nothing while the count holds", () => {
			// Producers call this every frame, so a steady blend must cost a
			// lookup — not a scan of the whole cache and not a delete.
			const cache = new AppearanceCache();
			for (let i = 0; i < 3; i++) {
				cache.set("blend-1", instanceAppearanceUid("extrude", i), makeEntry());
			}
			cache.pruneInstances("blend-1", "extrude", 3);

			const deleteSpy = vi.spyOn(cache, "delete");
			cache.pruneInstances("blend-1", "extrude", 3);
			expect(deleteSpy).not.toHaveBeenCalled();

			cache.pruneInstances("blend-1", "extrude", 1);

			expect(deleteSpy.mock.calls.map(([key]) => key)).toEqual([
				`blend-1::${instanceAppearanceUid("extrude", 1)}`,
				`blend-1::${instanceAppearanceUid("extrude", 2)}`,
			]);
		});

		it("should leave the un-suffixed appearance and other elements alone", () => {
			const cache = new AppearanceCache();
			const plain = makeEntry("plain");
			const otherElement = makeEntry("other-element");
			const otherAppearance = makeEntry("other-appearance");
			cache.set("blend-1", "extrude", plain);
			cache.set("blend-2", instanceAppearanceUid("extrude", 4), otherElement);
			cache.set("blend-1", instanceAppearanceUid("shadow", 4), otherAppearance);

			cache.pruneInstances("blend-1", "extrude", 0);
			cache.flushPendingDestroy();

			expect(cache.get("blend-1", "extrude")).toBe(plain);
			expect(cache.get("blend-2", instanceAppearanceUid("extrude", 4))).toBe(
				otherElement,
			);
			expect(cache.get("blend-1", instanceAppearanceUid("shadow", 4))).toBe(
				otherAppearance,
			);
		});
	});
});

describe("FilterProcessorContext.appearanceCache", () => {
	it("should scope get/set to the element bound at the applyFilters call", () => {
		const cache = new AppearanceCache();
		const otherElementEntry = makeEntry("other-element");
		cache.set("el-b", "extrude", otherElementEntry);

		const context = captureFilterContext({ elementId: "el-a", cache });

		// The accessor must not see another element's entry under the same uid.
		expect(context.appearanceCache?.get("extrude")).toBeUndefined();

		const ownEntry = makeEntry("own");
		context.appearanceCache?.set("extrude", ownEntry);

		expect(context.appearanceCache?.get("extrude")).toBe(ownEntry);
		expect(cache.get("el-a", "extrude")).toBe(ownEntry);
		expect(cache.get("el-b", "extrude")).toBe(otherElementEntry);
	});

	it("should omit appearanceCache when no appearance scope is given", () => {
		const context = captureFilterContext(undefined);

		expect(context.appearanceCache).toBeUndefined();
	});
});

describe("RenderCacheManager (appearance wiring)", () => {
	it("should evict appearance entries of removed elements on document change", () => {
		const manager = new RenderCacheManager();
		const liveEntry = makeEntry("live");
		const deadEntry = makeEntry("dead");
		manager.appearance.set("el-live", "extrude", liveEntry);
		manager.appearance.set("el-dead", "extrude", deadEntry);

		manager.onDocumentChange({ "el-live": {} });

		expect(manager.appearance.get("el-live", "extrude")).toBe(liveEntry);
		expect(manager.appearance.get("el-dead", "extrude")).toBeUndefined();
		expect(deadEntry.destroy).not.toHaveBeenCalled();

		manager.appearance.flushPendingDestroy();

		expect(deadEntry.destroy).toHaveBeenCalledTimes(1);
		expect(liveEntry.destroy).not.toHaveBeenCalled();
	});

	it("should destroy all appearance entries on clearAll", () => {
		const manager = new RenderCacheManager();
		const entryA = makeEntry("a");
		const entryB = makeEntry("b");
		manager.appearance.set("el-1", "extrude", entryA);
		manager.appearance.set("el-2", "extrude", entryB);

		manager.clearAll();

		expect(entryA.destroy).toHaveBeenCalledTimes(1);
		expect(entryB.destroy).toHaveBeenCalledTimes(1);
		expect([...manager.appearance.keys()]).toEqual([]);
	});
});

function makeEntry(hash = "hash"): MockEntry {
	return { hash, destroy: vi.fn() };
}

/**
 * Runs applyFilters with a single mock post-filter and returns the context
 * that FilterRenderer assembled for the handler.
 */
function captureFilterContext(
	appearanceScope: { elementId: string; cache: AppearanceCache } | undefined,
): FilterProcessorContext {
	const renderer = new FilterRenderer(createMockDevice());
	let captured: FilterProcessorContext | null = null;
	const handler: RegisterableFilterHandler = {
		initialize: async () => {},
		onScaleFilter: (filter: Filter) => filter,
		getExpansionMargin: () => 0,
		postProcess: (context) => {
			captured = context;
		},
	};
	renderer.registerHandler("blur", handler);

	const filter: Filter = {
		uid: "appearance-test-filter",
		processor: "blur",
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: { radius: 4 } },
	};
	renderer.applyFilters(
		createMockTexture(240, 180, "rgba8unorm"),
		[filter],
		createMockEncoder(),
		undefined,
		1,
		undefined,
		appearanceScope,
	);

	if (!captured) throw new Error("postProcess was not invoked");
	return captured;
}

function createMockTexture(
	width: number,
	height: number,
	format: GPUTextureFormat,
): GPUTexture {
	return {
		width,
		height,
		format,
		createView: vi.fn(() => ({}) as GPUTextureView),
		destroy: vi.fn(),
	} as unknown as GPUTexture;
}

function createMockDevice(): GPUDevice {
	return {
		createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
			const size = descriptor.size as { width: number; height: number };
			return createMockTexture(size.width, size.height, descriptor.format);
		}),
	} as unknown as GPUDevice;
}

function createMockEncoder(): GPUCommandEncoder {
	return {
		copyTextureToTexture: vi.fn(),
	} as unknown as GPUCommandEncoder;
}
