import {
	describe,
	expect,
	it,
} from "../../../../../../node_modules/vitest/dist/index";
import type { MeshFace } from "../../../schema";
import {
	makeSplitMeshFixture,
	makeTwoLevelFixture,
} from "../../../testUtils/meshFixtures";
import { evalCubicBezier } from "../primitives/bezier";
import {
	bilinearUV,
	evalEdge,
	getBoundarySegmentInfo,
	getBoundarySubcurve,
	getDisplayedMeshHandle,
	getEffectiveMeshEdgeCurve,
	getLocalEdgeTFromBoundaryT,
	getMeshEdgeHandle,
	getRootBoundaryCurves,
	type MeshVertexLike,
	shouldEmitMeshCPHandle,
} from "./meshTopology";

// ---------------------------------------------------------------------------
// Shared fixture: a curved quad (0→1→2→3) split at t=0.4 on edge (0,1) and
// t=0.5 on edge (3,2). Derived vertices 4 and 5 lie on the outer boundary.
// The root cubic on edge (0→1) has control points P1=(0.2, -0.6) and
// P2=(0.8, -0.6), giving it visible curvature.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 2-level subdivision: getBoundaryTOnRootEdge must resolve transitively.
// v9.positionSource.edgeVerts = [4, 1] where v4 is itself derived on [0, 1].
// The boundary functions must follow the chain to find root edge [0, 1].
// ---------------------------------------------------------------------------

function makeInteriorRootSegmentFixture() {
	const rootCurve = [
		{ x: 0.5, y: 0 },
		{ x: 0.72, y: 0.12 },
		{ x: 0.34, y: 0.38 },
		{ x: 0.5, y: 0.5 },
	] as const;
	const derivedPoint = evalCubicBezier(
		rootCurve[0],
		rootCurve[1],
		rootCurve[2],
		rootCurve[3],
		0.5,
	);

	const vertices: MeshVertexLike[] = [
		{ x: 0, y: 0, handles: { 4: { x: 0.25, y: 0 }, 7: { x: 0, y: 0.25 } } },
		{ x: 1, y: 0, handles: { 4: { x: 0.75, y: 0 }, 5: { x: 1, y: 0.25 } } },
		{ x: 1, y: 1, handles: { 5: { x: 1, y: 0.75 }, 6: { x: 0.75, y: 1 } } },
		{ x: 0, y: 1, handles: { 6: { x: 0.25, y: 1 }, 7: { x: 0, y: 0.75 } } },
		{
			x: 0.5,
			y: 0,
			handles: {
				0: { x: 0.16, y: -0.05 },
				1: { x: 0.84, y: -0.05 },
				8: rootCurve[1],
				9: { x: 0.98, y: -0.22 },
			},
			positionSource: { edgeVerts: [0, 1], t: 0.5 },
			meshSource: { edgeVerts: [0, 1], t: 0.5 },
		},
		{
			x: 1,
			y: 0.5,
			handles: {
				1: { x: 1.05, y: 0.16 },
				2: { x: 1.05, y: 0.84 },
				8: { x: 0.84, y: 0.5 },
			},
			positionSource: { edgeVerts: [1, 2], t: 0.5 },
			meshSource: { edgeVerts: [1, 2], t: 0.5 },
		},
		{
			x: 0.5,
			y: 1,
			handles: {
				2: { x: 0.84, y: 1.05 },
				3: { x: 0.16, y: 1.05 },
				8: { x: 0.5, y: 0.84 },
			},
			positionSource: { edgeVerts: [3, 2], t: 0.5 },
			meshSource: { edgeVerts: [3, 2], t: 0.5 },
		},
		{
			x: 0,
			y: 0.5,
			handles: {
				0: { x: -0.05, y: 0.16 },
				3: { x: -0.05, y: 0.84 },
				9: { x: 0.08, y: 0.56 },
			},
			positionSource: { edgeVerts: [0, 3], t: 0.5 },
			meshSource: { edgeVerts: [0, 3], t: 0.5 },
		},
		{
			x: 0.5,
			y: 0.5,
			handles: {
				4: rootCurve[2],
				5: { x: 0.82, y: 0.5 },
				6: { x: 0.5, y: 0.82 },
				7: { x: 0.18, y: 0.5 },
				9: { x: 0.14, y: 0.16 },
			},
		},
		{
			x: derivedPoint.x,
			y: derivedPoint.y,
			handles: {
				4: { x: 0.97, y: 0.46 },
				7: { x: 0.12, y: 0.46 },
				8: { x: 0.04, y: -0.02 },
			},
			positionSource: { edgeVerts: [4, 8], t: 0.5 },
			meshSource: { edgeVerts: [4, 8], t: 0.5 },
		},
	];

	const faces: MeshFace[] = [
		{ type: "quad", verts: [0, 4, 9, 7] },
		{ type: "quad", verts: [4, 1, 5, 8] },
		{ type: "tri", verts: [4, 8, 9] },
		{ type: "quad", verts: [7, 9, 8, 6] },
		{ type: "quad", verts: [8, 5, 2, 6] },
		{ type: "quad", verts: [0, 7, 6, 3] },
	];

	return { vertices, faces, rootCurve };
}

