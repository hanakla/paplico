/**
 * Path Operations
 *
 * Boolean operations for compound paths (union, subtract, intersect, exclude)
 * and path splitting operations (eraser, anchor point splitting).
 */

import polygonClipping from "polygon-clipping";
import {
	type BezierPoint,
	type CompoundPathSource,
	type CubicBezierSegment,
	generateUid,
	type Path,
	type PathSegment,
	type StrokeWidthPoint,
} from "../../schema";
import { getStrokeWidth } from "../elementQuery";
import {
	getStartAnchor,
	resolveCP1,
	resolveCP2,
	resolveSegment,
	toRelativeCP1,
	toRelativeCP2,
} from "./segmentOps";
import { type FittedCubic, fitCubicBeziers } from "./strokeFitting";

// ============================================================================
// Boolean Operations
// ============================================================================

type Coord = [number, number];
type Ring = Coord[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

interface ComputeBooleanOperationOptions {
	curveTolerance?: number;
	maxFlattenDepth?: number;
	minEdgeLength?: number;
}

const EPSILON = 0.001;
const DEFAULT_CURVE_TOLERANCE = 0.25;
const DEFAULT_MAX_FLATTEN_DEPTH = 10;
const DEFAULT_MIN_EDGE_LENGTH = 0.05;

const MIN_CURVE_TOLERANCE = 0.01;
const MIN_MAX_FLATTEN_DEPTH = 1;
const MIN_EDGE_LENGTH = 0.001;

type NormalizedComputeOptions = {
	curveToleranceSquared: number;
	maxFlattenDepth: number;
	minEdgeLength: number;
};

/**
 * Compute boolean operations on multiple paths using per-source operations.
 * Each source (except the first) specifies its own boolean operation against
 * the accumulated result. Returns the resulting bezier segments.
 */
export function computeBooleanOperation(
	sources: CompoundPathSource[],
	pathMap: Map<string, Path>,
	options: ComputeBooleanOperationOptions = {},
): CubicBezierSegment[] {
	if (sources.length === 0) return [];

	const normalizedOptions = normalizeOptions(options);
	const firstPath = pathMap.get(sources[0].id);
	if (!firstPath) return [];
	if (sources.length === 1) return firstPath.segments ?? [];

	let result: MultiPolygon = pathToPolygon(firstPath, normalizedOptions);
	if (result.length === 0) return [];

	for (let i = 1; i < sources.length; i++) {
		const path = pathMap.get(sources[i].id);
		if (!path) continue;

		const poly = pathToPolygon(path, normalizedOptions);
		if (poly.length === 0) continue;

		switch (sources[i].op) {
			case "union":
				result = polygonClipping.union(result, poly);
				break;
			case "subtract":
				result = polygonClipping.difference(result, poly);
				break;
			case "intersect":
				result = polygonClipping.intersection(result, poly);
				break;
			case "exclude":
				result = polygonClipping.xor(result, poly);
				break;
			default:
				throw new Error(`Unknown boolean operation: ${sources[i].op}`);
		}
	}

	return multiPolygonToSegments(result, normalizedOptions.minEdgeLength);
}

/**
 * Convert a Path to a MultiPolygon for polygon-clipping.
 * Handles both stroked paths and filled paths differently.
 */
function pathToPolygon(
	path: Path,
	options: NormalizedComputeOptions,
): MultiPolygon {
	const points = sampleBezierPath(path.segments, options);

	if (points.length < 3) {
		return [];
	}

	const hasFill = path.filters?.some((f) => f.processor === "fill");
	if (hasFill || isPathClosed(path.segments)) {
		const ring: Ring = points.map((p) => [p.x, p.y]);
		if (
			ring.length > 0 &&
			(ring[0][0] !== ring[ring.length - 1][0] ||
				ring[0][1] !== ring[ring.length - 1][1])
		) {
			ring.push([...ring[0]]);
		}
		return [[ring]];
	}

	return createStrokeOutline(points, getStrokeWidth(path.filters));
}

/**
 * Sample bezier path into discrete points via adaptive flattening.
 */
function sampleBezierPath(
	segments: CubicBezierSegment[],
	options: NormalizedComputeOptions,
): BezierPoint[] {
	const points: BezierPoint[] = [];

	for (let segIdx = 0; segIdx < segments.length; segIdx++) {
		const segment = segments[segIdx];
		const prevEnd = segIdx > 0 ? segments[segIdx - 1].end : undefined;
		const { start, cp1, cp2, end } = resolveSegment(segment, prevEnd);

		appendAdaptiveFlattenedSegment(
			points,
			start,
			cp1,
			cp2,
			end,
			options.curveToleranceSquared,
			options.maxFlattenDepth,
		);
	}

	return points;
}

function appendAdaptiveFlattenedSegment(
	points: BezierPoint[],
	start: BezierPoint,
	cp1: BezierPoint,
	cp2: BezierPoint,
	end: BezierPoint,
	curveToleranceSquared: number,
	maxFlattenDepth: number,
): void {
	if (points.length === 0 || !pointsEqual(points[points.length - 1], start)) {
		points.push(start);
	}

	subdivideCubicBezier(
		points,
		start,
		cp1,
		cp2,
		end,
		curveToleranceSquared,
		maxFlattenDepth,
		0,
	);
}

function subdivideCubicBezier(
	points: BezierPoint[],
	p0: BezierPoint,
	p1: BezierPoint,
	p2: BezierPoint,
	p3: BezierPoint,
	curveToleranceSquared: number,
	maxFlattenDepth: number,
	depth: number,
): void {
	if (
		depth >= maxFlattenDepth ||
		isCubicFlatEnough(p0, p1, p2, p3, curveToleranceSquared)
	) {
		if (!pointsEqual(points[points.length - 1], p3)) {
			points.push(p3);
		}
		return;
	}

	const [left, right] = splitCubicBezierHalf(p0, p1, p2, p3);
	subdivideCubicBezier(
		points,
		left[0],
		left[1],
		left[2],
		left[3],
		curveToleranceSquared,
		maxFlattenDepth,
		depth + 1,
	);
	subdivideCubicBezier(
		points,
		right[0],
		right[1],
		right[2],
		right[3],
		curveToleranceSquared,
		maxFlattenDepth,
		depth + 1,
	);
}

function splitCubicBezierHalf(
	p0: BezierPoint,
	p1: BezierPoint,
	p2: BezierPoint,
	p3: BezierPoint,
): [
	[BezierPoint, BezierPoint, BezierPoint, BezierPoint],
	[BezierPoint, BezierPoint, BezierPoint, BezierPoint],
] {
	const p01 = midpoint(p0, p1);
	const p12 = midpoint(p1, p2);
	const p23 = midpoint(p2, p3);
	const p012 = midpoint(p01, p12);
	const p123 = midpoint(p12, p23);
	const p0123 = midpoint(p012, p123);

	return [
		[p0, p01, p012, p0123],
		[p0123, p123, p23, p3],
	];
}

function midpoint(a: BezierPoint, b: BezierPoint): BezierPoint {
	return {
		x: (a.x + b.x) * 0.5,
		y: (a.y + b.y) * 0.5,
	};
}

function isCubicFlatEnough(
	p0: BezierPoint,
	p1: BezierPoint,
	p2: BezierPoint,
	p3: BezierPoint,
	curveToleranceSquared: number,
): boolean {
	const chordX = p3.x - p0.x;
	const chordY = p3.y - p0.y;
	const chordLengthSquared = chordX * chordX + chordY * chordY;

	if (chordLengthSquared <= Number.EPSILON) {
		return (
			Math.max(
				distanceSquared(p0, p1),
				distanceSquared(p0, p2),
				distanceSquared(p0, p3),
			) <= curveToleranceSquared
		);
	}

	const dist1Squared = signedDoubleAreaSquared(p0, p3, p1) / chordLengthSquared;
	const dist2Squared = signedDoubleAreaSquared(p0, p3, p2) / chordLengthSquared;
	return Math.max(dist1Squared, dist2Squared) <= curveToleranceSquared;
}

function signedDoubleAreaSquared(
	a: BezierPoint,
	b: BezierPoint,
	p: BezierPoint,
): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const cross = dx * (a.y - p.y) - dy * (a.x - p.x);
	return cross * cross;
}

