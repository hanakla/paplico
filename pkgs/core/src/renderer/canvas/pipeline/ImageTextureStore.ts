import type { BoundingBox, EmbeddedFile } from "../../../schema";
import { IdleClock, type UseStamp } from "./IdleClock";

/** Images decoded and uploaded at once. Uploads run through the GPU process,
 *  so a document's worth of them at once starves the frames behind them. */
const MAX_CONCURRENT_LOADS = 256;
/** Previews prefetched at once, so the images a canvas waits for are not
 *  queued behind a whole document's worth of them. */
const MAX_CONCURRENT_PREFETCHES = 8;
/** How long after a view change no new image load starts, so a pan or zoom
 *  in progress does not compete with the loads for the GPU. */
const LOAD_HOLD_MS = 100;
/** How long after the hold ends a canvas may keep waiting for the loads
 *  asked for during a gesture before it draws without them. */
const MAX_LOAD_WAIT_MS = 300;
/** How often the canvases hear that images arrived while more are in flight.
 *  Each time costs them a full redraw. */
const LOADED_NOTIFY_INTERVAL_MS = 500;
/** Longer side of an image's preview texture, in texels. */
const PREVIEW_MAX_SIDE = 512;
/** The most a preview holds: a square one. */
const MAX_PREVIEW_BYTES = PREVIEW_MAX_SIDE * PREVIEW_MAX_SIDE * 4;
/** How far a preview may be stretched before the whole image replaces it. A
 *  stretch this small is not seen, and the whole image costs a redraw. */
const PREVIEW_STRETCH_LIMIT = 1.25;
/** How long a texture must sit unused before the budget may free it. A load
 *  that lands is drawn a moment later, by the redraw it asks for. */
const MIN_IDLE_MS = 2_000;

/** A canvas's handle on the store. Every texture read through it is held
 *  for that canvas until the store releases the canvas. */
export interface ImageTextures {
	/**
	 * The texture to draw `file` with over the world `bounds`: the preview
	 * when that is sharp enough at the canvas's density, the whole image
	 * otherwise or without `bounds`. While the whole image loads, its preview
	 * stands in. Null until either has loaded; the load starts here.
	 */
	get(file: EmbeddedFile, bounds?: BoundingBox): GPUTexture | null;
	/** Start the load `get` would start for the same arguments, for an image
	 *  the canvas is about to draw. Its arrival asks for no redraw. */
	request(file: EmbeddedFile, bounds: BoundingBox): void;
	/** How much of `file` is loaded. A frame that asks keeps what it found
	 *  in use, like one that draws it: a picture cached from that state stays
	 *  valid only while the state holds. */
	stateOf(file: EmbeddedFile): ImageLoadState;
	/** Count the frame in progress with the one before it: it draws only part
	 *  of the view, so what the earlier frame drew is still on screen. */
	continueLastFrame(): void;
	/** Decode and upload the whole of `file` unless it is already loaded or
	 *  loading. */
	ensure(file: EmbeddedFile): Promise<GPUTexture | null>;
}

/** How much of an image the store holds: nothing, its preview, or the image
 *  at its own size. Each step changes what a draw of the image shows. */
export type ImageLoadState = "none" | "preview" | "whole";

interface TextureEntry {
	texture: GPUTexture;
	bytes: number;
	holders: Set<string>;
	lastUse: UseStamp;
}

interface QueuedLoad {
	file: EmbeddedFile;
	pendingKey: string;
	maxSide: number;
	resolve: (loaded: LoadedImage | null) => void;
}

interface LoadedImage {
	texture: GPUTexture;
	bytes: number;
	/** Whether the texture holds the image at its own size. */
	isWhole: boolean;
}

/**
 * GPU textures of embedded image files, shared by every canvas target. They
 * are keyed by file uid and content hash: one uid can carry other bytes in
 * another revision of the document. Each texture lives while some canvas
 * holds it, so a closed preview's images go with it.
 *
 * An image's bytes never change under its key, so a texture is made once
 * and reused. Every image gets a small preview ahead of time, which is all a
 * zoomed-out view draws; the whole image loads when a canvas shows it larger
 * than its preview.
 *
 * The textures together stay within `maxBytes`, except for the ones the
 * latest frame with images used and the ones used within `MIN_IDLE_MS`. Past
 * it, the textures used longest ago are freed and load again when a canvas
 * next draws them.
 */
