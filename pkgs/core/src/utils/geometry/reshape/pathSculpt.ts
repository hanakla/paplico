import type {
	CubicBezierSegment,
	PathSegment,
	Point,
	StrokeWidthPoint,
} from "../../../schema";
import { lerp } from "../../math";
import {
	booleanOp,
	contourToCubicSegments,
	cubicSegmentsToContour,
} from "../generate/booleanOp";
import { type Ring, ringArea, ringPerimeter } from "../generate/pathOps";
import {
	arcLengthRatioAt,
	buildArcLengthTable,
	samplePathAtArcLength,
} from "../measure/arcLength";
import { computeSubPathSignedArea } from "../measure/area";
import { evalCubicBezier, GeometryEpsilon } from "../primitives/bezier";
import { resolveSegment, splitIntoSubPaths } from "../primitives/segment";
import { distanceToSegment } from "../query/hitTest";
import { reverseSubPath, splitSegmentAtIndex } from "./segment";

/** Straight pieces each curve is cut into to find where a stroke crosses a line. */
const CROSSING_SAMPLES_PER_SEGMENT = 24;

/**
 * Share of a mouth, the gap between where a stroke enters an outline and
 * where it leaves it, that rounds each of those two corners.
 */
const MOUTH_CORNER_RADIUS_RATIO = 0.15;

/** Screen pixels within which an anchor counts as on a curve. */
const ON_CURVE_TOLERANCE_PX = 0.5;

/** Closer than this to an end of a segment, a crossing counts as on that end. */
const SEGMENT_END_T = 1e-4;

/**
 * Reshape a path by a freehand stroke, already smoothed into curves. `stroke`
 * is in the space of `segments`, and `zoom` is the screen pixels one unit of
 * that space covers.
 *
 * The region the stroke encloses, by running straight from its last point
 * back to its first, is added to the path or taken away from it, as `op`
 * says; a null `op` leaves the regions as they are. An open sub-path
 * encloses its region the same way, and comes back closed.
 *
 * With `keepOpen`, an open sub-path is a line instead: the stretch of it
 * between the first and the last place the stroke crosses it follows the
 * stroke, and the rest stays as it is.
 *
 * The result keeps the direction of the path, and takes the pressure and
 * tilt of the nearest point of the path. The corners where the stroke meets
 * the path are rounded in proportion to the mouth they open.
 *
 * Returns the reshaped segments, an empty array when nothing of the path is
 * left, or null when the stroke leaves the path as it is.
 */
export function sculptPath(
	segments: CubicBezierSegment[],
	stroke: CubicBezierSegment[],
	op: "add" | "subtract" | null,
	zoom: number,
	keepOpen: boolean,
): PathSegment[] | null {
	if (!keepOpen) return op && sculptRegion(segments, stroke, op, zoom);

	const subPaths = splitIntoSubPaths(segments);
	const closed = subPaths.filter(isClosedSubPath).flat();
	const lines = subPaths.filter((subPath) => !isClosedSubPath(subPath));
	const sculpted =
		op && closed.length > 0 ? sculptRegion(closed, stroke, op, zoom) : null;
	const redrawn = lines.map((line) => redrawLine(line, stroke));
	if (sculpted === null && redrawn.every((line) => line === null)) return null;

	const redrawnLines = new Map(
		lines.map((line, index) => [line, redrawn[index]]),
	);
	const withLines = (subPath: CubicBezierSegment[]) =>
		redrawnLines.get(subPath) ?? subPath;
	// Sub-paths keep their order unless the closed ones were rebuilt together.
	return sculpted === null
		? subPaths.flatMap(withLines)
		: [...sculpted, ...lines.flatMap(withLines)];
}

/**
 * A per-side profile of the path `from`, such as its stroke widths, placed
 * along the reshaped path `to`: each point moves to the place on `to` nearest
 * to where it sat on `from`, so the parts of the path that kept their shape
 * keep their profile.
 */
export function carryProfile(
	profile: StrokeWidthPoint[],
	from: CubicBezierSegment[],
	to: CubicBezierSegment[],
): StrokeWidthPoint[] {
	const lengths = buildArcLengthTable(from);
	const total = lengths.at(-1)?.cumulativeLength ?? 0;
	return profile
		.map((point) => {
			// The ends stay on the ends, which on a closed path share one place.
			if (point.t <= 0 || point.t >= 1) return point;
			const place = samplePathAtArcLength(
				from,
				lengths,
				point.t * total,
				total,
			);
			if (!place) return point;
			const { index, t } = nearestPlace(to, place);
			return { ...point, t: arcLengthRatioAt(to, index, t) };
		})
		.sort((a, b) => a.t - b.t);
}

