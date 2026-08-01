import earcut from "earcut";
import polygonClipping, {
	type MultiPolygon,
	type Polygon,
	type Ring,
} from "polygon-clipping";
import type { CubicBezierSegment } from "../../schema";
import { splitIntoSubPaths } from "../canvas/CanvasLayer.helpers";
import { flattenBezierPath } from "./bezierFlatten";

/**
 * Pure-CPU extrusion mesh builder.
 *
 * Pipeline: adaptive flattening of each sub-path (existing bezier
 * flattener, tolerance scaled by the resolution bucket) → normalization via
 * polygon-clipping (self-intersections resolved up front; counter-wound
 * sub-paths cut holes out of dominant-wound outers) → earcut triangulation
 * of the front cap with holes (z = 0) and the back cap (z = -depth, winding
 * reversed) → side quads with outward normals, smoothed across adjacent
 * edges below the smoothing angle → optional rounded cap-edge bevels built
 * from corner-bisector insets with a quarter-circle profile.
 */
export interface ExtrudeMeshData {
	/**
	 * Interleaved [px, py, pz, nx, ny, nz, u, v, u2, v2] per vertex.
	 * (u,v) = baked-fill UV (planar projection over bounds2d). (u2,v2) = the
	 * per-face surface-wrap UV in world units for a tiled material pattern:
	 * caps carry world (x, -y); side/bevel walls carry (arc length around the
	 * ring, depth position from the front cap).
	 */
	vertices: Float32Array;
	indices: Uint32Array;
	/**
	 * 2D bounds of the normalized PROFILE outline (world units, pre-rotation)
	 * — the box the baked albedo covers and the fill UV projects over. For an
	 * extrusion this equals the solid's XY extent; a revolved solid grows past
	 * it (see bounds3d).
	 */
	bounds2d: { minX: number; minY: number; maxX: number; maxY: number };
	/**
	 * 3D bounds of the generated solid (world units, pre-rotation). Drives the
	 * projected-bounds/offscreen sizing in the baker. Extrusion: bounds2d ×
	 * z ∈ [-depth, 0]. Revolve: min/max over every generated vertex (the sweep
	 * extends past the profile in both X and Z).
	 */
	bounds3d: {
		minX: number;
		minY: number;
		minZ: number;
		maxX: number;
		maxY: number;
		maxZ: number;
	};
}

/** Number of floats per vertex (position + normal + fill uv + wrap uv). */
export const EXTRUDE_VERTEX_FLOATS = 10;

const MIN_RING_AREA = 1e-6;
/** Adjacent side edges within this angle share smoothed vertex normals. */
const SMOOTH_NORMAL_ANGLE_RAD = (30 * Math.PI) / 180;
const SMOOTH_NORMAL_DOT = Math.cos(SMOOTH_NORMAL_ANGLE_RAD);
/** Clamp for the corner-bisector inset length at sharp corners. */
const BEVEL_MITER_LIMIT = 2;
const ROUND_BEVEL_PROFILE_SEGMENTS = 16;
/** Guardrail for lengthwise bevel subdivisions on very long outline edges. */
const MAX_EDGE_SUBDIVISIONS = 64;