/**
 * Check if two points are approximately equal.
 */
function pointsEqual(
	a: BezierPoint,
	b: BezierPoint,
	epsilon = EPSILON,
): boolean {
	return Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon;
}

function distanceSquared(a: BezierPoint, b: BezierPoint): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return dx * dx + dy * dy;
}

/**
 * Check if a path is closed (first point equals last point).
 */
function isPathClosed(segments: CubicBezierSegment[]): boolean {
	if (segments.length === 0) return false;
	return segments[segments.length - 1].isClosed === true;
}

/**
 * Create an outline polygon from a stroked path.
 * This creates a "thick line" polygon for boolean operations.
 */
function createStrokeOutline(
	points: BezierPoint[],
	strokeWidth: number,
): MultiPolygon {
	if (points.length < 2) return [];

	const halfWidth = strokeWidth / 2;
	const leftSide: Coord[] = [];
	const rightSide: Coord[] = [];

	for (let i = 0; i < points.length; i++) {
		const curr = points[i];
		const prev = points[i - 1] ?? curr;
		const next = points[i + 1] ?? curr;

		const dx1 = curr.x - prev.x;
		const dy1 = curr.y - prev.y;
		const dx2 = next.x - curr.x;
		const dy2 = next.y - curr.y;

		let dx = dx1 + dx2;
		let dy = dy1 + dy2;
		const len = Math.sqrt(dx * dx + dy * dy);

		if (len < 0.0001) {
			dx = dy1 !== 0 ? 1 : 0;
			dy = dx1 !== 0 ? 1 : 0;
		} else {
			dx /= len;
			dy /= len;
		}

		const nx = -dy;
		const ny = dx;
		leftSide.push([curr.x + nx * halfWidth, curr.y + ny * halfWidth]);
		rightSide.push([curr.x - nx * halfWidth, curr.y - ny * halfWidth]);
	}

	const ring: Ring = [...leftSide, ...rightSide.reverse()];
	ring.push([...ring[0]]);

	return [[ring]];
}

/**
 * Convert a MultiPolygon result back to bezier segments.
 * Uses linear segments with point cleanup to reduce jagged noise.
 */
function multiPolygonToSegments(
	multiPoly: MultiPolygon,
	minEdgeLength: number,
): CubicBezierSegment[] {
	const segments: CubicBezierSegment[] = [];
	const minEdgeLengthSquared = minEdgeLength * minEdgeLength;

	for (const polygon of multiPoly) {
		for (const ring of polygon) {
			const ringPoints = normalizeRingPoints(ring, minEdgeLengthSquared);
			if (ringPoints.length < 3) continue;

			const ringSegments: CubicBezierSegment[] = [];
			let isFirstSegment = true;

			for (let i = 0; i < ringPoints.length; i++) {
				const start = ringPoints[i];
				const end = ringPoints[(i + 1) % ringPoints.length];

				if (distanceSquared(start, end) < minEdgeLengthSquared) continue;

				const dx = end.x - start.x;
				const dy = end.y - start.y;
				const cp1: BezierPoint = {
					x: dx / 3,
					y: dy / 3,
				};
				const cp2: BezierPoint = {
					x: -dx / 3,
					y: -dy / 3,
				};

				ringSegments.push({
					start: isFirstSegment ? start : undefined,
					cp1,
					cp2,
					end,
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
					isMoved: isFirstSegment,
				});

				isFirstSegment = false;
			}

			if (ringSegments.length === 0) continue;
			const lastIndex = ringSegments.length - 1;
			ringSegments[lastIndex] = {
				...ringSegments[lastIndex],
				isClosed: true,
			};
			segments.push(...ringSegments);
		}
	}

	return segments;
}

function normalizeRingPoints(
	ring: Ring,
	minEdgeLengthSquared: number,
): BezierPoint[] {
	if (ring.length < 3) return [];

	const deduped: BezierPoint[] = [];
	for (const coord of ring) {
		const point: BezierPoint = { x: coord[0], y: coord[1] };
		if (
			deduped.length === 0 ||
			!pointsEqual(deduped[deduped.length - 1], point)
		) {
			deduped.push(point);
		}
	}

	if (
		deduped.length > 1 &&
		pointsEqual(deduped[0], deduped[deduped.length - 1])
	) {
		deduped.pop();
	}

	if (deduped.length < 3) return [];

	const filtered: BezierPoint[] = [deduped[0]];
	for (let i = 1; i < deduped.length; i++) {
		const prev = filtered[filtered.length - 1];
		const curr = deduped[i];
		if (distanceSquared(prev, curr) >= minEdgeLengthSquared) {
			filtered.push(curr);
		}
	}

	while (
		filtered.length >= 2 &&
		distanceSquared(filtered[0], filtered[filtered.length - 1]) <
			minEdgeLengthSquared
	) {
		filtered.pop();
	}

	if (filtered.length < 3) return [];
	return filtered;
}

function normalizeOptions(
	options: ComputeBooleanOperationOptions,
): NormalizedComputeOptions {
	const curveTolerance = Math.max(
		options.curveTolerance ?? DEFAULT_CURVE_TOLERANCE,
		MIN_CURVE_TOLERANCE,
	);
	const maxFlattenDepth = Math.max(
		Math.floor(options.maxFlattenDepth ?? DEFAULT_MAX_FLATTEN_DEPTH),
		MIN_MAX_FLATTEN_DEPTH,
	);
	const minEdgeLength = Math.max(
		options.minEdgeLength ?? DEFAULT_MIN_EDGE_LENGTH,
		MIN_EDGE_LENGTH,
	);

	return {
		curveToleranceSquared: curveTolerance * curveTolerance,
		maxFlattenDepth,
		minEdgeLength,
	};
}

// ============================================================================
// Path Splitting
// ============================================================================

interface Point {
	x: number;
	y: number;
}

/**
 * Evaluate cubic Bezier curve at parameter t (0-1)
 */
export function evalBezier(
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	t: number,
): Point {
	const u = 1 - t;
	const tt = t * t;
	const uu = u * u;
	const uuu = uu * u;
	const ttt = tt * t;

	const x = uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x;
	const y = uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y;

	return { x, y };
}

/**
 * Split a cubic Bezier curve at parameter t
 * Returns two new cubic Bezier segments
 */
export function splitBezierAtT(
	p0: BezierPoint,
	p1: BezierPoint,
	p2: BezierPoint,
	p3: BezierPoint,
	t: number,
): [
	{ p0: BezierPoint; p1: BezierPoint; p2: BezierPoint; p3: BezierPoint },
	{ p0: BezierPoint; p1: BezierPoint; p2: BezierPoint; p3: BezierPoint },
] {
	// De Casteljau's algorithm for subdivision
	const q0 = {
		x: p0.x + (p1.x - p0.x) * t,
		y: p0.y + (p1.y - p0.y) * t,
		pressure: p0.pressure,
	};
	const q1 = {
		x: p1.x + (p2.x - p1.x) * t,
		y: p1.y + (p2.y - p1.y) * t,
		pressure: p1.pressure,
	};
	const q2 = {
		x: p2.x + (p3.x - p2.x) * t,
		y: p2.y + (p3.y - p2.y) * t,
		pressure: p3.pressure,
	};

	const r0 = {
		x: q0.x + (q1.x - q0.x) * t,
		y: q0.y + (q1.y - q0.y) * t,
		pressure: q0.pressure,
	};
	const r1 = {
		x: q1.x + (q2.x - q1.x) * t,
		y: q1.y + (q2.y - q1.y) * t,
		pressure: q1.pressure,
	};

	// Interpolate pressure linearly between start and end at parameter t
	const splitPressure =
		p0.pressure != null && p3.pressure != null
			? p0.pressure + (p3.pressure - p0.pressure) * t
			: (p0.pressure ?? p3.pressure);

	const s = {
		x: r0.x + (r1.x - r0.x) * t,
		y: r0.y + (r1.y - r0.y) * t,
		pressure: splitPressure,
	};

	return [
		{ p0, p1: q0, p2: r0, p3: s },
		{ p0: s, p1: r1, p2: q2, p3 },
	];
}

