/**
 * GPU-side render pass timing via WebGPU timestamp queries.
 *
 * Readback results feed a periodic console.log summary. Do not emit
 * performance.measure entries here: nothing clears the User Timing buffer,
 * and its unbounded growth makes React dev's per-render clearMeasures
 * calls (which scan the whole buffer) pathologically slow.
 *
 * Usage:
 *   profiler.beginFrame()
 *   encoder.beginRenderPass({ ...desc, timestampWrites: profiler.timestampWrites("label") })
 *   profiler.resolve(encoder)   // before encoder.finish()
 *   queue.submit(...)
 *   profiler.readback()         // non-blocking
 */

enum FrameState {
	/** Buffer is idle and available for resolve writes. */
	idle = 0,
	/** Buffer has been written by resolve, awaiting readback initiation. */
	written = 1,
	/** mapAsync in flight — buffer must NOT be used as copy destination. */
	mapping = 2,
}

export class GPUTimingProfiler {
	private readonly enabled: boolean;
	private readonly querySet: GPUQuerySet | null = null;
	private readonly resolveBuffer: GPUBuffer | null = null;
	private readonly maxQueries: number;

	/** Double-buffered readback frames. */
	private readonly frames: [ReadbackFrame, ReadbackFrame];
	private writeIdx = 0;

	/** Per-frame mutable state, reset in beginFrame(). */
	private queryCount = 0;
	private labels: string[] = [];

	/** Accumulated results for periodic console.log summary. */
	private readonly accumulated = new Map<string, number[]>();
	private frameCount = 0;
	private readonly logInterval: number;

	public constructor(device: GPUDevice, maxQueries = 32, logInterval = 120) {
		this.maxQueries = maxQueries;
		this.logInterval = logInterval;
		this.enabled = device.features.has("timestamp-query");

		if (!this.enabled) {
			this.frames = [nullFrame(), nullFrame()];
			return;
		}

		this.querySet = device.createQuerySet({
			type: "timestamp",
			count: maxQueries * 2,
		});

		const byteSize = maxQueries * 2 * 8;
		this.resolveBuffer = device.createBuffer({
			label: "Timestamp Resolve",
			size: byteSize,
			usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
		});

		this.frames = [
			createReadbackFrame(device, byteSize),
			createReadbackFrame(device, byteSize),
		];
	}

	/** Reset per-frame query state. Call at the start of each frame. */
	public beginFrame(): void {
		this.queryCount = 0;
		this.labels = [];
	}

	/**
	 * Returns a `timestampWrites` descriptor for a render pass.
	 * Returns `undefined` when profiling is disabled or query slots exhausted.
	 */
	public timestampWrites(
		label: string,
	):
		| (GPURenderPassTimestampWrites & GPUComputePassTimestampWrites)
		| undefined {
		if (!this.enabled || !this.querySet || this.queryCount >= this.maxQueries) {
			return undefined;
		}

		const idx = this.queryCount++;
		this.labels.push(label);

		return {
			querySet: this.querySet,
			beginningOfPassWriteIndex: idx * 2,
			endOfPassWriteIndex: idx * 2 + 1,
		};
	}

	/**
	 * Resolve timestamp queries into a staging buffer.
	 * Call after all render passes, before `encoder.finish()`.
	 */
	public resolve(encoder: GPUCommandEncoder): void {
		if (
			!this.enabled ||
			this.queryCount === 0 ||
			!this.querySet ||
			!this.resolveBuffer
		)
			return;

		const frame = this.frames[this.writeIdx];
		// Skip if buffer is still being mapped or already has unread data.
		if (frame.state !== FrameState.idle) return;

		const count = this.queryCount * 2;
		encoder.resolveQuerySet(this.querySet, 0, count, this.resolveBuffer, 0);
		encoder.copyBufferToBuffer(
			this.resolveBuffer,
			0,
			frame.buffer,
			0,
			count * 8,
		);

		frame.labels = this.labels.slice();
		frame.queryCount = this.queryCount;
		frame.state = FrameState.written;

		this.writeIdx ^= 1;
	}

	/**
	 * Initiate async readback of a written frame.
	 * Call after `queue.submit()`.  Non-blocking.
	 */
	public readback(): void {
		if (!this.enabled) return;

		for (const frame of this.frames) {
			if (frame.state !== FrameState.written) continue;

			frame.state = FrameState.mapping;
			frame.buffer
				.mapAsync(GPUMapMode.READ)
				.then(() => {
					const data = new BigUint64Array(frame.buffer.getMappedRange());

					for (let i = 0; i < frame.queryCount; i++) {
						const beginNs = data[i * 2];
						const endNs = data[i * 2 + 1];
						const durationMs = Number(endNs - beginNs) / 1_000_000;
						const label = frame.labels[i];

						// Draw-free passes can sample begin/end out of order on some
						// GPUs; a negative duration is invalid, not a real measurement.
						if (durationMs < 0) continue;

						let acc = this.accumulated.get(label);
						if (!acc) {
							acc = [];
							this.accumulated.set(label, acc);
						}
						acc.push(durationMs);
					}

					frame.buffer.unmap();
					frame.state = FrameState.idle;

					this.frameCount++;
					if (this.frameCount >= this.logInterval) {
						this.logAndReset();
					}
				})
				.catch(() => {
					frame.state = FrameState.idle;
				});

			break; // Only initiate one readback per call
		}
	}

	private logAndReset(): void {
		const lines: string[] = [];

		for (const [label, durations] of this.accumulated) {
			durations.sort((a, b) => a - b);
			const count = durations.length;
			const median = durations[Math.floor(count / 2)];
			const avg = durations.reduce((s, v) => s + v, 0) / count;
			const max = durations[count - 1];
			lines.push(
				`  ${label}: median=${median.toFixed(3)}ms avg=${avg.toFixed(3)}ms max=${max.toFixed(3)}ms (n=${count})`,
			);
		}

		if (lines.length > 0) {
			console.log(
				`[GPU Timing] ${this.frameCount} frames:\n${lines.join("\n")}`,
			);
		}

		this.accumulated.clear();
		this.frameCount = 0;
	}

	public destroy(): void {
		this.querySet?.destroy();
		this.resolveBuffer?.destroy();
		for (const frame of this.frames) {
			frame.buffer?.destroy();
		}
	}
}

interface ReadbackFrame {
	buffer: GPUBuffer;
	labels: string[];
	queryCount: number;
	state: FrameState;
}

function createReadbackFrame(
	device: GPUDevice,
	byteSize: number,
): ReadbackFrame {
	return {
		buffer: device.createBuffer({
			label: "Timestamp Readback",
			size: byteSize,
			usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
		}),
		labels: [],
		queryCount: 0,
		state: FrameState.idle,
	};
}

function nullFrame(): ReadbackFrame {
	return {
		buffer: null!,
		labels: [],
		queryCount: 0,
		state: FrameState.idle,
	};
}
