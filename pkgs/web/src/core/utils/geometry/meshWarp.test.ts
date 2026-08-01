import { createIdentityTransform } from "@/core/document/factory";
import type {
	FillAppearance,
	FreeGradientStop,
	Group,
	ImageObject,
	MeshArtObject,
	MeshFace,
	MeshGeometryVertex,
	Path,
	PathSegment,
	Point,
} from "@/core/schema";
import { toRGBColor } from "@/core/schema";
import {
	evalEdge,
	getVertexNeighbors,
	rotateDerivedCrossHandles,
	syncDerivedVertices,
} from "./meshGradient";
import {
	createMeshWarpInverse,
	createMeshWarpSampler,
	createWarpCageFromRect,
	demoteWarpVertexToDerived,
	promoteWarpVertexToExplicit,
	subdivideWarpFace,
	warpMeshChildren,
} from "./meshWarp";

const RECT = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

describe("createWarpCageFromRect", () => {
	it("should create a single CCW quad with src equal to position", () => {
		const cage = createWarpCageFromRect(RECT);
		expect(cage.faces).toEqual([{ type: "quad", verts: [0, 1, 2, 3] }]);
		expect(cage.vertices).toHaveLength(4);
		for (const vertex of cage.vertices) {
			expect(vertex.src).toEqual({ x: vertex.x, y: vertex.y });
			expect(vertex.handles).toEqual({});
		}
	});
});