/**
 * Calculate squared distance from point to line segment (avoids sqrt).
 */
function pointToSegmentDistanceSq(
	point: Point,
	segStart: Point,
	segEnd: Point,
): number {
	const dx = segEnd.x - segStart.x;
	const dy = segEnd.y - segStart.y;
	const lenSq = dx * dx + dy * dy;

	if (lenSq === 0) {
		const pdx = point.x - segStart.x;
		const pdy = point.y - segStart.y;
		return pdx * pdx + pdy * pdy;
	}

	const t = Math.max(
		0,
		Math.min(
			1,
			((point.x - segStart.x) * dx + (point.y - segStart.y) * dy) / lenSq,
		),
	);

	const projX = segStart.x + t * dx;
	const projY = segStart.y + t * dy;
	const pdx = point.x - projX;
	const pdy = point.y - projY;

	return pdx * pdx + pdy * pdy;
}

/**
 * Check if a point on the bezier curve is within eraser radius
 */
function isPointErased(
	point: Point,
	eraserStroke: Point[],
	eraserRadius: number,
): boolean {
	return isPointErasedSq(point, eraserStroke, eraserRadius * eraserRadius);
}

/**
 * Check if a point is within eraser radius using squared distance (avoids sqrt).
 */
function isPointErasedSq(
	point: Point,
	eraserStroke: Point[],
	eraserRadiusSq: number,
): boolean {
	// Handle single point (click without drag)
	if (eraserStroke.length === 1) {
		const dx = point.x - eraserStroke[0].x;
		const dy = point.y - eraserStroke[0].y;
		return dx * dx + dy * dy <= eraserRadiusSq;
	}

	// Handle stroke with multiple points
	for (let j = 0; j < eraserStroke.length - 1; j++) {
		const distSq = pointToSegmentDistanceSq(
			point,
			eraserStroke[j],
			eraserStroke[j + 1],
		);
		if (distSq <= eraserRadiusSq) {
			return true;
		}
	}
	return false;
}

/**
 * Split a path by eraser stroke and return remaining path segments.
 * Each resulting fragment carries pathStart/pathEnd metadata indicating
 * its normalized position within the original stroke.
 */
export function splitPathByEraser(
	path: Path,
	eraserStroke: Point[],
	eraserRadius: number,
): Path[] {
	if (eraserStroke.length === 0) {
		return [path];
	}

	// Pre-compute per-segment lengths and cumulative start offsets
	// for pathStart/pathEnd calculation.
	const segCount = path.segments.length;
	const segStartAccum = new Float64Array(segCount);
	let totalLength = 0;

	for (let si = 0; si < segCount; si++) {
		const seg = path.segments[si];
		const prevEnd = si > 0 ? path.segments[si - 1].end : undefined;
		const {
			start: s0,
			cp1: s1,
			cp2: s2,
			end: s3,
		} = resolveSegment(seg, prevEnd);

		segStartAccum[si] = totalLength;
		const len = approximateBezierArcLength(s0, s1, s2, s3, 0, 1);
		totalLength += len;
	}

	const resultPaths: Path[] = [];
	let currentSegments: PathSegment[] = [];
	let fragmentStartAccumLen = 0;
	let fragmentEndAccumLen = 0;

	// Sample each segment and build up non-erased regions
	for (let segIdx = 0; segIdx < segCount; segIdx++) {
		const segment = path.segments[segIdx];
		const prevEnd = segIdx > 0 ? path.segments[segIdx - 1].end : undefined;
		const {
			start: p0,
			cp1: p1,
			cp2: p2,
			end: p3,
		} = resolveSegment(segment, prevEnd);

		const segStartLen = segStartAccum[segIdx];

		// Sample the bezier curve
		const samples = 50;
		const erasedFlags: boolean[] = [];

		for (let i = 0; i <= samples; i++) {
			const t = i / samples;
			const point = evalBezier(p0, p1, p2, p3, t);
			erasedFlags.push(isPointErased(point, eraserStroke, eraserRadius));
		}

		// Find continuous non-erased regions
		let regionStart: number | null = null;
		const regions: Array<{ start: number; end: number }> = [];

		for (let i = 0; i <= samples; i++) {
			if (!erasedFlags[i] && regionStart === null) {
				regionStart = i / samples;
			} else if (erasedFlags[i] && regionStart !== null) {
				regions.push({ start: regionStart, end: i / samples });
				regionStart = null;
			}
		}

		if (regionStart !== null) {
			regions.push({ start: regionStart, end: 1.0 });
		}

		// If segment starts erased (region doesn't start at 0), finalize previous path
		const startsErased = regions.length === 0 || regions[0].start > 0.02;
		if (startsErased && currentSegments.length > 0) {
			const ps = totalLength > 0 ? fragmentStartAccumLen / totalLength : 0;
			const pe = totalLength > 0 ? fragmentEndAccumLen / totalLength : 1;
			resultPaths.push(createPathFromSegments(path, currentSegments, ps, pe));
			currentSegments = [];
		}

		// Add non-erased regions to current segments
		for (let regionIdx = 0; regionIdx < regions.length; regionIdx++) {
			const region = regions[regionIdx];
			let bezier = { p0, p1, p2, p3 };

			// Track accumulated lengths for this region
			const regionStartLen =
				segStartLen +
				approximateBezierArcLength(p0, p1, p2, p3, 0, region.start);
			const regionEndLen =
				segStartLen + approximateBezierArcLength(p0, p1, p2, p3, 0, region.end);

			// Extract the region [region.start, region.end]
			if (region.start > 0) {
				const [, right] = splitBezierAtT(
					bezier.p0,
					bezier.p1,
					bezier.p2,
					bezier.p3,
					region.start,
				);
				bezier = right;
			}

			if (region.end < 1) {
				const adjustedT = (region.end - region.start) / (1 - region.start);
				const [left] = splitBezierAtT(
					bezier.p0,
					bezier.p1,
					bezier.p2,
					bezier.p3,
					adjustedT,
				);
				bezier = left;
			}

			// Record fragment start when beginning a new fragment
			if (currentSegments.length === 0) {
				fragmentStartAccumLen = regionStartLen;
			}
			fragmentEndAccumLen = regionEndLen;

			// Add segment to current path
			const startAnchor =
				currentSegments.length === 0
					? bezier.p0
					: currentSegments[currentSegments.length - 1].end;
			// Interpolate pressure from the original segment's range
			const origStartP = segment.startPressure;
			const origEndP = segment.endPressure;
			const regionStartPressure =
				origStartP != null && origEndP != null
					? origStartP + (origEndP - origStartP) * region.start
					: (origStartP ?? origEndP);
			const regionEndPressure =
				origStartP != null && origEndP != null
					? origStartP + (origEndP - origStartP) * region.end
					: (origStartP ?? origEndP);

			// Interpolate tilt/deltaTime from the original segment's range
			const origStartTiltX = segment.startTiltX;
			const origEndTiltX = segment.endTiltX;
			const regionStartTiltX =
				origStartTiltX != null && origEndTiltX != null
					? origStartTiltX + (origEndTiltX - origStartTiltX) * region.start
					: (origStartTiltX ?? origEndTiltX);
			const regionEndTiltX =
				origStartTiltX != null && origEndTiltX != null
					? origStartTiltX + (origEndTiltX - origStartTiltX) * region.end
					: (origStartTiltX ?? origEndTiltX);

			const origStartTiltY = segment.startTiltY;
			const origEndTiltY = segment.endTiltY;
			const regionStartTiltY =
				origStartTiltY != null && origEndTiltY != null
					? origStartTiltY + (origEndTiltY - origStartTiltY) * region.start
					: (origStartTiltY ?? origEndTiltY);
			const regionEndTiltY =
				origStartTiltY != null && origEndTiltY != null
					? origStartTiltY + (origEndTiltY - origStartTiltY) * region.end
					: (origStartTiltY ?? origEndTiltY);

			const origStartDT = segment.startDeltaTime;
			const origEndDT = segment.endDeltaTime;
			const regionStartDeltaTime =
				origStartDT != null && origEndDT != null
					? origStartDT + (origEndDT - origStartDT) * region.start
					: (origStartDT ?? origEndDT);
			const regionEndDeltaTime =
				origStartDT != null && origEndDT != null
					? origStartDT + (origEndDT - origStartDT) * region.end
					: (origStartDT ?? origEndDT);

			currentSegments.push({
				start: currentSegments.length === 0 ? bezier.p0 : undefined,
				cp1: toRelativeCP1(bezier.p1, startAnchor),
				cp2: toRelativeCP2(bezier.p2, bezier.p3),
				end: bezier.p3,
				isMoved: currentSegments.length === 0,
				startPressure: regionStartPressure,
				endPressure: regionEndPressure,
				startTiltX: regionStartTiltX,
				startTiltY: regionStartTiltY,
				endTiltX: regionEndTiltX,
				endTiltY: regionEndTiltY,
				startDeltaTime: regionStartDeltaTime,
				endDeltaTime: regionEndDeltaTime,
				// Preserve corner radius only when the original end point is retained
				cornerRadius: region.end >= 0.98 ? segment.cornerRadius : undefined,
				cornerSuperellipseN:
					region.end >= 0.98 ? segment.cornerSuperellipseN : undefined,
			});

			// If there are more regions in this segment, finalize current path and start a new one
			if (regionIdx < regions.length - 1) {
				if (currentSegments.length > 0) {
					const ps = totalLength > 0 ? fragmentStartAccumLen / totalLength : 0;
					const pe = totalLength > 0 ? fragmentEndAccumLen / totalLength : 1;
					resultPaths.push(
						createPathFromSegments(path, currentSegments, ps, pe),
					);
					currentSegments = [];
				}
			}
		}
	}

	// Finalize last path if any segments remain
	if (currentSegments.length > 0) {
		const ps = totalLength > 0 ? fragmentStartAccumLen / totalLength : 0;
		const pe = totalLength > 0 ? fragmentEndAccumLen / totalLength : 1;
		resultPaths.push(createPathFromSegments(path, currentSegments, ps, pe));
	}

	return resultPaths;
}

