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
	type BlendObject,
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
	type Reference3DElement,
	type RepeatObject,
	type TextElement,
	type Vec2,
} from "../../schema";
import { deepClone, neverReached } from "../lang";
import { GeometryEpsilon } from "./bezierBool";
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
): (p: Point, accept?: (src: Point) => boolean) => Point | null {
	const warpFaces = buildWarpFaces(vertices, faces);
	return (p, accept) => {
		const seen: Point[] = [];
		for (const wf of warpFaces) {
			// A folded face spills past its own boundary curves, so only the
			// hull of the curves' control points can reject a point up front.
			if (p.x < wf.minX || p.x > wf.maxX || p.y < wf.minY || p.y > wf.maxY) {
				continue;
			}
			// A folded face maps several source points onto `p`; the bilinear
			// seed finds one, the fixed seeds reach the others.
			const seeds = [
				bilinearUV(vertices, wf.face.verts, p.x, p.y),
				...INVERSE_SEEDS,
			];
			for (const seed of seeds) {
				const src = invertInFace(wf, p, seed.u, seed.v);
				if (!src) continue;
				if (
					seen.some(
						(q) =>
							Math.hypot(q.x - src.x, q.y - src.y) < INVERSE_MERGE_DISTANCE,
					)
				) {
					continue;
				}
				seen.push(src);
				if (!accept || accept(src)) return src;
			}
		}
		return null;
	};
}

/** Extra Newton seeds per face, in (u, v). */
const INVERSE_SEEDS = [
	{ u: 0.5, v: 0.5 },
	{ u: 0.25, v: 0.25 },
	{ u: 0.75, v: 0.25 },
	{ u: 0.75, v: 0.75 },
	{ u: 0.25, v: 0.75 },
];
/** Residual (mesh-local units) below which Newton counts as converged. */
const INVERSE_RESIDUAL = 1e-3;
/** (u, v) overshoot still attributed to the face, for shared edges. */
const INVERSE_UV_SLACK = 1e-3;
/** Two source candidates closer than this are the same solution. */
const INVERSE_MERGE_DISTANCE = 1e-6;

/**
 * Newton-solve (u, v) of `p` inside one face from a seed. Returns the
 * source-space point, or null when the iteration leaves the face or fails to
 * converge.
 */
