/**
 * BoundedStampStore - bounded residency for resident brush-stamp instances.
 *
 * ONE GPUBuffer, created lazily on the first alloc, grows from a small
 * initial size (≥2× per grow) up to a hard cap of
 * min(maxStorageBufferBindingSize, maxBufferSize, 128 MiB), so binding the
 * whole buffer always validates and the cap IS the store's total memory
 * budget. canFit() answers — without side effects — whether a run can be
 * placed; when it cannot even at the cap, alloc() returns null and the
 * caller falls back to the frame-pooled transient path.
 *
 * A run's offset never moves for the lease's lifetime: growth reallocates the
 * buffer but copies every live range to the SAME offset from its CPU mirror,
 * so the shader's `stamps[instance_index]` read (brushStamp.wgsl) stays valid
 * with the handle's absolute firstStamp as the draw's firstInstance. The
 * outgrown buffer is retired to a frame-boundary destroy, and releases are
 * deferred there too (a just-released range may still be referenced by this
 * frame's already-encoded draws) — mirroring GeometryStore.
 */

/** A caller-held lease on a stamp run. The run's offset is stable for the
 *  lease's lifetime, so both index fields are snapshots. */
export interface StampHandle {
	/** Absolute first stamp index in the store — the draw's firstInstance. */
	readonly firstStamp: number;
	/** Number of stamps in the run. */
	readonly stampCount: number;
	/** Return the run to the store. Deferred until the next
	 *  flushPendingReleases() so in-flight draws keep their data. */
	release(): void;
}

interface BoundedStampStoreOptions {
	/** Floats per stamp instance (the store's stride, in floats). */
	floatsPerStamp: number;
	usage: GPUBufferUsageFlags;
	label: string;
	/** Force the capacity cap (max stamps the buffer may grow to). Production
	 *  derives it from the device limits; tests inject a small value. */
	maxCapacityStamps?: number;
	/** Force the initial capacity (tests set it below the cap to exercise
	 *  growth). Defaults to INITIAL_CAPACITY_STAMPS clamped to the cap. */
	initialCapacityStamps?: number;
}

interface StampRange {
	/** First stamp index. Stable across the store's growth. */
	offset: number;
	/** Length in stamps. */
	count: number;
	/** CPU mirror, re-uploaded to the SAME offset when the store grows.
	 *  Owned by the store: alloc() takes the caller's array without copying. */
	data: Float32Array;
	released: boolean;
}

/** Cap the store at 128 MiB (>2M stamps at 64 B/stamp) so resident stamps
 *  never pin an unreasonable slab of GPU memory. */
const MAX_STORE_BYTES = 128 * 1024 * 1024;
/** Initial capacity (~1 MiB at 64 B/stamp) so a light document never
 *  allocates a full-cap slab. */
const INITIAL_CAPACITY_STAMPS = 16_384;

export class BoundedStampStore {
	/** Hard cap the buffer may grow to, in stamps (≤ the device binding limit,
	 *  so a whole-buffer binding always validates). */
	public readonly maxCapacityStamps: number;
	private readonly floatsPerStamp: number;
	private readonly bytesPerStamp: number;
	private readonly usage: GPUBufferUsageFlags;
	private readonly label: string;
	private readonly initialCapacityStamps: number;
	/** Created lazily on the first alloc — targets that never draw stamp
	 *  brushes must not pay for a resident slab. */
	private gpuBuffer: GPUBuffer | null = null;
	private capacityStamps = 0;
	/** Sorted, non-adjacent free blocks in stamps. */
	private freeList: Array<{ offset: number; count: number }> = [];
	private readonly live = new Set<StampRange>();
	private readonly pendingReleases: StampRange[] = [];
	/** Outgrown backing buffers awaiting a frame-boundary destroy. */
	private readonly retiredBuffers: GPUBuffer[] = [];
	/** Terminal state: destroy() is final. Every entry point rejects afterwards
	 *  so a stale handle's release can never resurrect a freed range into a
	 *  reused store (the ranges themselves are also flagged released). */
	private destroyed = false;

	public constructor(
		private readonly device: GPUDevice,
		options: BoundedStampStoreOptions,
	) {
		this.floatsPerStamp = options.floatsPerStamp;
		this.bytesPerStamp = options.floatsPerStamp * 4;
		this.usage = options.usage;
		this.label = options.label;
		this.maxCapacityStamps =
			options.maxCapacityStamps ??
			deriveMaxCapacityStamps(device, this.bytesPerStamp);
		if (this.maxCapacityStamps < 1) {
			throw new Error(
				"BoundedStampStore: derived capacity cap is below one stamp",
			);
		}
		this.initialCapacityStamps = Math.min(
			options.initialCapacityStamps ?? INITIAL_CAPACITY_STAMPS,
			this.maxCapacityStamps,
		);
	}

