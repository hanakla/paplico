import { UNIFIED_VERTEX_FLOATS } from "./unifiedVertexLayout";

/** Initial capacity in vertices (~2.3 MB at the default stride). */
const INITIAL_CAPACITY_VERTICES = 65_536;

/** Configuration for stores holding other retained per-element data (e.g.
 *  brush stamp instances). Defaults describe the unified geometry layout. */
interface GeometryStoreOptions {
	initialCapacityVertices?: number;
	floatsPerVertex?: number;
	usage?: GPUBufferUsageFlags;
	label?: string;
	/** Keep every range's offset fixed for the store's lifetime: growth
	 *  copies ranges to the SAME offsets instead of repacking. Required when
	 *  other stores bake this store's absolute indices into their data
	 *  (e.g. stamp instances referencing resident path metas). Trades
	 *  fragmentation for referential stability. */
	stableOffsets?: boolean;
}

/**
 * A caller-held lease on a vertex range inside the store. `byteOffset` is
 * live — the store rewrites it when the backing buffer grows and repacks —
 * so read it at draw time, never snapshot it across frames.
 */
export interface GeometryHandle {
	readonly byteOffset: number;
	/** Absolute vertex number of the range's first vertex — the value index
	 *  lists (RunBatcher) reference when drawing with buffer offset 0. Live,
	 *  like byteOffset. */
	readonly firstVertex: number;
	readonly vertexCount: number;
	/** Overwrite the range's contents in place (same length required). */
	write(data: Float32Array): void;
	/** Return the range to the store. Deferred until the next
	 *  flushPendingReleases() so in-flight draws keep their data. */
	release(): void;
}

interface StoredRange {
	vertexOffset: number;
	vertexCount: number;
	/** CPU mirror for regrow repacking (same lifetime as the range). */
	data: Float32Array;
	released: boolean;
}

/**
 * Persistent shared vertex buffer for retained element geometry (solid
 * strokes, fill fans/fringes/covers). Replaces the per-element GPUBuffers the
 * geometry caches used to create: every cached range lives in ONE buffer,
 * written only when an element's geometry actually changes, so cache-hit
 * frames bind a single vertex buffer and upload nothing.
 *
 * Allocation is a first-fit free list in vertex units with adjacent-block
 * merging. Releases are deferred to the frame boundary (a just-released
 * range may still be referenced by this frame's already-encoded draws).
 * When capacity runs out the store allocates a bigger buffer and repacks
 * every live range from its CPU mirror — handles observe the move through
 * their live `byteOffset`. The outgrown buffer is destroyed at the next
 * flushPendingReleases(), NOT immediately: destroying a buffer referenced by
 * a not-yet-submitted command buffer fails validation at submit, and this
 * frame's already-encoded draws still point at it.
 */
export class GeometryStore {
	private gpuBuffer: GPUBuffer;
	private capacityVertices: number;
	private readonly floatsPerVertex: number;
	private readonly bytesPerVertex: number;
	private readonly usage: GPUBufferUsageFlags;
	private readonly label: string;
	private readonly stableOffsets: boolean;
	/** Sorted, non-adjacent free blocks in vertex units. */
	private freeList: Array<{ vertexOffset: number; vertexCount: number }>;
	private readonly live = new Set<StoredRange>();
	private readonly pendingReleases: StoredRange[] = [];
	/** Outgrown backing buffers awaiting a frame-boundary destroy. */
	private readonly retiredBuffers: GPUBuffer[] = [];

	public constructor(
		private readonly device: GPUDevice,
		options: GeometryStoreOptions = {},
	) {
		const initialCapacityVertices =
			options.initialCapacityVertices ?? INITIAL_CAPACITY_VERTICES;
		this.floatsPerVertex = options.floatsPerVertex ?? UNIFIED_VERTEX_FLOATS;
		this.bytesPerVertex = this.floatsPerVertex * 4;
		// STORAGE: the RunBatcher's vertex-pulling pipelines read the default
		// store directly in the vertex shader (unifiedPulled.wgsl).
		this.usage =
			options.usage ??
			GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE;
		this.label = options.label ?? "Geometry Store Vertices";
		this.stableOffsets = options.stableOffsets ?? false;
		this.capacityVertices = initialCapacityVertices;
		this.gpuBuffer = this.createBuffer(initialCapacityVertices);
		this.freeList = [{ vertexOffset: 0, vertexCount: initialCapacityVertices }];
	}

	/** The shared vertex buffer every handle's byteOffset points into. Re-read
	 *  per draw — it is replaced when the store grows. */
	public buffer(): GPUBuffer {
		return this.gpuBuffer;
	}

	/** Upload `data` (whole vertices at the store's stride) into a free range
	 *  and lease it. */
	public alloc(data: Float32Array): GeometryHandle {
		if (data.length % this.floatsPerVertex !== 0) {
			throw new Error(
				`GeometryStore.alloc: data length ${data.length} is not a multiple of ${this.floatsPerVertex}`,
			);
		}
		const vertexCount = data.length / this.floatsPerVertex;
		const vertexOffset = this.reserve(vertexCount);
		const range: StoredRange = {
			vertexOffset,
			vertexCount,
			// Keep our own copy — callers reuse their scratch arrays.
			data: data.slice(),
			released: false,
		};
		this.live.add(range);
		this.device.queue.writeBuffer(
			this.gpuBuffer,
			range.vertexOffset * this.bytesPerVertex,
			range.data,
		);

		const store = this;
		const bytesPerVertex = this.bytesPerVertex;
		return {
			get byteOffset() {
				return range.vertexOffset * bytesPerVertex;
			},
			get firstVertex() {
				return range.vertexOffset;
			},
			vertexCount,
			write(next: Float32Array) {
				if (next.length !== range.data.length) {
					throw new Error(
						`GeometryHandle.write: length ${next.length} does not match the leased range (${range.data.length})`,
					);
				}
				range.data.set(next);
				store.device.queue.writeBuffer(
					store.gpuBuffer,
					range.vertexOffset * bytesPerVertex,
					range.data,
				);
			},
			release() {
				if (range.released) return;
				range.released = true;
				store.live.delete(range);
				store.pendingReleases.push(range);
			},
		};
	}

