// =============================================================================
// Mesh gradient / mesh geometry CPU utilities.
//
// Shared mesh-gradient / mesh-geometry helpers derived from the
// "Bézier polygon hit + Coons Patch color (no holes)" prototype at
// pkgs/web/src/app/proto/mesh-gradient/page.tsx. This file is the
// spec-oriented source of truth for shared behavior used by both MeshArtObject
// (geometry-only element) and MeshGradient (self-contained fill).
//
// -----------------------------------------------------------------------------
// Spec — data model
// -----------------------------------------------------------------------------
// * A mesh is a pair (vertices, faces).
// * Each face is either a `quad` (4 verts CCW) or `tri` (3 verts CCW). Coons
//   patches are defined only for quads/tris — 5+ sided faces are invalid.
// * Each vertex carries per-neighbor cubic Bézier handles keyed by the
//   neighbor's index. An edge (i, j) is rendered as the cubic
//     P0 = vi, CP0 = vi.handles[j], CP1 = vj.handles[i], P3 = vj.
//   Missing handle entries fall back to linear 1/3 and 2/3 seeds.
// * The mesh outer boundary = the set of edges incident to exactly one face.
//
// -----------------------------------------------------------------------------
// Spec — color model (MeshGradient only)
// -----------------------------------------------------------------------------
// * `colorMode: "explicit"` — color is user-set; survives topology edits.
// * `colorMode: "derived"` — color is recomputed from `colorSource` whenever
//   the surrounding geometry changes. Used for subdivision-introduced
//   vertices that the user has never colored.
// * `colorSource.kind === "edge"` — sample a 1D color blend along the parent
//   edge at parameter `t`.
// * `colorSource.kind === "quad"` — sample a 2D Coons-patch blend at (u, v)
//   inside the parent quad.
// * Color blending happens in OKLab (see `colorFromEdge`/`colorFromFaceCorners`).
//
// -----------------------------------------------------------------------------
// Spec — root segment shape ownership
// -----------------------------------------------------------------------------
// The outer boundary of the mesh (getBoundaryEdgeSet) is formed by edges
// incident to exactly one face. In addition, interior chains may contain
// derived vertices between anchor vertices (typically a boundary vertex and an
// explicit interior vertex). In both cases, the shape of the segment is
// determined **solely by its anchor vertices** — derived vertices are position
// markers on the anchor-to-anchor root cubic and do not influence the face
// shape.
//
// Diagram — initial quad, then two successive subdivisions:
//
//   v0(E) ─────────────────── v1(E)        E = explicit vertex
//   │                           │          D = derived vertex
//   │         face[0]           │
//   │                           │
//   v3(E) ─────────────────── v2(E)
//
//   After subdivideFace(face[0], 0.5, 0.5):
//
//   v0(E) ──── v4(D) ──── v1(E)      v4: positionSource={edgeVerts:[0,1], t=0.5}
//   │            │            │       v5: positionSource={edgeVerts:[1,2], t=0.5}
//   │   f[0]     │   f[1]    │       v6: positionSource={edgeVerts:[3,2], t=0.5}
//   │            │            │       v7: positionSource={edgeVerts:[0,3], t=0.5}
//   v7(D) ──── v8(E) ──── v5(D)      v8: explicit center
//   │            │            │
//   │   f[3]     │   f[2]    │
//   │            │            │
//   v3(E) ──── v6(D) ──── v2(E)
//
//   After subdivideFace(face[1], 0.5, 0.5):
//
//   v0(E) ─ v4(D) ─ v9(D) ─ v1(E)   v9:  positionSource={edgeVerts:[4,1], t=0.5}
//   │          │        │       │     v10: positionSource={edgeVerts:[1,5], t=0.5}
//   │  f[0]    │ f[1-0] │f[1-1]│     v12: explicit center
//   │          │        │       │
//   v7(D) ── v8(E) ─ v12(E) ─ v10(D)
//   │          │        │       │
//   │  f[3]    │ f[1-3] │f[1-2]│
//   │          │        │       │
//   v3(E) ─ v6(D) ─ v11(D) ─ v2(E)
//
// Boundary edge v0 → v4 → v9 → v1:
//
//   The *shape* of this entire boundary segment is the single root cubic:
//     getEdgeCurve(v0, v1) = [v0, v0.handles[1], v1.handles[0], v1]
//
//   v4 and v9 are position markers that slide along this cubic:
//     v4 sits at root cubic t = 0.5
//     v9 sits at root cubic t = 0.75  (0.5 + 0.5 * 0.5)
//
//   v4's and v9's BCPs (handles) do NOT affect the boundary edge shape.
//   Only v0.handles[1] and v1.handles[0] control the boundary curve.
//   UI layers decide independently which boundary CPs to show:
//   Gradient-style selected-vertex overlays hide boundary-derived owners,
//   while PathEditTool applies its own owner-side visibility rule.
//
// Dragging a derived vertex on a root segment:
//   - Project onto the owning root cubic/subcurve via findClosestCurveT
//   - Update positionSource.t (slide along that root segment)
//   - Do NOT move the vertex's handles (prototype L2659 early return)
//   - The segment shape does not change
//
// Dragging an explicit vertex or its handle:
//   - The root cubic itself changes → the owned segment / face shape changes
//   - All derived vertices on that root segment are re-projected via syncDerivedVertices
//
// Key functions enforcing this spec:
//   evalEdge(v, f, i, j, t) — for derived sub-edges, evaluates the owning root
//     cubic sub-interval via getRootSegmentSubcurve, ignoring derived handles.
//   getMeshEdgeHandle(v, f, i, j) — returns root-segment subcurve CP for
//     root-segment edges (not the derived vertex's stored handle).
//   getDisplayedMeshHandle(v, f, i, j) — resolves the display position for
//     a visible CP. It does not decide whether that CP should be shown.
//   shouldEmitMeshCPHandle(...) — selected-vertex CP visibility helper used by
//     GradientTool-style overlays. PathEditTool uses a different owner-side
//     visibility rule and does not call this helper.
//   getRootBoundaryCurves(v, f) — builds the boundary outline from
//     getEdgeCurve(explicitA, explicitB), skipping all derived vertices.
//
// Transitive root resolution:
//   A derived vertex may reference another derived edge such as
//   v9.positionSource.edgeVerts = [4, 1] (derived→explicit), where v4 is itself
//   derived on [0, 1]. Root-segment helpers must resolve that chain transitively
//   to the ultimate anchor pair so evalEdge / displayed handles / hit testing
//   still use the anchor-owned cubic instead of the stored derived handles.
//
// (Prototype references: getHandle L335-339, getDisplayedHandle L341-360,
//  evalEdge L362-375, vertex drag L2639-2661, applySplitHandles L458-471.)
//
// -----------------------------------------------------------------------------
// Spec — position constraints
// -----------------------------------------------------------------------------
// * A vertex with `positionSource` is derived from a parent edge.
//   Spec A tools keep it on the owning root cubic by updating `positionSource.t`
//   (see above). Derived vertices remain constrained until the user explicitly
//   promotes them by clearing `positionSource` / `meshSource` (for example via
//   explicit color assignment in MeshGradient UI).
// * `meshSource` is the topology-fixed analogue of `positionSource` (non-
//   movable reference for BCP inversion math on root segments).
// * Vertices without `positionSource` are placed at their stored (x, y).
//
// -----------------------------------------------------------------------------
// Spec — topology operations
// -----------------------------------------------------------------------------
// * `subdivideFace(f, u, v)` — cross-cut a quad face at (u, v) into 4
//   sub-quads. The clicked center becomes an *explicit* vertex seeded with
//   the Coons color at (u, v); the 4 new edge-intersection vertices become
//   *derived* (edge colorSource + positionSource) and share a `splitLineId`.
//   Adjacent faces that share a cut edge are also subdivided so the mesh
//   stays T-junction-free.
// * `deleteMeshVertex(idx)` — remove a vertex, drop faces that reference it,
//   rewire `splitLineId`-paired vertices so 4-corner topology is restored,
//   and remap all remaining indices.
// * `syncDerivedVertices(vertices, faces)` — re-evaluate x/y and color for
//   every vertex whose `colorMode === "derived"`, using colorSource /
//   positionSource as the source of truth.
//
// -----------------------------------------------------------------------------
// Glossary (project-specific terms)
// -----------------------------------------------------------------------------
// * BCP            Bézier Control Point — the cubic handle stored on a vertex,
//                  keyed by the neighbor vertex index.
// * Derived vertex A subdivision-introduced vertex whose position and/or
//                  color are recomputed from a colorSource / positionSource.
//                  On root segments, a derived vertex is a position marker on
//                  the anchor-to-anchor cubic; its BCPs do not affect the face
//                  shape. UI visibility of those BCPs depends on the caller
//                  (GradientTool vs PathEditTool).
// * Explicit       User-set (position or color); never re-derived. Only
//                  explicit / anchor-owned handles control root-segment shape.
// * Edge-derived   Derived vertex whose colorSource is `kind: "edge"`.
// * Quad-derived   Derived vertex whose colorSource is `kind: "quad"`.
// * Face           A mesh cell — either `quad` (4 verts CCW) or `tri` (3
//                  verts CCW). Only these shapes are valid here because the
//                  Coons patch math is defined for 3/4-sided closed regions.
// * Handle         Per-neighbor BCP stored on a vertex as
//                  `handles[neighborIdx]`. Edge (i, j) is the cubic
//                  (vi, vi.handles[j], vj.handles[i], vj).
//                  On root-segment edges, derived vertex handles are ignored —
//                  the anchor-owned cubic handles are used instead.
// * Boundary edge  A single edge incident to exactly one face. In code this is
//                  detected via `getBoundaryEdgeSet(faces)`.
// * Outer boundary The full closed loop formed by all boundary edges.
// * Boundary vertex
//                  A vertex incident to at least one boundary edge. This
//                  includes explicit corner vertices on the mesh outline and
//                  derived vertices inserted along the outer boundary.
// * Interior vertex
//                  A vertex incident only to non-boundary edges. Moving an
//                  interior explicit vertex must not implicitly turn adjacent
//                  interior derived vertices into outer-boundary markers.
// * Anchor vertex  A vertex that owns a root segment's shape. In practice this
//                  is an explicit vertex, or a boundary vertex when resolving an
//                  interior root segment from boundary → explicit interior.
// * Root boundary edge
//                  The explicit-to-explicit parent interval on the outer
//                  boundary that owns the actual boundary shape. Subdivision may
//                  insert derived vertices along it, but those vertices do not
//                  create new shape owners.
// * Root segment   The anchor-to-anchor parent interval that owns an effective
//                  cubic used for edge evaluation, CP display, and hit testing.
//                  A root boundary edge is the outer-boundary subset of this.
// * Root boundary  The outer boundary of the mesh viewed in terms of its
//                  explicit-owned root boundary edges rather than the subdivided
//                  boundary-edge chain.
// * Root cubic     The cubic Bézier from explicit vertex A to explicit vertex B:
//                  [A, A.handles[B], B.handles[A], B]. After subdivision,
//                  A.handles[B] and B.handles[A] are preserved (not deleted).
// * splitLineId    Shared identifier tying together the set of vertices
//                  introduced by a single subdivision operation — used so
//                  `deleteMeshVertex` can remove them as a group.
// =============================================================================

