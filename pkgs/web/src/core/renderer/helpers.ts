import type {
	CubicBezierSegment,
	LineCap,
	LineJoin,
	StrokeAlign,
	StrokeWidthPoint,
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
	pathStart?: number,
	pathEnd?: number,
	zoomBucket?: number,
	strokeAlign?: StrokeAlign,
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
	h = (h * 31 + floatBits(pathStart ?? 0)) | 0;
	h = (h * 31 + floatBits(pathEnd ?? 1)) | 0;
	// Round join/cap subdivision follows the device-space error budget, so
	// cached geometry must be split per zoom bucket or zooming in would keep
	// serving the coarser tessellation.
	h = (h * 31 + (zoomBucket ?? 0)) | 0;
	// An absent align and an explicit "center" must collide: the UI writes the
	// explicit value, and splitting them would throw away every cached outline
	// the moment the panel is touched.
	h =
		(h * 31 +
			(strokeAlign === "outside" ? 1 : strokeAlign === "inside" ? 2 : 0)) |
		0;
	return h;
}
