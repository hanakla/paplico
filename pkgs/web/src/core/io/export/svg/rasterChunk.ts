import type { BoundingBox, Document, RawRGBA } from "../../../schema";
import { imageDataToBlob } from "../pngEncode";
import { bytesToDataUrl } from "./dataUrl";

/** Center-form world bounds used by the renderer's export entry points. */
interface ExportBounds {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
}

/** The two RenderOrchestrator methods a raster chunk render needs. */
interface RasterChunkRenderer {
	computeElementsExportBounds(
		elementIds: readonly string[],
		document: Document,
	): ExportBounds | null;
	renderElementsToImageData(
		elementIds: string[],
		document: Document,
		bounds: ExportBounds,
		scale?: number,
		backgroundColor?: RawRGBA,
	): Promise<ImageData | null>;
}

export interface RasterChunkResult {
	dataUrl: string;
	/** World bounds the PNG actually covers (min/max form, Y up). */
	bounds: BoundingBox;
}

/**
 * Render a z-consecutive raster run to a transparent PNG data URL. The
 * filter-expanded bounds are intersected with `clipBounds` (the artboard) so
 * off-artboard halo pixels are not rendered. `scale` is the pixel density
 * only; the returned bounds stay in world units.
 */
export async function renderRasterChunk(
	renderer: RasterChunkRenderer,
	document: Document,
	elementIds: string[],
	clipBounds: BoundingBox,
	scale: number,
): Promise<RasterChunkResult | null> {
	const bounds = renderer.computeElementsExportBounds(elementIds, document);
	if (!bounds) return null;

	const minX = Math.max(bounds.centerX - bounds.width / 2, clipBounds.minX);
	const minY = Math.max(bounds.centerY - bounds.height / 2, clipBounds.minY);
	const maxX = Math.min(bounds.centerX + bounds.width / 2, clipBounds.maxX);
	const maxY = Math.min(bounds.centerY + bounds.height / 2, clipBounds.maxY);
	if (maxX - minX <= 0 || maxY - minY <= 0) return null;

	const clipped: ExportBounds = {
		centerX: (minX + maxX) / 2,
		centerY: (minY + maxY) / 2,
		width: maxX - minX,
		height: maxY - minY,
	};

	const imageData = await renderer.renderElementsToImageData(
		elementIds,
		document,
		clipped,
		scale,
		{ r: 0, g: 0, b: 0, a: 0 },
	);
	if (!imageData) return null;

	const blob = await imageDataToBlob(imageData);
	if (!blob) return null;

	return {
		dataUrl: bytesToDataUrl(
			new Uint8Array(await blob.arrayBuffer()),
			"image/png",
		),
		bounds: {
			minX,
			minY,
			maxX,
			maxY,
			width: maxX - minX,
			height: maxY - minY,
		},
	};
}