export function buildExtrudeMesh(args: {
	segments: CubicBezierSegment[];
	depth: number;
	/** Flattening tolerance in world units. Default 0.25. */
	tolerance?: number;
	/** Rounded cap-edge bevel radius in world units. 0/absent = hard edges. */
	bevelSize?: number;
	/**
	 * Pull wall/bevel UV sample points this far (world units) inward along
	 * the outward XY normal. Wall vertices sit exactly on the outline, where
	 * the baked fill's antialiased coverage ramps to 0 — sampling there makes
	 * walls semi-transparent. Cap UVs (pure ±Z normals) are unaffected.
	 * Default 0.
	 */
	uvInset?: number;
	/**
	 * Store vertex positions relative to the outline center instead of in
	 * absolute (world) coordinates. A group extrude carries world positions,
	 * and multiplying large world coordinates by the mvp in fp32 loses the
	 * depth bits (catastrophic cancellation) — non-overlapping children then
	 * quantize to the same depth and fall back to draw (layer) order. The
	 * renderer post-multiplies the mvp by T(center) to place them back in
	 * world. bounds2d, fill UV, and wrap uv2 stay in world regardless.
	 * Default false (positions in world; used by tests).
	 */
	rebaseToCenter?: boolean;
}): ExtrudeMeshData | null {
	if (args.depth <= 0) return null;

	const polygons = normalizeOutline(args.segments, args.tolerance ?? 0.25);
	if (polygons.length === 0) return null;

	const positions: number[] = [];
	const normals: number[] = [];
	// Per-face surface-wrap UV (world units), 2 per vertex, index-aligned with
	// positions. Emitted inline during assembly because side walls need the
	// ring arc length, which a vertex's XY position can't reconstruct.
	const uv2: number[] = [];
	const indices: number[] = [];
	const depth = args.depth;
	// The bevel eats into the depth from both caps — keep a sliver of
	// straight side wall so the profile stays well-formed.
	const bevelSize = Math.min(Math.max(args.bevelSize ?? 0, 0), depth * 0.499);
	const roundBevelProfileSegments =
		bevelSize > 1e-6 ? ROUND_BEVEL_PROFILE_SEGMENTS : 1;

	// Outline bounds — used by both the fill UV and the back-cap wrap mirror, so
	// compute them before assembly (appendPolygon mirrors back-cap uv2 about the
	// outline's X center).
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const polygon of polygons) {
		for (const ring of polygon) {
			for (const [x, y] of ring) {
				minX = Math.min(minX, x);
				minY = Math.min(minY, y);
				maxX = Math.max(maxX, x);
				maxY = Math.max(maxY, y);
			}
		}
	}
	const centerX2 = minX + maxX;
	// Optional position rebase to the outline center (see the rebaseToCenter
	// arg). UV/uv2 below use world sx/sy, so only the stored position shifts.
	const offsetX = args.rebaseToCenter ? centerX2 / 2 : 0;
	const offsetY = args.rebaseToCenter ? (minY + maxY) / 2 : 0;

	for (const polygon of polygons) {
		appendPolygon(
			polygon,
			depth,
			bevelSize,
			roundBevelProfileSegments,
			centerX2,
			positions,
			normals,
			uv2,
			indices,
		);
	}
	if (indices.length === 0) return null;

	// Bake the fill-texture UV per vertex. The baked fill is rasterized over
	// bounds2d through the offscreen convention (world y-up → texel v-down,
	// see OffscreenPresenter.createOffscreenPass / blit.wgsl.ts), so absorb the
	// Y flip here: u = (x - minX)/w, v = (maxY - y)/h. Front and back caps use
	// the SAME u so each shape's back samples its own fill at the same XY — a
	// group-bounds X mirror on the back cap would map a child's back onto a
	// different child in a multi-child group; the visual left/right flip when
	// the solid is rotated to show its back comes from the geometry itself.
	// Wall/bevel UVs are pulled `uvInset` inward along the outward XY normal so
	// they sample the fill just inside the outline instead of on its antialiased
	// edge (caps have zero XY normal and stay put). Degenerate bounds collapse
	// to u/v = 0 (no NaN).
	const invW = maxX > minX ? 1 / (maxX - minX) : 0;
	const invH = maxY > minY ? 1 / (maxY - minY) : 0;
	const uvInset = args.uvInset ?? 0;

	const vertexCount = positions.length / 3;
	const vertices = new Float32Array(vertexCount * EXTRUDE_VERTEX_FLOATS);
	for (let i = 0; i < vertexCount; i++) {
		const px = positions[i * 3];
		const py = positions[i * 3 + 1];
		const nx = normals[i * 3];
		const ny = normals[i * 3 + 1];
		const nz = normals[i * 3 + 2];
		let sx = px;
		let sy = py;
		if (uvInset > 0) {
			const xyLen = Math.hypot(nx, ny);
			if (xyLen > 1e-6) {
				sx -= (nx / xyLen) * uvInset;
				sy -= (ny / xyLen) * uvInset;
			}
		}
		const u = (sx - minX) * invW;
		const v = (maxY - sy) * invH;
		const o = i * EXTRUDE_VERTEX_FLOATS;
		vertices[o] = px - offsetX;
		vertices[o + 1] = py - offsetY;
		vertices[o + 2] = positions[i * 3 + 2];
		vertices[o + 3] = nx;
		vertices[o + 4] = ny;
		vertices[o + 5] = nz;
		vertices[o + 6] = Math.min(Math.max(u, 0), 1);
		vertices[o + 7] = Math.min(Math.max(v, 0), 1);
		// Surface-wrap UV (world units, not normalized/clamped — the shader
		// divides by the tile size and repeat-samples).
		vertices[o + 8] = uv2[i * 2];
		vertices[o + 9] = uv2[i * 2 + 1];
	}

	return {
		vertices,
		indices: new Uint32Array(indices),
		bounds2d: { minX, minY, maxX, maxY },
		// An extrusion never leaves the profile's XY box; it only sweeps -Z.
		bounds3d: { minX, minY, minZ: -depth, maxX, maxY, maxZ: 0 },
	};
}

