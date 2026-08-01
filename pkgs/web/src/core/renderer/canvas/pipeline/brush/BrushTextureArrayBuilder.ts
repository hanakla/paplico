/**
 * BrushTextureArrayBuilder - Build GPU texture_2d_array from multiple brush textures.
 *
 * Collects unique texture UIDs, determines max dimensions, and copies each
 * texture into a layer of a single GPUTexture (texture_2d_array). Textures
 * smaller than the max are centered with transparent padding.
 *
 * Cached by sorted UID hash so repeated brush strokes reuse the same array.
 */

import type { BrushTextureManager } from "./BrushTextureManager";

export interface TextureArrayResult {
	texture: GPUTexture;
	sampler: GPUSampler;
	/** Ordered list of UIDs matching array layer indices */
	layerUids: string[];
	width: number;
	height: number;
}

export class BrushTextureArrayBuilder {
	private device: GPUDevice;
	private textureManager: BrushTextureManager;
	private cache: Map<string, TextureArrayResult> = new Map();

	public constructor(device: GPUDevice, textureManager: BrushTextureManager) {
		this.device = device;
		this.textureManager = textureManager;
	}

	/**
	 * Build or retrieve a cached texture_2d_array for the given UIDs.
	 * Returns null if any UID has no loaded texture.
	 */
	public build(uids: string[]): TextureArrayResult | null {
		if (uids.length === 0) return null;

		// Deduplicate while preserving order
		const seen = new Set<string>();
		const uniqueUids: string[] = [];
		for (const uid of uids) {
			if (!seen.has(uid)) {
				seen.add(uid);
				uniqueUids.push(uid);
			}
		}

		const cacheKey = [...uniqueUids].sort().join("|");
		const cached = this.cache.get(cacheKey);
		if (cached) return cached;

		// Determine max dimensions
		let maxW = 0;
		let maxH = 0;
		for (const uid of uniqueUids) {
			const size = this.textureManager.getTextureSize(uid);
			if (!size) return null;
			// Sources are copied into the rgba8unorm array below; textures in
			// any other format (def-rasterized textures use the canvas format)
			// are not copy-compatible, so bail out and let the caller fall back
			// to single-texture rendering.
			const sourceFormat = this.textureManager.getTexture(uid)?.format;
			if (sourceFormat !== "rgba8unorm") return null;
			if (size.width > maxW) maxW = size.width;
			if (size.height > maxH) maxH = size.height;
		}

		const layerCount = uniqueUids.length;
		const arrayTexture = this.device.createTexture({
			label: `brush-texture-array-${layerCount}layers`,
			size: [maxW, maxH, layerCount],
			format: "rgba8unorm",
			usage:
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST |
				GPUTextureUsage.RENDER_ATTACHMENT,
		});

		const encoder = this.device.createCommandEncoder({
			label: "brush-texture-array-copy",
		});

		for (let i = 0; i < layerCount; i++) {
			const uid = uniqueUids[i];
			const srcTexture = this.textureManager.getTexture(uid);
			const srcSize = this.textureManager.getTextureSize(uid)!;

			if (!srcTexture) {
				arrayTexture.destroy();
				return null;
			}

			// Center the source texture within the max-size layer
			const offsetX = Math.floor((maxW - srcSize.width) / 2);
			const offsetY = Math.floor((maxH - srcSize.height) / 2);

			encoder.copyTextureToTexture(
				{ texture: srcTexture },
				{ texture: arrayTexture, origin: [offsetX, offsetY, i] },
				[srcSize.width, srcSize.height, 1],
			);
		}

		this.device.queue.submit([encoder.finish()]);

		const result: TextureArrayResult = {
			texture: arrayTexture,
			sampler: this.textureManager.getSampler(),
			layerUids: uniqueUids,
			width: maxW,
			height: maxH,
		};

		this.cache.set(cacheKey, result);
		return result;
	}

	public destroy(): void {
		for (const result of this.cache.values()) {
			result.texture.destroy();
		}
		this.cache.clear();
	}
}
