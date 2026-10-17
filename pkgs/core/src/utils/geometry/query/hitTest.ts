import { localAppearances } from "../../../document/appearancePresets";
import type {
	BezierPoint,
	BoundingBox,
	CubicBezierSegment,
	Path,
	PathSegment,
} from "../../../schema";
import {
	getStrokeAlign,
	getStrokeWidth,
	strokeOuterReach,
} from "../../elementQuery";
import { calculatePathBounds } from "../measure/pathBounds";
import { evalCubicBezier } from "../primitives/bezier";
import { expandBounds } from "../primitives/box";
import { resolveSegment } from "../primitives/segment";

/**
 * Check if a point is inside a bounding box
 */
export function pointInBounds(
	x: number,
	y: number,
	bounds: BoundingBox,
): boolean {
	return (
		x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY
	);
}

/**
 * Check if two bounding boxes intersect
 */
export function boundsIntersect(a: BoundingBox, b: BoundingBox): boolean {
	return !(
		a.maxX < b.minX ||
		a.minX > b.maxX ||
		a.maxY < b.minY ||
		a.minY > b.maxY
	);
}

// --- Path Hit Testing ---

/**
 * Calculate squared distance from a point to a point
 */
function distanceSquared(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): number {
	const dx = x2 - x1;
	const dy = y2 - y1;
	return dx * dx + dy * dy;
}

/**
 * Calculate the minimum distance from a point to a cubic bezier segment
 * Uses adaptive subdivision for accuracy
 * @param px Point X coordinate
 * @param py Point Y coordinate
 * @param segment The bezier segment
 * @param prevEnd Previous segment end point (used as start if segment.start is undefined)
 * @returns Minimum distance to the curve
 */
export function distanceToSegment(
	px: number,
	py: number,
	segment: CubicBezierSegment,
	prevEnd: BezierPoint | null,
): { distance: number; t: number } {
	const rawStart = segment.start ?? prevEnd;
	if (!rawStart) {
		return { distance: Number.POSITIVE_INFINITY, t: 0 };
	}

	const {
		start: p0,
		cp1: p1,
		cp2: p2,
		end: p3,
	} = resolveSegment(segment, prevEnd ?? undefined);

	// Sample the curve and find the minimum distance
	const numSamples = 20;
	let minDistSq = Number.POSITIVE_INFINITY;
	let bestT = 0;

	for (let i = 0; i <= numSamples; i++) {
		const t = i / numSamples;
		const pt = evalCubicBezier(p0, p1, p2, p3, t);
		const dSq = distanceSquared(px, py, pt.x, pt.y);
		if (dSq < minDistSq) {
			minDistSq = dSq;
			bestT = t;
		}
	}

	// Refine around bestT with binary search
	let tMin = Math.max(0, bestT - 1 / numSamples);
	let tMax = Math.min(1, bestT + 1 / numSamples);
	const refinementSteps = 5;

	for (let step = 0; step < refinementSteps; step++) {
		const tMid = (tMin + tMax) / 2;
		const tLow = (tMin + tMid) / 2;
		const tHigh = (tMid + tMax) / 2;

		const ptLow = evalCubicBezier(p0, p1, p2, p3, tLow);
		const ptHigh = evalCubicBezier(p0, p1, p2, p3, tHigh);

		const distLow = distanceSquared(px, py, ptLow.x, ptLow.y);
		const distHigh = distanceSquared(px, py, ptHigh.x, ptHigh.y);

		if (distLow < distHigh) {
			tMax = tMid;
			if (distLow < minDistSq) {
				minDistSq = distLow;
				bestT = tLow;
			}
		} else {
			tMin = tMid;
			if (distHigh < minDistSq) {
				minDistSq = distHigh;
				bestT = tHigh;
			}
		}
	}

	return { distance: Math.sqrt(minDistSq), t: bestT };
}

/**
 * Check if a point is on a path (within stroke width tolerance)
 * @param px Point X coordinate (world space)
 * @param py Point Y coordinate (world space)
 * @param path The path to test against
 * @param extraTolerance Additional tolerance in world units (for click forgiveness)
 * @returns true if the point is on the path stroke
 */
