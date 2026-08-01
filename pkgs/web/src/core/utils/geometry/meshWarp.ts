/**
 * Coons-patch mesh warp: the geometric core of the mesh warp container.
 *
 * A warp cage is a set of mesh vertices (each carrying an immutable
 * source-space position `src` fixed at creation/subdivision time) plus quad
 * faces. Because the initial cage is a single rectangle and `subdivideFace`
 * only ever cuts at constant u/v, the source-space image of every face stays
 * an axis-aligned rectangle — so "source point → (face, u, v)" is an exact
 * rectangle-containment test plus a linear solve, while the deformed position
 * is the Coons-patch evaluation of the face's current (edited) geometry.
 *
 * Interior cut curves created by subdivision carry no stored handles (the
 * implicit 1/3-straight default), matching mesh-gradient behavior: the outer
 * boundary and all pre-existing edges are preserved exactly across a
 * subdivision (root-segment subcurves), the patch interior is only C0 at the
 * new cut.
 */

import { createIdentityTransform } from "../../document/factory";
import {
	type AnyArtObject,
	type BezierPoint,
	type CubicBezierSegment,
	type ElementTransform,
	getTransform,
	type ImageObject,
	isIdentityTransform,
	type MeshArtObject,
	type MeshFace,
	type MeshGeometryVertex,
	type Path,
	type Point,
	type TextElement,
	type Vec2,
} from "../../schema";
import { deepClone } from "../lang";
import { resolveBlendSourcePath } from "./blendInterpolation";
import { brandLocalBBox, calculateSegmentListBounds } from "./bounds";
import { applyTransformToPoint, composeTransforms } from "./geometry";
import {
	bilinearUV,
	type CubicCurve,
	coonsPatchPoint,
	createEdgeDerivedGeometryVertex,
	createQuadDerivedGeometryVertex,
	cubicBez,
	findClosestCurveT,
	getCurveInterval,
	getEffectiveMeshEdgeCurve,
	getVertexNeighbors,
	isPromotedMeshVertex,
	pointInBezierFace,
	resolveMeshVertexOwningEdge,
	splitCurve,
	subdivideFace,
} from "./meshGradient";
import { deformGradientFilters, deformPathSegments } from "./pointDeform";
import {
	resolveSegment,
	toRelativeCP1,
	toRelativeCP2,
	toWorldPath,
} from "./segmentOps";

/** Initial cage: one quad covering `rect`, vertices at rest (src == position). */
export function createWarpCageFromRect(rect: {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}): { vertices: MeshGeometryVertex[]; faces: MeshFace[] } {
	const corners: Point[] = [
		{ x: rect.minX, y: rect.minY },
		{ x: rect.maxX, y: rect.minY },
		{ x: rect.maxX, y: rect.maxY },
		{ x: rect.minX, y: rect.maxY },
	];
	return {
		vertices: corners.map((p) => ({
			x: p.x,
			y: p.y,
			src: { x: p.x, y: p.y },
			handles: {},
		})),
		faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
	};
}

/**
 * Forward map: source-space point → deformed position on the cage.
 * Points outside the cage resolve to the nearest face's rectangle and
 * extrapolate through the (polynomial) Coons expression — C0-continuous at
 * the cage boundary, never clamped.
 */
export function createMeshWarpSampler(
	vertices: readonly MeshGeometryVertex[],
	faces: readonly MeshFace[],
): (p: Point) => Point {
	const warpFaces = buildWarpFaces(vertices, faces);
	if (warpFaces.length === 0) return (p) => ({ x: p.x, y: p.y });
	return (p) => {
		const wf = findSourceFace(warpFaces, p);
		const { u, v } = sourceUV(wf, p);
		return coonsPoint(wf, u, v);
	};
}

/**
 * Inverse map: deformed position → source-space point, or null when the
 * point is not on any deformed face. Used for hit testing.
 */
export function createMeshWarpInverse(
	vertices: readonly MeshGeometryVertex[],
	faces: readonly MeshFace[],
): (p: Point) => Point | null {
	const warpFaces = buildWarpFaces(vertices, faces);
	return (p) => {
		for (const wf of warpFaces) {
			if (!pointInBezierFace(vertices, faces, wf.face, p.x, p.y)) continue;
			let { u, v } = bilinearUV(vertices, wf.face.verts, p.x, p.y);
			for (let iter = 0; iter < 15; iter++) {
				const s = coonsPoint(wf, u, v);
				const rx = s.x - p.x;
				const ry = s.y - p.y;
				if (rx * rx + ry * ry < 1e-18) break;
				const h = 1e-4;
				const su = coonsPoint(wf, u + h, v);
				const sv = coonsPoint(wf, u, v + h);
				const j00 = (su.x - s.x) / h;
				const j10 = (su.y - s.y) / h;
				const j01 = (sv.x - s.x) / h;
				const j11 = (sv.y - s.y) / h;
				const det = j00 * j11 - j01 * j10;
				if (Math.abs(det) < 1e-12) break;
				u -= (j11 * rx - j01 * ry) / det;
				v -= (-j10 * rx + j00 * ry) / det;
				// Keep Newton from escaping the face while still allowing slight
				// overshoot at the shared-edge boundary.
				u = Math.max(-0.25, Math.min(1.25, u));
				v = Math.max(-0.25, Math.min(1.25, v));
			}
			const cu = Math.max(0, Math.min(1, u));
			const cv = Math.max(0, Math.min(1, v));
			return {
				x: wf.srcOrigin.x + cu * wf.eU.x + cv * wf.eV.x,
				y: wf.srcOrigin.y + cu * wf.eU.y + cv * wf.eV.y,
			};
		}
		return null;
	};
}