	/** Whether a run of `stampCount` stamps can be placed right now — into an
	 *  existing free block or by growing toward the cap. Pure (no allocation,
	 *  no growth). Shares findFit()/grownTailCount() with alloc(), so
	 *  `canFit(n) === (alloc(n stamps) !== null)` for the same store state.
	 *  Callers use it as the admission check BEFORE allocating sibling
	 *  resources (meta/stops ranges) for the run. */
	public canFit(stampCount: number): boolean {
		this.assertNotDestroyed("canFit");
		if (stampCount > this.maxCapacityStamps) return false;
		// Not initialized yet: the first alloc creates the initial buffer and
		// grows it toward the cap as needed, so any run up to the cap fits.
		if (!this.gpuBuffer) return true;
		if (this.findFit(stampCount) >= 0) return true;
		if (this.capacityStamps >= this.maxCapacityStamps) return false;
		return this.grownTailCount(stampCount) >= stampCount;
	}

	/** Upload `data` (whole stamps at the store's stride) into a free range and
	 *  lease it.
	 *
	 *  OWNERSHIP: the store takes ownership of the exact array passed — it is
	 *  kept as the range's CPU mirror (re-uploaded on growth), NOT copied. The
	 *  caller must hand over a freshly owned array and must not mutate it
	 *  afterwards.
	 *
	 *  First-fit; grows the buffer (≥2×, up to the cap) when nothing fits.
	 *  Returns null exactly when canFit() is false — including a run larger
	 *  than the whole cap — so the caller can fall back to the frame-pooled
	 *  transient path. A null return has no side effects (no growth). Throws
	 *  only on malformed input. */
	public alloc(data: Float32Array): StampHandle | null {
		this.assertNotDestroyed("alloc");
		if (data.length % this.floatsPerStamp !== 0) {
			throw new Error(
				`BoundedStampStore.alloc: data length ${data.length} is not a multiple of ${this.floatsPerStamp}`,
			);
		}
		const count = data.length / this.floatsPerStamp;
		if (!this.canFit(count)) return null;

		this.ensureInitialized();
		let offset = this.reserve(count);
		if (offset < 0) {
			this.grow(count);
			offset = this.reserve(count);
		}
		if (offset < 0) return null;

		const range: StampRange = {
			offset,
			count,
			data,
			released: false,
		};
		this.live.add(range);
		this.device.queue.writeBuffer(
			this.requireBuffer(),
			offset * this.bytesPerStamp,
			range.data,
		);
		return this.makeHandle(range);
	}

	/** The GPUBuffer backing the store — bind whole as the stamp storage
	 *  buffer. Re-read per draw: growth replaces it. Only valid while resident
	 *  draws exist (i.e. after a successful alloc). */
	public buffer(): GPUBuffer {
		this.assertNotDestroyed("buffer");
		return this.requireBuffer();
	}

	/** Return released ranges to the free list and destroy outgrown backing
	 *  buffers. Call once per frame after the previous frame's submit — a range
	 *  released mid-frame may still be referenced by this frame's
	 *  already-encoded draws, as may a just-retired buffer. Released ranges
	 *  leave `live` only here, so a grow() between release and flush still
	 *  re-uploads their data for those in-flight draws. */
	public flushPendingReleases(): void {
		this.assertNotDestroyed("flushPendingReleases");
		for (const range of this.pendingReleases) {
			this.live.delete(range);
			this.free(range.offset, range.count);
		}
		this.pendingReleases.length = 0;
		for (const buffer of this.retiredBuffers) buffer.destroy();
		this.retiredBuffers.length = 0;
	}

	/** Terminal: the store rejects every entry point afterwards. Live and
	 *  pending ranges are flagged released so a stale handle's release() is a
	 *  no-op instead of pushing its old range into a later store state. */
	public destroy(): void {
		this.destroyed = true;
		this.gpuBuffer?.destroy();
		this.gpuBuffer = null;
		this.capacityStamps = 0;
		for (const buffer of this.retiredBuffers) buffer.destroy();
		this.retiredBuffers.length = 0;
		for (const range of this.live) range.released = true;
		for (const range of this.pendingReleases) range.released = true;
		this.pendingReleases.length = 0;
		this.live.clear();
		this.freeList = [];
	}

	private assertNotDestroyed(method: string): void {
		if (this.destroyed) {
			throw new Error(`BoundedStampStore.${method}: store is destroyed`);
		}
	}

	/** Create the initial buffer / capacity / free list on the first alloc. */
	private ensureInitialized(): void {
		if (this.gpuBuffer) return;
		this.capacityStamps = this.initialCapacityStamps;
		this.gpuBuffer = this.createBuffer(this.capacityStamps);
		this.freeList = [{ offset: 0, count: this.capacityStamps }];
	}