// ---------------------------------------------------------------------------
// Outline normalization
// ---------------------------------------------------------------------------

/**
 * Flatten sub-paths into rings and normalize with polygon-clipping:
 * rings wound with the dominant direction of the outline are unioned into
 * the solid, counter-wound rings are subtracted as holes, and
 * self-intersections are resolved by the boolean pass itself. Classifying
 * against the dominant direction (sign of the total signed area) instead of
 * a fixed CCW=solid rule keeps parity with fill's nonzero rule: an outline
 * drawn entirely clockwise still extrudes its painted region. Output
 * polygons are [outer, ...holes] with closed rings (outer CCW, holes CW).
 * Shared with the revolve mesh builder (same profile normalization).
 */
export function normalizeOutline(
	segments: CubicBezierSegment[],
	tolerance: number,
): MultiPolygon {
	const rated: { ring: Ring; area: number }[] = [];
	const zeroAreaRings: Ring[] = [];
	let totalArea = 0;

	for (const subPath of splitIntoSubPaths(segments)) {
		const flat = flattenBezierPath(subPath, { curveTolerance: tolerance });
		const ring: Ring = [];
		for (let i = 0; i + 1 < flat.length; i += 2) {
			ring.push([flat[i], flat[i + 1]]);
		}
		// Drop the duplicated closing point; polygon-clipping closes rings.
		if (
			ring.length > 1 &&
			ring[0][0] === ring[ring.length - 1][0] &&
			ring[0][1] === ring[ring.length - 1][1]
		) {
			ring.pop();
		}
		if (ring.length < 3) continue;

		const area = signedArea(ring);
		if (Math.abs(area) < MIN_RING_AREA) {
			zeroAreaRings.push(ring);
			continue;
		}
		rated.push({ ring, area });
		totalArea += area;
	}

	const dominantSign = totalArea >= 0 ? 1 : -1;
	const solids: MultiPolygon = [];
	const cuts: MultiPolygon = [];
	for (const { ring, area } of rated) {
		(area * dominantSign > 0 ? solids : cuts).push([ring]);
	}
	for (const ring of zeroAreaRings) {
		// Self-intersecting rings can cancel to zero signed area (e.g. a
		// symmetric bowtie) — normalize them in isolation; the boolean pass
		// splits the crossing edges and recovers the actual lobes.
		try {
			solids.push(...polygonClipping.union([ring]));
		} catch {
			// Truly degenerate ring — skip it.
		}
	}
	if (solids.length === 0) return [];

	try {
		const union = polygonClipping.union(solids[0], ...solids.slice(1));
		if (cuts.length === 0) return union;
		return polygonClipping.difference(union, ...cuts);
	} catch {
		// Degenerate inputs (e.g. zero-width slivers) can throw deep inside the
		// boolean pass — treat the outline as empty rather than crash a frame.
		return [];
	}
}

function signedArea(ring: readonly (readonly [number, number])[]): number {
	let area = 0;
	for (let i = 0; i < ring.length; i++) {
		const [x1, y1] = ring[i];
		const [x2, y2] = ring[(i + 1) % ring.length];
		area += x1 * y2 - x2 * y1;
	}
	return area / 2;
}

