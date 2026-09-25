import { describe, expect, it } from "vitest";
import {
	type MeshFace,
	type MeshGradientVertex,
	toRGBColor,
} from "../../schema";
import {
	bilinearUV,
	createEdgeDerivedGeometryVertex,
	createQuadDerivedGeometryVertex,
	cubicBez,
	deleteMeshVertex,
	evalEdge,
	findClosestCurveT,
	getBoundarySegmentInfo,
	getBoundarySubcurve,
	getDisplayedMeshHandle,
	getEffectiveMeshEdgeCurve,
	getLocalEdgeTFromBoundaryT,
	getMeshEdgeHandle,
	getRootBoundaryCurves,
	type MeshVertexLike,
	pointInBezierFace,
	shouldEmitMeshCPHandle,
	subdivideFace,
} from "./meshGradient";

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
// Shared fixture: a curved quad (0→1→2→3) split at t=0.4 on edge (0,1) and
// t=0.5 on edge (3,2). Derived vertices 4 and 5 lie on the outer boundary.
// The root cubic on edge (0→1) has control points P1=(0.2, -0.6) and
// P2=(0.8, -0.6), giving it visible curvature.
// ---------------------------------------------------------------------------
function makeSplitMeshFixture() {
	const t = 0.4;
	const A = { x: 0, y: 0 };
	const B = { x: 1, y: 0 };
	const P1 = { x: 0.2, y: -0.6 };
	const P2 = { x: 0.8, y: -0.6 };
	const s = 1 - t;
	// de Casteljau intermediates for split at t=0.4
	const Q0 = { x: s * A.x + t * P1.x, y: s * A.y + t * P1.y };
	const Q1 = { x: s * P1.x + t * P2.x, y: s * P1.y + t * P2.y };
	const Q2 = { x: s * P2.x + t * B.x, y: s * P2.y + t * B.y };
	const R0 = { x: s * Q0.x + t * Q1.x, y: s * Q0.y + t * Q1.y };
	const R1 = { x: s * Q1.x + t * Q2.x, y: s * Q1.y + t * Q2.y };
	const M = { x: s * R0.x + t * R1.x, y: s * R0.y + t * R1.y };

	const vertices: MeshVertexLike[] = [
		// 0: root top-left — keeps original handle toward 1 (P1) plus split handle toward 4 (Q0)
		{ x: A.x, y: A.y, handles: { 1: P1, 4: Q0, 3: { x: 0, y: 0.33 } } },
		// 1: root top-right — keeps original handle toward 0 (P2) plus split handle toward 4 (Q2)
		{
			x: B.x,
			y: B.y,
			handles: { 0: P2, 4: Q2, 2: { x: 1, y: 0.33 } },
		},
		// 2: root bottom-right
		{
			x: 1,
			y: 1,
			handles: { 1: { x: 1, y: 0.67 }, 5: { x: 0.75, y: 1 } },
		},
		// 3: root bottom-left
		{
			x: 0,
			y: 1,
			handles: { 0: { x: 0, y: 0.67 }, 5: { x: 0.25, y: 1 } },
		},
		// 4: derived on boundary edge (0→1) at t=0.4
		{
			x: M.x,
			y: M.y,
			handles: {
				0: R0,
				1: R1,
				5: { x: M.x, y: M.y + 0.33 },
			},
			positionSource: { edgeVerts: [0, 1], t },
		},
		// 5: derived on boundary edge (3→2) at t=0.5
		{
			x: 0.5,
			y: 1,
			handles: {
				3: { x: 0.25, y: 1 },
				2: { x: 0.75, y: 1 },
				4: { x: 0.5, y: 0.67 },
			},
			positionSource: { edgeVerts: [3, 2], t: 0.5 },
		},
	];

	const faces: MeshFace[] = [
		{ type: "quad", verts: [0, 4, 5, 3] },
		{ type: "quad", verts: [4, 1, 2, 5] },
	];

	return { vertices, faces, P1, P2, t, M, Q0, Q2, R0, R1 };
}

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
		const expected = cubicBez(A, P1, P2, B, rootT);
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
		const expected = cubicBez(A, P1, P2, B, rootT);
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
		const midpoint = cubicBez(sub41![0], sub41![1], sub41![2], sub41![3], 0.5);
		const rootT = 0.4 + 0.5 * 0.6;
		const expected = cubicBez(A, P1, P2, B, rootT);
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
		const midpoint = cubicBez(sub41![0], sub41![1], sub41![2], sub41![3], 0.5);
		const rootT = 0.4 + 0.5 * 0.6;
		const expected = cubicBez(A, P1, P2, B, rootT);
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