describe("bilinearUV", () => {
	const unitQuad = [
		{ x: 0, y: 0, handles: {} },
		{ x: 1, y: 0, handles: {} },
		{ x: 1, y: 1, handles: {} },
		{ x: 0, y: 1, handles: {} },
	];
	const quadIdx = [0, 1, 2, 3];

	it("should return (0.5, 0.5) for the center of a unit quad", () => {
		const { u, v } = bilinearUV(unitQuad, quadIdx, 0.5, 0.5);
		expect(u).toBeCloseTo(0.5, 6);
		expect(v).toBeCloseTo(0.5, 6);
	});

	it("should return (0, 0) for the p00 corner", () => {
		const { u, v } = bilinearUV(unitQuad, quadIdx, 0, 0);
		expect(u).toBeCloseTo(0, 6);
		expect(v).toBeCloseTo(0, 6);
	});

	it("should return (1, 0) for the p10 corner", () => {
		const { u, v } = bilinearUV(unitQuad, quadIdx, 1, 0);
		expect(u).toBeCloseTo(1, 6);
		expect(v).toBeCloseTo(0, 6);
	});

	it("should return (1, 1) for the p11 corner", () => {
		const { u, v } = bilinearUV(unitQuad, quadIdx, 1, 1);
		expect(u).toBeCloseTo(1, 6);
		expect(v).toBeCloseTo(1, 6);
	});

	it("should return (0, 1) for the p01 corner", () => {
		const { u, v } = bilinearUV(unitQuad, quadIdx, 0, 1);
		expect(u).toBeCloseTo(0, 6);
		expect(v).toBeCloseTo(1, 6);
	});

	it("should return (0.25, 0.75) for an off-center point in a unit quad", () => {
		const { u, v } = bilinearUV(unitQuad, quadIdx, 0.25, 0.75);
		expect(u).toBeCloseTo(0.25, 6);
		expect(v).toBeCloseTo(0.75, 6);
	});

	it("should handle a non-unit rectangular quad", () => {
		const rect = [
			{ x: 10, y: 20, handles: {} },
			{ x: 30, y: 20, handles: {} },
			{ x: 30, y: 60, handles: {} },
			{ x: 10, y: 60, handles: {} },
		];
		const { u, v } = bilinearUV(rect, quadIdx, 20, 40);
		expect(u).toBeCloseTo(0.5, 6);
		expect(v).toBeCloseTo(0.5, 6);
	});

	it("should handle a skewed (non-affine) quad where A != 0", () => {
		const skewed = [
			{ x: 0, y: 0, handles: {} },
			{ x: 1, y: 0, handles: {} },
			{ x: 2, y: 1, handles: {} },
			{ x: 0, y: 1, handles: {} },
		];
		const { u, v } = bilinearUV(skewed, quadIdx, 0.75, 0.5);
		expect(u).toBeCloseTo(0.5, 4);
		expect(v).toBeCloseTo(0.5, 4);
	});
});

