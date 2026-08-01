import { describe, expect, it, vi } from "vitest";
import { GeometryStore } from "./GeometryStore";

const VERTEX_FLOATS = 9;
const BYTES_PER_VERTEX = VERTEX_FLOATS * 4;

describe("GeometryStore", () => {
	it("should lease ranges back-to-back and upload their data in place", () => {
		const { store, writes } = createStore(16);

		const a = store.alloc(vertices(2));
		const b = store.alloc(vertices(3));

		expect(a.byteOffset).toBe(0);
		expect(a.vertexCount).toBe(2);
		expect(b.byteOffset).toBe(2 * BYTES_PER_VERTEX);
		expect(b.vertexCount).toBe(3);
		expect(writes.map((w) => w.offset)).toEqual([0, 2 * BYTES_PER_VERTEX]);
	});

	it("should keep a released range unavailable until the flush", () => {
		const { store } = createStore(4);

		const a = store.alloc(vertices(2));
		a.release();
		// The freed space is NOT reusable yet — in-flight draws may still read
		// it — so this allocation must land after the live tail.
		const b = store.alloc(vertices(2));
		expect(b.byteOffset).toBe(2 * BYTES_PER_VERTEX);

		store.flushPendingReleases();
		const c = store.alloc(vertices(2));
		expect(c.byteOffset).toBe(0);
	});

	it("should merge adjacent freed blocks into one allocatable range", () => {
		const { store } = createStore(6);
		const a = store.alloc(vertices(2));
		const b = store.alloc(vertices(2));
		const tail = store.alloc(vertices(2));

		a.release();
		b.release();
		store.flushPendingReleases();

		// 2+2 merged: a 4-vertex request fits at the front without growing.
		const merged = store.alloc(vertices(4));
		expect(merged.byteOffset).toBe(0);
		expect(tail.byteOffset).toBe(4 * BYTES_PER_VERTEX);
	});

	it("should ignore double release", () => {
		const { store } = createStore(4);
		const a = store.alloc(vertices(2));

		a.release();
		a.release();
		store.flushPendingReleases();

		expect(store.alloc(vertices(2)).byteOffset).toBe(0);
		// The second slot is still intact — a double release must not have
		// returned the same block twice.
		expect(store.alloc(vertices(2)).byteOffset).toBe(2 * BYTES_PER_VERTEX);
	});

	it("should grow, repack live ranges, and defer destroying the old buffer", () => {
		const { store, buffers } = createStore(4);
		const a = store.alloc(vertices(2, 1));
		const gap = store.alloc(vertices(1, 2));
		gap.release(); // still pending at grow time — must be dropped, not repacked

		const big = store.alloc(vertices(4, 3)); // exceeds capacity → grow

		expect(store.buffer()).toBe(buffers.at(-1));
		// This frame's already-encoded draws still reference the outgrown
		// buffer — destroying before the frame boundary would fail at submit.
		const outgrown = buffers[0] as { destroy: ReturnType<typeof vi.fn> };
		expect(outgrown.destroy).not.toHaveBeenCalled();
		// Live ranges were repacked contiguously; the handle observed the move.
		expect(a.byteOffset).toBe(0);
		expect(big.byteOffset).toBe(2 * BYTES_PER_VERTEX);
		// Flushing destroys the outgrown buffer and must not corrupt the free
		// list via the dropped pending release.
		store.flushPendingReleases();
		expect(outgrown.destroy).toHaveBeenCalledTimes(1);
		const next = store.alloc(vertices(1));
		expect(next.byteOffset).toBe(6 * BYTES_PER_VERTEX);
	});

	it("should re-upload live data into the grown buffer", () => {
		const { store, writes, buffers } = createStore(2);
		store.alloc(vertices(2, 7));

		store.alloc(vertices(2, 8)); // grow

		const grown = buffers.at(-1);
		const repacked = writes.filter((w) => w.buffer === grown);
		expect(repacked.map((w) => w.offset)).toEqual([0, 2 * BYTES_PER_VERTEX]);
		expect(repacked[0].data[0]).toBe(7);
		expect(repacked[1].data[0]).toBe(8);
	});

	it("should reject data that is not whole vertices", () => {
		const { store } = createStore(4);
		expect(() => store.alloc(new Float32Array(5))).toThrow(/multiple/);
	});
});

// Helpers

function vertices(count: number, fill = 0): Float32Array {
	return new Float32Array(count * VERTEX_FLOATS).fill(fill);
}

function createStore(capacityVertices: number) {
	const writes: Array<{ buffer: unknown; offset: number; data: Float32Array }> =
		[];
	const buffers: unknown[] = [];
	const device = {
		createBuffer: vi.fn((desc: { size: number }) => {
			const buffer = { size: desc.size, destroy: vi.fn() };
			buffers.push(buffer);
			return buffer;
		}),
		queue: {
			writeBuffer: vi.fn(
				(buffer: unknown, offset: number, data: Float32Array) => {
					writes.push({ buffer, offset, data: data.slice() });
				},
			),
		},
	} as unknown as GPUDevice;

	const store = new GeometryStore(device, {
		initialCapacityVertices: capacityVertices,
	});
	return { store, writes, buffers };
}
