import { describe, expect, it, vi } from "vitest";
import type { StampBuffer } from "../../caches/StampCache";
import { StampCache } from "../../caches/StampCache";
import { BoundedStampStore } from "./BoundedStampStore";

/** Floats per resident stamp instance (mirrors STAMP_FLOATS). */
const STAMP_FLOATS = 16;
const STAMP_BYTES = STAMP_FLOATS * 4;
/** GPUBufferUsage globals are absent under happy-dom; the mock ignores usage. */
const STORAGE_COPY_DST = 0x80 | 0x08;

describe("BoundedStampStore", () => {
	it("should allocate consecutive runs at absolute offsets in one buffer", () => {
		const { store, buffers } = createStore({ max: 4 });

		const a = store.alloc(stamps(2));
		const b = store.alloc(stamps(2)); // fills the store exactly

		expect(a?.firstStamp).toBe(0);
		expect(a?.stampCount).toBe(2);
		expect(b?.firstStamp).toBe(2);
		// One backing buffer — created on the first alloc, never paged.
		expect(buffers).toHaveLength(1);
	});

	it("should not create the GPU buffer until the first alloc", () => {
		const { store, buffers } = createStore({ max: 4 });

		// Construction and the pure canFit() check allocate nothing.
		expect(buffers).toHaveLength(0);
		expect(store.canFit(2)).toBe(true);
		expect(buffers).toHaveLength(0);

		store.alloc(stamps(2));
		expect(buffers).toHaveLength(1);
	});

	it("should reject buffer() before the first alloc", () => {
		const { store } = createStore({ max: 4 });
		expect(() => store.buffer()).toThrow(/before the first alloc/);
	});

	it("should answer canFit in agreement with alloc across free-list fragmentation", () => {
		const { store } = createStore({ max: 8, initial: 8 });
		store.alloc(stamps(3));
		const middle = store.alloc(stamps(3));
		store.alloc(stamps(2)); // store full
		middle?.release();
		store.flushPendingReleases(); // one free hole: stamps 3..6

		// A run larger than the hole: canFit false ⇔ alloc null.
		expect(store.canFit(4)).toBe(false);
		expect(store.alloc(stamps(4))).toBeNull();
		// A run matching the hole: canFit true ⇔ alloc succeeds.
		expect(store.canFit(3)).toBe(true);
		expect(store.alloc(stamps(3))?.firstStamp).toBe(3);
		// Full again: canFit false ⇔ alloc null.
		expect(store.canFit(1)).toBe(false);
		expect(store.alloc(stamps(1))).toBeNull();
	});

	it("should answer canFit in agreement with alloc when the fit needs growth headroom", () => {
		const { store } = createStore({ max: 8, initial: 4 });
		store.alloc(stamps(3)); // trailing free block: 1 stamp

		// Fits only by growing 4 -> 8 AND merging the appended tail with the
		// existing trailing free stamp (3 + 5 = 8).
		expect(store.canFit(5)).toBe(true);
		expect(store.alloc(stamps(5))?.firstStamp).toBe(3);
		// At the cap and full: canFit false ⇔ alloc null.
		expect(store.canFit(1)).toBe(false);
		expect(store.alloc(stamps(1))).toBeNull();
	});

	it("should not grow the buffer for an alloc that cannot fit even at the cap", () => {
		const { store, buffers } = createStore({ max: 4, initial: 2 });
		store.alloc(stamps(4)); // init + grow to the cap
		const buffersAfterAlloc = buffers.length;

		expect(store.alloc(stamps(1))).toBeNull();

		// The rejected alloc had no side effects — no speculative growth.
		expect(buffers).toHaveLength(buffersAfterAlloc);
	});

	it("should take ownership of the passed array as the regrow mirror instead of copying", () => {
		const { store, writes } = createStore({ max: 8, initial: 2 });
		const owned = stamps(2, 1);
		store.alloc(owned);

		// The mirror IS the exact passed array: a (contract-violating)
		// mutation shows up in the grow re-upload, proving no internal copy.
		owned[0] = 42;
		store.alloc(stamps(2)); // grow 2 -> 4 re-uploads live ranges

		const reupload = writes.find(
			(w) => w.buffer === store.buffer() && w.offset === 0,
		);
		expect(reupload?.data[0]).toBe(42);
	});

	it("should upload alloc data at the absolute byte offset", () => {
		const { store, writes, buffers } = createStore({ max: 4 });
		store.alloc(stamps(2, 1));

		store.alloc(stamps(2, 2));

		const lastWrite = writes.at(-1);
		expect(lastWrite?.buffer).toBe(buffers[0]);
		expect(lastWrite?.offset).toBe(2 * STAMP_BYTES);
	});

	it("should grow the buffer in place, keeping live offsets stable", () => {
		const { store, writes, buffers } = createStore({ max: 8, initial: 2 });
		const a = store.alloc(stamps(2, 7)); // fills the initial capacity
		const buf0 = store.buffer();

		const b = store.alloc(stamps(2)); // grows 2 -> 4

		expect(a?.firstStamp).toBe(0);
		expect(b?.firstStamp).toBe(2);
		// Growth replaced the buffer...
		expect(store.buffer()).not.toBe(buf0);
		expect(store.buffer()).toBe(buffers.at(-1));
		// ...and re-uploaded the live range `a` to the new buffer at the SAME
		// offset.
		expect(
			writes.some((w) => w.buffer === store.buffer() && w.offset === 0),
		).toBe(true);
	});

	it("should grow through multiple steps up to the cap", () => {
		const { store } = createStore({ max: 8, initial: 2 });

		const handles = [0, 1, 2, 3].map(() => store.alloc(stamps(2)));

		// 8 stamps: capacity grew 2 -> 4 -> 8; every run kept its offset.
		expect(handles.map((h) => h?.firstStamp)).toEqual([0, 2, 4, 6]);
		// At the cap, the next run no longer fits.
		expect(store.alloc(stamps(1))).toBeNull();
	});

	it("should retire the outgrown buffer to the frame-boundary flush, not destroy it immediately", () => {
		const { store } = createStore({ max: 8, initial: 2 });
		store.alloc(stamps(2));
		const buf0 = store.buffer();

		store.alloc(stamps(2)); // grow retires buf0

		expect(destroyCalls(buf0)).toBe(0);
		store.flushPendingReleases();
		expect(destroyCalls(buf0)).toBe(1);
	});

	it("should return null when a run cannot fit even after growing to the cap", () => {
		const { store } = createStore({ max: 4, initial: 2 });
		expect(store.alloc(stamps(3))).not.toBeNull(); // grows 2 -> 4 (the cap)

		expect(store.alloc(stamps(2))).toBeNull();
		// The remaining single-stamp slot still allocates.
		expect(store.alloc(stamps(1))?.firstStamp).toBe(3);
	});

	it("should return null for a single run larger than the whole cap", () => {
		const { store } = createStore({ max: 4 });
		expect(store.alloc(stamps(5))).toBeNull();
	});

	it("should throw for data that is not whole stamps", () => {
		const { store } = createStore({ max: 4 });
		expect(() => store.alloc(new Float32Array(STAMP_FLOATS + 1))).toThrow(
			/multiple/,
		);
	});

	it("should reject every entry point after destroy", () => {
		const { store } = createStore({ max: 4 });
		store.alloc(stamps(1));

		store.destroy();

		expect(() => store.alloc(stamps(1))).toThrow(/destroyed/);
		expect(() => store.canFit(1)).toThrow(/destroyed/);
		expect(() => store.buffer()).toThrow(/destroyed/);
		expect(() => store.flushPendingReleases()).toThrow(/destroyed/);
	});

	it("should turn a stale handle's release into a no-op after destroy", () => {
		const { store } = createStore({ max: 4 });
		const live = store.alloc(stamps(2));
		const pending = store.alloc(stamps(1));
		pending?.release(); // pending at destroy time

		store.destroy();

		// Neither the still-live nor the already-pending handle may enqueue
		// anything into the destroyed store — a resurrected free-list entry
		// would overlap a later store state's live ranges.
		expect(() => live?.release()).not.toThrow();
		expect(() => pending?.release()).not.toThrow();
	});

	it("should keep a released slot unavailable until the flush, then reuse it", () => {
		const { store } = createStore({ max: 4 });
		const a = store.alloc(stamps(2));
		store.alloc(stamps(2)); // store full
		a?.release();

		// The freed slot is NOT reusable yet — in-flight draws may still read
		// it — so the store reports full.
		expect(store.alloc(stamps(2))).toBeNull();

		store.flushPendingReleases();
		const reused = store.alloc(stamps(2));
		expect(reused?.firstStamp).toBe(0);
	});

	it("should carry a released range's data through a same-frame growth until the flush", () => {
		const { store, writes } = createStore({ max: 4, initial: 2 });
		// Queue a resident draw for A (the handle's range), then a cache
		// eviction releases it before the frame's flush.
		const a = store.alloc(stamps(2, 7));
		a?.release();

		// A later same-frame alloc grows the buffer 2 -> 4. A's queued draw
		// still reads its original firstStamp range from the NEW buffer at
		// submit, so the grow must re-upload the released-but-unflushed data.
		const b = store.alloc(stamps(2, 1));
		expect(b?.firstStamp).toBe(2);
		const grownBuffer = store.buffer();
		const aReupload = writes.find(
			(w) => w.buffer === grownBuffer && w.offset === 0,
		);
		expect(aReupload?.data).toEqual(stamps(2, 7));

		// A's slot returns to the free list only at the flush.
		expect(store.alloc(stamps(2))).toBeNull();
		store.flushPendingReleases();
		expect(store.alloc(stamps(2))?.firstStamp).toBe(0);
	});

	it("should ignore a double release", () => {
		const { store } = createStore({ max: 4 });
		const a = store.alloc(stamps(2));

		a?.release();
		a?.release();
		store.flushPendingReleases();

		// Only one slot returned: a 2-stamp alloc reuses it at offset 0, and a
		// second alloc lands after it — the double release did not free twice.
		expect(store.alloc(stamps(2))?.firstStamp).toBe(0);
		expect(store.alloc(stamps(2))?.firstStamp).toBe(2);
	});

	it("should release the previous lease when the same path inserts a new fingerprint", () => {
		const { store } = createStore({ max: 4 });
		const cache = new StampCache();
		const first = residentEntry(store, stamps(2));
		cache.set("path-1:fpA", first.entry, "path-1");

		// Editing the path produces a NEW composite key for the same owner;
		// inserting it must free the old key's lease.
		const second = residentEntry(store, stamps(2)); // store now full
		cache.set("path-1:fpB", second.entry, "path-1");
		store.flushPendingReleases();

		expect(first.release).toHaveBeenCalledTimes(1);
		// The old stamp lease was returned through the deferred-release path:
		// its slot is reusable again.
		expect(store.alloc(stamps(2))?.firstStamp).toBe(0);
	});

	it("should derive the capacity cap from the device limits when not injected", () => {
		const { device } = createDevice({
			maxStorageBufferBindingSize: 128 * 1024 * 1024,
			maxBufferSize: 256 * 1024 * 1024,
		});
		const store = new BoundedStampStore(device, {
			floatsPerStamp: STAMP_FLOATS,
			usage: STORAGE_COPY_DST,
			label: "Derived",
		});

		// min(128 MiB binding, 256 MiB buffer, 128 MiB cap) / 64 bytes.
		expect(store.maxCapacityStamps).toBe((128 * 1024 * 1024) / STAMP_BYTES);
	});

	it("should destroy the backing buffer and any retired buffer", () => {
		const { store } = createStore({ max: 8, initial: 2 });
		store.alloc(stamps(2));
		const buf0 = store.buffer();
		store.alloc(stamps(2)); // grow retires buf0
		const buf1 = store.buffer();

		store.destroy();

		expect(destroyCalls(buf0)).toBe(1);
		expect(destroyCalls(buf1)).toBe(1);
	});
});

