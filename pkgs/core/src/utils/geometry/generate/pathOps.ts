import { sliceStrokeWidths } from "../../../renderer/geometry/strokeTessellator";
import {
	type BezierPoint,
	type CompoundPathSource,
	type CubicBezierSegment,
	generateUid,
	type Path,
	type StrokeWidthPoint,
} from "../../../schema";
import { GeometryEpsilon } from "../primitives/bezier";
import { splitIntoSubPaths } from "../primitives/segment";
import { pointInPolygon } from "../query/hitTest";
import type { Segment } from "../query/segmentIntersection";
import {
	type BooleanOp,
	booleanOp,
	contourToCubicSegments,
	cubicSegmentsToContour,
} from "./booleanOp";
import { applyCornerRadius } from "./cornerRadius";
import { type FittedCubic, fitCubicBeziers } from "./strokeFitting";

// ============================================================================
// Boolean Operations
// ============================================================================

export type Coord = [number, number];
export type Ring = Coord[];

const BOOLEAN_OP_BY_SOURCE_OP: Record<CompoundPathSource["op"], BooleanOp> = {
	union: "union",
	subtract: "difference",
	intersect: "intersect",
	exclude: "xor",
};

/**
 * Compute boolean operations on multiple paths using per-source operations.
 * Each source (except the first) specifies its own boolean operation against
 * the accumulated result. The result keeps the sources' curves.
 * Only the outline of each source takes part, so an open sub-path is closed
 * with a straight line and stroke width plays no role.
 */
export function computeBooleanOperation(
	sources: CompoundPathSource[],
	pathMap: Map<string, Path>,
): CubicBezierSegment[] {
	if (sources.length === 0) return [];

	const firstPath = pathMap.get(sources[0].id);
	if (!firstPath) return [];
	if (sources.length === 1) return firstPath.segments ?? [];

	const geo = new GeometryEpsilon();
	let result = pathToContours(firstPath, geo);
	if (result.length === 0) return [];

	try {
		for (const source of sources.slice(1)) {
			const path = pathMap.get(source.id);
			if (!path) continue;

			const contours = pathToContours(path, geo);
			if (contours.length === 0) continue;

			result = booleanOp(result, contours, BOOLEAN_OP_BY_SOURCE_OP[source.op]);
		}
	} catch {
		return [];
	}

	return result.flatMap(contourToCubicSegments);
}

function pathToContours(path: Path, geo: GeometryEpsilon): Segment[][] {
	return splitIntoSubPaths(applyCornerRadius(path.segments))
		.map((subPath) => cubicSegmentsToContour(subPath, geo))
		.filter((contour) => contour.length > 0);
}

/** A straight segment continuing the current subpath from `from` to `to`. */
export function straightSegment(
	from: BezierPoint,
	to: BezierPoint,
): CubicBezierSegment {
	return {
		start: { ...from },
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: { ...to },
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: false,
	};
}

/** Signed area of a polygon ring (shoelace formula). */
export function ringArea(ring: Ring): number {
	let area = 0;
	for (let i = 0; i < ring.length - 1; i++) {
		area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
	}
	return area / 2;
}

/**
 * Outline the area a triangle soup covers under the nonzero rule ([x, y, ...]
 * with 3 vertices per triangle) as closed cubic Bézier subpaths that stay
 * within `tolerance` of it. Overlapping triangles merge; enclosed gaps become
 * hole subpaths.
 *
 * Triangles that share edges (a stroke body's quads, a cap's fan) are joined
 * by cancelling the shared edges first, so the boolean union only sees the
 * boundary rings left over. Fed the sliver triangles themselves, the sweep
 * line loses segments.
 */
