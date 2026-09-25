/**
 * Warp cage construction from an arbitrary closed contour.
 *
 * Four corner points split the contour into bottom / right / top / left
 * chains. The chains bound a piecewise Coons patch that is sampled at every
 * curve break of the opposite chains, so every face keeps a cubic boundary
 * and the outer edges reproduce the original curves exactly. Source-space
 * positions stay an axis-aligned grid over the content bounds, which is what
 * the rest of the mesh warp machinery assumes.
 */

import type {
	BezierPoint,
	BoundingBox,
	CubicBezierSegment,
	MeshArtObject,
	MeshFace,
	MeshGeometryVertex,
	Point,
} from "../../schema";
import { deepClone } from "../lang";
import {
	cubicSegmentsToContour,
	GeometryEpsilon,
	segmentsIntersect,
} from "./bezierBool";
import { calculateSegmentListBounds } from "./bounds";
import {
	type CubicCurve,
	cubicBez,
	findClosestCurveT,
	getCurveInterval,
} from "./meshGradient";
import { buildArcLengthTable } from "./pathSampling";
import { resolveSegment, toRelativeCP1, toRelativeCP2 } from "./segmentOps";

export type WarpGeometry = Pick<MeshArtObject, "vertices" | "faces">;

type WarpShapeFailure =
	| "multiple-subpaths"
	| "open-contour"
	| "zero-area"
	| "non-finite"
	| "self-intersecting";

type WarpShapeResult =
	| { ok: true; geometry: WarpGeometry }
	| { ok: false; reason: WarpShapeFailure };

/**
 * Build a warp cage whose outer boundary is `segments` and whose source grid
 * spans `contentBounds`. `segments` must describe one closed sub-path with
 * relative control points, as stored on a Path.
 */
export function buildWarpGeometryFromContour(
	segments: CubicBezierSegment[],
	contentBounds: BoundingBox,
): WarpShapeResult {
	const contour = resolveContour(segments);
	if (!contour.ok) return contour;

	const corners = pickCorners(contour.curves);
	if (!corners) return { ok: false, reason: "zero-area" };
	const [bl, br, tr, tl] = corners;
	const bottom = buildChain(sliceContour(contour.curves, bl, br));
	const right = buildChain(sliceContour(contour.curves, br, tr));
	const top = buildChain(reverseCurves(sliceContour(contour.curves, tr, tl)));
	const left = buildChain(reverseCurves(sliceContour(contour.curves, tl, bl)));

	const us = mergeBreaks(bottom.breaks, top.breaks);
	const vs = mergeBreaks(left.breaks, right.breaks);
	const p00 = evalChain(bottom, 0);
	const p10 = evalChain(bottom, 1);
	const p01 = evalChain(top, 0);
	const p11 = evalChain(top, 1);
	const coons = (u: number, v: number): Point => {
		const b = evalChain(bottom, u);
		const t = evalChain(top, u);
		const l = evalChain(left, v);
		const r = evalChain(right, v);
		const mu = 1 - u;
		const mv = 1 - v;
		return {
			x:
				mv * b.x +
				v * t.x +
				mu * l.x +
				u * r.x -
				(mu * mv * p00.x + u * mv * p10.x + u * v * p11.x + mu * v * p01.x),
			y:
				mv * b.y +
				v * t.y +
				mu * l.y +
				u * r.y -
				(mu * mv * p00.y + u * mv * p10.y + u * v * p11.y + mu * v * p01.y),
		};
	};

	const nu = us.length;
	const nv = vs.length;
	const index = (i: number, j: number): number => j * nu + i;
	const vertices: MeshGeometryVertex[] = [];
	for (let j = 0; j < nv; j++) {
		for (let i = 0; i < nu; i++) {
			const p = coons(us[i], vs[j]);
			vertices.push({
				x: p.x,
				y: p.y,
				src: {
					x: contentBounds.minX + us[i] * contentBounds.width,
					y: contentBounds.minY + vs[j] * contentBounds.height,
				},
				handles: {},
			});
		}
	}

	const setEdge = (a: number, b: number, curve: CubicCurve): void => {
		vertices[a].handles[b] = { x: curve[1].x, y: curve[1].y };
		vertices[b].handles[a] = { x: curve[2].x, y: curve[2].y };
	};
	for (let j = 0; j < nv; j++) {
		for (let i = 0; i < nu - 1; i++) {
			const curve =
				j === 0
					? chainInterval(bottom, us[i], us[i + 1])
					: j === nv - 1
						? chainInterval(top, us[i], us[i + 1])
						: fitCubic((k) => coons(us[i] + (us[i + 1] - us[i]) * k, vs[j]));
			setEdge(index(i, j), index(i + 1, j), curve);
		}
	}
	for (let i = 0; i < nu; i++) {
		for (let j = 0; j < nv - 1; j++) {
			const curve =
				i === 0
					? chainInterval(left, vs[j], vs[j + 1])
					: i === nu - 1
						? chainInterval(right, vs[j], vs[j + 1])
						: fitCubic((k) => coons(us[i], vs[j] + (vs[j + 1] - vs[j]) * k));
			setEdge(index(i, j), index(i, j + 1), curve);
		}
	}

	const faces: MeshFace[] = [];
	for (let j = 0; j < nv - 1; j++) {
		for (let i = 0; i < nu - 1; i++) {
			faces.push({
				type: "quad",
				verts: [
					index(i, j),
					index(i + 1, j),
					index(i + 1, j + 1),
					index(i, j + 1),
				],
			});
		}
	}
	return { ok: true, geometry: { vertices, faces } };
}