/**
 * Remove normalized arc-length ranges from a path.
 *
 * Range boundaries are converted to Bezier parameters by arc-length bisection,
 * then the original curves are subdivided with De Casteljau's algorithm.
 */
export function splitPathByNormalizedRanges(
	path: Path,
	erasedRanges: Array<{ start: number; end: number }>,
): Path[] {
	const ranges = normalizePathRanges(erasedRanges);
	if (ranges.length === 0) return [path];

	let subpathIndex = -1;
	let accumulatedLength = 0;
	const segmentData = path.segments.map((segment, index) => {
		const startsSubpath =
			index === 0 || segment.isMoved === true || segment.start !== undefined;
		if (startsSubpath) subpathIndex++;

		const previousEnd = index > 0 ? path.segments[index - 1].end : undefined;
		const bezier = resolveSegment(segment, previousEnd);
		const length = approximateBezierArcLength(
			bezier.start,
			bezier.cp1,
			bezier.cp2,
			bezier.end,
			0,
			1,
		);
		const startLength = accumulatedLength;
		accumulatedLength += length;
		return {
			segment,
			bezier,
			length,
			startLength,
			endLength: accumulatedLength,
			subpathIndex,
		};
	});
	const totalLength = accumulatedLength;
	if (totalLength <= Number.EPSILON) return [];
	const subpathLengths = new Map<
		number,
		{ startLength: number; endLength: number }
	>();
	for (const data of segmentData) {
		const subpath = subpathLengths.get(data.subpathIndex);
		if (subpath) {
			subpath.endLength = data.endLength;
		} else {
			subpathLengths.set(data.subpathIndex, {
				startLength: data.startLength,
				endLength: data.endLength,
			});
		}
	}

	const result: Path[] = [];
	for (const visibleRange of invertPathRanges(ranges)) {
		const startLength = visibleRange.start * totalLength;
		const endLength = visibleRange.end * totalLength;
		const segments: PathSegment[] = [];
		let outputSubpathIndex: number | undefined;

		for (const {
			segment,
			bezier,
			length,
			startLength: segmentStartLength,
			endLength: segmentEndLength,
			subpathIndex: currentSubpathIndex,
		} of segmentData) {
			const visibleStart = Math.max(startLength, segmentStartLength);
			const visibleEnd = Math.min(endLength, segmentEndLength);

			if (visibleEnd > visibleStart && length > Number.EPSILON) {
				const startT = findBezierTAtArcLength(
					bezier.start,
					bezier.cp1,
					bezier.cp2,
					bezier.end,
					visibleStart - segmentStartLength,
					length,
				);
				const endT = findBezierTAtArcLength(
					bezier.start,
					bezier.cp1,
					bezier.cp2,
					bezier.end,
					visibleEnd - segmentStartLength,
					length,
				);
				const startsOutputSubpath =
					segments.length === 0 || outputSubpathIndex !== currentSubpathIndex;
				const subpathLength = subpathLengths.get(currentSubpathIndex)!;
				const preservesClosedSubpath =
					segment.isClosed === true &&
					startLength <= subpathLength.startLength + Number.EPSILON &&
					endLength >= subpathLength.endLength - Number.EPSILON;
				segments.push(
					createSegmentRange(
						segment,
						bezier,
						startT,
						endT,
						startsOutputSubpath,
						preservesClosedSubpath,
					),
				);
				outputSubpathIndex = currentSubpathIndex;
			}
		}

		if (segments.length > 0) {
			result.push(
				createPathFromSegments(
					path,
					segments,
					visibleRange.start,
					visibleRange.end,
				),
			);
		}
	}

	return result;
}

const SAMPLES_PER_SEGMENT = 16;

/**
 * Subtract eraser stroke shape from a filled path using polygon boolean difference.
 * Converts the path to a polygon, performs boolean difference with the eraser polygon,
 * and converts the result back to bezier segments.
 */
export function subtractEraserFromFilledPath(
	path: Path,
	eraserStroke: Point[],
	eraserRadius: number,
): Path[] {
	if (eraserStroke.length === 0) return [path];

	// Convert the filled path to a polygon, tracking cornerRadius vertices
	const { polygon: pathPolygon, cornerVertices } =
		filledPathToPolygonWithCorners(path);
	if (pathPolygon.length === 0) return [path];

	// Convert eraser stroke to a polygon outline
	const eraserPolygon = eraserStrokeToPolygon(eraserStroke, eraserRadius);
	if (eraserPolygon.length === 0) return [path];

	// Self-union resolves self-intersecting paths into valid non-overlapping
	// rings so that the subsequent difference produces correct results.
	const resolvedPath = polygonClipping.union(pathPolygon);

	// Perform boolean difference: path - eraser
	const result = polygonClipping.difference(resolvedPath, eraserPolygon);

	if (result.length === 0) return [];

	// Convert each resulting polygon to a Path, restoring cornerRadius.
	// All rings of a single polygon are concatenated into one Path with
	// multiple subpaths (isMoved/isClosed per ring) so that even-odd fill
	// rule renders holes correctly without splitting into separate objects.
	// Filter out tiny fragments caused by floating-point precision issues.
	const MIN_FRAGMENT_AREA = eraserRadius * eraserRadius * 0.01;

	const resultPaths: Path[] = [];
	for (const polygon of result) {
		const allSegments: CubicBezierSegment[] = [];

		for (const ring of polygon) {
			if (ring.length < 3) continue;
			if (Math.abs(ringArea(ring)) < MIN_FRAGMENT_AREA) continue;

			const simplified = simplifyRing(ring);
			const segments = ringToSegments(simplified, eraserRadius * 0.1);
			if (segments.length > 0) {
				restoreCornerRadius(segments, cornerVertices);
				allSegments.push(...segments);
			}
		}

		if (allSegments.length > 0) {
			resultPaths.push(createPathFromSegments(path, allSegments));
		}
	}

	return resultPaths;
}

