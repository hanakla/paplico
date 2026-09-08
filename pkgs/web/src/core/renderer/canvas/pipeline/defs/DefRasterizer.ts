/**
 * Rasterizes off-canvas def trees into persistent GPUTextures keyed by
 * `def:${defId}:${revision}:${w}x${h}`. Each entry is a long-lived texture (NOT
 * borrowed from TexturePool — those are short-lived and recycled per frame)
 * because both pattern fill sampling and brush stamp sampling read from the
 * same texture across many frames.
 *
 * The actual rendering of def contents into a texture is delegated to a
 * `renderFn` supplied by CanvasLayer; the rasterizer itself only handles
 * caching, invalidation, and resolution banding so that the GPU plumbing
 * (uniform scope, viewport overrides) stays where it is.
 */

export interface DefRasterizerOptions {
	/**
	 * Optional cap on cached entries. When exceeded the least-recently-used
	 * entry is evicted. Defaults to 32, which comfortably covers a handful of
	 * defs across several zoom bands.
	 */
	maxEntries?: number;
	/**
	 * Invoked with the entry's textureUid just before its texture is destroyed
	 * (LRU eviction / invalidation), so consumers holding the uid (e.g.
	 * BrushTextureManager's def aliases) can drop their references.
	 */
	onEvicted?: (textureUid: string) => void;
}

export type DefRasterRenderFn = (
	defId: string,
	width: number,
	height: number,
) => GPUTexture | null;

/** Resolution banding mode. Each consumer picks the band that matches its use. */
export type DefResolutionMode =
	| {
			/** scatter / vector brush source: long edge clamped to pow2(64..1024). */
			kind: "scatter";
			/** Logical (world-space) size of the source bounding box. */
			worldSize: { width: number; height: number };
			/** Current viewport zoom factor at the time of rendering. */
			zoom: number;
	  }
	| {
			/** Pattern tile target: tile size × target scale, clamped 64..2048. */
			kind: "pattern";
			tileWorldSize: { width: number; height: number };
			targetScale: number;
	  };

interface CacheEntry {
	texture: GPUTexture;
	width: number;
	height: number;
	textureUid: string;
	/** Monotonic last-use timestamp for LRU eviction. */
	lastUsed: number;
}

export class DefRasterizer {
	private readonly maxEntries: number;
	private readonly onEvicted?: (textureUid: string) => void;
	private cache = new Map<string, CacheEntry>();
	private lruCounter = 0;

	public constructor(options: DefRasterizerOptions = {}) {
		this.maxEntries = options.maxEntries ?? 32;
		this.onEvicted = options.onEvicted;
	}

	/**
	 * Build the stable cache key for a def at a target resolution. Consumers
	 * (brushSource, pattern fill) include this string in their own cache keys
	 * so that stamp / gradient / geometry caches self-invalidate alongside the
	 * underlying texture.
	 */
	public static textureUidFor(
		defId: string,
		revision: number,
		width: number,
		height: number,
	): string {
		return `def:${defId}:${revision}:${width}x${height}`;
	}

	/**
	 * Quantize a target resolution into one of the documented pow2 bands so
	 * minor zoom / size jitter does not thrash the cache.
	 */
	public static resolveTargetSize(mode: DefResolutionMode): {
		width: number;
		height: number;
	} {
		if (mode.kind === "scatter") {
			const longEdge = Math.max(mode.worldSize.width, mode.worldSize.height);
			const targetPx = Math.max(1, longEdge * Math.max(mode.zoom, 0.0001) * 2);
			const banded = clamp(pow2Ceil(targetPx), 64, 1024);
			// Preserve aspect ratio at banded resolution.
			const aspect =
				mode.worldSize.width > 0 && mode.worldSize.height > 0
					? mode.worldSize.width / mode.worldSize.height
					: 1;
			if (aspect >= 1) {
				return {
					width: banded,
					height: Math.max(1, Math.round(banded / aspect)),
				};
			}
			return {
				width: Math.max(1, Math.round(banded * aspect)),
				height: banded,
			};
		}
		// pattern tile
		const longEdge = Math.max(
			mode.tileWorldSize.width,
			mode.tileWorldSize.height,
		);
		const targetPx = Math.max(1, longEdge * Math.max(mode.targetScale, 0.0001));
		const banded = clamp(pow2Ceil(targetPx), 64, 2048);
		const aspect =
			mode.tileWorldSize.width > 0 && mode.tileWorldSize.height > 0
				? mode.tileWorldSize.width / mode.tileWorldSize.height
				: 1;
		if (aspect >= 1) {
			return {
				width: banded,
				height: Math.max(1, Math.round(banded / aspect)),
			};
		}
		return {
			width: Math.max(1, Math.round(banded * aspect)),
			height: banded,
		};
	}

	/**
	 * Look up a cached rasterized def at the given resolution. Falls through to
	 * `renderFn` on miss; the returned texture is retained in the cache. Returns
	 * `null` if rendering failed (e.g. the def is unresolvable or rendered into
	 * no pixels).
	 */
	public ensureRasterized(
		defId: string,
		revision: number,
		width: number,
		height: number,
		renderFn: DefRasterRenderFn,
	): { texture: GPUTexture; textureUid: string } | null {
		const key = DefRasterizer.textureUidFor(defId, revision, width, height);
		const existing = this.cache.get(key);
		if (existing) {
			existing.lastUsed = ++this.lruCounter;
			return { texture: existing.texture, textureUid: existing.textureUid };
		}

		const texture = renderFn(defId, width, height);
		if (!texture) return null;

		this.cache.set(key, {
			texture,
			width,
			height,
			textureUid: key,
			lastUsed: ++this.lruCounter,
		});
		this.evictIfNeeded();
		return { texture, textureUid: key };
	}

	/** Drop every cached entry whose key starts with `def:${defId}:`. */
	public invalidate(defId: string): void {
		const prefix = `def:${defId}:`;
		for (const [key, entry] of this.cache) {
			if (key.startsWith(prefix)) {
				this.onEvicted?.(entry.textureUid);
				entry.texture.destroy();
				this.cache.delete(key);
			}
		}
	}

	/** Drop every cached entry (e.g. document replace). */
	public invalidateAll(): void {
		for (const entry of this.cache.values()) {
			this.onEvicted?.(entry.textureUid);
			entry.texture.destroy();
		}
		this.cache.clear();
	}

	/** Release every cached texture. Call from CanvasLayer.destroy. */
	public destroy(): void {
		this.invalidateAll();
	}

	private evictIfNeeded(): void {
		while (this.cache.size > this.maxEntries) {
			let oldestKey: string | null = null;
			let oldestTs = Number.POSITIVE_INFINITY;
			for (const [key, entry] of this.cache) {
				if (entry.lastUsed < oldestTs) {
					oldestTs = entry.lastUsed;
					oldestKey = key;
				}
			}
			if (!oldestKey) return;
			const evicted = this.cache.get(oldestKey)!;
			this.onEvicted?.(evicted.textureUid);
			evicted.texture.destroy();
			this.cache.delete(oldestKey);
		}
	}
}

// Helpers

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function pow2Ceil(value: number): number {
	if (value <= 1) return 1;
	let p = 1;
	while (p < value) p *= 2;
	return p;
}
