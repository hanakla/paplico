import type { BezierPoint, CubicBezierSegment } from "../../../schema";

/**
 * Resolve the start anchor of a segment.
 * Returns segment.start when present, otherwise prevEnd (the previous segment's end).
 */
export function getStartAnchor(
	segment: CubicBezierSegment,
	prevEnd?: BezierPoint,
): BezierPoint {
	// biome-ignore lint/style/noNonNullAssertion: the first segment carries segment.start, and callers always pass prevEnd for later ones
	return segment.start ?? prevEnd!;
}

/**
 * Restore a relative cp1 to absolute world coordinates.
 * cp1 is an offset from the start anchor.
 */
export function resolveCP1(
	cp1: BezierPoint,
	startAnchor: BezierPoint,
): BezierPoint {
	return {
		...cp1,
		x: startAnchor.x + cp1.x,
		y: startAnchor.y + cp1.y,
	};
}

/**
 * Restore a relative cp2 to absolute world coordinates.
 * cp2 is an offset from the end anchor.
 */
export function resolveCP2(cp2: BezierPoint, end: BezierPoint): BezierPoint {
	return {
		...cp2,
		x: end.x + cp2.x,
		y: end.y + cp2.y,
	};
}

/**
 * Restore every coordinate of a segment to absolute world coordinates.
 * Use it before passing the segment to a Bezier evaluator.
 */
export function resolveSegment(
	segment: CubicBezierSegment,
	prevEnd?: BezierPoint,
): {
	start: BezierPoint;
	cp1: BezierPoint;
	cp2: BezierPoint;
	end: BezierPoint;
} {
	const start = getStartAnchor(segment, prevEnd);
	return {
		start,
		cp1: resolveCP1(segment.cp1, start),
		cp2: resolveCP2(segment.cp2, segment.end),
		end: segment.end,
	};
}

/**
 * Convert an absolute cp1 to an offset from the start anchor.
 */
export function toRelativeCP1(
	absoluteCP1: BezierPoint,
	startAnchor: BezierPoint,
): BezierPoint {
	return {
		...absoluteCP1,
		x: absoluteCP1.x - startAnchor.x,
		y: absoluteCP1.y - startAnchor.y,
	};
}

/**
 * Convert an absolute cp2 to an offset from the end anchor.
 */
export function toRelativeCP2(
	absoluteCP2: BezierPoint,
	endAnchor: BezierPoint,
): BezierPoint {
	return {
		...absoluteCP2,
		x: absoluteCP2.x - endAnchor.x,
		y: absoluteCP2.y - endAnchor.y,
	};
}

/**
 * Split bezier segments into sub-paths at `isMoved` boundaries.
 */
export function splitIntoSubPaths(
	segments: CubicBezierSegment[],
): CubicBezierSegment[][] {
	if (segments.length === 0) return [];

	const subPaths: CubicBezierSegment[][] = [];
	let currentSubPath: CubicBezierSegment[] = [];

	for (const segment of segments) {
		// isMoved is a pen lift (SVG M): the segment opens the next sub-path.
		if (segment.isMoved && currentSubPath.length > 0) {
			subPaths.push(currentSubPath);
			currentSubPath = [];
		}
		currentSubPath.push(segment);
	}

	if (currentSubPath.length > 0) {
		subPaths.push(currentSubPath);
	}

	return subPaths;
}
