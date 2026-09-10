import earcut from "earcut";
import { flattenCubicBezier } from "../geometry/bezierFlatten";
import type { BezierPathPrimitive } from "./primitives";

export interface FillPoint {
	x: number;
	y: number;
}

interface FillTriangle {
	p0: FillPoint;
	p1: FillPoint;
	p2: FillPoint;
	/** Bit 0/1/2 marks the boundary edge opposite p0/p1/p2. */
	boundaryMask: number;
}

export function flattenBezierContour(
	segments: BezierPathPrimitive["segments"],
	ox: number,
	oy: number,
	curveTolerance: number,
): FillPoint[] {
	const points: FillPoint[] = [];
	let previousEnd: FillPoint | null = null;
	for (const segment of segments) {
		const start = segment.start ?? previousEnd ?? segment.end;
		const flattened = flattenCubicBezier(
			start,
			segment.cp1,
			segment.cp2,
			segment.end,
			{ curveTolerance },
		);
		for (let i = points.length === 0 ? 0 : 2; i < flattened.length; i += 2) {
			points.push({ x: flattened[i] + ox, y: flattened[i + 1] + oy });
		}
		previousEnd = segment.end;
	}
	return points;
}

export function isPointInFillContour(
	points: readonly FillPoint[],
	x: number,
	y: number,
): boolean {
	let inside = false;
	for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
		const pi = points[i];
		const pj = points[j];
		if (
			pi.y > y !== pj.y > y &&
			x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x
		) {
			inside = !inside;
		}
	}
	return inside;
}

export function triangulateFillContour(
	input: readonly FillPoint[],
): FillTriangle[] {
	const points = normalizeContour(input);
	if (points.length < 3) return [];

	const indices = earcut(points.flatMap(({ x, y }) => [x, y]));
	const triangles: FillTriangle[] = [];
	for (let i = 0; i < indices.length; i += 3) {
		const i0 = indices[i];
		const i1 = indices[i + 1];
		const i2 = indices[i + 2];
		triangles.push({
			p0: points[i0],
			p1: points[i1],
			p2: points[i2],
			boundaryMask:
				(Number(isBoundaryEdge(i1, i2, points.length)) << 0) |
				(Number(isBoundaryEdge(i2, i0, points.length)) << 1) |
				(Number(isBoundaryEdge(i0, i1, points.length)) << 2),
		});
	}
	return triangles;
}

function normalizeContour(input: readonly FillPoint[]): FillPoint[] {
	const points: FillPoint[] = [];
	for (const point of input) {
		const previous = points.at(-1);
		if (previous?.x === point.x && previous.y === point.y) continue;
		points.push(point);
	}
	const first = points[0];
	const last = points.at(-1);
	if (points.length > 1 && first.x === last?.x && first.y === last.y) {
		points.pop();
	}
	return points;
}

function isBoundaryEdge(a: number, b: number, pointCount: number): boolean {
	const distance = Math.abs(a - b);
	return distance === 1 || distance === pointCount - 1;
}
