import {
	type CubicBezierSegment,
	colorToRawRGBA,
	type LineCap,
	type LineJoin,
	type StrokeColor,
	type StrokeWidthPoint,
} from "../schema";
import { floatBits, hashSegments } from "../utils/geometry/segmentOps";

/**
 * Compute a geometry hash that includes segment coordinates AND stroke
 * parameters that affect tessellation output (width, cap, join, dash, etc.).
 */
export function hashStrokeGeometry(
	segments: CubicBezierSegment[],
	strokeWidth: number,
	sizeByPressure: number,
	lineCap: LineCap,
	lineJoin: LineJoin,
	miterLimit: number,
	dashArray?: readonly number[],
	dashOffset?: number,
	strokeWidths?: StrokeWidthPoint[],
	taperStart?: number,
	taperEnd?: number,
	pathStart?: number,
	pathEnd?: number,
	zoomBucket?: number,
): number {
	let h = hashSegments(segments);
	h = (h * 31 + floatBits(strokeWidth)) | 0;
	h = (h * 31 + floatBits(sizeByPressure)) | 0;
	h = (h * 31 + (lineCap === "round" ? 1 : lineCap === "square" ? 2 : 0)) | 0;
	h = (h * 31 + (lineJoin === "round" ? 1 : lineJoin === "bevel" ? 2 : 0)) | 0;
	h = (h * 31 + floatBits(miterLimit)) | 0;
	if (dashArray) {
		h = (h * 31 + dashArray.length) | 0;
		for (let i = 0; i < dashArray.length; i++) {
			h = (h * 31 + floatBits(dashArray[i])) | 0;
		}
		h = (h * 31 + floatBits(dashOffset ?? 0)) | 0;
	}
	if (strokeWidths) {
		h = (h * 31 + strokeWidths.length) | 0;
		for (let i = 0; i < strokeWidths.length; i++) {
			const sw = strokeWidths[i];
			h = (h * 31 + floatBits(sw.t)) | 0;
			h = (h * 31 + floatBits(sw.side1)) | 0;
			h = (h * 31 + floatBits(sw.side2)) | 0;
		}
	}
	h = (h * 31 + floatBits(taperStart ?? 0)) | 0;
	h = (h * 31 + floatBits(taperEnd ?? 0)) | 0;
	h = (h * 31 + floatBits(pathStart ?? 0)) | 0;
	h = (h * 31 + floatBits(pathEnd ?? 1)) | 0;
	// Round join/cap subdivision follows the device-space error budget, so
	// cached geometry must be split per zoom bucket or zooming in would keep
	// serving the coarser tessellation.
	h = (h * 31 + (zoomBucket ?? 0)) | 0;
	return h;
}

/**
 * Cache key for the paint a stroke tessellation baked into its vertices.
 *
 * Solid strokes bake the full RGBA × alphaMultiplier per vertex; gradient and
 * pattern strokes bake only the multiplier and sample their color at draw
 * time. Both are invisible to hashStrokeColor — the multiplier carries the
 * appearance / element / layer opacity, none of which live on the StrokeColor
 * — so cached vertices must be separated by this key or an opacity change
 * silently reuses the previous alpha. Mirrors the fill side's paint key in
 * PathElementRenderer.renderStencilFill.
 */
export function buildStrokePaintKey(
	strokeColor: StrokeColor,
	alphaMultiplier: number,
): string {
	if (strokeColor.type !== "solid") {
		return `g:${alphaMultiplier.toFixed(4)}`;
	}
	const c = colorToRawRGBA(strokeColor.color);
	return `s:${c.r.toFixed(4)},${c.g.toFixed(4)},${c.b.toFixed(4)},${(
		c.a * alphaMultiplier
	).toFixed(4)}`;
}

/**
 * True when the stroke's resolved paint lets the backdrop through, so its
 * tessellation has to draw with first-fragment-wins coverage: the per-segment
 * quads overlap at every join and self-intersection, and blending those pixels
 * a second time is what makes the overlaps read as darker.
 *
 * Patterns are judged by the multiplier alone — the alpha of their texels is
 * only known on the GPU — so a see-through pattern under an opaque multiplier
 * keeps the plain single-draw path.
 */
export function isStrokePaintSemiTransparent(
	strokeColor: StrokeColor,
	alphaMultiplier: number,
): boolean {
	if (alphaMultiplier < 1) return true;
	if (strokeColor.type === "solid") {
		return colorToRawRGBA(strokeColor.color).a < 1;
	}
	if (strokeColor.type === "stroke-gradient") {
		return strokeColor.gradient.stops.some(
			(stop) => colorToRawRGBA(stop.color).a < 1,
		);
	}
	return false;
}

/**
 * Hash a StrokeColor value for cache invalidation when color/gradient changes.
 */
export function hashStrokeColor(sc: StrokeColor): number {
	const str = JSON.stringify(sc);
	let h = 0;
	for (let i = 0; i < str.length; i++) {
		h = (h * 31 + str.charCodeAt(i)) | 0;
	}
	return h;
}