interface CornerRadiusVertex {
	x: number;
	y: number;
	cornerRadius: number;
	cornerSuperellipseN?: number;
}

/**
 * Convert a filled path's bezier segments to a closed polygon for boolean operations.
 * Also builds a map from exact vertex coordinates to cornerRadius metadata.
 *
 * Segment end-points are emitted using their original coordinates (not evalBezier)
 * so that polygon-clipping preserves them exactly on non-intersecting edges.
 */
function filledPathToPolygonWithCorners(path: Path): {
	polygon: MultiPolygon;
	cornerVertices: CornerRadiusVertex[];
} {
	const cornerVertices: CornerRadiusVertex[] = [];
	const points = sampleBezierSegments(path.segments);
	if (points.length < 3) return { polygon: [], cornerVertices };

	// Collect cornerRadius vertices from original segments
	for (const segment of path.segments) {
		const cr = (segment as CubicBezierSegment & { cornerRadius?: number })
			.cornerRadius;
		if (cr != null && cr > 0) {
			cornerVertices.push({
				x: segment.end.x,
				y: segment.end.y,
				cornerRadius: cr,
				cornerSuperellipseN: (
					segment as CubicBezierSegment & {
						cornerSuperellipseN?: number;
					}
				).cornerSuperellipseN,
			});
		}
	}

	const ring: Ring = points.map((p) => [p.x, p.y]);

	// Ensure closed
	const first = ring[0];
	const last = ring[ring.length - 1];
	if (first[0] !== last[0] || first[1] !== last[1]) {
		ring.push([...first]);
	}

	return { polygon: [[ring]], cornerVertices };
}

/** Signed area of a polygon ring (shoelace formula). */
function ringArea(ring: Ring): number {
	let area = 0;
	for (let i = 0; i < ring.length - 1; i++) {
		area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
	}
	return area / 2;
}

/**
 * Sample bezier segments into discrete points.
 */
function sampleBezierSegments(segments: CubicBezierSegment[]): Point[] {
	const points: Point[] = [];

	for (let segIdx = 0; segIdx < segments.length; segIdx++) {
		const segment = segments[segIdx];
		const prevEnd = segIdx > 0 ? segments[segIdx - 1].end : undefined;
		const resolved = resolveSegment(segment, prevEnd);
		if (!resolved.start) continue;

		for (let i = 0; i <= SAMPLES_PER_SEGMENT; i++) {
			const t = i / SAMPLES_PER_SEGMENT;
			const point = evalBezier(
				resolved.start,
				resolved.cp1,
				resolved.cp2,
				resolved.end,
				t,
			);

			// Skip near-duplicate points
			if (points.length > 0) {
				const prev = points[points.length - 1];
				if (
					Math.abs(prev.x - point.x) < 0.001 &&
					Math.abs(prev.y - point.y) < 0.001
				) {
					continue;
				}
			}
			points.push(point);
		}
	}

	return points;
}

/**
 * Remove nearly-collinear intermediate vertices from a polygon ring.
 *
 * sampleBezierSegments emits many points along each bezier segment.
 * After polygon boolean operations, these dense intermediate points inflate
 * the segment count. CornerRadiusProcessor clamps the fillet radius to
 * half the adjacent segment chord length, so short segments effectively
 * suppress corner rounding. This function merges consecutive collinear
 * points back into longer edges, preserving direction-change vertices
 * (original corners and eraser intersection points).
 */
function simplifyRing(ring: Ring): Ring {
	// Need at least a triangle + closing duplicate
	if (ring.length < 4) return ring;

	const COLLINEAR_THRESHOLD = 0.05; // sin(angle) threshold (~2.87°)

	const simplified: Coord[] = [ring[0]];

	for (let i = 1; i < ring.length - 1; i++) {
		const prev = simplified[simplified.length - 1];
		const curr = ring[i];
		const next = ring[i + 1];

		const dx1 = curr[0] - prev[0];
		const dy1 = curr[1] - prev[1];
		const dx2 = next[0] - curr[0];
		const dy2 = next[1] - curr[1];

		const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
		const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

		if (len1 < 1e-6 || len2 < 1e-6) {
			// Degenerate edge — skip this point
			continue;
		}

		// |cross| / (len1*len2) = |sin(angle)| between the two edges
		const sinAngle = Math.abs(dx1 * dy2 - dy1 * dx2) / (len1 * len2);
		if (sinAngle > COLLINEAR_THRESHOLD) {
			// Significant direction change — keep vertex
			simplified.push(curr);
		}
		// Otherwise skip (nearly collinear)
	}

	// Closing vertex
	simplified.push(ring[ring.length - 1]);

	return simplified;
}

/**
 * Convert a polygon ring (from polygon-clipping) back to bezier segments.
 *
 * Uses Raph Levien's Bézier path simplification: detects corners via
 * tangent cross-product, splits the ring at sharp vertices, and fits
 * optimal cubic Béziers to each smooth sub-polyline.
 */
function ringToSegments(ring: Ring, tolerance = 0.5): CubicBezierSegment[] {
	const n = ring.length - 1; // last point === first point (closed ring)
	if (n < 2) return [];

	// -- Corner detection (Levien-style tangent cross/dot product) --
	// A vertex is a corner if |sin(angle)| > CORNER_RATIO * |cos(angle)|
	// i.e. |tan(angle)| > CORNER_RATIO, approximately angle > atan(CORNER_RATIO).
	const CORNER_RATIO = 0.5; // ~26.5° threshold
	const corners: number[] = [];

	for (let i = 0; i < n; i++) {
		const prev = ring[(i - 1 + n) % n];
		const curr = ring[i];
		const next = ring[(i + 1) % n];

		const dx1 = curr[0] - prev[0];
		const dy1 = curr[1] - prev[1];
		const dx2 = next[0] - curr[0];
		const dy2 = next[1] - curr[1];

		const cross = Math.abs(dx1 * dy2 - dy1 * dx2);
		const dot = dx1 * dx2 + dy1 * dy2;

		if (cross > Math.abs(dot) * CORNER_RATIO) {
			corners.push(i);
		}
	}

	// -- Split ring at corners into smooth sub-polylines --
	type Vec2 = { x: number; y: number };
	const toVec = (c: Coord): Vec2 => ({ x: c[0], y: c[1] });

	const subPolylines: Vec2[][] = [];

	if (corners.length === 0) {
		// No corners: whole ring is smooth. Treat as open path from ring[0] around to ring[0].
		const pts: Vec2[] = [];
		for (let i = 0; i <= n; i++) pts.push(toVec(ring[i % n]));
		subPolylines.push(pts);
	} else {
		for (let ci = 0; ci < corners.length; ci++) {
			const startIdx = corners[ci];
			const endIdx = corners[(ci + 1) % corners.length];
			const pts: Vec2[] = [];

			let idx = startIdx;
			let first = true;
			for (;;) {
				pts.push(toVec(ring[idx % n]));
				// Skip break check on first iteration so that when
				// startIdx === endIdx (single corner), we traverse the full ring.
				if (!first && idx % n === endIdx % n) break;
				first = false;
				idx++;
			}
			subPolylines.push(pts);
		}
	}

	// -- Fit cubic Béziers to each smooth sub-polyline --
	const allFitted: FittedCubic[] = [];
	for (const sub of subPolylines) {
		if (sub.length < 2) continue;
		allFitted.push(...fitCubicBeziers(sub, tolerance));
	}

	// -- Convert FittedCubic[] to CubicBezierSegment[] --
	const segments: CubicBezierSegment[] = [];
	for (let i = 0; i < allFitted.length; i++) {
		const f = allFitted[i];
		// cp1 is relative to p0, cp2 is relative to p3
		segments.push({
			start: i === 0 ? { x: f.p0.x, y: f.p0.y } : undefined,
			cp1: { x: f.p1.x - f.p0.x, y: f.p1.y - f.p0.y },
			cp2: { x: f.p2.x - f.p3.x, y: f.p2.y - f.p3.y },
			end: { x: f.p3.x, y: f.p3.y },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: i === 0,
			isClosed: i === allFitted.length - 1 ? true : undefined,
		});
	}

	return segments;
}

