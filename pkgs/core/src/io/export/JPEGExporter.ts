import type { RawRGBA } from "../../schema";
import { embedIccProfileInJpeg } from "./jpegIcc";
import { convertToOutputProfile, type OutputIccProfile } from "./outputProfile";
import type { ExportContext, ExportResult, IExporter } from "./types";

interface JPEGExportOptions {
	/** Scale factor (1 = 100%, 2 = 200% / @2x) */
	scale?: number;
	/** Background color (default: white) */
	backgroundColor?: RawRGBA;
	/** ICC profile to embed into the exported image */
	iccProfile?: OutputIccProfile;
	/**
	 * Source profile bytes = the ICC of the document working space.
	 * Only when both this and `iccProfile` are present, pixels are actually
	 * converted from the working space color space into `iccProfile`'s space.
	 */
	sourceProfileBytes?: Uint8Array;
	/** Encoder quality in 0-1 (default: 0.92) */
	quality?: number;
}

/**
 * Renders an artboard to a JPEG blob. Transparent pixels are composited
 * over the background color because JPEG has no alpha channel.
 */
export class JPEGExporter implements IExporter {
	public constructor(private options: JPEGExportOptions = {}) {}

	public async export(
		ctx: ExportContext,
		artboardId: string,
	): Promise<ExportResult | null> {
		const {
			scale = 1,
			backgroundColor = { r: 1, g: 1, b: 1, a: 1 },
			quality = 0.92,
			iccProfile,
			sourceProfileBytes,
		} = this.options;
		const doc = ctx.document;

		const artboard = doc.artboards.find((a) => a.id === artboardId);
		if (!artboard) {
			console.error(`Artboard not found: ${artboardId}`);
			return null;
		}

		const imageData = await ctx.renderer.renderArtboardToImageData(
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
		sourceCtx.putImageData(
			await convertToOutputProfile(imageData, iccProfile, sourceProfileBytes),
			0,
			0,
		);

		const canvas = new OffscreenCanvas(width, height);
		const canvasCtx = canvas.getContext("2d");
		if (!canvasCtx) {
			console.error("Failed to get 2D context for export");
			return null;
		}
		canvasCtx.fillStyle = rawRgbaToCssRgb(backgroundColor);
		canvasCtx.fillRect(0, 0, width, height);
		canvasCtx.drawImage(sourceCanvas, 0, 0);

		let blob = await canvas.convertToBlob({ type: "image/jpeg", quality });

		if (iccProfile) {
			const jpegBytes = embedIccProfileInJpeg(
				new Uint8Array(await blob.arrayBuffer()),
				iccProfile.data,
			);
			blob = new Blob([jpegBytes], { type: "image/jpeg" });
		}

		return { blob, width, height };
	}
}

/** Format a RawRGBA (0-1 floats) as an opaque CSS rgb() color. */
function rawRgbaToCssRgb(color: RawRGBA): string {
	const r = Math.round(color.r * 255);
	const g = Math.round(color.g * 255);
	const b = Math.round(color.b * 255);
	return `rgb(${r}, ${g}, ${b})`;
}
