/**
 * Tool-side mesh editing support, shared between the gradient tool (mesh
 * gradient fills, bounds-relative space) and the path edit tool (warp cages,
 * mesh-local space).
 *
 * Every function here is pure over vertices/faces in the caller's own
 * coordinate space. Non-square spaces (a gradient's bounds-relative 0..1
 * square) pass their pixel scale as `scaleX`/`scaleY` so angles and
 * distances are measured undistorted; uniform spaces omit them.
 */

import type { MeshFace, Point } from "../../schema";
import {
	type CubicCurve,
	cubicBez,
	edgeKey,
	findClosestCurveT,
	getDisplayedMeshHandle,
	getEffectiveMeshEdgeCurve,
	getVertexNeighbors,
	MESH_CP_FAN_REF_MIN_SCREEN_PX,
	type MeshVertexLike,
	resolveMeshEdgeHandleSlot,
	shouldEmitMeshCPHandle,
} from "./meshGradient";

/**
 * Alt-drag fan over a vertex's CP handles: an explicit vertex keeps each
 * handle aimed at its own neighbor and turns the whole fan with the pointer;
 * a derived vertex lines every handle up with the pointer (far-side ones
 * taking its opposite) so sliding it never kinks the curve.
 */
export interface MeshHandleFanState {
	/** Write slots + the straight direction toward each neighbor (rad). */
	baseAngles: Array<{ slot: number; angle: number }>;
	/**
	 * A derived vertex sits partway along an edge, so aiming its handles at
	 * their neighbors kinks the curve there. Those line up with the pointer
	 * instead.
	 */
	alignToPointer: boolean;
	/** Angle reference captured once the pointer leaves the vertex. */
	ref: { angle: number } | null;
}

/** Capture the fan's write slots and start directions at drag start. */
export function beginMeshHandleFan(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
	vertexIndex: number,
	scaleX = 1,
	scaleY = 1,
): MeshHandleFanState {
	const slots = new Set<number>();
	for (const ni of getVertexNeighbors(faces, vertexIndex)) {
		if (!shouldEmitMeshCPHandle(vertices, faces, vertexIndex, ni)) continue;
		slots.add(resolveMeshEdgeHandleSlot(vertices, faces, vertexIndex, ni));
	}
	const origin = vertices[vertexIndex];
	return {
		baseAngles: [...slots].map((slot) => ({
			slot,
			angle: Math.atan2(
				(vertices[slot].y - origin.y) * scaleY,
				(vertices[slot].x - origin.x) * scaleX,
			),
		})),
		alignToPointer: origin.positionSource != null,
		ref: null,
	};
}

/**
 * Rebuild the vertex's CP handles from the vertex outwards at the pointer's
 * distance (see {@link MeshHandleFanState} for the two aiming rules).
 * Mutates `vertex.handles`; returns false while the pointer is still too
 * close to the vertex for its angle to mean anything.
 */
export function applyMeshHandleFan(
	fan: MeshHandleFanState,
	vertex: MeshVertexLike,
	pointer: Point,
	zoom: number,
	scaleX = 1,
	scaleY = 1,
): boolean {
	const dx = (pointer.x - vertex.x) * scaleX;
	const dy = (pointer.y - vertex.y) * scaleY;
	const dist = Math.hypot(dx, dy);
	if (!fan.ref) {
		// The pointer direction is noise this close to the vertex.
		if (dist * zoom < MESH_CP_FAN_REF_MIN_SCREEN_PX) return false;
		fan.ref = { angle: Math.atan2(dy, dx) };
		return false;
	}
	const pointerAngle = Math.atan2(dy, dx);
	const dAngle = pointerAngle - fan.ref.angle;
	const nextHandles = { ...vertex.handles };
	for (const base of fan.baseAngles) {
		// Explicit: keep each handle on its neighbor and turn the fan.
		// Derived: line every handle up with the pointer (the pen tool's
		// Alt-drag, generalized past two handles).
		const angle = fan.alignToPointer
			? Math.cos(base.angle - pointerAngle) >= 0
				? pointerAngle
				: pointerAngle + Math.PI
			: base.angle + dAngle;
		nextHandles[base.slot] = {
			x: vertex.x + (Math.cos(angle) * dist) / scaleX,
			y: vertex.y + (Math.sin(angle) * dist) / scaleY,
		};
	}
	vertex.handles = nextHandles;
	return true;
}