/**
 * Face subdivision for warp cages: delegates topology to `subdivideFace` and
 * derives each new vertex's `src` from the source-space rectangle (bilinear
 * for face-interior vertices, lerp along the edge for edge cuts) so the
 * source grid stays axis-aligned.
 */
export function subdivideWarpFace(
	vertices: readonly MeshGeometryVertex[],
	faces: readonly MeshFace[],
	faceIdx: number,
	clickU: number,
	clickV: number,
	cutAxes?: { u?: boolean; v?: boolean },
): {
	vertices: MeshGeometryVertex[];
	faces: MeshFace[];
	centerIdx: number;
} | null {
	let nextId =
		vertices.reduce((maxId, v) => Math.max(maxId, v.splitLineId ?? 0), 0) + 1;
	const srcAtFace = (
		faceVerts: readonly number[],
		u: number,
		v: number,
	): Point => {
		const [a, b, c, d] = faceVerts;
		const mu = 1 - u;
		const mv = 1 - v;
		return {
			x:
				mu * mv * vertices[a].src.x +
				u * mv * vertices[b].src.x +
				u * v * vertices[c].src.x +
				mu * v * vertices[d].src.x,
			y:
				mu * mv * vertices[a].src.y +
				u * mv * vertices[b].src.y +
				u * v * vertices[c].src.y +
				mu * v * vertices[d].src.y,
		};
	};
	return subdivideFace<MeshGeometryVertex>(
		vertices,
		faces,
		faceIdx,
		clickU,
		clickV,
		{
			makeCenterExplicit: (position, faceVerts, u, v) => ({
				x: position.x,
				y: position.y,
				handles: {},
				src: srcAtFace(faceVerts, u, v),
			}),
			makeEdgeDerived: (position, edgeVerts, t) =>
				createEdgeDerivedGeometryVertex(position, edgeVerts, t, (fields) => ({
					...fields,
					src: {
						x:
							vertices[edgeVerts[0]].src.x +
							(vertices[edgeVerts[1]].src.x - vertices[edgeVerts[0]].src.x) * t,
						y:
							vertices[edgeVerts[0]].src.y +
							(vertices[edgeVerts[1]].src.y - vertices[edgeVerts[0]].src.y) * t,
					},
				})),
			makeQuadDerived: (position, faceVerts, u, v) =>
				createQuadDerivedGeometryVertex(position, (fields) => ({
					...fields,
					src: srcAtFace(faceVerts, u, v),
				})),
			nextSplitLineId: () => nextId++,
			cutAxes,
		},
	);
}

/**
 * Promote a derived cage vertex (edge-locked to its owning root segment) to an
 * explicit one. Shape is preserved: every adjacent edge's effective curve is
 * materialized into stored handles first, so the root-segment resolution that
 * disappears with the sources keeps rendering identically. Returns null when
 * the vertex is not derived.
 */
export function promoteWarpVertexToExplicit(
	vertices: readonly MeshGeometryVertex[],
	faces: readonly MeshFace[],
	vertexIndex: number,
): MeshGeometryVertex[] | null {
	const target = vertices[vertexIndex];
	if (!target || (!target.positionSource && !target.meshSource)) return null;

	// The run of edge this vertex rides, and where along it the vertex sits —
	// read before the promotion, while the sources still resolve.
	const run = resolveWarpEdgeRun(vertices, faces, vertexIndex);
	const runCurve = run
		? getEffectiveMeshEdgeCurve(vertices, faces, run.ends[0], run.ends[1])
		: null;
	const runParameter = run
		? srcParameterOnEdge(
				target.src,
				vertices[run.ends[0]].src,
				vertices[run.ends[1]].src,
			)
		: null;

	const next = vertices.map((v) => ({
		...v,
		handles: { ...v.handles },
		src: { ...v.src },
	}));
	// Materialize BEFORE clearing the sources — the effective curves resolve
	// through them.
	for (const neighborIdx of getVertexNeighbors(faces, vertexIndex)) {
		const curve = getEffectiveMeshEdgeCurve(
			next,
			faces,
			vertexIndex,
			neighborIdx,
		);
		next[vertexIndex].handles[neighborIdx] = { x: curve[1].x, y: curve[1].y };
		next[neighborIdx].handles[vertexIndex] = { x: curve[2].x, y: curve[2].y };
	}
	const promoted = next[vertexIndex];
	promoted.positionSource = undefined;
	promoted.meshSource = undefined;
	// The vertex no longer belongs to its split set: deleting a former sibling
	// must not drag an explicit vertex along.
	promoted.splitLineId = undefined;
	if (run && runCurve && runParameter != null) {
		splitEdgeRunAt(next, run.ends, vertexIndex, runCurve, runParameter);
		rebindAcrossPromotedVertex(next, vertexIndex, run);
	}
	return next;
}

