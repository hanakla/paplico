/** Textures the pool keeps before retiring the oldest free one. */
const MAX_SCRATCH_TEXTURES = 24;

/**
 * Size-keyed pool of intermediate textures shared by filter passes.
 *
 * A texture stays checked out until it is released, so one chain never gets
 * the same texture twice (a pyramid level and its own source would otherwise
 * collide when a level's size repeats). Across chains reuse is safe: passes
 * execute in encode order, so the next chain's writes land after the previous
 * chain's reads.
 */
export class ScratchTexturePool {
	private free = new Map<string, GPUTexture[]>();
	private busy: Array<{ key: string; texture: GPUTexture }> = [];
	private total = 0;
	private pendingDestroy: GPUTexture[] = [];

	public acquire(
		device: GPUDevice,
		width: number,
		height: number,
		format: GPUTextureFormat,
		usage: GPUTextureUsageFlags,
		label: string,
	): GPUTexture {
		const key = `${width}x${height}:${format}:${usage}`;
		const pooled = this.free.get(key)?.pop();
		if (pooled) {
			this.busy.push({ key, texture: pooled });
			return pooled;
		}
		if (this.total >= MAX_SCRATCH_TEXTURES) this.retireOldestFree();
		const texture = device.createTexture({
			label,
			size: { width, height },
			format,
			usage,
		});
		this.total++;
		this.busy.push({ key, texture });
		return texture;
	}

	/** A render-target texture in `like`'s format, sized like it unless `size` says otherwise. */
	public acquireLike(
		device: GPUDevice,
		like: GPUTexture,
		label: string,
		size: { width: number; height: number } = like,
	): GPUTexture {
		return this.acquire(
			device,
			size.width,
			size.height,
			like.format,
			GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.COPY_DST,
			label,
		);
	}

	/** Return one texture handed out by acquire. */
	public release(texture: GPUTexture): void {
		const index = this.busy.findIndex((entry) => entry.texture === texture);
		if (index === -1) return;
		const [{ key }] = this.busy.splice(index, 1);
		const list = this.free.get(key);
		if (list) list.push(texture);
		else this.free.set(key, [texture]);
	}

	/** Return every texture handed out since the last call. */
	public releaseAll(): void {
		for (const { key, texture } of this.busy) {
			const list = this.free.get(key);
			if (list) list.push(texture);
			else this.free.set(key, [texture]);
		}
		this.busy.length = 0;
	}

	/** Destroy textures retired on a previous frame. Called once per frame,
	 *  after the previous frame's submit completed. */
	public flushPendingDestroy(): void {
		for (const texture of this.pendingDestroy) texture.destroy();
		this.pendingDestroy.length = 0;
	}

	public destroy(): void {
		this.releaseAll();
		for (const list of this.free.values()) {
			for (const texture of list) texture.destroy();
		}
		this.free.clear();
		this.total = 0;
		this.flushPendingDestroy();
	}

	private retireOldestFree(): void {
		for (const [key, list] of this.free) {
			const texture = list.pop();
			if (!texture) continue;
			if (list.length === 0) this.free.delete(key);
			// Deferred: passes encoded this frame may still reference it.
			this.pendingDestroy.push(texture);
			this.total--;
			return;
		}
	}
}
