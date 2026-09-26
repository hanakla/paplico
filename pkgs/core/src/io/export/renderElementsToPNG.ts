import type { Document, RawRGBA } from "../../schema";
import { imageDataToBlob } from "./pngEncode";
import type { ExportRenderer, ExportResult } from "./types";

/** Renders specific elements to a PNG blob for clipboard copies and thumbnails. */
export async function renderElementsToPNG(
	renderer: ExportRenderer,
	elementIds: string[],
	document: Document,
	{
		scale = 1,
		backgroundColor = { r: 0, g: 0, b: 0, a: 0 },
	}: { scale?: number; backgroundColor?: RawRGBA } = {},
): Promise<ExportResult | null> {
	// Bounds expanded to include post-process filter reach (blur / drop-shadow
	// / glow / extrude), so the copied image is not clipped to raw geometry.
	const bounds = renderer.computeElementsExportBounds(elementIds, document);
	if (!bounds) return null;

	const imageData = await renderer.renderElementsToImageData(
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