export class ImageTextureStore {
	private readonly entries = new Map<string, TextureEntry>();
	private readonly previews = new Map<string, TextureEntry>();
	private readonly pendingLoads = new Map<
		string,
		{ promise: Promise<GPUTexture | null>; holders: Set<string> }
	>();
	/** Loads a canvas waits for, then the previews fetched ahead of need. */
	private readonly loadQueue: QueuedLoad[] = [];
	private readonly prefetchQueue: QueuedLoad[] = [];
	/** Keys a canvas drew without the texture it asked for. */
	private readonly wantedKeys = new Set<string>();
	/** Ticks once per frame that uses an image. */
	private readonly clock = new IdleClock();
	private isFrameUnused = true;
	private exportsInProgress = 0;
	private residentBytes = 0;
	private activeLoads = 0;
	private activePrefetches = 0;
	private loadsHeldUntil = 0;
	private holdTimer: ReturnType<typeof setTimeout> | null = null;
	private notifyTimer: ReturnType<typeof setTimeout> | null = null;
	private isNotifyQueued = false;

	/**
	 * @param onLoaded Called when a texture finishes loading, so canvases that
	 * drew a hole for it draw again.
	 * @param maxBytes Bytes the textures may hold together.
	 */
	public constructor(
		private readonly device: GPUDevice,
		private readonly onLoaded: () => void,
		private readonly maxBytes = Number.POSITIVE_INFINITY,
	) {}

	/**
	 * The handle canvas `canvasId` reads and fills the store through.
	 * @param texelsPerWorldUnit The density the canvas draws at right now.
	 */
	public forCanvas(
		canvasId: string,
		texelsPerWorldUnit: () => number = () => Number.POSITIVE_INFINITY,
	): ImageTextures {
		return {
			get: (file, bounds) => {
				const { texture, isSharp } = this.lookup(
					file,
					canvasId,
					bounds
						? longerSide(bounds) * texelsPerWorldUnit()
						: Number.POSITIVE_INFINITY,
				);
				if (!isSharp) this.wantedKeys.add(keyOf(file));
				return texture;
			},
			request: (file, bounds) => {
				this.lookup(file, canvasId, longerSide(bounds) * texelsPerWorldUnit());
			},
			stateOf: (file) => {
				const key = keyOf(file);
				const whole = this.entries.get(key);
				const found = whole ?? this.previews.get(key);
				if (!found) return "none";
				this.use(found, canvasId);
				return whole ? "whole" : "preview";
			},
			continueLastFrame: () => {
				this.isFrameUnused = false;
			},
			ensure: (file) => this.ensure(file, canvasId),
		};
	}

	/** Whether loads asked for during a gesture are still on their way and
	 *  worth waiting for before drawing the view the gesture ended on. */
	public get hasLoadsToAwait(): boolean {
		return (
			(this.loadQueue.length > 0 || this.activeLoads > 0) &&
			performance.now() < this.loadsHeldUntil + MAX_LOAD_WAIT_MS
		);
	}

	/**
	 * Hold every texture from here until `endExport`: an export loads its
	 * images, then draws them later, with frames of the canvases in between.
	 * Its own uses do not count as a frame, so what the canvases show is not
	 * taken for unused.
	 */
	public beginExport(): void {
		this.exportsInProgress++;
	}

	public endExport(): void {
		this.exportsInProgress--;
	}

	/**
	 * Start a frame: free the textures past the budget that the latest frame
	 * with images did not use. Runs before the frame reads any texture, when
	 * every earlier frame is already submitted. Frees nothing during an
	 * export.
	 */
	public beginFrame(): void {
		if (this.exportsInProgress > 0) return;
		this.isFrameUnused = true;
		if (this.residentBytes <= this.maxBytes) return;
		const now = performance.now();
		const idle = [this.entries, this.previews]
			.flatMap((textures) =>
				[...textures].map(([key, entry]) => ({ textures, key, entry })),
			)
			.filter(
				({ entry }) =>
					this.clock.isIdleFor(entry.lastUse, 1) &&
					now - entry.lastUse.time >= MIN_IDLE_MS,
			)
			.sort((a, b) => a.entry.lastUse.time - b.entry.lastUse.time);
		for (const { textures, key } of idle) {
			if (this.residentBytes <= this.maxBytes) break;
			this.free(textures, key);
		}
	}

	/** Load the preview of every image in `files` in the background, so a
	 *  canvas that later shows one has it at hand. The previews the budget
	 *  leaves no room for load when a canvas draws them. */
	public prefetchPreviews(
		files: readonly EmbeddedFile[],
		canvasId: string,
	): void {
		for (const file of files) {
			if (file.type.startsWith("image/")) {
				this.ensurePreview(file, canvasId, false);
			}
		}
	}

	/** Keep new loads from starting for a moment, so a pan or zoom in progress
	 *  does not compete with them for the GPU. */
	public holdLoads(): void {
		this.loadsHeldUntil = performance.now() + LOAD_HOLD_MS;
	}