const CORNER_MATCH_TOLERANCE_SQ = 4; // 2px tolerance

/** Restore cornerRadius on result segments whose end is near an original corner vertex. */
function restoreCornerRadius(
	segments: CubicBezierSegment[],
	cornerVertices: CornerRadiusVertex[],
): void {
	if (cornerVertices.length === 0) return;
	for (const seg of segments) {
		const ex = seg.end.x;
		const ey = seg.end.y;
		for (const cv of cornerVertices) {
			const dx = ex - cv.x;
			const dy = ey - cv.y;
			if (dx * dx + dy * dy <= CORNER_MATCH_TOLERANCE_SQ) {
				(seg as CubicBezierSegment & { cornerRadius?: number }).cornerRadius =
					cv.cornerRadius;
				(
					seg as CubicBezierSegment & { cornerSuperellipseN?: number }
				).cornerSuperellipseN = cv.cornerSuperellipseN;
				break;
			}
		}
	}
}

/**
 * Convert an eraser stroke (center line + radius) into a polygon outline.
 */
function eraserStrokeToPolygon(stroke: Point[], radius: number): MultiPolygon {
	if (stroke.length === 1) {
		// Single point: create a circle approximation
		return [[createCircleRing(stroke[0], radius)]];
	}

	const leftSide: Coord[] = [];
	const rightSide: Coord[] = [];

	for (let i = 0; i < stroke.length; i++) {
		const curr = stroke[i];
		const prev = stroke[i - 1] ?? curr;
		const next = stroke[i + 1] ?? curr;

		// Average tangent direction
		let dx = next.x - prev.x;
		let dy = next.y - prev.y;
		const len = Math.sqrt(dx * dx + dy * dy);

		if (len < 0.0001) {
			dx = 1;
			dy = 0;
		} else {
			dx /= len;
			dy /= len;
		}

		// Perpendicular normal
		const nx = -dy;
		const ny = dx;

		leftSide.push([curr.x + nx * radius, curr.y + ny * radius]);
		rightSide.push([curr.x - nx * radius, curr.y - ny * radius]);
	}

	// Add rounded end caps.
	// Caps are generated in the opposite traversal order, so reverse them
	// to keep the ring non-self-intersecting.
	const firstPoint = stroke[0];
	const lastPoint = stroke[stroke.length - 1];
	const startCap = createSemiCircleCoords(
		firstPoint,
		radius,
		leftSide[0],
		rightSide[0],
	);
	const endCap = createSemiCircleCoords(
		lastPoint,
		radius,
		rightSide.at(-1)!,
		leftSide.at(-1)!,
	);

	const ring: Ring = [
		...leftSide,
		...endCap.toReversed(),
		...rightSide.toReversed(),
		...startCap.toReversed(),
	];
	ring.push([...ring[0]]); // Close the ring

	return [[ring]];
}

/**
 * Create a semicircle arc between two points around a center.
 */
function createSemiCircleCoords(
	center: Point,
	radius: number,
	from: Coord,
	to: Coord,
): Coord[] {
	const startAngle = Math.atan2(from[1] - center.y, from[0] - center.x);
	const endAngle = Math.atan2(to[1] - center.y, to[0] - center.x);

	let angleDiff = endAngle - startAngle;
	if (angleDiff < 0) angleDiff += Math.PI * 2;
	if (angleDiff > Math.PI * 2) angleDiff -= Math.PI * 2;

	const steps = Math.max(4, Math.ceil(angleDiff / (Math.PI / 8)));
	const coords: Coord[] = [];

	for (let i = 1; i < steps; i++) {
		const angle = startAngle + (angleDiff * i) / steps;
		coords.push([
			center.x + Math.cos(angle) * radius,
			center.y + Math.sin(angle) * radius,
		]);
	}

	return coords;
}

/**
 * Create a circle ring approximation for a single-point eraser.
 */
function createCircleRing(center: Point, radius: number): Ring {
	const steps = 16;
	const ring: Ring = [];
	for (let i = 0; i <= steps; i++) {
		const angle = (Math.PI * 2 * i) / steps;
		ring.push([
			center.x + Math.cos(angle) * radius,
			center.y + Math.sin(angle) * radius,
		]);
	}
	return ring;
}

/**
 * Split a path at a specific anchor point (vertex)
 * Returns two new paths, or null if the anchor point is at the start/end or path has only one segment.
 *
 * @param path - The path to split
 * @param segmentIndex - The segment index where the anchor is
 * @param pointType - "start" or "end" of the segment (anchors are at segment boundaries)
 * @returns Two new paths, or null if split is not possible
 */
export function splitPathAtAnchor(
	path: Path,
	segmentIndex: number,
	pointType: "start" | "end",
): [Path, Path] | null {
	const segments = path.segments;

	// Determine the split point (which segment boundary)
	let splitIndex: number;
	if (pointType === "start") {
		// "start" of segment i = boundary before segment i
		splitIndex = segmentIndex;
	} else {
		// "end" of segment i = boundary after segment i = start of segment i+1
		splitIndex = segmentIndex + 1;
	}

	// Can't split at the very beginning or very end
	if (splitIndex <= 0 || splitIndex >= segments.length) {
		return null;
	}

	// Split into two parts
	const firstSegments = segments.slice(0, splitIndex);
	const secondSegments = segments.slice(splitIndex);

	if (firstSegments.length === 0 || secondSegments.length === 0) {
		return null;
	}

	// Compute per-segment lengths to determine pathStart/pathEnd
	let totalLength = 0;
	let firstPathLength = 0;
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const prevEnd = i > 0 ? segments[i - 1].end : undefined;
		const {
			start: s0,
			cp1: s1,
			cp2: s2,
			end: s3,
		} = resolveSegment(seg, prevEnd);

		let len = 0;
		let px = s0.x;
		let py = s0.y;
		for (let k = 1; k <= 10; k++) {
			const t = k * 0.1;
			const pt = evalBezier(s0, s1, s2, s3, t);
			const dx = pt.x - px;
			const dy = pt.y - py;
			len += Math.sqrt(dx * dx + dy * dy);
			px = pt.x;
			py = pt.y;
		}
		totalLength += len;
		if (i < splitIndex) {
			firstPathLength += len;
		}
	}

	const splitRatio =
		totalLength > 0
			? firstPathLength / totalLength
			: splitIndex / segments.length;

	// For the second path, we need to add a start point to the first segment
	// The start point is the end of the last segment of the first path
	const lastSegmentOfFirst = firstSegments[firstSegments.length - 1];
	const firstSegmentOfSecond = secondSegments[0];

	const updatedSecondSegments: CubicBezierSegment[] = [
		{
			start: { x: lastSegmentOfFirst.end.x, y: lastSegmentOfFirst.end.y },
			cp1: firstSegmentOfSecond.cp1,
			cp2: firstSegmentOfSecond.cp2,
			end: firstSegmentOfSecond.end,
			isMoved: true,
			isClosed: firstSegmentOfSecond.isClosed,
			startPressure: firstSegmentOfSecond.startPressure,
			endPressure: firstSegmentOfSecond.endPressure,
			startTiltX: firstSegmentOfSecond.startTiltX,
			startTiltY: firstSegmentOfSecond.startTiltY,
			endTiltX: firstSegmentOfSecond.endTiltX,
			endTiltY: firstSegmentOfSecond.endTiltY,
			startDeltaTime: firstSegmentOfSecond.startDeltaTime,
			endDeltaTime: firstSegmentOfSecond.endDeltaTime,
			cornerRadius: firstSegmentOfSecond.cornerRadius,
			cornerSuperellipseN: firstSegmentOfSecond.cornerSuperellipseN,
		},
		...secondSegments.slice(1),
	];

	const firstPath = createPathFromSegments(path, firstSegments, 0, splitRatio);
	const secondPath = createPathFromSegments(
		path,
		updatedSecondSegments,
		splitRatio,
		1,
	);

	return [firstPath, secondPath];
}