import type { MeshFace, Point } from "../../schema";
import { type Color, colorToRawRGBA, toRGBColor } from "../../schema";

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

interface MeshColorVertexLike extends MeshVertexLike {
	color: Color;
	colorSource?:
		| { kind: "quad"; faceVerts: number[]; u: number; v: number }
		| { kind: "edge"; edgeVerts: number[]; t: number };
}

export type CubicCurve = [Point, Point, Point, Point];

const EDGE_PARAM_EPSILON = 1e-6;
const VERTEX_POSITION_EPSILON = 1e-6;

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

export function cubicBez(
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	t: number,
): Point {
	const mt = 1 - t;
	const mt2 = mt * mt;
	const t2 = t * t;
	return {
		x:
			mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x,
		y:
			mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y,
	};
}

function lerpPoint(a: Point, b: Point, t: number): Point {
	return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function splitCurve(
	curve: CubicCurve,
	t: number,
): { left: CubicCurve; right: CubicCurve } {
	const p01 = lerpPoint(curve[0], curve[1], t);
	const p12 = lerpPoint(curve[1], curve[2], t);
	const p23 = lerpPoint(curve[2], curve[3], t);
	const p012 = lerpPoint(p01, p12, t);
	const p123 = lerpPoint(p12, p23, t);
	const p = lerpPoint(p012, p123, t);
	return {
		left: [curve[0], p01, p012, p],
		right: [p, p123, p23, curve[3]],
	};
}

function reverseCurve(curve: CubicCurve): CubicCurve {
	return [curve[3], curve[2], curve[1], curve[0]];
}

export function getCurveInterval(
	curve: CubicCurve,
	t0: number,
	t1: number,
): CubicCurve {
	if (Math.abs(t1 - t0) < 1e-8) {
		const p = cubicBez(curve[0], curve[1], curve[2], curve[3], t0);
		return [p, p, p, p];
	}
	if (t0 > t1) return reverseCurve(getCurveInterval(curve, t1, t0));
	if (t0 <= 0 && t1 >= 1) return curve.map((p) => ({ ...p })) as CubicCurve;
	const { left } = splitCurve(curve, t1);
	if (t0 <= 0) return left;
	return splitCurve(left, t0 / t1).right;
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

function getEdgeCurve(
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
	return cubicBez(curve[0], curve[1], curve[2], curve[3], t);
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

function rayCrossBezier(px: number, py: number, curve: CubicCurve): number {
	const STEPS = 32;
	let crossings = 0;
	let prevX = curve[0].x;
	let prevY = curve[0].y;
	for (let k = 1; k <= STEPS; k++) {
		const t = k / STEPS;
		const p = cubicBez(curve[0], curve[1], curve[2], curve[3], t);
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
		const p = cubicBez(curve[0], curve[1], curve[2], curve[3], t);
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
			const p = cubicBez(curve[0], curve[1], curve[2], curve[3], t);
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

/**
 * Quad Coons patch position at (u, v).
 * Quad verts order: [i00, i10, i11, i01] (CCW).
 */
function coonsPositionQuad(
	vertices: readonly MeshVertexLike[],
	quad: readonly number[],
	u: number,
	v: number,
): Point {
	const [i00, i10, i11, i01] = quad;
	const curveBetween = (i: number, j: number): CubicCurve => [
		{ x: vertices[i].x, y: vertices[i].y },
		getBaseHandle(vertices, i, j),
		getBaseHandle(vertices, j, i),
		{ x: vertices[j].x, y: vertices[j].y },
	];
	return coonsPatchPoint(
		curveBetween(i00, i10),
		curveBetween(i01, i11),
		curveBetween(i00, i01),
		curveBetween(i10, i11),
		u,
		v,
	);
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
	const c0 = cubicBez(bottom[0], bottom[1], bottom[2], bottom[3], u);
	const c1 = cubicBez(top[0], top[1], top[2], top[3], u);
	const d0 = cubicBez(left[0], left[1], left[2], left[3], v);
	const d1 = cubicBez(right[0], right[1], right[2], right[3], v);
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

// =============================================================================
// Topology ops ported from `pkgs/web/src/app/proto/mesh-gradient/page.tsx`.
// =============================================================================

/** Index of the edge (startVert → endVert) in `faceVerts`, or null if absent. */
function findFaceEdgeIdx(
	faceVerts: readonly number[],
	i: number,
	j: number,
): number | null {
	for (let edgeIdx = 0; edgeIdx < faceVerts.length; edgeIdx++) {
		const a = faceVerts[edgeIdx];
		const b = faceVerts[(edgeIdx + 1) % faceVerts.length];
		if ((a === i && b === j) || (a === j && b === i)) return edgeIdx;
	}
	return null;
}

/** Opposite edge in a quad. */
function oppositeEdgeIdx(edgeIdx: number): number {
	return (edgeIdx + 2) % 4;
}

/** Quad edges: 0/2 run along u, 1/3 along v. */
function edgeLogicalAxis(edgeIdx: number): "u" | "v" {
	return edgeIdx % 2 === 0 ? "u" : "v";
}

/** Logical (u or v) value → parameter t along the edge that the quad edge traces. */
function logicalValueToEdgeT(edgeIdx: number, value: number): number {
	return edgeIdx === 0 || edgeIdx === 1 ? value : 1 - value;
}

function getCanonicalEdgeVertexKey(i: number, j: number, t: number): string {
	const normalizedT = i <= j ? t : 1 - t;
	return `${Math.min(i, j)},${Math.max(i, j)},${Math.round(normalizedT * 1e9)}`;
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
function getBoundaryVertexLoop(faces: readonly MeshFace[]): number[] | null {
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

// -----------------------------------------------------------------------------
// sRGB ↔ OKLab (Björn Ottosson) — for perceptual color interpolation.
// -----------------------------------------------------------------------------

function srgbChannelToLinear(v: number): number {
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgbChannel(v: number): number {
	return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

function srgbToOklab(
	r: number,
	g: number,
	b: number,
): [number, number, number] {
	const lr = srgbChannelToLinear(r);
	const lg = srgbChannelToLinear(g);
	const lb = srgbChannelToLinear(b);
	const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
	const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
	const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
	const l_ = Math.cbrt(l);
	const m_ = Math.cbrt(m);
	const s_ = Math.cbrt(s);
	return [
		0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
		1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
		0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
	];
}

function oklabToSrgb(
	L: number,
	A: number,
	B: number,
): [number, number, number] {
	const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
	const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
	const s_ = L - 0.0894841775 * A - 1.291485548 * B;
	const l = l_ * l_ * l_;
	const m = m_ * m_ * m_;
	const s = s_ * s_ * s_;
	const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
	const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
	const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
	return [
		Math.max(0, Math.min(1, linearToSrgbChannel(lr))),
		Math.max(0, Math.min(1, linearToSrgbChannel(lg))),
		Math.max(0, Math.min(1, linearToSrgbChannel(lb))),
	];
}

function colorToRGB(c: Color): { r: number; g: number; b: number; a: number } {
	return colorToRawRGBA(c);
}

/** Perceptual bilinear interpolation of four corner colors in OKLab. */
function bilinearColorOklab(
	c00: Color,
	c10: Color,
	c11: Color,
	c01: Color,
	u: number,
	v: number,
): Color {
	const r00 = colorToRGB(c00);
	const r10 = colorToRGB(c10);
	const r11 = colorToRGB(c11);
	const r01 = colorToRGB(c01);
	const lab00 = srgbToOklab(r00.r, r00.g, r00.b);
	const lab10 = srgbToOklab(r10.r, r10.g, r10.b);
	const lab11 = srgbToOklab(r11.r, r11.g, r11.b);
	const lab01 = srgbToOklab(r01.r, r01.g, r01.b);
	const mu = 1 - u;
	const mv = 1 - v;
	const L =
		mu * mv * lab00[0] +
		u * mv * lab10[0] +
		u * v * lab11[0] +
		mu * v * lab01[0];
	const A =
		mu * mv * lab00[1] +
		u * mv * lab10[1] +
		u * v * lab11[1] +
		mu * v * lab01[1];
	const B =
		mu * mv * lab00[2] +
		u * mv * lab10[2] +
		u * v * lab11[2] +
		mu * v * lab01[2];
	const [r, g, b] = oklabToSrgb(L, A, B);
	const a = mu * mv * r00.a + u * mv * r10.a + u * v * r11.a + mu * v * r01.a;
	return toRGBColor({ r, g, b, a });
}

/** Perceptual 1D interpolation of two endpoint colors in OKLab at parameter t. */
function lerpColorOklab(a: Color, b: Color, t: number): Color {
	const ra = colorToRGB(a);
	const rb = colorToRGB(b);
	const la = srgbToOklab(ra.r, ra.g, ra.b);
	const lb = srgbToOklab(rb.r, rb.g, rb.b);
	const mt = 1 - t;
	const [r, g, b2] = oklabToSrgb(
		mt * la[0] + t * lb[0],
		mt * la[1] + t * lb[1],
		mt * la[2] + t * lb[2],
	);
	return toRGBColor({ r, g, b: b2, a: mt * ra.a + t * rb.a });
}

/** Coons-patch corner color at (u, v) for a quad. */
export function colorFromFaceCorners(
	vertices: readonly MeshColorVertexLike[],
	faceVerts: readonly number[],
	u: number,
	v: number,
): Color {
	const [i00, i10, i11, i01] = faceVerts;
	return bilinearColorOklab(
		vertices[i00].color,
		vertices[i10].color,
		vertices[i11].color,
		vertices[i01].color,
		u,
		v,
	);
}

/** Edge color at parameter t. */
function colorFromEdge(
	vertices: readonly MeshColorVertexLike[],
	edgeVerts: readonly number[],
	t: number,
): Color {
	return lerpColorOklab(
		vertices[edgeVerts[0]].color,
		vertices[edgeVerts[1]].color,
		t,
	);
}

// -----------------------------------------------------------------------------
// Derived vertex factories
// -----------------------------------------------------------------------------

/** Creates a position-only derived vertex on the interior of a quad face. */
export function createQuadDerivedGeometryVertex<V extends MeshVertexLike>(
	position: Point,
	factory: (fields: {
		x: number;
		y: number;
		handles: Record<number, Point>;
	}) => V,
): V {
	return factory({ x: position.x, y: position.y, handles: {} });
}

/** Creates a position-only derived vertex on an edge, with positionSource recorded. */
export function createEdgeDerivedGeometryVertex<V extends MeshVertexLike>(
	position: Point,
	edgeVerts: readonly number[],
	t: number,
	factory: (fields: {
		x: number;
		y: number;
		handles: Record<number, Point>;
		positionSource: { edgeVerts: number[]; t: number };
		meshSource: { edgeVerts: number[]; t: number };
	}) => V,
): V {
	return factory({
		x: position.x,
		y: position.y,
		handles: {},
		positionSource: { edgeVerts: [...edgeVerts], t },
		meshSource: { edgeVerts: [...edgeVerts], t },
	});
}

/** Creates a color+position derived vertex on the interior of a quad. */
export function createQuadDerivedColorVertex<V extends MeshColorVertexLike>(
	vertices: readonly MeshColorVertexLike[],
	position: Point,
	faceVerts: readonly number[],
	u: number,
	v: number,
	factory: (fields: {
		x: number;
		y: number;
		color: Color;
		colorMode: "derived";
		colorSource: { kind: "quad"; faceVerts: number[]; u: number; v: number };
		handles: Record<number, Point>;
	}) => V,
): V {
	return factory({
		x: position.x,
		y: position.y,
		color: colorFromFaceCorners(vertices, faceVerts, u, v),
		colorMode: "derived",
		colorSource: { kind: "quad", faceVerts: [...faceVerts], u, v },
		handles: {},
	});
}

/** Creates a color+position derived vertex on an edge. */
export function createEdgeDerivedColorVertex<V extends MeshColorVertexLike>(
	vertices: readonly MeshColorVertexLike[],
	position: Point,
	edgeVerts: readonly number[],
	t: number,
	factory: (fields: {
		x: number;
		y: number;
		color: Color;
		colorMode: "derived";
		colorSource: { kind: "edge"; edgeVerts: number[]; t: number };
		positionSource: { edgeVerts: number[]; t: number };
		meshSource: { edgeVerts: number[]; t: number };
		handles: Record<number, Point>;
	}) => V,
): V {
	return factory({
		x: position.x,
		y: position.y,
		color: colorFromEdge(vertices, edgeVerts, t),
		colorMode: "derived",
		colorSource: { kind: "edge", edgeVerts: [...edgeVerts], t },
		positionSource: { edgeVerts: [...edgeVerts], t },
		meshSource: { edgeVerts: [...edgeVerts], t },
		handles: {},
	});
}

// -----------------------------------------------------------------------------
// Insert edge-mid vertex on the undirected edge (i, j) at parameter t.
//
// `applySplitHandles` adjusts the two adjacent handles of the parent edge so
// that the edge curve is preserved after insertion (de Casteljau split).
// -----------------------------------------------------------------------------

function deCasteljauSplit(
	curve: CubicCurve,
	t: number,
): { left: CubicCurve; right: CubicCurve; point: Point } {
	const [p0, p1, p2, p3] = curve;
	const q0 = { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
	const q1 = { x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t };
	const q2 = { x: p2.x + (p3.x - p2.x) * t, y: p2.y + (p3.y - p2.y) * t };
	const r0 = { x: q0.x + (q1.x - q0.x) * t, y: q0.y + (q1.y - q0.y) * t };
	const r1 = { x: q1.x + (q2.x - q1.x) * t, y: q1.y + (q2.y - q1.y) * t };
	const point = { x: r0.x + (r1.x - r0.x) * t, y: r0.y + (r1.y - r0.y) * t };
	return {
		left: [p0, q0, r0, point],
		right: [point, r1, q2, p3],
		point,
	};
}

/**
 * Inserts a derived vertex at parameter `t` on the undirected edge between
 * vertex indices `i` and `j`. The parent edge's curve is preserved by
 * splitting via de Casteljau and writing the resulting control handles to:
 *   - vertices[i].handles[mid]    = left.cp1
 *   - vertices[mid].handles[i]    = left.cp2
 *   - vertices[mid].handles[j]    = right.cp1
 *   - vertices[j].handles[mid]    = right.cp2
 * Parent handles on `vertices[i].handles[j]` and `vertices[j].handles[i]`
 * are removed.
 *
 * Returns the index of the inserted vertex, or the existing vertex index
 * if a matching split vertex already sits on this edge.
 */
function insertEdgeMidVertex<V extends MeshVertexLike>(
	vertices: V[],
	i: number,
	j: number,
	t: number,
	makeMid: (position: Point) => V,
): number {
	const existing = findExistingSplitVertexOnEdge(vertices, i, j, t);
	if (existing !== null) return existing;

	const curve = getEdgeCurve(vertices, i, j);
	const { left, right, point } = deCasteljauSplit(curve, t);
	const mid = makeMid(point);
	const midIdx = vertices.push(mid) - 1;

	// Wire handles to preserve the curve shape. Root→root handles are
	// intentionally preserved (not deleted) so that getBoundarySubcurve can
	// read them via getEdgeCurve(rootStart, rootEnd). Matches prototype's
	// applySplitHandles (page.tsx L458-471).
	vertices[i].handles[midIdx] = { x: left[1].x, y: left[1].y };
	mid.handles[i] = { x: left[2].x, y: left[2].y };
	mid.handles[j] = { x: right[1].x, y: right[1].y };
	vertices[j].handles[midIdx] = { x: right[2].x, y: right[2].y };

	return midIdx;
}

function findExistingSplitVertexOnEdge(
	vertices: readonly MeshVertexLike[],
	i: number,
	j: number,
	t: number,
): number | null {
	const pi = vertices[i];
	const pj = vertices[j];
	for (let vi = 0; vi < vertices.length; vi++) {
		if (vi === i || vi === j) continue;
		const v = vertices[vi];
		if (!v.positionSource) continue;
		const ps = v.positionSource;
		const [a, b] = ps.edgeVerts;
		const forwardMatch =
			a === i && b === j && Math.abs(ps.t - t) < EDGE_PARAM_EPSILON;
		const reverseMatch =
			a === j && b === i && Math.abs(ps.t - (1 - t)) < EDGE_PARAM_EPSILON;
		if (!forwardMatch && !reverseMatch) continue;
		// Double-check with position too, in case the caller used different key ordering.
		const curve = getEdgeCurve([pi, pj] as unknown as MeshVertexLike[], 0, 1);
		const expected = cubicBez(curve[0], curve[1], curve[2], curve[3], t);
		if (
			Math.abs(v.x - expected.x) < VERTEX_POSITION_EPSILON &&
			Math.abs(v.y - expected.y) < VERTEX_POSITION_EPSILON
		) {
			return vi;
		}
	}
	return null;
}

// -----------------------------------------------------------------------------
// subdivideFace — face split with cross-face propagation.
//
// Matches the prototype (`subdivideFace` in `proto/mesh-gradient/page.tsx`).
// The click location becomes an **explicit** center vertex; every new
// vertex created as a side-effect (edge-cut mid-points, cross-face
// intersections) is **derived** with a shared `splitLineId`.
// -----------------------------------------------------------------------------

type FaceSplitPlan = {
	u?: { value: number; splitId: number };
	v?: { value: number; splitId: number };
};

interface SubdivideFaceOptions<V extends MeshVertexLike> {
	/** Factory for the explicit center vertex created at (u, v) in the source face. */
	makeCenterExplicit: (
		position: Point,
		faceVerts: readonly number[],
		u: number,
		v: number,
	) => V;
	/** Factory for a derived edge mid-point vertex on a parent edge. */
	makeEdgeDerived: (
		position: Point,
		edgeVerts: readonly number[],
		t: number,
	) => V;
	/** Factory for a derived cross-face intersection vertex inside a quad. */
	makeQuadDerived: (
		position: Point,
		faceVerts: readonly number[],
		u: number,
		v: number,
	) => V;
	/** Returns the next splitLineId; used to tag vertices created together. */
	nextSplitLineId: () => number;
	/**
	 * Axes to cut (default both). A single-axis cut inserts edge vertices only —
	 * no explicit center vertex — and `centerIdx` is the cut vertex on the edge
	 * the click coordinate pins (v ≈ 0/1 for a u-cut, u ≈ 0/1 for a v-cut).
	 */
	cutAxes?: { u?: boolean; v?: boolean };
}

/**
 * Split the quad face at (u, v). Propagates the cut to neighboring quad
 * faces across shared edges that have the matching logical axis. Returns
 * the mutated vertex / face arrays and the inserted center-vertex index.
 */
export function subdivideFace<V extends MeshVertexLike>(
	vertices: readonly V[],
	faces: readonly MeshFace[],
	faceIdx: number,
	clickU: number,
	clickV: number,
	opts: SubdivideFaceOptions<V>,
): { vertices: V[]; faces: MeshFace[]; centerIdx: number } | null {
	const face = faces[faceIdx];
	if (!face || face.type !== "quad") return null;

	const newVerts: V[] = vertices.map((v) => ({
		...v,
		handles: { ...v.handles },
	}));
	const sourceFaces: MeshFace[] = faces.map((f) => ({
		type: f.type,
		verts: [...f.verts],
	}));

	const cutU = opts.cutAxes ? (opts.cutAxes.u ?? false) : true;
	const cutV = opts.cutAxes ? (opts.cutAxes.v ?? false) : true;
	if (!cutU && !cutV) return null;

	const subdivisionId =
		vertices.reduce(
			(maxId, vertex) => Math.max(maxId, vertex.subdivisionId ?? 0),
			0,
		) + 1;
	const hSplitId = cutU ? opts.nextSplitLineId() : -1;
	const vSplitId = cutV ? opts.nextSplitLineId() : -1;
	const edgeVertexMap = new Map<string, number>();
	const splitPlans = new Map<number, FaceSplitPlan>();

	const setPlanValue = (
		targetFaceIdx: number,
		axis: "u" | "v",
		value: number,
		splitId: number,
	) => {
		const plan = splitPlans.get(targetFaceIdx) ?? {};
		const existing = plan[axis];
		if (existing && Math.abs(existing.value - value) >= EDGE_PARAM_EPSILON)
			return;
		plan[axis] = { value, splitId };
		splitPlans.set(targetFaceIdx, plan);
	};

	const findAdjacentFace = (
		edgeStart: number,
		edgeEnd: number,
		excludeFaceIdx: number,
	): { faceIdx: number; edgeIdx: number } | null => {
		for (let fi = 0; fi < sourceFaces.length; fi++) {
			if (fi === excludeFaceIdx) continue;
			const ei = findFaceEdgeIdx(sourceFaces[fi].verts, edgeStart, edgeEnd);
			if (ei !== null) return { faceIdx: fi, edgeIdx: ei };
		}
		return null;
	};

	const getOrInsertFaceCutVertex = (
		faceVerts: number[],
		edgeIdx: number,
		value: number,
		splitId: number,
	): number => {
		const startIdx = faceVerts[edgeIdx];
		const endIdx = faceVerts[(edgeIdx + 1) % 4];
		const t = logicalValueToEdgeT(edgeIdx, value);
		const key = getCanonicalEdgeVertexKey(startIdx, endIdx, t);
		const cached = edgeVertexMap.get(key);
		if (cached !== undefined) return cached;
		const pos = cubicBez(
			...(getEdgeCurve(newVerts, startIdx, endIdx) as [
				Point,
				Point,
				Point,
				Point,
			]),
			t,
		);
		const midIdx = insertEdgeMidVertex(newVerts, startIdx, endIdx, t, (p) => {
			const mid = opts.makeEdgeDerived(p, [startIdx, endIdx], t);
			mid.splitLineId = splitId;
			return mid;
		});
		edgeVertexMap.set(key, midIdx);
		// Position already computed — ensure numerical agreement.
		newVerts[midIdx].x = pos.x;
		newVerts[midIdx].y = pos.y;
		return midIdx;
	};

	const propagateCut = (
		startFaceIdx: number,
		exitEdgeIdx: number,
		axis: "u" | "v",
		value: number,
		splitId: number,
	) => {
		let currentFaceIdx = startFaceIdx;
		let currentEdgeIdx = exitEdgeIdx;
		const visited = new Set<number>([startFaceIdx]);
		while (true) {
			const cf = sourceFaces[currentFaceIdx];
			const es = cf.verts[currentEdgeIdx];
			const ee = cf.verts[(currentEdgeIdx + 1) % 4];
			const adj = findAdjacentFace(es, ee, currentFaceIdx);
			if (!adj) break;
			if (visited.has(adj.faceIdx)) break;
			const adjFace = sourceFaces[adj.faceIdx];
			if (adjFace.type !== "quad") break;
			if (edgeLogicalAxis(adj.edgeIdx) !== axis) break;
			setPlanValue(adj.faceIdx, axis, value, splitId);
			currentFaceIdx = adj.faceIdx;
			currentEdgeIdx = oppositeEdgeIdx(adj.edgeIdx);
			visited.add(currentFaceIdx);
		}
	};

	const findExistingVertexByPosition = (
		x: number,
		y: number,
	): number | null => {
		for (let vi = 0; vi < newVerts.length; vi++) {
			const p = newVerts[vi];
			if (
				Math.abs(p.x - x) < VERTEX_POSITION_EPSILON &&
				Math.abs(p.y - y) < VERTEX_POSITION_EPSILON
			)
				return vi;
		}
		return null;
	};

	const getOrCreateIntersectionVertex = (
		faceVerts: number[],
		u: number,
		v: number,
		splitId: number,
	): number => {
		const p = coonsPositionQuad(newVerts, faceVerts, u, v);
		const existing = findExistingVertexByPosition(p.x, p.y);
		if (existing !== null) return existing;
		const intersection = opts.makeQuadDerived(p, faceVerts, u, v);
		intersection.splitLineId = splitId;
		return newVerts.push(intersection) - 1;
	};

	// Plan cuts starting from the source face and propagate along each cut axis.
	if (cutU) {
		setPlanValue(faceIdx, "u", clickU, hSplitId);
		propagateCut(faceIdx, 0, "u", clickU, hSplitId);
		propagateCut(faceIdx, 2, "u", clickU, hSplitId);
	}
	if (cutV) {
		setPlanValue(faceIdx, "v", clickV, vSplitId);
		propagateCut(faceIdx, 1, "v", clickV, vSplitId);
		propagateCut(faceIdx, 3, "v", clickV, vSplitId);
	}

	// Pre-insert edge cuts so all rebuilt faces share vertex indices.
	for (const [plannedFaceIdx, plan] of splitPlans) {
		const pf = sourceFaces[plannedFaceIdx];
		if (pf.type !== "quad") continue;
		if (plan.u) {
			getOrInsertFaceCutVertex(pf.verts, 0, plan.u.value, plan.u.splitId);
			getOrInsertFaceCutVertex(pf.verts, 2, plan.u.value, plan.u.splitId);
		}
		if (plan.v) {
			getOrInsertFaceCutVertex(pf.verts, 1, plan.v.value, plan.v.splitId);
			getOrInsertFaceCutVertex(pf.verts, 3, plan.v.value, plan.v.splitId);
		}
	}

	let iCenter: number;
	if (cutU && cutV) {
		// Explicit center vertex for the source face (user's click location).
		const centerPos = coonsPositionQuad(newVerts, face.verts, clickU, clickV);
		const centerVert = opts.makeCenterExplicit(
			centerPos,
			face.verts,
			clickU,
			clickV,
		);
		centerVert.splitLineId = hSplitId;
		centerVert.subdivisionSource = {
			id: subdivisionId,
			vertexCount: vertices.length,
			faces: sourceFaces.map((sourceFace) => ({
				type: sourceFace.type,
				verts: [...sourceFace.verts],
			})),
		};
		iCenter = newVerts.push(centerVert) - 1;
	} else {
		// Single-axis cut: the "new vertex" is the (already inserted) cut vertex
		// on the source face edge the click pinned.
		const entryEdgeIdx = cutU ? (clickV < 0.5 ? 0 : 2) : clickU < 0.5 ? 3 : 1;
		iCenter = getOrInsertFaceCutVertex(
			face.verts,
			entryEdgeIdx,
			cutU ? clickU : clickV,
			cutU ? hSplitId : vSplitId,
		);
	}

	// Rebuild faces.
	const nextFaces: MeshFace[] = [];
	for (let fi = 0; fi < sourceFaces.length; fi++) {
		const cf = sourceFaces[fi];
		if (cf.type !== "quad") {
			nextFaces.push(cf);
			continue;
		}
		const plan = splitPlans.get(fi);
		if (!plan) {
			nextFaces.push(cf);
			continue;
		}
		const [qA, qB, qC, qD] = cf.verts;
		if (plan.u && plan.v) {
			const m0 = getOrInsertFaceCutVertex(
				cf.verts,
				0,
				plan.u.value,
				plan.u.splitId,
			);
			const m1 = getOrInsertFaceCutVertex(
				cf.verts,
				1,
				plan.v.value,
				plan.v.splitId,
			);
			const m2 = getOrInsertFaceCutVertex(
				cf.verts,
				2,
				plan.u.value,
				plan.u.splitId,
			);
			const m3 = getOrInsertFaceCutVertex(
				cf.verts,
				3,
				plan.v.value,
				plan.v.splitId,
			);
			const center =
				fi === faceIdx
					? iCenter
					: getOrCreateIntersectionVertex(
							cf.verts,
							plan.u.value,
							plan.v.value,
							plan.u.splitId,
						);
			nextFaces.push(
				{ type: "quad", verts: [qA, m0, center, m3] },
				{ type: "quad", verts: [m0, qB, m1, center] },
				{ type: "quad", verts: [center, m1, qC, m2] },
				{ type: "quad", verts: [m3, center, m2, qD] },
			);
			continue;
		}
		if (plan.u) {
			const m0 = getOrInsertFaceCutVertex(
				cf.verts,
				0,
				plan.u.value,
				plan.u.splitId,
			);
			const m2 = getOrInsertFaceCutVertex(
				cf.verts,
				2,
				plan.u.value,
				plan.u.splitId,
			);
			nextFaces.push(
				{ type: "quad", verts: [qA, m0, m2, qD] },
				{ type: "quad", verts: [m0, qB, qC, m2] },
			);
			continue;
		}
		if (plan.v) {
			const m1 = getOrInsertFaceCutVertex(
				cf.verts,
				1,
				plan.v.value,
				plan.v.splitId,
			);
			const m3 = getOrInsertFaceCutVertex(
				cf.verts,
				3,
				plan.v.value,
				plan.v.splitId,
			);
			nextFaces.push(
				{ type: "quad", verts: [qA, qB, m1, m3] },
				{ type: "quad", verts: [m3, m1, qC, qD] },
			);
			continue;
		}
		nextFaces.push(cf);
	}

	for (let vi = vertices.length; vi < newVerts.length; vi++) {
		newVerts[vi].subdivisionId = subdivisionId;
	}

	return { vertices: newVerts, faces: nextFaces, centerIdx: iCenter };
}

// -----------------------------------------------------------------------------
// deleteMeshVertex — remove a vertex (and its split siblings) and
// reconstruct parent quad faces when possible.
// -----------------------------------------------------------------------------

/**
 * Removes the vertex at `removeIdx` together with any other vertex sharing
 * its `splitLineId`. Faces referencing the removed vertex set are grouped by
 * connectivity (through removed vertices) and each group is replaced with a
 * reconstructed quad if exactly four non-removed corner vertices remain.
 * Groups that cannot be reconstructed are preserved as-is.
 *
 * Corner vertices are identified as non-removed vertices appearing exactly
 * once across the faces in the group; they are sorted counter-clockwise
 * around their centroid before rebuilding the quad.
 *
 * Orphaned vertices (no longer referenced by any face) outside the first
 * four protected corners are dropped, and remaining indices are compacted.
 */
export function deleteMeshVertex<V extends MeshVertexLike>(
	vertices: readonly V[],
	faces: readonly MeshFace[],
	removeIdx: number,
	protectedCornerCount = 4,
): { vertices: V[]; faces: MeshFace[] } {
	if (removeIdx < protectedCornerCount) {
		return {
			vertices: vertices.map((v) => ({ ...v, handles: { ...v.handles } })),
			faces: faces.map((f) => ({ type: f.type, verts: [...f.verts] })),
		};
	}
	const targetVertex = vertices[removeIdx];
	if (
		targetVertex?.colorMode === "derived" ||
		(targetVertex?.subdivisionId !== undefined &&
			!targetVertex.subdivisionSource &&
			targetVertex.colorMode !== "explicit")
	) {
		// A derived vertex owns no geometry of its own — but one anchoring a
		// split line stands for the whole cut, so deleting it deletes the line
		// (its siblings share the splitLineId and go with it). Derived
		// by-products without a line of their own stay undeletable, and so
		// does a line that runs through an explicit vertex (delete that vertex
		// instead).
		const collapsed =
			targetVertex?.splitLineId !== undefined
				? collapseSplitLine(
						vertices,
						faces,
						targetVertex.splitLineId,
						protectedCornerCount,
					)
				: null;
		return (
			collapsed ?? {
				vertices: vertices.map((vertex) => ({
					...vertex,
					handles: { ...vertex.handles },
				})),
				faces: faces.map((face) => ({
					type: face.type,
					verts: [...face.verts],
				})),
			}
		);
	}
	const subdivisionSource = vertices[removeIdx]?.subdivisionSource;
	if (
		subdivisionSource &&
		vertices.filter((vertex) => vertex.subdivisionId !== subdivisionSource.id)
			.length === subdivisionSource.vertexCount &&
		!vertices.some(
			(vertex) => (vertex.subdivisionId ?? 0) > subdivisionSource.id,
		)
	) {
		return restoreMeshSubdivision(vertices, subdivisionSource);
	}
	const collapsedGrid = collapseMeshGridAtVertex(
		vertices,
		faces,
		removeIdx,
		protectedCornerCount,
	);
	if (collapsedGrid) return collapsedGrid;

	const vertsToRemove = collectImplicitArms(vertices, faces, removeIdx);

	const workVerts: V[] = vertices.map((v) => ({
		...v,
		handles: { ...v.handles },
	}));
	const workFaces: MeshFace[] = faces.map((f) => ({
		type: f.type,
		verts: [...f.verts],
	}));

	const affectedFaceIndices = new Set<number>();
	for (let fi = 0; fi < workFaces.length; fi++) {
		if (workFaces[fi].verts.some((vi) => vertsToRemove.has(vi))) {
			affectedFaceIndices.add(fi);
		}
	}

	const processedFaces = new Set<number>();
	const newFaces: MeshFace[] = [];

	for (const fi of affectedFaceIndices) {
		if (processedFaces.has(fi)) continue;
		const group = new Set<number>();
		const queue = [fi];
		while (queue.length > 0) {
			const cur = queue.pop()!;
			if (group.has(cur)) continue;
			group.add(cur);
			processedFaces.add(cur);
			const curVerts = workFaces[cur].verts;
			for (const ofi of affectedFaceIndices) {
				if (group.has(ofi)) continue;
				if (
					workFaces[ofi].verts.some(
						(vi) => vertsToRemove.has(vi) && curVerts.includes(vi),
					)
				) {
					queue.push(ofi);
				}
			}
		}

		const boundary = getBoundaryVertexLoop(
			[...group].map((gfi) => workFaces[gfi]),
		)?.filter((vi) => !vertsToRemove.has(vi));
		if (!boundary || boundary.length < 3) {
			// Cannot reconstruct — revert this group.
			for (const gfi of group) processedFaces.delete(gfi);
			continue;
		}

		const rewiredBoundary = orientMeshFaceCounterClockwise(boundary, workVerts);
		if (rewiredBoundary.length === 4) {
			newFaces.push({ type: "quad", verts: rewiredBoundary });
		} else {
			for (let i = 1; i < rewiredBoundary.length - 1; i++) {
				newFaces.push({
					type: "tri",
					verts: [
						rewiredBoundary[0],
						rewiredBoundary[i],
						rewiredBoundary[i + 1],
					],
				});
			}
		}
	}

	// Remove affected faces (processed ones only — unprocessed groups stay).
	const sortedAffected = [...processedFaces].sort((a, b) => b - a);
	for (const fi of sortedAffected) workFaces.splice(fi, 1);
	for (const nf of newFaces) workFaces.push(nf);

	return compactMeshAfterDeletion(workVerts, workFaces, protectedCornerCount);
}

/**
 * Remove one whole split line — every vertex sharing `splitLineId` — and
 * merge the faces it separated, so deleting any vertex of an inserted cut
 * removes the cut. Returns null (leave the mesh alone) when the line runs
 * through an explicit vertex, is not a single connected chain, or its faces
 * cannot be merged back cleanly.
 */
function collapseSplitLine<V extends MeshVertexLike>(
	vertices: readonly V[],
	faces: readonly MeshFace[],
	splitLineId: number,
	protectedCornerCount: number,
): { vertices: V[]; faces: MeshFace[] } | null {
	if (!faces.every((face) => face.type === "quad")) return null;
	const members = new Set<number>();
	for (let vi = 0; vi < vertices.length; vi++) {
		if (vertices[vi].splitLineId === splitLineId) members.add(vi);
	}
	if (members.size < 2) return null;
	for (const vi of members) {
		if (isExplicitMeshVertex(vertices[vi])) return null;
	}

	// Order the members into the chain the line traces. An end has exactly
	// one member neighbor; a broken chain (a promoted vertex left the set)
	// never collects every member and is refused.
	const memberNeighbors = (vi: number): number[] =>
		[...getVertexNeighbors(faces, vi)].filter((ni) => members.has(ni));
	const start =
		[...members].find((vi) => memberNeighbors(vi).length === 1) ?? null;
	if (start === null) return null;
	const line: number[] = [start];
	const visited = new Set<number>([start]);
	for (
		let next = memberNeighbors(start).find((ni) => !visited.has(ni));
		next !== undefined;
		next = memberNeighbors(next).find((ni) => !visited.has(ni))
	) {
		line.push(next);
		visited.add(next);
	}
	if (line.length !== members.size) return null;

	// An inserted cut always runs boundary to boundary. A chain that stops
	// short (a promoted vertex left the set) would leave a hanging node if
	// half-collapsed, so it is refused whole.
	const boundary = new Set(getBoundaryVertexLoop(faces) ?? []);
	if (!boundary.has(line[0]) || !boundary.has(line[line.length - 1])) {
		return null;
	}

	const nextFaces = collapseMeshGridLine(vertices, faces, line);
	if (!nextFaces) return null;

	return compactMeshAfterDeletion(
		vertices.map((vertex) => ({
			...vertex,
			handles: { ...vertex.handles },
		})),
		nextFaces,
		protectedCornerCount,
	);
}

function collapseMeshGridAtVertex<V extends MeshVertexLike>(
	vertices: readonly V[],
	faces: readonly MeshFace[],
	removeIdx: number,
	protectedCornerCount: number,
): { vertices: V[]; faces: MeshFace[] } | null {
	if (!faces.every((face) => face.type === "quad")) return null;
	const neighbors = [...getVertexNeighbors(faces, removeIdx)];
	if (neighbors.length !== 4) return null;

	const oppositePairs = new Map<string, [number, number]>();
	for (const neighbor of neighbors) {
		const opposite = getOppositeMeshNeighbor(faces, removeIdx, neighbor);
		if (opposite === null || !neighbors.includes(opposite)) return null;
		const pair: [number, number] =
			neighbor < opposite ? [neighbor, opposite] : [opposite, neighbor];
		oppositePairs.set(`${pair[0]}:${pair[1]}`, pair);
	}
	if (oppositePairs.size !== 2) return null;

	const lines = [...oppositePairs.values()].map(([first, second]) => {
		const firstArm = traceMeshLineArm(vertices, faces, removeIdx, first);
		const secondArm = traceMeshLineArm(vertices, faces, removeIdx, second);
		return [...firstArm.toReversed(), ...secondArm.slice(1)];
	});
	if (
		lines.some((line) =>
			line.some(
				(vi) => vi !== removeIdx && vertices[vi]?.colorMode === "explicit",
			),
		)
	) {
		return null;
	}

	let nextFaces = faces.map((face) => ({
		type: face.type,
		verts: [...face.verts],
	}));
	const removedVertices = new Set<number>();
	for (const line of lines) {
		const activeLine = line.filter((vi) => !removedVertices.has(vi));
		const collapsed = collapseMeshGridLine(vertices, nextFaces, activeLine);
		if (!collapsed) return null;
		nextFaces = collapsed;
		for (const vi of activeLine) removedVertices.add(vi);
	}

	return compactMeshAfterDeletion(
		vertices.map((vertex) => ({
			...vertex,
			handles: { ...vertex.handles },
		})),
		nextFaces,
		protectedCornerCount,
	);
}
function traceMeshLineArm<V extends MeshVertexLike>(
	vertices: readonly V[],
	faces: readonly MeshFace[],
	originIdx: number,
	startIdx: number,
): number[] {
	const path = [originIdx, startIdx];
	let previousIdx = originIdx;
	let currentIdx = startIdx;
	while (vertices[currentIdx]?.colorMode !== "explicit") {
		const nextIdx = getOppositeMeshNeighbor(faces, currentIdx, previousIdx);
		if (nextIdx === null || path.includes(nextIdx)) break;
		path.push(nextIdx);
		previousIdx = currentIdx;
		currentIdx = nextIdx;
	}
	return path;
}

function getOppositeMeshNeighbor(
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

function collapseMeshGridLine<V extends MeshVertexLike>(
	vertices: readonly V[],
	faces: readonly MeshFace[],
	line: readonly number[],
): MeshFace[] | null {
	if (line.length < 2) return null;
	const lineVertices = new Set(line);
	const processedFaces = new Set<number>();
	const mergedFaces: MeshFace[] = [];
	for (let lineIndex = 0; lineIndex < line.length - 1; lineIndex++) {
		const a = line[lineIndex];
		const b = line[lineIndex + 1];
		const adjacentFaces = faces.flatMap((face, faceIndex) =>
			meshFaceHasEdge(face, a, b) ? [faceIndex] : [],
		);
		if (
			adjacentFaces.length !== 2 ||
			adjacentFaces.some((faceIndex) => processedFaces.has(faceIndex))
		) {
			return null;
		}
		const boundary = getBoundaryVertexLoop(
			adjacentFaces.map((faceIndex) => faces[faceIndex]),
		)?.filter((vi) => !lineVertices.has(vi));
		if (!boundary || boundary.length !== 4) return null;
		mergedFaces.push({
			type: "quad",
			verts: orientMeshFaceCounterClockwise(boundary, vertices),
		});
		for (const faceIndex of adjacentFaces) processedFaces.add(faceIndex);
	}

	return [
		...faces.filter((_, faceIndex) => !processedFaces.has(faceIndex)),
		...mergedFaces,
	];
}

function meshFaceHasEdge(face: MeshFace, a: number, b: number): boolean {
	return face.verts.some(
		(vi, index) =>
			(vi === a && face.verts[(index + 1) % face.verts.length] === b) ||
			(vi === b && face.verts[(index + 1) % face.verts.length] === a),
	);
}

function compactMeshAfterDeletion<V extends MeshVertexLike>(
	vertices: V[],
	faces: MeshFace[],
	protectedCornerCount: number,
): { vertices: V[]; faces: MeshFace[] } {
	const usedVerts = new Set(faces.flatMap((face) => face.verts));
	const indexMap = new Map<number, number>();
	const compactedVerts: V[] = [];
	for (let vi = 0; vi < vertices.length; vi++) {
		if (vi >= protectedCornerCount && !usedVerts.has(vi)) continue;
		indexMap.set(vi, compactedVerts.length);
		compactedVerts.push(vertices[vi]);
	}
	for (const face of faces) {
		face.verts = face.verts.map((vi) => indexMap.get(vi) ?? vi);
	}
	for (const vertex of compactedVerts) remapMeshVertexIndices(vertex, indexMap);
	return { vertices: compactedVerts, faces };
}

function restoreMeshSubdivision<V extends MeshVertexLike>(
	vertices: readonly V[],
	source: NonNullable<MeshVertexLike["subdivisionSource"]>,
): { vertices: V[]; faces: MeshFace[] } {
	const indexMap = new Map<number, number>();
	const restoredVertices: V[] = [];
	for (let vi = 0; vi < vertices.length; vi++) {
		if (vertices[vi].subdivisionId === source.id) continue;
		indexMap.set(vi, restoredVertices.length);
		restoredVertices.push({
			...vertices[vi],
			handles: { ...vertices[vi].handles },
		});
	}
	const restoredFaces = source.faces.map((face) => ({
		type: face.type,
		verts: face.verts.map((vi) => indexMap.get(vi) ?? vi),
	}));
	for (const vertex of restoredVertices) {
		remapMeshVertexIndices(vertex, indexMap);
	}
	return { vertices: restoredVertices, faces: restoredFaces };
}

function collectImplicitArms<V extends MeshVertexLike>(
	vertices: readonly V[],
	faces: readonly MeshFace[],
	removeIdx: number,
): Set<number> {
	const result = new Set<number>([removeIdx]);
	const origin = vertices[removeIdx];
	if (!origin) return result;

	for (const startIdx of getVertexNeighbors(faces, removeIdx)) {
		const start = vertices[startIdx];
		if (start?.colorMode !== "derived") continue;

		const direction = { x: start.x - origin.x, y: start.y - origin.y };
		const splitLineId = start.splitLineId;
		let previousIdx = removeIdx;
		let currentIdx = startIdx;
		while (vertices[currentIdx]?.colorMode === "derived") {
			result.add(currentIdx);
			const current = vertices[currentIdx];
			const nextIdx = [...getVertexNeighbors(faces, currentIdx)]
				.filter((candidateIdx) => {
					if (candidateIdx === previousIdx || result.has(candidateIdx))
						return false;
					const candidate = vertices[candidateIdx];
					return (
						candidate?.colorMode === "explicit" ||
						splitLineId === undefined ||
						candidate?.splitLineId === splitLineId
					);
				})
				.map((candidateIdx) => ({
					candidateIdx,
					score: armDirectionScore(current, vertices[candidateIdx], direction),
				}))
				.filter(({ score }) => score > 0)
				.sort((a, b) => b.score - a.score)[0]?.candidateIdx;
			if (
				nextIdx === undefined ||
				vertices[nextIdx]?.colorMode === "explicit"
			) {
				break;
			}
			previousIdx = currentIdx;
			currentIdx = nextIdx;
		}
	}

	return result;
}

function armDirectionScore(
	from: MeshVertexLike,
	to: MeshVertexLike | undefined,
	direction: Point,
): number {
	if (!to) return Number.NEGATIVE_INFINITY;
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const length = Math.hypot(dx, dy);
	const directionLength = Math.hypot(direction.x, direction.y);
	if (length === 0 || directionLength === 0) return Number.NEGATIVE_INFINITY;
	return (dx * direction.x + dy * direction.y) / (length * directionLength);
}

function orientMeshFaceCounterClockwise<V extends MeshVertexLike>(
	indices: number[],
	vertices: readonly V[],
): number[] {
	return meshFaceSignedArea(indices, vertices) > 0
		? [...indices].reverse()
		: indices;
}

function meshFaceSignedArea<V extends MeshVertexLike>(
	indices: readonly number[],
	vertices: readonly V[],
): number {
	let signedArea = 0;
	for (let i = 0; i < indices.length; i++) {
		const current = vertices[indices[i]];
		const next = vertices[indices[(i + 1) % indices.length]];
		signedArea += current.x * next.y - next.x * current.y;
	}
	return signedArea;
}

function remapMeshVertexIndices<V extends MeshVertexLike>(
	vertex: V,
	indexMap: ReadonlyMap<number, number>,
): void {
	vertex.handles = Object.fromEntries(
		Object.entries(vertex.handles).flatMap(([key, value]) => {
			const mapped = indexMap.get(Number(key));
			return mapped === undefined ? [] : [[mapped, value]];
		}),
	);
	vertex.positionSource = remapMeshEdgeSource(vertex.positionSource, indexMap);
	vertex.meshSource = remapMeshEdgeSource(vertex.meshSource, indexMap);

	const colorVertex = vertex as V & MeshColorVertexLike;
	if (colorVertex.colorSource?.kind === "edge") {
		colorVertex.colorSource = remapMeshEdgeSource(
			colorVertex.colorSource,
			indexMap,
		);
	} else if (colorVertex.colorSource?.kind === "quad") {
		const faceVerts = remapMeshVertexIndexList(
			colorVertex.colorSource.faceVerts,
			indexMap,
		);
		colorVertex.colorSource = faceVerts
			? { ...colorVertex.colorSource, faceVerts }
			: undefined;
	}
	const subdivisionSource = vertex.subdivisionSource;
	if (subdivisionSource) {
		const sourceVertexIndices = Array.from(
			{ length: subdivisionSource.vertexCount },
			(_, index) => index,
		);
		if (sourceVertexIndices.some((index) => !indexMap.has(index))) {
			vertex.subdivisionSource = undefined;
		} else {
			vertex.subdivisionSource = {
				...subdivisionSource,
				faces: subdivisionSource.faces.map((face) => ({
					type: face.type,
					verts: face.verts.map((index) => {
						const mappedIndex = indexMap.get(index);
						if (mappedIndex === undefined) {
							throw new Error("Missing mesh subdivision vertex mapping");
						}
						return mappedIndex;
					}),
				})),
			};
		}
	}
}

function remapMeshEdgeSource<T extends { edgeVerts: number[]; t: number }>(
	source: T | undefined,
	indexMap: ReadonlyMap<number, number>,
): T | undefined {
	if (!source) return undefined;
	const edgeVerts = remapMeshVertexIndexList(source.edgeVerts, indexMap);
	return edgeVerts ? { ...source, edgeVerts } : undefined;
}

function remapMeshVertexIndexList(
	indices: readonly number[],
	indexMap: ReadonlyMap<number, number>,
): number[] | null {
	const remapped = indices.map((index) => indexMap.get(index));
	return remapped.some((index) => index === undefined)
		? null
		: (remapped as number[]);
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
 * Put a promoted gradient vertex back on the edge it was cut from: it follows
 * that edge again and takes its color from the edge instead of holding the
 * one the user assigned. Returns null when the vertex was not promoted or no
 * edge runs through it. Run `syncDerivedVertices` afterwards to settle the
 * position and color.
 */
export function demoteMeshColorVertexToDerived<V extends MeshColorVertexLike>(
	vertices: readonly V[],
	faces: readonly MeshFace[],
	vertexIndex: number,
): V[] | null {
	const target = vertices[vertexIndex];
	if (!target || !isPromotedMeshVertex(target)) return null;

	const owner = resolveMeshVertexOwningEdge(vertices, faces, vertexIndex);
	if (!owner) return null;
	const [edgeA, edgeB] = owner.edgeVerts;

	const next = vertices.map((vertex) => ({
		...vertex,
		handles: { ...vertex.handles },
	}));
	const curve = getEffectiveMeshEdgeCurve(next, faces, edgeA, edgeB);
	const t = findClosestCurveT(curve, target.x, target.y);
	const demoted = next[vertexIndex];
	demoted.colorMode = "derived";
	demoted.colorSource = { kind: "edge", edgeVerts: [edgeA, edgeB], t };
	demoted.positionSource = { edgeVerts: [edgeA, edgeB], t };
	demoted.meshSource = { edgeVerts: [edgeA, edgeB], t };
	// Rejoin the split line hanging off this vertex, so the line moves and
	// deletes as one again.
	demoted.splitLineId = [...getVertexNeighbors(faces, vertexIndex)]
		.filter((ni) => !owner.alongNeighbors.includes(ni))
		.map((ni) => next[ni].splitLineId)
		.find((id) => id !== undefined);
	// The along-edge handles were materialized when the vertex became
	// explicit; the root segment owns that stretch of curve again now.
	for (const neighbor of owner.alongNeighbors) delete demoted.handles[neighbor];
	return next;
}

/**
 * Whether the user placed this vertex, so that topology edits around it must
 * keep it. A gradient vertex says so with its color mode; a geometry cage
 * vertex carries no color at all and stays derived exactly while it is still
 * bound to the edge or face it was cut from.
 */
function isExplicitMeshVertex(vertex: MeshVertexLike | undefined): boolean {
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

// -----------------------------------------------------------------------------
// syncDerivedVertices — recompute derived vertices' positions (and colors,
// when the vertex carries a color field) from their sources.
// -----------------------------------------------------------------------------

/**
 * Updates every `derived`-mode vertex in place:
 *   - `colorSource.kind === "quad"`: position = Coons(faceVerts, u, v).
 *   - `colorSource.kind === "edge"` with `positionSource`: position =
 *     evalEdge(positionSource.edgeVerts, positionSource.t).
 *   - Color (if `MeshColorVertexLike`) is recomputed from the same source.
 * Geometry-only vertices (no `colorMode`, e.g. warp-cage vertices) are
 * position-synced from `positionSource` alone. Vertices lacking the required
 * source are left untouched.
 */
/**
 * Turn every derived vertex's cross-edge handles with its owning edge.
 *
 * A derived vertex sits on an edge; the split lines running away from it into
 * the patch start with its stored handles. Sliding or bending that edge only
 * moves the vertex, so those split lines kept their old direction and the
 * surface creased along them — bending one boundary handle visibly folded the
 * interior. Rotating them by how much the edge's tangent turned keeps each
 * split line attached to the edge frame instead.
 *
 * Call with the cage as it was before the edit and the cage after
 * `syncDerivedVertices` has repositioned everything.
 */
export function rotateDerivedCrossHandles<V extends MeshVertexLike>(
	before: readonly V[],
	after: V[],
	faces: readonly MeshFace[],
): void {
	for (let vi = 0; vi < after.length; vi++) {
		const source = after[vi].positionSource;
		const previous = before[vi];
		if (!source || !previous?.positionSource) continue;
		const [a, b] = source.edgeVerts;
		const [pa, pb] = previous.positionSource.edgeVerts;

		const oldAngle = edgeTangentAngle(
			before,
			faces,
			pa,
			pb,
			previous.positionSource.t,
		);
		const newAngle = edgeTangentAngle(after, faces, a, b, source.t);
		if (oldAngle == null || newAngle == null) continue;
		const delta = newAngle - oldAngle;
		if (Math.abs(delta) < 1e-9) continue;

		const cos = Math.cos(delta);
		const sin = Math.sin(delta);
		const vertex = after[vi];
		for (const [key, handle] of Object.entries(vertex.handles)) {
			// Handles along the owning edge are ignored by the effective-curve
			// lookup; only the ones leaving the edge describe a split line.
			if (isOnOwningEdge(after, faces, vi, Number(key), a, b)) continue;
			const dx = handle.x - vertex.x;
			const dy = handle.y - vertex.y;
			handle.x = vertex.x + dx * cos - dy * sin;
			handle.y = vertex.y + dx * sin + dy * cos;
		}
	}
}

/** Tangent direction (rad) of the effective edge curve at `t`, or null. */
function edgeTangentAngle(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
	i: number,
	j: number,
	t: number,
): number | null {
	if (!vertices[i] || !vertices[j]) return null;
	const curve = getEffectiveMeshEdgeCurve(vertices, faces, i, j);
	const h = 1e-3;
	const t0 = Math.max(0, Math.min(1 - h, t - h / 2));
	const a = cubicBez(curve[0], curve[1], curve[2], curve[3], t0);
	const b = cubicBez(curve[0], curve[1], curve[2], curve[3], t0 + h);
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	if (Math.hypot(dx, dy) < 1e-12) return null;
	return Math.atan2(dy, dx);
}

/** True when the edge (vi → neighbor) lies on the vertex's own root segment. */
function isOnOwningEdge(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
	vi: number,
	neighbor: number,
	rootStart: number,
	rootEnd: number,
): boolean {
	if (neighbor === rootStart || neighbor === rootEnd) return true;
	const info = getRootSegmentInfo(vertices, faces, vi, neighbor);
	if (!info) return false;
	const [a, b] = info.rootEdge;
	return (
		(a === rootStart && b === rootEnd) || (a === rootEnd && b === rootStart)
	);
}

export function syncDerivedVertices<V extends MeshVertexLike>(
	vertices: V[],
	faces: readonly MeshFace[],
): void {
	// Handles ride along with the recomputed position: the along-edge handles
	// of a derived vertex are ignored by getEffectiveMeshEdgeCurve, but its
	// cross-edge (split line) handles must follow so those curves keep shape.
	const moveDerived = (v: MeshVertexLike, p: Point) => {
		const dx = p.x - v.x;
		const dy = p.y - v.y;
		if (dx === 0 && dy === 0) return;
		v.x = p.x;
		v.y = p.y;
		for (const h of Object.values(v.handles)) {
			h.x += dx;
			h.y += dy;
		}
	};

	for (const v of vertices) {
		if (v.colorMode == null) {
			// Geometry-only mesh (warp cage): a positionSource alone marks the
			// vertex as derived, so it must keep tracking its owning edge.
			if (v.positionSource) {
				const [a, b] = v.positionSource.edgeVerts;
				moveDerived(v, evalEdge(vertices, faces, a, b, v.positionSource.t));
			}
			continue;
		}
		if (v.colorMode !== "derived") continue;
		const hasColor = "color" in v;
		const vc = v as unknown as MeshColorVertexLike;

		if (vc.colorSource?.kind === "edge") {
			if (!v.positionSource) continue;
			const [a, b] = v.positionSource.edgeVerts;
			moveDerived(v, evalEdge(vertices, faces, a, b, v.positionSource.t));
			if (hasColor) {
				const nextColor = colorFromEdge(
					vertices as unknown as readonly MeshColorVertexLike[],
					vc.colorSource.edgeVerts,
					vc.colorSource.t,
				);
				(v as unknown as MeshColorVertexLike).color = nextColor;
			}
		} else if (vc.colorSource?.kind === "quad") {
			const { faceVerts, u, v: vv } = vc.colorSource;
			moveDerived(v, coonsPositionQuad(vertices, faceVerts, u, vv));
			if (hasColor) {
				(v as unknown as MeshColorVertexLike).color = colorFromFaceCorners(
					vertices as unknown as readonly MeshColorVertexLike[],
					faceVerts,
					u,
					vv,
				);
			}
		} else if (v.positionSource) {
			const [a, b] = v.positionSource.edgeVerts;
			moveDerived(v, evalEdge(vertices, faces, a, b, v.positionSource.t));
		}
	}

	// Touch faces only to avoid an unused-parameter warning while keeping the
	// signature forward-compatible with face-aware derivations.
	void faces;
}
