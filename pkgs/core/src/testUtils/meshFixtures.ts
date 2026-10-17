import type { MeshFace } from "../schema";
import type { MeshVertexLike } from "../utils/geometry/measure/meshTopology";

// ---------------------------------------------------------------------------
// Shared fixture: a curved quad (0→1→2→3) split at t=0.4 on edge (0,1) and
// t=0.5 on edge (3,2). Derived vertices 4 and 5 lie on the outer boundary.
// The root cubic on edge (0→1) has control points P1=(0.2, -0.6) and
// P2=(0.8, -0.6), giving it visible curvature.
// ---------------------------------------------------------------------------
export function makeSplitMeshFixture() {
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
export function makeTwoLevelFixture() {
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