function normalizePathRanges(
	ranges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
	const sorted = ranges
		.map(({ start, end }) => ({
			start: Math.max(0, Math.min(1, start)),
			end: Math.max(0, Math.min(1, end)),
		}))
		.filter(({ start, end }) => end > start)
		.toSorted((a, b) => a.start - b.start);
	const merged: Array<{ start: number; end: number }> = [];

	for (const range of sorted) {
		const previous = merged.at(-1);
		if (previous && range.start <= previous.end) {
			previous.end = Math.max(previous.end, range.end);
		} else {
			merged.push(range);
		}
	}

	return merged;
}

function invertPathRanges(
	ranges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
	const result: Array<{ start: number; end: number }> = [];
	let cursor = 0;

	for (const range of ranges) {
		if (range.start > cursor) result.push({ start: cursor, end: range.start });
		cursor = Math.max(cursor, range.end);
	}

	if (cursor < 1) result.push({ start: cursor, end: 1 });
	return result;
}

function findBezierTAtArcLength(
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	targetLength: number,
	totalLength: number,
): number {
	if (targetLength <= 0) return 0;
	if (targetLength >= totalLength) return 1;

	let low = 0;
	let high = 1;
	for (let i = 0; i < 24; i++) {
		const middle = (low + high) / 2;
		const length = approximateBezierArcLength(p0, p1, p2, p3, 0, middle);
		if (length < targetLength) {
			low = middle;
		} else {
			high = middle;
		}
	}

	return (low + high) / 2;
}

function createSegmentRange(
	segment: PathSegment,
	bezier: {
		start: BezierPoint;
		cp1: BezierPoint;
		cp2: BezierPoint;
		end: BezierPoint;
	},
	startT: number,
	endT: number,
	startsSubpath: boolean,
	preservesClosedSubpath: boolean,
): PathSegment {
	let range = {
		p0: bezier.start,
		p1: bezier.cp1,
		p2: bezier.cp2,
		p3: bezier.end,
	};

	if (startT > 0) {
		const [, right] = splitBezierAtT(
			range.p0,
			range.p1,
			range.p2,
			range.p3,
			startT,
		);
		range = right;
	}
	if (endT < 1) {
		const adjustedT = (endT - startT) / (1 - startT);
		const [left] = splitBezierAtT(
			range.p0,
			range.p1,
			range.p2,
			range.p3,
			adjustedT,
		);
		range = left;
	}

	return {
		start: startsSubpath ? range.p0 : undefined,
		cp1: toRelativeCP1(range.p1, range.p0),
		cp2: toRelativeCP2(range.p2, range.p3),
		end: range.p3,
		isMoved: startsSubpath,
		isClosed: preservesClosedSubpath || undefined,
		startPressure: interpolateSegmentValue(
			segment.startPressure,
			segment.endPressure,
			startT,
		),
		endPressure: interpolateSegmentValue(
			segment.startPressure,
			segment.endPressure,
			endT,
		),
		startTiltX: interpolateSegmentValue(
			segment.startTiltX,
			segment.endTiltX,
			startT,
		),
		startTiltY: interpolateSegmentValue(
			segment.startTiltY,
			segment.endTiltY,
			startT,
		),
		endTiltX: interpolateSegmentValue(
			segment.startTiltX,
			segment.endTiltX,
			endT,
		),
		endTiltY: interpolateSegmentValue(
			segment.startTiltY,
			segment.endTiltY,
			endT,
		),
		startDeltaTime: interpolateSegmentValue(
			segment.startDeltaTime,
			segment.endDeltaTime,
			startT,
		),
		endDeltaTime: interpolateSegmentValue(
			segment.startDeltaTime,
			segment.endDeltaTime,
			endT,
		),
		cornerRadius: endT >= 1 - Number.EPSILON ? segment.cornerRadius : undefined,
		cornerSuperellipseN:
			endT >= 1 - Number.EPSILON ? segment.cornerSuperellipseN : undefined,
	};
}

function interpolateSegmentValue(start: number, end: number, t: number): number;
function interpolateSegmentValue(
	start: number | undefined,
	end: number | undefined,
	t: number,
): number | undefined;
function interpolateSegmentValue(
	start: number | undefined,
	end: number | undefined,
	t: number,
): number | undefined {
	if (start == null || end == null) return start ?? end;
	return start + (end - start) * t;
}

/**
 * Create a new path from segments, preserving original path properties.
 * pathStart/pathEnd indicate where this fragment sits within the original full stroke (0–1).
 * Defaults (0 and 1) are stored as undefined to keep the schema lean.
 */
/**
 * Build path elements for several segment runs extracted from one source path,
 * preserving its style. pathStart/pathEnd trim ranges are distributed by
 * segment count (an approximation of arc length, adequate for run splitting).
 */
export function createPathsFromSegmentLists(
	originalPath: Path,
	segmentLists: CubicBezierSegment[][],
): Path[] {
	const totalSegments = segmentLists.reduce(
		(sum, list) => sum + list.length,
		0,
	);
	let consumed = 0;
	return segmentLists.map((segments) => {
		const start = totalSegments > 0 ? consumed / totalSegments : 0;
		consumed += segments.length;
		const end = totalSegments > 0 ? consumed / totalSegments : 1;
		return createPathFromSegments(originalPath, segments, start, end);
	});
}

function createPathFromSegments(
	originalPath: Path,
	segments: CubicBezierSegment[],
	pathStart: number = 0,
	pathEnd: number = 1,
): Path {
	const originalPathStart = originalPath.pathStart ?? 0;
	const originalPathSpan = (originalPath.pathEnd ?? 1) - originalPathStart;
	const composedPathStart = originalPathStart + pathStart * originalPathSpan;
	const composedPathEnd = originalPathStart + pathEnd * originalPathSpan;

	return {
		type: "path",
		id: generateUid("obj"),
		name: originalPath.name,
		opacity: originalPath.opacity,
		blendMode: originalPath.blendMode,
		compositionMode: originalPath.compositionMode,
		visible: originalPath.visible,
		locked: originalPath.locked,
		isGuide: originalPath.isGuide,
		segments,
		filters: originalPath.filters,
		transform: { ...originalPath.transform },
		pathStart: composedPathStart > 0 ? composedPathStart : undefined,
		pathEnd: composedPathEnd < 1 ? composedPathEnd : undefined,
	};
}

function approximateBezierArcLength(
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	startT: number,
	endT: number,
): number {
	if (endT <= startT) return 0;

	const samples = 20;
	let length = 0;
	let previous = evalBezier(p0, p1, p2, p3, startT);

	for (let i = 1; i <= samples; i++) {
		const t = startT + ((endT - startT) * i) / samples;
		const current = evalBezier(p0, p1, p2, p3, t);
		length += Math.hypot(current.x - previous.x, current.y - previous.y);
		previous = current;
	}

	return length;
}

// ============================================================================
// Path Reversal & Merging
// ============================================================================