/**
 * Put a promoted cage vertex back on the edge it was cut from, the inverse of
 * `promoteWarpVertexToExplicit`. It follows that edge again instead of holding
 * its own position, and rejoins the split line it anchors. Returns null when
 * the vertex was not promoted or no cage edge runs through it.
 *
 * The vertex returns to the spot its immutable `src` names, wherever the user
 * had dragged it while it was explicit: a derived vertex's position is a
 * function of its source position, and every later cut reads the cage through
 * that source grid.
 */
export function demoteWarpVertexToDerived(
	vertices: readonly MeshGeometryVertex[],
	faces: readonly MeshFace[],
	vertexIndex: number,
): MeshGeometryVertex[] | null {
	const target = vertices[vertexIndex];
	if (!target || !isPromotedMeshVertex(target)) return null;

	const owner = resolveMeshVertexOwningEdge(vertices, faces, vertexIndex);
	if (!owner) return null;
	const [edgeA, edgeB] = owner.edgeVerts;

	const next = vertices.map((v) => ({
		...v,
		handles: { ...v.handles },
		src: { ...v.src },
	}));
	const t =
		srcParameterOnEdge(target.src, next[edgeA].src, next[edgeB].src) ??
		// A degenerate source span leaves nothing to read the vertex off, so
		// fall back to where it currently sits on the edge.
		findClosestCurveT(
			getEffectiveMeshEdgeCurve(next, faces, edgeA, edgeB),
			target.x,
			target.y,
		);
	const demoted = next[vertexIndex];
	demoted.positionSource = { edgeVerts: [edgeA, edgeB], t };
	demoted.meshSource = { edgeVerts: [edgeA, edgeB], t };
	// Rejoin the split line hanging off this vertex, so the line moves and
	// deletes as one again.
	demoted.splitLineId = [...getVertexNeighbors(faces, vertexIndex)]
		.filter((ni) => !owner.alongNeighbors.includes(ni))
		.map((ni) => next[ni].splitLineId)
		.find((id) => id !== undefined);
	// The along-edge handles were materialized by the promotion; the root
	// segment owns that stretch of curve again now.
	for (const neighbor of owner.alongNeighbors) delete demoted.handles[neighbor];
	return next;
}

/**
 * The run of cage edge a derived vertex rides: the source-grid line it was cut
 * on, followed both ways to the first vertex holding its own position. The
 * vertex's own binding names the axis, so a vertex where two lines cross is
 * read along the one it belongs to.
 */
function resolveWarpEdgeRun(
	vertices: readonly MeshGeometryVertex[],
	faces: readonly MeshFace[],
	vertexIndex: number,
): { ends: [number, number]; axis: "x" | "y" } | null {
	const source = vertices[vertexIndex].positionSource;
	if (!source) return null;
	const [from, to] = source.edgeVerts;
	if (!vertices[from] || !vertices[to]) return null;
	const axis: "x" | "y" =
		Math.abs(vertices[to].src.x - vertices[from].src.x) >
		Math.abs(vertices[to].src.y - vertices[from].src.y)
			? "x"
			: "y";
	const back = walkSrcLine(vertices, faces, vertexIndex, axis, -1);
	const forward = walkSrcLine(vertices, faces, vertexIndex, axis, 1);
	if (back === forward) return null;
	return { ends: [back, forward], axis };
}

/** Step along a source-grid line until a vertex holds its own position. */
function walkSrcLine(
	vertices: readonly MeshGeometryVertex[],
	faces: readonly MeshFace[],
	vertexIndex: number,
	axis: "x" | "y",
	direction: 1 | -1,
): number {
	const across = axis === "x" ? "y" : "x";
	let current = vertexIndex;
	for (let step = 0; step < vertices.length; step++) {
		const next = [...getVertexNeighbors(faces, current)]
			.filter(
				(ni) =>
					Math.abs(vertices[ni].src[across] - vertices[current].src[across]) <
						SRC_SPAN_EPSILON &&
					Math.sign(vertices[ni].src[axis] - vertices[current].src[axis]) ===
						direction,
			)
			.sort(
				(a, b) =>
					Math.abs(vertices[a].src[axis] - vertices[current].src[axis]) -
					Math.abs(vertices[b].src[axis] - vertices[current].src[axis]),
			)[0];
		if (next === undefined) return current;
		current = next;
		if (vertices[current].positionSource == null) return current;
	}
	return current;
}

