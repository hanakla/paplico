import { encodeAvifHdr, type PlanarYuvData } from "@paplico/avif-hdr";
import { convertImageRgbToRgb } from "../../color/ColorEngine";
import type { RenderOrchestrator } from "../../renderer/RenderOrchestrator";
import { HDR_EDR_HEADROOM, HDR_MAX_NITS } from "../../renderer/types";
import type { Document, RawRGBA } from "../../schema";
import { pqOetf, srgbEotf, srgbOetf } from "../../utils/color";
import { embedIccProfileInJpeg } from "./jpegIcc";
import { imageDataToBlob } from "./pngEncode";
import { embedIccProfileInPng, sanitizeIccProfileName } from "./pngIcc";

interface ExportOptions {
	/** Scale factor (1 = 100%, 2 = 200% / @2x) */
	scale?: number;
	/** Background color (default: white) */
	backgroundColor?: RawRGBA;
	/** ICC profile to embed into the exported image */
	iccProfile?: { data: Uint8Array; name: string };
	/**
	 * Source profile bytes = the ICC of the document working space.
	 * Only when both this and `iccProfile` are present, pixels are actually
	 * converted from the working space color space into `iccProfile`'s space.
	 */
	sourceProfileBytes?: Uint8Array;
	/**
	 * Color space the rendered pixels are interpreted in (default: "display-p3").
	 * Used by AVIF HDR export to tag the container with the correct color
	 * primaries so an "srgb" working space is not mislabeled as Display-P3.
	 */
	srcSpace?: "srgb" | "display-p3";
}

interface ExportResult {
	blob: Blob;
	width: number;
	height: number;
}

export class PaplicoExporter {
	public constructor(
		private renderer: RenderOrchestrator,
		private getDocument: () => Document,
	) {}

	/**
	 * Export an artboard to PNG and trigger download.
	 */
	public async asPNG(
		artboardId: string,
		options: ExportOptions & { filename?: string } = {},
	): Promise<boolean> {
		const { filename, ...exportOpts } = options;
		const result = await this.renderArtboardToPNG(artboardId, exportOpts);
		if (!result) return false;

		const artboard = this.getDocument().artboards.find(
			(a) => a.id === artboardId,
		);
		const defaultFilename = artboard
			? `${artboard.name.replace(/[^a-zA-Z0-9-_]/g, "_")}.png`
			: "export.png";

		const url = URL.createObjectURL(result.blob);
		const link = globalThis.document.createElement("a");
		link.href = url;
		link.download = filename ?? defaultFilename;
		link.click();
		URL.revokeObjectURL(url);

		console.log(
			`📥 Downloaded: ${link.download} (${result.width}x${result.height})`,
		);

		return true;
	}

	/**
	 * Export an artboard to JPEG and trigger download.
	 */
	public async asJPEG(
		artboardId: string,
		options: ExportOptions & { quality?: number; filename?: string } = {},
	): Promise<boolean> {
		const { filename, ...exportOpts } = options;
		const result = await this.renderArtboardToJPEG(artboardId, exportOpts);
		if (!result) return false;

		const artboard = this.getDocument().artboards.find(
			(a) => a.id === artboardId,
		);
		const defaultFilename = artboard
			? `${artboard.name.replace(/[^a-zA-Z0-9-_]/g, "_")}.jpg`
			: "export.jpg";

		const url = URL.createObjectURL(result.blob);
		const link = globalThis.document.createElement("a");
		link.href = url;
		link.download = filename ?? defaultFilename;
		link.click();
		URL.revokeObjectURL(url);

		console.log(
			`📥 Downloaded: ${link.download} (${result.width}x${result.height})`,
		);

		return true;
	}

	/**
	 * Export an artboard to AVIF HDR and trigger download.
	 */
	public async asAvifHdr(
		artboardId: string,
		options: ExportOptions & { filename?: string } = {},
	): Promise<boolean> {
		const { filename, ...exportOpts } = options;
		const result = await this.renderArtboardToAvifHdr(artboardId, exportOpts);
		if (!result) return false;

		const artboard = this.getDocument().artboards.find(
			(a) => a.id === artboardId,
		);
		const defaultFilename = artboard
			? `${artboard.name.replace(/[^a-zA-Z0-9-_]/g, "_")}.avif`
			: "export.avif";

		const url = URL.createObjectURL(result.blob);
		const link = globalThis.document.createElement("a");
		link.href = url;
		link.download = filename ?? defaultFilename;
		link.click();
		URL.revokeObjectURL(url);

		return true;
	}