// ---------------------------------------------------------------------------
// Mesh assembly
// ---------------------------------------------------------------------------

/** Per-ring geometry pre-computed for wall/bevel generation. Shared with the
 *  revolve mesh builder (profile edge normals + arc length). */
export interface RingGeometry {
	/** Open ring points (consecutive duplicates removed). */
	points: [number, number][];
	/** Outward unit normal of edge i→i+1 (in the ring's XY plane). */
	edgeNormals: [number, number][];
	/** Length of edge i→i+1. */
	edgeLengths: number[];
	/** Averaged outward unit normal at vertex i. */
	vertexNormals: [number, number][];
	/** Whether the corner at vertex i smooths across its two edges. */
	smooth: boolean[];
	/** Corner bisector scaled by the miter factor (unit inset direction × scale). */
	insetDirs: [number, number][];
	/** Arc length from point 0 to point i along the ring (cumLen[0] = 0). */
	cumLen: number[];
	/** Total ring perimeter (arc length of the closing edge lands here). */
	perimeter: number;
}

interface RingStation {
	points: [number, number][];
	normals: [number, number][];
	u: number[];
	perimeter: number;
}

function appendPolygon(
	polygon: Polygon,
	depth: number,
	bevelSize: number,
	roundBevelProfileSegments: number,
	centerX2: number,
	positions: number[],
	normals: number[],
	uv2: number[],
	indices: number[],
): void {
	const ringGeoms: RingGeometry[] = [];
	for (const ring of polygon) {
		const geom = computeRingGeometry(openRing(ring));
		if (geom) ringGeoms.push(geom);
	}
	if (ringGeoms.length === 0) return;

	if (bevelSize > 1e-6) {
		const ok = appendBevelledSolid(
			ringGeoms,
			depth,
			bevelSize,
			roundBevelProfileSegments,
			centerX2,
			positions,
			normals,
			uv2,
			indices,
		);
		if (ok) return;
		// Inset collapsed the caps entirely — fall back to hard edges rather
		// than emitting an open tube.
	}
	appendHardEdgedSolid(
		ringGeoms,
		depth,
		centerX2,
		positions,
		normals,
		uv2,
		indices,
	);
}

/** Caps at z=0/-depth plus straight side walls (no bevel). */
function appendHardEdgedSolid(
	ringGeoms: RingGeometry[],
	depth: number,
	centerX2: number,
	positions: number[],
	normals: number[],
	uv2: number[],
	indices: number[],
): void {
	appendCaps(
		ringGeoms.map((g) => g.points),
		0,
		-depth,
		centerX2,
		positions,
		normals,
		uv2,
		indices,
	);
	for (const geom of ringGeoms) {
		appendBand(
			geom,
			0,
			0,
			0,
			-depth,
			0,
			0,
			1,
			0,
			1,
			0,
			false,
			0,
			positions,
			normals,
			uv2,
			indices,
		);
	}
}

/**
 * Rounded-bevel solid: inset caps, quarter-circle bevel bands on both cap
 * edges, and a straight side wall in between. Returns false when the inset
 * cap outline collapses (caller falls back to hard edges).
 */
