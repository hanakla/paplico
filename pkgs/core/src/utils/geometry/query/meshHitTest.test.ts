import {
	describe,
	expect,
	it,
} from "../../../../../../node_modules/vitest/dist/index";
import {
	makeSplitMeshFixture,
	makeTwoLevelFixture,
} from "../../../testUtils/meshFixtures";
import {
	evalEdge,
	getBoundarySegmentInfo,
	getBoundarySubcurve,
} from "../measure/meshTopology";
import { evalCubicBezier } from "../primitives/bezier";
import { findClosestCurveT } from "./meshHitTest";

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
		const snappedPos = evalCubicBezier(
			sub![0],
			sub![1],
			sub![2],
			sub![3],
			closestT,
		);

		// The snapped position must lie on the root cubic (not at the drag target)
		// Verify by evaluating the root cubic at the corresponding root T
		const rootT = closestT * 0.4; // sub-edge [0, 0.4], so rootT = closestT * 0.4
		const rootPos = evalCubicBezier(A, P1, P2, B, rootT);
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
		const projected = evalCubicBezier(A, P1, P2, B, newT);
		// 4. Update vertex
		v4.x = projected.x;
		v4.y = projected.y;
		v4.positionSource!.t = newT;
		// 5. Do NOT move handles (Spec A: edge-locked)

		// Verify: v4 is on root cubic
		const verify = evalCubicBezier(A, P1, P2, B, v4.positionSource!.t);
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
		const projected = evalCubicBezier(A, P1, P2, B, newRootT);

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
		const verify = evalCubicBezier(A, P1, P2, B, newRootT);
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
