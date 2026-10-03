/**
 * Per-frame GPU texture pool.
 *
 * Offscreen render passes create and destroy many transient colour textures
 * every frame. TexturePool recycles them across frames so the GPU memory
 * allocator is only hit on the first few frames.
 *
 * Pool keys use SIZE_QUANTUM-quantized dimensions so that textures of
 * similar (but not identical) sizes share the same bucket, improving reuse.
 *
 * Pooled textures leave in least-recently-released order: at frame start
 * when they sat unused long enough (IdleClock.isExpired) or the pool is over
 * its memory budget, and on trimIdle() when they sat out recent frames.
 *
 * Usage:
 *   pool.resetFrame()            // start of a document frame — evict idle textures
 *   const t = pool.acquire(...)  // borrow a texture
 *   pool.release(t)              // return it (actual destroy is deferred)
 *   pool.trimIdle(n)             // between frames — free what sat out n frames
 *   const kept = pool.snapshot() // before a one-off render
 *   pool.trimToSnapshot(kept)    // after it — free what it left idle
 *   pool.destroy()               // teardown — destroy everything
 */

import { IdleClock, type UseStamp } from "./IdleClock";

/** Budget for pooled (idle) textures. A glass-solid + drop-shadow frame
 *  parks well over 128 MB between frames (offscreen colors, backdrop
 *  captures, bakes); a budget below the per-frame working set makes
 *  resetFrame evict everything just to re-allocate it next frame. */
const MAX_POOL_BYTES = 384 * 1024 * 1024;

/**
 * Size quantum for texture pool allocations.
 * Requests are rounded up to the nearest multiple so that small per-frame
 * size variations (e.g. 1-2 px during zoom) hit the same bucket and reuse
 * existing textures instead of allocating new ones every frame.
 */
const SIZE_QUANTUM = 128;

/** Round up to the nearest SIZE_QUANTUM multiple. */
export function quantizeSize(v: number): number {
	return Math.ceil(v / SIZE_QUANTUM) * SIZE_QUANTUM;
}

/** Estimate GPU memory for a texture based on format, dimensions, and sample count. */
function textureBytes(
	width: number,
	height: number,
	format: GPUTextureFormat,
	sampleCount: number,
): number {
	let bytesPerTexel: number;
	switch (format) {
		case "rgba16float":
			bytesPerTexel = 8;
			break;
		case "rgba8unorm":
		case "bgra8unorm":
			bytesPerTexel = 4;
			break;
		default:
			bytesPerTexel = 4;
	}
	return width * height * sampleCount * bytesPerTexel;
}

/** Ceiling for the canvas-scaled pool budget. */
const MAX_POOL_BYTES_CEILING = 1024 * 1024 * 1024;

/**
 * Pool budget for a given canvas size. A frame's transient working set
 * (offscreen colours, glass composites, backdrop captures) scales
 * with the canvas surface; a fixed budget below that working set makes
 * resetFrame evict canvas-sized textures every frame just to re-allocate
 * them the next one.
 */
export function texturePoolBudgetBytes(width: number, height: number): number {
	const canvasBytes = width * height * 4;
	return Math.min(
		MAX_POOL_BYTES_CEILING,
		Math.max(MAX_POOL_BYTES, canvasBytes * 16),
	);
}

export class TexturePool {
	/** Textures available for reuse, keyed by quantized spec string. */
	private readonly available = new Map<string, GPUTexture[]>();

	/** When each available texture was released. Map order is release order,
	 *  so iteration runs least recently used first. */
	private readonly releasedAt = new Map<
		GPUTexture,
		{ key: string; stamp: UseStamp }
	>();

	private readonly clock = new IdleClock();

	/** Textures currently lent out (for bookkeeping / destroy). */
	private readonly inUse = new Set<GPUTexture>();

	/** Total bytes of all textures currently sitting in the available pool. */
	private totalPooledBytes = 0;

	/** Budget for pooled (idle) textures; re-evaluated per canvas size. */
	private budgetBytes = MAX_POOL_BYTES;

	public constructor(private readonly device: GPUDevice) {}

	public getBudgetBytes(): number {
		return this.budgetBytes;
	}

	/** Update the pooled-bytes budget (eviction applies on the next resetFrame). */
	public setBudgetBytes(bytes: number): void {
		this.budgetBytes = bytes;
	}

	/**
	 * Acquire a texture matching the given spec.  Returns a pooled texture
	 * when one with matching quantized dimensions / format / sampleCount exists,
	 * otherwise allocates a new one.
	 *
	 * Width and height are rounded up to the next power of two for the pool
	 * key, so a 300x200 request and a 250x180 request both hit the same
	 * 512x256 bucket.  The actual texture is allocated at the quantized size
	 * so it can satisfy any request within the bucket.
	 *
	 * `usage` is only used for **new** allocations.  Pooled textures were
	 * created with the *union* of all usages requested so far for that spec
	 * -- callers should ensure they always request the same usage set for the
	 * same spec key.
	 */
	public acquire(
		width: number,
		height: number,
		format: GPUTextureFormat,
		sampleCount: number,
		usage: GPUTextureUsageFlags,
		label: string,
	): GPUTexture {
		// Snap dimensions to SIZE_QUANTUM so near-identical requests (e.g.
		// during zoom) share the same bucket and achieve exact-match reuse.
		const qw = Math.ceil(width / SIZE_QUANTUM) * SIZE_QUANTUM;
		const qh = Math.ceil(height / SIZE_QUANTUM) * SIZE_QUANTUM;
		const key = `${qw}x${qh}x${format}x${sampleCount}x${usage}`;
		const bucket = this.available.get(key);

		if (bucket && bucket.length > 0) {
			const tex = bucket.pop()!;
			this.releasedAt.delete(tex);
			this.totalPooledBytes -= textureBytes(
				tex.width,
				tex.height,
				tex.format,
				tex.sampleCount,
			);
			this.inUse.add(tex);
			return tex;
		}

		// Allocate at the quantized size.  All textures in the same bucket
		// share identical dimensions, so render-pass attachments (MSAA +
		// resolve target) always match.
		const tex = this.device.createTexture({
			label,
			size: { width: qw, height: qh },
			format,
			sampleCount,
			usage,
		});
		this.inUse.add(tex);
		return tex;
	}