	/**
	 * Export an artboard to PNG blob without downloading.
	 */
	public async renderArtboardToPNG(
		artboardId: string,
		options: ExportOptions = {},
	): Promise<ExportResult | null> {
		const { scale = 1, backgroundColor = { r: 1, g: 1, b: 1, a: 1 } } = options;
		const doc = this.getDocument();

		const artboard = doc.artboards.find((a) => a.id === artboardId);
		if (!artboard) {
			console.error(`Artboard not found: ${artboardId}`);
			return null;
		}

		const imageData = await this.renderer.renderArtboardToImageData(
			artboard,
			doc,
			scale,
			backgroundColor,
		);
		if (!imageData) {
			console.error("Failed to render artboard");
			return null;
		}

		const { width, height } = imageData;

		// Convert to PNG via OffscreenCanvas
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			console.error("Failed to get 2D context for export");
			return null;
		}

		if (options.iccProfile && options.sourceProfileBytes) {
			const converted = await convertImageRgbToRgb(imageData.data, {
				srcProfileBytes: options.sourceProfileBytes,
				dstProfileBytes: options.iccProfile.data,
				intent: "relative-colorimetric",
			});
			const pixels = new ImageData(
				new Uint8ClampedArray(
					converted.buffer as ArrayBuffer,
					converted.byteOffset,
					converted.length,
				),
				width,
				height,
			);
			ctx.putImageData(pixels, 0, 0);
		} else {
			ctx.putImageData(imageData, 0, 0);
		}
		let blob = await canvas.convertToBlob({ type: "image/png" });

		if (options.iccProfile) {
			const pngBytes = new Uint8Array(await blob.arrayBuffer());
			const withProfile = await embedIccProfileInPng(
				pngBytes,
				options.iccProfile.data,
				sanitizeIccProfileName(options.iccProfile.name),
			);
			blob = new Blob([withProfile], { type: "image/png" });
		}

