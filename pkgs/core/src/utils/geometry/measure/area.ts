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

/**
 * Compute signed area of a polygon (shoelace formula).
 * Positive = counter-clockwise, Negative = clockwise.
 */
export function computePolylineSignedArea(points: number[]): number {
	let area = 0;
	const n = points.length / 2;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		const x1 = points[i * 2];
		const y1 = points[i * 2 + 1];
		const x2 = points[j * 2];
		const y2 = points[j * 2 + 1];
		area += x1 * y2 - x2 * y1;
	}
	return area / 2;
}
