import type { CubicBezierSegment } from "../../schema";
import {
	computeRingGeometry,
	EXTRUDE_VERTEX_FLOATS,
	type ExtrudeMeshData,
	normalizeOutline,
	openRing,
	type RingGeometry,
	triangulateCapRings,
} from "./extrudeMesh";

/**
 * Pure-CPU solid-of-revolution (lathe) mesh builder — the revolve3d sibling
 * of buildExtrudeMesh, emitting the same interleaved vertex format so the
 * shared MeshPassRenderer / baker pipeline consumes it unchanged.
 *
 * Pipeline: the profile outline is normalized exactly like an extrusion
 * (flatten → polygon-clipping union/difference, dominant winding), then swept
 * around a vertical axis placed at the profile's left/right edge (± offset)
 * in chord-error-driven angular stations. Adjacent stations are stitched with
 * quad bands whose normals rotate the profile's 2D outward normals around the
 * axis; a partial sweep (angleDeg < 360) optionally gains two flat end caps
 * (earcut of the profile). A full sweep reuses the θ=0 trig values verbatim
 * for the closing station so the seam is bit-identical (no crack).
 */
export function buildRevolveMesh(args: {
	segments: CubicBezierSegment[];
	/** Sweep angle in degrees, clamped to (0, 360]. */
	angleDeg: number;
	/** Distance from the profile edge to the revolve axis (world units, >= 0). */
	offset: number;
	/** Which side of the profile the axis sits on. */
	axis: "left" | "right";
	/** Close a partial sweep with flat end caps. Inert at 360°. */
	cap: boolean;
	/** Flattening tolerance in world units — also the sweep chord error. Default 0.25. */
	tolerance?: number;
	/** Pull fill-UV samples this far inward along the profile normal (see buildExtrudeMesh). */
	uvInset?: number;
	/** Store positions relative to the solid's bounds3d XY center (see buildExtrudeMesh). */
	rebaseToCenter?: boolean;
}): ExtrudeMeshData | null {
	const angleDeg = Math.min(Math.max(args.angleDeg, 0), 360);
	if (angleDeg <= 0) return null;
	const tolerance = args.tolerance ?? 0.25;

	const polygons = normalizeOutline(args.segments, tolerance);
	if (polygons.length === 0) return null;

	// Profile bounds (= bounds2d: the albedo bake box / fill-UV projection).
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

	// Axis line x = axisX; d maps profile +x onto the radial direction so the
	// same formulas serve both sides (left: axis before minX, radius grows
	// with x; right: mirrored).
	const offset = Math.max(args.offset, 0);
	const d = args.axis === "left" ? 1 : -1;
	const axisX = args.axis === "left" ? minX - offset : maxX + offset;
	const radiusOf = (x: number): number => Math.max(d * (x - axisX), 0);
	const rMax = Math.max(radiusOf(minX), radiusOf(maxX));
	if (rMax <= 0) return null;

	const stations = buildStations(angleDeg, rMax, tolerance);

	const positions: number[] = [];
	const normals: number[] = [];
	const uv2: number[] = [];
	// Per-vertex profile-plane data for the final fill-UV bake: position the
	// vertex samples the flat look at, and the 2D normal the uvInset pulls
	// along (a swept vertex's 3D position can't reconstruct either).
	const profile: number[] = [];
	const indices: number[] = [];

	const full = angleDeg >= 360;
	for (const polygon of polygons) {
		const ringGeoms: RingGeometry[] = [];
		for (const ring of polygon) {
			const geom = computeRingGeometry(openRing(ring));
			if (geom) ringGeoms.push(geom);
		}
		if (ringGeoms.length === 0) continue;

		for (const geom of ringGeoms) {
			appendSweepBands(
				geom,
				stations,
				axisX,
				d,
				radiusOf,
				positions,
				normals,
				uv2,
				profile,
				indices,
			);
		}
		if (!full && args.cap) {
			appendEndCaps(
				ringGeoms.map((g) => g.points),
				stations,
				axisX,
				d,
				radiusOf,
				positions,
				normals,
				uv2,
				profile,
				indices,
			);
		}
	}
	if (indices.length === 0) return null;

	// Solid bounds from the actual swept vertices — the revolution extends
	// past the profile in both X and Z, so the profile box is not enough.
	let b3minX = Infinity;
	let b3minY = Infinity;
	let b3minZ = Infinity;
	let b3maxX = -Infinity;
	let b3maxY = -Infinity;
	let b3maxZ = -Infinity;
	for (let i = 0; i < positions.length; i += 3) {
		b3minX = Math.min(b3minX, positions[i]);
		b3maxX = Math.max(b3maxX, positions[i]);
		b3minY = Math.min(b3minY, positions[i + 1]);
		b3maxY = Math.max(b3maxY, positions[i + 1]);
		b3minZ = Math.min(b3minZ, positions[i + 2]);
		b3maxZ = Math.max(b3maxZ, positions[i + 2]);
	}
	const offsetX = args.rebaseToCenter ? (b3minX + b3maxX) / 2 : 0;
	const offsetY = args.rebaseToCenter ? (b3minY + b3maxY) / 2 : 0;

	// Final assembly — same convention as buildExtrudeMesh's tail: fill UV is
	// the bounds2d planar projection with the offscreen Y flip, sampled at the
	// vertex's PROFILE position (uvInset pulled inward along the profile
	// normal), clamped to [0,1]; wrap uv2 passes through unclamped.
	const invW = maxX > minX ? 1 / (maxX - minX) : 0;
	const invH = maxY > minY ? 1 / (maxY - minY) : 0;
	const uvInset = args.uvInset ?? 0;

	const vertexCount = positions.length / 3;
	const vertices = new Float32Array(vertexCount * EXTRUDE_VERTEX_FLOATS);
	for (let i = 0; i < vertexCount; i++) {
		let sx = profile[i * 4];
		let sy = profile[i * 4 + 1];
		if (uvInset > 0) {
			const pnx = profile[i * 4 + 2];
			const pny = profile[i * 4 + 3];
			const len = Math.hypot(pnx, pny);
			if (len > 1e-6) {
				sx -= (pnx / len) * uvInset;
				sy -= (pny / len) * uvInset;
			}
		}
		const u = (sx - minX) * invW;
		const v = (maxY - sy) * invH;
		const o = i * EXTRUDE_VERTEX_FLOATS;
		vertices[o] = positions[i * 3] - offsetX;
		vertices[o + 1] = positions[i * 3 + 1] - offsetY;
		vertices[o + 2] = positions[i * 3 + 2];
		vertices[o + 3] = normals[i * 3];
		vertices[o + 4] = normals[i * 3 + 1];
		vertices[o + 5] = normals[i * 3 + 2];
		vertices[o + 6] = Math.min(Math.max(u, 0), 1);
		vertices[o + 7] = Math.min(Math.max(v, 0), 1);
		vertices[o + 8] = uv2[i * 2];
		vertices[o + 9] = uv2[i * 2 + 1];
	}

	return {
		vertices,
		indices: new Uint32Array(indices),
		bounds2d: { minX, minY, maxX, maxY },
		bounds3d: {
			minX: b3minX,
			minY: b3minY,
			minZ: b3minZ,
			maxX: b3maxX,
			maxY: b3maxY,
			maxZ: b3maxZ,
		},
	};
}