function isClosedSubPath(subPath: CubicBezierSegment[]): boolean {
	return subPath.at(-1)?.isClosed === true;
}

/** Add the region the stroke encloses to the region of `segments`, or take it away. */
function sculptRegion(
	segments: CubicBezierSegment[],
	stroke: CubicBezierSegment[],
	op: "add" | "subtract",
	zoom: number,
): PathSegment[] | null {
	const samples = sampleCurve(stroke);
	const ring: Ring = [...samples, ...samples.slice(0, 1)].map(({ x, y }) => [
		x,
		y,
	]);
	// A stroke that retraces its closing line encloses a sliver, under two
	// screen pixels wide on average: reshaping by it would leave a hairline
	// bump or slit.
	if (Math.abs(ringArea(ring)) < ringPerimeter(ring) / zoom) return null;

	const geo = new GeometryEpsilon();
	const strokeContour = cubicSegmentsToContour(stroke, geo);
	// The outline as stored, its corner radii left as radii to put back on
	// the corners the stroke leaves alone.
	const pathContours = splitIntoSubPaths(segments)
		.map((subPath) => cubicSegmentsToContour(subPath, geo))
		.filter((contour) => contour.length > 0);
	if (strokeContour.length === 0 || pathContours.length === 0) return null;

	try {
		// The part of the stroke's region that changes the path: what lies
		// outside the path when adding, inside it when subtracting.
		const changed = booleanOp(
			[strokeContour],
			pathContours,
			op === "add" ? "difference" : "intersect",
		);
		if (changed.length === 0) return null;

		const result = booleanOp(
			pathContours,
			[strokeContour],
			op === "add" ? "union" : "difference",
		).map(contourToCubicSegments);

		const isTurned =
			signedArea(splitIntoSubPaths(segments)) * signedArea(result) < 0;
		const tolerance = ON_CURVE_TOLERANCE_PX / zoom;
		return result.flatMap((subPath) =>
			withSharpSeam(
				roundMouths(
					keepCornerRadii(
						carryPointAttributes(
							isTurned ? asSubPath(reverseSubPath(subPath)) : subPath,
							segments,
						),
						segments,
						tolerance,
					),
					segments,
					stroke,
					tolerance,
				),
			),
		);
	} catch {
		return null;
	}
}

/** Signed area of sub-paths, each closed by the line joining its ends. */
function signedArea(subPaths: CubicBezierSegment[][]): number {
	return subPaths.reduce((sum, subPath) => {
		const first = subPath[0]?.start;
		const last = subPath.at(-1)?.end;
		// The area of the segments alone leaves the joining line out, which
		// makes its sign depend on where an open sub-path sits.
		const join = first && last ? (last.x * first.y - first.x * last.y) / 2 : 0;
		return sum + computeSubPathSignedArea(subPath) + join;
	}, 0);
}

function asSubPath(segments: CubicBezierSegment[]): CubicBezierSegment[] {
	return segments.map((segment, index) =>
		index === 0 ? { ...segment, isMoved: true } : segment,
	);
}

/**
 * Redraw the stretch of an open sub-path between the first and the last place
 * the stroke crosses it, so that it follows the stroke there. Null when the
 * stroke crosses it less than twice.
 */
