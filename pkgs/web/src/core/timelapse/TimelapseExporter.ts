import { type Artboard, type Document, getArtboardBounds } from "../schema";
import type { TimelapsePlayer } from "./TimelapsePlayer";
import type { TimelapsePreviewSurface } from "./TimelapsePreviewSurface";

const INTRO_COMPLETE_MS = 400;
const INTRO_FADEOUT_MS = 300;
/** Must match TimelapsePlayer.EVENT_INTERVAL_MS */
const EVENT_INTERVAL_MS = 100;

/**
 * Export timelapse as MP4 using WebCodecs API + MediaBunny.
 * Returns false from isSupported() on browsers without WebCodecs support.
 *
 * The exported video starts with the completed work shown for ~400ms,
 * then fades out to white over ~300ms, then plays the timelapse from the beginning.
 *
 * Note: Artboard filtering is controlled by the TimelapsePlayer instance passed to the constructor.
 * Create TimelapsePlayer with filterArtboard parameter to filter out updates outside that artboard.
 */
export class TimelapseExporter {
	public constructor(
		private surface: TimelapsePreviewSurface,
		private player: TimelapsePlayer,
	) {}

	public static isSupported(): boolean {
		return typeof VideoEncoder !== "undefined";
	}

	public async exportMP4(options: {
		artboard: Artboard;
		fps?: number;
		speed?: number;
		scale?: number;
		onProgress?: (progress: number) => void;
	}): Promise<Blob> {
		const { artboard, fps = 30, speed = 1, scale = 1, onProgress } = options;

		// Dynamic import: keep mediabunny out of the main bundle since it's only needed for export
		const {
			Output,
			Mp4OutputFormat,
			BufferTarget,
			EncodedVideoPacketSource,
			EncodedPacket,
		} = await import("mediabunny");

		const bounds = getArtboardBounds(artboard);
		const rawWidth = Math.ceil(bounds.width * scale);
		const rawHeight = Math.ceil(bounds.height * scale);
		// H.264 requires even dimensions
		const encWidth = rawWidth + (rawWidth % 2);
		const encHeight = rawHeight + (rawHeight % 2);

		const target = new BufferTarget();
		const videoSource = new EncodedVideoPacketSource("avc");
		const output = new Output({
			format: new Mp4OutputFormat({ fastStart: "in-memory" }),
			target,
		});
		output.addVideoTrack(videoSource);
		await output.start();

		let encoderError: Error | null = null;

		const encoder = new VideoEncoder({
			output: (chunk, meta) =>
				videoSource.add(EncodedPacket.fromEncodedChunk(chunk), meta),
			error: (e) => {
				encoderError = new Error(`VideoEncoder error: ${e.message}`);
			},
		});

		encoder.configure({
			codec: "avc1.640028",
			width: encWidth,
			height: encHeight,
			bitrate: 5_000_000,
			framerate: fps,
		});

		const totalEvents = this.player.totalEvents;
		let frameIndex = 0;

		// The video runs on the preview's clock: one video frame is one tick of
		// it. Stepping event-by-event instead would skip every intermediate
		// draw-on frame, which is the whole point of a timelapse.
		const frameDurationMs = 1000 / fps;
		this.player.setSpeed(speed);

		const encodeFrame = (pixels: Uint8ClampedArray, keyFrame: boolean) => {
			if (encoderError) throw encoderError;

			const frame = new VideoFrame(pixels, {
				format: "RGBA",
				codedWidth: encWidth,
				codedHeight: encHeight,
				timestamp: (frameIndex * 1_000_000) / fps,
				duration: 1_000_000 / fps,
			});
			encoder.encode(frame, { keyFrame });
			frame.close();
			frameIndex++;
		};

		// --- Intro: render the completed work ---
		const completedImage = await this.renderFrame(
			this.player.captureCompletedFrame(),
			artboard,
			scale,
		);
		const completedPixels = this.padToEncoder(
			completedImage,
			encWidth,
			encHeight,
		);

		// Hold completed frame
		const holdFrames = Math.ceil((INTRO_COMPLETE_MS / 1000) * fps);
		for (let f = 0; f < holdFrames; f++) {
			encodeFrame(completedPixels, f === 0);
			if (f % 10 === 0) await this.yieldIfNeeded(encoder);
		}

		// Fade out to white
		const fadeFrames = Math.ceil((INTRO_FADEOUT_MS / 1000) * fps);
		for (let f = 0; f < fadeFrames; f++) {
			const t = (f + 1) / fadeFrames; // 0→1 progress
			const fadedPixels = blendToWhite(completedPixels, t, encWidth, encHeight);
			encodeFrame(fadedPixels, false);
			if (f % 5 === 0) await this.yieldIfNeeded(encoder);
		}

		// --- Timelapse from the beginning ---
		// The player only moves forward here, so it never rewinds its replay
		// document. A step that changes nothing reuses the previous pixels
		// rather than re-rendering them.
		let framePixels = this.padToEncoder(
			await this.renderFrame(this.player.restart(), artboard, scale),
			encWidth,
			encHeight,
		);

		while (!this.player.hasFinished) {
			if (encoderError) throw encoderError;

			const frame = this.player.advanceBy(frameDurationMs);
			if (frame) {
				framePixels = this.padToEncoder(
					await this.renderFrame(frame, artboard, scale),
					encWidth,
					encHeight,
				);
			}
			encodeFrame(framePixels, frameIndex % (fps * 2) === 0);

			onProgress?.(
				Math.min(1, (this.player.currentIndex + 1) / Math.max(1, totalEvents)),
			);
			await this.yieldIfNeeded(encoder);
		}

		await encoder.flush();
		encoder.close();

		if (encoderError) throw encoderError;

		await output.finalize();

		return new Blob([target.buffer!], { type: "video/mp4" });
	}

