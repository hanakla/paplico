import { describe, expect, it, vi } from "vitest";
import type { LinearGradient } from "../../../schema";
import { GradientCache, hashGradientDraw } from "./GradientCache";
import { RenderCacheManager } from "./RenderCacheManager";

describe("GradientCache", () => {
	it("should keep a replaced entry's buffers alive until flushPendingDestroy", () => {
		const cache = new GradientCache();
		const first = makeEntry(1);
		const second = makeEntry(2);

		cache.set("el-1:fill-1:fill", first);
		cache.set("el-1:fill-1:fill", second);

		expect(cache.get("el-1:fill-1:fill")).toBe(second);
		expect(first.uniformBuffer.destroy).not.toHaveBeenCalled();
		expect(first.stopsBuffer.destroy).not.toHaveBeenCalled();

		cache.flushPendingDestroy();

		expect(first.uniformBuffer.destroy).toHaveBeenCalledTimes(1);
		expect(first.stopsBuffer.destroy).toHaveBeenCalledTimes(1);
		expect(second.uniformBuffer.destroy).not.toHaveBeenCalled();
	});

	it("should destroy a deleted entry's buffers only after flushPendingDestroy", () => {
		const cache = new GradientCache();
		const entry = makeEntry(1);
		cache.set("el-1:fill-1:fill", entry);

		cache.delete("el-1:fill-1:fill");

		expect(cache.get("el-1:fill-1:fill")).toBeUndefined();
		expect(entry.uniformBuffer.destroy).not.toHaveBeenCalled();

		cache.flushPendingDestroy();

		expect(entry.uniformBuffer.destroy).toHaveBeenCalledTimes(1);
		expect(entry.stopsBuffer.destroy).toHaveBeenCalledTimes(1);
	});

	it("should destroy every entry, including pending ones, on clear", () => {
		const cache = new GradientCache();
		const replaced = makeEntry(1);
		const live = makeEntry(2);
		cache.set("el-1:fill-1:fill", replaced);
		cache.set("el-1:fill-1:fill", live);

		cache.clear();

		expect(replaced.uniformBuffer.destroy).toHaveBeenCalledTimes(1);
		expect(live.uniformBuffer.destroy).toHaveBeenCalledTimes(1);
		expect([...cache.keys()]).toEqual([]);
	});

	it("should release replaced buffers when the cache manager flushes the frame", () => {
		const manager = new RenderCacheManager();
		const first = makeEntry(1);
		manager.gradient.set("el-1:fill-1:fill", first);
		manager.gradient.set("el-1:fill-1:fill", makeEntry(2));

		manager.flushPendingDestroy();

		expect(first.uniformBuffer.destroy).toHaveBeenCalledTimes(1);
	});

	function makeEntry(fingerprint: number) {
		return {
			uniformBuffer: { destroy: vi.fn() } as unknown as GPUBuffer,
			stopsBuffer: { destroy: vi.fn() } as unknown as GPUBuffer,
			bindGroup: {} as GPUBindGroup,
			fingerprint,
		};
	}
});

describe("hashGradientDraw", () => {
	function makeLinearGradient(midpoint: number): LinearGradient {
		return {
			type: "linear",
			x1: 0,
			y1: 0,
			x2: 1,
			y2: 0,
			stops: [
				{
					offset: 0,
					color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
					midpoint,
				},
				{
					offset: 1,
					color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
					midpoint: 0.5,
				},
			],
		};
	}

	it("changes fingerprint when a stop's midpoint changes (offset and color unchanged)", () => {
		const h1 = hashGradientDraw(makeLinearGradient(0.5), [0, 0], [1, 1], 0);
		const h2 = hashGradientDraw(makeLinearGradient(0.3), [0, 0], [1, 1], 0);

		expect(h1).not.toBe(h2);
	});

	it("returns the same fingerprint for identical gradients", () => {
		const h1 = hashGradientDraw(makeLinearGradient(0.5), [0, 0], [1, 1], 0);
		const h2 = hashGradientDraw(makeLinearGradient(0.5), [0, 0], [1, 1], 0);

		expect(h1).toBe(h2);
	});
});
