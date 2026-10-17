import type { MeshFace, Point } from "../../../schema";
import {
	edgeKey,
	getEffectiveMeshEdgeCurve,
	type MeshVertexLike,
} from "../measure/meshTopology";
import { type CubicCurve, evalCubicBezier } from "../primitives/bezier";

/**
 * The face edge closest to `point` (by the caller's own `metric`, e.g.
 * screen pixels), with the curve parameter of the closest spot on it.
 * Parameters hugging an endpoint are skipped — a click there means the
 * vertex, not the edge.
 */
export function findClosestMeshEdgePoint(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
	point: Point,
	metric: (onEdge: Point) => number,
): {
	faceIdx: number;
	edgeIdx: number;
	i: number;
	j: number;
	t: number;
	point: Point;
	dist: number;
} | null {
	let best: ReturnType<typeof findClosestMeshEdgePoint> = null;
	const seen = new Set<string>();
	for (let fi = 0; fi < faces.length; fi++) {
		const face = faces[fi];
		if (face.type !== "quad") continue;
		for (let e = 0; e < 4; e++) {
			const i = face.verts[e];
			const j = face.verts[(e + 1) % 4];
			const key = edgeKey(i, j);
			if (seen.has(key)) continue;
			seen.add(key);
			const curve = getEffectiveMeshEdgeCurve(vertices, faces, i, j);
			const t = findClosestCurveT(curve, point.x, point.y);
			// Near the endpoints a double-click promotes the vertex instead.
			if (t < 0.02 || t > 0.98) continue;
			const onEdge = evalCubicBezier(curve[0], curve[1], curve[2], curve[3], t);
			const dist = metric(onEdge);
			if (!best || dist < best.dist) {
				best = { faceIdx: fi, edgeIdx: e, t, i, j, point: onEdge, dist };
			}
		}
	}
	return best;
}

function rayCrossBezier(px: number, py: number, curve: CubicCurve): number {
	const STEPS = 32;
	let crossings = 0;
	let prevX = curve[0].x;
	let prevY = curve[0].y;
	for (let k = 1; k <= STEPS; k++) {
		const t = k / STEPS;
		const p = evalCubicBezier(curve[0], curve[1], curve[2], curve[3], t);
		if ((prevY <= py && p.y > py) || (p.y <= py && prevY > py)) {
			const frac = (py - prevY) / (p.y - prevY);
			const ix = prevX + frac * (p.x - prevX);
			if (ix > px) crossings++;
		}
		prevX = p.x;
		prevY = p.y;
	}
	return crossings;
}

/** Closest t in [0,1] on a cubic Bézier to (px, py). Coarse sample + refine. */
export function findClosestCurveT(
	curve: CubicCurve,
	px: number,
	py: number,
): number {
	const SAMPLES = 64;
	let bestT = 0;
	let bestDist = Number.POSITIVE_INFINITY;
	for (let s = 0; s <= SAMPLES; s++) {
		const t = s / SAMPLES;
		const p = evalCubicBezier(curve[0], curve[1], curve[2], curve[3], t);
		const d = (p.x - px) * (p.x - px) + (p.y - py) * (p.y - py);
		if (d < bestDist) {
			bestDist = d;
			bestT = t;
		}
	}
	let range = 1 / SAMPLES;
	for (let iter = 0; iter < 5; iter++) {
		const candidates = [
			Math.max(0, bestT - range),
			bestT,
			Math.min(1, bestT + range),
		];
		for (const t of candidates) {
			const p = evalCubicBezier(curve[0], curve[1], curve[2], curve[3], t);
			const d = (p.x - px) * (p.x - px) + (p.y - py) * (p.y - py);
			if (d < bestDist) {
				bestDist = d;
				bestT = t;
			}
		}
		range *= 0.5;
	}
	return bestT;
}

export function pointInBezierFace(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
	face: MeshFace,
	px: number,
	py: number,
): boolean {
	const vs = face.verts;
	const n = vs.length;
	let crossings = 0;
	for (let e = 0; e < n; e++) {
		const i = vs[e];
		const j = vs[(e + 1) % n];
		crossings += rayCrossBezier(
			px,
			py,
			getEffectiveMeshEdgeCurve(vertices, faces, i, j),
		);
	}
	return (crossings & 1) === 1;
}