/**
 * Cut the run of edge the newly explicit vertex sits on in two at that vertex,
 * storing each half's control points on its ends. The halves trace the very
 * curve the whole run did, so whatever rides them keeps its place.
 */
function splitEdgeRunAt(
	vertices: MeshGeometryVertex[],
	ends: readonly [number, number],
	promotedIdx: number,
	curve: [Point, Point, Point, Point],
	t: number,
): void {
	if (t <= 0 || t >= 1) return;
	const [from, to] = ends;
	const first = getCurveInterval(curve, 0, t);
	const second = getCurveInterval(curve, t, 1);
	vertices[from].handles[promotedIdx] = { x: first[1].x, y: first[1].y };
	vertices[promotedIdx].handles[from] = { x: first[2].x, y: first[2].y };
	vertices[promotedIdx].handles[to] = { x: second[1].x, y: second[1].y };
	vertices[to].handles[promotedIdx] = { x: second[2].x, y: second[2].y };
}

/**
 * Re-bind the derived vertices that ride a run of edge the newly explicit
 * vertex now ends. Their sources still name the whole run, and an explicit
 * vertex inside it means that run is no longer one curve — leaving them bound
 * to it would drop them somewhere else on the next sync. Each is bound to the
 * half it sits in, at the parameter its source position names, which is the
 * spot it already occupies.
 */
function rebindAcrossPromotedVertex(
	vertices: MeshGeometryVertex[],
	promotedIdx: number,
	run: { ends: [number, number]; axis: "x" | "y" },
): void {
	const { axis, ends } = run;
	const across = axis === "x" ? "y" : "x";
	const at = vertices[promotedIdx].src;
	const low = vertices[ends[0]].src[axis];
	const high = vertices[ends[1]].src[axis];
	for (let vi = 0; vi < vertices.length; vi++) {
		if (vi === promotedIdx || !vertices[vi].positionSource) continue;
		const src = vertices[vi].src;
		// Only vertices riding this run, on one side or the other of its new end.
		if (Math.abs(src[across] - at[across]) > SRC_SPAN_EPSILON) continue;
		if (src[axis] <= low || src[axis] >= high) continue;
		if (Math.abs(src[axis] - at[axis]) < SRC_SPAN_EPSILON) continue;

		const half: [number, number] =
			src[axis] < at[axis] ? [ends[0], promotedIdx] : [promotedIdx, ends[1]];
		const t = srcParameterOnEdge(
			src,
			vertices[half[0]].src,
			vertices[half[1]].src,
		);
		if (t == null) continue;
		vertices[vi].positionSource = { edgeVerts: half, t };
		vertices[vi].meshSource = { edgeVerts: half, t };
	}
}

/**
 * Where `src` sits along the source span from `from` to `to`, as the 0..1
 * parameter the cage's edge curves are cut at. Source faces are axis-aligned
 * rectangles, so exactly one axis varies along an edge. Null when neither
 * does.
 */
function srcParameterOnEdge(src: Point, from: Point, to: Point): number | null {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	if (Math.abs(dx) > Math.abs(dy)) {
		return Math.abs(dx) > SRC_SPAN_EPSILON ? (src.x - from.x) / dx : null;
	}
	return Math.abs(dy) > SRC_SPAN_EPSILON ? (src.y - from.y) / dy : null;
}

/** Dependencies for warping a mesh container's children into transients. */
export interface WarpChildrenDeps {
	resolve: (id: string) => AnyArtObject | null;
	/**
	 * Warp-ready glyph outline paths for a text child (element-local space,
	 * per-glyph paint filters applied, element x/y NOT applied), or null while
	 * the async glyph layout is still pending.
	 */
	getTextGlyphPaths: (element: TextElement) => Path[] | null;
}

/** A clip group inside the mesh, with its clip path warped alongside its members. */
export interface MeshWarpClipGroup {
	/** Mask key: the warped clip path's transient id. */
	id: string;
	/** Warped clip path, never painted — it only feeds the mask. */
	clipPath: Path;
	/** Transient ids the mask applies to (descendants of the clip group). */
	memberIds: string[];
}

/** Result of resolving a mesh container's children into render transients. */
export interface MeshWarpResolution {
	transients: AnyArtObject[];
	/**
	 * Transient image id → interleaved (x, y, u, v) triangle-list vertices in
	 * the mesh's local space. Drives the tessellated texture blit so an image
	 * child's interior bends along the cage — its `corners` only cover bounds
	 * and the no-texture fallback.
	 */
	imageWarpGrids: Map<string, Float32Array>;
	/** Clip groups among the children, warped with their members. */
	clipGroups: MeshWarpClipGroup[];
}

