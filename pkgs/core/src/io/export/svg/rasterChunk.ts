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
 * only; the returned bounds stay in world units. With `backdropIds`, the run
 * is rendered over that backdrop and the PNG keeps only what the run changed,
 * so it reproduces the render when laid over the backdrop exported as vector.
 */
export async function renderRasterChunk(
	renderer: RasterChunkRenderer,
	document: Document,
	elementIds: string[],
	clipBounds: BoundingBox,
	scale: number,
	backdropIds: readonly string[] = [],
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

	const render = (ids: string[]) =>
		renderer.renderElementsToImageData(ids, document, clipped, scale, {
			r: 0,
			g: 0,
			b: 0,
			a: 0,
		});
	const imageData = await render([...backdropIds, ...elementIds]);
	if (!imageData) return null;
	if (backdropIds.length > 0) {
		const backdrop = await render([...backdropIds]);
		if (!backdrop) return null;
		subtractBackdrop(imageData, backdrop);
	}

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

/**
 * Turn `composite` (straight RGBA) in place into the layer that, drawn with
 * source-over on `backdrop`, gives back `composite`. Each pixel takes the
 * lowest alpha that can reach the composite color, so pixels the run left
 * untouched become transparent. Where the backdrop is translucent and its
 * color changed, the result is only approximate: an over layer can raise the
 * backdrop's alpha but never lower it.
 */
export function subtractBackdrop(
	composite: Pick<ImageData, "data">,
	backdrop: Pick<ImageData, "data">,
): void {
	const out = composite.data;
	const under = backdrop.data;
	for (let i = 0; i < out.length; i += 4) {
		const alphaB = out[i + 3] / 255;
		const alphaA = under[i + 3] / 255;
		// Source-over gives alphaB = alpha + alphaA * (1 - alpha).
		let alpha = alphaA < 1 ? Math.max(0, (alphaB - alphaA) / (1 - alphaA)) : 0;
		for (let c = i; c < i + 3; c++) {
			const b = (out[c] / 255) * alphaB;
			const a = (under[c] / 255) * alphaA;
			// The premultiplied layer color b - a * (1 - alpha) must stay
			// within [0, alpha].
			if (b < a) alpha = Math.max(alpha, (a - b) / a);
			else if (b > a) alpha = Math.max(alpha, (b - a) / (1 - a));
		}
		alpha = Math.min(1, alpha);
		for (let c = i; c < i + 3; c++) {
			const b = (out[c] / 255) * alphaB;
			const a = (under[c] / 255) * alphaA;
			out[c] = alpha > 0 ? ((b - a * (1 - alpha)) / alpha) * 255 : 0;
		}
		out[i + 3] = alpha * 255;
	}
}
