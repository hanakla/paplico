import { describe, expect, it } from "vitest";
import { DefRasterizer } from "./DefRasterizer";

describe("DefRasterizer", () => {
	describe("textureUidFor", () => {
		it("formats stable cache keys", () => {
			expect(DefRasterizer.textureUidFor("d1", 3, 128, 64)).toBe(
				"def:d1:3:128x64",
			);
		});

		it("differs across revisions so consumer caches self-invalidate", () => {
			const a = DefRasterizer.textureUidFor("d1", 1, 128, 128);
			const b = DefRasterizer.textureUidFor("d1", 2, 128, 128);
			expect(a).not.toBe(b);
		});
	});

	describe("resolveTargetSize / scatter band", () => {
		it("quantizes to powers of two clamped 64..1024 on the long edge", () => {
			const small = DefRasterizer.resolveTargetSize({
				kind: "scatter",
				worldSize: { width: 10, height: 10 },
				zoom: 1,
			});
			// 10 * 2 = 20 → pow2Ceil = 32 → clamped to 64
			expect(small.width).toBe(64);
			expect(small.height).toBe(64);

			const huge = DefRasterizer.resolveTargetSize({
				kind: "scatter",
				worldSize: { width: 4000, height: 4000 },
				zoom: 1,
			});
			expect(huge.width).toBe(1024);
			expect(huge.height).toBe(1024);
		});

		it("preserves aspect ratio at banded resolution (wide source)", () => {
			const wide = DefRasterizer.resolveTargetSize({
				kind: "scatter",
				worldSize: { width: 200, height: 50 },
				zoom: 1,
			});
			expect(wide.width).toBeGreaterThanOrEqual(wide.height);
			// width 200 * 2 = 400 → pow2 512, clamped 64..1024 → 512
			expect(wide.width).toBe(512);
			expect(wide.height).toBe(128); // 512 / 4
		});

		it("preserves aspect ratio at banded resolution (tall source)", () => {
			const tall = DefRasterizer.resolveTargetSize({
				kind: "scatter",
				worldSize: { width: 50, height: 200 },
				zoom: 1,
			});
			expect(tall.height).toBeGreaterThanOrEqual(tall.width);
			expect(tall.height).toBe(512);
			expect(tall.width).toBe(128);
		});
	});

	describe("resolveTargetSize / pattern band", () => {
		it("quantizes to pow2 clamped 64..2048", () => {
			const small = DefRasterizer.resolveTargetSize({
				kind: "pattern",
				tileWorldSize: { width: 10, height: 10 },
				targetScale: 1,
			});
			expect(small.width).toBe(64);
			expect(small.height).toBe(64);

			const huge = DefRasterizer.resolveTargetSize({
				kind: "pattern",
				tileWorldSize: { width: 10_000, height: 10_000 },
				targetScale: 1,
			});
			expect(huge.width).toBe(2048);
			expect(huge.height).toBe(2048);
		});
	});

	describe("ensureRasterized cache", () => {
		it("invokes renderFn on miss and reuses the cached entry on hit", () => {
			const rasterizer = new DefRasterizer();
			const fakeTexture = { destroy: () => {} } as unknown as GPUTexture;
			let calls = 0;
			const renderFn = () => {
				calls++;
				return fakeTexture;
			};

			const first = rasterizer.ensureRasterized("d1", 1, 128, 128, renderFn);
			expect(first?.textureUid).toBe("def:d1:1:128x128");
			expect(calls).toBe(1);

			const second = rasterizer.ensureRasterized("d1", 1, 128, 128, renderFn);
			expect(second?.textureUid).toBe("def:d1:1:128x128");
			expect(calls).toBe(1);
		});

		it("invalidate drops every entry of a def and re-runs renderFn", () => {
			const rasterizer = new DefRasterizer();
			let destroyed = 0;
			const make = () =>
				({
					destroy: () => {
						destroyed++;
					},
				}) as unknown as GPUTexture;

			rasterizer.ensureRasterized("d1", 1, 64, 64, () => make());
			rasterizer.ensureRasterized("d1", 1, 128, 128, () => make());
			rasterizer.invalidate("d1");
			expect(destroyed).toBe(2);

			let calls = 0;
			rasterizer.ensureRasterized("d1", 1, 64, 64, () => {
				calls++;
				return make();
			});
			expect(calls).toBe(1);
		});

		it("returns null when renderFn returns null (e.g. unresolvable def)", () => {
			const rasterizer = new DefRasterizer();
			const res = rasterizer.ensureRasterized("d1", 1, 64, 64, () => null);
			expect(res).toBeNull();
		});

		it("evicts the LRU entry when over maxEntries", () => {
			const rasterizer = new DefRasterizer({ maxEntries: 2 });
			let destroyed = 0;
			const make = () =>
				({
					destroy: () => {
						destroyed++;
					},
				}) as unknown as GPUTexture;

			rasterizer.ensureRasterized("d1", 1, 64, 64, () => make());
			rasterizer.ensureRasterized("d2", 1, 64, 64, () => make());
			// Re-touch d1 so d2 is the LRU.
			rasterizer.ensureRasterized("d1", 1, 64, 64, () => make());
			rasterizer.ensureRasterized("d3", 1, 64, 64, () => make());
			expect(destroyed).toBe(1);

			// d2 is gone — would be a miss now.
			let calls = 0;
			rasterizer.ensureRasterized("d2", 1, 64, 64, () => {
				calls++;
				return make();
			});
			expect(calls).toBe(1);
		});
	});
});