// Helpers

interface MockBuffer {
	size: number;
	destroy: ReturnType<typeof vi.fn>;
}

function stamps(count: number, fill = 0): Float32Array {
	return new Float32Array(count * STAMP_FLOATS).fill(fill);
}

function createDevice(limits?: {
	maxStorageBufferBindingSize: number;
	maxBufferSize: number;
}) {
	const writes: Array<{ buffer: unknown; offset: number; data: Float32Array }> =
		[];
	const buffers: MockBuffer[] = [];
	const device = {
		limits: limits ?? {
			maxStorageBufferBindingSize: 1 << 30,
			maxBufferSize: 1 << 30,
		},
		createBuffer: vi.fn((desc: { size: number }) => {
			const buffer: MockBuffer = { size: desc.size, destroy: vi.fn() };
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
	return { device, writes, buffers };
}

function createStore(opts: { max: number; initial?: number }) {
	const { device, writes, buffers } = createDevice();
	const store = new BoundedStampStore(device, {
		floatsPerStamp: STAMP_FLOATS,
		usage: STORAGE_COPY_DST,
		label: "Test Stamp Store",
		maxCapacityStamps: opts.max,
		initialCapacityStamps: opts.initial,
	});
	return { store, writes, buffers };
}

function destroyCalls(buffer: GPUBuffer): number {
	return (buffer as unknown as MockBuffer).destroy.mock.calls.length;
}

/** A StampCache entry holding a lease from `store`, with a spied release. */
function residentEntry(store: BoundedStampStore, data: Float32Array) {
	const handle = store.alloc(data);
	if (!handle) throw new Error("test setup: store.alloc returned null");
	const release = vi.fn(handle.release);
	const entry: StampBuffer = {
		data,
		count: data.length / STAMP_FLOATS,
		residentDab: { handle: { ...handle, release } },
	};
	return { entry, release };
}