// ---------------------------------------------------------------------------
// Sweep stations
// ---------------------------------------------------------------------------

/** Angular sample around the axis: θ plus its (possibly reused) trig values. */
interface SweepStation {
	theta: number;
	cos: number;
	sin: number;
}

/** Hard bounds on the angular subdivision count. */
const MIN_SWEEP_STEPS = 3;
const MAX_SWEEP_STEPS = 256;

/**
 * Chord-error-driven angular stations: step Δθ keeps the sagitta of the
 * outermost radius within `tolerance` (Δθ = 2·acos(1 − tol/rMax)). A full
 * sweep's closing station reuses station 0's trig values verbatim so the
 * seam vertices are bit-identical (no crack / z-fight).
 */
function buildStations(
	angleDeg: number,
	rMax: number,
	tolerance: number,
): SweepStation[] {
	const angleRad = (angleDeg * Math.PI) / 180;
	const chord = Math.min(Math.max(tolerance / rMax, 0), 1);
	const maxStep = 2 * Math.acos(1 - chord);
	const steps = Math.min(
		Math.max(
			maxStep > 1e-9 ? Math.ceil(angleRad / maxStep) : MAX_SWEEP_STEPS,
			MIN_SWEEP_STEPS,
		),
		MAX_SWEEP_STEPS,
	);
	const full = angleDeg >= 360;

	const stations: SweepStation[] = [];
	for (let k = 0; k <= steps; k++) {
		if (full && k === steps) {
			stations.push({
				theta: angleRad,
				cos: stations[0].cos,
				sin: stations[0].sin,
			});
			continue;
		}
		const theta = (angleRad * k) / steps;
		stations.push({ theta, cos: Math.cos(theta), sin: Math.sin(theta) });
	}
	return stations;
}