/** Grid segments per axis when tessellating an image child's interior. */
const IMAGE_WARP_GRID_SEGMENTS = 16;

/**
 * Resolve a mesh container's children into render-ready transient elements in
 * the mesh's local space: vector geometry (paths, compound outlines, text
 * glyphs) is baked through composed child transforms and mapped point-by-point
 * through the cage's Coons warp; images tessellate into a warped texture grid
 * (see MeshWarpResolution.imageWarpGrids); nested mesh containers compose
 * (inner warp first, then the outer one). Blend / Repeat / Reference3D
 * children pass through unwarped (v1 limitation).
 *
 * Transient ids are `${mesh.id}::warp::…` so per-element GPU caches never
 * collide with the children's own (unrendered) entries, mirroring
 * renderBlend's `::src` convention.
 */
export function warpMeshChildren(
	mesh: MeshArtObject,
	deps: WarpChildrenDeps,
): MeshWarpResolution {
	const warp = createMeshWarpSampler(mesh.vertices, mesh.faces);
	const out: AnyArtObject[] = [];
	const imageWarpGrids = new Map<string, Float32Array>();
	const clipGroups: MeshWarpClipGroup[] = [];
	const visited = new Set<string>([mesh.id]);

	const warpPath = (
		path: Path,
		parentT: ElementTransform | undefined,
		id: string,
		opacityScale: number,
	): Path | null => {
		const baked = parentT ? toWorldPath(path, parentT) : toWorldPath(path);
		const oldBounds = calculateSegmentListBounds(baked.segments);
		if (!oldBounds) return null;
		const segments = deformPathSegments(
			refineSegmentsForWarp(baked.segments, warp),
			warp,
		);
		const newBounds = calculateSegmentListBounds(segments);
		if (!newBounds) return null;
		const filters = deformGradientFilters(
			baked,
			warp,
			brandLocalBBox(oldBounds),
			brandLocalBBox(newBounds),
			{ x: 0, y: 0 },
		);
		return {
			...baked,
			id,
			segments,
			opacity: baked.opacity * opacityScale,
			...(filters ? { filters } : {}),
		};
	};

	const emitPath = (
		path: Path,
		parentT: ElementTransform | undefined,
		id: string,
		opacityScale: number,
	): void => {
		const warped = warpPath(path, parentT, id, opacityScale);
		if (warped) out.push(warped);
	};

	const visit = (
		childId: string,
		parentT: ElementTransform | undefined,
		opacityScale: number,
	): void => {
		if (visited.has(childId)) return;
		const el = deps.resolve(childId);
		if (!el || el.visible === false) return;
		visited.add(childId);
		const tid = `${mesh.id}::warp::${el.id}`;

		switch (el.type) {
			case "path":
				emitPath(el, parentT, tid, opacityScale);
				break;
			case "compound-path": {
				const resolved = resolveBlendSourcePath(
					el,
					(cid) => deps.resolve(cid) ?? undefined,
				);
				if (resolved) emitPath(resolved, parentT, tid, opacityScale);
				break;
			}
			case "group": {
				const childT = parentT
					? composeTransforms(parentT, getTransform(el))
					: getTransform(el);
				const childOpacity = opacityScale * el.opacity;
				// Group-level blendMode / filters are not applied to the flattened
				// children (v1 limitation). Clipping is: the clip path warps with
				// the group and comes back as a mask over the members instead of
				// painting as a normal shape.
				const firstMember = out.length;
				for (const cid of el.childIds) {
					if (cid === el.clipPathId) continue;
					visit(cid, childT, childOpacity);
				}
				if (el.clipPathId != null) {
					const clipSource = deps.resolve(el.clipPathId);
					const memberIds = out.slice(firstMember).map((t) => t.id);
					if (clipSource?.type === "path" && memberIds.length > 0) {
						const clipId = `${mesh.id}::warp::${el.clipPathId}`;
						const clipPath = warpPath(clipSource, childT, clipId, 1);
						if (clipPath) {
							clipGroups.push({ id: clipId, clipPath, memberIds });
						}
					}
				}
				break;
			}
			case "mesh": {
				const childT = parentT
					? composeTransforms(parentT, getTransform(el))
					: getTransform(el);
				const childOpacity = opacityScale * el.opacity;
				const innerResolution = warpMeshChildren(el, deps);
				for (const inner of innerResolution.transients) {
					const innerId = `${mesh.id}::warp::${inner.id}`;
					if (inner.type === "path") {
						emitPath(inner, childT, innerId, childOpacity);
					} else if (inner.type === "image") {
						const { transient, grid } = warpImageChild(
							inner,
							childT,
							innerId,
							childOpacity,
							warp,
							innerResolution.imageWarpGrids.get(inner.id),
						);
						out.push(transient);
						imageWarpGrids.set(innerId, grid);
					} else {
						out.push(inner);
					}
				}
				// The inner cage's clip groups warp once more through this cage.
				for (const inner of innerResolution.clipGroups) {
					const clipId = `${mesh.id}::warp::${inner.id}`;
					const clipPath = warpPath(inner.clipPath, childT, clipId, 1);
					if (!clipPath) continue;
					clipGroups.push({
						id: clipId,
						clipPath,
						memberIds: inner.memberIds.map((id) => `${mesh.id}::warp::${id}`),
					});
				}
				break;
			}
			case "image": {
				const { transient, grid } = warpImageChild(
					el,
					parentT,
					tid,
					opacityScale,
					warp,
				);
				out.push(transient);
				imageWarpGrids.set(tid, grid);
				break;
			}
			case "text": {
				const glyphs = deps.getTextGlyphPaths(el);
				if (!glyphs) break; // async glyph layout pending — caller re-renders
				const composed = parentT
					? composeTransforms(parentT, getTransform(el))
					: getTransform(el);
				const identity = isIdentityTransform(composed);
				// Transform origin: centre of the glyph-ink bounds offset by the
				// element position (approximates the renderer's synced text bounds;
				// exact whenever the text transform is identity).
				const inkBounds = calculateSegmentListBounds(
					glyphs.flatMap((g) => g.segments),
				);
				const originX = inkBounds
					? (inkBounds.minX + inkBounds.maxX) / 2 + el.x
					: el.x;
				const originY = inkBounds
					? (inkBounds.minY + inkBounds.maxY) / 2 + el.y
					: el.y;
				const mapPoint = (p: Point): Point => {
					const positioned = { x: p.x + el.x, y: p.y + el.y };
					return warp(
						identity
							? positioned
							: applyTransformToPoint(
									positioned.x,
									positioned.y,
									composed,
									originX,
									originY,
								),
					);
				};
				for (const [index, glyph] of glyphs.entries()) {
					out.push({
						...glyph,
						id: `${tid}::g${index}`,
						segments: deformPathSegments(glyph.segments, mapPoint),
						transform: createIdentityTransform(),
						opacity: glyph.opacity * opacityScale,
					});
				}
				break;
			}
			default:
				// blend / repeat / reference3d: no vector warp available — pass
				// through unwarped so the content stays visible (v1 limitation).
				out.push(el);
				break;
		}
	};

	for (const childId of mesh.childIds) visit(childId, undefined, 1);
	return { transients: out, imageWarpGrids, clipGroups };
}