	/** Drop `canvasId`'s holds, destroying the textures no canvas holds. */
	public release(canvasId: string): void {
		for (const textures of [this.entries, this.previews]) {
			for (const [key, entry] of textures) {
				entry.holders.delete(canvasId);
				if (entry.holders.size === 0) this.free(textures, key);
			}
		}
		for (const pending of this.pendingLoads.values()) {
			pending.holders.delete(canvasId);
		}
	}

	public destroy(): void {
		for (const textures of [this.entries, this.previews]) {
			for (const key of [...textures.keys()]) this.free(textures, key);
		}
		// A load still in flight finds no holders and destroys its texture.
		for (const pending of this.pendingLoads.values()) pending.holders.clear();
		this.pendingLoads.clear();
		for (const queue of [this.loadQueue, this.prefetchQueue]) {
			for (const queued of queue.splice(0)) queued.resolve(null);
		}
		this.wantedKeys.clear();
		if (this.holdTimer != null) clearTimeout(this.holdTimer);
		if (this.notifyTimer != null) clearTimeout(this.notifyTimer);
		this.holdTimer = null;
		this.notifyTimer = null;
	}

	/**
	 * The sharpest texture of `file` at hand, and whether it is sharp enough
	 * where its longer side spans `texels`. When it is not, the load of one
	 * that is starts here.
	 */
	private lookup(
		file: EmbeddedFile,
		canvasId: string,
		texels: number,
	): { texture: GPUTexture | null; isSharp: boolean } {
		const key = keyOf(file);
		const whole = this.entries.get(key);
		if (whole) {
			this.use(whole, canvasId);
			return { texture: whole.texture, isSharp: true };
		}
		const preview = this.previews.get(key);
		if (preview) this.use(preview, canvasId);
		const previewSuffices = texels <= PREVIEW_MAX_SIDE * PREVIEW_STRETCH_LIMIT;
		if (preview && previewSuffices) {
			return { texture: preview.texture, isSharp: true };
		}
		if (previewSuffices) this.ensurePreview(file, canvasId, true);
		else void this.ensure(file, canvasId);
		return { texture: preview?.texture ?? null, isSharp: false };
	}

	private ensure(
		file: EmbeddedFile,
		canvasId: string,
	): Promise<GPUTexture | null> {
		const key = keyOf(file);
		const entry = this.entries.get(key);
		if (entry) {
			this.use(entry, canvasId);
			return Promise.resolve(entry.texture);
		}
		return this.startLoad(file, canvasId, {
			pendingKey: `${key}|whole`,
			maxSide: Number.POSITIVE_INFINITY,
			isUrgent: true,
		});
	}

	private ensurePreview(
		file: EmbeddedFile,
		canvasId: string,
		isUrgent: boolean,
	): void {
		const key = keyOf(file);
		if (this.entries.has(key) || this.previews.has(key)) return;
		// The whole image is on its way and serves in the preview's place.
		if (this.pendingLoads.has(`${key}|whole`)) return;
		void this.startLoad(file, canvasId, {
			pendingKey: `${key}|preview`,
			maxSide: PREVIEW_MAX_SIDE,
			isUrgent,
		});
	}

	private startLoad(
		file: EmbeddedFile,
		canvasId: string,
		{
			pendingKey,
			maxSide,
			isUrgent,
		}: { pendingKey: string; maxSide: number; isUrgent: boolean },
	): Promise<GPUTexture | null> {
		const pending = this.pendingLoads.get(pendingKey);
		if (pending) {
			pending.holders.add(canvasId);
			if (isUrgent) this.promote(pendingKey);
			return pending.promise;
		}

		const key = keyOf(file);
		const holders = new Set([canvasId]);
		const promise = new Promise<LoadedImage | null>((resolve) => {
			(isUrgent ? this.loadQueue : this.prefetchQueue).push({
				file,
				pendingKey,
				maxSide,
				resolve,
			});
		}).then((loaded) => {
			if (this.pendingLoads.get(pendingKey)?.holders === holders) {
				this.pendingLoads.delete(pendingKey);
			}
			if (!loaded) return null;
			if (holders.size === 0) {
				loaded.texture.destroy();
				return null;
			}
			const textures = loaded.isWhole ? this.entries : this.previews;
			// An image no larger than a preview arrives whole from either load.
			const earlier = textures.get(key);
			if (earlier) {
				loaded.texture.destroy();
				for (const holder of holders) earlier.holders.add(holder);
				return earlier.texture;
			}
			textures.set(key, {
				texture: loaded.texture,
				bytes: loaded.bytes,
				holders,
				lastUse: this.clock.stamp(),
			});
			this.residentBytes += loaded.bytes;
			// Only a texture some canvas drew without changes a picture.
			if (this.wantedKeys.has(key)) {
				if (loaded.isWhole) this.wantedKeys.delete(key);
				this.notifyLoaded();
			}
			return loaded.texture;
		});
		// The next load starts once this one is counted against the budget.
		void promise.finally(() => this.pumpLoads());
		this.pendingLoads.set(pendingKey, { promise, holders });
		this.pumpLoads();
		return promise;
	}

