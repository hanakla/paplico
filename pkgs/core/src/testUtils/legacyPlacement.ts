import type { ElementTransform } from "../schema";
import { transformLinearMatrix } from "../utils/geometry/geometry";

interface Point {
	x: number;
	y: number;
}

/**
 * Where documents older than 20260929 drew a local point: turned and scaled
 * by `t` around `pivot`, then moved by t's translation.
 */
export function legacyPlace(
	point: Point,
	t: ElementTransform,
	pivot: Point,
): Point {
	const m = transformLinearMatrix(t);
	const dx = point.x - pivot.x;
	const dy = point.y - pivot.y;
	return {
		x: pivot.x + m.m00 * dx + m.m01 * dy + t.x,
		y: pivot.y + m.m10 * dx + m.m11 * dy + t.y,
	};
}