describe("getRootBoundaryCurves", () => {
	it("should return one cubic per boundary edge for a plain quad", () => {
		const vertices: MeshVertexLike[] = [
			{ x: 0, y: 0, handles: {} },
			{ x: 1, y: 0, handles: {} },
			{ x: 1, y: 1, handles: {} },
			{ x: 0, y: 1, handles: {} },
		];
		const faces: MeshFace[] = [{ type: "quad", verts: [0, 1, 2, 3] }];
		const curves = getRootBoundaryCurves(vertices, faces);
		expect(curves).not.toBeNull();
		expect(curves!.length).toBe(4);
	});

	it("should skip derived vertices on the boundary and keep 4 root segments", () => {
		// Original quad 0→1→2→3. A horizontal split introduces derived vertex 4
		// on edge (0,1) and derived vertex 5 on edge (3,2), yielding two quads.
		// Boundary loop visits 0 → 4 → 1 → 2 → 5 → 3; derived 4 and 5 must be
		// skipped, leaving 4 root segments.
		const vertices: MeshVertexLike[] = [
			// Root→root handles preserved (linear edge, 1/3 positions)
			{
				x: 0,
				y: 0,
				handles: {
					1: { x: 1 / 3, y: 0 },
					4: { x: 0.25, y: 0 },
				},
			},
			{
				x: 1,
				y: 0,
				handles: {
					0: { x: 2 / 3, y: 0 },
					4: { x: 0.75, y: 0 },
				},
			},
			{
				x: 1,
				y: 1,
				handles: {
					3: { x: 2 / 3, y: 1 },
					5: { x: 0.75, y: 1 },
				},
			},
			{
				x: 0,
				y: 1,
				handles: {
					2: { x: 1 / 3, y: 1 },
					5: { x: 0.25, y: 1 },
				},
			},
			{
				x: 0.5,
				y: 0,
				handles: {
					0: { x: 0.25, y: 0 },
					1: { x: 0.75, y: 0 },
				},
				positionSource: { edgeVerts: [0, 1], t: 0.5 },
			},
			{
				x: 0.5,
				y: 1,
				handles: {
					2: { x: 0.75, y: 1 },
					3: { x: 0.25, y: 1 },
				},
				positionSource: { edgeVerts: [3, 2], t: 0.5 },
			},
		];
		const faces: MeshFace[] = [
			{ type: "quad", verts: [0, 4, 5, 3] },
			{ type: "quad", verts: [4, 1, 2, 5] },
		];
		const curves = getRootBoundaryCurves(vertices, faces);
		expect(curves).not.toBeNull();
		expect(curves!.length).toBe(4);
		const seg01 = curves!.find(
			(c) => c[0].x === 0 && c[0].y === 0 && c[3].x === 1 && c[3].y === 0,
		);
		expect(seg01).toBeDefined();
		const seg23 = curves!.find(
			(c) => c[0].x === 1 && c[0].y === 1 && c[3].x === 0 && c[3].y === 1,
		);
		expect(seg23).toBeDefined();
	});

	it("should reconstruct the original curved root cubic from a split edge", () => {
		// Take a curved cubic from A=(0,0) to B=(1,0) with original control
		// points P1=(0.2, -0.6), P2=(0.8, -0.6). Split at t=0.4 inserts derived
		// vertex V at M = cubic(0.4). The de Casteljau sub-handles for the
		// first half are:
		//   Q0 = (1-t)A + t P1   = (0.08, -0.24)
		//   Q1 = (1-t)P1 + t P2  = (0.44, -0.60)
		//   R0 = (1-t)Q0 + t Q1  = (0.224, -0.384)
		//   M  = cubic(0.4)      = (0.352, -0.432)
		//   R1 = (1-t)Q1 + t Q2  where Q2 = (1-t)P2 + tB = (0.88, -0.36)
		//      = 0.6*(0.44,-0.60) + 0.4*(0.88,-0.36) = (0.616, -0.504)
		// Reconstruction must recover P1=(0.2,-0.6), P2=(0.8,-0.6).
		const t = 0.4;
		const A = { x: 0, y: 0 };
		const B = { x: 1, y: 0 };
		const P1 = { x: 0.2, y: -0.6 };
		const P2 = { x: 0.8, y: -0.6 };
		const s = 1 - t;
		const Q0 = { x: s * A.x + t * P1.x, y: s * A.y + t * P1.y };
		const Q1 = { x: s * P1.x + t * P2.x, y: s * P1.y + t * P2.y };
		const Q2 = { x: s * P2.x + t * B.x, y: s * P2.y + t * B.y };
		const R0 = { x: s * Q0.x + t * Q1.x, y: s * Q0.y + t * Q1.y };
		const R1 = { x: s * Q1.x + t * Q2.x, y: s * Q1.y + t * Q2.y };
		const M = { x: s * R0.x + t * R1.x, y: s * R0.y + t * R1.y };
		// Build mesh with two quads separated by a split inserting V=4 on (0,1)
		// and a mirror vertex 5 on (3,2).
		const vertices: MeshVertexLike[] = [
			{ x: A.x, y: A.y, handles: { 1: P1, 4: Q0 } },
			{ x: B.x, y: B.y, handles: { 0: P2, 4: Q2 } },
			{ x: 1, y: 1, handles: { 5: { x: 0.75, y: 1 } } },
			{ x: 0, y: 1, handles: { 5: { x: 0.25, y: 1 } } },
			{
				x: M.x,
				y: M.y,
				handles: { 0: R0, 1: R1 },
				positionSource: { edgeVerts: [0, 1], t },
			},
			{
				x: 0.5,
				y: 1,
				handles: { 2: { x: 0.75, y: 1 }, 3: { x: 0.25, y: 1 } },
				positionSource: { edgeVerts: [3, 2], t: 0.5 },
			},
		];
		const faces: MeshFace[] = [
			{ type: "quad", verts: [0, 4, 5, 3] },
			{ type: "quad", verts: [4, 1, 2, 5] },
		];
		const curves = getRootBoundaryCurves(vertices, faces);
		const seg01 = curves!.find(
			(c) => c[0].x === 0 && c[0].y === 0 && c[3].x === 1 && c[3].y === 0,
		)!;
		expect(seg01).toBeDefined();
		expect(seg01[1].x).toBeCloseTo(P1.x, 6);
		expect(seg01[1].y).toBeCloseTo(P1.y, 6);
		expect(seg01[2].x).toBeCloseTo(P2.x, 6);
		expect(seg01[2].y).toBeCloseTo(P2.y, 6);
	});
});