describe("createMeshWarpSampler", () => {
	it("should return the identity mapping for an undeformed cage", () => {
		const cage = createWarpCageFromRect(RECT);
		const warp = createMeshWarpSampler(cage.vertices, cage.faces);
		for (const p of gridPoints(0, 100, 5)) {
			const q = warp(p);
			expect(q.x).toBeCloseTo(p.x, 9);
			expect(q.y).toBeCloseTo(p.y, 9);
		}
	});

	it("should move points near a dragged vertex while keeping other corners fixed", () => {
		const cage = createWarpCageFromRect(RECT);
		cage.vertices[2] = { ...cage.vertices[2], x: 140, y: 150 };
		const warp = createMeshWarpSampler(cage.vertices, cage.faces);
		expect(warp({ x: 100, y: 100 })).toEqual({ x: 140, y: 150 });
		expect(warp({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
		expect(warp({ x: 100, y: 0 })).toEqual({ x: 100, y: 0 });
		expect(warp({ x: 0, y: 100 })).toEqual({ x: 0, y: 100 });
	});

	it("should follow the effective edge curve along a bent boundary", () => {
		const cage = createWarpCageFromRect(RECT);
		cage.vertices[0].handles[1] = { x: 33, y: -20 };
		cage.vertices[1].handles[0] = { x: 67, y: -20 };
		const warp = createMeshWarpSampler(cage.vertices, cage.faces);
		for (const t of [0, 0.25, 0.5, 0.75, 1]) {
			const expected = evalEdge(cage.vertices, cage.faces, 0, 1, t);
			const actual = warp({ x: t * 100, y: 0 });
			expect(actual.x).toBeCloseTo(expected.x, 9);
			expect(actual.y).toBeCloseTo(expected.y, 9);
		}
	});

	it("should extrapolate continuously just outside the cage", () => {
		const cage = createWarpCageFromRect(RECT);
		cage.vertices[2] = { ...cage.vertices[2], x: 130, y: 120 };
		cage.vertices[0].handles[1] = { x: 30, y: -25 };
		cage.vertices[1].handles[0] = { x: 70, y: -25 };
		const warp = createMeshWarpSampler(cage.vertices, cage.faces);
		const onEdge = warp({ x: 50, y: 0 });
		const outside = warp({ x: 50, y: -0.001 });
		expect(Math.hypot(outside.x - onEdge.x, outside.y - onEdge.y)).toBeLessThan(
			0.01,
		);
	});

	it("should preserve the outer boundary exactly across a subdivision", () => {
		const cage = deformedCage();
		const warpBefore = createMeshWarpSampler(cage.vertices, cage.faces);
		const subdivided = subdivideWarpFace(
			cage.vertices,
			cage.faces,
			0,
			0.4,
			0.6,
		);
		expect(subdivided).not.toBeNull();
		if (!subdivided) return;
		const warpAfter = createMeshWarpSampler(
			subdivided.vertices,
			subdivided.faces,
		);
		// Boundary source points: bottom/top/left/right edges of the source rect.
		for (const t of [0, 0.1, 0.4, 0.5, 0.9, 1]) {
			for (const p of [
				{ x: t * 100, y: 0 },
				{ x: t * 100, y: 100 },
				{ x: 0, y: t * 100 },
				{ x: 100, y: t * 100 },
			]) {
				const a = warpBefore(p);
				const b = warpAfter(p);
				expect(b.x).toBeCloseTo(a.x, 6);
				expect(b.y).toBeCloseTo(a.y, 6);
			}
		}
		// The split point itself lies on the original surface.
		const srcCenter = { x: 40, y: 60 };
		const a = warpBefore(srcCenter);
		const b = warpAfter(srcCenter);
		expect(b.x).toBeCloseTo(a.x, 6);
		expect(b.y).toBeCloseTo(a.y, 6);
	});

	it("should stay the identity everywhere after subdividing an undeformed cage", () => {
		const cage = createWarpCageFromRect(RECT);
		const subdivided = subdivideWarpFace(
			cage.vertices,
			cage.faces,
			0,
			0.25,
			0.5,
		);
		expect(subdivided).not.toBeNull();
		if (!subdivided) return;
		const warp = createMeshWarpSampler(subdivided.vertices, subdivided.faces);
		for (const p of gridPoints(0, 100, 5)) {
			const q = warp(p);
			expect(q.x).toBeCloseTo(p.x, 6);
			expect(q.y).toBeCloseTo(p.y, 6);
		}
	});
});

describe("createMeshWarpInverse", () => {
	it("should invert the forward mapping inside the cage", () => {
		const cage = deformedCage();
		const warp = createMeshWarpSampler(cage.vertices, cage.faces);
		const inverse = createMeshWarpInverse(cage.vertices, cage.faces);
		for (const p of gridPoints(10, 90, 5)) {
			const roundTrip = inverse(warp(p));
			expect(roundTrip).not.toBeNull();
			if (!roundTrip) continue;
			expect(roundTrip.x).toBeCloseTo(p.x, 6);
			expect(roundTrip.y).toBeCloseTo(p.y, 6);
		}
	});

	it("should return null outside the deformed cage", () => {
		const cage = deformedCage();
		const inverse = createMeshWarpInverse(cage.vertices, cage.faces);
		expect(inverse({ x: 500, y: 500 })).toBeNull();
		expect(inverse({ x: -200, y: -200 })).toBeNull();
	});
});

describe("syncDerivedVertices (warp cage)", () => {
	it("should keep derived vertices on their owning edge when a root vertex moves", () => {
		const cage = createWarpCageFromRect(RECT);
		const subdivided = subdivideWarpFace(
			cage.vertices,
			cage.faces,
			0,
			0.5,
			0.5,
		);
		expect(subdivided).not.toBeNull();
		if (!subdivided) return;
		const derivedIdx = subdivided.vertices.findIndex(
			(v) =>
				v.positionSource?.edgeVerts[0] === 0 &&
				v.positionSource.edgeVerts[1] === 1,
		);
		expect(derivedIdx).toBeGreaterThanOrEqual(0);

		// Drag the root corner (100,0) to (200,0): the mid vertex on the bottom
		// edge must follow to the new edge midpoint.
		subdivided.vertices[1] = { ...subdivided.vertices[1], x: 200, y: 0 };
		syncDerivedVertices(subdivided.vertices, subdivided.faces);

		expect(subdivided.vertices[derivedIdx].x).toBeCloseTo(100, 6);
		expect(subdivided.vertices[derivedIdx].y).toBeCloseTo(0, 6);
	});

	it("should translate a derived vertex's handles together with its position", () => {
		const cage = createWarpCageFromRect(RECT);
		const subdivided = subdivideWarpFace(
			cage.vertices,
			cage.faces,
			0,
			0.5,
			0.5,
		);
		expect(subdivided).not.toBeNull();
		if (!subdivided) return;
		const derivedIdx = subdivided.vertices.findIndex(
			(v) =>
				v.positionSource?.edgeVerts[0] === 0 &&
				v.positionSource.edgeVerts[1] === 1,
		);
		expect(derivedIdx).toBeGreaterThanOrEqual(0);
		const derived = subdivided.vertices[derivedIdx];
		// Give the derived vertex a cross-edge handle (toward the face center).
		derived.handles = { 99: { x: derived.x + 5, y: derived.y + 30 } };

		subdivided.vertices[1] = { ...subdivided.vertices[1], x: 200, y: 0 };
		syncDerivedVertices(subdivided.vertices, subdivided.faces);

		// Position moved from (50,0) to (100,0); the handle keeps its offset.
		expect(derived.x).toBeCloseTo(100, 6);
		expect(derived.handles[99].x).toBeCloseTo(105, 6);
		expect(derived.handles[99].y).toBeCloseTo(30, 6);
	});
});

describe("rotateDerivedCrossHandles", () => {
	it("turns a split line with the edge it hangs off", () => {
		const cage = createWarpCageFromRect(RECT);
		const subdivided = subdivideWarpFace(
			cage.vertices,
			cage.faces,
			0,
			0.5,
			0.5,
		);
		expect(subdivided).not.toBeNull();
		if (!subdivided) return;
		const { vertices, faces, centerIdx } = subdivided;

		// The derived vertex on the bottom edge, and its split line toward the
		// centre: give it a stored handle pointing straight up into the patch.
		const derivedIdx = vertices.findIndex(
			(v) =>
				v.positionSource?.edgeVerts[0] === 0 &&
				v.positionSource.edgeVerts[1] === 1,
		);
		expect(derivedIdx).toBeGreaterThanOrEqual(0);
		vertices[derivedIdx].handles[centerIdx] = {
			x: vertices[derivedIdx].x,
			y: vertices[derivedIdx].y + 20,
		};
		const before = vertices.map((v) => ({ ...v, handles: { ...v.handles } }));

		// Bend the bottom edge by pulling vertex 0's root handle upward, then
		// resync as the tool does.
		vertices[0].handles[1] = { x: 33, y: 60 };
		syncDerivedVertices(vertices, faces);
		rotateDerivedCrossHandles(before, vertices, faces);

		const handle = vertices[derivedIdx].handles[centerIdx];
		const dx = handle.x - vertices[derivedIdx].x;
		const dy = handle.y - vertices[derivedIdx].y;
		// The edge now runs uphill under the vertex, so the split line tilts with
		// it instead of staying straight up.
		expect(Math.abs(dx)).toBeGreaterThan(1);
		// Length is preserved — the handle only turns.
		expect(Math.hypot(dx, dy)).toBeCloseTo(20, 6);
	});

	it("leaves along-edge handles alone", () => {
		const cage = createWarpCageFromRect(RECT);
		const subdivided = subdivideWarpFace(
			cage.vertices,
			cage.faces,
			0,
			0.5,
			0.5,
		);
		expect(subdivided).not.toBeNull();
		if (!subdivided) return;
		const { vertices, faces } = subdivided;
		const derivedIdx = vertices.findIndex(
			(v) =>
				v.positionSource?.edgeVerts[0] === 0 &&
				v.positionSource.edgeVerts[1] === 1,
		);
		vertices[derivedIdx].handles[0] = { x: 30, y: 0 };
		const before = vertices.map((v) => ({ ...v, handles: { ...v.handles } }));

		vertices[0].handles[1] = { x: 33, y: 60 };
		syncDerivedVertices(vertices, faces);
		rotateDerivedCrossHandles(before, vertices, faces);

		// Handle 0 lies along the vertex's own edge: the effective curve ignores
		// it, so rotating it would be meaningless churn.
		const moved = vertices[derivedIdx].handles[0];
		const originalOffset = {
			x: 30 - before[derivedIdx].x,
			y: 0 - before[derivedIdx].y,
		};
		expect(moved.x - vertices[derivedIdx].x).toBeCloseTo(originalOffset.x, 6);
		expect(moved.y - vertices[derivedIdx].y).toBeCloseTo(originalOffset.y, 6);
	});
});

describe("subdivideWarpFace (single-axis cut)", () => {
	it("should insert a vertex on the clicked edge without a face center", () => {
		const cage = createWarpCageFromRect(RECT);
		// Cut only along u at u=0.4, pinned to the bottom edge (v=0).
		const result = subdivideWarpFace(cage.vertices, cage.faces, 0, 0.4, 0, {
			u: true,
		});
		expect(result).not.toBeNull();
		if (!result) return;

		// One cut line → two faces, two derived vertices (bottom + top edges).
		expect(result.faces).toHaveLength(2);
		expect(result.vertices).toHaveLength(6);
		for (const v of result.vertices.slice(4)) {
			expect(v.positionSource).toBeDefined();
		}

		// centerIdx is the vertex on the clicked (bottom) edge.
		const center = result.vertices[result.centerIdx];
		expect(center.x).toBeCloseTo(40, 6);
		expect(center.y).toBeCloseTo(0, 6);
		expect(center.src).toEqual({ x: 40, y: 0 });
	});

	it("should run a new cut line straight across an already-cut cage", () => {
		const cage = createWarpCageFromRect(RECT);
		const grid = subdivideWarpFace(cage.vertices, cage.faces, 0, 0.5, 0.5);
		expect(grid).not.toBeNull();
		if (!grid) return;
		// The 2x2 grid: corners 0..3, edge mid-points 4..7, center 8.
		const bottomLeftFace = grid.faces.findIndex(
			(face) => face.verts.includes(0) && face.verts.includes(4),
		);
		expect(bottomLeftFace).toBeGreaterThanOrEqual(0);

		// Click halfway along the bottom edge's left half: source x = 25.
		const result = subdivideWarpFace(
			grid.vertices,
			grid.faces,
			bottomLeftFace,
			0.5,
			0,
			{ u: true },
		);
		expect(result).not.toBeNull();
		if (!result) return;

		// The cut runs the full height: a vertex on the bottom edge, one where
		// it crosses the existing horizontal line, one on the top edge.
		expect(result.vertices).toHaveLength(grid.vertices.length + 3);
		expect(result.faces).toHaveLength(6);
		for (const face of result.faces) expect(face.type).toBe("quad");
		const added = result.vertices.slice(grid.vertices.length);
		expect(added.map((v) => v.src)).toEqual([
			{ x: 25, y: 0 },
			{ x: 25, y: 50 },
			{ x: 25, y: 100 },
		]);

		// The vertex on the bottom edge joins its two neighbors along that edge
		// and the one directly above it — nothing else.
		const inserted = result.centerIdx;
		const above = result.vertices.findIndex(
			(v) => v.src.x === 25 && v.src.y === 50,
		);
		expect([...getVertexNeighbors(result.faces, inserted)].sort()).toEqual(
			[0, 4, above].sort(),
		);

		// Every source-space face stays an axis-aligned rectangle, which is what
		// the warp sampler resolves points through.
		for (const face of result.faces) {
			const xs = face.verts.map((vi) => result.vertices[vi].src.x);
			const ys = face.verts.map((vi) => result.vertices[vi].src.y);
			expect(new Set(xs).size).toBe(2);
			expect(new Set(ys).size).toBe(2);
		}
	});

	it("should preserve the outer boundary exactly across a single-axis cut", () => {
		const cage = deformedCage();
		const warpBefore = createMeshWarpSampler(cage.vertices, cage.faces);
		const result = subdivideWarpFace(cage.vertices, cage.faces, 0, 0, 0.7, {
			v: true,
		});
		expect(result).not.toBeNull();
		if (!result) return;
		const warpAfter = createMeshWarpSampler(result.vertices, result.faces);
		// Same guarantee as a full subdivision: boundary curves are exact (the
		// interior cut line is straight — C0 — matching mesh gradients).
		for (const t of [0, 0.1, 0.4, 0.5, 0.7, 0.9, 1]) {
			for (const p of [
				{ x: t * 100, y: 0 },
				{ x: t * 100, y: 100 },
				{ x: 0, y: t * 100 },
				{ x: 100, y: t * 100 },
			]) {
				const a = warpBefore(p);
				const b = warpAfter(p);
				expect(b.x).toBeCloseTo(a.x, 6);
				expect(b.y).toBeCloseTo(a.y, 6);
			}
		}
	});
});

describe("promoteWarpVertexToExplicit", () => {
	it("should clear the derived sources without changing the warp", () => {
		const cage = deformedCage();
		const subdivided = subdivideWarpFace(
			cage.vertices,
			cage.faces,
			0,
			0.5,
			0.5,
		);
		expect(subdivided).not.toBeNull();
		if (!subdivided) return;
		const derivedIdx = subdivided.vertices.findIndex(
			(v) => v.positionSource != null,
		);
		expect(derivedIdx).toBeGreaterThanOrEqual(0);
		const before = createMeshWarpSampler(subdivided.vertices, subdivided.faces);

		const promoted = promoteWarpVertexToExplicit(
			subdivided.vertices,
			subdivided.faces,
			derivedIdx,
		);
		expect(promoted).not.toBeNull();
		if (!promoted) return;

		expect(promoted[derivedIdx].positionSource).toBeUndefined();
		expect(promoted[derivedIdx].meshSource).toBeUndefined();
		expect(promoted[derivedIdx].splitLineId).toBeUndefined();
		// Original arrays are untouched.
		expect(subdivided.vertices[derivedIdx].positionSource).toBeDefined();

		const after = createMeshWarpSampler(promoted, subdivided.faces);
		for (const p of gridPoints(0, 100, 5)) {
			const a = before(p);
			const b = after(p);
			expect(b.x).toBeCloseTo(a.x, 6);
			expect(b.y).toBeCloseTo(a.y, 6);
		}
	});

	it("should return null for an explicit vertex", () => {
		const cage = createWarpCageFromRect(RECT);
		expect(
			promoteWarpVertexToExplicit(cage.vertices, cage.faces, 0),
		).toBeNull();
	});
});

describe("demoteWarpVertexToDerived", () => {
	it("should bind a promoted vertex back to the edge it was cut from", () => {
		const cage = createWarpCageFromRect(RECT);
		const cut = subdivideWarpFace(cage.vertices, cage.faces, 0, 0.4, 0, {
			u: true,
		});
		expect(cut).not.toBeNull();
		if (!cut) return;
		const promoted = promoteWarpVertexToExplicit(
			cut.vertices,
			cut.faces,
			cut.centerIdx,
		);
		expect(promoted).not.toBeNull();
		if (!promoted) return;
		// The user pulls the promoted vertex off its edge before deleting it.
		promoted[cut.centerIdx] = { ...promoted[cut.centerIdx], x: 40, y: 25 };

		const demoted = demoteWarpVertexToDerived(
			promoted,
			cut.faces,
			cut.centerIdx,
		);
		expect(demoted).not.toBeNull();
		if (!demoted) return;
		syncDerivedVertices(demoted, cut.faces);

		const vertex = demoted[cut.centerIdx];
		// Back on the bottom edge, owned by the two corners it runs between.
		expect(vertex.positionSource?.edgeVerts).toEqual([0, 1]);
		expect(vertex.y).toBeCloseTo(0, 6);
		expect(vertex.x).toBeCloseTo(40, 0);
		// It anchors the same cut line as its sibling on the top edge again.
		expect(vertex.splitLineId).toBe(demoted[cut.centerIdx + 1].splitLineId);
		// The cage keeps its shape: no vertex or face went away.
		expect(demoted).toHaveLength(promoted.length);
	});

	it("should return the vertex to the spot its source position names", () => {
		const cage = createWarpCageFromRect(RECT);
		const cut = subdivideWarpFace(cage.vertices, cage.faces, 0, 0.4, 0, {
			u: true,
		});
		expect(cut).not.toBeNull();
		if (!cut) return;
		const promoted = promoteWarpVertexToExplicit(
			cut.vertices,
			cut.faces,
			cut.centerIdx,
		);
		expect(promoted).not.toBeNull();
		if (!promoted) return;
		// While explicit, the user slides it far along the bottom edge.
		promoted[cut.centerIdx] = { ...promoted[cut.centerIdx], x: 80, y: 0 };

		const demoted = demoteWarpVertexToDerived(
			promoted,
			cut.faces,
			cut.centerIdx,
		);
		expect(demoted).not.toBeNull();
		if (!demoted) return;
		syncDerivedVertices(demoted, cut.faces);

		// A derived vertex's position follows its source position, so it lands
		// back at x = 40 rather than keeping the 80 it was dragged to.
		expect(demoted[cut.centerIdx].src.x).toBe(40);
		expect(demoted[cut.centerIdx].x).toBeCloseTo(40, 6);
		expect(demoted[cut.centerIdx].y).toBeCloseTo(0, 6);

		// A cut on the same edge then lines its vertices up across the cage.
		const rightFace = cut.faces.findIndex((face) => face.verts.includes(1));
		const recut = subdivideWarpFace(demoted, cut.faces, rightFace, 0.5, 0, {
			u: true,
		});
		expect(recut).not.toBeNull();
		if (!recut) return;
		syncDerivedVertices(recut.vertices, recut.faces);
		const added = recut.vertices.slice(demoted.length);
		expect(added).toHaveLength(2);
		expect(added[0].x).toBeCloseTo(added[1].x, 6);
	});

	it("should return null for a vertex the user placed", () => {
		const cage = createWarpCageFromRect(RECT);
		const subdivided = subdivideWarpFace(
			cage.vertices,
			cage.faces,
			0,
			0.5,
			0.5,
		);
		expect(subdivided).not.toBeNull();
		if (!subdivided) return;
		// The clicked center of a subdivision was never derived, and neither
		// were the cage's own corners.
		expect(
			demoteWarpVertexToDerived(
				subdivided.vertices,
				subdivided.faces,
				subdivided.centerIdx,
			),
		).toBeNull();
		expect(
			demoteWarpVertexToDerived(subdivided.vertices, subdivided.faces, 0),
		).toBeNull();
	});
});

describe("warpMeshChildren", () => {
	it("should bend an image child's interior grid along the cage curvature", () => {
		const cage = createWarpCageFromRect(RECT);
		// Bow the bottom cage edge downward — the 4-corner projective blit
		// could never reproduce this inside the image.
		cage.vertices[0].handles[1] = { x: 33, y: -30 };
		cage.vertices[1].handles[0] = { x: 67, y: -30 };
		const image: ImageObject = {
			id: "img-1",
			type: "image",
			fileUid: "file-1",
			x: 50,
			y: 50,
			width: 100,
			height: 100,
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};
		const mesh: MeshArtObject = {
			id: "mesh-1",
			type: "mesh",
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			childIds: [image.id],
			vertices: cage.vertices,
			faces: cage.faces,
		};

		const { transients, imageWarpGrids } = warpMeshChildren(mesh, {
			resolve: (id) => (id === image.id ? image : null),
			getTextGlyphPaths: () => null,
		});

		expect(transients).toHaveLength(1);
		const grid = imageWarpGrids.get(`${mesh.id}::warp::${image.id}`);
		expect(grid).toBeInstanceOf(Float32Array);
		if (!grid) return;

		// The image's bottom edge midpoint (uv (0.5, 1) = source (50, 0)) lies
		// on the cage boundary, so it must sit on the bent edge curve — not on
		// the straight line between the warped corners.
		const expected = evalEdge(cage.vertices, cage.faces, 0, 1, 0.5);
		expect(expected.y).toBeLessThan(-1);
		let found = false;
		for (let i = 0; i < grid.length; i += 4) {
			if (grid[i + 2] === 0.5 && grid[i + 3] === 1) {
				expect(grid[i]).toBeCloseTo(expected.x, 6);
				expect(grid[i + 1]).toBeCloseTo(expected.y, 6);
				found = true;
				break;
			}
		}
		expect(found).toBe(true);
	});

	it("should bend a free gradient's implicit cell edges with the cage", () => {
		const cage = createWarpCageFromRect(RECT);
		// Bow the bottom cage edge downward so the warp is non-affine.
		cage.vertices[0].handles[1] = { x: 33, y: -40 };
		cage.vertices[1].handles[0] = { x: 67, y: -40 };
		const gradientPath: Path = {
			id: "path-1",
			type: "path",
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			segments: [
				straightSegment({ x: 0, y: 0 }, { x: 100, y: 0 }, true),
				straightSegment({ x: 100, y: 0 }, { x: 100, y: 100 }),
				straightSegment({ x: 100, y: 100 }, { x: 0, y: 100 }),
				straightSegment({ x: 0, y: 100 }, { x: 0, y: 0 }),
			],
			filters: [
				{
					uid: "fill-1",
					processor: "fill",
					enabled: true,
					opacity: 1,
					blendMode: "normal",
					paramData: {
						version: "1",
						params: {
							fill: {
								type: "free",
								stops: [
									freeStop("a", 0.1, 0.1),
									freeStop("b", 0.9, 0.1),
									freeStop("c", 0.5, 0.9),
								],
							},
						},
					},
				},
			],
		};
		const mesh: MeshArtObject = {
			id: "mesh-1",
			type: "mesh",
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			childIds: [gradientPath.id],
			vertices: cage.vertices,
			faces: cage.faces,
		};

		const { transients } = warpMeshChildren(mesh, {
			resolve: (id) => (id === gradientPath.id ? gradientPath : null),
			getTextGlyphPaths: () => null,
		});
		const warped = transients[0];
		expect(warped.type).toBe("path");
		const fillFilter = warped.filters?.find((f) => f.processor === "fill");
		const fill = (fillFilter as FillAppearance | undefined)?.paramData.params
			.fill;
		expect(fill?.type).toBe("free");
		if (fill?.type !== "free") return;

		// Every cell edge must carry a materialized CP: the renderer rebuilds
		// missing ones as straight lines between the warped stops, which would
		// undo the bend.
		const stopA = fill.stops[0];
		const stopB = fill.stops[1];
		expect(stopA.edgeCPs?.b).toBeDefined();
		if (!stopA.edgeCPs?.b) return;
		const straight = {
			x: stopA.x + (stopB.x - stopA.x) / 3,
			y: stopA.y + (stopB.y - stopA.y) / 3,
		};
		const bend = Math.hypot(
			stopA.edgeCPs.b.x - straight.x,
			stopA.edgeCPs.b.y - straight.y,
		);
		expect(bend).toBeGreaterThan(0.01);
	});

	it("should keep one contour when subdividing a sub-path opener", () => {
		const cage = createWarpCageFromRect(RECT);
		// Bend hard enough that every segment gets split several times.
		cage.vertices[0].handles[1] = { x: 33, y: -60 };
		cage.vertices[1].handles[0] = { x: 67, y: -60 };
		const square: Path = {
			id: "square-1",
			type: "path",
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			segments: [
				straightSegment({ x: 10, y: 10 }, { x: 90, y: 10 }, true),
				straightSegment({ x: 90, y: 10 }, { x: 90, y: 90 }),
				straightSegment({ x: 90, y: 90 }, { x: 10, y: 90 }),
				straightSegment({ x: 10, y: 90 }, { x: 10, y: 10 }),
			],
		};
		// The first segment opens the sub-path, as a real path's does.
		square.segments[0] = { ...square.segments[0], isMoved: true };
		const mesh: MeshArtObject = {
			id: "mesh-1",
			type: "mesh",
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			childIds: [square.id],
			vertices: cage.vertices,
			faces: cage.faces,
		};

		const { transients } = warpMeshChildren(mesh, {
			resolve: (id) => (id === square.id ? square : null),
			getTextGlyphPaths: () => null,
		});
		const warped = transients[0];
		expect(warped.type).toBe("path");
		if (warped.type !== "path") return;

		expect(warped.segments.length).toBeGreaterThan(4);
		// A sub-path opens where `isMoved` or `start` is set; the split pieces
		// must chain instead, or the contour tears apart (visible as spikes).
		const openers = warped.segments.filter(
			(seg, i) => i > 0 && (seg.isMoved === true || seg.start !== undefined),
		);
		expect(openers).toHaveLength(0);
		expect(warped.segments[0].isMoved).toBe(true);
	});

	it("should warp a clip group's clip path and list its members", () => {
		const cage = createWarpCageFromRect(RECT);
		cage.vertices[2] = { ...cage.vertices[2], x: 140, y: 150 };
		const member: Path = {
			id: "member-1",
			type: "path",
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			segments: [
				straightSegment({ x: 0, y: 0 }, { x: 100, y: 100 }, true),
				straightSegment({ x: 100, y: 100 }, { x: 0, y: 0 }),
			],
		};
		const clip: Path = {
			...member,
			id: "clip-1",
			segments: [
				straightSegment({ x: 50, y: 50 }, { x: 100, y: 100 }, true),
				straightSegment({ x: 100, y: 100 }, { x: 50, y: 50 }),
			],
		};
		const group: Group = {
			id: "group-1",
			type: "group",
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			childIds: [clip.id, member.id],
			clipPathId: clip.id,
		};
		const mesh: MeshArtObject = {
			id: "mesh-1",
			type: "mesh",
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			childIds: [group.id],
			vertices: cage.vertices,
			faces: cage.faces,
		};
		const objects = new Map<string, Group | Path>([
			[group.id, group],
			[clip.id, clip],
			[member.id, member],
		]);

		const { transients, clipGroups } = warpMeshChildren(mesh, {
			resolve: (id) => objects.get(id) ?? null,
			getTextGlyphPaths: () => null,
		});

		// The clip path never paints…
		expect(transients.map((t) => t.id)).toEqual([
			`${mesh.id}::warp::${member.id}`,
		]);
		// …it comes back as a mask over the member, warped by the same cage.
		expect(clipGroups).toHaveLength(1);
		expect(clipGroups[0].id).toBe(`${mesh.id}::warp::${clip.id}`);
		expect(clipGroups[0].memberIds).toEqual([`${mesh.id}::warp::${member.id}`]);
		const warp = createMeshWarpSampler(cage.vertices, cage.faces);
		const clipStart = clipGroups[0].clipPath.segments[0].start;
		const expected = warp({ x: 50, y: 50 });
		expect(clipStart?.x).toBeCloseTo(expected.x, 6);
		expect(clipStart?.y).toBeCloseTo(expected.y, 6);
	});

	it("should bend a square child's straight edge onto the bent cage boundary", () => {
		const cage = createWarpCageFromRect(RECT);
		// Bow the bottom cage edge downward.
		cage.vertices[0].handles[1] = { x: 33, y: -30 };
		cage.vertices[1].handles[0] = { x: 67, y: -30 };
		// A square whose bottom edge lies exactly on that cage edge.
		const square: Path = {
			id: "square-1",
			type: "path",
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			segments: [
				straightSegment({ x: 0, y: 0 }, { x: 100, y: 0 }, true),
				straightSegment({ x: 100, y: 0 }, { x: 100, y: 100 }),
				straightSegment({ x: 100, y: 100 }, { x: 0, y: 100 }),
				straightSegment({ x: 0, y: 100 }, { x: 0, y: 0 }),
			],
		};
		const mesh: MeshArtObject = {
			id: "mesh-1",
			type: "mesh",
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			childIds: [square.id],
			vertices: cage.vertices,
			faces: cage.faces,
		};

		const { transients } = warpMeshChildren(mesh, {
			resolve: (id) => (id === square.id ? square : null),
			getTextGlyphPaths: () => null,
		});
		expect(transients).toHaveLength(1);
		const warped = transients[0];
		expect(warped.type).toBe("path");
		if (warped.type !== "path") return;

		// The straight bottom edge became several segments that follow the cage
		// boundary: every anchor along it sits on the bent edge curve.
		const bottomAnchors = warped.segments
			.map((seg, i) => ({
				seg,
				prev: i === 0 ? seg.start : warped.segments[i - 1].end,
			}))
			.map(({ seg }) => seg.end)
			.filter((p) => p.x >= 0 && p.x <= 100 && p.y < 1);
		expect(bottomAnchors.length).toBeGreaterThan(1);
		for (const anchor of bottomAnchors) {
			const onCurve = closestPointOnEdge(cage, anchor);
			expect(onCurve).toBeLessThan(0.5);
		}
		// The midpoint of the source edge must reach the bent curve, not the
		// straight chord between the corners (y = 0).
		const mid = evalEdge(cage.vertices, cage.faces, 0, 1, 0.5);
		expect(mid.y).toBeLessThan(-1);
		const nearestToMid = Math.min(
			...bottomAnchors.map((p) => Math.hypot(p.x - mid.x, p.y - mid.y)),
		);
		expect(nearestToMid).toBeLessThan(1);
	});
});

describe("subdivideWarpFace", () => {
	it("should assign axis-aligned source-grid positions to all new vertices", () => {
		const cage = createWarpCageFromRect(RECT);
		const subdivided = subdivideWarpFace(
			cage.vertices,
			cage.faces,
			0,
			0.25,
			0.5,
		);
		expect(subdivided).not.toBeNull();
		if (!subdivided) return;
		const newSrcs = subdivided.vertices
			.slice(4)
			.map((v) => `${v.src.x},${v.src.y}`)
			.sort();
		expect(newSrcs).toEqual(
			["25,0", "25,100", "100,50", "0,50", "25,50"].sort(),
		);
	});

	it("should keep src immutable for pre-existing vertices", () => {
		const cage = deformedCage();
		const subdivided = subdivideWarpFace(
			cage.vertices,
			cage.faces,
			0,
			0.3,
			0.7,
		);
		expect(subdivided).not.toBeNull();
		if (!subdivided) return;
		for (let i = 0; i < 4; i++) {
			expect(subdivided.vertices[i].src).toEqual(cage.vertices[i].src);
		}
	});
});

// --- Test helpers ---

/** Cage with a dragged corner and a bent bottom edge. */
function deformedCage(): {
	vertices: MeshGeometryVertex[];
	faces: ReturnType<typeof createWarpCageFromRect>["faces"];
} {
	const cage = createWarpCageFromRect(RECT);
	cage.vertices[2] = { ...cage.vertices[2], x: 135, y: 125 };
	cage.vertices[0].handles[1] = { x: 33, y: -20 };
	cage.vertices[1].handles[0] = { x: 67, y: -20 };
	return cage;
}

/** Free gradient stop at bounds-relative (x, y), opaque red. */
function freeStop(id: string, x: number, y: number): FreeGradientStop {
	return {
		id,
		x,
		y,
		color: toRGBColor({ r: 1, g: 0, b: 0, a: 1 }),
	};
}

/** One straight cubic segment between two absolute anchors. */
function straightSegment(
	from: Point,
	to: Point,
	withStart = false,
): PathSegment {
	return {
		...(withStart ? { start: { ...from } } : {}),
		cp1: { x: (to.x - from.x) / 3, y: (to.y - from.y) / 3 },
		cp2: { x: -(to.x - from.x) / 3, y: -(to.y - from.y) / 3 },
		end: { ...to },
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: false,
	};
}

/** Distance from `p` to the cage's bottom edge curve (sampled). */
function closestPointOnEdge(
	cage: { vertices: MeshGeometryVertex[]; faces: MeshFace[] },
	p: Point,
): number {
	let best = Number.POSITIVE_INFINITY;
	for (let i = 0; i <= 200; i++) {
		const q = evalEdge(cage.vertices, cage.faces, 0, 1, i / 200);
		best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y));
	}
	return best;
}

function gridPoints(min: number, max: number, steps: number): Point[] {
	const points: Point[] = [];
	for (let i = 0; i <= steps; i++) {
		for (let j = 0; j <= steps; j++) {
			points.push({
				x: min + ((max - min) * i) / steps,
				y: min + ((max - min) * j) / steps,
			});
		}
	}
	return points;
}