// ---------------------------------------------------------------------------
// Surface bands
// ---------------------------------------------------------------------------

/** Two 3D points closer than this collapse a triangle (axis-clamped slivers). */
const DEGENERATE_EPSILON_SQ = 1e-12;

/**
 * Sweep one profile ring across all stations, stitching adjacent stations
 * with quads (4 unique vertices per quad, matching appendFlatBand's style so
 * hard profile corners keep per-edge normals). Winding is chosen so the
 * geometric triangle normal matches the rotated outward profile normal (the
 * profile tangent × sweep direction points inward, hence the flipped order).
 */
function appendSweepBands(
	geom: RingGeometry,
	stations: SweepStation[],
	axisX: number,
	d: number,
	radiusOf: (x: number) => number,
	positions: number[],
	normals: number[],
	uv2: number[],
	profile: number[],
	indices: number[],
): void {
	const count = geom.points.length;
	for (let i = 0; i < count; i++) {
		const j = (i + 1) % count;
		const [pxI, pyI] = geom.points[i];
		const [pxJ, pyJ] = geom.points[j];
		const rI = radiusOf(pxI);
		const rJ = radiusOf(pxJ);
		// Both edge ends sit on the axis — the whole band is a zero-area seam.
		if (rI <= 0 && rJ <= 0) continue;

		const leftXY = geom.smooth[i] ? geom.vertexNormals[i] : geom.edgeNormals[i];
		const rightXY = geom.smooth[j]
			? geom.vertexNormals[j]
			: geom.edgeNormals[i];
		// Wrap-UV v = profile arc length (the closing edge reaches the full
		// perimeter, staying monotonic) — the revolve analogue of wall depth.
		const vL = geom.cumLen[i];
		const vR = j === 0 ? geom.perimeter : geom.cumLen[j];

		for (let k = 0; k + 1 < stations.length; k++) {
			const a = stations[k];
			const b = stations[k + 1];
			const base = positions.length / 3;
			pushSweptVertex(
				a,
				pxI,
				pyI,
				rI,
				leftXY,
				vL,
				axisX,
				d,
				positions,
				normals,
				uv2,
				profile,
			);
			pushSweptVertex(
				a,
				pxJ,
				pyJ,
				rJ,
				rightXY,
				vR,
				axisX,
				d,
				positions,
				normals,
				uv2,
				profile,
			);
			pushSweptVertex(
				b,
				pxJ,
				pyJ,
				rJ,
				rightXY,
				vR,
				axisX,
				d,
				positions,
				normals,
				uv2,
				profile,
			);
			pushSweptVertex(
				b,
				pxI,
				pyI,
				rI,
				leftXY,
				vL,
				axisX,
				d,
				positions,
				normals,
				uv2,
				profile,
			);
			// Flipped relative to appendFlatBand: the sweep's surface orientation
			// (tangent × θ̂) is inward, so reverse to face the normals outward.
			pushTriangle(indices, positions, base, base + 2, base + 1);
			pushTriangle(indices, positions, base, base + 3, base + 2);
		}
	}
}

/**
 * Emit one swept vertex: position p(θ) = (axisX + d·r·cosθ, y, −r·sinθ),
 * normal n(θ) = (nx·cosθ, ny, −d·nx·sinθ) (the profile's outward 2D normal
 * rotated around the axis), wrap uv2 = (θ·r, profile arc length), plus the
 * profile-plane sample data for the final fill-UV bake.
 */
