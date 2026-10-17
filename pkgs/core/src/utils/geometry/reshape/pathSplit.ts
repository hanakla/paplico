import polygonClipping from "polygon-clipping";
import {
	type BezierPoint,
	type CubicBezierSegment,
	generateUid,
	type Path,
	type PathSegment,
	type Point,
	type StrokeWidthPoint,
} from "../../../schema";
import {
	type Coord,
	createPathFromSegments,
	type Ring,
	ringArea,
	ringToSegments,
	straightSegment,
} from "../generate/pathOps";
import { approximateBezierArcLength } from "../measure/arcLength";
import { evalCubicBezier, splitBezierAtT } from "../primitives/bezier";
import {
	getStartAnchor,
	resolveCP1,
	resolveCP2,
	resolveSegment,
	toRelativeCP1,
	toRelativeCP2,
} from "../primitives/segment";

type Polygon = Ring[];
type MultiPolygon = Polygon[];

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
			const point = evalCubicBezier(p0, p1, p2, p3, t);
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
 * Segment end-points are emitted using their original coordinates (not evalCubicBezier)
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
			const point = evalCubicBezier(
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
 * the segment count. applyCornerRadius clamps the fillet radius to
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
			const pt = evalCubicBezier(s0, s1, s2, s3, t);
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

// ============================================================================
// Path Reversal & Merging
// ============================================================================

/**
 * Reverse the direction of a cubic bezier path.
 * Control points are resolved to absolute coordinates, swapped (cp2→cp1, cp1→cp2),
 * then converted back to relative offsets for the reversed parameterization.
 * Pressure, tilt, and deltaTime fields are swapped to match the new direction.
 */
function reverseSegments(segments: CubicBezierSegment[]): CubicBezierSegment[] {
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
			const pt = evalCubicBezier(s0, s1, s2, s3, t);
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
 * Close an open path with a straight segment from its end anchor back to its
 * start anchor. Both anchors stay in place.
 * Returns null when the path is already closed.
 */
export function closePathAtEndpoints(
	segments: CubicBezierSegment[],
): CubicBezierSegment[] | null {
	const first = segments[0];
	const last = segments.at(-1);
	if (!first?.start || !last || last.isClosed) return null;

	return [
		...segments,
		{ ...straightSegment(last.end, first.start), isClosed: true },
	];
}

/**
 * Merge two paths at their specified endpoints into a single continuous path.
 * A straight segment bridges the two endpoints, so both anchors stay in place.
 * By default the result inherits ArtObject properties from whichever path
 * provides the first segment run (determined by connection direction).
 * Pass `propertyDonor` to override this — e.g. to use the frontmost path's
 * properties regardless of connection direction.
 * strokeWidths and strokeErasure are remapped proportionally by segment
 * chord-length.
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

	if (endpointA === "end" && endpointB === "start") {
		segsFirst = pathA.segments;
		segsSecond = pathB.segments;
		firstPath = pathA;
	} else if (endpointA === "start" && endpointB === "end") {
		segsFirst = pathB.segments;
		segsSecond = pathA.segments;
		firstPath = pathB;
	} else if (endpointA === "end" && endpointB === "end") {
		segsFirst = pathA.segments;
		segsSecond = reverseSegments(pathB.segments);
		firstPath = pathA;
		swSecondReversed = true;
	} else {
		// start-start
		segsFirst = reverseSegments(pathA.segments);
		segsSecond = pathB.segments;
		firstPath = pathA;
		swFirstReversed = true;
	}

	// Join: bridge the two endpoints with a straight segment
	const lastOfFirst = segsFirst[segsFirst.length - 1];
	const startOfSecond = getStartAnchor(segsSecond[0], lastOfFirst.end);
	const joinedSecond: CubicBezierSegment[] = [
		straightSegment(lastOfFirst.end, startOfSecond),
		{ ...segsSecond[0], start: undefined, isMoved: false },
		...segsSecond.slice(1),
	];

	const mergedSegments = [...segsFirst, ...joinedSecond];

	// Compute pathStart / pathEnd
	const minPathStart = Math.min(pathA.pathStart ?? 0, pathB.pathStart ?? 0);
	const maxPathEnd = Math.max(pathA.pathEnd ?? 1, pathB.pathEnd ?? 1);

	// Remap the per-side profiles proportionally by segment chord-length
	const firstLengths = computeSegmentLengths(segsFirst);
	const secondLengths = computeSegmentLengths(joinedSecond);
	const lenFirst = firstLengths.reduce((a, b) => a + b, 0);
	const lenSecond = secondLengths.reduce((a, b) => a + b, 0);
	const totalLen = lenFirst + lenSecond;
	const ratio = totalLen > 0 ? lenFirst / totalLen : 0.5;

	const secondPath = firstPath === pathA ? pathB : pathA;
	const mergeProfiles = (
		first: StrokeWidthPoint[] | undefined,
		second: StrokeWidthPoint[] | undefined,
	) =>
		mergeSideProfiles(first, second, swFirstReversed, swSecondReversed, ratio);

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
		strokeWidths: mergeProfiles(
			firstPath.strokeWidths,
			secondPath.strokeWidths,
		),
		strokeErasure: mergeProfiles(
			firstPath.strokeErasure,
			secondPath.strokeErasure,
		),
		// The merged profile keeps one interpretation; carry the flag only when
		// both sources agree (a mixed merge falls back to composing ratios).
		strokeWidthsBaked:
			pathA.strokeWidthsBaked === pathB.strokeWidthsBaked
				? pathA.strokeWidthsBaked
				: undefined,
	};
}

/**
 * One per-side profile over a merged path: each source's points squeezed
 * into its share of the length, `ratio` being the first run's share. A
 * reversed source also swaps its sides, since side1 and side2 are the left
 * and right of the travel direction.
 */
function mergeSideProfiles(
	first: StrokeWidthPoint[] | undefined,
	second: StrokeWidthPoint[] | undefined,
	firstReversed: boolean,
	secondReversed: boolean,
	ratio: number,
): StrokeWidthPoint[] | undefined {
	if (!first && !second) return undefined;

	const oriented = (sw: StrokeWidthPoint, reversed: boolean) =>
		reversed
			? { t: 1 - sw.t, side1: sw.side2, side2: sw.side1 }
			: { t: sw.t, side1: sw.side1, side2: sw.side2 };
	const remapped: StrokeWidthPoint[] = [
		...(first ?? []).map((sw) => {
			const point = oriented(sw, firstReversed);
			return { ...point, t: point.t * ratio };
		}),
		...(second ?? []).map((sw) => {
			const point = oriented(sw, secondReversed);
			return { ...point, t: ratio + point.t * (1 - ratio) };
		}),
	];
	return remapped.sort((a, b) => a.t - b.t);
}