export function isPointOnPath(
	px: number,
	py: number,
	path: Path,
	extraTolerance = 0,
): boolean {
	if (path.segments.length === 0) return false;

	// First, quick bounds check (already includes stroke width)
	const bounds = calculatePathBounds(path);
	const expandedBounds = expandBounds(bounds, extraTolerance);
	if (!pointInBounds(px, py, expandedBounds)) {
		return false;
	}

	// If path has fill, check if point is inside the filled area
	const hasFill = localAppearances(path.filters).some(
		(f) => f.processor === "fill",
	);
	if (hasFill) {
		if (isPointInPath(px, py, path)) {
			return true;
		}
	}

	// Calculate hit tolerance: half stroke width + extra tolerance
	const hitTolerance =
		strokeOuterReach(
			getStrokeWidth(path.filters, 0),
			getStrokeAlign(path.filters),
		) + extraTolerance;
	return isPointNearSegments(px, py, path.segments, hitTolerance);
}

/** True when the point lies within `tolerance` of any segment's curve. */
export function isPointNearSegments(
	px: number,
	py: number,
	segments: readonly PathSegment[],
	tolerance: number,
): boolean {
	let prevEnd: BezierPoint | null = null;
	for (const segment of segments) {
		const { distance } = distanceToSegment(px, py, segment, prevEnd);
		if (distance <= tolerance) return true;
		prevEnd = segment.end;
	}
	return false;
}

/**
 * Check if a path's actual geometry (stroke + fill) intersects with a rectangle.
 * Used for marquee selection to avoid false positives from AABB-only checks.
 */
export function doesPathIntersectRect(
	path: Pick<Path, "segments" | "filters">,
	rectMinX: number,
	rectMinY: number,
	rectMaxX: number,
	rectMaxY: number,
): boolean {
	if (path.segments.length === 0) return false;

	const strokeReach = strokeOuterReach(
		getStrokeWidth(path.filters, 0),
		getStrokeAlign(path.filters),
	);
	const hasFill = localAppearances(path.filters).some(
		(f) => f.processor === "fill",
	);

	// Check if any sampled point on the stroke is inside the rect
	let prevEnd: BezierPoint | null = null;
	for (const segment of path.segments) {
		const { start, cp1, cp2, end } = resolveSegment(
			segment,
			prevEnd ?? undefined,
		);

		const numSamples = 16;
		for (let i = 0; i <= numSamples; i++) {
			const pt = evalCubicBezier(start, cp1, cp2, end, i / numSamples);
			if (
				pt.x + strokeReach >= rectMinX &&
				pt.x - strokeReach <= rectMaxX &&
				pt.y + strokeReach >= rectMinY &&
				pt.y - strokeReach <= rectMaxY
			) {
				return true;
			}
		}

		prevEnd = segment.end;
	}

	// If filled, check if any corner of the rect is inside the path
	if (hasFill) {
		for (const [cx, cy] of [
			[rectMinX, rectMinY],
			[rectMaxX, rectMinY],
			[rectMinX, rectMaxY],
			[rectMaxX, rectMaxY],
		] as const) {
			if (isPointInPath(cx, cy, path)) return true;
		}
	}

	return false;
}

/**
 * Check if a point is inside a closed path using winding number algorithm
 * @param px Point X coordinate (world space)
 * @param py Point Y coordinate (world space)
 * @param path The path to test against
 * @returns true if the point is inside the filled area
 */