function appendBevelledSolid(
	ringGeoms: RingGeometry[],
	depth: number,
	size: number,
	segments: number,
	centerX2: number,
	positions: number[],
	normals: number[],
	uv2: number[],
	indices: number[],
): boolean {
	// Caps: inset the outline by the bevel radius and clean self-crossings
	// (tight corners can fold the inset ring over itself).
	const insetPolygon = ringGeoms.map((geom) =>
		geom.points.map((_, i) => insetPoint(geom, i, size)),
	) as Polygon;
	let capPolygons: MultiPolygon;
	try {
		capPolygons = polygonClipping.union([insetPolygon]);
	} catch {
		capPolygons = [];
	}
	if (capPolygons.length === 0) return false;

	for (const polygon of capPolygons) {
		appendCaps(
			polygon.map(openRing).filter((r) => r.length >= 3),
			0,
			-depth,
			centerX2,
			positions,
			normals,
			uv2,
			indices,
		);
	}

	for (const geom of ringGeoms) {
		for (let k = 0; k < segments; k++) {
			const thetaA = (k / segments) * (Math.PI / 2);
			const thetaB = ((k + 1) / segments) * (Math.PI / 2);
			const insetA = size * (1 - Math.sin(thetaA));
			const insetB = size * (1 - Math.sin(thetaB));
			const zA = -size * (1 - Math.cos(thetaA));
			const zB = -size * (1 - Math.cos(thetaB));

			// Front bevel band (cap edge at z=0 → side wall at z=-size).
			appendBand(
				geom,
				insetA,
				zA,
				insetB,
				zB,
				size * Math.sin(thetaA),
				size * Math.sin(thetaB),
				Math.sin(thetaA),
				Math.cos(thetaA),
				Math.sin(thetaB),
				Math.cos(thetaB),
				false,
				size,
				positions,
				normals,
				uv2,
				indices,
			);
			// Back bevel band: z-mirrored, so normals flip in Z and the
			// winding reverses to stay outward-facing.
			appendBand(
				geom,
				insetA,
				-depth - zA,
				insetB,
				-depth - zB,
				size * Math.sin(thetaA),
				size * Math.sin(thetaB),
				Math.sin(thetaA),
				-Math.cos(thetaA),
				Math.sin(thetaB),
				-Math.cos(thetaB),
				true,
				size,
				positions,
				normals,
				uv2,
				indices,
			);
		}
		// Straight side wall between the two bevels.
		appendBand(
			geom,
			0,
			-size,
			0,
			-(depth - size),
			size,
			size,
			1,
			0,
			1,
			0,
			false,
			size,
			positions,
			normals,
			uv2,
			indices,
		);
	}
	return true;
}

/**
 * Earcut-triangulate a cap polygon ([outer, ...holes] open rings) into a flat
 * point list + triangle indices into it. Null when degenerate. Shared with
 * the revolve mesh builder (partial-sweep end caps).
 */
export function triangulateCapRings(
	rings: [number, number][][],
): { flat: number[]; triangles: number[] } | null {
	if (rings.length === 0 || rings[0].length < 3) return null;

	// Earcut input: outer ring followed by holes, with hole start offsets.
	const flat: number[] = [];
	const holeIndices: number[] = [];
	for (let r = 0; r < rings.length; r++) {
		if (r > 0) holeIndices.push(flat.length / 2);
		for (const [x, y] of rings[r]) flat.push(x, y);
	}
	const triangles = earcut(flat, holeIndices);
	if (triangles.length === 0) return null;
	return { flat, triangles };
}

/** Front (z=zFront, +Z) and back (z=zBack, -Z, reversed) caps via earcut. */
function appendCaps(
	rings: [number, number][][],
	zFront: number,
	zBack: number,
	centerX2: number,
	positions: number[],
	normals: number[],
	uv2: number[],
	indices: number[],
): void {
	const triangulated = triangulateCapRings(rings);
	if (!triangulated) return;
	const { flat, triangles: capTriangles } = triangulated;

	const pointCount = flat.length / 2;

	// Cap wrap UV = world (x, -y). The back cap mirrors X about the outline
	// center so a surface pattern reads upright when the solid faces from
	// behind. (The fill UV, by contrast, is not mirrored — see the final
	// assembly — so each child's back samples its own fill rather than a
	// horizontally-opposite child's in a multi-child group.)
	const frontBase = positions.length / 3;
	for (let i = 0; i < pointCount; i++) {
		positions.push(flat[i * 2], flat[i * 2 + 1], zFront);
		normals.push(0, 0, 1);
		uv2.push(flat[i * 2], -flat[i * 2 + 1]);
	}
	for (const index of capTriangles) {
		indices.push(frontBase + index);
	}

	const backBase = positions.length / 3;
	for (let i = 0; i < pointCount; i++) {
		positions.push(flat[i * 2], flat[i * 2 + 1], zBack);
		normals.push(0, 0, -1);
		uv2.push(centerX2 - flat[i * 2], -flat[i * 2 + 1]);
	}
	for (let t = 0; t < capTriangles.length; t += 3) {
		indices.push(
			backBase + capTriangles[t],
			backBase + capTriangles[t + 2],
			backBase + capTriangles[t + 1],
		);
	}
}

