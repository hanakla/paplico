import { describe, expect, it } from "vitest";
import type { BezierPoint, CubicBezierSegment } from "../../schema";
import { EXTRUDE_VERTEX_FLOATS } from "./extrudeMesh";
import { buildRevolveMesh } from "./revolveMesh";

describe("buildRevolveMesh", () => {
	// Profile: 30×50 rect at x ∈ [10, 40], y ∈ [0, 50].
	const PROFILE = () => rect(10, 0, 30, 50);

	it("should return null for a non-positive sweep angle", () => {
		expect(
			buildRevolveMesh({
				segments: PROFILE(),
				angleDeg: 0,
				offset: 0,
				axis: "left",
				cap: true,
			}),
		).toBe(null);
	});

	it("should return null for empty segments", () => {
		expect(
			buildRevolveMesh({
				segments: [],
				angleDeg: 360,
				offset: 0,
				axis: "left",
				cap: true,
			}),
		).toBe(null);
	});

	it("should sweep a rect into a cylinder-like solid with 3D bounds spanning ±maxRadius around the axis", () => {
		const mesh = buildRevolveMesh({
			segments: PROFILE(),
			angleDeg: 360,
			offset: 0,
			axis: "left",
			cap: true,
		})!;
		expect(mesh).not.toBe(null);

		// Axis at x=10, max radius 30 → the solid spans x ∈ [-20, 40], z ∈ [-30, 30].
		expect(mesh.bounds3d.minX).toBeCloseTo(-20, 0);
		expect(mesh.bounds3d.maxX).toBeCloseTo(40, 0);
		expect(mesh.bounds3d.minZ).toBeCloseTo(-30, 0);
		expect(mesh.bounds3d.maxZ).toBeCloseTo(30, 0);
		expect(mesh.bounds3d.minY).toBe(0);
		expect(mesh.bounds3d.maxY).toBe(50);
		// bounds2d stays the PROFILE box (albedo bake target).
		expect(mesh.bounds2d).toEqual({ minX: 10, minY: 0, maxX: 40, maxY: 50 });

		// No vertex escapes the max radius.
		forEachVertex(mesh, (v) => {
			expect(Math.hypot(v.x - 10, v.z)).toBeLessThanOrEqual(30 + 1e-3);
		});
	});

	it("should keep the θ=0 station at the original profile position for both axis sides", () => {
		for (const axis of ["left", "right"] as const) {
			const mesh = buildRevolveMesh({
				segments: PROFILE(),
				angleDeg: 90,
				offset: 5,
				axis,
				cap: false,
			})!;
			// The profile corner (40, 50) must appear verbatim among vertices.
			let found = false;
			forEachVertex(mesh, (v) => {
				if (
					Math.abs(v.x - 40) < 1e-6 &&
					Math.abs(v.y - 50) < 1e-6 &&
					Math.abs(v.z) < 1e-6
				) {
					found = true;
				}
			});
			expect(found).toBe(true);
		}
	});

	describe("watertightness (exact-position edge pairing)", () => {
		it("should be watertight for a full sweep clear of the axis (torus-like)", () => {
			const mesh = buildRevolveMesh({
				segments: PROFILE(),
				angleDeg: 360,
				offset: 5,
				axis: "left",
				cap: false,
			})!;
			const counts = edgeCounts(mesh);
			expect([...counts.values()].every((c) => c === 2)).toBe(true);
		});

		it("should be watertight for a full sweep touching the axis (cylinder)", () => {
			const mesh = buildRevolveMesh({
				segments: PROFILE(),
				angleDeg: 360,
				offset: 0,
				axis: "left",
				cap: true,
			})!;
			const counts = edgeCounts(mesh);
			expect([...counts.values()].every((c) => c === 2)).toBe(true);
		});

		it("should be watertight for a capped partial sweep with a hole in the profile", () => {
			const segments = [...rect(10, 0, 30, 50), ...rectCW(20, 10, 10, 20)];
			const mesh = buildRevolveMesh({
				segments,
				angleDeg: 180,
				offset: 5,
				axis: "left",
				cap: true,
			})!;
			const counts = edgeCounts(mesh);
			expect([...counts.values()].every((c) => c === 2)).toBe(true);
		});

		it("should leave open boundary edges for an uncapped partial sweep", () => {
			const mesh = buildRevolveMesh({
				segments: PROFILE(),
				angleDeg: 180,
				offset: 5,
				axis: "left",
				cap: false,
			})!;
			const counts = edgeCounts(mesh);
			expect([...counts.values()].some((c) => c === 1)).toBe(true);
		});
	});

	describe("normals", () => {
		it("should emit unit-length normals everywhere", () => {
			const mesh = buildRevolveMesh({
				segments: PROFILE(),
				angleDeg: 270,
				offset: 5,
				axis: "left",
				cap: true,
			})!;
			forEachVertex(mesh, (v) => {
				expect(Math.hypot(v.nx, v.ny, v.nz)).toBeCloseTo(1, 5);
			});
		});

		it("should orient every triangle to face along its vertices' stored normals", () => {
			const mesh = buildRevolveMesh({
				segments: PROFILE(),
				angleDeg: 360,
				offset: 5,
				axis: "left",
				cap: false,
			})!;
			forEachTriangle(mesh, (a, b, c, normalSum) => {
				const gx =
					(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
				const gy =
					(b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
				const gz =
					(b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
				const area = Math.hypot(gx, gy, gz);
				if (area < 1e-9) return;
				const dot =
					(gx * normalSum[0] + gy * normalSum[1] + gz * normalSum[2]) / area;
				expect(dot).toBeGreaterThan(0);
			});
		});

		it("should point outer-wall normals radially away from the axis", () => {
			const mesh = buildRevolveMesh({
				segments: PROFILE(),
				angleDeg: 360,
				offset: 0,
				axis: "left",
				cap: true,
			})!;
			let checked = 0;
			forEachVertex(mesh, (v) => {
				const r = Math.hypot(v.x - 10, v.z);
				// Outer wall only: at max radius AND carrying a horizontal normal
				// (the top/bottom discs' rim vertices also sit at rMax, but their
				// normals correctly point ±Y).
				if (r < 30 - 1e-3 || Math.abs(v.ny) > 1e-3) return;
				const dot = ((v.x - 10) / r) * v.nx + (v.z / r) * v.nz;
				expect(dot).toBeGreaterThan(0.9);
				checked++;
			});
			expect(checked).toBeGreaterThan(0);
		});
	});

	it("should preserve the hole left by a positive offset (no vertex inside the axis gap)", () => {
		const mesh = buildRevolveMesh({
			segments: PROFILE(),
			angleDeg: 360,
			offset: 5,
			axis: "left",
			cap: false,
		})!;
		// axisX = 5; every profile point sits at r >= 5 from it.
		forEachVertex(mesh, (v) => {
			expect(Math.hypot(v.x - 5, v.z)).toBeGreaterThanOrEqual(5 - 1e-3);
		});
	});

	it("should clamp a negative offset to zero", () => {
		const clamped = buildRevolveMesh({
			segments: PROFILE(),
			angleDeg: 360,
			offset: -10,
			axis: "left",
			cap: true,
		})!;
		const zero = buildRevolveMesh({
			segments: PROFILE(),
			angleDeg: 360,
			offset: 0,
			axis: "left",
			cap: true,
		})!;
		expect(clamped.bounds3d).toEqual(zero.bounds3d);
	});

	it("should skip degenerate triangles (every indexed triangle has area)", () => {
		const mesh = buildRevolveMesh({
			segments: PROFILE(),
			angleDeg: 360,
			offset: 0,
			axis: "left",
			cap: true,
		})!;
		forEachTriangle(mesh, (a, b, c) => {
			const area = triangleArea(a, b, c);
			expect(area).toBeGreaterThan(0);
		});
	});

	it("should treat the cap flag as inert at 360°", () => {
		const withCap = buildRevolveMesh({
			segments: PROFILE(),
			angleDeg: 360,
			offset: 5,
			axis: "left",
			cap: true,
		})!;
		const without = buildRevolveMesh({
			segments: PROFILE(),
			angleDeg: 360,
			offset: 5,
			axis: "left",
			cap: false,
		})!;
		expect(withCap.vertices.length).toBe(without.vertices.length);
		expect(withCap.indices.length).toBe(without.indices.length);
	});

	it("should subdivide the sweep finer as tolerance shrinks, within hard bounds", () => {
		const coarse = buildRevolveMesh({
			segments: PROFILE(),
			angleDeg: 360,
			offset: 0,
			axis: "left",
			cap: false,
			tolerance: 4,
		})!;
		const fine = buildRevolveMesh({
			segments: PROFILE(),
			angleDeg: 360,
			offset: 0,
			axis: "left",
			cap: false,
			tolerance: 0.05,
		})!;
		const extreme = buildRevolveMesh({
			segments: PROFILE(),
			angleDeg: 360,
			offset: 0,
			axis: "left",
			cap: false,
			tolerance: 1e-9,
		});
		expect(fine.vertices.length).toBeGreaterThan(coarse.vertices.length);
		// The 256-station clamp keeps even absurd tolerances finite.
		expect(extreme).not.toBe(null);
		expect(extreme!.vertices.length).toBeLessThan(fine.vertices.length * 64);
	});

	describe("uv", () => {
		it("should keep the fill uv inside [0,1]", () => {
			const mesh = buildRevolveMesh({
				segments: PROFILE(),
				angleDeg: 360,
				offset: 5,
				axis: "left",
				cap: false,
			})!;
			forEachVertex(mesh, (v) => {
				expect(v.u).toBeGreaterThanOrEqual(0);
				expect(v.u).toBeLessThanOrEqual(1);
				expect(v.v).toBeGreaterThanOrEqual(0);
				expect(v.v).toBeLessThanOrEqual(1);
			});
		});

		it("should grow the wrap u monotonically with the sweep angle at fixed radius", () => {
			const mesh = buildRevolveMesh({
				segments: PROFILE(),
				angleDeg: 360,
				offset: 0,
				axis: "left",
				cap: false,
			})!;
			// Collect wrap-u values of outer-wall vertices at one profile height,
			// sorted by sweep angle via atan2 — u2 = θ·r must be non-decreasing
			// per full turn (seam resets aside, the set spans [0, 2π·r]).
			const rMax = 30;
			let maxU2 = 0;
			forEachVertex(mesh, (v) => {
				const r = Math.hypot(v.x - 10, v.z);
				if (r < rMax - 1e-3) return;
				maxU2 = Math.max(maxU2, v.u2);
			});
			expect(maxU2).toBeCloseTo(2 * Math.PI * rMax, 0);
		});
	});

	describe("rebaseToCenter", () => {
		it("should shift positions by the solid's bounds3d XY center while bounds stay world", () => {
			const world = buildRevolveMesh({
				segments: PROFILE(),
				angleDeg: 360,
				offset: 0,
				axis: "left",
				cap: true,
			})!;
			const rebased = buildRevolveMesh({
				segments: PROFILE(),
				angleDeg: 360,
				offset: 0,
				axis: "left",
				cap: true,
				rebaseToCenter: true,
			})!;
			// World bounds3d identical; rebased positions center on the origin.
			expect(rebased.bounds3d).toEqual(world.bounds3d);
			const cx = (world.bounds3d.minX + world.bounds3d.maxX) / 2;
			const cy = (world.bounds3d.minY + world.bounds3d.maxY) / 2;
			for (let i = 0; i < rebased.vertices.length; i += EXTRUDE_VERTEX_FLOATS) {
				expect(rebased.vertices[i]).toBeCloseTo(world.vertices[i] - cx, 4);
				expect(rebased.vertices[i + 1]).toBeCloseTo(
					world.vertices[i + 1] - cy,
					4,
				);
				expect(rebased.vertices[i + 2]).toBe(world.vertices[i + 2]);
			}
		});
	});
});

// Helpers

function lineSeg(
	start: BezierPoint,
	end: BezierPoint,
	isMoved = false,
): CubicBezierSegment {
	return {
		start,
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved,
	};
}

/** Closed CCW rectangle. */
function rect(
	x: number,
	y: number,
	w: number,
	h: number,
): CubicBezierSegment[] {
	const points: BezierPoint[] = [
		{ x, y },
		{ x: x + w, y },
		{ x: x + w, y: y + h },
		{ x, y: y + h },
	];
	return points.map((p, i) =>
		lineSeg(p, points[(i + 1) % points.length], i === 0),
	);
}

/** Closed CW rectangle (hole winding). */
function rectCW(
	x: number,
	y: number,
	w: number,
	h: number,
): CubicBezierSegment[] {
	const points: BezierPoint[] = [
		{ x, y },
		{ x, y: y + h },
		{ x: x + w, y: y + h },
		{ x: x + w, y },
	];
	return points.map((p, i) =>
		lineSeg(p, points[(i + 1) % points.length], i === 0),
	);
}

interface MeshVertex {
	x: number;
	y: number;
	z: number;
	nx: number;
	ny: number;
	nz: number;
	u: number;
	v: number;
	u2: number;
	v2: number;
}

function forEachVertex(
	mesh: { vertices: Float32Array },
	fn: (v: MeshVertex) => void,
): void {
	for (let i = 0; i < mesh.vertices.length; i += EXTRUDE_VERTEX_FLOATS) {
		fn({
			x: mesh.vertices[i],
			y: mesh.vertices[i + 1],
			z: mesh.vertices[i + 2],
			nx: mesh.vertices[i + 3],
			ny: mesh.vertices[i + 4],
			nz: mesh.vertices[i + 5],
			u: mesh.vertices[i + 6],
			v: mesh.vertices[i + 7],
			u2: mesh.vertices[i + 8],
			v2: mesh.vertices[i + 9],
		});
	}
}

type Vec3Tuple = [number, number, number];

function forEachTriangle(
	mesh: { vertices: Float32Array; indices: Uint32Array },
	fn: (a: Vec3Tuple, b: Vec3Tuple, c: Vec3Tuple, normalSum: Vec3Tuple) => void,
): void {
	for (let t = 0; t < mesh.indices.length; t += 3) {
		const corners: Vec3Tuple[] = [];
		const normalSum: Vec3Tuple = [0, 0, 0];
		for (let k = 0; k < 3; k++) {
			const o = mesh.indices[t + k] * EXTRUDE_VERTEX_FLOATS;
			corners.push([
				mesh.vertices[o],
				mesh.vertices[o + 1],
				mesh.vertices[o + 2],
			]);
			normalSum[0] += mesh.vertices[o + 3];
			normalSum[1] += mesh.vertices[o + 4];
			normalSum[2] += mesh.vertices[o + 5];
		}
		fn(corners[0], corners[1], corners[2], normalSum);
	}
}

function triangleArea(a: Vec3Tuple, b: Vec3Tuple, c: Vec3Tuple): number {
	const gx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
	const gy = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
	const gz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
	return Math.hypot(gx, gy, gz) / 2;
}

/**
 * Count how many triangles reference each undirected edge, keyed by the EXACT
 * float bits of both endpoint positions — a watertight mesh pairs every edge
 * exactly twice, and a seam whose closing station is not bit-identical to
 * station 0 shows up as unpaired edges.
 */
function edgeCounts(mesh: {
	vertices: Float32Array;
	indices: Uint32Array;
}): Map<string, number> {
	const posKey = (index: number): string => {
		const o = index * EXTRUDE_VERTEX_FLOATS;
		return `${mesh.vertices[o]},${mesh.vertices[o + 1]},${mesh.vertices[o + 2]}`;
	};
	const counts = new Map<string, number>();
	for (let t = 0; t < mesh.indices.length; t += 3) {
		for (let k = 0; k < 3; k++) {
			const a = posKey(mesh.indices[t + k]);
			const b = posKey(mesh.indices[t + ((k + 1) % 3)]);
			const key = a < b ? `${a}|${b}` : `${b}|${a}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	return counts;
}
