import type { EmbeddedFile } from "../../../schema";

/** A canvas's handle on the store. Every texture read through it is held
 *  for that canvas until the store releases the canvas. */
export interface ImageTextures {
	get(file: EmbeddedFile): GPUTexture | null;
	has(file: EmbeddedFile): boolean;
	/** Decode and upload `file` unless it is already loaded or loading. */
	ensure(file: EmbeddedFile): Promise<GPUTexture | null>;
}

/**
 * GPU textures of embedded image files, shared by every canvas target. They
 * are keyed by file uid and content hash: one uid can carry other bytes in
 * another revision of the document. Each texture lives while some canvas
 * holds it, so a closed preview's images go with it.
 */
export class ImageTextureStore {
	private readonly entries = new Map<
		string,
		{ texture: GPUTexture; holders: Set<string> }
	>();
	private readonly pendingLoads = new Map<
		string,
		{ promise: Promise<GPUTexture | null>; holders: Set<string> }
	>();

	/**
	 * @param onLoaded Called when a texture finishes loading, so canvases that
	 * drew a hole for it draw again.
	 */
	public constructor(
		private readonly device: GPUDevice,
		private readonly onLoaded: () => void,
	) {}

	/** The handle canvas `canvasId` reads and fills the store through. */
	public forCanvas(canvasId: string): ImageTextures {
		return {
			get: (file) => {
				const entry = this.entries.get(keyOf(file));
				entry?.holders.add(canvasId);
				return entry?.texture ?? null;
			},
			has: (file) => this.entries.has(keyOf(file)),
			ensure: (file) => this.ensure(file, canvasId),
		};
	}

	/** Drop `canvasId`'s holds, destroying the textures no canvas holds. */
	public release(canvasId: string): void {
		for (const [key, entry] of this.entries) {
			entry.holders.delete(canvasId);
			if (entry.holders.size > 0) continue;
			entry.texture.destroy();
			this.entries.delete(key);
		}
		for (const pending of this.pendingLoads.values()) {
			pending.holders.delete(canvasId);
		}
	}

	public destroy(): void {
		for (const entry of this.entries.values()) entry.texture.destroy();
		this.entries.clear();
		// A load still in flight finds no holders and destroys its texture.
		for (const pending of this.pendingLoads.values()) pending.holders.clear();
		this.pendingLoads.clear();
	}

	private ensure(
		file: EmbeddedFile,
		canvasId: string,
	): Promise<GPUTexture | null> {
		const key = keyOf(file);
		const entry = this.entries.get(key);
		if (entry) {
			entry.holders.add(canvasId);
			return Promise.resolve(entry.texture);
		}

		const pending = this.pendingLoads.get(key);
		if (pending) {
			pending.holders.add(canvasId);
			return pending.promise;
		}

		const holders = new Set([canvasId]);
		const promise = this.load(file).then((texture) => {
			if (this.pendingLoads.get(key)?.holders === holders) {
				this.pendingLoads.delete(key);
			}
			if (!texture) return null;
			if (holders.size === 0) {
				texture.destroy();
				return null;
			}
			this.entries.set(key, { texture, holders });
			this.onLoaded();
			return texture;
		});
		this.pendingLoads.set(key, { promise, holders });
		return promise;
	}

	private async load(file: EmbeddedFile): Promise<GPUTexture | null> {
		try {
			// Create Blob from Uint8Array (cast to ensure ArrayBuffer compatibility)
			const blob = new Blob([file.bin as BlobPart], { type: file.type });
			const imageBitmap = await createImageBitmap(blob);

			const texture = this.device.createTexture({
				label: `Image Texture: ${file.name}`,
				size: { width: imageBitmap.width, height: imageBitmap.height },
				format: "rgba8unorm",
				usage:
					GPUTextureUsage.TEXTURE_BINDING |
					GPUTextureUsage.COPY_DST |
					GPUTextureUsage.RENDER_ATTACHMENT,
			});

			// Copy ImageBitmap to GPUTexture with premultiplied alpha.
			// The blit pipeline uses premultiplied alpha blending
			// (srcFactor: "one"), so the texture must store premultiplied values.
			try {
				this.device.queue.copyExternalImageToTexture(
					{ source: imageBitmap },
					{ texture, premultipliedAlpha: true },
					{ width: imageBitmap.width, height: imageBitmap.height },
				);
			} catch {
				// dawn-node doesn't support copyExternalImageToTexture with ImageBitmap.
				// Decode with pngjs and write raw RGBA pixels via writeTexture.
				const { PNG } = await import("pngjs");
				const png = PNG.sync.read(Buffer.from(file.bin));
				const pixelData = Uint8Array.from(png.data);
				// Premultiply alpha to match blit pipeline expectations
				for (let i = 0; i < pixelData.length; i += 4) {
					const a = pixelData[i + 3] / 255;
					pixelData[i] = Math.round(pixelData[i] * a);
					pixelData[i + 1] = Math.round(pixelData[i + 1] * a);
					pixelData[i + 2] = Math.round(pixelData[i + 2] * a);
				}
				this.device.queue.writeTexture(
					{ texture },
					pixelData,
					{
						bytesPerRow: imageBitmap.width * 4,
						rowsPerImage: imageBitmap.height,
					},
					[imageBitmap.width, imageBitmap.height, 1],
				);
			}

			return texture;
		} catch (error) {
			console.error(`Failed to load image texture: ${file.name}`, error);
			return null;
		}
	}
}

// Helpers

function keyOf(file: EmbeddedFile): string {
	return `${file.uid}:${file.hash}`;
}