/**
 * Reuse an existing cage for new content: keep every vertex and face, and map
 * the source grid linearly from the old source extent onto `contentBounds`.
 */
export function remapWarpGeometrySrc(
	mesh: MeshArtObject,
	contentBounds: BoundingBox,
): WarpGeometry | null {
	const { vertices, faces } = mesh;
	if (vertices.length === 0) return null;
	const validIndex = (i: number): boolean =>
		Number.isInteger(i) && i >= 0 && i < vertices.length;
	if (!faces.every((face) => face.verts.every(validIndex))) return null;

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const { src } of vertices) {
		minX = Math.min(minX, src.x);
		minY = Math.min(minY, src.y);
		maxX = Math.max(maxX, src.x);
		maxY = Math.max(maxY, src.y);
	}
	const width = maxX - minX;
	const height = maxY - minY;
	if (!(width > 0) || !(height > 0)) return null;

	return {
		vertices: vertices.map((vertex) => ({
			...deepClone(vertex),
			src: {
				x:
					contentBounds.minX +
					((vertex.src.x - minX) / width) * contentBounds.width,
				y:
					contentBounds.minY +
					((vertex.src.y - minY) / height) * contentBounds.height,
			},
		})),
		faces: deepClone(faces),
	};
}

/** Map every vertex position and handle through `map`, leaving `src` alone. */
export function mapWarpGeometryPositions(
	geometry: WarpGeometry,
	map: (p: Point) => Point,
): WarpGeometry {
	return {
		vertices: geometry.vertices.map((vertex) => {
			const p = map(vertex);
			return {
				...vertex,
				x: p.x,
				y: p.y,
				handles: Object.fromEntries(
					Object.entries(vertex.handles).map(([key, handle]) => [
						key,
						map(handle),
					]),
				),
			};
		}),
		faces: geometry.faces,
	};
}

// --- Contour resolution ---

const POINT_EPSILON = 1e-9;
const AREA_EPSILON = 1e-6;
const PARAM_EPSILON = 1e-6;
const AREA_SAMPLES = 16;
const CORNER_CANDIDATES_PER_CORNER = 8;

interface ContourParam {
	curve: number;
	t: number;
}

function resolveContour(
	segments: CubicBezierSegment[],
):
	| { ok: true; curves: CubicCurve[] }
	| { ok: false; reason: WarpShapeFailure } {
	if (segments.length === 0 || segments[0].start === undefined) {
		return { ok: false, reason: "open-contour" };
	}
	const curves: CubicCurve[] = [];
	let prevEnd: BezierPoint | undefined;
	for (const [i, segment] of segments.entries()) {
		if (i > 0 && (segment.start !== undefined || segment.isMoved)) {
			return { ok: false, reason: "multiple-subpaths" };
		}
		const abs = resolveSegment(segment, prevEnd);
		prevEnd = segment.end;
		curves.push(
			[abs.start, abs.cp1, abs.cp2, abs.end].map(toPoint) as CubicCurve,
		);
	}
	if (!curves.every((curve) => curve.every(isFinitePoint))) {
		return { ok: false, reason: "non-finite" };
	}

	const first = curves[0][0];
	const last = curves[curves.length - 1][3];
	if (!samePoint(first, last)) {
		if (!segments[segments.length - 1].isClosed) {
			return { ok: false, reason: "open-contour" };
		}
		curves.push(lineCurve(last, first));
	}

	const kept = curves.filter((curve) => !isDegenerateCurve(curve));
	if (isSelfIntersecting(kept))
		return { ok: false, reason: "self-intersecting" };
	const area = signedArea(kept);
	if (Math.abs(area) < AREA_EPSILON) return { ok: false, reason: "zero-area" };
	return { ok: true, curves: area < 0 ? reverseCurves(kept) : kept };
}