export function isPointInPath(
	px: number,
	py: number,
	path: Pick<Path, "segments">,
): boolean {
	if (path.segments.length === 0) return false;

	let windingNumber = 0;
	let prevEnd: BezierPoint | null = null;
	let contourStart: BezierPoint | null = null;

	for (const segment of path.segments) {
		const rawStart = segment.start ?? prevEnd;
		if (!rawStart) continue;

		// Each contour closes back onto its own start. Closing the whole path
		// at once would draw a phantom edge from one contour to the next and
		// flip the winding of points in the gap between them. A contour begins
		// where the pen lifts, i.e. an explicit start away from the previous
		// end; isMoved alone is not a lift, since an image quad marks each
		// side isMoved while still chaining into one polygon.
		const lifted =
			prevEnd !== null &&
			segment.start !== undefined &&
			(segment.start.x !== prevEnd.x || segment.start.y !== prevEnd.y);
		if (contourStart === null || lifted) {
			if (contourStart && prevEnd) {
				windingNumber += windingCrossing(prevEnd, contourStart, px, py);
			}
			contourStart = rawStart;
		}

		const { start, cp1, cp2, end } = resolveSegment(
			segment,
			prevEnd ?? undefined,
		);

		// Flatten bezier curve into line segments for winding number calculation
		const points = flattenBezierSegment(start, cp1, cp2, end);
		for (let i = 0; i < points.length - 1; i++) {
			windingNumber += windingCrossing(points[i], points[i + 1], px, py);
		}

		prevEnd = segment.end;
	}

	// For a closed contour this is a zero-length edge; an open contour is
	// implicitly closed with a straight line.
	if (contourStart && prevEnd) {
		windingNumber += windingCrossing(prevEnd, contourStart, px, py);
	}

	return windingNumber !== 0;
}

/**
 * Winding contribution of the edge p1→p2 for a ray cast from (px, py)
 * toward +x: +1 for an upward crossing, -1 for a downward one, else 0.
 */
function windingCrossing(
	p1: BezierPoint,
	p2: BezierPoint,
	px: number,
	py: number,
): number {
	if (p1.y <= py) {
		return p2.y > py && isLeft(p1, p2, px, py) > 0 ? 1 : 0;
	}
	return p2.y <= py && isLeft(p1, p2, px, py) < 0 ? -1 : 0;
}

/**
 * Flatten a cubic bezier segment into line segments for polygon testing
 */
function flattenBezierSegment(
	p0: BezierPoint,
	p1: BezierPoint,
	p2: BezierPoint,
	p3: BezierPoint,
	tolerance = 0.5,
): BezierPoint[] {
	const points: BezierPoint[] = [p0];

	function subdivide(
		t0: number,
		t1: number,
		q0: BezierPoint,
		q3: BezierPoint,
		depth: number,
	): void {
		if (depth > 12) {
			points.push(q3);
			return;
		}

		// Calculate midpoint at t = 0.5
		const tMid = (t0 + t1) / 2;
		const t = tMid;
		const mt = 1 - t;
		const qMid = {
			x:
				mt * mt * mt * p0.x +
				3 * mt * mt * t * p1.x +
				3 * mt * t * t * p2.x +
				t * t * t * p3.x,
			y:
				mt * mt * mt * p0.y +
				3 * mt * mt * t * p1.y +
				3 * mt * t * t * p2.y +
				t * t * t * p3.y,
		};

		// Check if line q0-q3 is close enough to curve
		const dx = q3.x - q0.x;
		const dy = q3.y - q0.y;
		const d = Math.sqrt(dx * dx + dy * dy);

		if (d < tolerance) {
			points.push(q3);
			return;
		}

		const midX = (q0.x + q3.x) / 2;
		const midY = (q0.y + q3.y) / 2;
		const distFromLine = Math.abs(
			(qMid.x - midX) * (qMid.x - midX) + (qMid.y - midY) * (qMid.y - midY),
		);

		if (distFromLine < tolerance * tolerance) {
			points.push(q3);
			return;
		}

		// Subdivide recursively
		subdivide(t0, tMid, q0, qMid, depth + 1);
		subdivide(tMid, t1, qMid, q3, depth + 1);
	}

	subdivide(0, 1, p0, p3, 0);
	return points;
}

/**
 * Test if point is left/on/right of an infinite line
 * @returns >0 for point left of line, =0 for on line, <0 for right of line
 */
function isLeft(
	p1: BezierPoint,
	p2: BezierPoint,
	px: number,
	py: number,
): number {
	return (p2.x - p1.x) * (py - p1.y) - (px - p1.x) * (p2.y - p1.y);
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon(
	px: number,
	py: number,
	polygon: ReadonlyArray<{ x: number; y: number }>,
): boolean {
	if (polygon.length < 3) return false;

	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const xi = polygon[i].x;
		const yi = polygon[i].y;
		const xj = polygon[j].x;
		const yj = polygon[j].y;

		if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
	}
	return inside;
}