export function triangleSoupOutline(
	triangles: readonly number[],
	tolerance: number,
): CubicBezierSegment[] {
	// Shared edges only cancel when their vertices are exact, so vertices
	// snap to a grid well below the tolerance.
	const grid = tolerance / 100;
	const snap = (v: number) => Math.round(v / grid) * grid;
	const rings = meshBoundaryRings(triangles, snap);
	if (rings.length === 0) return [];

	const geo = new GeometryEpsilon();
	let shapes = groupHoleRings(rings).map((shape) =>
		shape.map((ring) =>
			cubicSegmentsToContour(
				ring
					.slice(1)
					.map((coord, i) =>
						straightSegment(
							{ x: ring[i][0], y: ring[i][1] },
							{ x: coord[0], y: coord[1] },
						),
					),
				geo,
			),
		),
	);
	// Pairwise union as a balanced tree, so each step merges two shapes of
	// similar size instead of one growing result against every next shape.
	while (shapes.length > 1) {
		const merged: Segment[][][] = [];
		for (let i = 0; i < shapes.length; i += 2) {
			merged.push(
				i + 1 < shapes.length
					? booleanOp(shapes[i], shapes[i + 1], "union")
					: shapes[i],
			);
		}
		shapes = merged;
	}
	return shapes[0].flatMap((contour) => {
		const ring: Ring = contour.map((seg) => seg.start());
		ring.push(ring[0]);
		// The union leaves slivers where shapes touched along an edge; a region
		// thinner than the tolerance is invisible either way.
		if ((2 * Math.abs(ringArea(ring))) / ringPerimeter(ring) < tolerance) {
			return [];
		}
		// The fitter measures its error only at the vertices, so a long edge
		// left with its two ends alone lets the fitted curve bulge away from it.
		return ringToSegments(densifyRing(ring, tolerance * 10), tolerance);
	});
}

/**
 * The boundary of a triangle mesh as closed rings. Every triangle is wound
 * counter-clockwise, so an edge two triangles share appears once in each
 * direction and cancels; the directed edges left chain into rings, an outer
 * boundary running counter-clockwise and an enclosed gap clockwise.
 */
function meshBoundaryRings(
	triangles: readonly number[],
	snap: (v: number) => number,
): Ring[] {
	const key = (c: Coord) => `${c[0]},${c[1]}`;
	const edges = new Map<string, { from: Coord; to: Coord }>();
	for (let i = 0; i + 5 < triangles.length; i += 6) {
		const ring: Coord[] = [];
		for (let k = i; k < i + 6; k += 2) {
			ring.push([snap(triangles[k]), snap(triangles[k + 1])]);
		}
		const [a, b, c] = ring;
		const area2 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
		if (area2 === 0) continue;
		const wound = area2 > 0 ? ring : ring.reverse();
		for (let k = 0; k < 3; k++) {
			const from = wound[k];
			const to = wound[(k + 1) % 3];
			if (edges.delete(`${key(to)}|${key(from)}`)) continue;
			edges.set(`${key(from)}|${key(to)}`, { from, to });
		}
	}

	const outgoing = new Map<string, { from: Coord; to: Coord }[]>();
	for (const edge of edges.values()) {
		const k = key(edge.from);
		outgoing.set(k, [...(outgoing.get(k) ?? []), edge]);
	}
	const rings: Ring[] = [];
	const used = new Set<{ from: Coord; to: Coord }>();
	for (const start of edges.values()) {
		if (used.has(start)) continue;
		const ring: Ring = [start.from];
		let edge = start;
		for (;;) {
			used.add(edge);
			ring.push(edge.to);
			const next = outgoing.get(key(edge.to))?.find((e) => !used.has(e));
			if (!next) break;
			edge = next;
		}
		if (ring.length >= 4) rings.push(ring);
	}
	return rings;
}

/**
 * Group boundary rings into shapes for the boolean union: a clockwise ring
 * is the hole of the smallest counter-clockwise ring around it and goes into
 * that ring's shape, so the union keeps the gap instead of filling it as a
 * shape of its own.
 */
function groupHoleRings(rings: Ring[]): Ring[][] {
	const solids: { ring: Ring; area: number; shape: Ring[] }[] = [];
	const holes: Ring[] = [];
	for (const ring of rings) {
		const area = ringArea(ring);
		if (area > 0) solids.push({ ring, area, shape: [ring] });
		else holes.push(ring);
	}
	for (const hole of holes) {
		const [x, y] = hole[0];
		const owner = solids
			.filter((solid) =>
				pointInPolygon(
					x,
					y,
					solid.ring.map(([px, py]) => ({ x: px, y: py })),
				),
			)
			.sort((a, b) => a.area - b.area)[0];
		if (owner) owner.shape.push(hole);
	}
	return solids.map((solid) => solid.shape);
}

