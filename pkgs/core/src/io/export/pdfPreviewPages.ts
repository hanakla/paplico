import type { PdfPreviewPage } from "../papf/pdfContainer";
import { JPEGExporter } from "./JPEGExporter";
import type { ExportContext } from "./types";

/**
 * Renders every artboard as a JPEG preview page for the PDF container.
 * Pages are rasterized at a fixed 72 dpi, one pixel per PDF point, since
 * the preview only serves file viewers. A page whose render fails is
 * emitted blank so saving never depends on the GPU state.
 */
export async function renderPdfPreviewPages(
	ctx: ExportContext,
): Promise<PdfPreviewPage[]> {
	const exporter = new JPEGExporter({
		scale: 1,
		quality: PDF_PREVIEW_JPEG_QUALITY,
	});
	return Promise.all(
		ctx.document.artboards.map(async ({ id, width, height }) => ({
			width,
			height,
			jpeg: await renderPreviewJpeg(exporter, ctx, id),
		})),
	);
}

const PDF_PREVIEW_JPEG_QUALITY = 0.85;

async function renderPreviewJpeg(
	exporter: JPEGExporter,
	ctx: ExportContext,
	artboardId: string,
): Promise<Uint8Array | null> {
	try {
		const result = await exporter.export(ctx, artboardId);
		if (!result) return null;
		return new Uint8Array(await result.blob.arrayBuffer());
	} catch (error) {
		console.error("Failed to render PDF preview page", error);
		return null;
	}
}