// --- Helpers ---

/**
 * World-unit deviation tolerated between the warped curve and the curve the
 * warped control points actually produce, before a segment is split.
 */
const WARP_FIT_TOLERANCE = 0.2;
/** Split depth cap: 2^6 = 64 pieces per source segment. */
const WARP_MAX_SPLIT_DEPTH = 6;
/** Source span below which an edge carries no readable direction. */
const SRC_SPAN_EPSILON = 1e-9;

/**
 * Split path segments until mapping their control points reproduces the warped
 * curve within `WARP_FIT_TOLERANCE`.
 *
 * Warping a path maps its anchors and control points, which bends a segment
 * only as much as four moved points can: a straight edge running along a bent
 * cage boundary would stay straight no matter how the cage is edited. Splitting
 * first gives the curve enough points to follow the patch, and since the warp
 * is locally affine the error shrinks fast — short segments are left alone.
 */
function refineSegmentsForWarp(
	segments: CubicBezierSegment[],
	warp: (p: Point) => Point,
): CubicBezierSegment[] {
	const result: CubicBezierSegment[] = [];
	let prevEnd: BezierPoint | undefined;

	for (const segment of segments) {
		const abs = resolveSegment(segment, prevEnd);
		prevEnd = segment.end;

		const pieces: CubicCurve[] = [];
		splitCurveForWarp([abs.start, abs.cp1, abs.cp2, abs.end], warp, 0, pieces);
		if (pieces.length === 1) {
			result.push(segment);
			continue;
		}

		// The split pieces replace one segment: the first keeps its start anchor
		// (and the segment's metadata), the rest chain off the previous end. Only
		// the last piece may close the sub-path.
		pieces.forEach((piece, i) => {
			const [p0, c1, c2, p3] = piece;
			const isFirst = i === 0;
			result.push({
				...segment,
				start:
					isFirst && segment.start
						? { ...segment.start, x: p0.x, y: p0.y }
						: undefined,
				cp1: toRelativeCP1({ ...segment.cp1, x: c1.x, y: c1.y }, p0),
				cp2: toRelativeCP2({ ...segment.cp2, x: c2.x, y: c2.y }, p3),
				end: { ...segment.end, x: p3.x, y: p3.y },
				// `isMoved` and `start` both open a sub-path: carrying them onto
				// every piece would shred one contour into as many open sub-paths
				// as it was split into, and the fill would tear into spikes.
				isMoved: isFirst ? segment.isMoved : false,
				isClosed: i === pieces.length - 1 ? segment.isClosed : undefined,
			});
		});
	}
	return result;
}

