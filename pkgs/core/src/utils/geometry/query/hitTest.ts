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
import {
	type CubicCurve,
	evalCubicBezier,
	evalCubicBezierDerivative,
	splitCurve,
} from "../primitives/bezier";
import { expandBounds } from "../primitives/box";
import { resolveSegment } from "../primitives/segment";

/** World length along a curve below which the nearest-point search stops. */
const REFINED_SPAN_WORLD = 0.01;
/** Bounds the nearest-point search on degenerate curves. */
const MAX_REFINEMENT_STEPS = 48;
/** How far a curve may stray from the chords it is tested as. */
const CURVE_FLATNESS_WORLD = 0.5;
/** Fill flatness as a share of the click tolerance a fill hit test is given. */
const FILL_FLATNESS_PER_TOLERANCE = 0.25;
/** Bounds the chord tests at halving a segment 12 times. */
const MAX_SUBDIVISION_DEPTH = 12;

type Rect = Pick<BoundingBox, "minX" | "minY" | "maxX" | "maxY">;

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

	// Refine around bestT until the bracket spans less than
	// REFINED_SPAN_WORLD along the curve, so a long segment is resolved as
	// finely as a short one.
	let tMin = Math.max(0, bestT - 1 / numSamples);
	let tMax = Math.min(1, bestT + 1 / numSamples);
	const length = controlPolygonLength(p0, p1, p2, p3);

	for (
		let step = 0;
		step < MAX_REFINEMENT_STEPS && (tMax - tMin) * length > REFINED_SPAN_WORLD;
		step++
	) {
		const tMid = (tMin + tMax) / 2;
		const pt = evalCubicBezier(p0, p1, p2, p3, tMid);
		const distMid = distanceSquared(px, py, pt.x, pt.y);
		if (distMid < minDistSq) {
			minDistSq = distMid;
			bestT = tMid;
		}

		// Where the tangent points away from the point, the distance grows
		// with t, so the nearest point lies before tMid; otherwise after it.
		const tangent = evalCubicBezierDerivative(p0, p1, p2, p3, tMid);
		if ((pt.x - px) * tangent.x + (pt.y - py) * tangent.y > 0) {
			tMax = tMid;
		} else {
			tMin = tMid;
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
		// The click tolerance is screen pixels over the zoom, so a share of it
		// keeps the fill edge as sharp on screen at any zoom.
		const flatness =
			extraTolerance > 0
				? Math.min(
						CURVE_FLATNESS_WORLD,
						extraTolerance * FILL_FLATNESS_PER_TOLERANCE,
					)
				: CURVE_FLATNESS_WORLD;
		if (isPointInPath(px, py, path, flatness)) {
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
		const start = segment.start ?? prevEnd;
		prevEnd = segment.end;
		if (!start) continue;
		// A curve lies inside its control points' box, so a point farther
		// than the tolerance from that box cannot be near the curve.
		const { cp1, cp2, end } = resolveSegment(segment, start);
		const box = controlBox(start, cp1, cp2, end);
		if (
			px < box.minX - tolerance ||
			px > box.maxX + tolerance ||
			py < box.minY - tolerance ||
			py > box.maxY + tolerance
		) {
			continue;
		}
		if (distanceToSegment(px, py, segment, start).distance <= tolerance) {
			return true;
		}
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

	// Check if the stroke's centerline enters the rect grown by the stroke's
	// reach.
	const rect = {
		minX: rectMinX - strokeReach,
		minY: rectMinY - strokeReach,
		maxX: rectMaxX + strokeReach,
		maxY: rectMaxY + strokeReach,
	};
	let prevEnd: BezierPoint | null = null;
	for (const segment of path.segments) {
		const { start, cp1, cp2, end } = resolveSegment(
			segment,
			prevEnd ?? undefined,
		);
		prevEnd = segment.end;
		if (curveTouchesRect([start, cp1, cp2, end], rect, 0)) return true;
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
 * @param flatness How far, in world units, the curves may be treated as
 *   straight; smaller resolves the fill edge more finely.
 * @returns true if the point is inside the filled area
 */
export function isPointInPath(
	px: number,
	py: number,
	path: Pick<Path, "segments">,
	flatness = CURVE_FLATNESS_WORLD,
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

		windingNumber += curveWinding([start, cp1, cp2, end], px, py, flatness, 0);

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
 * Winding contribution of a cubic for a ray cast from (px, py) toward +x.
 * Halves the curve until a half is flat enough to count as its chord, and
 * drops each half the ray cannot cross, so a curve costs only the halves
 * the ray passes through.
 */
function curveWinding(
	curve: CubicCurve,
	px: number,
	py: number,
	flatness: number,
	depth: number,
): number {
	const [a, b, c, d] = curve;
	// Every chord of the curve stays in its control box, so a box wholly
	// above, below or left of the point holds no chord that crosses the ray.
	const box = controlBox(a, b, c, d);
	if (box.minY > py || box.maxY <= py || box.maxX < px) return 0;
	if (depth >= MAX_SUBDIVISION_DEPTH || isFlat(curve, flatness)) {
		return windingCrossing(a, d, px, py);
	}
	const { left, right } = splitCurve(curve, 0.5);
	return (
		curveWinding(left, px, py, flatness, depth + 1) +
		curveWinding(right, px, py, flatness, depth + 1)
	);
}

/**
 * Whether both inner control points lie within `flatness` of the chord,
 * which keeps the whole curve that close to it.
 */
function isFlat([a, b, c, d]: CubicCurve, flatness: number): boolean {
	return (
		distanceToChord(b, a, d) <= flatness && distanceToChord(c, a, d) <= flatness
	);
}

/** Distance from `p` to the line segment from `a` to `b`. */
function distanceToChord(
	p: BezierPoint,
	a: BezierPoint,
	b: BezierPoint,
): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSq = dx * dx + dy * dy;
	const t =
		lengthSq === 0
			? 0
			: Math.max(
					0,
					Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq),
				);
	return Math.sqrt(distanceSquared(p.x, p.y, a.x + dx * t, a.y + dy * t));
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

/** Length of a cubic's control polygon, which bounds the curve's length. */
function controlPolygonLength(
	p0: BezierPoint,
	p1: BezierPoint,
	p2: BezierPoint,
	p3: BezierPoint,
): number {
	return (
		Math.hypot(p1.x - p0.x, p1.y - p0.y) +
		Math.hypot(p2.x - p1.x, p2.y - p1.y) +
		Math.hypot(p3.x - p2.x, p3.y - p2.y)
	);
}

/** Box around a cubic's control points, which contains the whole curve. */
function controlBox(
	p0: BezierPoint,
	p1: BezierPoint,
	p2: BezierPoint,
	p3: BezierPoint,
): Rect {
	return {
		minX: Math.min(p0.x, p1.x, p2.x, p3.x),
		minY: Math.min(p0.y, p1.y, p2.y, p3.y),
		maxX: Math.max(p0.x, p1.x, p2.x, p3.x),
		maxY: Math.max(p0.y, p1.y, p2.y, p3.y),
	};
}

/**
 * Whether a cubic touches the rect. Halves the curve, dropping each half
 * whose control box misses the rect, until a half is flat enough to test as
 * its chord, so a long curve costs only the halves near the rect.
 */
function curveTouchesRect(
	curve: CubicCurve,
	rect: Rect,
	depth: number,
): boolean {
	const [a, b, c, d] = curve;
	const box = controlBox(a, b, c, d);
	if (
		box.maxX < rect.minX ||
		box.minX > rect.maxX ||
		box.maxY < rect.minY ||
		box.minY > rect.maxY
	) {
		return false;
	}
	if (depth >= MAX_SUBDIVISION_DEPTH || isFlat(curve, CURVE_FLATNESS_WORLD)) {
		return lineTouchesRect(a, d, rect);
	}
	const { left, right } = splitCurve(curve, 0.5);
	return (
		curveTouchesRect(left, rect, depth + 1) ||
		curveTouchesRect(right, rect, depth + 1)
	);
}

/** Whether the line from `a` to `b` touches the rect, by Liang-Barsky clipping. */
function lineTouchesRect(a: BezierPoint, b: BezierPoint, rect: Rect): boolean {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	let tEnter = 0;
	let tExit = 1;
	for (const [p, q] of [
		[-dx, a.x - rect.minX],
		[dx, rect.maxX - a.x],
		[-dy, a.y - rect.minY],
		[dy, rect.maxY - a.y],
	] as const) {
		if (p === 0) {
			if (q < 0) return false;
			continue;
		}
		const t = q / p;
		if (p < 0) {
			if (t > tExit) return false;
			tEnter = Math.max(tEnter, t);
		} else {
			if (t < tEnter) return false;
			tExit = Math.min(tExit, t);
		}
	}
	return true;
}
