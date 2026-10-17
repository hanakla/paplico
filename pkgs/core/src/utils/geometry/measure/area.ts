import type { CubicBezierSegment } from "../../../schema";
import { resolveSegment } from "../primitives/segment";

/**
 * Fast hash of segment control-point coordinates.
 * Used for cache validation (geometry change detection).
 */
/**
 * Compute the signed area of a closed subpath using the shoelace formula
 * on resolved endpoints. Positive = CCW, negative = CW (in Y-up space).
 */
export function computeSubPathSignedArea(
	segments: CubicBezierSegment[],
): number {
	let area = 0;
	for (let i = 0; i < segments.length; i++) {
		const prevEnd = i > 0 ? segments[i - 1].end : undefined;
		const resolved = resolveSegment(segments[i], prevEnd);
		area +=
			resolved.start.x * resolved.end.y - resolved.end.x * resolved.start.y;
	}
	return area * 0.5;
}