/**
 * Move a mesh vertex toward the target, keeping its contract: an
 * edge-derived vertex is projected back onto its owning root segment (its
 * edge parameter follows), and the handles ride along rigidly — the
 * along-edge ones are ignored by the effective-curve lookup, but the
 * cross-edge (split line) handles must follow the slide.
 * Returns the new edge parameter when the vertex is edge-locked.
 */
export function slideMeshVertex(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
	vertexIndex: number,
	targetX: number,
	targetY: number,
): { t: number | null } {
	const vertex = vertices[vertexIndex];
	if (!vertex) return { t: null };
	let nextX = targetX;
	let nextY = targetY;
	let projectedT: number | null = null;
	if (vertex.positionSource) {
		const [a, b] = vertex.positionSource.edgeVerts;
		const curve = getEffectiveMeshEdgeCurve(vertices, faces, a, b);
		const t = findClosestCurveT(curve, targetX, targetY);
		const projected = cubicBez(curve[0], curve[1], curve[2], curve[3], t);
		nextX = projected.x;
		nextY = projected.y;
		vertex.positionSource = { edgeVerts: vertex.positionSource.edgeVerts, t };
		projectedT = t;
	}
	const dx = nextX - vertex.x;
	const dy = nextY - vertex.y;
	vertex.x = nextX;
	vertex.y = nextY;
	for (const handle of Object.values(vertex.handles)) {
		handle.x += dx;
		handle.y += dy;
	}
	return { t: projectedT };
}

/**
 * Write a dragged CP through the same root-segment resolution the handle
 * display uses ({@link getDisplayedMeshHandle}), so dragging a CP on a
 * subdivided edge moves the curve that is actually rendered.
 */
export function writeMeshCPHandle(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
	vertexIndex: number,
	neighborIndex: number,
	point: Point,
): void {
	const vertex = vertices[vertexIndex];
	if (!vertex) return;
	const slot = resolveMeshEdgeHandleSlot(
		vertices,
		faces,
		vertexIndex,
		neighborIndex,
	);
	vertex.handles = {
		...vertex.handles,
		[slot]: { x: point.x, y: point.y },
	};
}

/**
 * Every distinct mesh edge with its effective (root-segment resolved) curve,
 * deduped across the faces that share it — the enumeration every overlay
 * draws its cage from.
 */
export function collectMeshEdgeCurves(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
): Array<{ i: number; j: number; curve: CubicCurve }> {
	const edges: Array<{ i: number; j: number; curve: CubicCurve }> = [];
	const seen = new Set<string>();
	for (const face of faces) {
		const n = face.verts.length;
		for (let e = 0; e < n; e++) {
			const i = face.verts[e];
			const j = face.verts[(e + 1) % n];
			const key = edgeKey(i, j);
			if (seen.has(key)) continue;
			seen.add(key);
			if (!vertices[i] || !vertices[j]) continue;
			edges.push({
				i,
				j,
				curve: getEffectiveMeshEdgeCurve(vertices, faces, i, j),
			});
		}
	}
	return edges;
}

/**
 * The CP handles worth showing around one vertex: both directions of every
 * incident edge, filtered to the CPs that actually drive the rendered curve
 * and resolved to the position the drag writes back to.
 */
export function collectMeshCPHandles(
	vertices: readonly MeshVertexLike[],
	faces: readonly MeshFace[],
	aroundVertexIndex: number,
): Array<{ ownerIdx: number; neighborIdx: number; cp: Point }> {
	const out: Array<{ ownerIdx: number; neighborIdx: number; cp: Point }> = [];
	const push = (ownerIdx: number, neighborIdx: number): void => {
		if (!vertices[ownerIdx]) return;
		if (!shouldEmitMeshCPHandle(vertices, faces, ownerIdx, neighborIdx)) {
			return;
		}
		out.push({
			ownerIdx,
			neighborIdx,
			cp: getDisplayedMeshHandle(vertices, faces, ownerIdx, neighborIdx),
		});
	};
	for (const ni of getVertexNeighbors(faces, aroundVertexIndex)) {
		push(aroundVertexIndex, ni);
		push(ni, aroundVertexIndex);
	}
	return out;
}

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
			const onEdge = cubicBez(curve[0], curve[1], curve[2], curve[3], t);
			const dist = metric(onEdge);
			if (!best || dist < best.dist) {
				best = { faceIdx: fi, edgeIdx: e, t, i, j, point: onEdge, dist };
			}
		}
	}
	return best;
}
