import { describe, expect, it, type Mock, vi } from "vitest";
import type { StampBuffer } from "../pipeline/brush/StampGenerator";
import type { AppearanceCacheEntry } from "./AppearanceCache";
import { RenderCacheManager } from "./RenderCacheManager";

type MockEntry = AppearanceCacheEntry & { destroy: Mock };

describe("RenderCacheManager", () => {
	describe("document scoping", () => {
		it("should keep the main document's entries when another document full-renders", () => {
			// Regression: the brush preview renders a throwaway document with
			// strategy "full" through the shared manager; its onDocumentChange
			// used to prune every main-document entry as "not live".
			const manager = new RenderCacheManager();
			manager.setActiveDocument("main-doc");
			manager.stamp.set("el1:fp:1.0:hash", makeStampBuffer());
			manager.appearance.set("el1", "extrude", makeAppearanceEntry());

			manager.setActiveDocument("brush-preview-document");
			manager.onDocumentChange({ "brush-preview-path": {} });

			manager.setActiveDocument("main-doc");
			expect(manager.stamp.get("el1:fp:1.0:hash")).toBeDefined();
			expect(manager.appearance.get("el1", "extrude")).toBeDefined();
		});

		it("should isolate entries between document scopes", () => {
			const manager = new RenderCacheManager();
			manager.setActiveDocument("doc-a");
			manager.stamp.set("el1:fp:1.0:hash", makeStampBuffer());

			manager.setActiveDocument("doc-b");

			expect(manager.stamp.get("el1:fp:1.0:hash")).toBeUndefined();
		});

		it("should destroy a dropped document's GPU resources and stay usable", () => {
			const manager = new RenderCacheManager();
			manager.setActiveDocument("doc-a");
			const entry = makeAppearanceEntry();
			manager.appearance.set("el1", "extrude", entry);

			manager.dropDocument("doc-a");

			expect(entry.destroy).toHaveBeenCalledTimes(1);
			// The active scope was recreated empty — the manager keeps working.
			expect(manager.appearance.get("el1", "extrude")).toBeUndefined();
			manager.appearance.set("el2", "extrude", makeAppearanceEntry());
			expect(manager.appearance.get("el2", "extrude")).toBeDefined();
		});

		it("should evict the least-recently-activated scope past the budget", () => {
			const manager = new RenderCacheManager();
			manager.setActiveDocument("doc-a");
			const entry = makeAppearanceEntry();
			manager.appearance.set("el1", "extrude", entry);

			// Default scope + doc-a..doc-e exceeds MAX_SCOPES (4); doc-a is the
			// oldest non-active scope after the default one gets evicted first.
			manager.setActiveDocument("doc-b");
			manager.setActiveDocument("doc-c");
			manager.setActiveDocument("doc-d");
			manager.setActiveDocument("doc-e");

			expect(entry.destroy).toHaveBeenCalledTimes(1);
			manager.setActiveDocument("doc-a");
			expect(manager.appearance.get("el1", "extrude")).toBeUndefined();
		});

		it("should flush deferred destroys of deactivated scopes too", () => {
			const manager = new RenderCacheManager();
			manager.setActiveDocument("doc-a");
			const evicted = makeAppearanceEntry();
			manager.appearance.set("el1", "extrude", evicted);
			// Overwrite defers the old entry's destroy inside doc-a's scope…
			manager.appearance.set("el1", "extrude", makeAppearanceEntry());

			// …and the flush must reach it even after another document activates.
			manager.setActiveDocument("doc-b");
			manager.flushPendingDestroy();

			expect(evicted.destroy).toHaveBeenCalledTimes(1);
		});
	});

	describe("onDocumentChange", () => {
		it("should keep stamp entries for live elements across full renders", () => {
			// Regression: stamp keys are single-colon composites
			// ("<id>:<scatterFp>:<aspect>:<hash>"). Judging them with the "::"
			// baseId split returned the whole key, never matched a live id, and
			// wiped the entire stamp cache on every full render.
			const manager = new RenderCacheManager();
			const key = "el1:scatterFp:1.0:abc123";
			manager.stamp.set(key, makeStampBuffer());

			manager.onDocumentChange({ el1: {} });

			expect(manager.stamp.get(key)).toBeDefined();
		});

		it("should prune stamp entries whose element is gone", () => {
			const manager = new RenderCacheManager();
			const key = "el1:scatterFp:1.0:abc123";
			manager.stamp.set(key, makeStampBuffer());

			manager.onDocumentChange({ other: {} });

			expect(manager.stamp.get(key)).toBeUndefined();
		});

		it("should keep blend-intermediate stamp entries alive via their blend id", () => {
			// A blend intermediate's path id is "<blendId>::sX_Y"; the first ":"
			// lands inside that "::", so the liveness id resolves to the blend id.
			const manager = new RenderCacheManager();
			const key = "blend1::s0_1:scatterFp:1.0:abc123";
			manager.stamp.set(key, makeStampBuffer());

			manager.onDocumentChange({ blend1: {} });

			expect(manager.stamp.get(key)).toBeDefined();
		});
	});

	describe("resident stamp ownership", () => {
		it("should release the old fingerprint for the same path", () => {
			const manager = new RenderCacheManager();
			const oldEntry = makeResidentStampBuffer(4, 4);
			manager.stamp.set("el1:old", oldEntry.entry, "el1");

			manager.stamp.set("el1:new", makeStampBuffer(), "el1");

			expect(manager.stamp.get("el1:old")).toBeUndefined();
			expect(oldEntry.releases.stamps).toHaveBeenCalledTimes(1);
			expect(oldEntry.releases.meta).toHaveBeenCalledTimes(1);
			expect(oldEntry.releases.stops).toHaveBeenCalledTimes(1);
		});

		it("should evict the least-recently-used entry over the document byte budget", () => {
			// A resident entry costs resident.byteSize alone — its `data` is the
			// store-shared mirror already counted there.
			const manager = new RenderCacheManager({ stampCacheMaxBytes: 16 });
			const a = makeResidentStampBuffer(1, 8);
			const b = makeResidentStampBuffer(1, 8);
			const c = makeResidentStampBuffer(1, 8);
			manager.stamp.set("a:fp", a.entry, "a");
			manager.stamp.set("b:fp", b.entry, "b");
			manager.stamp.get("a:fp");

			manager.stamp.set("c:fp", c.entry, "c");

			expect(manager.stamp.get("a:fp")).toBeDefined();
			expect(manager.stamp.get("b:fp")).toBeUndefined();
			expect(manager.stamp.get("c:fp")).toBeDefined();
			expect(b.releases.stamps).toHaveBeenCalledTimes(1);
			expect(b.releases.meta).toHaveBeenCalledTimes(1);
			expect(b.releases.stops).toHaveBeenCalledTimes(1);
		});
	});
});

// Helpers

function makeStampBuffer(): StampBuffer {
	return { data: new Float32Array(0), count: 0 };
}

function makeResidentStampBuffer(dataFloats: number, residentBytes: number) {
	const releases = {
		stamps: vi.fn(),
		meta: vi.fn(),
		stops: vi.fn(),
	};
	const entry = {
		data: new Float32Array(dataFloats),
		count: dataFloats,
		resident: {
			stamps: { release: releases.stamps },
			meta: { release: releases.meta },
			stops: { release: releases.stops },
			metaSnapshot: new Float32Array(0),
			stopsSnapshot: null,
			syncedFrame: 0,
			byteSize: residentBytes,
		},
	} as unknown as StampBuffer;
	return { entry, releases };
}

function makeAppearanceEntry(): MockEntry {
	return { hash: "hash", destroy: vi.fn() };
}