/** Recursive halving until the mapped control points fit the warped curve. */
function splitCurveForWarp(
	curve: CubicCurve,
	warp: (p: Point) => Point,
	depth: number,
	out: CubicCurve[],
): void {
	if (depth >= WARP_MAX_SPLIT_DEPTH || fitsWarpedCurve(curve, warp)) {
		out.push(curve);
		return;
	}
	const { left, right } = splitCurve(curve, 0.5);
	splitCurveForWarp(left, warp, depth + 1, out);
	splitCurveForWarp(right, warp, depth + 1, out);
}

/**
 * True when the cubic through the warped control points stays within tolerance
 * of the warped source curve at its quarter points.
 */
function fitsWarpedCurve(
	curve: CubicCurve,
	warp: (p: Point) => Point,
): boolean {
	const mapped: CubicCurve = [
		warp(curve[0]),
		warp(curve[1]),
		warp(curve[2]),
		warp(curve[3]),
	];
	for (const t of [0.25, 0.5, 0.75]) {
		const expected = warp(cubicBez(curve[0], curve[1], curve[2], curve[3], t));
		const actual = cubicBez(mapped[0], mapped[1], mapped[2], mapped[3], t);
		if (
			Math.hypot(actual.x - expected.x, actual.y - expected.y) >
			WARP_FIT_TOLERANCE
		) {
			return false;
		}
	}
	return true;
}

interface WarpFace {
	face: MeshFace;
	/** Source-space rect frame: origin = src of i00, edges toward i10 / i01. */
	srcOrigin: Point;
	eU: Point;
	eV: Point;
	invLenU2: number;
	invLenV2: number;
	srcMinX: number;
	srcMinY: number;
	srcMaxX: number;
	srcMaxY: number;
	/** Effective boundary curves in Coons orientation. */
	bottom: CubicCurve; // i00 → i10, parameter u at v=0
	top: CubicCurve; // i01 → i11, parameter u at v=1
	left: CubicCurve; // i00 → i01, parameter v at u=0
	right: CubicCurve; // i10 → i11, parameter v at u=1
}

function buildWarpFaces(
	vertices: readonly MeshGeometryVertex[],
	faces: readonly MeshFace[],
): WarpFace[] {
	const result: WarpFace[] = [];
	for (const face of faces) {
		if (face.type !== "quad") continue;
		const [i00, i10, i11, i01] = face.verts;
		const s00 = vertices[i00].src;
		const s10 = vertices[i10].src;
		const s11 = vertices[i11].src;
		const s01 = vertices[i01].src;
		const eU = { x: s10.x - s00.x, y: s10.y - s00.y };
		const eV = { x: s01.x - s00.x, y: s01.y - s00.y };
		const lenU2 = eU.x * eU.x + eU.y * eU.y;
		const lenV2 = eV.x * eV.x + eV.y * eV.y;
		if (lenU2 === 0 || lenV2 === 0) continue;
		result.push({
			face,
			srcOrigin: s00,
			eU,
			eV,
			invLenU2: 1 / lenU2,
			invLenV2: 1 / lenV2,
			srcMinX: Math.min(s00.x, s10.x, s11.x, s01.x),
			srcMinY: Math.min(s00.y, s10.y, s11.y, s01.y),
			srcMaxX: Math.max(s00.x, s10.x, s11.x, s01.x),
			srcMaxY: Math.max(s00.y, s10.y, s11.y, s01.y),
			bottom: getEffectiveMeshEdgeCurve(vertices, faces, i00, i10),
			top: getEffectiveMeshEdgeCurve(vertices, faces, i01, i11),
			left: getEffectiveMeshEdgeCurve(vertices, faces, i00, i01),
			right: getEffectiveMeshEdgeCurve(vertices, faces, i10, i11),
		});
	}
	return result;
}

function sourceUV(wf: WarpFace, p: Point): { u: number; v: number } {
	const dx = p.x - wf.srcOrigin.x;
	const dy = p.y - wf.srcOrigin.y;
	return {
		u: (dx * wf.eU.x + dy * wf.eU.y) * wf.invLenU2,
		v: (dx * wf.eV.x + dy * wf.eV.y) * wf.invLenV2,
	};
}

const FACE_LOOKUP_EPSILON = 1e-9;

function findSourceFace(warpFaces: WarpFace[], p: Point): WarpFace {
	let nearest = warpFaces[0];
	let nearestDist = Number.POSITIVE_INFINITY;
	for (const wf of warpFaces) {
		const dx = Math.max(wf.srcMinX - p.x, 0, p.x - wf.srcMaxX);
		const dy = Math.max(wf.srcMinY - p.y, 0, p.y - wf.srcMaxY);
		const dist = dx * dx + dy * dy;
		if (dist <= FACE_LOOKUP_EPSILON) return wf;
		if (dist < nearestDist) {
			nearestDist = dist;
			nearest = wf;
		}
	}
	return nearest;
}