function redrawLine(
	line: CubicBezierSegment[],
	stroke: CubicBezierSegment[],
): PathSegment[] | null {
	const crossings = lineCrossings(line, stroke);
	const first = crossings[0];
	const last = crossings.at(-1);
	if (!first || !last || first === last) return null;

	const isForward = first.linePosition <= last.linePosition;
	const from = locateOnLine(line, isForward ? first : last);
	const to = locateOnLine(line, isForward ? last : first);
	if (to.position - from.position < SEGMENT_END_T) return null;

	const along = curveBetween(stroke, first.strokePosition, last.strokePosition);
	const bridge = isForward ? along : reverseSubPath(along);
	if (bridge.length === 0) return null;

	const recordsPressure =
		from.attributes.pressure !== undefined ||
		to.attributes.pressure !== undefined;
	const head = lineUpTo(line, from);
	const tail = lineFrom(line, to);
	const lastBridge = bridge.length - 1;
	const attributesAlong = (index: number): PointAttributes => {
		const ratio = index / bridge.length;
		return {
			pressure: recordsPressure
				? lerpPressure(from.attributes.pressure, to.attributes.pressure, ratio)
				: undefined,
			tiltX: lerp(from.attributes.tiltX, to.attributes.tiltX, ratio),
			tiltY: lerp(from.attributes.tiltY, to.attributes.tiltY, ratio),
		};
	};
	const joined = [
		...head,
		...bridge.map((segment, index) => {
			const atStart = attributesAlong(index);
			const atEnd = attributesAlong(index + 1);
			return {
				...segment,
				// Chained onto the head, the bridge starts where the head ends.
				start:
					head.length === 0 && index === 0
						? { ...from.point, pressure: atStart.pressure }
						: undefined,
				isMoved: false,
				isClosed: undefined,
				end: {
					...(index === lastBridge ? to.point : segment.end),
					pressure: atEnd.pressure,
				},
				startPressure: atStart.pressure,
				endPressure: atEnd.pressure,
				startTiltX: atStart.tiltX,
				startTiltY: atStart.tiltY,
				endTiltX: atEnd.tiltX,
				endTiltY: atEnd.tiltY,
			};
		}),
		...tail,
	];
	// The cut points are the two corners of the mouth; a cut on an end of
	// the line is no corner.
	const radius =
		MOUTH_CORNER_RADIUS_RATIO *
		Math.hypot(to.point.x - from.point.x, to.point.y - from.point.y);
	const corners = [head.length - 1, head.length + lastBridge].filter(
		(index) => index >= 0 && index < joined.length - 1,
	);
	return asSubPath(
		joined.map((segment, index) =>
			corners.includes(index) ? { ...segment, cornerRadius: radius } : segment,
		),
	);
}

/**
 * Round the corners of a closed outline where the stroke meets the path.
 * Walking the outline, each two neighbouring corners are a pair when the
 * stretch between them follows the stroke, and both get a radius in
 * proportion to the gap between them.
 */
function roundMouths(
	subPath: CubicBezierSegment[],
	path: CubicBezierSegment[],
	stroke: CubicBezierSegment[],
	tolerance: number,
): PathSegment[] {
	const isOn = (curve: CubicBezierSegment[], point: Point) =>
		nearestPlace(curve, point).distance <= tolerance;
	// Vertex i joins segment i to the next one around the outline.
	const corners = subPath.flatMap((segment, index) =>
		isOn(path, segment.end) && isOn(stroke, segment.end) ? [index] : [],
	);
	if (corners.length < 2) return subPath;

	const radii = new Map<number, number>();
	corners.forEach((from, k) => {
		const to = corners[(k + 1) % corners.length];
		const next = (from + 1) % subPath.length;
		const { start, cp1, cp2, end } = resolveSegment(
			subPath[next],
			subPath[from].end,
		);
		const middle = evalCubicBezier(start, cp1, cp2, end, 0.5);
		if (!isOn(stroke, middle) || isOn(path, middle)) return;

		const a = subPath[from].end;
		const b = subPath[to].end;
		const radius = MOUTH_CORNER_RADIUS_RATIO * Math.hypot(b.x - a.x, b.y - a.y);
		for (const corner of [from, to]) {
			radii.set(corner, Math.max(radii.get(corner) ?? 0, radius));
		}
	});
	if (radii.size === 0) return subPath;

	return subPath.map((segment, index) => {
		const radius = radii.get(index);
		return radius === undefined
			? segment
			: { ...segment, cornerRadius: radius };
	});
}

/** A closed outline with the corner radii of `path` back on the corners it kept. */
function keepCornerRadii(
	subPath: PathSegment[],
	path: PathSegment[],
	tolerance: number,
): PathSegment[] {
	const corners = path.filter((segment) => (segment.cornerRadius ?? 0) > 0);
	if (corners.length === 0) return subPath;
	return subPath.map((segment) => {
		const corner = corners.find(
			({ end }) =>
				Math.hypot(end.x - segment.end.x, end.y - segment.end.y) <= tolerance,
		);
		return corner
			? {
					...segment,
					cornerRadius: corner.cornerRadius,
					cornerSuperellipseN: corner.cornerSuperellipseN,
				}
			: segment;
	});
}

/**
 * A closed outline started at a vertex without a corner radius. The vertex
 * where an outline closes is rounded only when it ends the last sub-path of
 * the whole path, so it must stay sharp; with no sharp vertex to start at,
 * that one radius is dropped.
 */