/**
 * One band of quads around a ring between two profile stations (A → B).
 * Station A is emitted first (matches the z=0-row-first wall convention);
 * pass `flipWinding` when B is nearer the viewer than A (back bevel).
 * XY normals follow the smoothing rule (averaged at smooth corners, per-edge
 * at hard corners) and are blended with the profile Z component.
 */
function appendBand(
	geom: RingGeometry,
	insetA: number,
	zA: number,
	insetB: number,
	zB: number,
	cornerRadiusA: number,
	cornerRadiusB: number,
	nXYScaleA: number,
	nZA: number,
	nXYScaleB: number,
	nZB: number,
	flipWinding: boolean,
	edgeSegmentLength: number,
	positions: number[],
	normals: number[],
	uv2: number[],
	indices: number[],
): void {
	if (
		cornerRadiusA <= 1e-6 &&
		cornerRadiusB <= 1e-6 &&
		edgeSegmentLength <= 1e-6
	) {
		appendFlatBand(
			geom,
			insetA,
			zA,
			insetB,
			zB,
			nXYScaleA,
			nZA,
			nXYScaleB,
			nZB,
			flipWinding,
			positions,
			normals,
			uv2,
			indices,
		);
		return;
	}

	const stationA = buildRingStation(
		geom,
		insetA,
		cornerRadiusA,
		edgeSegmentLength,
	);
	const stationB = buildRingStation(
		geom,
		insetB,
		cornerRadiusB,
		edgeSegmentLength,
	);
	const count = Math.min(stationA.points.length, stationB.points.length);
	for (let i = 0; i < count; i++) {
		const j = (i + 1) % count;
		const [ax1, ay1] = stationA.points[i];
		const [ax2, ay2] = stationA.points[j];
		const [bx1, by1] = stationB.points[i];
		const [bx2, by2] = stationB.points[j];
		const leftA = stationA.normals[i];
		const rightA = stationA.normals[j];
		const leftB = stationB.normals[i];
		const rightB = stationB.normals[j];
		const uA0 = stationA.u[i];
		const uA1 =
			stationA.u[j] < uA0 ? stationA.u[j] + stationA.perimeter : stationA.u[j];
		const uB0 = stationB.u[i];
		const uB1 =
			stationB.u[j] < uB0 ? stationB.u[j] + stationB.perimeter : stationB.u[j];

		const base = positions.length / 3;
		positions.push(ax1, ay1, zA, ax2, ay2, zA, bx2, by2, zB, bx1, by1, zB);
		pushBlendedNormal(normals, leftA, nXYScaleA, nZA);
		pushBlendedNormal(normals, rightA, nXYScaleA, nZA);
		pushBlendedNormal(normals, rightB, nXYScaleB, nZB);
		pushBlendedNormal(normals, leftB, nXYScaleB, nZB);
		uv2.push(uA0, -zA, uA1, -zA, uB1, -zB, uB0, -zB);
		if (flipWinding) {
			indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
		} else {
			indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
		}
	}
}

