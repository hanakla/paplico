import type { MeshFace, Point } from "../../../schema";
import {
	colorFromEdge,
	colorFromFaceCorners,
	type MeshColorVertexLike,
} from "../generate/meshVertexFactory";
import {
	coonsPatchPoint,
	evalEdge,
	getBaseHandle,
	getBoundaryVertexLoop,
	getEdgeCurve,
	getEffectiveMeshEdgeCurve,
	getOppositeMeshNeighbor,
	getRootSegmentInfo,
	getVertexNeighbors,
	isExplicitMeshVertex,
	isPromotedMeshVertex,
	type MeshVertexLike,
	meshFaceHasEdge,
	resolveMeshVertexOwningEdge,
} from "../measure/meshTopology";
import {
	type CubicCurve,
	evalCubicBezier,
	splitCurve,
} from "../primitives/bezier";
import { findClosestCurveT } from "../query/meshHitTest";

const EDGE_PARAM_EPSILON = 1e-6;
const VERTEX_POSITION_EPSILON = 1e-6;

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

// -----------------------------------------------------------------------------
// Insert edge-mid vertex on the undirected edge (i, j) at parameter t.
//
// `applySplitHandles` adjusts the two adjacent handles of the parent edge so
// that the edge curve is preserved after insertion (de Casteljau split).
// -----------------------------------------------------------------------------

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
	const { left, right } = splitCurve(curve, t);
	const mid = makeMid(left[3]);
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
		const expected = evalCubicBezier(curve[0], curve[1], curve[2], curve[3], t);
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
		const pos = evalCubicBezier(
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
	const a = evalCubicBezier(curve[0], curve[1], curve[2], curve[3], t0);
	const b = evalCubicBezier(curve[0], curve[1], curve[2], curve[3], t0 + h);
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