// ---------------------------------------------------------------------------
// Edge-lock drag scenario: dragging a boundary derived vertex constrains it
// to the root cubic via findClosestCurveT + getBoundarySubcurve.
// ---------------------------------------------------------------------------
describe("Spec A scenario: edge-locked drag via findClosestCurveT", () => {
	it("findClosestCurveT on the boundary subcurve constrains to root cubic", () => {
		const { vertices, faces, P1, P2 } = makeSplitMeshFixture();
		const A = { x: vertices[0].x, y: vertices[0].y };
		const B = { x: vertices[1].x, y: vertices[1].y };

		const sub = getBoundarySubcurve(vertices, faces, 0, 4);
		expect(sub).not.toBeNull();

		// Simulate dragging vertex 4 to an arbitrary point off the curve
		const dragTarget = { x: 0.3, y: -0.8 };
		// findClosestCurveT finds the nearest point on the subcurve
		const closestT = findClosestCurveT(sub!, dragTarget.x, dragTarget.y);
		const snappedPos = cubicBez(sub![0], sub![1], sub![2], sub![3], closestT);

		// The snapped position must lie on the root cubic (not at the drag target)
		// Verify by evaluating the root cubic at the corresponding root T
		const rootT = closestT * 0.4; // sub-edge [0, 0.4], so rootT = closestT * 0.4
		const rootPos = cubicBez(A, P1, P2, B, rootT);
		expect(snappedPos.x).toBeCloseTo(rootPos.x, 4);
		expect(snappedPos.y).toBeCloseTo(rootPos.y, 4);

		// The snapped position should NOT equal the drag target
		const distToDrag = Math.hypot(
			snappedPos.x - dragTarget.x,
			snappedPos.y - dragTarget.y,
		);
		expect(distToDrag).toBeGreaterThan(0.01);
	});
});

// ---------------------------------------------------------------------------
// 2-level subdivision: getBoundaryTOnRootEdge must resolve transitively.
// v9.positionSource.edgeVerts = [4, 1] where v4 is itself derived on [0, 1].
// The boundary functions must follow the chain to find root edge [0, 1].
// ---------------------------------------------------------------------------
function makeTwoLevelFixture() {
	// Curved root cubic v0→v1: P1=(0.2, -0.6), P2=(0.8, -0.6)
	const P1 = { x: 0.2, y: -0.6 };
	const P2 = { x: 0.8, y: -0.6 };

	// First split at t=0.5 on edge (0,1) inserts v4
	const t1 = 0.5;
	const s1 = 0.5;
	const Q0 = { x: s1 * 0 + t1 * P1.x, y: s1 * 0 + t1 * P1.y }; // (0.1, -0.3)
	const Q1 = { x: s1 * P1.x + t1 * P2.x, y: s1 * P1.y + t1 * P2.y }; // (0.5, -0.6)
	const Q2 = { x: s1 * P2.x + t1 * 1, y: s1 * P2.y + t1 * 0 }; // (0.9, -0.3)
	const R0 = { x: s1 * Q0.x + t1 * Q1.x, y: s1 * Q0.y + t1 * Q1.y }; // (0.3, -0.45)
	const R1 = { x: s1 * Q1.x + t1 * Q2.x, y: s1 * Q1.y + t1 * Q2.y }; // (0.7, -0.45)
	const M1 = { x: s1 * R0.x + t1 * R1.x, y: s1 * R0.y + t1 * R1.y }; // (0.5, -0.45)

	// Second split at t=0.5 on edge (4,1) inserts v9
	// Edge (4,1) is the right half of root cubic: [M1, R1, Q2, v1]
	// Split that at t=0.5:
	const t2 = 0.5;
	const s2 = 0.5;
	const S0 = { x: s2 * M1.x + t2 * R1.x, y: s2 * M1.y + t2 * R1.y };
	const S1 = { x: s2 * R1.x + t2 * Q2.x, y: s2 * R1.y + t2 * Q2.y };
	const S2 = { x: s2 * Q2.x + t2 * 1, y: s2 * Q2.y + t2 * 0 };
	const T0 = { x: s2 * S0.x + t2 * S1.x, y: s2 * S0.y + t2 * S1.y };
	const T1 = { x: s2 * S1.x + t2 * S2.x, y: s2 * S1.y + t2 * S2.y };
	const M2 = { x: s2 * T0.x + t2 * T1.x, y: s2 * T0.y + t2 * T1.y };

	const vertices: MeshVertexLike[] = [
		// v0: explicit, root handles toward v1 preserved
		{ x: 0, y: 0, handles: { 1: P1, 4: Q0, 3: { x: 0, y: 0.33 } } },
		// v1: explicit, root handles toward v0 preserved
		{ x: 1, y: 0, handles: { 0: P2, 9: S2, 2: { x: 1, y: 0.33 } } },
		// v2: explicit
		{ x: 1, y: 1, handles: { 1: { x: 1, y: 0.67 }, 3: { x: 0.67, y: 1 } } },
		// v3: explicit
		{ x: 0, y: 1, handles: { 0: { x: 0, y: 0.67 }, 2: { x: 0.33, y: 1 } } },
		// v4: derived on root edge [0,1] at t=0.5
		{
			x: M1.x,
			y: M1.y,
			handles: { 0: R0, 9: T0, 8: { x: M1.x, y: M1.y + 0.33 } },
			positionSource: { edgeVerts: [0, 1], t: 0.5 },
		},
		// v5-v7: other derived (simplified, not on edge 0→1)
		{
			x: 1,
			y: 0.5,
			handles: {},
			positionSource: { edgeVerts: [1, 2], t: 0.5 },
		},
		{
			x: 0.5,
			y: 1,
			handles: {},
			positionSource: { edgeVerts: [3, 2], t: 0.5 },
		},
		{
			x: 0,
			y: 0.5,
			handles: {},
			positionSource: { edgeVerts: [0, 3], t: 0.5 },
		},
		// v8: explicit center
		{
			x: 0.5,
			y: 0.5,
			handles: { 4: { x: 0.5, y: 0.17 }, 7: { x: 0.17, y: 0.5 } },
		},
		// v9: derived on edge [4,1] at t=0.5 — this is the 2nd-level derived
		// Root cubic t = 0.5 + 0.5 * 0.5 = 0.75
		{
			x: M2.x,
			y: M2.y,
			handles: { 4: T0, 1: T1, 5: { x: M2.x, y: M2.y + 0.1 } },
			positionSource: { edgeVerts: [4, 1], t: 0.5 },
		},
	];

	// Edge split of v9 on edge (4,1) of face[1]=[4,1,5,8]:
	//   face[1] → quad [4,9,5,8] + tri [9,1,5]
	// Boundary loop: 0→4→9→1→5→2→6→3→7→0
	const faces: MeshFace[] = [
		{ type: "quad", verts: [0, 4, 8, 7] }, // original face[0]
		{ type: "quad", verts: [4, 9, 5, 8] }, // left half of face[1]
		{ type: "tri", verts: [9, 1, 5] }, // right half of face[1]
		{ type: "quad", verts: [8, 5, 2, 6] }, // original face[2]
		{ type: "quad", verts: [7, 8, 6, 3] }, // original face[3]
	];

	return { vertices, faces, P1, P2, M1, M2 };
}

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
		const expected = cubicBez(A, P1, P2, B, rootT);
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

