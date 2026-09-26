import { encodeAvifHdr, type PlanarYuvData } from "@paplico/avif-hdr";
import { HDR_EDR_HEADROOM, HDR_MAX_NITS } from "../../renderer/types";
import type { RawRGBA } from "../../schema";
import { pqOetf, srgbEotf, srgbOetf } from "../../utils/color";
import type { ExportContext, ExportResult, IExporter } from "./types";

interface AvifHdrExportOptions {
	/** Scale factor (1 = 100%, 2 = 200% / @2x) */
	scale?: number;
	/** Background color (default: white) */
	backgroundColor?: RawRGBA;
	/**
	 * Color space the rendered pixels are interpreted in (default: "display-p3").
	 * Tags the container with the correct color primaries so an "srgb" working
	 * space is not mislabeled as Display-P3.
	 */
	srcSpace?: "srgb" | "display-p3";
}

/** Renders an artboard to an AVIF HDR blob. */
export class AvifHdrExporter implements IExporter {
	public constructor(private options: AvifHdrExportOptions = {}) {}

	public async export(
		ctx: ExportContext,
		artboardId: string,
	): Promise<ExportResult | null> {
		const {
			scale = 1,
			backgroundColor = { r: 1, g: 1, b: 1, a: 1 },
			srcSpace = "display-p3",
		} = this.options;
		const doc = ctx.document;

		const artboard = doc.artboards.find((a) => a.id === artboardId);
		if (!artboard) {
			console.error(`Artboard not found: ${artboardId}`);
			return null;
		}

		const result = await ctx.renderer.renderArtboardToFloat32(
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
