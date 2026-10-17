import type { MeshFace, Point } from "../../../schema";
import {
	type AnyArtObject,
	type ElementTransform,
	getTransform,
	isIdentityTransform,
	type MeshArtObject,
} from "../../../schema";
import {
	type CubicCurve,
	evalCubicBezier,
	getCurveInterval,
} from "../primitives/bezier";
import {
	applyTransformToPoint,
	composeTransforms,
	toWorld,
	type WorldBezierSegment,
} from "../space/coordinates";

export interface MeshVertexLike {
	x: number;
	y: number;
	handles: Record<number, Point>;
	positionSource?: { edgeVerts: number[]; t: number };
	meshSource?: { edgeVerts: number[]; t: number };
	colorMode?: "explicit" | "derived";
	splitLineId?: number;
	subdivisionId?: number;
	subdivisionSource?: {
		id: number;
		vertexCount: number;
		faces: MeshFace[];
	};
}

/** Undirected edge key — always orders endpoints ascending. */
export function edgeKey(a: number, b: number): string {
	return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Returns the set of undirected edges (as "min:max" strings) that appear in
 * exactly one face — i.e. the outer boundary of the mesh.
 */
function getBoundaryEdgeSet(faces: readonly MeshFace[]): Set<string> {
	const counts = new Map<string, number>();
	for (const face of faces) {
		const vs = face.verts;
		const n = vs.length;
		for (let e = 0; e < n; e++) {
			const k = edgeKey(vs[e], vs[(e + 1) % n]);
			counts.set(k, (counts.get(k) ?? 0) + 1);
		}
	}
	const out = new Set<string>();
	for (const [k, c] of counts) if (c === 1) out.add(k);
	return out;
}

/** All vertex indices sharing at least one face with `idx`. */
export function getVertexNeighbors(
	faces: readonly MeshFace[],
	idx: number,
): Set<number> {
	const neighbors = new Set<number>();
	for (const face of faces) {
		const vs = face.verts;
		const pos = vs.indexOf(idx);
		if (pos === -1) continue;
		const n = vs.length;
		neighbors.add(vs[(pos + 1) % n]);
		neighbors.add(vs[(pos + n - 1) % n]);
	}
	return neighbors;
}

/**
 * Effective per-neighbor control handle for the edge i→j: the stored handle if
 * present, otherwise the implicit default 1/3 of the way along the straight line
 * from vertex i toward vertex j.
 */
export function getBaseHandle(
	vertices: readonly MeshVertexLike[],
	i: number,
	j: number,
): Point {
	const stored = vertices[i].handles[j];
	if (stored) return { x: stored.x, y: stored.y };
	const a = vertices[i];
	const b = vertices[j];
	return {
		x: a.x + (b.x - a.x) / 3,
		y: a.y + (b.y - a.y) / 3,
	};
}

export function getEdgeCurve(
	vertices: readonly MeshVertexLike[],
	i: number,
	j: number,
): CubicCurve {
	return [
		{ x: vertices[i].x, y: vertices[i].y },
		getBaseHandle(vertices, i, j),
		getBaseHandle(vertices, j, i),
		{ x: vertices[j].x, y: vertices[j].y },
	];
}

/**
 * Evaluate a point on the edge (i→j) at parameter t, resolving root-segment
 * subcurves automatically. Mirrors prototype's boundary behavior and extends it
 * to interior derived chains.
 */
export function evalEdge(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
	i: number,
	j: number,
	t: number,
): Point {
	const curve = getEffectiveMeshEdgeCurve(vertices, faces, i, j);
	return evalCubicBezier(curve[0], curve[1], curve[2], curve[3], t);
}

function getBoundaryTOnRootEdge(
	vertices: readonly MeshVertexLike[],
	vertexIdx: number,
	rootStart: number,
	rootEnd: number,
): number | null {
	if (vertexIdx === rootStart) return 0;
	if (vertexIdx === rootEnd) return 1;
	const v = vertices[vertexIdx];
	for (const sourceKey of ["positionSource", "meshSource"] as const) {
		const source = v[sourceKey];
		if (!source) continue;
		if (source.edgeVerts[0] === rootStart && source.edgeVerts[1] === rootEnd)
			return source.t;
		// Transitive resolution: if positionSource.edgeVerts references another
		// derived vertex, follow the chain to compute the root-edge T.
		// e.g. v9.positionSource = {edgeVerts:[4,1], t:0.5} where v4 is derived
		// on [0,1] at t=0.5 → v9's root T = 0.5 + 0.5 * (1.0 - 0.5) = 0.75
		const [a, b] = source.edgeVerts;
		const tA = getBoundaryTOnRootEdge(vertices, a, rootStart, rootEnd);
		const tB = getBoundaryTOnRootEdge(vertices, b, rootStart, rootEnd);
		if (tA !== null && tB !== null) return tA + source.t * (tB - tA);
	}
	return null;
}

interface BoundarySegmentInfo {
	rootEdge: [number, number];
	t0: number;
	t1: number;
}

function getBoundaryVertexSet(faces: readonly MeshFace[]): Set<number> {
	const boundaryEdges = getBoundaryEdgeSet(faces);
	const result = new Set<number>();
	for (const face of faces) {
		const n = face.verts.length;
		for (let edgeIdx = 0; edgeIdx < n; edgeIdx++) {
			const i = face.verts[edgeIdx];
			const j = face.verts[(edgeIdx + 1) % n];
			if (!boundaryEdges.has(edgeKey(i, j))) continue;
			result.add(i);
			result.add(j);
		}
	}
	return result;
}

function isRootSegmentAnchor(
	vertices: readonly MeshVertexLike[],
	boundaryVertices: ReadonlySet<number>,
	vertexIdx: number,
): boolean {
	return (
		boundaryVertices.has(vertexIdx) ||
		vertices[vertexIdx]?.positionSource == null
	);
}

function expandEdgeEndpointToRootAnchor(
	vertices: readonly MeshVertexLike[],
	boundaryVertices: ReadonlySet<number>,
	vertexIdx: number,
	otherIdx: number,
): number | null {
	if (isRootSegmentAnchor(vertices, boundaryVertices, vertexIdx)) return null;
	const source =
		vertices[vertexIdx]?.positionSource ?? vertices[vertexIdx]?.meshSource;
	if (!source) return null;
	if (source.edgeVerts[0] === otherIdx) return source.edgeVerts[1] ?? null;
	if (source.edgeVerts[1] === otherIdx) return source.edgeVerts[0] ?? null;
	return null;
}

function getTOnRootSegment(
	vertices: readonly MeshVertexLike[],
	vertexIdx: number,
	rootStart: number,
	rootEnd: number,
	seen = new Set<number>(),
): number | null {
	if (vertexIdx === rootStart) return 0;
	if (vertexIdx === rootEnd) return 1;
	if (seen.has(vertexIdx)) return null;
	seen.add(vertexIdx);
	const vertex = vertices[vertexIdx];
	if (!vertex) return null;
	for (const sourceKey of ["positionSource", "meshSource"] as const) {
		const source = vertex[sourceKey];
		if (!source) continue;
		if (source.edgeVerts[0] === rootStart && source.edgeVerts[1] === rootEnd) {
			return source.t;
		}
		if (source.edgeVerts[0] === rootEnd && source.edgeVerts[1] === rootStart) {
			return 1 - source.t;
		}
		const [a, b] = source.edgeVerts;
		const tA = getTOnRootSegment(
			vertices,
			a,
			rootStart,
			rootEnd,
			new Set(seen),
		);
		const tB = getTOnRootSegment(
			vertices,
			b,
			rootStart,
			rootEnd,
			new Set(seen),
		);
		if (tA !== null && tB !== null) return tA + source.t * (tB - tA);
	}
	return null;
}

function normalizeRootSegmentInfo(
	rootStart: number,
	rootEnd: number,
	t0: number,
	t1: number,
): BoundarySegmentInfo | null {
	if (Math.abs(t1 - t0) < 1e-8) return null;
	if (t0 <= t1) {
		return { rootEdge: [rootStart, rootEnd], t0, t1 };
	}
	return {
		rootEdge: [rootEnd, rootStart],
		t0: 1 - t0,
		t1: 1 - t1,
	};
}

export function getRootSegmentInfo(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
	i: number,
	j: number,
): BoundarySegmentInfo | null {
	const boundaryInfo = getBoundarySegmentInfo(vertices, faces, i, j);
	if (boundaryInfo) return boundaryInfo;

	const boundaryVertices = getBoundaryVertexSet(faces);
	let rootStart = i;
	let rootEnd = j;
	const visitedPairs = new Set<string>();

	for (let iter = 0; iter < vertices.length * 2; iter++) {
		const pairKey = `${rootStart}:${rootEnd}`;
		if (visitedPairs.has(pairKey)) break;
		visitedPairs.add(pairKey);

		let changed = false;
		const expandedStart = expandEdgeEndpointToRootAnchor(
			vertices,
			boundaryVertices,
			rootStart,
			rootEnd,
		);
		if (expandedStart != null && expandedStart !== rootStart) {
			rootStart = expandedStart;
			changed = true;
		}

		const expandedEnd = expandEdgeEndpointToRootAnchor(
			vertices,
			boundaryVertices,
			rootEnd,
			rootStart,
		);
		if (expandedEnd != null && expandedEnd !== rootEnd) {
			rootEnd = expandedEnd;
			changed = true;
		}

		if (!changed) break;
	}

	if (
		rootStart === rootEnd ||
		!isRootSegmentAnchor(vertices, boundaryVertices, rootStart) ||
		!isRootSegmentAnchor(vertices, boundaryVertices, rootEnd)
	) {
		return null;
	}

	const t0 = getTOnRootSegment(vertices, i, rootStart, rootEnd);
	const t1 = getTOnRootSegment(vertices, j, rootStart, rootEnd);
	if (t0 === null || t1 === null) return null;
	return normalizeRootSegmentInfo(rootStart, rootEnd, t0, t1);
}

export function getBoundarySegmentInfo(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
	i: number,
	j: number,
): BoundarySegmentInfo | null {
	const loop = getBoundaryVertexLoop(faces);
	if (!loop) return null;
	const isDerived = (idx: number) => vertices[idx].positionSource != null;
	const rootIndices: number[] = [];
	for (let k = 0; k < loop.length; k++) {
		if (!isDerived(loop[k])) rootIndices.push(loop[k]);
	}
	for (let ri = 0; ri < rootIndices.length; ri++) {
		const rootStart = rootIndices[ri];
		const rootEnd = rootIndices[(ri + 1) % rootIndices.length];
		const t0 = getBoundaryTOnRootEdge(vertices, i, rootStart, rootEnd);
		const t1 = getBoundaryTOnRootEdge(vertices, j, rootStart, rootEnd);
		if (t0 === null || t1 === null) continue;
		return { rootEdge: [rootStart, rootEnd], t0, t1 };
	}
	return null;
}

export function getLocalEdgeTFromBoundaryT(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
	edgeVerts: readonly number[],
	boundaryT: number,
): number {
	const info = getBoundarySegmentInfo(
		vertices,
		faces,
		edgeVerts[0],
		edgeVerts[1],
	);
	if (!info || Math.abs(info.t1 - info.t0) < 1e-8) return boundaryT;
	return Math.max(0, Math.min(1, (boundaryT - info.t0) / (info.t1 - info.t0)));
}

export function getBoundarySubcurve(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
	i: number,
	j: number,
): CubicCurve | null {
	const info = getBoundarySegmentInfo(vertices, faces, i, j);
	if (!info) return null;
	// Read root→root handles directly. Root handles are preserved after
	// subdivision (insertEdgeMidVertex does not delete them), matching the
	// prototype's getBoundarySubcurve (page.tsx L325-333).
	const rootCurve = getEdgeCurve(vertices, info.rootEdge[0], info.rootEdge[1]);
	return getCurveInterval(rootCurve, info.t0, info.t1);
}

/**
 * Returns the curve that should drive edge rendering / packing for edge (i→j).
 * Any edge that lies on a derived root segment resolves to that segment's
 * subcurve; only edges without a parent segment use stored per-neighbor
 * handles directly.
 */
export function getEffectiveMeshEdgeCurve(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
	i: number,
	j: number,
): CubicCurve {
	return (
		getRootSegmentSubcurve(vertices, faces, i, j) ??
		getEdgeCurve(vertices, i, j)
	);
}

function getRootSegmentSubcurve(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
	i: number,
	j: number,
): CubicCurve | null {
	const info = getRootSegmentInfo(vertices, faces, i, j);
	if (!info) return null;
	const rootCurve = getEdgeCurve(vertices, info.rootEdge[0], info.rootEdge[1]);
	return getCurveInterval(rootCurve, info.t0, info.t1);
}

/**
 * Coons-patch position at (u, v) for a quad bounded by four cubic curves:
 * `bottom`/`top` run along u (at v=0 / v=1), `left`/`right` along v (at
 * u=0 / u=1). Corner terms come from the curves' own endpoints.
 */
export function coonsPatchPoint(
	bottom: CubicCurve,
	top: CubicCurve,
	left: CubicCurve,
	right: CubicCurve,
	u: number,
	v: number,
): Point {
	const c0 = evalCubicBezier(bottom[0], bottom[1], bottom[2], bottom[3], u);
	const c1 = evalCubicBezier(top[0], top[1], top[2], top[3], u);
	const d0 = evalCubicBezier(left[0], left[1], left[2], left[3], v);
	const d1 = evalCubicBezier(right[0], right[1], right[2], right[3], v);
	const mu = 1 - u;
	const mv = 1 - v;
	return {
		x:
			mv * c0.x +
			v * c1.x +
			mu * d0.x +
			u * d1.x -
			(mu * mv * bottom[0].x +
				u * mv * bottom[3].x +
				u * v * top[3].x +
				mu * v * top[0].x),
		y:
			mv * c0.y +
			v * c1.y +
			mu * d0.y +
			u * d1.y -
			(mu * mv * bottom[0].y +
				u * mv * bottom[3].y +
				u * v * top[3].y +
				mu * v * top[0].y),
	};
}

/**
 * Inverse bilinear from 4 corner positions. Used as a seed for quad (u, v)
 * lookups when full Newton is unnecessary. Falls back to (0.5, 0.5) if the
 * quadratic is degenerate.
 */
export function bilinearUV(
	vertices: readonly MeshVertexLike[],
	quad: readonly number[],
	px: number,
	py: number,
): { u: number; v: number } {
	const [i00, i10, i11, i01] = quad;
	const p00 = vertices[i00];
	const p10 = vertices[i10];
	const p11 = vertices[i11];
	const p01 = vertices[i01];

	const ex = p10.x - p00.x;
	const ey = p10.y - p00.y;
	const fx = p01.x - p00.x;
	const fy = p01.y - p00.y;
	const gx = p00.x - p10.x + p11.x - p01.x;
	const gy = p00.y - p10.y + p11.y - p01.y;
	const hx = px - p00.x;
	const hy = py - p00.y;

	const A = fx * gy - fy * gx;
	const B = ex * fy - ey * fx + hx * gy - hy * gx;
	const C = hx * ey - hy * ex;

	let u = 0.5;
	let v = 0.5;

	if (Math.abs(A) < 1e-8) {
		if (Math.abs(B) > 1e-8) v = -C / B;
	} else {
		const disc = B * B - 4 * A * C;
		if (disc >= 0) {
			const sq = Math.sqrt(disc);
			const v1 = (-B + sq) / (2 * A);
			const v2 = (-B - sq) / (2 * A);
			const inRange = (t: number) => t >= -0.001 && t <= 1.001;
			if (inRange(v1) && inRange(v2))
				v = Math.abs(v1 - 0.5) < Math.abs(v2 - 0.5) ? v1 : v2;
			else if (inRange(v1)) v = v1;
			else if (inRange(v2)) v = v2;
			else v = v1;
		}
	}

	const denomX = ex + gx * v;
	const denomY = ey + gy * v;
	if (Math.abs(denomX) > Math.abs(denomY)) {
		if (Math.abs(denomX) > 1e-8) u = (hx - fx * v) / denomX;
	} else if (Math.abs(denomY) > 1e-8) {
		u = (hy - fy * v) / denomY;
	}

	return {
		u: Math.max(0, Math.min(1, u)),
		v: Math.max(0, Math.min(1, v)),
	};
}

/** Undirected edge counts across all faces. */
function getEdgeFaceCounts(faces: readonly MeshFace[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const face of faces) {
		const vs = face.verts;
		for (let e = 0; e < vs.length; e++) {
			const k = edgeKey(vs[e], vs[(e + 1) % vs.length]);
			counts.set(k, (counts.get(k) ?? 0) + 1);
		}
	}
	return counts;
}

/**
 * Ordered closed polyline of boundary edges: sequence of vertex indices
 * starting at the lexicographically smallest boundary edge. Returns `null`
 * when the boundary is malformed (disconnected or non-manifold).
 */
export function getBoundaryVertexLoop(
	faces: readonly MeshFace[],
): number[] | null {
	const counts = getEdgeFaceCounts(faces);
	const adj = new Map<number, Set<number>>();
	for (const [k, c] of counts) {
		if (c !== 1) continue;
		const [a, b] = k.split(":").map(Number);
		if (!adj.has(a)) adj.set(a, new Set());
		if (!adj.has(b)) adj.set(b, new Set());
		adj.get(a)!.add(b);
		adj.get(b)!.add(a);
	}
	if (adj.size === 0) return null;
	const start = [...adj.keys()].sort((a, b) => a - b)[0];
	const loop: number[] = [start];
	let prev = -1;
	let cur = start;
	while (true) {
		const neighbors = [...(adj.get(cur) ?? [])].filter((n) => n !== prev);
		if (neighbors.length === 0) return null;
		const next = neighbors[0];
		if (next === start) return loop;
		loop.push(next);
		prev = cur;
		cur = next;
		if (loop.length > adj.size + 1) return null;
	}
}

/**
 * Decide whether to emit the CP handle owned by `ownerIdx` on its edge toward
 * `neighborIdx` in GradientTool-style selected-vertex overlays.
 *
 * A handle is emitted only when dragging it can actually change the rendered
 * edge curve, mirroring getEffectiveMeshEdgeCurve / getDisplayedMeshHandle:
 *
 * - Edges that are not part of a root segment (e.g. a derived→explicit split
 *   line) render from their own endpoint handles, so both sides are editable.
 * - Edges lying on a root segment expose only the root-anchor-side handles
 *   (which map onto the root cubic's base handles); handles owned by derived
 *   mid-segment vertices are ignored by the curve and therefore hidden.
 */
export function shouldEmitMeshCPHandle(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
	ownerIdx: number,
	neighborIdx: number,
): boolean {
	const info = getRootSegmentInfo(vertices, faces, ownerIdx, neighborIdx);
	if (!info) return true;
	const [rootStart, rootEnd] = info.rootEdge;
	if (ownerIdx === rootStart && Math.abs(info.t0) < 1e-8 && info.t1 > 1e-8) {
		return true;
	}
	return (
		ownerIdx === rootEnd && Math.abs(info.t0 - 1) < 1e-8 && info.t1 < 1 - 1e-8
	);
}

/**
 * Returns the display position for a visible CP handle in the mesh overlay,
 * mirroring the prototype's `getDisplayedHandle(vertices, i, j)`:
 *
 * - If the edge (i→j) lies on a root segment subcurve, and `i` is a root
 *   endpoint of that segment while `j` is the first derived neighbor (t > 0),
 *   return the root handle (`i.handles[rootEnd]`). Symmetrically for the other
 *   end.
 * - Otherwise delegate to `getHandle` (root-segment subcurve CP or raw handle).
 *
 * Visibility is decided by the caller (`shouldEmitMeshCPHandle` for
 * GradientTool-style overlays, owner-side rules in PathEditTool).
 */
export function getDisplayedMeshHandle(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
	i: number,
	j: number,
): Point {
	const info = getRootSegmentInfo(vertices, faces, i, j);
	if (!info) return getMeshEdgeHandle(vertices, faces, i, j);
	const [rootStart, rootEnd] = info.rootEdge;
	if (i === rootStart && Math.abs(info.t0) < 1e-8 && info.t1 > 1e-8) {
		return getBaseHandle(vertices, rootStart, rootEnd);
	}
	if (i === rootEnd && Math.abs(info.t0 - 1) < 1e-8 && info.t1 < 1 - 1e-8) {
		return getBaseHandle(vertices, rootEnd, rootStart);
	}
	return getMeshEdgeHandle(vertices, faces, i, j);
}

/**
 * Returns the effective CP handle for the edge (i→j), using the owning
 * root-segment subcurve CP when the edge lies on a derived root segment.
 */
export function getMeshEdgeHandle(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
	i: number,
	j: number,
): Point {
	const bsc = getRootSegmentSubcurve(vertices, faces, i, j);
	if (bsc) return { ...bsc[1] };
	return getBaseHandle(vertices, i, j);
}

/**
 * The storage slot a CP drag on edge (vi→ni) actually writes, returned as the
 * neighbor key on `vertices[vi].handles`. When the edge lies on a root segment
 * and `vi` is the root anchor at the touched end, the write target is the root
 * cubic's base handle (`vi.handles[rootNeighbor]`) — the handle
 * `getEffectiveMeshEdgeCurve` actually reads. Otherwise it is `ni` itself.
 */
/**
 * Screen-px radius the pointer must leave before an Alt-drag handle fan
 * captures its polar reference vector — the angle of a near-zero vector next
 * to the grabbed vertex is unstable.
 */
export const MESH_CP_FAN_REF_MIN_SCREEN_PX = 8;

export function resolveMeshEdgeHandleSlot(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
	vi: number,
	ni: number,
): number {
	const info = getRootSegmentInfo(vertices, faces, vi, ni);
	if (!info) return ni;
	const [rootStart, rootEnd] = info.rootEdge;
	if (vi === rootStart && Math.abs(info.t0) < 1e-8 && info.t1 > 1e-8) {
		return rootEnd;
	}
	if (vi === rootEnd && Math.abs(info.t0 - 1) < 1e-8 && info.t1 < 1 - 1e-8) {
		return rootStart;
	}
	return ni;
}

/**
 * Root-to-root cubic curves that form the outer boundary of a mesh, skipping
 * derived vertices inserted by `subdivideFace`. Returns `null`
 * when the boundary topology is malformed or no root vertices are present.
 */
export function getRootBoundaryCurves(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
): CubicCurve[] | null {
	const loop = getBoundaryVertexLoop(faces);
	if (!loop || loop.length < 2) return null;
	const isDerived = (idx: number) => vertices[idx].positionSource != null;
	const rootPositions: number[] = [];
	for (let k = 0; k < loop.length; k++) {
		if (!isDerived(loop[k])) rootPositions.push(k);
	}
	if (rootPositions.length < 2) return null;
	const result: CubicCurve[] = [];
	for (let i = 0; i < rootPositions.length; i++) {
		const rootStart = loop[rootPositions[i]];
		const rootEnd = loop[rootPositions[(i + 1) % rootPositions.length]];
		result.push(getEdgeCurve(vertices, rootStart, rootEnd));
	}
	return result;
}

export function getOppositeMeshNeighbor(
	faces: readonly MeshFace[],
	centerIdx: number,
	incomingIdx: number,
): number | null {
	const neighbors = getVertexNeighbors(faces, centerIdx);
	if (!neighbors.has(incomingIdx)) return null;
	const turningNeighbors = new Set<number>();
	let adjacentFaceCount = 0;
	for (const face of faces) {
		if (!meshFaceHasEdge(face, centerIdx, incomingIdx)) continue;
		adjacentFaceCount++;
		const centerPosition = face.verts.indexOf(centerIdx);
		const previous =
			face.verts[(centerPosition + face.verts.length - 1) % face.verts.length];
		const next = face.verts[(centerPosition + 1) % face.verts.length];
		if (previous !== incomingIdx) turningNeighbors.add(previous);
		if (next !== incomingIdx) turningNeighbors.add(next);
	}
	if (adjacentFaceCount === 0) return null;
	const candidates = [...neighbors].filter(
		(neighbor) => neighbor !== incomingIdx && !turningNeighbors.has(neighbor),
	);
	return candidates.length === 1 ? candidates[0] : null;
}

export function meshFaceHasEdge(face: MeshFace, a: number, b: number): boolean {
	return face.verts.some(
		(vi, index) =>
			(vi === a && face.verts[(index + 1) % face.verts.length] === b) ||
			(vi === b && face.verts[(index + 1) % face.verts.length] === a),
	);
}

/**
 * Whether the user made this vertex explicit after a subdivision had created
 * it as a derived one — the single kind of explicit vertex that can be put
 * back. The vertex a subdivision was clicked into carries its restore
 * snapshot instead, and the mesh's original corners carry no subdivision id.
 */
export function isPromotedMeshVertex(
	vertex: MeshVertexLike | undefined,
): boolean {
	return (
		vertex?.subdivisionId !== undefined &&
		!vertex.subdivisionSource &&
		isExplicitMeshVertex(vertex)
	);
}

/**
 * The edge a vertex sits on: the grid line running straight through it, given
 * as the pair of placed vertices bounding it (`edgeVerts`) plus the vertex's
 * own two neighbors along it. Returns null when no line passes through the
 * vertex — there is nothing to bind it to then.
 */
export function resolveMeshVertexOwningEdge<V extends MeshVertexLike>(
	vertices: readonly V[],
	faces: readonly MeshFace[],
	vertexIndex: number,
): { edgeVerts: [number, number]; alongNeighbors: [number, number] } | null {
	const neighbors = [...getVertexNeighbors(faces, vertexIndex)];
	for (const neighbor of neighbors) {
		const opposite = getOppositeMeshNeighbor(faces, vertexIndex, neighbor);
		if (opposite === null || !neighbors.includes(opposite)) continue;
		const first = walkToLineEnd(vertices, faces, vertexIndex, neighbor);
		const second = walkToLineEnd(vertices, faces, vertexIndex, opposite);
		if (first === second) continue;
		return {
			edgeVerts: [first, second],
			alongNeighbors: [neighbor, opposite],
		};
	}
	return null;
}

/**
 * Whether the user placed this vertex, so that topology edits around it must
 * keep it. A gradient vertex says so with its color mode; a geometry cage
 * vertex carries no color at all and stays derived exactly while it is still
 * bound to the edge or face it was cut from.
 */
export function isExplicitMeshVertex(
	vertex: MeshVertexLike | undefined,
): boolean {
	if (!vertex) return false;
	if (vertex.colorMode != null) return vertex.colorMode === "explicit";
	return vertex.positionSource == null && vertex.meshSource == null;
}

/** Follow a grid line outwards from `originIdx` to the first placed vertex. */
function walkToLineEnd<V extends MeshVertexLike>(
	vertices: readonly V[],
	faces: readonly MeshFace[],
	originIdx: number,
	startIdx: number,
): number {
	let previousIdx = originIdx;
	let currentIdx = startIdx;
	while (!isExplicitMeshVertex(vertices[currentIdx])) {
		const nextIdx = getOppositeMeshNeighbor(faces, currentIdx, previousIdx);
		if (nextIdx === null || nextIdx === originIdx) break;
		previousIdx = currentIdx;
		currentIdx = nextIdx;
	}
	return currentIdx;
}

/**
 * Convert a MeshArtObject's outer boundary into world-space cubic Bézier
 * segments — the mesh analogue of `getWorldSegments` for Path. Each boundary
 * edge emits one cubic with endpoints + per-side handles resolved via
 * `getEdgeCurve`, then transformed through the element's SRT (composed with
 * `ancestorTransform` when given).
 *
 * Returns an empty array when the boundary is degenerate (no faces / broken
 * topology), so callers can treat the result uniformly with Path outlines.
 */
export function getMeshWorldBoundarySegments(
	mesh: MeshArtObject,
	getElement: (id: string) => AnyArtObject | undefined,
	ancestorTransform?: ElementTransform,
): WorldBezierSegment[] {
	const curves = getRootBoundaryCurves(mesh.vertices, mesh.faces);
	if (!curves || curves.length < 1) return [];

	const elementT = getTransform(mesh);
	const t = ancestorTransform
		? composeTransforms(ancestorTransform, elementT)
		: elementT;
	const identity = isIdentityTransform(t);

	const tp = (p: { x: number; y: number }) => {
		if (identity) return toWorld(p.x, p.y);
		const w = applyTransformToPoint(p.x, p.y, t);
		return toWorld(w.x, w.y);
	};

	return curves.map((curve) => ({
		start: tp(curve[0]),
		cp1: tp(curve[1]),
		cp2: tp(curve[2]),
		end: tp(curve[3]),
	}));
}
