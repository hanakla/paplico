import type { RectPrimitive } from "../primitives";

/** Center+size geometry of an axis-aligned min/max box (world units). */
export function rectGeom(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): Pick<RectPrimitive, "cx" | "cy" | "width" | "height"> {
	return {
		cx: (minX + maxX) / 2,
		cy: (minY + maxY) / 2,
		width: maxX - minX,
		height: maxY - minY,
	};
}
