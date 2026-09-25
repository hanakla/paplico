/**
 * Per-frame GPU buffer pools shared by the dab and ribbon renderers:
 * instance data, PathMetas and ColorStops. Grow-only; the pools rewind at the
 * start of each frame so every draw of a frame keeps its own buffer until
 * the frame is submitted.
 */
export class BrushFrameBuffers {
	private readonly device: GPUDevice;
	private readonly instancePool: PooledBuffer[] = [];
	private readonly pathMetaPool: PooledBuffer[] = [];
	private readonly colorStopsPool: PooledBuffer[] = [];
	private instanceIdx = 0;
	private pathMetaIdx = 0;
	private colorStopsIdx = 0;

	public constructor(device: GPUDevice) {
		this.device = device;
	}

	/** Rewind every pool. Call at the start of each frame. */
	public beginFrame(): void {
		this.instanceIdx = 0;
		this.pathMetaIdx = 0;
		this.colorStopsIdx = 0;
	}

	public acquireInstances(requiredSize: number): GPUBuffer {
		const buffer = this.acquire(
			this.instancePool,
			this.instanceIdx,
			requiredSize,
			4096,
			"Brush Instance Buffer (Pooled)",
		);
		this.instanceIdx++;
		return buffer;
	}

	public acquirePathMetaBuffer(requiredSize: number): GPUBuffer {
		const buffer = this.acquire(
			this.pathMetaPool,
			this.pathMetaIdx,
			requiredSize,
			1024,
			"PathMeta Storage Buffer (Pooled)",
		);
		this.pathMetaIdx++;
		return buffer;
	}

	public acquireColorStopsBuffer(requiredSize: number): GPUBuffer {
		const buffer = this.acquire(
			this.colorStopsPool,
			this.colorStopsIdx,
			requiredSize,
			256,
			"Color Stops Storage Buffer (Pooled)",
		);
		this.colorStopsIdx++;
		return buffer;
	}

	public destroy(): void {
		for (const pool of [
			this.instancePool,
			this.pathMetaPool,
			this.colorStopsPool,
		]) {
			for (const entry of pool) entry.buffer.destroy();
			pool.length = 0;
		}
	}

	private acquire(
		pool: PooledBuffer[],
		index: number,
		requiredSize: number,
		minSize: number,
		label: string,
	): GPUBuffer {
		let entry = pool[index];
		const size = poolBufferSize(requiredSize, minSize);
		// Reallocate when the buffer is too small, and also when the need has
		// dropped two power-of-two steps so a burst does not pin its peak.
		if (!entry || entry.size < size || entry.size > size * SHRINK_RATIO) {
			entry?.buffer.destroy();
			entry = {
				buffer: this.device.createBuffer({
					label,
					size,
					usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
				}),
				size,
			};
			pool[index] = entry;
		}
		return entry.buffer;
	}
}

interface PooledBuffer {
	buffer: GPUBuffer;
	size: number;
}

/** A pooled buffer larger than the need by this factor is replaced with a
 *  smaller one. Two power-of-two steps of slack keep oscillating sizes from
 *  reallocating every frame. */
const SHRINK_RATIO = 4;

/** Round pooled buffer sizes up to a power of two so gradual size growth
 *  reuses buffers instead of destroying/recreating them every frame. */
function poolBufferSize(requiredSize: number, minSize: number): number {
	return Math.max(2 ** Math.ceil(Math.log2(requiredSize)), minSize);
}