function invertInFace(
	wf: WarpFace,
	p: Point,
	u: number,
	v: number,
): Point | null {
	let residual = Number.POSITIVE_INFINITY;
	for (let iter = 0; iter < 15; iter++) {
		const s = coonsPoint(wf, u, v);
		const rx = s.x - p.x;
		const ry = s.y - p.y;
		residual = Math.hypot(rx, ry);
		if (residual < 1e-9) break;
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
	const s = coonsPoint(wf, u, v);
	if (Math.hypot(s.x - p.x, s.y - p.y) > INVERSE_RESIDUAL) return null;
	if (
		u < -INVERSE_UV_SLACK ||
		u > 1 + INVERSE_UV_SLACK ||
		v < -INVERSE_UV_SLACK ||
		v > 1 + INVERSE_UV_SLACK
	) {
		return null;
	}
	const cu = Math.max(0, Math.min(1, u));
	const cv = Math.max(0, Math.min(1, v));
	return {
		x: wf.srcOrigin.x + cu * wf.eU.x + cv * wf.eV.x,
		y: wf.srcOrigin.y + cu * wf.eU.y + cv * wf.eV.y,
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

/**
 * Children the cage cannot deform: they have no vector form to warp, so the
 * warp draws them unwarped and the shape command refuses them as content.
 */
export function isMeshWarpPassthrough(
	el: AnyArtObject,
): el is BlendObject | RepeatObject | Reference3DElement {
	return (
		el.type === "blend" || el.type === "repeat" || el.type === "reference3d"
	);
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
	/**
	 * Transient image id → how its texture reaches the mesh's local space. An
	 * outer mesh composes this with its own warp and re-tessellates, so nested
	 * warps never lose resolution.
	 */
	imageWarps: Map<string, ImageWarpSource>;
	/** Clip groups among the children, warped with their members. */
	clipGroups: MeshWarpClipGroup[];
}

/** An image's texture quad and its mapping into a mesh's local space. */
interface ImageWarpSource {
	/** TL, TR, BR, BL of the texture quad in the image's own space. */
	corners: readonly [Vec2, Vec2, Vec2, Vec2];
	/** Image-space point → mesh-local point. */
	map: (x: number, y: number) => Point;
}

/** Initial grid segments per axis when tessellating an image child's interior. */
const IMAGE_WARP_GRID_SEGMENTS = 16;
/** Grid segments per axis the tolerance-driven refinement stops at. */
const IMAGE_WARP_GRID_MAX_SEGMENTS = 64;

/**
 * Resolve a mesh container's children into render-ready transient elements in
 * the mesh's local space: vector geometry (paths, compound outlines, text
 * glyphs) is baked through composed child transforms and mapped point-by-point
 * through the cage's Coons warp; images tessellate into a warped texture grid
 * (see MeshWarpResolution.imageWarpGrids); nested mesh containers compose
 * (inner warp first, then the outer one). Blend / Repeat / Reference3D
 * children pass through unwarped.
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
	const gridLines = collectSourceGridLines(mesh.vertices);
	const out: AnyArtObject[] = [];
	const imageWarpGrids = new Map<string, Float32Array>();
	const imageWarps = new Map<string, ImageWarpSource>();
	const clipGroups: MeshWarpClipGroup[] = [];
	const visited = new Set<string>([mesh.id]);

	const warpSegments = (segments: CubicBezierSegment[]): CubicBezierSegment[] =>
		deformPathSegments(refineSegmentsForWarp(segments, warp, gridLines), warp);

	const warpPath = (
		path: Path,
		parentT: ElementTransform | undefined,
		id: string,
		opacityScale: number,
	): Path | null => {
		const baked = parentT ? toWorldPath(path, parentT) : toWorldPath(path);
		const oldBounds = calculateSegmentListBounds(baked.segments);
		if (!oldBounds) return null;
		const segments = warpSegments(baked.segments);
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
		if (isMeshWarpPassthrough(el)) {
			out.push(el);
			return;
		}
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
				// children. Clipping is: the clip path warps with
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
						const { transient, grid, source } = warpImageChild(
							inner,
							childT,
							innerId,
							childOpacity,
							warp,
							gridLines,
							innerResolution.imageWarps.get(inner.id),
						);
						out.push(transient);
						imageWarpGrids.set(innerId, grid);
						imageWarps.set(innerId, source);
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
				const { transient, grid, source } = warpImageChild(
					el,
					parentT,
					tid,
					opacityScale,
					warp,
					gridLines,
				);
				out.push(transient);
				imageWarpGrids.set(tid, grid);
				imageWarps.set(tid, source);
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
				// Placing is affine, so mapping the control points is exact; the
				// warp then goes through the same refinement as a path.
				const place = (p: Point): Point => {
					const positioned = { x: p.x + el.x, y: p.y + el.y };
					return identity
						? positioned
						: applyTransformToPoint(
								positioned.x,
								positioned.y,
								composed,
								originX,
								originY,
							);
				};
				for (const [index, glyph] of glyphs.entries()) {
					out.push({
						...glyph,
						id: `${tid}::g${index}`,
						segments: warpSegments(deformPathSegments(glyph.segments, place)),
						transform: createIdentityTransform(),
						opacity: glyph.opacity * opacityScale,
					});
				}
				break;
			}
			default:
				neverReached(el);
		}
	};

	for (const childId of mesh.childIds) visit(childId, undefined, 1);
	return { transients: out, imageWarpGrids, imageWarps, clipGroups };
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
	gridLines: SourceGridLines,
): CubicBezierSegment[] {
	const result: CubicBezierSegment[] = [];
	let prevEnd: BezierPoint | undefined;

	for (const segment of segments) {
		const abs = resolveSegment(segment, prevEnd);
		prevEnd = segment.end;

		// Each face is its own Coons patch, so a curve is only smooth within
		// one face: cut at the face boundaries first, then refine each piece.
		const pieces: CubicCurve[] = [];
		for (const piece of splitCurveAtGridLines(
			[abs.start, abs.cp1, abs.cp2, abs.end],
			gridLines,
		)) {
			splitCurveForWarp(piece, warp, 0, pieces);
		}
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

/** Constant-x and constant-y lines of the source grid: the face boundaries. */
interface SourceGridLines {
	xs: number[];
	ys: number[];
}

const CUBIC_SOLVER = new GeometryEpsilon();
const GRID_LINE_EPSILON = 1e-9;
const GRID_CUT_T_EPSILON = 1e-6;

function collectSourceGridLines(
	vertices: readonly MeshGeometryVertex[],
): SourceGridLines {
	const unique = (values: number[]): number[] => {
		const sorted = [...values].sort((a, b) => a - b);
		const result: number[] = [];
		for (const value of sorted) {
			const prev = result[result.length - 1];
			if (prev !== undefined && value - prev < GRID_LINE_EPSILON) continue;
			result.push(value);
		}
		return result;
	};
	return {
		xs: unique(vertices.map((v) => v.src.x)),
		ys: unique(vertices.map((v) => v.src.y)),
	};
}

/** Cut a source-space curve wherever it crosses a grid line. */
function splitCurveAtGridLines(
	curve: CubicCurve,
	gridLines: SourceGridLines,
): CubicCurve[] {
	const ts: number[] = [];
	for (const x of gridLines.xs) {
		collectAxisCrossings(
			curve.map((p) => p.x),
			x,
			ts,
		);
	}
	for (const y of gridLines.ys) {
		collectAxisCrossings(
			curve.map((p) => p.y),
			y,
			ts,
		);
	}
	if (ts.length === 0) return [curve];
	ts.sort((a, b) => a - b);
	const cuts = [0];
	for (const t of ts) {
		if (t - cuts[cuts.length - 1] > GRID_CUT_T_EPSILON) cuts.push(t);
	}
	if (1 - cuts[cuts.length - 1] > GRID_CUT_T_EPSILON) cuts.push(1);
	else cuts[cuts.length - 1] = 1;
	const pieces: CubicCurve[] = [];
	for (let i = 0; i < cuts.length - 1; i++) {
		pieces.push(getCurveInterval(curve, cuts[i], cuts[i + 1]));
	}
	return pieces;
}

/** Parameters where one coordinate of a cubic equals `value`, strictly inside (0, 1). */
function collectAxisCrossings(
	coords: number[],
	value: number,
	out: number[],
): void {
	const [p0, p1, p2, p3] = coords;
	// The control polygon bounds the curve, so a line outside it never cuts.
	if (value <= Math.min(p0, p1, p2, p3) || value >= Math.max(p0, p1, p2, p3)) {
		return;
	}
	const roots = CUBIC_SOLVER.solveCubic(
		-p0 + 3 * p1 - 3 * p2 + p3,
		3 * p0 - 6 * p1 + 3 * p2,
		-3 * p0 + 3 * p1,
		p0 - value,
	);
	for (const t of roots) {
		if (t > GRID_CUT_T_EPSILON && t < 1 - GRID_CUT_T_EPSILON) out.push(t);
	}
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
	/** Deformed-space hull of the boundary curves' control points. */
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
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
		const bottom = getEffectiveMeshEdgeCurve(vertices, faces, i00, i10);
		const top = getEffectiveMeshEdgeCurve(vertices, faces, i01, i11);
		const left = getEffectiveMeshEdgeCurve(vertices, faces, i00, i01);
		const right = getEffectiveMeshEdgeCurve(vertices, faces, i10, i11);
		const hull = [...bottom, ...top, ...left, ...right];
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
			bottom,
			top,
			left,
			right,
			minX: Math.min(...hull.map((q) => q.x)),
			minY: Math.min(...hull.map((q) => q.y)),
			maxX: Math.max(...hull.map((q) => q.x)),
			maxY: Math.max(...hull.map((q) => q.y)),
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
 * and tessellate the texture quad into a warped (x, y, u, v) triangle grid so
 * the interior bends along the cage. `innerSource` (image already warped by an
 * inner mesh container) supplies the original texture quad and the inner
 * mapping, so the grid is re-tessellated through both warps at once.
 */
function warpImageChild(
	image: ImageObject,
	parentT: ElementTransform | undefined,
	id: string,
	opacityScale: number,
	warp: (p: Point) => Point,
	gridLines: SourceGridLines,
	innerSource?: ImageWarpSource,
): { transient: ImageObject; grid: Float32Array; source: ImageWarpSource } {
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
	const toSource = (x: number, y: number): Point =>
		identity
			? { x, y }
			: applyTransformToPoint(x, y, composed, originX, originY);
	const corners = baseCorners.map(([x, y]) => {
		const w = warp(toSource(x, y));
		return [w.x, w.y] as Vec2;
	}) as [Vec2, Vec2, Vec2, Vec2];
	const centerX =
		(corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4;
	const centerY =
		(corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4;

	const textureToSource = innerSource
		? (x: number, y: number): Point => {
				const inner = innerSource.map(x, y);
				return toSource(inner.x, inner.y);
			}
		: toSource;
	const source: ImageWarpSource = {
		corners: innerSource?.corners ?? baseCorners,
		map: (x, y) => warp(textureToSource(x, y)),
	};

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
		grid: buildImageWarpGrid(source.corners, textureToSource, warp, gridLines),
		source,
	};
}

/** One tessellation vertex: source-space position plus texture coordinate. */
interface GridVertex {
	x: number;
	y: number;
	u: number;
	v: number;
}

/**
 * Tessellate the (possibly free-transformed) texture quad into a warped
 * triangle-list grid. Interior points interpolate the base corners
 * bilinearly, map through `toSource` into the cage's source space, get cut
 * along the face boundaries so no triangle straddles two patches, and finally
 * map through `warp`. The grid is refined uniformly until the warp of every
 * edge midpoint stays within tolerance of the straight edge, so neighbouring
 * triangles always share their split points. UVs run (0,0) at TL to (1,1) at
 * BR, matching the quad blit's texture orientation.
 */
function buildImageWarpGrid(
	baseCorners: readonly [Vec2, Vec2, Vec2, Vec2],
	toSource: (x: number, y: number) => Point,
	warp: (p: Point) => Point,
	gridLines: SourceGridLines,
): Float32Array {
	let n = IMAGE_WARP_GRID_SEGMENTS;
	let tessellation = tessellateImageQuad(baseCorners, toSource, n);
	while (
		n < IMAGE_WARP_GRID_MAX_SEGMENTS &&
		exceedsWarpTolerance(tessellation, warp)
	) {
		n *= 2;
		tessellation = tessellateImageQuad(baseCorners, toSource, n);
	}

	const triangles: GridVertex[][] = [];
	for (const [a, b, c] of tessellation.triangles) {
		const polygons = [
			[tessellation.points[a], tessellation.points[b], tessellation.points[c]],
		];
		for (const polygon of cutPolygonsAtGridLines(polygons, gridLines)) {
			for (let i = 1; i < polygon.length - 1; i++) {
				triangles.push([polygon[0], polygon[i], polygon[i + 1]]);
			}
		}
	}

	const grid = new Float32Array(triangles.length * 3 * 4);
	let offset = 0;
	for (const triangle of triangles) {
		for (const vertex of triangle) {
			const w = warp(vertex);
			grid[offset++] = w.x;
			grid[offset++] = w.y;
			grid[offset++] = vertex.u;
			grid[offset++] = vertex.v;
		}
	}
	return grid;
}

interface ImageTessellation {
	points: GridVertex[];
	/** Index triples into `points`. */
	triangles: [number, number, number][];
}

function tessellateImageQuad(
	baseCorners: readonly [Vec2, Vec2, Vec2, Vec2],
	toSource: (x: number, y: number) => Point,
	n: number,
): ImageTessellation {
	const [tl, tr, br, bl] = baseCorners;
	const points: GridVertex[] = new Array((n + 1) * (n + 1));
	for (let row = 0; row <= n; row++) {
		const t = row / n;
		const lx = tl[0] + (bl[0] - tl[0]) * t;
		const ly = tl[1] + (bl[1] - tl[1]) * t;
		const rx = tr[0] + (br[0] - tr[0]) * t;
		const ry = tr[1] + (br[1] - tr[1]) * t;
		for (let col = 0; col <= n; col++) {
			const s = col / n;
			const p = toSource(lx + (rx - lx) * s, ly + (ry - ly) * s);
			points[row * (n + 1) + col] = { x: p.x, y: p.y, u: s, v: t };
		}
	}
	const triangles: [number, number, number][] = [];
	const at = (row: number, col: number): number => row * (n + 1) + col;
	for (let row = 0; row < n; row++) {
		for (let col = 0; col < n; col++) {
			triangles.push([at(row, col), at(row, col + 1), at(row + 1, col)]);
			triangles.push([
				at(row + 1, col),
				at(row, col + 1),
				at(row + 1, col + 1),
			]);
		}
	}
	return { points, triangles };
}

/** True when some triangle edge, warped straight, misses the warped midpoint. */
function exceedsWarpTolerance(
	tessellation: ImageTessellation,
	warp: (p: Point) => Point,
): boolean {
	const warped = tessellation.points.map((p) => warp(p));
	const checked = new Set<string>();
	for (const triangle of tessellation.triangles) {
		for (let e = 0; e < 3; e++) {
			const a = triangle[e];
			const b = triangle[(e + 1) % 3];
			const key = a < b ? `${a}:${b}` : `${b}:${a}`;
			if (checked.has(key)) continue;
			checked.add(key);
			const pa = tessellation.points[a];
			const pb = tessellation.points[b];
			const expected = warp({ x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 });
			const actual = {
				x: (warped[a].x + warped[b].x) / 2,
				y: (warped[a].y + warped[b].y) / 2,
			};
			if (
				Math.hypot(actual.x - expected.x, actual.y - expected.y) >
				WARP_FIT_TOLERANCE
			) {
				return true;
			}
		}
	}
	return false;
}

/** Split convex polygons along every grid line they straddle. */
function cutPolygonsAtGridLines(
	polygons: GridVertex[][],
	gridLines: SourceGridLines,
): GridVertex[][] {
	let result = polygons;
	for (const x of gridLines.xs)
		result = result.flatMap((p) => cutPolygon(p, "x", x));
	for (const y of gridLines.ys)
		result = result.flatMap((p) => cutPolygon(p, "y", y));
	return result;
}

/** Cut one convex polygon at `axis = value` into the part below and above. */
function cutPolygon(
	polygon: GridVertex[],
	axis: "x" | "y",
	value: number,
): GridVertex[][] {
	const sides = polygon.map((p) => p[axis] - value);
	if (sides.every((d) => d <= GRID_LINE_EPSILON)) return [polygon];
	if (sides.every((d) => d >= -GRID_LINE_EPSILON)) return [polygon];
	const below: GridVertex[] = [];
	const above: GridVertex[] = [];
	for (let i = 0; i < polygon.length; i++) {
		const a = polygon[i];
		const b = polygon[(i + 1) % polygon.length];
		const da = sides[i];
		const db = sides[(i + 1) % polygon.length];
		if (da <= 0) below.push(a);
		if (da >= 0) above.push(a);
		if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
			const cut = cutVertexOnLine(a, b, axis, value);
			below.push(cut);
			above.push(cut);
		}
	}
	return [below, above].filter((p) => p.length >= 3);
}

/**
 * The point where edge a–b crosses `axis = value`. Endpoints are ordered
 * canonically first, so both triangles sharing the edge get bit-identical
 * results and the cut leaves no seam.
 */
function cutVertexOnLine(
	a: GridVertex,
	b: GridVertex,
	axis: "x" | "y",
	value: number,
): GridVertex {
	const [p, q] = a.x < b.x || (a.x === b.x && a.y < b.y) ? [a, b] : [b, a];
	const t = (value - p[axis]) / (q[axis] - p[axis]);
	const cut = {
		x: p.x + (q.x - p.x) * t,
		y: p.y + (q.y - p.y) * t,
		u: p.u + (q.u - p.u) * t,
		v: p.v + (q.v - p.v) * t,
	};
	cut[axis] = value;
	return cut;
}

/** Coons blend of the face's cached boundary curves. */
function coonsPoint(wf: WarpFace, u: number, v: number): Point {
	return coonsPatchPoint(wf.bottom, wf.top, wf.left, wf.right, u, v);
}