/**
 * Reverse the direction of a cubic bezier path.
 * Control points are resolved to absolute coordinates, swapped (cp2→cp1, cp1→cp2),
 * then converted back to relative offsets for the reversed parameterization.
 * Pressure, tilt, and deltaTime fields are swapped to match the new direction.
 */
export function reverseSegments(
	segments: CubicBezierSegment[],
): CubicBezierSegment[] {
	if (segments.length === 0) return [];

	const lastIdx = segments.length - 1;
	const isClosed = segments[lastIdx].isClosed;
	const result: CubicBezierSegment[] = [];

	for (let ri = 0; ri < segments.length; ri++) {
		// Original index (iterating in reverse)
		const oi = lastIdx - ri;
		const oldSeg = segments[oi];
		const prevEnd = oi > 0 ? segments[oi - 1].end : undefined;
		const oldStart = getStartAnchor(oldSeg, prevEnd);

		// New start = old end, new end = old start
		const newStart = oldSeg.end;
		const newEnd = oldStart;

		// Resolve old control points to absolute, then swap and convert back to relative:
		// Old cp2 (near old end = new start) → new cp1
		// Old cp1 (near old start = new end) → new cp2
		const absOldCP2 = resolveCP2(oldSeg.cp2, oldSeg.end);
		const absOldCP1 = resolveCP1(oldSeg.cp1, oldStart);

		const newCP1 = toRelativeCP1(absOldCP2, newStart);
		const newCP2 = toRelativeCP2(absOldCP1, newEnd);

		// Spread preserves PathSegment-specific fields (cornerRadius, cornerSuperellipseN)
		result.push({
			...oldSeg,
			start: ri === 0 ? { ...newStart } : undefined,
			cp1: newCP1,
			cp2: newCP2,
			end: { ...newEnd },
			startPressure: oldSeg.endPressure,
			endPressure: oldSeg.startPressure,
			startTiltX: oldSeg.endTiltX,
			startTiltY: oldSeg.endTiltY,
			endTiltX: oldSeg.startTiltX,
			endTiltY: oldSeg.startTiltY,
			startDeltaTime: oldSeg.endDeltaTime,
			endDeltaTime: oldSeg.startDeltaTime,
			isMoved: ri === 0,
			isClosed: ri === lastIdx ? isClosed : undefined,
		});
	}

	return result;
}

/**
 * Compute chord-length approximation of each segment using 10-step evaluation.
 * Same approximation as splitPathAtAnchor.
 */
function computeSegmentLengths(segments: CubicBezierSegment[]): number[] {
	const lengths: number[] = [];
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const prevEnd = i > 0 ? segments[i - 1].end : undefined;
		const {
			start: s0,
			cp1: s1,
			cp2: s2,
			end: s3,
		} = resolveSegment(seg, prevEnd);

		let len = 0;
		let px = s0.x;
		let py = s0.y;
		for (let k = 1; k <= 10; k++) {
			const t = k * 0.1;
			const pt = evalBezier(s0, s1, s2, s3, t);
			const dx = pt.x - px;
			const dy = pt.y - py;
			len += Math.sqrt(dx * dx + dy * dy);
			px = pt.x;
			py = pt.y;
		}
		lengths.push(len);
	}
	return lengths;
}

/**
 * Merge two paths at their specified endpoints into a single continuous path.
 * By default the result inherits ArtObject properties from whichever path
 * provides the first segment run (determined by connection direction).
 * Pass `propertyDonor` to override this — e.g. to use the frontmost path's
 * properties regardless of connection direction.
 * StrokeWidths are remapped proportionally by segment chord-length.
 */
export function mergePathsAtEndpoints(
	pathA: Path,
	endpointA: "start" | "end",
	pathB: Path,
	endpointB: "start" | "end",
	propertyDonor?: Path,
): Path {
	let segsFirst: CubicBezierSegment[];
	let segsSecond: CubicBezierSegment[];
	let firstPath: Path;
	let swFirstReversed = false;
	let swSecondReversed = false;
	let firstStrokeWidths: StrokeWidthPoint[] | undefined;
	let secondStrokeWidths: StrokeWidthPoint[] | undefined;

	if (endpointA === "end" && endpointB === "start") {
		segsFirst = pathA.segments;
		segsSecond = pathB.segments;
		firstPath = pathA;
		firstStrokeWidths = pathA.strokeWidths;
		secondStrokeWidths = pathB.strokeWidths;
	} else if (endpointA === "start" && endpointB === "end") {
		segsFirst = pathB.segments;
		segsSecond = pathA.segments;
		firstPath = pathB;
		firstStrokeWidths = pathB.strokeWidths;
		secondStrokeWidths = pathA.strokeWidths;
	} else if (endpointA === "end" && endpointB === "end") {
		segsFirst = pathA.segments;
		segsSecond = reverseSegments(pathB.segments);
		firstPath = pathA;
		firstStrokeWidths = pathA.strokeWidths;
		secondStrokeWidths = pathB.strokeWidths;
		swSecondReversed = true;
	} else {
		// start-start
		segsFirst = reverseSegments(pathA.segments);
		segsSecond = pathB.segments;
		firstPath = pathA;
		firstStrokeWidths = pathA.strokeWidths;
		secondStrokeWidths = pathB.strokeWidths;
		swFirstReversed = true;
	}

	// Join: set second[0].start to first[last].end, clear isMoved
	const lastOfFirst = segsFirst[segsFirst.length - 1];
	const joinedSecond: CubicBezierSegment[] = [
		{
			...segsSecond[0],
			start: { ...lastOfFirst.end },
			isMoved: false,
		},
		...segsSecond.slice(1),
	];

	const mergedSegments = [...segsFirst, ...joinedSecond];

	// Compute pathStart / pathEnd
	const minPathStart = Math.min(pathA.pathStart ?? 0, pathB.pathStart ?? 0);
	const maxPathEnd = Math.max(pathA.pathEnd ?? 1, pathB.pathEnd ?? 1);

	// Remap strokeWidths proportionally by segment chord-length
	const firstLengths = computeSegmentLengths(segsFirst);
	const secondLengths = computeSegmentLengths(joinedSecond);
	const lenFirst = firstLengths.reduce((a, b) => a + b, 0);
	const lenSecond = secondLengths.reduce((a, b) => a + b, 0);
	const totalLen = lenFirst + lenSecond;
	const ratio = totalLen > 0 ? lenFirst / totalLen : 0.5;

	let mergedStrokeWidths: StrokeWidthPoint[] | undefined;
	if (firstStrokeWidths || secondStrokeWidths) {
		const remapped: StrokeWidthPoint[] = [];

		if (firstStrokeWidths) {
			for (const sw of firstStrokeWidths) {
				const t = swFirstReversed ? 1 - sw.t : sw.t;
				remapped.push({ t: t * ratio, side1: sw.side1, side2: sw.side2 });
			}
		}

		if (secondStrokeWidths) {
			for (const sw of secondStrokeWidths) {
				const t = swSecondReversed ? 1 - sw.t : sw.t;
				remapped.push({
					t: ratio + t * (1 - ratio),
					side1: sw.side1,
					side2: sw.side2,
				});
			}
		}

		remapped.sort((a, b) => a.t - b.t);
		mergedStrokeWidths = remapped;
	}

	const donor = propertyDonor ?? firstPath;

	return {
		type: "path",
		id: generateUid("obj"),
		name: donor.name,
		opacity: donor.opacity,
		blendMode: donor.blendMode,
		compositionMode: donor.compositionMode,
		visible: donor.visible,
		locked: donor.locked,
		isGuide: donor.isGuide,
		segments: mergedSegments,
		filters: donor.filters,
		transform: { ...donor.transform },
		pathStart: minPathStart > 0 ? minPathStart : undefined,
		pathEnd: maxPathEnd < 1 ? maxPathEnd : undefined,
		strokeWidths: mergedStrokeWidths,
	};
}