function pushSweptVertex(
	station: SweepStation,
	px: number,
	py: number,
	r: number,
	profileNormal: [number, number],
	v2: number,
	axisX: number,
	d: number,
	positions: number[],
	normals: number[],
	uv2: number[],
	profile: number[],
): void {
	positions.push(axisX + d * r * station.cos, py, -r * station.sin);
	const [nx, ny] = profileNormal;
	const wx = nx * station.cos;
	const wz = -d * nx * station.sin;
	const len = Math.hypot(wx, ny, wz);
	if (len < 1e-12) {
		normals.push(0, 0, 1);
	} else {
		normals.push(wx / len, ny / len, wz / len);
	}
	uv2.push(station.theta * r, v2);
	profile.push(px, py, nx, ny);
}

/** Push a triangle unless the axis clamp collapsed it to a sliver. */
function pushTriangle(
	indices: number[],
	positions: number[],
	i0: number,
	i1: number,
	i2: number,
): void {
	if (
		distSq(positions, i0, i1) < DEGENERATE_EPSILON_SQ ||
		distSq(positions, i1, i2) < DEGENERATE_EPSILON_SQ ||
		distSq(positions, i2, i0) < DEGENERATE_EPSILON_SQ
	) {
		return;
	}
	indices.push(i0, i1, i2);
}

function distSq(positions: number[], a: number, b: number): number {
	const dx = positions[a * 3] - positions[b * 3];
	const dy = positions[a * 3 + 1] - positions[b * 3 + 1];
	const dz = positions[a * 3 + 2] - positions[b * 3 + 2];
	return dx * dx + dy * dy + dz * dz;
}

// ---------------------------------------------------------------------------
// Partial-sweep end caps
// ---------------------------------------------------------------------------

/**
 * Flat end caps closing a partial sweep: the profile polygon itself placed at
 * θ=0 and θ=angle. The start cap faces −θ̂(0) = (0,0,1) (toward the viewer,
 * the material lies at θ>0); the end cap faces +θ̂(angle) with reversed
 * winding. Cap wrap uv2 is world (x, −y), matching extrude caps.
 */
function appendEndCaps(
	rings: [number, number][][],
	stations: SweepStation[],
	axisX: number,
	d: number,
	radiusOf: (x: number) => number,
	positions: number[],
	normals: number[],
	uv2: number[],
	profile: number[],
	indices: number[],
): void {
	const triangulated = triangulateCapRings(rings);
	if (!triangulated) return;
	const { flat, triangles } = triangulated;
	const pointCount = flat.length / 2;
	const start = stations[0];
	const end = stations[stations.length - 1];

	const startBase = positions.length / 3;
	for (let i = 0; i < pointCount; i++) {
		const px = flat[i * 2];
		const py = flat[i * 2 + 1];
		const r = radiusOf(px);
		positions.push(axisX + d * r * start.cos, py, -r * start.sin);
		normals.push(0, 0, 1);
		uv2.push(px, -py);
		profile.push(px, py, 0, 0);
	}
	for (let t = 0; t < triangles.length; t += 3) {
		pushTriangle(
			indices,
			positions,
			startBase + triangles[t],
			startBase + triangles[t + 1],
			startBase + triangles[t + 2],
		);
	}

	// End cap outward normal = +θ̂(angle) = (−d·sin a, 0, −cos a).
	const endBase = positions.length / 3;
	for (let i = 0; i < pointCount; i++) {
		const px = flat[i * 2];
		const py = flat[i * 2 + 1];
		const r = radiusOf(px);
		positions.push(axisX + d * r * end.cos, py, -r * end.sin);
		normals.push(-d * end.sin, 0, -end.cos);
		uv2.push(px, -py);
		profile.push(px, py, 0, 0);
	}
	for (let t = 0; t < triangles.length; t += 3) {
		pushTriangle(
			indices,
			positions,
			endBase + triangles[t],
			endBase + triangles[t + 2],
			endBase + triangles[t + 1],
		);
	}
}