function appendFlatBand(
	geom: RingGeometry,
	insetA: number,
	zA: number,
	insetB: number,
	zB: number,
	nXYScaleA: number,
	nZA: number,
	nXYScaleB: number,
	nZB: number,
	flipWinding: boolean,
	positions: number[],
	normals: number[],
	uv2: number[],
	indices: number[],
): void {
	const count = geom.points.length;
	for (let i = 0; i < count; i++) {
		const j = (i + 1) % count;
		const [ax1, ay1] = insetPoint(geom, i, insetA);
		const [ax2, ay2] = insetPoint(geom, j, insetA);
		const [bx1, by1] = insetPoint(geom, i, insetB);
		const [bx2, by2] = insetPoint(geom, j, insetB);

		const leftXY = geom.smooth[i] ? geom.vertexNormals[i] : geom.edgeNormals[i];
		const rightXY = geom.smooth[j]
			? geom.vertexNormals[j]
			: geom.edgeNormals[i];

		// Wrap UV: u = ring arc length (closing edge reaches the full perimeter,
		// staying monotonic), v = depth position from the front cap (v = -z).
		const uL = geom.cumLen[i];
		const uR = j === 0 ? geom.perimeter : geom.cumLen[j];

		const base = positions.length / 3;
		positions.push(ax1, ay1, zA, ax2, ay2, zA, bx2, by2, zB, bx1, by1, zB);
		pushBlendedNormal(normals, leftXY, nXYScaleA, nZA);
		pushBlendedNormal(normals, rightXY, nXYScaleA, nZA);
		pushBlendedNormal(normals, rightXY, nXYScaleB, nZB);
		pushBlendedNormal(normals, leftXY, nXYScaleB, nZB);
		uv2.push(uL, -zA, uR, -zA, uR, -zB, uL, -zB);
		if (flipWinding) {
			indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
		} else {
			indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
		}
	}
}

function buildRingStation(
	geom: RingGeometry,
	inset: number,
	cornerRadius: number,
	edgeSegmentLength: number,
): RingStation {
	const points: [number, number][] = [];
	const normals: [number, number][] = [];
	const u: number[] = [];
	const count = geom.points.length;
	const radius = Math.max(cornerRadius, 0);
	let uCursor = 0;
	for (let i = 0; i < count; i++) {
		const j = (i + 1) % count;
		const edgeNormal = geom.edgeNormals[i];
		const centerA = insetPoint(geom, i, inset + radius);
		const centerB = insetPoint(geom, j, inset + radius);
		const start = offsetPoint(centerA, edgeNormal, radius);
		const end = offsetPoint(centerB, edgeNormal, radius);
		const straightLength = Math.hypot(end[0] - start[0], end[1] - start[1]);
		const subdivisions =
			edgeSegmentLength > 1e-6
				? Math.min(
						MAX_EDGE_SUBDIVISIONS,
						Math.max(1, Math.ceil(geom.edgeLengths[i] / edgeSegmentLength)),
					)
				: 1;

		for (let s = i === 0 ? 0 : 1; s <= subdivisions; s++) {
			const t = s / subdivisions;
			points.push(lerpPoint(start, end, t));
			normals.push(edgeNormal);
			u.push(uCursor + straightLength * t);
		}
		uCursor += straightLength;

		const nextNormal = geom.edgeNormals[j];
		const angleA = Math.atan2(edgeNormal[1], edgeNormal[0]);
		let delta = Math.atan2(
			edgeNormal[0] * nextNormal[1] - edgeNormal[1] * nextNormal[0],
			edgeNormal[0] * nextNormal[0] + edgeNormal[1] * nextNormal[1],
		);
		if (Math.abs(delta) > Math.PI) {
			delta += delta > 0 ? -Math.PI * 2 : Math.PI * 2;
		}
		const arcSegments = Math.max(
			1,
			Math.ceil(Math.abs(delta) / (Math.PI / 12)),
		);
		for (let s = 1; s <= arcSegments; s++) {
			if (i === count - 1 && s === arcSegments) continue;
			const angle = angleA + (delta * s) / arcSegments;
			const normal: [number, number] = [Math.cos(angle), Math.sin(angle)];
			points.push(offsetPoint(centerB, normal, radius));
			normals.push(normal);
			u.push(uCursor + (Math.abs(delta) * radius * s) / arcSegments);
		}
		uCursor += Math.abs(delta) * radius;
	}

	return { points, normals, u, perimeter: uCursor };
}

function offsetPoint(
	point: [number, number],
	normal: [number, number],
	distance: number,
): [number, number] {
	return [point[0] + normal[0] * distance, point[1] + normal[1] * distance];
}