function isSelfIntersecting(curves: CubicCurve[]): boolean {
	if (curves.some(hasSelfLoop)) return true;
	const n = curves.length;
	if (n < 2) return false;
	const segments = cubicSegmentsToContour(
		curvesToSegments(curves),
		new GeometryEpsilon(),
	);
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const hit = segmentsIntersect(segments[i], segments[j], false);
			if (!hit) continue;
			if (hit.kind === "tRangePairs") return true;
			const jFollowsI = j === i + 1;
			const iFollowsJ = i === 0 && j === n - 1;
			for (const [ti, tj] of hit.tValuePairs) {
				if (jFollowsI && ti > 1 - PARAM_EPSILON && tj < PARAM_EPSILON) continue;
				if (iFollowsJ && ti < PARAM_EPSILON && tj > 1 - PARAM_EPSILON) continue;
				return true;
			}
		}
	}
	return false;
}

/**
 * Whether one cubic crosses itself inside t ∈ (0, 1). In the canonical frame
 * (P0 at the origin, P1 at (0, 1), P2 at (1, 1)) the loop region lies below
 * the cusp parabola and above the boundaries where the loop leaves the
 * parameter range.
 */
function hasSelfLoop(curve: CubicCurve): boolean {
	const [p0, p1, p2, p3] = curve;
	const x1 = p1.x - p0.x;
	const y1 = p1.y - p0.y;
	const x2 = p2.x - p0.x;
	const y2 = p2.y - p0.y;
	const x3 = p3.x - p0.x;
	const y3 = p3.y - p0.y;
	const det = x1 * y2 - x2 * y1;
	if (Math.abs(det) < POINT_EPSILON) return false;
	const a = (x3 * y2 - x2 * y3) / det;
	const b = (x1 * y3 - x3 * y1) / det;
	const x = b;
	const y = a + b;
	if (x >= 1) return false;
	const cusp = (-x * x + 2 * x + 3) / 4;
	if (y >= cusp) return false;
	const lower =
		x <= 0 ? (-x * x + 3 * x) / 3 : (Math.sqrt(3 * (4 * x - x * x)) - x) / 2;
	return y > lower;
}

// --- Corner selection ---

/**
 * Pick the contour parameters that become the bottom-left, bottom-right,
 * top-right and top-left cage corners, in contour order.
 */
function pickCorners(
	curves: CubicCurve[],
): [ContourParam, ContourParam, ContourParam, ContourParam] | null {
	const bounds = curvesBounds(curves);
	const width = bounds.maxX - bounds.minX || 1;
	const height = bounds.maxY - bounds.minY || 1;
	const normalized = curves.map(
		(curve) =>
			curve.map((p) => ({
				x: (p.x - bounds.minX) / width,
				y: (p.y - bounds.minY) / height,
			})) as CubicCurve,
	);
	const targets: Point[] = [
		{ x: 0, y: 0 },
		{ x: 1, y: 0 },
		{ x: 1, y: 1 },
		{ x: 0, y: 1 },
	];

	const raw: ContourParam[] = [];
	for (const [i, curve] of normalized.entries()) {
		raw.push({ curve: i, t: 0 });
		for (const target of targets) {
			raw.push({ curve: i, t: findClosestCurveT(curve, target.x, target.y) });
		}
	}
	raw.push(...arcLengthQuarterPoints(curves));
	const candidates = dedupeParams(raw, curves.length);

	const positions = candidates.map((c) => evalCurve(normalized[c.curve], c.t));
	const ranked = targets.map((target) =>
		candidates
			.map((_, index) => ({ index, dist: distance2(positions[index], target) }))
			.sort((a, b) => a.dist - b.dist || a.index - b.index)
			.slice(0, CORNER_CANDIDATES_PER_CORNER),
	);

	let best: number[] | null = null;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const a of ranked[0]) {
		for (const b of ranked[1]) {
			for (const c of ranked[2]) {
				for (const d of ranked[3]) {
					const combo = [a.index, b.index, c.index, d.index];
					if (!isCyclicallyIncreasing(combo)) continue;
					const score = a.dist + b.dist + c.dist + d.dist;
					if (score < bestScore) {
						bestScore = score;
						best = combo;
					}
				}
			}
		}
	}
	if (!best) return null;
	return best.map((index) => candidates[index]) as [
		ContourParam,
		ContourParam,
		ContourParam,
		ContourParam,
	];
}

