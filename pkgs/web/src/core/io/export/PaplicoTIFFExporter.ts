import {
	convertImageRgbToRgb,
	convertImageToCmyk,
} from "../../color/ColorEngine";
import { inspectIccProfile } from "../../color/IccProfileRegistry";
import type { BuiltinIccProfileId, RenderingIntent } from "../../color/types";
import type { RenderOrchestrator } from "../../renderer/RenderOrchestrator";
import type { Document, RawRGBA } from "../../schema";
import { encodeTiff } from "./tiffWriter";

export interface TIFFExportOptions {
	/** Scale factor (1 = 100%, 2 = 200% / @2x) */
	scale?: number;
	/** Background color (default: white) */
	backgroundColor?: RawRGBA;
	/**
	 * Color profile to apply. A CMYK profile converts the pixels to CMYK; an RGB
	 * profile converts the pixels into its space. The profile is embedded either
	 * way. When omitted, an RGB TIFF is written without an embedded profile.
	 */
	profile?: { data: Uint8Array };
	/** Color space of the rendered pixels (default: "display-p3") */
	srcSpace?: "srgb" | "display-p3";
	/** ICC rendering intent (default: "relative-colorimetric") */
	intent?: RenderingIntent;
	/** Output resolution in dots per inch */
	dpi?: number;
}

interface ExportResult {
	blob: Blob;
	width: number;
	height: number;
}

/**
 * TIFF exporter. Renders an artboard and encodes a baseline TIFF. Without a
 * CMYK profile it writes an RGB TIFF; with one it converts the pixels to 8-bit
 * CMYK through the profile and embeds it for print submission.
 */
export class PaplicoTIFFExporter {
	public constructor(
		private renderer: RenderOrchestrator,
		private getDocument: () => Document,
		private getBuiltinProfileBytes: (
			id: BuiltinIccProfileId,
		) => Promise<Uint8Array>,
	) {}

	/**
	 * Export an artboard to TIFF and trigger download.
	 */
	public async asTIFF(
		artboardId: string,
		options: TIFFExportOptions & { filename?: string },
	): Promise<boolean> {
		const { filename, ...exportOpts } = options;
		const result = await this.renderArtboardToTIFF(artboardId, exportOpts);
		if (!result) return false;

		const artboard = this.getDocument().artboards.find(
			(a) => a.id === artboardId,
		);
		const defaultFilename = artboard
			? `${artboard.name.replace(/[^a-zA-Z0-9-_]/g, "_")}.tif`
			: "export.tif";

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
	 * Export an artboard to a TIFF blob without downloading.
	 */
	public async renderArtboardToTIFF(
		artboardId: string,
		options: TIFFExportOptions,
	): Promise<ExportResult | null> {
		const {
			scale = 1,
			backgroundColor = { r: 1, g: 1, b: 1, a: 1 },
			srcSpace = "display-p3",
			intent = "relative-colorimetric",
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

		// TIFF output here has no alpha channel; flatten any residual transparency
		// over the background color (same concern as JPEG export).
		const rgba = flattenToOpaque(imageData.data, backgroundColor);

		const tiffBytes = await this.encodeWithProfile(
			rgba,
			width,
			height,
			srcSpace,
			intent,
			options.profile?.data,
			options.dpi,
		);

		return {
			blob: new Blob([tiffBytes], { type: "image/tiff" }),
			width,
			height,
		};
	}

	/**
	 * Encode flattened RGBA pixels to TIFF. A CMYK profile yields a CMYK TIFF; an
	 * RGB profile yields an RGB TIFF converted into its space; no profile (or an
	 * unconvertible one) yields a plain RGB TIFF. The profile is embedded when
	 * present.
	 */
	private async encodeWithProfile(
		rgba: Uint8ClampedArray,
		width: number,
		height: number,
		srcSpace: "srgb" | "display-p3",
		intent: RenderingIntent,
		profileBytes: Uint8Array | undefined,
		dpi: number | undefined,
	): Promise<Uint8Array<ArrayBuffer>> {
		const colorSpace = profileBytes
			? inspectIccProfile(profileBytes)?.colorSpace
			: undefined;

		if (profileBytes && colorSpace === "cmyk") {
			const cmyk = await convertImageToCmyk(rgba, {
				srcSpace,
				profileBytes,
				intent,
				srcProfileBytes: await this.getBuiltinProfileBytes(srcSpace),
			});
			return encodeTiff(cmyk, width, height, {
				colorModel: "cmyk",
				iccProfile: profileBytes,
				dpi,
			});
		}

		if (profileBytes && colorSpace === "rgb") {
			const converted = await convertImageRgbToRgb(rgba, {
				srcProfileBytes: await this.getBuiltinProfileBytes(srcSpace),
				dstProfileBytes: profileBytes,
				intent,
			});
			return encodeTiff(dropAlpha(converted), width, height, {
				colorModel: "rgb",
				iccProfile: profileBytes,
				dpi,
			});
		}

		return encodeTiff(dropAlpha(rgba), width, height, {
			colorModel: "rgb",
			dpi,
		});
	}
}

/**
 * Composite residual transparency over an opaque background color.
 * Returns the input unchanged when every pixel is already opaque.
 */
function flattenToOpaque(
	data: Uint8ClampedArray,
	background: RawRGBA,
): Uint8ClampedArray {
	let hasTransparency = false;
	for (let i = 3; i < data.length; i += 4) {
		if (data[i] < 255) {
			hasTransparency = true;
			break;
		}
	}
	if (!hasTransparency) return data;

	const bgR = background.r * 255;
	const bgG = background.g * 255;
	const bgB = background.b * 255;
	const out = new Uint8ClampedArray(data.length);
	for (let i = 0; i < data.length; i += 4) {
		const a = data[i + 3] / 255;
		out[i] = data[i] * a + bgR * (1 - a);
		out[i + 1] = data[i + 1] * a + bgG * (1 - a);
		out[i + 2] = data[i + 2] * a + bgB * (1 - a);
		out[i + 3] = 255;
	}
	return out;
}

/** Drop the alpha channel, packing RGBA into tightly interleaved RGB bytes. */
function dropAlpha(rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
	const pixelCount = rgba.length / 4;
	const out = new Uint8Array(pixelCount * 3);
	for (let i = 0; i < pixelCount; i++) {
		out[i * 3] = rgba[i * 4];
		out[i * 3 + 1] = rgba[i * 4 + 1];
		out[i * 3 + 2] = rgba[i * 4 + 2];
	}
	return out;
}