	/**
	 * Acquire a texture at the exact requested size (no quantization).
	 * For consumers whose UV math assumes texture size == content size
	 * (backdrop region captures). `release()` keys by the texture's actual
	 * dimensions, so exact-size textures pool across frames like any other
	 * instead of being re-allocated every frame.
	 */
	public acquireExact(
		width: number,
		height: number,
		format: GPUTextureFormat,
		sampleCount: number,
		usage: GPUTextureUsageFlags,
		label: string,
	): GPUTexture {
		const key = `${width}x${height}x${format}x${sampleCount}x${usage}`;
		const bucket = this.available.get(key);
		if (bucket && bucket.length > 0) {
			const tex = bucket.pop()!;
			this.releasedAt.delete(tex);
			this.totalPooledBytes -= textureBytes(
				tex.width,
				tex.height,
				tex.format,
				tex.sampleCount,
			);
			this.inUse.add(tex);
			return tex;
		}
		const tex = this.device.createTexture({
			label,
			size: { width, height },
			format,
			sampleCount,
			usage,
		});
		this.inUse.add(tex);
		return tex;
	}

	/**
	 * Return a texture to the pool for reuse in future frames.
	 * Returns `true` if the texture belonged to this pool, `false` otherwise.
	 *
	 * Eviction is NOT performed here — textures released during a frame may
	 * still be referenced by in-flight command buffers. Call `resetFrame()`
	 * after queue.submit() to run budget eviction safely.
	 */
	public release(texture: GPUTexture | null | undefined): boolean {
		if (!texture) return false;
		if (!this.inUse.delete(texture)) return false; // not ours

		const { width, height, format, sampleCount, usage } = texture;
		// Textures are allocated at quantized size, so width/height are
		// already multiples of SIZE_QUANTUM. Use them directly as the key.
		const key = `${width}x${height}x${format}x${sampleCount}x${usage}`;

		let bucket = this.available.get(key);
		if (!bucket) {
			bucket = [];
			this.available.set(key, bucket);
		}
		bucket.push(texture);
		this.releasedAt.set(texture, { key, stamp: this.clock.stamp() });
		this.totalPooledBytes += textureBytes(width, height, format, sampleCount);

		return true;
	}

	/**
	 * Destroy a borrowed texture instead of returning it. For callers freeing
	 * cached results between frames, where a released texture would count as
	 * used in the last frame and survive the trim that freed its owner.
	 */
	public discard(texture: GPUTexture): void {
		this.inUse.delete(texture);
		texture.destroy();
	}

	/**
	 * Start a document frame: evict the textures that expired unused, then
	 * the least recently released ones while over budget. Call before the
	 * frame encodes anything, so no evicted texture is referenced by an
	 * unsubmitted command buffer.
	 */
	public resetFrame(): void {
		this.clock.tick();
		const now = performance.now();
		for (const [texture, { key, stamp }] of this.releasedAt) {
			if (
				!this.clock.isExpired(stamp, now) &&
				this.totalPooledBytes <= this.budgetBytes
			) {
				break;
			}
			this.evict(texture, key);
		}
	}

	/** Every texture the pool holds now, idle or lent out. */
	public snapshot(): ReadonlySet<GPUTexture> {
		return new Set([...this.releasedAt.keys(), ...this.inUse]);
	}

	/**
	 * Free the idle textures that were not in the pool when `snapshot` was
	 * taken. Call between frames only.
	 */
	public trimToSnapshot(snapshot: ReadonlySet<GPUTexture>): void {
		for (const [texture, { key }] of this.releasedAt) {
			if (!snapshot.has(texture)) this.evict(texture, key);
		}
	}

	/**
	 * Free the pooled textures that sat out the last `minIdleFrames` document
	 * frames; 0 frees every pooled texture. Call between frames only.
	 */
	public trimIdle(minIdleFrames: number): void {
		for (const [texture, { key, stamp }] of this.releasedAt) {
			if (!this.clock.isIdleFor(stamp, minIdleFrames)) break;
			this.evict(texture, key);
		}
	}

	/** Destroy all pooled textures and release GPU memory. */
	public destroy(): void {
		for (const bucket of this.available.values()) {
			for (const tex of bucket) tex.destroy();
		}
		this.available.clear();
		this.releasedAt.clear();

		for (const tex of this.inUse) tex.destroy();
		this.inUse.clear();

		this.totalPooledBytes = 0;
	}

	private evict(texture: GPUTexture, key: string): void {
		const bucket = this.available.get(key)!;
		bucket.splice(bucket.indexOf(texture), 1);
		if (bucket.length === 0) this.available.delete(key);
		this.releasedAt.delete(texture);
		this.totalPooledBytes -= textureBytes(
			texture.width,
			texture.height,
			texture.format,
			texture.sampleCount,
		);
		texture.destroy();
	}
}
