/**
 * Region geometry for area text (text flowed inside a closed path).
 * Provides path classification for text binding and scanline interval
 * computation used by the layout engine's line width provider.
 * All functions are pure; coordinate-space conversion is the caller's job.
 */

import type { CubicBezierSegment, Point } from "../schema";
import { evalCubicBezier } from "../utils/geometry/pathSampling";
import { resolveSegment } from "../utils/geometry/segmentOps";

/** Usable horizontal span within a line band */
export interface TextLineInterval {
	x0: number;
	x1: number;
}

/**
 * Classify a path for text binding: any closed subpath makes it a shape
 * region (area text); an entirely open path is a text-on-path axis.
 */
export function classifyPathForTextBinding(
	segments: CubicBezierSegment[],
): "onPath" | "inShape" {
	return segments.some((segment) => segment.isClosed) ? "inShape" : "onPath";
}

/**
 * Flatten the closed subpaths of a segment list into polygons.
 * Open subpaths are excluded (they don't bound a region).
 */
export function flattenClosedSubpaths(
	segments: CubicBezierSegment[],
	samplesPerSegment = 24,
): Point[][] {
	const polygons: Point[][] = [];
	let current: Point[] = [];
	let currentClosed = false;
	let prevEnd: Point | undefined;

	const finishSubpath = () => {
		if (currentClosed && current.length >= 3) polygons.push(current);
		current = [];
		currentClosed = false;
	};

	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		const startsNewSubpath = i === 0 || segment.isMoved || segment.start;
		if (startsNewSubpath && current.length > 0) finishSubpath();

		const { start, cp1, cp2, end } = resolveSegment(segment, prevEnd);
		if (current.length === 0) current.push({ x: start.x, y: start.y });
		for (let s = 1; s <= samplesPerSegment; s++) {
			const p = evalCubicBezier(start, cp1, cp2, end, s / samplesPerSegment);
			current.push(p);
		}
		if (segment.isClosed) currentClosed = true;
		prevEnd = segment.end;
	}
	finishSubpath();

	return polygons;
}

/**
 * Even-odd point-in-region test over the polygons produced by
 * {@link flattenClosedSubpaths} (holes supported).
 */
export function pointInPolygonsEvenOdd(
	polygons: Point[][],
	x: number,
	y: number,
): boolean {
	let inside = false;
	for (const polygon of polygons) {
		for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
			const a = polygon[i];
			const b = polygon[j];
			if (
				a.y > y !== b.y > y &&
				x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
			) {
				inside = !inside;
			}
		}
	}
	return inside;
}

/**
 * Compute the usable horizontal intervals for a line band [yA, yB] inside
 * the region bounded by `polygons` (even-odd rule, holes supported).
 * The result is the intersection of the scanline intervals at both band
 * edges — conservative so glyphs never poke outside the region.
 */
export function intervalsForBand(
	polygons: Point[][],
	yA: number,
	yB: number,
	inset = 0,
): TextLineInterval[] {
	const lo = Math.min(yA, yB);
	const hi = Math.max(yA, yB);
	// Sample strictly inside the band: a scanline exactly on a polygon edge
	// (e.g. the shape's top edge) would register no crossings
	const delta = (hi - lo) * 1e-6;
	const atLo = scanlineIntervals(polygons, lo + delta);
	const atHi = scanlineIntervals(polygons, hi - delta);
	const common = intersectIntervals(atLo, atHi);
	if (inset === 0) return common;
	return common
		.map(({ x0, x1 }) => ({ x0: x0 + inset, x1: x1 - inset }))
		.filter(({ x0, x1 }) => x1 > x0);
}

/** Even-odd scanline: sorted crossing xs paired into inside intervals */
function scanlineIntervals(polygons: Point[][], y: number): TextLineInterval[] {
	const xs: number[] = [];
	for (const polygon of polygons) {
		for (let i = 0; i < polygon.length; i++) {
			const p1 = polygon[i];
			const p2 = polygon[(i + 1) % polygon.length];
			if (p1.y <= y === p2.y <= y) continue;
			xs.push(p1.x + ((y - p1.y) * (p2.x - p1.x)) / (p2.y - p1.y));
		}
	}
	xs.sort((a, b) => a - b);
	const intervals: TextLineInterval[] = [];
	for (let i = 0; i + 1 < xs.length; i += 2) {
		intervals.push({ x0: xs[i], x1: xs[i + 1] });
	}
	return intervals;
}

function intersectIntervals(
	a: TextLineInterval[],
	b: TextLineInterval[],
): TextLineInterval[] {
	const result: TextLineInterval[] = [];
	let ai = 0;
	let bi = 0;
	while (ai < a.length && bi < b.length) {
		const x0 = Math.max(a[ai].x0, b[bi].x0);
		const x1 = Math.min(a[ai].x1, b[bi].x1);
		if (x1 > x0) result.push({ x0, x1 });
		if (a[ai].x1 < b[bi].x1) ai++;
		else bi++;
	}
	return result;
}
