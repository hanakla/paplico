import { describe, expect, it } from "vitest";
import type { BezierPoint, CubicBezierSegment } from "../../schema";
import { buildExtrudeMesh, EXTRUDE_VERTEX_FLOATS } from "./extrudeMesh";

describe("buildExtrudeMesh", () => {
	it("should return null for non-positive depth", () => {
		expect(buildExtrudeMesh({ segments: rect(0, 0, 10, 10), depth: 0 })).toBe(
			null,
		);
		expect(buildExtrudeMesh({ segments: rect(0, 0, 10, 10), depth: -5 })).toBe(
			null,
		);
	});

	it("should return null for empty or degenerate outlines", () => {
		expect(buildExtrudeMesh({ segments: [], depth: 5 })).toBe(null);
		// Two-point "outline" has no area.
		const line = [
			lineSeg({ x: 0, y: 0 }, { x: 10, y: 0 }),
			lineSeg({ x: 10, y: 0 }, { x: 0, y: 0 }),
		];
		expect(buildExtrudeMesh({ segments: line, depth: 5 })).toBe(null);
	});

	it("should place every vertex on the front (z=0) or back (z=-depth) plane", () => {
		const mesh = buildExtrudeMesh({ segments: rect(0, 0, 10, 10), depth: 5 })!;
		for (let i = 0; i < mesh.vertices.length; i += EXTRUDE_VERTEX_FLOATS) {
			const z = mesh.vertices[i + 2];
			expect(z === 0 || z === -5).toBe(true);
		}
	});

	it("should report the outline bounds in bounds2d", () => {
		const mesh = buildExtrudeMesh({ segments: rect(2, 3, 10, 10), depth: 5 })!;
		expect(mesh.bounds2d.minX).toBeCloseTo(2);
		expect(mesh.bounds2d.minY).toBeCloseTo(3);
		expect(mesh.bounds2d.maxX).toBeCloseTo(12);
		expect(mesh.bounds2d.maxY).toBeCloseTo(13);
	});

	it("should wind the front cap CCW and the back cap CW (reversed)", () => {
		const mesh = buildExtrudeMesh({ segments: rect(0, 0, 10, 10), depth: 5 })!;
		for (let t = 0; t < mesh.indices.length; t += 3) {
			const [a, b, c] = triangle(mesh, t);
			// Cap triangles only (all three vertices on the same z plane).
			if (a[2] !== b[2] || b[2] !== c[2]) continue;
			const cross =
				(b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
			if (a[2] === 0) {
				expect(cross).toBeGreaterThan(0);
			} else {
				expect(cross).toBeLessThan(0);
			}
		}
	});

	it("should give caps ±Z normals and side walls outward in-plane normals", () => {
		const mesh = buildExtrudeMesh({ segments: rect(0, 0, 10, 10), depth: 5 })!;
		const sideNormals = new Set<string>();
		for (let i = 0; i < mesh.vertices.length; i += EXTRUDE_VERTEX_FLOATS) {
			const [nx, ny, nz] = [
				mesh.vertices[i + 3],
				mesh.vertices[i + 4],
				mesh.vertices[i + 5],
			];
			expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1);
			if (nz !== 0) {
				// Cap: pure ±Z.
				expect(nx).toBe(0);
				expect(ny).toBe(0);
			} else {
				sideNormals.add(`${Math.round(nx)},${Math.round(ny)}`);
			}
		}
		// A rectangle has exactly four outward wall directions.
		expect(sideNormals).toEqual(new Set(["1,0", "-1,0", "0,1", "0,-1"]));
	});

	it("should carve a CW sub-path as a hole in the front cap", () => {
		const outline = [...rect(0, 0, 20, 20), ...rectCW(5, 5, 10, 10, true)];
		const mesh = buildExtrudeMesh({ segments: outline, depth: 5 })!;
		// Front cap area = outer 400 − hole 100.
		expect(frontCapArea(mesh)).toBeCloseTo(300, 0);
		// Hole walls double the side quad count vs. a plain rect.
		const solid = buildExtrudeMesh({ segments: rect(0, 0, 20, 20), depth: 5 })!;
		expect(mesh.indices.length).toBeGreaterThan(solid.indices.length);
	});

	it("should normalize self-intersecting outlines instead of failing", () => {
		// Bowtie: (0,0) → (10,10) → (10,0) → (0,10) → close.
		const points: BezierPoint[] = [
			{ x: 0, y: 0 },
			{ x: 10, y: 10 },
			{ x: 10, y: 0 },
			{ x: 0, y: 10 },
		];
		const segments = points.map((p, i) =>
			lineSeg(p, points[(i + 1) % points.length], i === 0),
		);
		const mesh = buildExtrudeMesh({ segments, depth: 5 });
		expect(mesh).not.toBe(null);
		// The two triangular lobes of the bowtie each cover 25 units².
		expect(frontCapArea(mesh!)).toBeCloseTo(50, 0);
	});

	it("should union overlapping positively-wound sub-paths", () => {
		const outline = [...rect(0, 0, 10, 10), ...rect(5, 0, 10, 10, true)];
		const mesh = buildExtrudeMesh({ segments: outline, depth: 5 })!;
		expect(frontCapArea(mesh)).toBeCloseTo(150, 0);
	});

	it("should extrude a clockwise-only outline like fill paints it", () => {
		// A single CW-wound closed path is painted by fill (nonzero rule) and
		// must extrude the same region instead of degenerating to hole-only.
		const mesh = buildExtrudeMesh({ segments: rectCW(0, 0, 10, 10), depth: 5 });
		expect(mesh).not.toBe(null);
		expect(frontCapArea(mesh!)).toBeCloseTo(100, 0);
	});

	it("should treat a fully reversed outline (CW outer + CCW inner) as solid with hole", () => {
		const outline = [...rectCW(0, 0, 20, 20), ...rect(5, 5, 10, 10, true)];
		const mesh = buildExtrudeMesh({ segments: outline, depth: 5 })!;
		expect(frontCapArea(mesh)).toBeCloseTo(300, 0);
	});

	describe("bevel", () => {
		it("should inset the caps by the bevel radius and keep the depth range", () => {
			const mesh = buildExtrudeMesh({
				segments: rect(0, 0, 20, 20),
				depth: 10,
				bevelSize: 2,
			})!;

			let minZ = Infinity;
			let maxZ = -Infinity;
			let capMinX = Infinity;
			let capMaxX = -Infinity;
			for (let i = 0; i < mesh.vertices.length; i += EXTRUDE_VERTEX_FLOATS) {
				const z = mesh.vertices[i + 2];
				minZ = Math.min(minZ, z);
				maxZ = Math.max(maxZ, z);
				if (z === 0) {
					capMinX = Math.min(capMinX, mesh.vertices[i]);
					capMaxX = Math.max(capMaxX, mesh.vertices[i]);
				}
			}
			expect(minZ).toBeCloseTo(-10);
			expect(maxZ).toBeCloseTo(0);
			// Everything on the z=0 plane (cap + first bevel ring) is inset by 2.
			expect(capMinX).toBeCloseTo(2);
			expect(capMaxX).toBeCloseTo(18);
		});

		it("should emit unit normals with intermediate Z on the bevel profile", () => {
			const mesh = buildExtrudeMesh({
				segments: rect(0, 0, 20, 20),
				depth: 10,
				bevelSize: 2,
			})!;

			const intermediateNZ = new Set<number>();
			for (let i = 0; i < mesh.vertices.length; i += EXTRUDE_VERTEX_FLOATS) {
				const [nx, ny, nz] = [
					mesh.vertices[i + 3],
					mesh.vertices[i + 4],
					mesh.vertices[i + 5],
				];
				expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1);
				if (Math.abs(nz) > 0.01 && Math.abs(nz) < 0.99) {
					intermediateNZ.add(Math.round(Math.abs(nz) * 1000));
				}
			}
			// A 4-segment quarter profile has stations at cos(kπ/8):
			// ≈0.924, ≈0.707, ≈0.383 between the ±Z caps and the flat side.
			expect(intermediateNZ.size).toBeGreaterThanOrEqual(3);
		});

		it("should subdivide long bevel edges along the ring length", () => {
			const mesh = buildExtrudeMesh({
				segments: rect(0, 0, 40, 10),
				depth: 10,
				bevelSize: 2,
			})!;

			const frontBottomEdgeXs = new Set<number>();
			for (let i = 0; i < mesh.vertices.length; i += EXTRUDE_VERTEX_FLOATS) {
				const x = mesh.vertices[i];
				const y = mesh.vertices[i + 1];
				const z = mesh.vertices[i + 2];
				if (Math.abs(z) < 1e-6 && Math.abs(y - 2) < 1e-6) {
					frontBottomEdgeXs.add(Math.round(x * 1_000) / 1_000);
				}
			}

			expect(frontBottomEdgeXs.size).toBeGreaterThan(2);
		});

		it("should round vertical side corners instead of leaving a sharp miter", () => {
			const mesh = buildExtrudeMesh({
				segments: rect(0, 0, 20, 20),
				depth: 10,
				bevelSize: 2,
			})!;

			let hasBottomRightArcPoint = false;
			for (let i = 0; i < mesh.vertices.length; i += EXTRUDE_VERTEX_FLOATS) {
				const x = mesh.vertices[i];
				const y = mesh.vertices[i + 1];
				const z = mesh.vertices[i + 2];
				const nx = mesh.vertices[i + 3];
				const ny = mesh.vertices[i + 4];
				const nz = mesh.vertices[i + 5];
				if (
					Math.abs(z + 2) < 1e-6 &&
					Math.abs(nz) < 1e-6 &&
					x > 18 &&
					x < 20 &&
					y > 0 &&
					y < 2 &&
					nx > 0 &&
					ny < 0
				) {
					hasBottomRightArcPoint = true;
				}
			}

			expect(hasBottomRightArcPoint).toBe(true);
		});

		it("should keep rounded bevel corner wrap uv non-collapsed per face", () => {
			const mesh = buildExtrudeMesh({
				segments: rect(0, 0, 20, 20),
				depth: 10,
				bevelSize: 2,
			})!;

			let hasNonCollapsedCornerFace = false;
			for (let t = 0; t + 5 < mesh.indices.length; t += 6) {
				const unique = [...new Set(mesh.indices.slice(t, t + 6))];
				if (unique.length !== 4) continue;
				const vertices = unique.map((index) => vertex(mesh, index));
				if (
					!vertices.some(
						(v) =>
							v.x > 18 &&
							v.x < 20 &&
							v.y > 0 &&
							v.y < 2 &&
							v.nx > 0.1 &&
							v.ny < -0.1,
					)
				) {
					continue;
				}

				const u2s = vertices.map((v) => v.u2);
				const v2s = vertices.map((v) => v.v2);
				const u2Span = Math.max(...u2s) - Math.min(...u2s);
				const v2Span = Math.max(...v2s) - Math.min(...v2s);
				if (u2Span > 0.01 && v2Span > 0.01) {
					hasNonCollapsedCornerFace = true;
				}
			}

			expect(hasNonCollapsedCornerFace).toBe(true);
		});

		it("should clamp the bevel radius to half the depth", () => {
			const mesh = buildExtrudeMesh({
				segments: rect(0, 0, 20, 20),
				depth: 4,
				bevelSize: 100,
			});
			expect(mesh).not.toBe(null);
			for (let i = 0; i < mesh!.vertices.length; i += EXTRUDE_VERTEX_FLOATS) {
				const z = mesh!.vertices[i + 2];
				expect(z).toBeGreaterThanOrEqual(-4);
				expect(z).toBeLessThanOrEqual(0);
			}
		});
	});

	describe("side smoothing", () => {
		it("should average side normals across gently-curved outlines", () => {
			// Regular 24-gon: adjacent edges differ by 15° < the 30° threshold,
			// so both wall quads at a shared corner get the same averaged normal.
			const mesh = buildExtrudeMesh({
				segments: regularPolygon(10, 10, 8, 24),
				depth: 5,
			})!;
			expect(distinctSideNormalCounts(mesh)).toEqual(new Set([1]));
		});

		it("should keep hard creases on right-angle corners", () => {
			// Rectangle corners are 90° ≥ threshold — each wall keeps its own
			// flat normal, so corner positions carry two distinct normals.
			const mesh = buildExtrudeMesh({
				segments: rect(0, 0, 10, 10),
				depth: 5,
			})!;
			expect(distinctSideNormalCounts(mesh).has(2)).toBe(true);
		});
	});

	describe("fill uv", () => {
		it("should map front/side uv from position with a flipped Y", () => {
			const mesh = buildExtrudeMesh({
				segments: rect(2, 3, 10, 10),
				depth: 5,
			})!;
			const { minX, minY, maxX, maxY } = mesh.bounds2d;
			const w = maxX - minX;
			const h = maxY - minY;
			for (let i = 0; i < mesh.vertices.length; i += EXTRUDE_VERTEX_FLOATS) {
				const x = mesh.vertices[i];
				const y = mesh.vertices[i + 1];
				const u = mesh.vertices[i + 6];
				const v = mesh.vertices[i + 7];
				expect(v).toBeCloseTo((maxY - y) / h);
				// Front and back caps map u from the same position, so each shape's
				// back samples its own fill (geometry mirrors it when rotated).
				expect(u).toBeCloseTo((x - minX) / w);
			}
		});

		it("should pull wall uv samples inward by uvInset while caps stay put", () => {
			const mesh = buildExtrudeMesh({
				segments: rect(0, 0, 10, 10),
				depth: 5,
				uvInset: 1,
			})!;
			const { minX, maxX, maxY } = mesh.bounds2d;
			const w = maxX - minX;
			for (let i = 0; i < mesh.vertices.length; i += EXTRUDE_VERTEX_FLOATS) {
				const x = mesh.vertices[i];
				const y = mesh.vertices[i + 1];
				const nx = mesh.vertices[i + 3];
				const ny = mesh.vertices[i + 4];
				const nz = mesh.vertices[i + 5];
				const u = mesh.vertices[i + 6];
				const v = mesh.vertices[i + 7];
				if (nz === 1 || nz === -1) {
					// Caps keep the plain projection (front and back use the same u).
					expect(u).toBeCloseTo((x - minX) / w);
					expect(v).toBeCloseTo((maxY - y) / w);
				} else {
					// Walls sample 1 world unit inward along the outward normal.
					expect(u).toBeCloseTo((x - nx - minX) / w);
					expect(v).toBeCloseTo((maxY - (y - ny)) / w);
				}
			}
		});

		it("should span the full 0..1 uv range across the outline", () => {
			const mesh = buildExtrudeMesh({
				segments: rect(0, 0, 10, 10),
				depth: 5,
			})!;
			let minU = Infinity;
			let maxU = -Infinity;
			let minV = Infinity;
			let maxV = -Infinity;
			for (let i = 0; i < mesh.vertices.length; i += EXTRUDE_VERTEX_FLOATS) {
				minU = Math.min(minU, mesh.vertices[i + 6]);
				maxU = Math.max(maxU, mesh.vertices[i + 6]);
				minV = Math.min(minV, mesh.vertices[i + 7]);
				maxV = Math.max(maxV, mesh.vertices[i + 7]);
			}
			expect(minU).toBeCloseTo(0);
			expect(maxU).toBeCloseTo(1);
			expect(minV).toBeCloseTo(0);
			expect(maxV).toBeCloseTo(1);
		});
	});

	describe("wrap uv (uv2)", () => {
		it("should carry world (x, -y) on the caps, X-mirrored on the back", () => {
			const mesh = buildExtrudeMesh({
				segments: rect(0, 0, 10, 10),
				depth: 5,
			})!;
			const centerX2 = mesh.bounds2d.minX + mesh.bounds2d.maxX;
			for (let i = 0; i < mesh.vertices.length; i += EXTRUDE_VERTEX_FLOATS) {
				const x = mesh.vertices[i];
				const y = mesh.vertices[i + 1];
				const nz = mesh.vertices[i + 5];
				const u2 = mesh.vertices[i + 8];
				const v2 = mesh.vertices[i + 9];
				if (nz > 0.5) {
					expect(u2).toBeCloseTo(x);
					expect(v2).toBeCloseTo(-y);
				} else if (nz < -0.5) {
					expect(u2).toBeCloseTo(centerX2 - x);
					expect(v2).toBeCloseTo(-y);
				}
			}
		});

		it("should wrap side walls by (arc length, depth from the front)", () => {
			const mesh = buildExtrudeMesh({
				segments: rect(0, 0, 10, 10),
				depth: 5,
			})!;
			const depthRows = new Set<number>();
			let minU2 = Infinity;
			let maxU2 = -Infinity;
			for (let i = 0; i < mesh.vertices.length; i += EXTRUDE_VERTEX_FLOATS) {
				if (Math.abs(mesh.vertices[i + 5]) > 0.5) continue; // walls only
				const u2 = mesh.vertices[i + 8];
				depthRows.add(Math.round(mesh.vertices[i + 9]));
				minU2 = Math.min(minU2, u2);
				maxU2 = Math.max(maxU2, u2);
			}
			// v2 = depth position: front row 0, back row = depth 5.
			expect(depthRows).toEqual(new Set([0, 5]));
			// u2 covers 0 → perimeter (10×10 square = 40) monotonically.
			expect(minU2).toBeCloseTo(0);
			expect(maxU2).toBeCloseTo(40);
		});
	});

	describe("rebaseToCenter", () => {
		it("should shift positions to the outline center while keeping world UV", () => {
			const world = buildExtrudeMesh({
				segments: rect(2, 3, 10, 10),
				depth: 5,
			})!;
			const rebased = buildExtrudeMesh({
				segments: rect(2, 3, 10, 10),
				depth: 5,
				rebaseToCenter: true,
			})!;
			const cx = (world.bounds2d.minX + world.bounds2d.maxX) / 2;
			const cy = (world.bounds2d.minY + world.bounds2d.maxY) / 2;
			// bounds2d stays in world; only stored positions move.
			expect(rebased.bounds2d).toEqual(world.bounds2d);
			expect(rebased.vertices.length).toBe(world.vertices.length);
			for (let i = 0; i < world.vertices.length; i += EXTRUDE_VERTEX_FLOATS) {
				expect(rebased.vertices[i]).toBeCloseTo(world.vertices[i] - cx);
				expect(rebased.vertices[i + 1]).toBeCloseTo(world.vertices[i + 1] - cy);
				expect(rebased.vertices[i + 2]).toBeCloseTo(world.vertices[i + 2]);
				// Normals (3-5), fill uv (6,7) and wrap uv2 (8,9) are unchanged.
				for (const slot of [3, 4, 5, 6, 7, 8, 9]) {
					expect(rebased.vertices[i + slot]).toBeCloseTo(
						world.vertices[i + slot],
					);
				}
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

/** Closed CCW rectangle (Y-up world coordinates). */
function rect(
	x: number,
	y: number,
	w: number,
	h: number,
	isMoved = false,
): CubicBezierSegment[] {
	const points: BezierPoint[] = [
		{ x, y },
		{ x: x + w, y },
		{ x: x + w, y: y + h },
		{ x, y: y + h },
	];
	return points.map((p, i) =>
		lineSeg(p, points[(i + 1) % points.length], i === 0 && isMoved),
	);
}

/** Closed CW rectangle (hole winding). */
function rectCW(
	x: number,
	y: number,
	w: number,
	h: number,
	isMoved = false,
): CubicBezierSegment[] {
	const points: BezierPoint[] = [
		{ x, y },
		{ x, y: y + h },
		{ x: x + w, y: y + h },
		{ x: x + w, y },
	];
	return points.map((p, i) =>
		lineSeg(p, points[(i + 1) % points.length], i === 0 && isMoved),
	);
}

/** Closed CCW regular polygon. */
function regularPolygon(
	cx: number,
	cy: number,
	radius: number,
	sides: number,
): CubicBezierSegment[] {
	const points: BezierPoint[] = [];
	for (let i = 0; i < sides; i++) {
		const angle = (i / sides) * Math.PI * 2;
		points.push({
			x: cx + radius * Math.cos(angle),
			y: cy + radius * Math.sin(angle),
		});
	}
	return points.map((p, i) =>
		lineSeg(p, points[(i + 1) % points.length], i === 0),
	);
}

/**
 * Group side-wall vertices (normal z = 0, position z = 0) by position and
 * count how many distinct normals each position carries.
 */
function distinctSideNormalCounts(mesh: {
	vertices: Float32Array;
	indices: Uint32Array;
}): Set<number> {
	const normalsByPosition = new Map<string, Set<string>>();
	for (let i = 0; i < mesh.vertices.length; i += EXTRUDE_VERTEX_FLOATS) {
		const z = mesh.vertices[i + 2];
		const nz = mesh.vertices[i + 5];
		if (z !== 0 || nz !== 0) continue;
		const posKey = `${mesh.vertices[i].toFixed(4)},${mesh.vertices[i + 1].toFixed(4)}`;
		const normalKey = `${mesh.vertices[i + 3].toFixed(4)},${mesh.vertices[i + 4].toFixed(4)}`;
		let set = normalsByPosition.get(posKey);
		if (!set) {
			set = new Set();
			normalsByPosition.set(posKey, set);
		}
		set.add(normalKey);
	}
	return new Set([...normalsByPosition.values()].map((s) => s.size));
}

function triangle(
	mesh: { vertices: Float32Array; indices: Uint32Array },
	offset: number,
): [number, number, number][] {
	return [0, 1, 2].map((k) => {
		const v = mesh.indices[offset + k] * EXTRUDE_VERTEX_FLOATS;
		return [mesh.vertices[v], mesh.vertices[v + 1], mesh.vertices[v + 2]];
	});
}

function vertex(
	mesh: { vertices: Float32Array },
	index: number,
): {
	x: number;
	y: number;
	nx: number;
	ny: number;
	u2: number;
	v2: number;
} {
	const i = index * EXTRUDE_VERTEX_FLOATS;
	return {
		x: mesh.vertices[i],
		y: mesh.vertices[i + 1],
		nx: mesh.vertices[i + 3],
		ny: mesh.vertices[i + 4],
		u2: mesh.vertices[i + 8],
		v2: mesh.vertices[i + 9],
	};
}

/** Total unsigned area of front-cap (z = 0) triangles. */
function frontCapArea(mesh: {
	vertices: Float32Array;
	indices: Uint32Array;
}): number {
	let area = 0;
	for (let t = 0; t < mesh.indices.length; t += 3) {
		const [a, b, c] = triangle(mesh, t);
		if (a[2] !== 0 || b[2] !== 0 || c[2] !== 0) continue;
		area +=
			Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) /
			2;
	}
	return area;
}