	private padToEncoder(
		imageData: ImageData,
		encWidth: number,
		encHeight: number,
	): Uint8ClampedArray {
		if (imageData.width === encWidth && imageData.height === encHeight) {
			return imageData.data;
		}
		return padPixels(
			imageData.data,
			imageData.width,
			imageData.height,
			encWidth,
			encHeight,
		);
	}

	private async yieldIfNeeded(encoder: VideoEncoder): Promise<void> {
		if (encoder.encodeQueueSize > 5) {
			await new Promise<void>((r) => setTimeout(r, 0));
		}
	}

	private async renderFrame(
		document: Document,
		artboard: Artboard,
		scale: number,
	): Promise<ImageData> {
		const imageData = await this.surface.renderToImageData(
			document,
			artboard,
			scale,
		);
		if (!imageData) throw new Error("Render failed");
		return imageData;
	}
}

/** Pad RGBA pixel data from srcW×srcH to dstW×dstH, filling extra pixels with white opaque. */
function padPixels(
	src: Uint8ClampedArray,
	srcW: number,
	srcH: number,
	dstW: number,
	dstH: number,
): Uint8ClampedArray {
	const dst = new Uint8ClampedArray(dstW * dstH * 4);
	// Fill with white opaque
	for (let i = 0; i < dst.length; i += 4) {
		dst[i] = 255;
		dst[i + 1] = 255;
		dst[i + 2] = 255;
		dst[i + 3] = 255;
	}
	for (let y = 0; y < srcH; y++) {
		const srcOff = y * srcW * 4;
		const dstOff = y * dstW * 4;
		dst.set(src.subarray(srcOff, srcOff + srcW * 4), dstOff);
	}
	return dst;
}

/** Blend RGBA pixels toward white by factor t (0=original, 1=white). */
function blendToWhite(
	src: Uint8ClampedArray,
	t: number,
	width: number,
	height: number,
): Uint8ClampedArray {
	const dst = new Uint8ClampedArray(width * height * 4);
	const invT = 1 - t;
	for (let i = 0; i < src.length; i += 4) {
		dst[i] = Math.round(src[i] * invT + 255 * t);
		dst[i + 1] = Math.round(src[i + 1] * invT + 255 * t);
		dst[i + 2] = Math.round(src[i + 2] * invT + 255 * t);
		dst[i + 3] = 255;
	}
	return dst;
}