function withSharpSeam(subPath: PathSegment[]): PathSegment[] {
	const isRounded = (segment: PathSegment) => (segment.cornerRadius ?? 0) > 0;
	if (!isRounded(subPath[subPath.length - 1])) return subPath;
	const sharp = subPath.findIndex((segment) => !isRounded(segment));
	if (sharp !== -1) return startAfter(subPath, sharp);
	return subPath.map((segment, index) =>
		index === subPath.length - 1
			? { ...segment, cornerRadius: undefined, cornerSuperellipseN: undefined }
			: segment,
	);
}

/** A closed outline started right after vertex `index`, the same shape. */
function startAfter(subPath: PathSegment[], index: number): PathSegment[] {
	const order = [...subPath.slice(index + 1), ...subPath.slice(0, index + 1)];
	return order.map((segment, k) => ({
		...segment,
		start: k === 0 ? { ...subPath[index].end } : undefined,
		isMoved: k === 0,
		isClosed: k === order.length - 1 ? true : undefined,
	}));
}

/**
 * The part of a curve between two positions on it, each a segment index plus
 * t, with `from` before `to`.
 */
function curveBetween(
	curve: CubicBezierSegment[],
	from: number,
	to: number,
): CubicBezierSegment[] {
	const end = locatePosition(curve, to);
	const head = lineUpTo(curve, end);
	const start = locatePosition(curve, from);
	// Cutting at `to` rescales t on the segment it shares with `from`.
	const t =
		start.segmentIndex === end.segmentIndex && end.t > SEGMENT_END_T
			? start.t / end.t
			: start.t;
	const [first, ...rest] = lineFrom(head, { ...start, t });
	return first ? [{ ...first, start: start.point }, ...rest] : [];
}

/** Pressure and tilt at a point of a path. */
type PointAttributes = {
	/** Undefined where the path records no pressure. */
	pressure: number | undefined;
	tiltX: number;
	tiltY: number;
};

/** A place on an open sub-path: `position` is the segment index plus t. */
type LinePlace = {
	position: number;
	segmentIndex: number;
	t: number;
	point: Point;
	attributes: PointAttributes;
};

type Crossing = { strokePosition: number; linePosition: number };

/** A point of a curve, with its position as a segment index plus t. */
type CurveSample = Point & { position: number };

function sampleCurve(curve: CubicBezierSegment[]): CurveSample[] {
	const samples: CurveSample[] = [];
	curve.forEach((segment, index) => {
		const { start, cp1, cp2, end } = resolveSegment(
			segment,
			index > 0 ? curve[index - 1].end : undefined,
		);
		for (let k = index === 0 ? 0 : 1; k <= CROSSING_SAMPLES_PER_SEGMENT; k++) {
			const t = k / CROSSING_SAMPLES_PER_SEGMENT;
			samples.push({
				...evalCubicBezier(start, cp1, cp2, end, t),
				position: index + t,
			});
		}
	});
	return samples;
}

/** Where the stroke crosses the line, in the order the stroke meets them. */
function lineCrossings(
	line: CubicBezierSegment[],
	stroke: CubicBezierSegment[],
): Crossing[] {
	const samples = sampleCurve(line);
	const strokeSamples = sampleCurve(stroke);

	const crossings: Crossing[] = [];
	for (let i = 0; i < strokeSamples.length - 1; i++) {
		const a = strokeSamples[i];
		const b = strokeSamples[i + 1];
		const strokeX = b.x - a.x;
		const strokeY = b.y - a.y;
		for (let j = 0; j < samples.length - 1; j++) {
			const p = samples[j];
			const q = samples[j + 1];
			const lineX = q.x - p.x;
			const lineY = q.y - p.y;
			const denominator = strokeX * lineY - strokeY * lineX;
			if (Math.abs(denominator) < Number.EPSILON) continue;
			const u = ((p.x - a.x) * lineY - (p.y - a.y) * lineX) / denominator;
			const v = ((p.x - a.x) * strokeY - (p.y - a.y) * strokeX) / denominator;
			if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
			crossings.push({
				strokePosition: lerp(a.position, b.position, u),
				linePosition: lerp(p.position, q.position, v),
			});
		}
	}
	return crossings.sort((a, b) => a.strokePosition - b.strokePosition);
}

function locateOnLine(
	line: CubicBezierSegment[],
	{ linePosition }: Crossing,
): LinePlace {
	return locatePosition(line, linePosition);
}