function ringPerimeter(ring: Ring): number {
	let length = 0;
	for (let i = 1; i < ring.length; i++) {
		length += Math.hypot(
			ring[i][0] - ring[i - 1][0],
			ring[i][1] - ring[i - 1][1],
		);
	}
	return length;
}

/** Split ring edges so consecutive vertices are at most `maxGap` apart. */
function densifyRing(ring: Ring, maxGap: number): Ring {
	const dense: Ring = [ring[0]];
	for (let i = 1; i < ring.length; i++) {
		const [x0, y0] = ring[i - 1];
		const [x1, y1] = ring[i];
		const pieces = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / maxGap);
		for (let piece = 1; piece < pieces; piece++) {
			const t = piece / pieces;
			dense.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
		}
		dense.push(ring[i]);
	}
	return dense;
}

/**
 * Convert a polygon ring (from polygon-clipping) back to bezier segments.
 *
 * Uses Raph Levien's Bézier path simplification: detects corners via
 * tangent cross-product, splits the ring at sharp vertices, and fits
 * optimal cubic Béziers to each smooth sub-polyline.
 */
export function ringToSegments(
	ring: Ring,
	tolerance = 0.5,
): CubicBezierSegment[] {
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

/**
 * A run of segments taken out of one path, with where it sat on that path:
 * `start` and `end` are ratios of the original's arc length. On a closed path
 * a run that wraps past the start has `end` above 1.
 */
export interface PathRun {
	segments: CubicBezierSegment[];
	start: number;
	end: number;
}

/**
 * Build path elements for several segment runs extracted from one source
 * path, preserving its style and the part of its width and erasure profiles
 * each run covers.
 */
export function createPathsFromRuns(
	originalPath: Path,
	runs: PathRun[],
): Path[] {
	return runs.map(({ segments, start, end }) =>
		createPathFromSegments(originalPath, segments, start, end),
	);
}

/**
 * Create a new path from segments, preserving original path properties.
 * pathStart/pathEnd indicate where this fragment sits within the original
 * path (ratios of its arc length, pathEnd above 1 for a run wrapping past the
 * start of a closed path). The width and erasure profiles are cut to that
 * range. Defaults (0 and 1) are stored as undefined to keep the schema lean.
 */
export function createPathFromSegments(
	originalPath: Path,
	segments: CubicBezierSegment[],
	pathStart: number = 0,
	pathEnd: number = 1,
): Path {
	// A wrapping run covers the original's whole trim range, split at the
	// seam, so it keeps that range instead of composing its own.
	const wraps = pathEnd > 1;
	const originalPathStart = originalPath.pathStart ?? 0;
	const originalPathSpan = (originalPath.pathEnd ?? 1) - originalPathStart;
	const composedPathStart = wraps
		? originalPathStart
		: originalPathStart + pathStart * originalPathSpan;
	const composedPathEnd = wraps
		? originalPathStart + originalPathSpan
		: originalPathStart + pathEnd * originalPathSpan;

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
		strokeWidths: sliceSideProfile(
			originalPath.strokeWidths,
			pathStart,
			pathEnd,
		),
		strokeWidthsBaked: originalPath.strokeWidthsBaked,
		strokeErasure: sliceSideProfile(
			originalPath.strokeErasure,
			pathStart,
			pathEnd,
		),
	};
}

/**
 * sliceStrokeWidths that also takes a run wrapping past the start of a closed
 * path (end above 1): the part from `start` to the end is joined to the part
 * from the start to `end - 1`.
 */
function sliceSideProfile(
	profile: StrokeWidthPoint[] | undefined,
	start: number,
	end: number,
): StrokeWidthPoint[] | undefined {
	if (end <= 1) return sliceStrokeWidths(profile, start, end);

	const head = sliceStrokeWidths(profile, start, 1);
	const tail = sliceStrokeWidths(profile, 0, end - 1);
	if (!head || !tail) return head ?? tail;

	const seam = (1 - start) / (end - start);
	return [
		...head.map((point) => ({ ...point, t: point.t * seam })),
		...tail.map((point) => ({ ...point, t: seam + point.t * (1 - seam) })),
	];
}