/**
 * Warp an image child: bake its 4 corners (existing free-transform corners or
 * the plain rectangle) through the composed transform + cage warp for bounds,
 * and tessellate the quad into a warped (x, y, u, v) triangle grid so the
 * interior bends along the cage. When `innerGrid` is given (image already
 * warped by an inner mesh container), its positions are re-mapped instead of
 * re-tessellating — the inner warp is preserved and composed with this one.
 */
function warpImageChild(
	image: ImageObject,
	parentT: ElementTransform | undefined,
	id: string,
	opacityScale: number,
	warp: (p: Point) => Point,
	innerGrid?: Float32Array,
): { transient: ImageObject; grid: Float32Array } {
	const composed = parentT
		? composeTransforms(parentT, getTransform(image))
		: getTransform(image);
	const halfW = image.width / 2;
	const halfH = image.height / 2;
	// TL, TR, BR, BL in Y-up space (matches buildImageQuadSegments).
	const baseCorners: [Vec2, Vec2, Vec2, Vec2] = image.corners ?? [
		[image.x - halfW, image.y + halfH],
		[image.x + halfW, image.y + halfH],
		[image.x + halfW, image.y - halfH],
		[image.x - halfW, image.y - halfH],
	];
	// Transform origin = local bounds centre (matches calculateImageBounds).
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [x, y] of baseCorners) {
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	}
	const originX = (minX + maxX) / 2;
	const originY = (minY + maxY) / 2;
	const identity = isIdentityTransform(composed);
	const mapPoint = (x: number, y: number): Point =>
		warp(
			identity
				? { x, y }
				: applyTransformToPoint(x, y, composed, originX, originY),
		);
	const corners = baseCorners.map(([x, y]) => {
		const w = mapPoint(x, y);
		return [w.x, w.y] as Vec2;
	}) as [Vec2, Vec2, Vec2, Vec2];
	const centerX =
		(corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4;
	const centerY =
		(corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4;

	let grid: Float32Array;
	if (innerGrid) {
		grid = new Float32Array(innerGrid.length);
		for (let i = 0; i < innerGrid.length; i += 4) {
			const w = mapPoint(innerGrid[i], innerGrid[i + 1]);
			grid[i] = w.x;
			grid[i + 1] = w.y;
			grid[i + 2] = innerGrid[i + 2];
			grid[i + 3] = innerGrid[i + 3];
		}
	} else {
		grid = buildImageWarpGrid(baseCorners, mapPoint);
	}

	return {
		transient: {
			...deepClone(image),
			id,
			x: centerX,
			y: centerY,
			corners,
			transform: createIdentityTransform(),
			opacity: image.opacity * opacityScale,
		},
		grid,
	};
}

/**
 * Tessellate the (possibly free-transformed) image quad into a warped
 * triangle-list grid. Interior points interpolate the base corners
 * bilinearly and map through `mapPoint`; UVs run (0,0) at TL to (1,1) at BR,
 * matching the quad blit's texture orientation.
 */
function buildImageWarpGrid(
	baseCorners: readonly [Vec2, Vec2, Vec2, Vec2],
	mapPoint: (x: number, y: number) => Point,
): Float32Array {
	const n = IMAGE_WARP_GRID_SEGMENTS;
	const [tl, tr, br, bl] = baseCorners;
	const points: Point[] = new Array((n + 1) * (n + 1));
	for (let row = 0; row <= n; row++) {
		const t = row / n;
		const lx = tl[0] + (bl[0] - tl[0]) * t;
		const ly = tl[1] + (bl[1] - tl[1]) * t;
		const rx = tr[0] + (br[0] - tr[0]) * t;
		const ry = tr[1] + (br[1] - tr[1]) * t;
		for (let col = 0; col <= n; col++) {
			const s = col / n;
			points[row * (n + 1) + col] = mapPoint(
				lx + (rx - lx) * s,
				ly + (ry - ly) * s,
			);
		}
	}

	const grid = new Float32Array(n * n * 6 * 4);
	let offset = 0;
	const push = (row: number, col: number): void => {
		const p = points[row * (n + 1) + col];
		grid[offset++] = p.x;
		grid[offset++] = p.y;
		grid[offset++] = col / n;
		grid[offset++] = row / n;
	};
	for (let row = 0; row < n; row++) {
		for (let col = 0; col < n; col++) {
			push(row, col);
			push(row, col + 1);
			push(row + 1, col);
			push(row + 1, col);
			push(row, col + 1);
			push(row + 1, col + 1);
		}
	}
	return grid;
}

/** Coons blend of the face's cached boundary curves. */
function coonsPoint(wf: WarpFace, u: number, v: number): Point {
	return coonsPatchPoint(wf.bottom, wf.top, wf.left, wf.right, u, v);
}