	/** Move a prefetch a canvas now waits for ahead of the other prefetches. */
	private promote(pendingKey: string): void {
		const index = this.prefetchQueue.findIndex(
			(queued) => queued.pendingKey === pendingKey,
		);
		if (index < 0) return;
		this.loadQueue.push(...this.prefetchQueue.splice(index, 1));
		this.pumpLoads();
	}

	private pumpLoads(): void {
		const heldFor = this.loadsHeldUntil - performance.now();
		if (heldFor > 0) {
			this.holdTimer ??= setTimeout(() => {
				this.holdTimer = null;
				this.pumpLoads();
			}, heldFor);
			return;
		}
		while (this.activeLoads + this.activePrefetches < MAX_CONCURRENT_LOADS) {
			const urgent = this.loadQueue.shift();
			const next =
				urgent ??
				(this.activePrefetches < MAX_CONCURRENT_PREFETCHES &&
				this.residentBytes + this.activePrefetches * MAX_PREVIEW_BYTES <
					this.maxBytes
					? this.prefetchQueue.shift()
					: undefined);
			if (!next) return;
			if (urgent) this.activeLoads++;
			else this.activePrefetches++;
			void this.load(next.file, next.maxSide).then((loaded) => {
				if (urgent) this.activeLoads--;
				else this.activePrefetches--;
				next.resolve(loaded);
			});
		}
	}

	/** Mark `entry` as used by `canvasId` in the frame in progress. */
	private use(entry: TextureEntry, canvasId: string): void {
		if (this.isFrameUnused && this.exportsInProgress === 0) {
			this.isFrameUnused = false;
			this.clock.tick();
		}
		entry.holders.add(canvasId);
		entry.lastUse = this.clock.stamp();
	}

	private free(textures: Map<string, TextureEntry>, key: string): void {
		const entry = textures.get(key);
		if (!entry) return;
		entry.texture.destroy();
		this.residentBytes -= entry.bytes;
		textures.delete(key);
	}

	/** Tell the canvases an image arrived. While more they wait for are in
	 *  flight they hear it once per interval. The last of those is announced
	 *  at once: the canvases wait on it to finish their picture. */
	private notifyLoaded(): void {
		const now = performance.now();
		const isDrained = this.loadQueue.length === 0 && this.activeLoads === 0;
		const wait = Math.max(
			isDrained ? 0 : LOADED_NOTIFY_INTERVAL_MS,
			this.loadsHeldUntil - now,
		);
		if (wait > 0) {
			this.notifyTimer ??= setTimeout(() => {
				this.notifyTimer = null;
				this.onLoaded();
			}, wait);
			return;
		}
		// Images that finish in the same task are announced together.
		if (this.isNotifyQueued) return;
		this.isNotifyQueued = true;
		queueMicrotask(() => {
			this.isNotifyQueued = false;
			if (this.notifyTimer != null) clearTimeout(this.notifyTimer);
			this.notifyTimer = null;
			this.onLoaded();
		});
	}

	private async load(
		file: EmbeddedFile,
		maxSide: number,
	): Promise<LoadedImage | null> {
		try {
			// Create Blob from Uint8Array (cast to ensure ArrayBuffer compatibility)
			const blob = new Blob([file.bin as BlobPart], { type: file.type });
			const { imageBitmap, isScaled } = await decodeWithinSide(
				blob,
				Math.min(maxSide, this.device.limits.maxTextureDimension2D),
			);

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

			// An image past the texture limit has no larger texture to wait for.
			return {
				texture,
				bytes: imageBitmap.width * imageBitmap.height * 4,
				isWhole: !isScaled || maxSide > PREVIEW_MAX_SIDE,
			};
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

function longerSide(bounds: BoundingBox): number {
	return Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
}

/** Decode `blob`, scaled down to fit `maxSide` when a side exceeds it. An
 *  image element is placed by its own width and height, so a smaller texture
 *  covers the same area. */
async function decodeWithinSide(
	blob: Blob,
	maxSide: number,
): Promise<{ imageBitmap: ImageBitmap; isScaled: boolean }> {
	const original = await createImageBitmap(blob);
	const scale = maxSide / Math.max(original.width, original.height);
	if (scale >= 1) return { imageBitmap: original, isScaled: false };

	try {
		const imageBitmap = await createImageBitmap(original, {
			resizeWidth: Math.max(1, Math.floor(original.width * scale)),
			resizeHeight: Math.max(1, Math.floor(original.height * scale)),
			resizeQuality: "high",
		});
		return { imageBitmap, isScaled: true };
	} finally {
		original.close();
	}
}
