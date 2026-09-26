import type { RawRGBA } from "../../schema";
import { convertToOutputProfile, type OutputIccProfile } from "./outputProfile";
import { embedIccProfileInPng, sanitizeIccProfileName } from "./pngIcc";
import type { ExportContext, ExportResult, IExporter } from "./types";

interface PNGExportOptions {
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
}

/** Renders an artboard to a PNG blob. */
export class PNGExporter implements IExporter {
	public constructor(private options: PNGExportOptions = {}) {}

	public async export(
		ctx: ExportContext,
		artboardId: string,
	): Promise<ExportResult | null> {
		const {
			scale = 1,
			backgroundColor = { r: 1, g: 1, b: 1, a: 1 },
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

		// Convert to PNG via OffscreenCanvas
		const canvas = new OffscreenCanvas(width, height);
		const canvasCtx = canvas.getContext("2d");
		if (!canvasCtx) {
			console.error("Failed to get 2D context for export");
			return null;
		}

		canvasCtx.putImageData(
			await convertToOutputProfile(imageData, iccProfile, sourceProfileBytes),
			0,
			0,
		);
		let blob = await canvas.convertToBlob({ type: "image/png" });

		if (iccProfile) {
			const pngBytes = new Uint8Array(await blob.arrayBuffer());
			const withProfile = await embedIccProfileInPng(
				pngBytes,
				iccProfile.data,
				sanitizeIccProfileName(iccProfile.name),
			);
			blob = new Blob([withProfile], { type: "image/png" });
		}

		return { blob, width, height };
	}
}