// ---------------------------------------------------------------------------
// Spec A full flow: dragging a boundary derived vertex projects it onto the
// root cubic and updates positionSource.t. Handles do NOT move.
//
//   Root cubic: v0 ──P1──P2── v1
//   After split at t=0.4: v0 ── v4 ── v1
//   v4.positionSource = {edgeVerts:[0,1], t:0.4}
//
//   Drag v4 to arbitrary off-curve point (0.3, -0.8).
//   Expected: v4 snaps to root cubic at findClosestCurveT result,
//   positionSource.t updates, handles unchanged.
// ---------------------------------------------------------------------------
describe("Spec A full flow: boundary derived drag → project onto root cubic", () => {
	it("1-level: dragging v4 off-curve snaps to root cubic, updates positionSource.t, handles unchanged", () => {
		const { vertices, faces, P1, P2 } = makeSplitMeshFixture();
		const v4 = vertices[4];
		const A = { x: vertices[0].x, y: vertices[0].y };
		const B = { x: vertices[1].x, y: vertices[1].y };

		// Save original handles
		const originalHandles = JSON.parse(JSON.stringify(v4.handles));

		// Simulate drag to off-curve position
		const dragTarget = { x: 0.3, y: -0.8 };

		// --- This is the projection algorithm (mirrors GradientTool drag) ---
		// 1. Get the FULL root cubic (not subcurve)
		const rootCubic: [
			{ x: number; y: number },
			{ x: number; y: number },
			{ x: number; y: number },
			{ x: number; y: number },
		] = [A, P1, P2, B];
		// 2. Find closest t on root cubic
		const newT = findClosestCurveT(rootCubic, dragTarget.x, dragTarget.y);
		// 3. Evaluate root cubic at newT → new position
		const projected = cubicBez(A, P1, P2, B, newT);
		// 4. Update vertex
		v4.x = projected.x;
		v4.y = projected.y;
		v4.positionSource!.t = newT;
		// 5. Do NOT move handles (Spec A: edge-locked)

		// Verify: v4 is on root cubic
		const verify = cubicBez(A, P1, P2, B, v4.positionSource!.t);
		expect(v4.x).toBeCloseTo(verify.x, 6);
		expect(v4.y).toBeCloseTo(verify.y, 6);

		// Verify: v4 is NOT at drag target
		expect(
			Math.hypot(v4.x - dragTarget.x, v4.y - dragTarget.y),
		).toBeGreaterThan(0.01);

		// Verify: handles unchanged
		for (const key of Object.keys(originalHandles)) {
			expect(v4.handles[Number(key)].x).toBeCloseTo(originalHandles[key].x, 6);
			expect(v4.handles[Number(key)].y).toBeCloseTo(originalHandles[key].y, 6);
		}

		// Verify: positionSource.t changed from original 0.4
		expect(v4.positionSource!.t).not.toBeCloseTo(0.4, 2);

		// Verify: evalEdge still traces root cubic through v4's new position
		const mid = evalEdge(vertices, faces, 0, 4, 1.0);
		expect(mid.x).toBeCloseTo(v4.x, 4);
		expect(mid.y).toBeCloseTo(v4.y, 4);
	});

	it("2-level: dragging v9 off-curve snaps to root cubic, positionSource.t updates", () => {
		const { vertices, faces, P1, P2 } = makeTwoLevelFixture();
		const v9 = vertices[9];
		const A = { x: vertices[0].x, y: vertices[0].y };
		const B = { x: vertices[1].x, y: vertices[1].y };

		const originalHandles = JSON.parse(JSON.stringify(v9.handles));

		// Drag v9 to off-curve position
		const dragTarget = { x: 0.9, y: -0.5 };

		// v9.positionSource = {edgeVerts:[4,1], t:0.5}
		// v4.positionSource = {edgeVerts:[0,1], t:0.5}
		// So v9 is on root edge [0,1]. Project onto full root cubic.
		const rootCubic: [
			{ x: number; y: number },
			{ x: number; y: number },
			{ x: number; y: number },
			{ x: number; y: number },
		] = [A, P1, P2, B];
		const newRootT = findClosestCurveT(rootCubic, dragTarget.x, dragTarget.y);
		const projected = cubicBez(A, P1, P2, B, newRootT);

		v9.x = projected.x;
		v9.y = projected.y;
		// Update positionSource: recompute local t relative to parent edge [4,1]
		// v4 is at root t=0.5, v1 is at root t=1.0
		// newRootT should be between 0.5 and 1.0 for this drag direction
		// localT = (newRootT - 0.5) / (1.0 - 0.5) = (newRootT - 0.5) * 2
		const v4RootT = 0.5;
		const v1RootT = 1.0;
		const localT = (newRootT - v4RootT) / (v1RootT - v4RootT);
		v9.positionSource!.t = Math.max(0, Math.min(1, localT));

		// Verify: v9 is on root cubic
		const verify = cubicBez(A, P1, P2, B, newRootT);
		expect(v9.x).toBeCloseTo(verify.x, 6);
		expect(v9.y).toBeCloseTo(verify.y, 6);

		// Verify: NOT at drag target
		expect(
			Math.hypot(v9.x - dragTarget.x, v9.y - dragTarget.y),
		).toBeGreaterThan(0.01);

		// Verify: handles unchanged
		for (const key of Object.keys(originalHandles)) {
			expect(v9.handles[Number(key)].x).toBeCloseTo(originalHandles[key].x, 6);
			expect(v9.handles[Number(key)].y).toBeCloseTo(originalHandles[key].y, 6);
		}

		// Verify: getBoundarySegmentInfo still resolves after t update
		const info = getBoundarySegmentInfo(vertices, faces, 4, 9);
		expect(info).not.toBeNull();
		expect(info!.rootEdge).toEqual([0, 1]);
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
		const actualMid = cubicBez(curve[0], curve[1], curve[2], curve[3], 0.5);
		const expectedMid = cubicBez(
			rootCurve[0],
			rootCurve[1],
			rootCurve[2],
			rootCurve[3],
			0.25,
		);
		const rawMid = cubicBez(
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

function makeInteriorRootSegmentFixture() {
	const rootCurve = [
		{ x: 0.5, y: 0 },
		{ x: 0.72, y: 0.12 },
		{ x: 0.34, y: 0.38 },
		{ x: 0.5, y: 0.5 },
	] as const;
	const derivedPoint = cubicBez(
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

describe("counter-clockwise mesh winding", () => {
	it("should hit-test points inside a CCW quad", () => {
		const { vertices, faces } = makeCCWQuadFixture();
		expect(pointInBezierFace(vertices, faces, faces[0], 0.5, 0.5)).toBe(true);
		expect(pointInBezierFace(vertices, faces, faces[0], 1.5, 0.5)).toBe(false);
	});

	it("should keep subdivided faces counter-clockwise", () => {
		const { vertices, faces } = makeCCWQuadFixture();
		const result = subdivideCCWQuad(vertices, faces);
		expect(result).not.toBeNull();
		expect(result!.faces.length).toBeGreaterThan(1);
		for (const face of result!.faces) {
			expect(screenSignedArea(result!.vertices, face.verts)).toBeLessThan(0);
		}
	});

	it("should resolve subdivided faces top-left first, counter-clockwise", () => {
		const { vertices, faces } = makeCCWQuadFixture();
		const result = subdivideCCWQuad(vertices, faces);
		expect(result).not.toBeNull();
		expect(result!.faces.length).toBe(4);

		const centroids = result!.faces.map((face) => {
			let cx = 0;
			let cy = 0;
			for (const vi of face.verts) {
				cx += result!.vertices[vi].x;
				cy += result!.vertices[vi].y;
			}
			return { x: cx / face.verts.length, y: cy / face.verts.length };
		});

		// faces[0] wins overlaps (first-hit-wins in the shaders), so the
		// resolution order must start at the top-left patch and continue
		// counter-clockwise: TL → BL → BR → TR.
		expect(centroids[0].x).toBeLessThan(0.5); // TL
		expect(centroids[0].y).toBeLessThan(0.5);
		expect(centroids[1].x).toBeLessThan(0.5); // BL
		expect(centroids[1].y).toBeGreaterThan(0.5);
		expect(centroids[2].x).toBeGreaterThan(0.5); // BR
		expect(centroids[2].y).toBeGreaterThan(0.5);
		expect(centroids[3].x).toBeGreaterThan(0.5); // TR
		expect(centroids[3].y).toBeLessThan(0.5);
	});

	it("should rebuild a counter-clockwise quad when deleting a split vertex", () => {
		const { vertices, faces } = makeCCWQuadFixture();
		const subdivided = subdivideCCWQuad(vertices, faces);
		expect(subdivided).not.toBeNull();

		const removeIdx = subdivided!.vertices.findIndex(
			(v) => v.splitLineId != null,
		);
		expect(removeIdx).toBeGreaterThanOrEqual(4);

		const rebuilt = deleteMeshVertex(
			subdivided!.vertices,
			subdivided!.faces,
			removeIdx,
		);
		expect(rebuilt.faces.length).toBeGreaterThan(0);
		for (const face of rebuilt.faces) {
			expect(screenSignedArea(rebuilt.vertices, face.verts)).toBeLessThan(0);
		}
	});

	it("should remove implicit arms connected to a deleted explicit vertex", () => {
		const { vertices, faces } = makeExplicitCenterFixture();

		const rebuilt = deleteMeshVertex(vertices, faces, 4);

		expect(rebuilt.vertices).toHaveLength(4);
		expect(rebuilt.faces).toHaveLength(1);
		expect(rebuilt.faces[0].type).toBe("quad");
	});

	it("should restore the exact grid topology after deleting A → B → C", () => {
		const initial = makeMeshGradientQuadFixture();
		expectGridTopology(initial, 1, []);

		const afterA = requireMeshGradientSubdivision(
			subdivideMeshGradientAt(initial.vertices, initial.faces, 0.2, 0.66, 0.5),
		);
		expectGridTopology(afterA, 2, [0.5]);

		const afterB = requireMeshGradientSubdivision(
			subdivideMeshGradientAt(afterA.vertices, afterA.faces, 0.64, 0.34, 0.6),
		);
		expectGridTopology(afterB, 3, [0.5, 0.6]);

		const afterC = requireMeshGradientSubdivision(
			subdivideMeshGradientAt(afterB.vertices, afterB.faces, 0.48, 0.78, 0.7),
		);
		expectGridTopology(afterC, 4, [0.5, 0.6, 0.7]);
		const identifiedAfterC = {
			vertices: afterC.vertices.map((vertex, index) => ({
				...vertex,
				color: { ...vertex.color, b: (index + 1) / 100 },
				handles: { ...vertex.handles },
			})),
			faces: afterC.faces.map((face) => ({
				type: face.type,
				verts: [...face.verts],
			})),
		};

		const removeAIdx = identifiedAfterC.vertices.findIndex(
			(vertex) => explicitMarker(vertex) === 0.5,
		);
		expect(removeAIdx).toBeGreaterThanOrEqual(4);

		const afterDeleteA = deleteMeshVertex(
			identifiedAfterC.vertices,
			identifiedAfterC.faces,
			removeAIdx,
		);
		expectGridTopology(afterDeleteA, 3, [0.6, 0.7]);
		const warpedAfterC = {
			vertices: identifiedAfterC.vertices.map((vertex) => ({
				...vertex,
				y: vertex.y + 8 * (vertex.x - 0.2) ** 2,
				handles: { ...vertex.handles },
			})),
			faces: identifiedAfterC.faces.map((face) => ({
				type: face.type,
				verts: [...face.verts],
			})),
		};
		const warpedAfterDeleteA = deleteMeshVertex(
			warpedAfterC.vertices,
			warpedAfterC.faces,
			removeAIdx,
		);
		expect(meshTopologyByVertexIdentity(warpedAfterDeleteA)).toEqual(
			meshTopologyByVertexIdentity(afterDeleteA),
		);

		const removeBIdx = afterDeleteA.vertices.findIndex(
			(vertex) => explicitMarker(vertex) === 0.6,
		);
		expect(removeBIdx).toBeGreaterThanOrEqual(4);

		const afterDeleteB = deleteMeshVertex(
			afterDeleteA.vertices,
			afterDeleteA.faces,
			removeBIdx,
		);
		expectGridTopology(afterDeleteB, 2, [0.7]);

		const removeCIdx = afterDeleteB.vertices.findIndex(
			(vertex) => explicitMarker(vertex) === 0.7,
		);
		expect(removeCIdx).toBeGreaterThanOrEqual(4);

		const afterDeleteC = deleteMeshVertex(
			afterDeleteB.vertices,
			afterDeleteB.faces,
			removeCIdx,
		);
		expectGridTopology(afterDeleteC, 1, []);
		expect(
			afterDeleteC.vertices.filter((vertex) => vertex.colorMode === "derived"),
		).toHaveLength(0);
		expect(meshTopologyByVertexIdentity(afterDeleteC)).toEqual({
			vertices: [0.01, 0.02, 0.03, 0.04],
			edges: ["0.01:0.02", "0.01:0.04", "0.02:0.03", "0.03:0.04"],
			faces: ["0.01:0.02:0.03:0.04"],
		});
	});

	it("should stop an implicit arm at another explicit vertex", () => {
		const { vertices, faces } = makeExplicitCenterFixture();
		vertices[5].colorMode = "explicit";

		const rebuilt = deleteMeshVertex(vertices, faces, 4);

		expect(
			rebuilt.vertices.some((vertex) => vertex.x === 0.5 && vertex.y === 0),
		).toBe(true);
		expect(
			rebuilt.vertices.filter((vertex) => vertex.colorMode === "derived"),
		).toHaveLength(0);
	});
});

/** CCW on screen (y-down): top-left → bottom-left → bottom-right → top-right */
function makeExplicitCenterFixture(): {
	vertices: MeshVertexLike[];
	faces: MeshFace[];
} {
	return {
		vertices: [
			{ x: 0, y: 0, handles: {}, colorMode: "explicit" },
			{ x: 1, y: 0, handles: {}, colorMode: "explicit" },
			{ x: 1, y: 1, handles: {}, colorMode: "explicit" },
			{ x: 0, y: 1, handles: {}, colorMode: "explicit" },
			{ x: 0.5, y: 0.5, handles: {}, colorMode: "explicit" },
			{
				x: 0.5,
				y: 0,
				handles: {},
				colorMode: "derived",
				splitLineId: 1,
			},
			{
				x: 1,
				y: 0.5,
				handles: {},
				colorMode: "derived",
				splitLineId: 2,
			},
			{
				x: 0.5,
				y: 1,
				handles: {},
				colorMode: "derived",
				splitLineId: 1,
			},
			{
				x: 0,
				y: 0.5,
				handles: {},
				colorMode: "derived",
				splitLineId: 2,
			},
		],
		faces: [
			{ type: "quad", verts: [0, 5, 4, 8] },
			{ type: "quad", verts: [5, 1, 6, 4] },
			{ type: "quad", verts: [4, 6, 2, 7] },
			{ type: "quad", verts: [8, 4, 7, 3] },
		],
	};
}

function makeMeshGradientQuadFixture(): {
	vertices: MeshGradientVertex[];
	faces: MeshFace[];
} {
	return {
		vertices: [0.1, 0.2, 0.3, 0.4].map((marker, index) => ({
			x: index >= 2 ? 1 : 0,
			y: index === 1 || index === 2 ? 1 : 0,
			color: markerColor(marker),
			colorMode: "explicit",
			handles: {},
		})),
		faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
	};
}

function subdivideMeshGradientAt(
	vertices: MeshGradientVertex[],
	faces: MeshFace[],
	x: number,
	y: number,
	marker: number,
) {
	const faceIdx = faces.findIndex((face) =>
		pointInBezierFace(vertices, faces, face, x, y),
	);
	if (faceIdx < 0) return null;
	const { u, v } = bilinearUV(vertices, faces[faceIdx].verts, x, y);
	let nextId =
		vertices.reduce(
			(maxId, vertex) => Math.max(maxId, vertex.splitLineId ?? 0),
			0,
		) + 1;
	return subdivideFace<MeshGradientVertex>(vertices, faces, faceIdx, u, v, {
		makeCenterExplicit: (position) => ({
			...position,
			color: markerColor(marker),
			colorMode: "explicit",
			handles: {},
		}),
		makeEdgeDerived: (position, edgeVerts, t) => ({
			...position,
			color: markerColor(0),
			colorMode: "derived",
			colorSource: { kind: "edge", edgeVerts: [...edgeVerts], t },
			positionSource: { edgeVerts: [...edgeVerts], t },
			meshSource: { edgeVerts: [...edgeVerts], t },
			handles: {},
		}),
		makeQuadDerived: (position, faceVerts, u, v) => ({
			...position,
			color: markerColor(0),
			colorMode: "derived",
			colorSource: { kind: "quad", faceVerts: [...faceVerts], u, v },
			handles: {},
		}),
		nextSplitLineId: () => nextId++,
	});
}

function markerColor(marker: number) {
	return toRGBColor({ r: marker, g: 0, b: 0, a: 1 });
}

function explicitMarker(vertex: MeshGradientVertex): number | null {
	if (vertex.colorMode !== "explicit" || vertex.color.type !== "rgb")
		return null;
	return vertex.color.r;
}

function explicitMarkers(vertices: readonly MeshGradientVertex[]): number[] {
	return vertices
		.map(explicitMarker)
		.filter((marker): marker is number => marker !== null)
		.sort((a, b) => a - b);
}

function expectGridTopology(
	mesh: {
		vertices: readonly MeshGradientVertex[];
		faces: readonly MeshFace[];
	},
	cellCount: number,
	addedExplicitMarkers: readonly number[],
): void {
	const sideVertexCount = cellCount + 1;
	expect(mesh.vertices).toHaveLength(sideVertexCount ** 2);
	expect(mesh.faces).toHaveLength(cellCount ** 2);
	expect(mesh.faces.every((face) => face.type === "quad")).toBe(true);

	const edges = new Set<string>();
	const degrees = Array.from({ length: mesh.vertices.length }, () => 0);
	for (const face of mesh.faces) {
		expect(new Set(face.verts)).toHaveLength(4);
		expect(
			Math.abs(screenSignedArea(mesh.vertices, face.verts)),
		).toBeGreaterThan(1e-8);
		for (let index = 0; index < face.verts.length; index++) {
			const from = face.verts[index];
			const to = face.verts[(index + 1) % face.verts.length];
			expect(mesh.vertices[from]).toBeDefined();
			expect(mesh.vertices[to]).toBeDefined();
			edges.add(testMeshEdgeKey(from, to));
		}
	}
	for (const edge of edges) {
		const [from, to] = edge.split(":").map(Number);
		degrees[from]++;
		degrees[to]++;
	}

	expect(edges).toHaveLength(2 * cellCount * sideVertexCount);
	expect(degrees.toSorted((a, b) => a - b)).toEqual(
		[
			...Array.from({ length: 4 }, () => 2),
			...Array.from({ length: 4 * (cellCount - 1) }, () => 3),
			...Array.from({ length: (cellCount - 1) ** 2 }, () => 4),
		].toSorted((a, b) => a - b),
	);
	expect(explicitMarkers(mesh.vertices)).toEqual(
		[0.1, 0.2, 0.3, 0.4, ...addedExplicitMarkers].toSorted((a, b) => a - b),
	);

	const xs = [
		...new Set(mesh.vertices.map((vertex) => testMeshCoordinate(vertex.x))),
	].toSorted((a, b) => a - b);
	const ys = [
		...new Set(mesh.vertices.map((vertex) => testMeshCoordinate(vertex.y))),
	].toSorted((a, b) => a - b);
	expect(xs).toHaveLength(sideVertexCount);
	expect(ys).toHaveLength(sideVertexCount);
	const vertexAt = new Map(
		mesh.vertices.map((vertex, index) => [
			`${testMeshCoordinate(vertex.x)}:${testMeshCoordinate(vertex.y)}`,
			index,
		]),
	);
	expect(vertexAt).toHaveLength(mesh.vertices.length);
	const expectedEdges = new Set<string>();
	const expectedFaces = new Set<string>();
	for (let row = 0; row < sideVertexCount; row++) {
		for (let column = 0; column < sideVertexCount; column++) {
			const current = getTestVertexIndex(vertexAt, `${xs[column]}:${ys[row]}`);
			if (column < cellCount) {
				const right = getTestVertexIndex(
					vertexAt,
					`${xs[column + 1]}:${ys[row]}`,
				);
				expectedEdges.add(testMeshEdgeKey(current, right));
			}
			if (row < cellCount) {
				const bottom = getTestVertexIndex(
					vertexAt,
					`${xs[column]}:${ys[row + 1]}`,
				);
				expectedEdges.add(testMeshEdgeKey(current, bottom));
			}
			if (column < cellCount && row < cellCount) {
				const faceVertices = [
					current,
					getTestVertexIndex(vertexAt, `${xs[column]}:${ys[row + 1]}`),
					getTestVertexIndex(vertexAt, `${xs[column + 1]}:${ys[row + 1]}`),
					getTestVertexIndex(vertexAt, `${xs[column + 1]}:${ys[row]}`),
				];
				expectedFaces.add(testMeshFaceKey(faceVertices));
			}
		}
	}
	expect(edges).toEqual(expectedEdges);
	expect(
		new Set(mesh.faces.map((face) => testMeshFaceKey(face.verts))),
	).toEqual(expectedFaces);

	const markerIndices = new Map(
		mesh.vertices.flatMap((vertex, index) => {
			const marker = explicitMarker(vertex);
			return marker === null ? [] : [[marker, index] as const];
		}),
	);
	for (const cornerMarker of [0.1, 0.2, 0.3, 0.4]) {
		for (const addedMarker of addedExplicitMarkers) {
			const cornerIdx = markerIndices.get(cornerMarker);
			const addedIdx = markerIndices.get(addedMarker);
			expect(cornerIdx).toBeDefined();
			expect(addedIdx).toBeDefined();
			if (cornerIdx === undefined || addedIdx === undefined) {
				throw new Error("Missing explicit test vertex marker");
			}
			expect(edges.has(testMeshEdgeKey(cornerIdx, addedIdx))).toBe(false);
		}
	}
}

function testMeshEdgeKey(a: number, b: number): string {
	return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function testMeshFaceKey(vertices: readonly number[]): string {
	return vertices.toSorted((a, b) => a - b).join(":");
}

function testMeshCoordinate(value: number): number {
	return Number(value.toFixed(12));
}

function requireMeshGradientSubdivision(
	result: ReturnType<typeof subdivideMeshGradientAt>,
): NonNullable<ReturnType<typeof subdivideMeshGradientAt>> {
	expect(result).not.toBeNull();
	if (result === null) throw new Error("Expected mesh subdivision");
	return result;
}

function getTestVertexIndex(
	vertices: ReadonlyMap<string, number>,
	key: string,
): number {
	const index = vertices.get(key);
	expect(index).toBeDefined();
	if (index === undefined) throw new Error(`Missing test vertex at ${key}`);
	return index;
}

function meshTopologyByVertexIdentity(mesh: {
	vertices: readonly MeshGradientVertex[];
	faces: readonly MeshFace[];
}) {
	const vertexIdentity = (index: number) =>
		testMeshVertexIdentity(mesh.vertices[index]);
	const edges = new Set<string>();
	for (const face of mesh.faces) {
		for (let index = 0; index < face.verts.length; index++) {
			const from = vertexIdentity(face.verts[index]);
			const to = vertexIdentity(face.verts[(index + 1) % face.verts.length]);
			edges.add(from < to ? `${from}:${to}` : `${to}:${from}`);
		}
	}
	return {
		vertices: mesh.vertices.map(testMeshVertexIdentity).toSorted(),
		edges: [...edges].toSorted(),
		faces: mesh.faces
			.map((face) =>
				face.verts
					.map(vertexIdentity)
					.toSorted((a, b) => a - b)
					.join(":"),
			)
			.toSorted(),
	};
}

function testMeshVertexIdentity(vertex: MeshGradientVertex): number {
	if (vertex.color.type !== "rgb") {
		throw new Error("Expected RGB test vertex color");
	}
	return vertex.color.b;
}

function makeCCWQuadFixture(): {
	vertices: MeshVertexLike[];
	faces: MeshFace[];
} {
	const vertices: MeshVertexLike[] = [
		{ x: 0, y: 0, handles: {} },
		{ x: 0, y: 1, handles: {} },
		{ x: 1, y: 1, handles: {} },
		{ x: 1, y: 0, handles: {} },
	];
	const faces: MeshFace[] = [{ type: "quad", verts: [0, 1, 2, 3] }];
	return { vertices, faces };
}

function subdivideCCWQuad(
	vertices: MeshVertexLike[],
	faces: MeshFace[],
	faceIdx = 0,
) {
	let nextId =
		vertices.reduce(
			(maxId, vertex) => Math.max(maxId, vertex.splitLineId ?? 0),
			0,
		) + 1;
	return subdivideFace<MeshVertexLike>(vertices, faces, faceIdx, 0.5, 0.5, {
		makeCenterExplicit: (position) => ({
			x: position.x,
			y: position.y,
			handles: {},
		}),
		makeEdgeDerived: (position, edgeVerts, t) =>
			createEdgeDerivedGeometryVertex<MeshVertexLike>(
				position,
				edgeVerts,
				t,
				(fields) => ({
					x: fields.x,
					y: fields.y,
					handles: fields.handles,
					positionSource: fields.positionSource,
				}),
			),
		makeQuadDerived: (position) =>
			createQuadDerivedGeometryVertex<MeshVertexLike>(position, (fields) => ({
				x: fields.x,
				y: fields.y,
				handles: fields.handles,
			})),
		nextSplitLineId: () => nextId++,
	});
}

/**
 * Signed polygon area via the standard shoelace formula. In this y-down mesh
 * space a loop that runs counter-clockwise on screen yields a NEGATIVE value.
 */
function screenSignedArea(
	vertices: readonly MeshVertexLike[],
	verts: readonly number[],
): number {
	let area = 0;
	for (let i = 0; i < verts.length; i++) {
		const a = vertices[verts[i]];
		const b = vertices[verts[(i + 1) % verts.length]];
		area += a.x * b.y - b.x * a.y;
	}
	return area / 2;
}