function locatePosition(
	line: CubicBezierSegment[],
	linePosition: number,
): LinePlace {
	const segmentIndex = Math.min(Math.floor(linePosition), line.length - 1);
	const t = linePosition - segmentIndex;
	const segment = line[segmentIndex];
	const { start, cp1, cp2, end } = resolveSegment(
		segment,
		segmentIndex > 0 ? line[segmentIndex - 1].end : undefined,
	);
	return {
		position: linePosition,
		segmentIndex,
		t,
		point: evalCubicBezier(start, cp1, cp2, end, t),
		attributes: attributesAt(segment, t),
	};
}

/** The line from its start to `place`. */
function lineUpTo(
	line: CubicBezierSegment[],
	{ segmentIndex, t, attributes }: LinePlace,
): CubicBezierSegment[] {
	if (t <= SEGMENT_END_T) return line.slice(0, segmentIndex);
	if (t >= 1 - SEGMENT_END_T) return line.slice(0, segmentIndex + 1);

	const head = splitSegmentAtIndex(line, segmentIndex, t).slice(
		0,
		segmentIndex + 1,
	);
	const cut = head[segmentIndex];
	head[segmentIndex] = {
		...cut,
		end: { ...cut.end, pressure: attributes.pressure },
		// The split leaves the pressures out of the halves it returns.
		startPressure: line[segmentIndex].startPressure,
		endPressure: attributes.pressure,
		endTiltX: attributes.tiltX,
		endTiltY: attributes.tiltY,
	};
	return head;
}

/** The line from `place` to its end, to chain after a segment that ends on `place`. */
function lineFrom(
	line: CubicBezierSegment[],
	{ segmentIndex, t, attributes }: LinePlace,
): CubicBezierSegment[] {
	if (t >= 1 - SEGMENT_END_T) return line.slice(segmentIndex + 1);
	if (t <= SEGMENT_END_T) {
		return line
			.slice(segmentIndex)
			.map((segment, index) =>
				index === 0 ? { ...segment, start: undefined } : segment,
			);
	}

	const tail = splitSegmentAtIndex(line, segmentIndex, t).slice(
		segmentIndex + 1,
	);
	tail[0] = {
		...tail[0],
		startPressure: attributes.pressure,
		endPressure: line[segmentIndex].endPressure,
		startTiltX: attributes.tiltX,
		startTiltY: attributes.tiltY,
	};
	return tail;
}

/** `subPath` with the pressure and tilt of the nearest points of `source` at its anchors. */
function carryPointAttributes(
	subPath: CubicBezierSegment[],
	source: CubicBezierSegment[],
): CubicBezierSegment[] {
	return subPath.map((segment, index) => {
		const { start, end } = resolveSegment(
			segment,
			index > 0 ? subPath[index - 1].end : undefined,
		);
		const atStart = attributesNear(source, start);
		const atEnd = attributesNear(source, end);
		return {
			...segment,
			start: segment.start && { ...segment.start, pressure: atStart.pressure },
			end: { ...segment.end, pressure: atEnd.pressure },
			startPressure: atStart.pressure,
			endPressure: atEnd.pressure,
			startTiltX: atStart.tiltX,
			startTiltY: atStart.tiltY,
			endTiltX: atEnd.tiltX,
			endTiltY: atEnd.tiltY,
		};
	});
}

function attributesNear(
	source: CubicBezierSegment[],
	point: Point,
): PointAttributes {
	const { index, t } = nearestPlace(source, point);
	return attributesAt(source[index], t);
}

/** The segment of `segments` nearest to a point, and the parameter of that point on it. */
function nearestPlace(
	segments: CubicBezierSegment[],
	{ x, y }: Point,
): { distance: number; index: number; t: number } {
	let nearest = { distance: Number.POSITIVE_INFINITY, index: 0, t: 0 };
	segments.forEach((segment, index) => {
		const { distance, t } = distanceToSegment(
			x,
			y,
			segment,
			index > 0 ? segments[index - 1].end : null,
		);
		if (distance < nearest.distance) nearest = { distance, index, t };
	});
	return nearest;
}

function attributesAt(segment: CubicBezierSegment, t: number): PointAttributes {
	return {
		pressure: lerpPressure(segment.startPressure, segment.endPressure, t),
		tiltX: lerp(segment.startTiltX, segment.endTiltX, t),
		tiltY: lerp(segment.startTiltY, segment.endTiltY, t),
	};
}

/** Pressure between two recorded ones; undefined when neither end records any. */
function lerpPressure(
	from: number | undefined,
	to: number | undefined,
	ratio: number,
): number | undefined {
	if (from === undefined && to === undefined) return undefined;
	return lerp(from ?? to ?? 0, to ?? from ?? 0, ratio);
}