		return { blob, width, height };
	}

	/**
	 * Export an artboard to JPEG blob without downloading.
	 * Transparent pixels are composited over the background color
	 * because JPEG has no alpha channel.
	 */
	public async renderArtboardToJPEG(
		artboardId: string,
		options: ExportOptions & { quality?: number } = {},
	): Promise<ExportResult | null> {
		const {
			scale = 1,
			backgroundColor = { r: 1, g: 1, b: 1, a: 1 },
			quality = 0.92,
		} = options;
		const doc = this.getDocument();

		const artboard = doc.artboards.find((a) => a.id === artboardId);
		if (!artboard) {
			console.error(`Artboard not found: ${artboardId}`);
			return null;
		}

		const imageData = await this.renderer.renderArtboardToImageData(
			artboard,
			doc,
			scale,
			backgroundColor,
		);
		if (!imageData) {
			console.error("Failed to render artboard");
			return null;
		}

		const { width, height } = imageData;

		// putImageData does not composite, so place the pixels on a temporary
		// canvas and drawImage them over an opaque background fill.
		const sourceCanvas = new OffscreenCanvas(width, height);
		const sourceCtx = sourceCanvas.getContext("2d");
		if (!sourceCtx) {
			console.error("Failed to get 2D context for export");
			return null;
		}
		if (options.iccProfile && options.sourceProfileBytes) {
			const converted = await convertImageRgbToRgb(imageData.data, {
				srcProfileBytes: options.sourceProfileBytes,
				dstProfileBytes: options.iccProfile.data,
				intent: "relative-colorimetric",
			});
			const pixels = new ImageData(
				new Uint8ClampedArray(
					converted.buffer as ArrayBuffer,
					converted.byteOffset,
					converted.length,
				),
				width,
				height,
			);
			sourceCtx.putImageData(pixels, 0, 0);
		} else {
			sourceCtx.putImageData(imageData, 0, 0);
		}

		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			console.error("Failed to get 2D context for export");
			return null;
		}
		ctx.fillStyle = rawRgbaToCssRgb(backgroundColor);
		ctx.fillRect(0, 0, width, height);
		ctx.drawImage(sourceCanvas, 0, 0);

		let blob = await canvas.convertToBlob({ type: "image/jpeg", quality });

		if (options.iccProfile) {
			const jpegBytes = embedIccProfileInJpeg(
				new Uint8Array(await blob.arrayBuffer()),
				options.iccProfile.data,
			);
			blob = new Blob([jpegBytes], { type: "image/jpeg" });
		}

		return { blob, width, height };
	}

	/**
	 * Export an artboard to AVIF HDR blob without downloading.
	 */
	public async renderArtboardToAvifHdr(
		artboardId: string,
		options: ExportOptions = {},
	): Promise<ExportResult | null> {
		const {
			scale = 1,
			backgroundColor = { r: 1, g: 1, b: 1, a: 1 },
			srcSpace = "display-p3",
		} = options;
		const doc = this.getDocument();

		const artboard = doc.artboards.find((a) => a.id === artboardId);
		if (!artboard) {
			console.error(`Artboard not found: ${artboardId}`);
			return null;
		}

		const result = await this.renderer.renderArtboardToFloat32(
			artboard,
			doc,
			scale,
			backgroundColor,
		);
		if (!result) {
			console.error("Failed to render artboard for HDR export");
			return null;
		}

		const { pixels, width, height } = result;
		const bitDepth = 10 as const;
		const transfer = (doc.hdr?.enabled ?? false) ? "pq" : "srgb";

		// Build PlanarYuvData directly using BT.709 YCbCr coefficients
		// to preserve Display-P3 gamut without BT.2020 conversion.
		const yuvData = convertFloat32ToP3Yuv(
			pixels,
			width,
			height,
			bitDepth,
			"4:4:4",
			transfer,
		);

		// sRGB shares BT.709 primaries (same chromaticities, D65 white point),
		// so an "srgb" working space is tagged bt709 rather than mislabeled
		// as Display-P3. The BT.709 YCbCr matrix is correct for both gamuts.
		const colorPrimaries = srcSpace === "srgb" ? "bt709" : "display-p3";

		const avifBytes = encodeAvifHdr(yuvData, {
			width,
			height,
			bitDepth,
			chromaSubsampling: "4:4:4",
			colorPrimaries,
			transferCharacteristics: transfer,
			matrixCoefficients: "bt709",
			fullRange: true,
			qp: 0,
		});

		const blob = new Blob([new Uint8Array(avifBytes)], { type: "image/avif" });
		return { blob, width, height };
	}

	/**
	 * Render specific elements to a PNG blob for clipboard export.
	 */
	public async renderElementsToPNG(
		elementIds: string[],
		document: Document,
		options: ExportOptions = {},
	): Promise<ExportResult | null> {
		const { scale = 1, backgroundColor = { r: 0, g: 0, b: 0, a: 0 } } = options;

		// Bounds expanded to include post-process filter reach (blur / drop-shadow
		// / glow / extrude), so the copied image is not clipped to raw geometry.
		const bounds = this.renderer.computeElementsExportBounds(
			elementIds,
			document,
		);
		if (!bounds) return null;

		const imageData = await this.renderer.renderElementsToImageData(
			elementIds,
			document,
			bounds,
			scale,
			backgroundColor,
		);
		if (!imageData) return null;

		const blob = await imageDataToBlob(imageData);
		if (!blob) return null;

		return { blob, width: imageData.width, height: imageData.height };
	}
}

/** Format a RawRGBA (0-1 floats) as an opaque CSS rgb() color. */
function rawRgbaToCssRgb(color: RawRGBA): string {
	const r = Math.round(color.r * 255);
	const g = Math.round(color.g * 255);
	const b = Math.round(color.b * 255);
	return `rgb(${r}, ${g}, ${b})`;
}

// BT.709 YCbCr coefficients (same as Display-P3)
const KR_709 = 0.2126;
const KG_709 = 0.7152;
const KB_709 = 0.0722;

/**
 * Convert linear Display-P3 RGBA Float32 to PlanarYuvData
 * using BT.709 YCbCr coefficients (matching P3 primaries).
 */