// ---------------------------------------------------------------------------
// Spec A: boundary-derived vertices are constrained to the root cubic curve.
// evalEdge on a boundary sub-edge uses getBoundarySubcurve, NOT stored handles.
// ---------------------------------------------------------------------------
describe("Spec A: boundary edge-locked evaluation (evalEdge)", () => {
	it("should evaluate a boundary sub-edge using the root cubic, not stored handles", () => {
		// If evalEdge used stored handles directly (getEdgeCurve(0,4)), the result
		// would differ from the root cubic evaluated at the corresponding t.
		// Spec says the boundary subcurve must be used.
		const { vertices, faces, P1, P2 } = makeSplitMeshFixture();
		const A = { x: vertices[0].x, y: vertices[0].y };
		const B = { x: vertices[1].x, y: vertices[1].y };

		// evalEdge(0, 4, 0.5) should equal cubicBez(A, P1, P2, B, 0.5 * 0.4)
		// because the sub-edge (0→4) maps to [0, 0.4] on the root cubic.
		const result = evalEdge(vertices, faces, 0, 4, 0.5);
		const rootT = 0.5 * 0.4; // t=0.5 on sub-edge [0, 0.4] → t=0.2 on root
		const expected = evalCubicBezier(A, P1, P2, B, rootT);
		expect(result.x).toBeCloseTo(expected.x, 5);
		expect(result.y).toBeCloseTo(expected.y, 5);
	});

	it("should evaluate derived→derived boundary edge via root cubic interval", () => {
		// Edge (4→1) maps to [0.4, 1.0] on root cubic 0→1.
		// evalEdge(4, 1, 0.25) → root cubic at t = 0.4 + 0.25 * 0.6 = 0.55
		const { vertices, faces, P1, P2 } = makeSplitMeshFixture();
		const A = { x: vertices[0].x, y: vertices[0].y };
		const B = { x: vertices[1].x, y: vertices[1].y };

		const result = evalEdge(vertices, faces, 4, 1, 0.25);
		const rootT = 0.4 + 0.25 * 0.6;
		const expected = evalCubicBezier(A, P1, P2, B, rootT);
		expect(result.x).toBeCloseTo(expected.x, 5);
		expect(result.y).toBeCloseTo(expected.y, 5);
	});

	it("should fall back to stored handles for interior (non-boundary) edges", () => {
		// Edge (4→5) is interior — connects the two derived vertices across
		// the split line. No boundary subcurve exists for this edge.
		const { vertices, faces } = makeSplitMeshFixture();
		const result = evalEdge(vertices, faces, 4, 5, 0.5);
		// Interior edge uses getEdgeCurve which reads stored handles directly.
		// Just verify it doesn't crash and returns a plausible interior point.
		expect(result.x).toBeGreaterThan(0);
		expect(result.y).toBeGreaterThan(0);
		expect(result.y).toBeLessThan(1);
	});

	it("should match endpoint positions at t=0 and t=1", () => {
		const { vertices, faces, M } = makeSplitMeshFixture();
		const start = evalEdge(vertices, faces, 0, 4, 0);
		expect(start.x).toBeCloseTo(0, 5);
		expect(start.y).toBeCloseTo(0, 5);
		const end = evalEdge(vertices, faces, 0, 4, 1);
		expect(end.x).toBeCloseTo(M.x, 5);
		expect(end.y).toBeCloseTo(M.y, 5);
	});
});