function lerpPoint(
	a: [number, number],
	b: [number, number],
	t: number,
): [number, number] {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function pushBlendedNormal(
	normals: number[],
	xy: [number, number],
	xyScale: number,
	z: number,
): void {
	const nx = xy[0] * xyScale;
	const ny = xy[1] * xyScale;
	const len = Math.hypot(nx, ny, z);
	if (len < 1e-12) {
		normals.push(0, 0, 1);
		return;
	}
	normals.push(nx / len, ny / len, z / len);
}

function insetPoint(
	geom: RingGeometry,
	index: number,
	inset: number,
): [number, number] {
	const [x, y] = geom.points[index];
	if (inset === 0) return [x, y];
	const [dx, dy] = geom.insetDirs[index];
	return [x - dx * inset, y - dy * inset];
}

/** Open rings for earcut / walls: drop polygon-clipping's closing point.
 *  Shared with the revolve mesh builder. */
export function openRing(ring: Ring): [number, number][] {
	const open = ring.map(([x, y]) => [x, y] as [number, number]);
	if (
		open.length > 1 &&
		open[0][0] === open[open.length - 1][0] &&
		open[0][1] === open[open.length - 1][1]
	) {
		open.pop();
	}
	return open;
}

/** Shared with the revolve mesh builder (profile edge normals + arc length). */
export function computeRingGeometry(
	points: [number, number][],
): RingGeometry | null {
	// Remove consecutive (near-)duplicate points so every edge has a usable
	// direction and corner data stays index-aligned with the points.
	const pts: [number, number][] = [];
	for (const p of points) {
		const last = pts.at(-1);
		if (last && (last[0] - p[0]) ** 2 + (last[1] - p[1]) ** 2 < 1e-18) continue;
		pts.push(p);
	}
	while (
		pts.length > 1 &&
		(pts[0][0] - pts.at(-1)![0]) ** 2 + (pts[0][1] - pts.at(-1)![1]) ** 2 <
			1e-18
	) {
		pts.pop();
	}
	if (pts.length < 3) return null;

	const count = pts.length;
	const edgeNormals: [number, number][] = [];
	const edgeLengths: number[] = [];
	const cumLen: number[] = [];
	let perimeter = 0;
	for (let i = 0; i < count; i++) {
		const [x1, y1] = pts[i];
		const [x2, y2] = pts[(i + 1) % count];
		const dx = x2 - x1;
		const dy = y2 - y1;
		const len = Math.hypot(dx, dy);
		// Outer rings are CCW (right of travel = outside) and holes are CW
		// (right of travel = hole interior = material outside), so the same
		// perpendicular (dy, -dx) points out of the solid for both.
		edgeNormals.push(len < 1e-12 ? [0, 0] : [dy / len, -dx / len]);
		edgeLengths.push(len);
		// Arc length to point i (before edge i), then extend past edge i.
		cumLen.push(perimeter);
		perimeter += len;
	}

	const vertexNormals: [number, number][] = [];
	const smooth: boolean[] = [];
	const insetDirs: [number, number][] = [];
	for (let i = 0; i < count; i++) {
		const nPrev = edgeNormals[(i - 1 + count) % count];
		const nNext = edgeNormals[i];
		const dot = nPrev[0] * nNext[0] + nPrev[1] * nNext[1];
		const bx = nPrev[0] + nNext[0];
		const by = nPrev[1] + nNext[1];
		const bLen = Math.hypot(bx, by);

		if (bLen < 1e-9) {
			// Degenerate 180° reversal — no meaningful bisector.
			vertexNormals.push([nNext[0], nNext[1]]);
			smooth.push(false);
			insetDirs.push([nNext[0], nNext[1]]);
			continue;
		}
		vertexNormals.push([bx / bLen, by / bLen]);
		smooth.push(dot > SMOOTH_NORMAL_DOT);
		// Miter offset = (nPrev+nNext)/(1+dot) = 2b/|b|², length 2/|b| —
		// clamped at sharp corners so insets don't spike.
		const miterLen = Math.min(2 / bLen, BEVEL_MITER_LIMIT);
		insetDirs.push([(bx / bLen) * miterLen, (by / bLen) * miterLen]);
	}

	return {
		points: pts,
		edgeNormals,
		edgeLengths,
		vertexNormals,
		smooth,
		insetDirs,
		cumLen,
		perimeter,
	};
}
