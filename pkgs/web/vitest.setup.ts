import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createDeflate, createInflate } from "node:zlib";
import { beforeAll } from "vitest";
import { ensureWebGPUGlobals } from "./src/core/testUtils/visualRegression";

/**
 * Tests must not reach the network for fonts: whether Google Fonts answers
 * flips the rendered text — and everything sampling it, like backdrop
 * filters — between runs, which poisons visual baselines. Every run takes
 * the same offline fallback (the bundled Noto Sans JP) instead, and the
 * fallback itself is answered from public/ because no app server is
 * listening at the document origin.
 */
const realFetch = globalThis.fetch;
const APP_FONT_ASSET_URL = /\/assets\/fonts\/([^/?#]+)$/;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input instanceof Request ? input.url : input);
	if (
		/fonts\.(?:googleapis|gstatic)\.com|googleapis\.com\/webfonts/.test(url)
	) {
		return Promise.resolve(new Response(null, { status: 403 }));
	}
	const asset = APP_FONT_ASSET_URL.exec(url);
	if (asset) {
		const file = path.join(__dirname, "public/assets/fonts", asset[1]);
		return Promise.resolve(new Response(readFileSync(file)));
	}
	return realFetch(input, init);
}) as typeof fetch;

/**
 * Polyfill CompressionStream/DecompressionStream for Node.js environment.
 * PAPF writer/reader uses Deflate compression via these Web Streams APIs.
 */
if (typeof globalThis.CompressionStream === "undefined") {
	(globalThis as any).CompressionStream = class CompressionStream {
		public readonly readable: ReadableStream<Uint8Array>;
		public readonly writable: WritableStream<Uint8Array>;
		public constructor(_format: string) {
			const deflate = createDeflate();
			this.readable = new ReadableStream({
				start(controller) {
					deflate.on("data", (chunk: Buffer) =>
						controller.enqueue(new Uint8Array(chunk)),
					);
					deflate.on("end", () => controller.close());
					deflate.on("error", (err) => controller.error(err));
				},
			});
			this.writable = new WritableStream({
				write(chunk) {
					deflate.write(chunk);
				},
				close() {
					deflate.end();
				},
			});
		}
	};
}

if (typeof globalThis.DecompressionStream === "undefined") {
	(globalThis as any).DecompressionStream = class DecompressionStream {
		public readonly readable: ReadableStream<Uint8Array>;
		public readonly writable: WritableStream<Uint8Array>;
		public constructor(_format: string) {
			const inflate = createInflate();
			this.readable = new ReadableStream({
				start(controller) {
					inflate.on("data", (chunk: Buffer) =>
						controller.enqueue(new Uint8Array(chunk)),
					);
					inflate.on("end", () => controller.close());
					inflate.on("error", (err) => controller.error(err));
				},
			});
			this.writable = new WritableStream({
				write(chunk) {
					inflate.write(chunk);
				},
				close() {
					inflate.end();
				},
			});
		}
	};
}

/**
 * Polyfill ImageData for Node.js environment
 * happy-dom may not provide a full ImageData constructor in all contexts.
 */
if (typeof globalThis.ImageData === "undefined") {
	(globalThis as any).ImageData = class ImageData {
		public readonly width: number;
		public readonly height: number;
		public readonly data: Uint8ClampedArray;
		public constructor(
			data: Uint8ClampedArray,
			width: number,
			height?: number,
		) {
			this.data = data;
			this.width = width;
			this.height = height ?? data.length / (width * 4);
		}
	};
}

/**
 * Polyfill createImageBitmap for Node.js environment
 * BrushTextureManager uses this to load base64 PNG textures.
 * happy-dom ships its own createImageBitmap that rejects Node Blobs, so the
 * polyfill replaces it unconditionally.
 */
{
	(globalThis as any).createImageBitmap = async (
		blob: Blob,
	): Promise<ImageBitmap> => {
		// Read blob as ArrayBuffer
		const arrayBuffer = await blob.arrayBuffer();
		const bytes = new Uint8Array(arrayBuffer);

		// Minimal PNG decoder - just extract width/height from IHDR chunk
		// PNG format: 8-byte signature + chunks
		// IHDR chunk is always first after signature
		const width =
			(bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
		const height =
			(bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];

		// Return a minimal ImageBitmap-like object
		return {
			width,
			height,
			close: () => {},
		} as ImageBitmap;
	};
}

/**
 * Global WebGPU test setup
 * ensureWebGPUGlobals() caches the GPU instance and injects WebGPU globals.
 * Individual GPUDevice creation is handled by each renderer via initDevice().
 */
beforeAll(async () => {
	await ensureWebGPUGlobals();
});
