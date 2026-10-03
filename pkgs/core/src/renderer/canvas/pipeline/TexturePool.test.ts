import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_EVICT_FRAMES, IDLE_EVICT_MS } from "./IdleClock";
import { TexturePool } from "./TexturePool";

let now = 0;

beforeEach(() => {
	now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("TexturePool", () => {
	describe("frame-start eviction", () => {
		it("should destroy a pooled texture left unused for the idle frames and time", () => {
			const pool = new TexturePool(createMockDevice());
			const texture = acquireColor(pool, 256);
			pool.release(texture);

			runIdleFrames(pool, IDLE_EVICT_FRAMES, IDLE_EVICT_MS);

			expect(texture.destroy).toHaveBeenCalledOnce();
		});

		it("should keep a pooled texture that ran out the idle frames but not the idle time", () => {
			const pool = new TexturePool(createMockDevice());
			const texture = acquireColor(pool, 256);
			pool.release(texture);

			runIdleFrames(pool, IDLE_EVICT_FRAMES * 10, IDLE_EVICT_MS / 2);

			expect(texture.destroy).not.toHaveBeenCalled();
		});

		it("should keep a lent texture however long it stays out", () => {
			const pool = new TexturePool(createMockDevice());
			const texture = acquireColor(pool, 256);

			runIdleFrames(pool, IDLE_EVICT_FRAMES, IDLE_EVICT_MS);

			expect(texture.destroy).not.toHaveBeenCalled();
		});

		it("should keep a texture used every frame and evict an idle one first when over budget", () => {
			const pool = new TexturePool(createMockDevice());
			const idle = acquireColor(pool, 512);
			pool.release(idle);
			const busy = acquireColor(pool, 256);
			pool.release(busy);
			// Room for one 256² texture: something has to go.
			pool.setBudgetBytes(256 * 256 * 4);

			for (let i = 0; i < 3; i++) {
				pool.resetFrame();
				pool.release(acquireColor(pool, 256));
			}

			expect(idle.destroy).toHaveBeenCalledOnce();
			expect(busy.destroy).not.toHaveBeenCalled();
		});
	});

	describe("trimIdle", () => {
		it("should free the textures the last frame did not use and keep the ones it did", () => {
			const pool = new TexturePool(createMockDevice());
			pool.resetFrame();
			const older = acquireColor(pool, 512);
			pool.release(older);
			pool.resetFrame();
			const recent = acquireColor(pool, 256);
			pool.release(recent);

			pool.trimIdle(1);

			expect(older.destroy).toHaveBeenCalledOnce();
			expect(recent.destroy).not.toHaveBeenCalled();
		});

		it("should free every pooled texture but no lent one with 0 idle frames", () => {
			const pool = new TexturePool(createMockDevice());
			const pooled = acquireColor(pool, 256);
			pool.release(pooled);
			const lent = acquireColor(pool, 512);

			pool.trimIdle(0);

			expect(pooled.destroy).toHaveBeenCalledOnce();
			expect(lent.destroy).not.toHaveBeenCalled();
		});

		it("should allocate a fresh texture for a request after its bucket was trimmed", () => {
			const device = createMockDevice();
			const pool = new TexturePool(device);
			pool.release(acquireColor(pool, 256));

			pool.trimIdle(0);
			acquireColor(pool, 256);

			expect(device.createTexture).toHaveBeenCalledTimes(2);
		});
	});

	describe("trimToSnapshot", () => {
		it("should free the idle textures added after the snapshot and keep the earlier ones", () => {
			const pool = new TexturePool(createMockDevice());
			const earlier = acquireColor(pool, 256);
			pool.release(earlier);
			const snapshot = pool.snapshot();

			const borrowed = acquireColor(pool, 256);
			const added = acquireColor(pool, 512);
			pool.release(borrowed);
			pool.release(added);
			pool.trimToSnapshot(snapshot);

			expect(borrowed).toBe(earlier);
			expect(earlier.destroy).not.toHaveBeenCalled();
			expect(added.destroy).toHaveBeenCalledOnce();
		});

		it("should keep a texture added after the snapshot while it is lent out", () => {
			const pool = new TexturePool(createMockDevice());
			const snapshot = pool.snapshot();

			const lent = acquireColor(pool, 256);
			pool.trimToSnapshot(snapshot);

			expect(lent.destroy).not.toHaveBeenCalled();
		});
	});
});

function acquireColor(pool: TexturePool, size: number): GPUTexture {
	return pool.acquire(
		size,
		size,
		"rgba8unorm",
		1,
		GPUTextureUsage.RENDER_ATTACHMENT,
		"Test",
	);
}

/** Start `frames` document frames spread evenly over `durationMs`. */
function runIdleFrames(
	pool: TexturePool,
	frames: number,
	durationMs: number,
): void {
	const start = now;
	for (let i = 1; i <= frames; i++) {
		now = start + (durationMs * i) / frames;
		pool.resetFrame();
	}
}

function createMockDevice(): GPUDevice {
	return {
		createTexture: vi.fn(
			(descriptor: GPUTextureDescriptor) =>
				({
					...(descriptor.size as GPUExtent3DDict),
					format: descriptor.format,
					sampleCount: descriptor.sampleCount ?? 1,
					usage: descriptor.usage,
					destroy: vi.fn(),
				}) as unknown as GPUTexture,
		),
	} as unknown as GPUDevice;
}