function arcLengthQuarterPoints(curves: CubicCurve[]): ContourParam[] {
	const table = buildArcLengthTable(curvesToSegments(curves));
	const total = table[table.length - 1].cumulativeLength;
	if (!(total > 0)) return [];
	const result: ContourParam[] = [];
	for (let q = 1; q < 4; q++) {
		const target = (total * q) / 4;
		const entry =
			table.find((e) => e.cumulativeLength >= target) ??
			table[table.length - 1];
		result.push({ curve: entry.segmentIndex, t: entry.localT });
	}
	return result;
}

function curvesToSegments(curves: CubicCurve[]): CubicBezierSegment[] {
	return curves.map(([p0, p1, p2, p3], i) => ({
		start: i === 0 ? { ...p0 } : undefined,
		cp1: toRelativeCP1({ ...p1 }, p0),
		cp2: toRelativeCP2({ ...p2 }, p3),
		end: { ...p3 },
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: false,
	}));
}

/** Sort by contour order, fold t≈1 onto the next curve's t=0, and drop repeats. */
function dedupeParams(
	params: ContourParam[],
	curveCount: number,
): ContourParam[] {
	const folded = params.map((p) =>
		p.t > 1 - PARAM_EPSILON ? { curve: (p.curve + 1) % curveCount, t: 0 } : p,
	);
	folded.sort((a, b) => a.curve - b.curve || a.t - b.t);
	const result: ContourParam[] = [];
	for (const p of folded) {
		const prev = result[result.length - 1];
		if (
			prev &&
			prev.curve === p.curve &&
			Math.abs(prev.t - p.t) < PARAM_EPSILON
		)
			continue;
		result.push(p);
	}
	return result;
}

/** True when the values are distinct and increase around the cycle with one wrap. */
function isCyclicallyIncreasing(values: number[]): boolean {
	let descents = 0;
	for (let i = 0; i < values.length; i++) {
		const a = values[i];
		const b = values[(i + 1) % values.length];
		if (a === b) return false;
		if (b < a) descents++;
	}
	return descents === 1;
}

// --- Chains ---

interface Chain {
	pieces: CubicCurve[];
	/** Cumulative parameter at each piece start, ending with 1. */
	breaks: number[];
}

/** Sub-curves of the contour from `from` forward to `to`, in contour order. */
function sliceContour(
	curves: CubicCurve[],
	from: ContourParam,
	to: ContourParam,
): CubicCurve[] {
	const n = curves.length;
	if (from.curve === to.curve && from.t < to.t) {
		return [getCurveInterval(curves[from.curve], from.t, to.t)];
	}
	const pieces: CubicCurve[] = [];
	if (from.t < 1) pieces.push(getCurveInterval(curves[from.curve], from.t, 1));
	for (let i = (from.curve + 1) % n; i !== to.curve; i = (i + 1) % n) {
		pieces.push(curves[i]);
	}
	if (to.t > 0) pieces.push(getCurveInterval(curves[to.curve], 0, to.t));
	return pieces.filter((piece) => !isDegenerateCurve(piece));
}

function buildChain(pieces: CubicCurve[]): Chain {
	const ends = new Array<number>(pieces.length).fill(0);
	for (const entry of buildArcLengthTable(curvesToSegments(pieces))) {
		ends[entry.segmentIndex] = entry.cumulativeLength;
	}
	const total = ends[ends.length - 1] ?? 0;
	const breaks = [0];
	for (const [i, end] of ends.entries()) {
		breaks.push(total > 0 ? end / total : (i + 1) / pieces.length);
	}
	breaks[breaks.length - 1] = 1;
	return { pieces, breaks };
}