function convertFloat32ToP3Yuv(
	rgba: Float32Array,
	width: number,
	height: number,
	bitDepth: 8 | 10 | 12,
	chromaSubsampling: "4:2:0" | "4:4:4",
	transfer: "srgb" | "pq" | "hlg" | "linear",
): PlanarYuvData {
	const pixelCount = width * height;
	const maxNits = HDR_MAX_NITS;
	const edrHeadroom = HDR_EDR_HEADROOM;
	// Readback values are gamma-encoded (sRGB transfer) from the GPU shader.
	// For PQ: linearize first, then encode to PQ signal.
	const oetf =
		transfer === "pq"
			? (v: number) => {
					const lin = srgbEotf(Math.max(0, v));
					return pqOetf(Math.min(lin, edrHeadroom) * maxNits);
				}
			: transfer === "linear"
				? (v: number) => Math.max(0, v)
				: (v: number) => srgbOetf(Math.max(0, Math.min(1, v)));

	const maxVal = (1 << bitDepth) - 1;
	const yPlane = new Uint16Array(pixelCount);
	const chromaW = chromaSubsampling === "4:2:0" ? Math.ceil(width / 2) : width;
	const chromaH =
		chromaSubsampling === "4:2:0" ? Math.ceil(height / 2) : height;
	const uPlane = new Uint16Array(chromaW * chromaH);
	const vPlane = new Uint16Array(chromaW * chromaH);

	const yFloat = new Float32Array(pixelCount);
	const cbFloat = new Float32Array(pixelCount);
	const crFloat = new Float32Array(pixelCount);

	for (let i = 0; i < pixelCount; i++) {
		const r = oetf(rgba[i * 4]);
		const g = oetf(rgba[i * 4 + 1]);
		const b = oetf(rgba[i * 4 + 2]);

		const y = KR_709 * r + KG_709 * g + KB_709 * b;
		const cb = (b - y) / (2 * (1 - KB_709)) + 0.5;
		const cr = (r - y) / (2 * (1 - KR_709)) + 0.5;

		yFloat[i] = y;
		cbFloat[i] = cb;
		crFloat[i] = cr;
		yPlane[i] = Math.round(Math.max(0, Math.min(1, y)) * maxVal);
	}

	if (chromaSubsampling === "4:2:0") {
		for (let cy = 0; cy < chromaH; cy++) {
			for (let cx = 0; cx < chromaW; cx++) {
				const sx = cx * 2;
				const sy = cy * 2;
				let cbSum = 0;
				let crSum = 0;
				let count = 0;
				for (let dy = 0; dy < 2 && sy + dy < height; dy++) {
					for (let dx = 0; dx < 2 && sx + dx < width; dx++) {
						const idx = (sy + dy) * width + sx + dx;
						cbSum += cbFloat[idx];
						crSum += crFloat[idx];
						count++;
					}
				}
				const ci = cy * chromaW + cx;
				uPlane[ci] = Math.round(
					Math.max(0, Math.min(1, cbSum / count)) * maxVal,
				);
				vPlane[ci] = Math.round(
					Math.max(0, Math.min(1, crSum / count)) * maxVal,
				);
			}
		}
	} else {
		for (let i = 0; i < pixelCount; i++) {
			uPlane[i] = Math.round(Math.max(0, Math.min(1, cbFloat[i])) * maxVal);
			vPlane[i] = Math.round(Math.max(0, Math.min(1, crFloat[i])) * maxVal);
		}
	}

	// Alpha
	let alpha: Uint16Array | undefined;
	let hasNonOpaque = false;
	for (let i = 0; i < pixelCount; i++) {
		if (rgba[i * 4 + 3] < 1.0) {
			hasNonOpaque = true;
			break;
		}
	}
	if (hasNonOpaque) {
		alpha = new Uint16Array(pixelCount);
		for (let i = 0; i < pixelCount; i++) {
			alpha[i] = Math.round(Math.max(0, Math.min(1, rgba[i * 4 + 3])) * maxVal);
		}
	}

	return {
		y: yPlane,
		u: uPlane,
		v: vPlane,
		alpha,
		width,
		height,
		bitDepth,
		chromaSubsampling,
	};
}
