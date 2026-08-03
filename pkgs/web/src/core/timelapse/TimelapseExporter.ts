import { proxy } from "valtio";
import type { RenderOrchestrator } from "../renderer/RenderOrchestrator";
import { type Artboard, type Document, getArtboardBounds } from "../schema";
import type { TimelapsePlayer } from "./TimelapsePlayer";

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
		private renderer: RenderOrchestrator,
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

		// Match preview playback timing:
		// Preview advances 1 event per EVENT_INTERVAL_MS (scaled by speed).
		// At the given fps, compute how many frames per event (or events per frame).
		const msPerEvent = EVENT_INTERVAL_MS / speed;
		const msPerFrame = 1000 / fps;
		const framesPerEvent = msPerEvent / msPerFrame;

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
		this.player.seekTo(totalEvents - 1);
		const completedDoc = this.player.buildCurrentDocument();
		const completedImage = await this.renderFrame(
			completedDoc,
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

		// --- Timelapse from beginning ---
		// Use fractional accumulator to match preview timing precisely.
		// When framesPerEvent >= 1, we hold each event's frame for multiple video frames.
		// When framesPerEvent < 1, we skip events to keep up.
		let eventIndex = -1;

		while (eventIndex < totalEvents - 1) {
			if (encoderError) throw encoderError;

			// Advance events based on accumulated frames
			if (framesPerEvent >= 1) {
				// Slow mode: render one event, then duplicate the frame
				eventIndex++;
				this.player.seekTo(eventIndex);
				const doc = this.player.buildCurrentDocument();
				const imageData = await this.renderFrame(doc, artboard, scale);
				const framePixels = this.padToEncoder(imageData, encWidth, encHeight);

				const repeatCount = Math.max(1, Math.round(framesPerEvent));
				for (let r = 0; r < repeatCount; r++) {
					encodeFrame(framePixels, frameIndex % (fps * 2) === 0);
				}
			} else {
				// Fast mode: skip multiple events per frame
				const eventsToAdvance = Math.max(1, Math.round(1 / framesPerEvent));
				eventIndex = Math.min(eventIndex + eventsToAdvance, totalEvents - 1);
				this.player.seekTo(eventIndex);
				const doc = this.player.buildCurrentDocument();
				const imageData = await this.renderFrame(doc, artboard, scale);
				const framePixels = this.padToEncoder(imageData, encWidth, encHeight);

				encodeFrame(framePixels, frameIndex % (fps * 2) === 0);
			}

			onProgress?.(Math.min(1, (eventIndex + 1) / totalEvents));
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
		const imageData = await this.renderer.renderArtboardToImageData(
			artboard,
			proxy(document),
			scale,
			{ r: 1, g: 1, b: 1, a: 1 },
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