	private requireBuffer(): GPUBuffer {
		if (!this.gpuBuffer) {
			throw new Error(
				"BoundedStampStore: buffer() before the first alloc — resident draws cannot exist yet",
			);
		}
		return this.gpuBuffer;
	}

	/** Index of the first free block that fits `count` stamps, or -1. Shared
	 *  by reserve() and canFit() so admission and allocation cannot diverge. */
	private findFit(count: number): number {
		for (let i = 0; i < this.freeList.length; i++) {
			if (this.freeList[i].count >= count) return i;
		}
		return -1;
	}

	/** Free stamps that a grow for `count` more stamps would leave at the
	 *  buffer's tail: the appended region merged with an existing trailing
	 *  free block — mirroring grow()'s free()-with-merge. Shared by canFit()
	 *  and (via grow's capacity formula) alloc(). */
	private grownTailCount(count: number): number {
		const nextCapacity = this.grownCapacity(count);
		let tail = nextCapacity - this.capacityStamps;
		const last = this.freeList.at(-1);
		if (last && last.offset + last.count === this.capacityStamps) {
			tail += last.count;
		}
		return tail;
	}

	/** Capacity after a grow for `count` more stamps: ≥2×, or enough for
	 *  `count` trailing stamps, capped at the store's maximum. */
	private grownCapacity(count: number): number {
		return Math.min(
			this.maxCapacityStamps,
			Math.max(this.capacityStamps * 2, this.capacityStamps + count),
		);
	}

	/** First-fit reservation. Returns the stamp offset, or -1 when nothing
	 *  fits. */
	private reserve(count: number): number {
		const i = this.findFit(count);
		if (i < 0) return -1;
		const block = this.freeList[i];
		const offset = block.offset;
		if (block.count === count) {
			this.freeList.splice(i, 1);
		} else {
			block.offset += count;
			block.count -= count;
		}
		return offset;
	}

	/** Grow the buffer toward the cap (≥2×, or enough for `needed` trailing
	 *  stamps), copying every live range to the SAME offset so leases stay
	 *  valid, and appending the new tail as free space. */
	private grow(needed: number): void {
		const nextCapacity = this.grownCapacity(needed);
		if (nextCapacity <= this.capacityStamps) return;
		const nextBuffer = this.createBuffer(nextCapacity);
		for (const range of this.live) {
			this.device.queue.writeBuffer(
				nextBuffer,
				range.offset * this.bytesPerStamp,
				range.data,
			);
		}
		this.retiredBuffers.push(this.requireBuffer());
		this.gpuBuffer = nextBuffer;
		this.free(this.capacityStamps, nextCapacity - this.capacityStamps);
		this.capacityStamps = nextCapacity;
	}

	/** Insert a freed block into the sorted free list, merging adjacent
	 *  blocks. */
	private free(offset: number, count: number): void {
		let insertAt = this.freeList.length;
		for (let i = 0; i < this.freeList.length; i++) {
			if (this.freeList[i].offset > offset) {
				insertAt = i;
				break;
			}
		}
		this.freeList.splice(insertAt, 0, { offset, count });

		// Merge with the next block, then with the previous one.
		const next = this.freeList[insertAt + 1];
		const inserted = this.freeList[insertAt];
		if (next && inserted.offset + inserted.count === next.offset) {
			inserted.count += next.count;
			this.freeList.splice(insertAt + 1, 1);
		}
		const prev = this.freeList[insertAt - 1];
		if (prev && prev.offset + prev.count === inserted.offset) {
			prev.count += inserted.count;
			this.freeList.splice(insertAt, 1);
		}
	}

	private makeHandle(range: StampRange): StampHandle {
		const store = this;
		return {
			firstStamp: range.offset,
			stampCount: range.count,
			release() {
				if (range.released) return;
				// Only flag + queue here: the range must stay in `live` until the
				// frame-boundary flush so a same-frame grow() still re-uploads its
				// data — draws already queued against the range read the NEW
				// buffer at submit.
				range.released = true;
				store.pendingReleases.push(range);
			},
		};
	}

	private createBuffer(capacityStamps: number): GPUBuffer {
		return this.device.createBuffer({
			label: this.label,
			size: capacityStamps * this.bytesPerStamp,
			usage: this.usage,
		});
	}
}

/** Largest capacity that stays ≤ the device binding limit (so a whole-buffer
 *  binding always validates) and ≤ the 128 MiB cap. */
function deriveMaxCapacityStamps(
	device: GPUDevice,
	bytesPerStamp: number,
): number {
	const bindLimit = Math.min(
		device.limits.maxStorageBufferBindingSize,
		device.limits.maxBufferSize,
	);
	return Math.floor(Math.min(bindLimit, MAX_STORE_BYTES) / bytesPerStamp);
}