function locatePiece(chain: Chain, s: number): number {
	const last = chain.pieces.length - 1;
	for (let k = 0; k < last; k++) {
		if (s < chain.breaks[k + 1]) return k;
	}
	return last;
}

function evalChain(chain: Chain, s: number): Point {
	const k = locatePiece(chain, s);
	const span = chain.breaks[k + 1] - chain.breaks[k];
	const t = span > 0 ? (s - chain.breaks[k]) / span : 0;
	return evalCurve(chain.pieces[k], Math.max(0, Math.min(1, t)));
}

/** The chain's cubic between parameters `s0` and `s1`, which never straddle a break. */
function chainInterval(chain: Chain, s0: number, s1: number): CubicCurve {
	const k = locatePiece(chain, (s0 + s1) / 2);
	const span = chain.breaks[k + 1] - chain.breaks[k];
	const t0 = span > 0 ? (s0 - chain.breaks[k]) / span : 0;
	const t1 = span > 0 ? (s1 - chain.breaks[k]) / span : 1;
	return getCurveInterval(
		chain.pieces[k],
		Math.max(0, Math.min(1, t0)),
		Math.max(0, Math.min(1, t1)),
	);
}

function mergeBreaks(a: number[], b: number[]): number[] {
	const sorted = [...a, ...b].sort((x, y) => x - y);
	const result: number[] = [];
	for (const value of sorted) {
		const prev = result[result.length - 1];
		if (prev !== undefined && value - prev < PARAM_EPSILON) continue;
		result.push(value);
	}
	return result;
}

/** Cubic through the samples of `at` at k = 0, 1/3, 2/3, 1. */
function fitCubic(at: (k: number) => Point): CubicCurve {
	const p0 = at(0);
	const q1 = at(1 / 3);
	const q2 = at(2 / 3);
	const p3 = at(1);
	return [
		p0,
		{
			x: (18 * q1.x - 9 * q2.x - 5 * p0.x + 2 * p3.x) / 6,
			y: (18 * q1.y - 9 * q2.y - 5 * p0.y + 2 * p3.y) / 6,
		},
		{
			x: (-9 * q1.x + 18 * q2.x + 2 * p0.x - 5 * p3.x) / 6,
			y: (-9 * q1.y + 18 * q2.y + 2 * p0.y - 5 * p3.y) / 6,
		},
		p3,
	];
}

// --- Curve helpers ---

function toPoint(p: Point): Point {
	return { x: p.x, y: p.y };
}

function isFinitePoint(p: Point): boolean {
	return Number.isFinite(p.x) && Number.isFinite(p.y);
}

function samePoint(a: Point, b: Point): boolean {
	return (
		Math.abs(a.x - b.x) < POINT_EPSILON && Math.abs(a.y - b.y) < POINT_EPSILON
	);
}

function distance2(a: Point, b: Point): number {
	return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function lineCurve(a: Point, b: Point): CubicCurve {
	return [toPoint(a), toPoint(a), toPoint(b), toPoint(b)];
}

function isDegenerateCurve(curve: CubicCurve): boolean {
	return curve.every((p) => samePoint(p, curve[0]));
}

function evalCurve(curve: CubicCurve, t: number): Point {
	return cubicBez(curve[0], curve[1], curve[2], curve[3], t);
}

function reverseCurves(curves: CubicCurve[]): CubicCurve[] {
	return curves
		.map((curve): CubicCurve => [curve[3], curve[2], curve[1], curve[0]])
		.reverse();
}

function signedArea(curves: CubicCurve[]): number {
	let area = 0;
	for (const curve of curves) {
		let prev = curve[0];
		for (let i = 1; i <= AREA_SAMPLES; i++) {
			const p = evalCurve(curve, i / AREA_SAMPLES);
			area += prev.x * p.y - p.x * prev.y;
			prev = p;
		}
	}
	return area / 2;
}

function curvesBounds(curves: CubicCurve[]): BoundingBox {
	return (
		calculateSegmentListBounds(curvesToSegments(curves)) ?? {
			minX: 0,
			minY: 0,
			maxX: 0,
			maxY: 0,
			width: 0,
			height: 0,
		}
	);
}