	/** Return released ranges to the free list and destroy outgrown backing
	 *  buffers. Call once per frame after the previous frame's submit
	 *  (alongside the caches' flushPendingDestroy). */
	public flushPendingReleases(): void {
		for (const range of this.pendingReleases) {
			this.free(range.vertexOffset, range.vertexCount);
		}
		this.pendingReleases.length = 0;
		for (const buffer of this.retiredBuffers) buffer.destroy();
		this.retiredBuffers.length = 0;
	}

	public destroy(): void {
		this.gpuBuffer.destroy();
		for (const buffer of this.retiredBuffers) buffer.destroy();
		this.retiredBuffers.length = 0;
		this.live.clear();
		this.pendingReleases.length = 0;
		this.freeList = [];
	}

	/** First-fit reservation, growing the store when nothing fits. */
	private reserve(vertexCount: number): number {
		for (let i = 0; i < this.freeList.length; i++) {
			const block = this.freeList[i];
			if (block.vertexCount < vertexCount) continue;
			const vertexOffset = block.vertexOffset;
			if (block.vertexCount === vertexCount) {
				this.freeList.splice(i, 1);
			} else {
				block.vertexOffset += vertexCount;
				block.vertexCount -= vertexCount;
			}
			return vertexOffset;
		}
		this.grow(vertexCount);
		return this.reserve(vertexCount);
	}

	/** Reallocate at ≥2× capacity and repack every live range from its CPU
	 *  mirror. Pending releases drop their ranges here (their data is not
	 *  repacked), which also compacts fragmentation. Stable-offset stores
	 *  copy ranges to their existing offsets instead — absolute indices
	 *  baked into other stores' data must survive the grow. */
	private grow(requiredVertices: number): void {
		if (this.stableOffsets) {
			const nextCapacity = Math.max(
				this.capacityVertices * 2,
				this.capacityVertices + requiredVertices,
			);
			const nextBuffer = this.createBuffer(nextCapacity);
			for (const range of this.live) {
				this.device.queue.writeBuffer(
					nextBuffer,
					range.vertexOffset * this.bytesPerVertex,
					range.data,
				);
			}
			this.retiredBuffers.push(this.gpuBuffer);
			this.gpuBuffer = nextBuffer;
			this.free(this.capacityVertices, nextCapacity - this.capacityVertices);
			this.capacityVertices = nextCapacity;
			return;
		}

		let liveVertices = 0;
		for (const range of this.live) liveVertices += range.vertexCount;
		const nextCapacity = Math.max(
			this.capacityVertices * 2,
			liveVertices + requiredVertices,
		);

		const nextBuffer = this.createBuffer(nextCapacity);
		let cursor = 0;
		for (const range of this.live) {
			range.vertexOffset = cursor;
			this.device.queue.writeBuffer(
				nextBuffer,
				cursor * this.bytesPerVertex,
				range.data,
			);
			cursor += range.vertexCount;
		}
		// Already-released ranges have no consumers after this frame; their
		// space simply doesn't survive the repack.
		for (const range of this.pendingReleases) {
			range.vertexOffset = -1;
		}
		this.pendingReleases.length = 0;

		this.retiredBuffers.push(this.gpuBuffer);
		this.gpuBuffer = nextBuffer;
		this.capacityVertices = nextCapacity;
		this.freeList = [
			{ vertexOffset: cursor, vertexCount: nextCapacity - cursor },
		];
	}

	/** Insert a block into the sorted free list, merging adjacent blocks. */
	private free(vertexOffset: number, vertexCount: number): void {
		if (vertexOffset < 0) return; // dropped by a repack
		let insertAt = this.freeList.length;
		for (let i = 0; i < this.freeList.length; i++) {
			if (this.freeList[i].vertexOffset > vertexOffset) {
				insertAt = i;
				break;
			}
		}
		this.freeList.splice(insertAt, 0, { vertexOffset, vertexCount });

		// Merge with the next block, then with the previous one.
		const next = this.freeList[insertAt + 1];
		const inserted = this.freeList[insertAt];
		if (
			next &&
			inserted.vertexOffset + inserted.vertexCount === next.vertexOffset
		) {
			inserted.vertexCount += next.vertexCount;
			this.freeList.splice(insertAt + 1, 1);
		}
		const prev = this.freeList[insertAt - 1];
		if (
			prev &&
			prev.vertexOffset + prev.vertexCount === inserted.vertexOffset
		) {
			prev.vertexCount += inserted.vertexCount;
			this.freeList.splice(insertAt, 1);
		}
	}

	private createBuffer(capacityVertices: number): GPUBuffer {
		return this.device.createBuffer({
			label: this.label,
			size: capacityVertices * this.bytesPerVertex,
			usage: this.usage,
		});
	}
}