// ---------------------------------------------------------------------------
// Spec B: handles between boundary-derived vertices use root cubic subcurve
// CPs, not vertex-stored handles. getMeshEdgeHandle / getDisplayedMeshHandle.
// ---------------------------------------------------------------------------
describe("Spec B: boundary subcurve CPs replace stored handles", () => {
	it("getBoundarySubcurve returns root cubic interval for boundary edge", () => {
		const { vertices, faces, P1, P2 } = makeSplitMeshFixture();
		const A = { x: vertices[0].x, y: vertices[0].y };

		const sub04 = getBoundarySubcurve(vertices, faces, 0, 4);
		expect(sub04).not.toBeNull();
		// Sub-edge (0→4) should start at A and end at M
		expect(sub04![0].x).toBeCloseTo(A.x, 5);
		expect(sub04![0].y).toBeCloseTo(A.y, 5);
		expect(sub04![3].x).toBeCloseTo(vertices[4].x, 4);
		expect(sub04![3].y).toBeCloseTo(vertices[4].y, 4);

		// The CP of the subcurve must NOT equal the stored handle vertex[0].handles[4]
		// when the root cubic is curved.
		// The subcurve CP comes from splitting the root cubic; it equals Q0 only
		// when the root cubic had the same CP structure as the stored handle.
		// In our fixture the stored handle IS Q0, so the subcurve[1] should match.
		// The key test is that for the derived→root sub-edge (4→1), the CP differs
		// from stored handles.
		const sub41 = getBoundarySubcurve(vertices, faces, 4, 1);
		expect(sub41).not.toBeNull();
		// Stored: vertex[4].handles[1] = R1 (de Casteljau). Subcurve CP is the
		// result of getCurveInterval([A, P1, P2, B], 0.4, 1.0)[1].
		// These should match because the reconstruction recovers the original root
		// cubic, and getCurveInterval at [0.4, 1.0] produces the second-half split.
		// The important guarantee is that this works even if stored handles are
		// tampered with — let's verify by intentionally corrupting a stored handle.
	});

	it("getBoundarySubcurve produces a curve tracing the root cubic, not the direct edge", () => {
		const { vertices, faces, P1, P2 } = makeSplitMeshFixture();
		const A = { x: vertices[0].x, y: vertices[0].y };
		const B = { x: vertices[1].x, y: vertices[1].y };

		// Edge (4→1) is the second half of the split root cubic [0.4, 1.0].
		// Evaluating the subcurve at t=0.5 should give the root cubic at t=0.7.
		const sub41 = getBoundarySubcurve(vertices, faces, 4, 1);
		expect(sub41).not.toBeNull();
		const midpoint = evalCubicBezier(
			sub41![0],
			sub41![1],
			sub41![2],
			sub41![3],
			0.5,
		);
		const rootT = 0.4 + 0.5 * 0.6;
		const expected = evalCubicBezier(A, P1, P2, B, rootT);
		expect(midpoint.x).toBeCloseTo(expected.x, 4);
		expect(midpoint.y).toBeCloseTo(expected.y, 4);
	});

	it("getBoundarySubcurve reads root→root handles, not derived vertex handles", () => {
		const { vertices, faces, P1, P2 } = makeSplitMeshFixture();
		const A = { x: vertices[0].x, y: vertices[0].y };
		const B = { x: vertices[1].x, y: vertices[1].y };

		// Corrupt ALL of derived vertex 4's handles. If getBoundarySubcurve
		// depended on derived handles, the result would be wrong.
		vertices[4].handles[0] = { x: 999, y: 999 };
		vertices[4].handles[1] = { x: 999, y: 999 };

		const sub41 = getBoundarySubcurve(vertices, faces, 4, 1);
		expect(sub41).not.toBeNull();
		const midpoint = evalCubicBezier(
			sub41![0],
			sub41![1],
			sub41![2],
			sub41![3],
			0.5,
		);
		const rootT = 0.4 + 0.5 * 0.6;
		const expected = evalCubicBezier(A, P1, P2, B, rootT);
		expect(midpoint.x).toBeCloseTo(expected.x, 4);
		expect(midpoint.y).toBeCloseTo(expected.y, 4);
	});

	it("getBoundarySubcurve returns null for interior edges", () => {
		const { vertices, faces } = makeSplitMeshFixture();
		// Edge (4→5) is interior — crosses the split line between two quads
		expect(getBoundarySubcurve(vertices, faces, 4, 5)).toBeNull();
		// Edge (0→3) is a root boundary edge (root→root), which also should
		// return a subcurve (the entire root edge trivially)
		const sub03 = getBoundarySubcurve(vertices, faces, 0, 3);
		// 0→3 is root→root, so info.t0=0, info.t1=1, subcurve = full edge
		expect(sub03).not.toBeNull();
	});

	it("getMeshEdgeHandle returns subcurve CP, not derived stored handle", () => {
		const { vertices, faces, P1, P2 } = makeSplitMeshFixture();

		// Corrupt derived vertex 4's handle toward 1.
		vertices[4].handles[1] = { x: 999, y: 999 };

		// getMeshEdgeHandle must still return the correct subcurve CP
		// because it reads root→root handles, not derived handles.
		const handle = getMeshEdgeHandle(vertices, faces, 4, 1);
		expect(handle.x).not.toBeCloseTo(999, 0);
		expect(handle.y).not.toBeCloseTo(999, 0);

		// Verify the CP traces the root cubic interval [0.4, 1.0]
		const sub = getBoundarySubcurve(vertices, faces, 4, 1);
		expect(sub).not.toBeNull();
		expect(handle.x).toBeCloseTo(sub![1].x, 5);
		expect(handle.y).toBeCloseTo(sub![1].y, 5);
	});

	it("getDisplayedMeshHandle returns root handle for root→first-derived edge", () => {
		const { vertices, faces } = makeSplitMeshFixture();
		// For root vertex 0 looking toward derived vertex 4 (first derived on
		// the boundary), getDisplayedMeshHandle should return the root handle
		// vertex[0].handles[1] (toward root end), NOT vertex[0].handles[4].
		// But actually the prototype says: for root endpoint at t=0 toward
		// first derived at t>0, return handles[rootEnd].
		// Wait — getBaseHandle(vertices, rootStart, rootEnd) = vertices[0].handles[1]
		// only if that handle exists. Let's check what index is rootEnd.
		// rootEnd for edge (0,1) root boundary is vertex 1.
		// getDisplayedMeshHandle(vertices, faces, 0, 4) should return
		// getBaseHandle(vertices, 0, 1) = vertices[0].handles[1].
		const displayed = getDisplayedMeshHandle(vertices, faces, 0, 4);
		const baseToRoot = vertices[0].handles[1]; // stored handle toward root end
		if (baseToRoot) {
			expect(displayed.x).toBeCloseTo(baseToRoot.x, 5);
			expect(displayed.y).toBeCloseTo(baseToRoot.y, 5);
		}
	});
});

// ---------------------------------------------------------------------------
// getBoundarySegmentInfo: identifies the root edge and t-interval for a
// boundary sub-edge.
// ---------------------------------------------------------------------------
describe("getBoundarySegmentInfo", () => {
	it("returns rootEdge=[0,1] with correct t0/t1 for derived vertex 4 at t=0.4", () => {
		const { vertices, faces, t } = makeSplitMeshFixture();
		const info = getBoundarySegmentInfo(vertices, faces, 0, 4);
		expect(info).not.toBeNull();
		expect(info!.rootEdge).toEqual([0, 1]);
		expect(info!.t0).toBeCloseTo(0, 6);
		expect(info!.t1).toBeCloseTo(t, 6);
	});

	it("returns rootEdge=[0,1] with t0=0.4, t1=1.0 for edge (4→1)", () => {
		const { vertices, faces, t } = makeSplitMeshFixture();
		const info = getBoundarySegmentInfo(vertices, faces, 4, 1);
		expect(info).not.toBeNull();
		expect(info!.rootEdge).toEqual([0, 1]);
		expect(info!.t0).toBeCloseTo(t, 6);
		expect(info!.t1).toBeCloseTo(1, 6);
	});

	it("returns null for interior edge (4→5)", () => {
		const { vertices, faces } = makeSplitMeshFixture();
		expect(getBoundarySegmentInfo(vertices, faces, 4, 5)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// getLocalEdgeTFromBoundaryT: converts a T on the root boundary to the
// local parameter within a sub-edge.
// ---------------------------------------------------------------------------
describe("getLocalEdgeTFromBoundaryT", () => {
	it("converts boundary T to local sub-edge T for edge (0→4) [0, 0.4]", () => {
		const { vertices, faces, t } = makeSplitMeshFixture();
		// Boundary T = 0.2 → local T on edge (0,4) mapping [0, 0.4] = 0.2 / 0.4 = 0.5
		const local = getLocalEdgeTFromBoundaryT(vertices, faces, [0, 4], 0.2);
		expect(local).toBeCloseTo(0.5, 5);
	});

	it("converts boundary T to local sub-edge T for edge (4→1) [0.4, 1.0]", () => {
		const { vertices, faces } = makeSplitMeshFixture();
		// Boundary T = 0.7 → local T on edge (4,1) mapping [0.4, 1.0] = (0.7 - 0.4) / 0.6 = 0.5
		const local = getLocalEdgeTFromBoundaryT(vertices, faces, [4, 1], 0.7);
		expect(local).toBeCloseTo(0.5, 5);
	});

	it("clamps result to [0,1]", () => {
		const { vertices, faces } = makeSplitMeshFixture();
		// Boundary T = 0 on edge (4,1) mapping [0.4, 1.0] → (0 - 0.4) / 0.6 < 0 → clamped to 0
		const local = getLocalEdgeTFromBoundaryT(vertices, faces, [4, 1], 0);
		expect(local).toBeCloseTo(0, 5);
	});
});

describe("2-level subdivision: transitive root edge resolution", () => {
	it("getBoundarySegmentInfo resolves v9 (positionSource:[4,1]) to root edge [0,1]", () => {
		const { vertices, faces } = makeTwoLevelFixture();
		// v4→v9 are both on root edge [0,1]. info must not be null.
		const info = getBoundarySegmentInfo(vertices, faces, 4, 9);
		expect(info).not.toBeNull();
		expect(info!.rootEdge).toEqual([0, 1]);
		expect(info!.t0).toBeCloseTo(0.5, 5);
		expect(info!.t1).toBeCloseTo(0.75, 5);
	});

	it("getBoundarySegmentInfo resolves v9→v1 to root edge [0,1]", () => {
		const { vertices, faces } = makeTwoLevelFixture();
		const info = getBoundarySegmentInfo(vertices, faces, 9, 1);
		expect(info).not.toBeNull();
		expect(info!.rootEdge).toEqual([0, 1]);
		expect(info!.t0).toBeCloseTo(0.75, 5);
		expect(info!.t1).toBeCloseTo(1, 5);
	});

	it("evalEdge(4, 9, 0.5) traces root cubic, not derived handles", () => {
		const { vertices, faces, P1, P2 } = makeTwoLevelFixture();
		const A = { x: 0, y: 0 };
		const B = { x: 1, y: 0 };
		const result = evalEdge(vertices, faces, 4, 9, 0.5);
		// Sub-edge [0.5, 0.75], t=0.5 → root t = 0.5 + 0.5 * 0.25 = 0.625
		const rootT = 0.5 + 0.5 * 0.25;
		const expected = evalCubicBezier(A, P1, P2, B, rootT);
		expect(result.x).toBeCloseTo(expected.x, 4);
		expect(result.y).toBeCloseTo(expected.y, 4);
	});

	it("getMeshEdgeHandle ignores v9's stored handles on boundary", () => {
		const { vertices, faces } = makeTwoLevelFixture();
		// Corrupt v9's handle toward v1
		vertices[9].handles[1] = { x: 999, y: 999 };
		const handle = getMeshEdgeHandle(vertices, faces, 9, 1);
		expect(handle.x).not.toBeCloseTo(999, 0);
	});
});

describe("shouldEmitMeshCPHandle", () => {
	// A CP handle is emitted only when dragging it can actually change the
	// rendered edge curve (getEffectiveMeshEdgeCurve / getDisplayedMeshHandle).

	it("should show both side CPs on an undivided root edge", () => {
		const { vertices, faces } = makeSplitMeshFixture();
		// Edge 0-3 is a full root edge: both endpoint handles apply.
		expect(shouldEmitMeshCPHandle(vertices, faces, 0, 3)).toBe(true);
		expect(shouldEmitMeshCPHandle(vertices, faces, 3, 0)).toBe(true);
	});

	it("should show the root-anchor-side CP on a root sub-edge", () => {
		const { vertices, faces } = makeSplitMeshFixture();
		// Edges 0-4 / 1-4 lie on root segment 0-1; the root anchors own the
		// base handles of the root cubic.
		expect(shouldEmitMeshCPHandle(vertices, faces, 0, 4)).toBe(true);
		expect(shouldEmitMeshCPHandle(vertices, faces, 1, 4)).toBe(true);
	});

	it("should hide the derived-owner CP on a root sub-edge", () => {
		const { vertices, faces } = makeSplitMeshFixture();
		// Vertex 4 sits mid-segment on root 0-1: its handles are ignored by
		// the root subcurve, so they are not editable.
		expect(shouldEmitMeshCPHandle(vertices, faces, 4, 0)).toBe(false);
		expect(shouldEmitMeshCPHandle(vertices, faces, 4, 1)).toBe(false);
	});

	it("should show CPs on both sides of an interior split-line edge", () => {
		const { vertices, faces } = makeSplitMeshFixture();
		// Edge 4-5 is a split line, not part of any root segment: it renders
		// from its own endpoint handles, so derived-owned CPs stay editable.
		expect(shouldEmitMeshCPHandle(vertices, faces, 4, 5)).toBe(true);
		expect(shouldEmitMeshCPHandle(vertices, faces, 5, 4)).toBe(true);
	});
});

describe("getEffectiveMeshEdgeCurve", () => {
	it("should return the root-cubic subcurve for boundary edges", () => {
		const { vertices, faces } = makeSplitMeshFixture();
		vertices[0].handles[4] = { x: -3, y: -3 };
		vertices[4].handles[0] = { x: -4, y: -4 };

		const curve = getEffectiveMeshEdgeCurve(vertices, faces, 0, 4);
		const boundary = getBoundarySubcurve(vertices, faces, 0, 4);

		expect(boundary).not.toBeNull();
		expect(curve).toEqual(boundary);
		expect(curve[1]).not.toEqual(vertices[0].handles[4]);
	});

	it("should keep raw stored handles for interior edges", () => {
		const { vertices, faces } = makeSplitMeshFixture();
		vertices[4].handles[5] = { x: 0.42, y: 0.61 };
		vertices[5].handles[4] = { x: 0.58, y: 0.39 };

		const curve = getEffectiveMeshEdgeCurve(vertices, faces, 4, 5);

		expect(curve).toEqual([
			{ x: vertices[4].x, y: vertices[4].y },
			vertices[4].handles[5],
			vertices[5].handles[4],
			{ x: vertices[5].x, y: vertices[5].y },
		]);
	});

	it("should resolve interior derived edges to the boundary-to-explicit root segment", () => {
		const { vertices, faces, rootCurve } = makeInteriorRootSegmentFixture();

		const curve = getEffectiveMeshEdgeCurve(vertices, faces, 4, 9);
		const actualMid = evalCubicBezier(
			curve[0],
			curve[1],
			curve[2],
			curve[3],
			0.5,
		);
		const expectedMid = evalCubicBezier(
			rootCurve[0],
			rootCurve[1],
			rootCurve[2],
			rootCurve[3],
			0.25,
		);
		const rawMid = evalCubicBezier(
			{ x: vertices[4].x, y: vertices[4].y },
			vertices[4].handles[9],
			vertices[9].handles[4],
			{ x: vertices[9].x, y: vertices[9].y },
			0.5,
		);

		expect(curve[1]).not.toEqual(vertices[4].handles[9]);
		expect(actualMid.x).toBeCloseTo(expectedMid.x, 6);
		expect(actualMid.y).toBeCloseTo(expectedMid.y, 6);
		expect(actualMid.x).not.toBeCloseTo(rawMid.x, 2);
		expect(actualMid.y).not.toBeCloseTo(rawMid.y, 2);
	});
});
