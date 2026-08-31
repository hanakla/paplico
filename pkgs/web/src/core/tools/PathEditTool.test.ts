import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentityTransform } from "../document/factory";
import type { ImageObject, MeshArtObject, Path, PathSegment } from "../schema";
import {
	createMockToolContext,
	type MockToolContext,
} from "../testUtils/mockToolContext";
import {
	getControlPoints,
	lastOverlayCall,
} from "../testUtils/pathEditOverlay";
import {
	ev,
	testCanvasHeight,
	testCanvasWidth,
	testViewport,
} from "../testUtils/pointerEvent";
import { brandWorldBBox } from "../utils/geometry/bounds";
import {
	cubicBez,
	getEffectiveMeshEdgeCurve,
	getVertexNeighbors,
	syncDerivedVertices,
} from "../utils/geometry/meshGradient";
import {
	createMeshWarpSampler,
	promoteWarpVertexToExplicit,
	subdivideWarpFace,
} from "../utils/geometry/meshWarp";
import { PathEditTool } from "./PathEditTool";

const HANDLES_KEY = "path-edit/handles";

/**
 * 2-segment straight path (world coords): (0,0) -> (100,0) -> (200,0)
 *
 * cp1/cp2 are RELATIVE OFFSETS:
 *   cp1 = offset from start anchor (segment.start ?? prevSegment.end)
 *   cp2 = offset from end anchor (segment.end)
 *
 * Absolute world positions (for reference):
 *   start(0,0)           -> screen(400,300)
 *   seg0.cp1 abs(33,0)   -> screen(433,300)  [relative: (33,0) from start(0,0)]
 *   seg0.cp2 abs(66,0)   -> screen(466,300)  [relative: (-34,0) from end(100,0)]
 *   end0/anchor(100,0)   -> screen(500,300)
 *   seg1.cp1 abs(133,0)  -> screen(533,300)  [relative: (33,0) from anchor(100,0)]
 *   seg1.cp2 abs(166,0)  -> screen(566,300)  [relative: (-34,0) from end(200,0)]
 *   end1(200,0)          -> screen(600,300)
 *
 * seg0.cp2 abs(66,0) and seg1.cp1 abs(133,0) are symmetric around anchor(100,0):
 *   distance from anchor: 34 and 33 (within 10% tolerance)
 *   angle: cp2 at ~180deg, cp1 at ~0deg (difference ~180deg)
 */
const testPath: Path = {
	id: "path-1",
	type: "path",
	opacity: 1,
	blendMode: "normal",
	segments: [
		{
			start: { x: 0, y: 0 },
			cp1: { x: 33, y: 0 }, // relative from start(0,0) -> abs(33,0)
			cp2: { x: -34, y: 0 }, // relative from end(100,0) -> abs(66,0)
			end: { x: 100, y: 0 },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: false,
		},
		{
			cp1: { x: 33, y: 0 }, // relative from anchor(100,0) -> abs(133,0)
			cp2: { x: -34, y: 0 }, // relative from end(200,0) -> abs(166,0)
			end: { x: 200, y: 0 },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: false,
		},
	],
	transform: createIdentityTransform(),
};

/** Deep clone testPath to avoid cross-test mutation */
function cloneTestPath(): Path {
	return {
		...testPath,
		segments: testPath.segments.map((seg) => ({
			...seg,
			start: seg.start ? { ...seg.start } : undefined,
			cp1: { ...seg.cp1 },
			cp2: { ...seg.cp2 },
			end: { ...seg.end },
		})),
	};
}

/** Straight open path along y=0 through the given x coordinates. */
function makeStraightPath(id: string, xs: number[]): Path {
	return {
		id,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		segments: xs.slice(1).map((x, i) => ({
			start: i === 0 ? { x: xs[0], y: 0 } : undefined,
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			end: { x, y: 0 },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: i === 0,
		})),
		transform: createIdentityTransform(),
	};
}

/** Extract committed segments for a pathId from batchPathUpdate mock calls */
function getCommittedSegments(
	ctx: MockToolContext,
	pathId: string,
	callIndex = -1,
): PathSegment[] | undefined {
	const calls = ctx.batchPathUpdate.mock.calls;
	const idx = callIndex < 0 ? calls.length + callIndex : callIndex;
	const batch = calls[idx]?.[0] as Array<[string, PathSegment[]]> | undefined;
	return batch?.find(([id]) => id === pathId)?.[1];
}

describe("PathEditTool", () => {
	let tool: PathEditTool;
	let ctx: MockToolContext;

	beforeEach(() => {
		ctx = createMockToolContext();
		tool = new PathEditTool(ctx);
	});

	it("should have name 'path-edit'", () => {
		expect(tool.name).toBe("path-edit");
	});

	describe("Path selection", () => {
		it("should select path on click and show UI", () => {
			const path = cloneTestPath();
			ctx.findPathAtPoint.mockReturnValue(path);

			// Click at screen(400,300) -> world(0,0), on the start point
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.pathSelect).toHaveBeenCalledWith("path-1");

			const cps = getControlPoints(ctx, HANDLES_KEY);
			expect(cps.length).toBeGreaterThan(0);
			expect(cps[0].pathId).toBe("path-1");
		});

		it("should clear all selection on empty click", () => {
			// First, select the path
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			ctx.uiSetOverlay.mockClear();

			// Click end0 to select it first
			tool.onPointerDown(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			ctx.uiSetOverlay.mockClear();

			// Click on empty area (findPathAtPoint returns null)
			ctx.findPathAtPoint.mockReturnValue(null);
			tool.onPointerDown(
				ev(100, 100),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(100, 100),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Empty click clears selectedPaths -> handles overlay cleared
			expect(lastOverlayCall(ctx, HANDLES_KEY)).toBeNull();
		});

		it("should initialize with initWithSelectedPaths", () => {
			const path = cloneTestPath();
			tool.initWithSelectedPaths(
				[path],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.pathSelect).toHaveBeenCalledWith("path-1");

			const overlay = lastOverlayCall(ctx, HANDLES_KEY);
			expect(overlay).toBeDefined();
			expect(overlay).not.toBeNull();
			expect(getControlPoints(ctx, HANDLES_KEY).length).toBeGreaterThan(0);
		});
	});

	describe("Anchor movement", () => {
		it("should move anchor and commit via pathUpdate", () => {
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Click on end0 anchor at screen(500,300) -> world(100,0)
			tool.onPointerDown(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Drag to screen(500,280) -> world(100,20)
			tool.onPointerMove(
				ev(500, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.batchPathUpdate).toHaveBeenCalled();

			const updatedSegments = getCommittedSegments(ctx, "path-1")!;
			// end0 moved from y=0 to y=20
			expect(updatedSegments[0].end.y).toBeCloseTo(20);
		});

		it("should keep cp1/cp2 relative offsets unchanged when anchor moves", () => {
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Click on end0 anchor at screen(500,300) -> world(100,0)
			tool.onPointerDown(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Drag to screen(500,280) -> world(100,20), delta = (0, +20)
			tool.onPointerMove(
				ev(500, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const updatedSegments = getCommittedSegments(ctx, "path-1")!;

			// seg0.cp2 was relative (-34,0) from end. End moved but offset is unchanged.
			expect(updatedSegments[0].cp2.x).toBeCloseTo(-34);
			expect(updatedSegments[0].cp2.y).toBeCloseTo(0);

			// seg1.cp1 was relative (33,0) from anchor(=seg0.end). Anchor moved but offset is unchanged.
			expect(updatedSegments[1].cp1.x).toBeCloseTo(33);
			expect(updatedSegments[1].cp1.y).toBeCloseTo(0);
		});
	});

	describe("Control point movement", () => {
		it("should mirror opposite handle when symmetric (no Alt key)", () => {
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Click on seg0.cp2 at screen(466,300) -> world(66,0)
			tool.onPointerDown(
				ev(466, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Drag to screen(466,280) -> world(66,20), moving cp2 up by 20
			tool.onPointerMove(
				ev(466, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(466, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.batchPathUpdate).toHaveBeenCalled();
			const updatedSegments = getCommittedSegments(ctx, "path-1")!;

			// seg0.cp2 should have moved to y=20
			expect(updatedSegments[0].cp2.y).toBeCloseTo(20);

			// seg1.cp1 should also have changed (angle/distance mirrored around anchor(100,0))
			// because cp2(66,0) and cp1(133,0) were symmetric at pointerDown time
			expect(updatedSegments[1].cp1.y).not.toBeCloseTo(0);
		});

		it("should move only the double-tapped CP of a symmetric pair", () => {
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Double-tap seg0.cp2 at screen(466,300): the UI delivers onDoubleClick
			// and then onPointerDown for that second press.
			tool.onDoubleClick(
				ev(466, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerDown(
				ev(466, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Drag it up by 20
			tool.onPointerMove(
				ev(466, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(466, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const updatedSegments = getCommittedSegments(ctx, "path-1")!;

			// seg0.cp2 moved to y=20
			expect(updatedSegments[0].cp2.y).toBeCloseTo(20);
			// Its symmetric partner seg1.cp1 stays put
			expect(updatedSegments[1].cp1.y).toBeCloseTo(0);
		});

		it("should mirror again on a plain drag after the double-tap drag ended", () => {
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Double-tap seg0.cp2, then release without dragging
			tool.onDoubleClick(
				ev(466, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerDown(
				ev(466, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(466, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// A later plain drag of the still-symmetric pair mirrors as before
			tool.onPointerDown(
				ev(466, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(466, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(466, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const updatedSegments = getCommittedSegments(ctx, "path-1")!;
			expect(updatedSegments[0].cp2.y).toBeCloseTo(20);
			expect(updatedSegments[1].cp1.y).not.toBeCloseTo(0);
		});

		it("should mirror opposite handle in world space when path has rotation transform", () => {
			// Path with rotation=90°: local (0,0)→(100,0)→(200,0)
			// becomes world (100,-100)→(100,0)→(100,100)
			// anchor world=(100,0), cp2(seg0) world=(100,-34), cp1(seg1) world=(100,33)
			const rotatedPath: Path = {
				...testPath,
				id: "path-rot",
				segments: testPath.segments.map((seg) => ({
					...seg,
					start: seg.start ? { ...seg.start } : undefined,
					cp1: { ...seg.cp1 },
					cp2: { ...seg.cp2 },
					end: { ...seg.end },
				})),
				transform: { x: 0, y: 0, rotation: Math.PI / 2, scaleX: 1, scaleY: 1 },
			};

			tool.initWithSelectedPaths(
				[rotatedPath],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// cp2(seg0) world=(100,-34) → screen(500, 334)
			tool.onPointerDown(
				ev(500, 334),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Drag cp2 to world=(120,-34) → screen(520, 334): moved +20 in world-X
			tool.onPointerMove(
				ev(520, 334),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(520, 334),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.batchPathUpdate).toHaveBeenCalled();
			const segs = getCommittedSegments(ctx, "path-rot")!;

			// In world space, cp1(seg1) should have moved symmetrically.
			// Old cp1 world=(100,33). New cp1 world should have y≈33 and x<100 (mirrored leftward).
			// Verify via getWorldSegments on the returned segments with same rotation.
			// Easier: just check that cp1 relative y changed from 0 (it was (33,0)) toward a negative value,
			// because in local space the world-x delta maps to a y delta under 90° rotation.
			expect(segs[1].cp1.y).not.toBeCloseTo(0, 0);
		});

		it("should break tangent through anchor with Alt key", () => {
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Click on seg0.cp2 at screen(466,300) -> world(66,0) with Alt held
			tool.onPointerDown(
				ev(466, 300, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Drag to screen(466,280) -> world(66,20) with Alt held
			tool.onPointerMove(
				ev(466, 280, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(466, 280, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.batchPathUpdate).toHaveBeenCalled();
			const updatedSegments = getCommittedSegments(ctx, "path-1")!;

			// seg0.cp2 (relative to end) moved
			expect(updatedSegments[0].cp2.y).toBeCloseTo(20);

			// Alt+drag keeps opposite CP unchanged.
			expect(updatedSegments[1].cp1.x).toBeCloseTo(33);
			expect(updatedSegments[1].cp1.y).toBeCloseTo(0);
		});
	});

	describe("Shape integrity", () => {
		it("face drag translates all anchors by same delta and preserves cp relative offsets", () => {
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			ctx.findPathAtPoint.mockReturnValue(
				(tool as any).selectedPaths.get("path-1")!,
			);

			// Drag face: screen(450,300)→screen(480,260) = world delta (+30,+40)
			tool.onPointerDown(
				ev(450, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(480, 260),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(480, 260),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const segs = getCommittedSegments(ctx, "path-1")!;

			// All anchors translated by (+30,+40)
			expect(segs[0].start?.x).toBeCloseTo(30);
			expect(segs[0].start?.y).toBeCloseTo(40);
			expect(segs[0].end.x).toBeCloseTo(130);
			expect(segs[0].end.y).toBeCloseTo(40);
			expect(segs[1].end.x).toBeCloseTo(230);
			expect(segs[1].end.y).toBeCloseTo(40);

			// Shape preserved: cp1/cp2 relative offsets are unchanged
			expect(segs[0].cp1.x).toBeCloseTo(33);
			expect(segs[0].cp1.y).toBeCloseTo(0);
			expect(segs[0].cp2.x).toBeCloseTo(-34);
			expect(segs[0].cp2.y).toBeCloseTo(0);
			expect(segs[1].cp1.x).toBeCloseTo(33);
			expect(segs[1].cp1.y).toBeCloseTo(0);
			expect(segs[1].cp2.x).toBeCloseTo(-34);
			expect(segs[1].cp2.y).toBeCloseTo(0);
		});

		it("single-anchor drag moves only that anchor, leaves other anchors unchanged", () => {
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Click end0 at screen(500,300)→world(100,0) to select only it (no prior selection)
			tool.onPointerDown(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Drag end0 to screen(500,250)→world(100,50): delta y=+50
			tool.onPointerDown(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(500, 250),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 250),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const segs = getCommittedSegments(ctx, "path-1")!;

			// end0 moved
			expect(segs[0].end.x).toBeCloseTo(100);
			expect(segs[0].end.y).toBeCloseTo(50);

			// start0 unchanged
			expect(segs[0].start?.x).toBeCloseTo(0);
			expect(segs[0].start?.y).toBeCloseTo(0);

			// end1 unchanged
			expect(segs[1].end.x).toBeCloseTo(200);
			expect(segs[1].end.y).toBeCloseTo(0);
		});

		it("corner radius drag changes cornerRadius value but does not move anchor positions", () => {
			function makeRectPath(): Path {
				const corners = [
					{ x: -100, y: 100 },
					{ x: 100, y: 100 },
					{ x: 100, y: -100 },
					{ x: -100, y: -100 },
				];
				const segments = corners.map((p1, i) => {
					const p2 = corners[(i + 1) % corners.length];
					return {
						start: i === 0 ? p1 : undefined,
						cp1: { x: (p2.x - p1.x) * 0.33, y: (p2.y - p1.y) * 0.33 },
						cp2: { x: -(p2.x - p1.x) * 0.33, y: -(p2.y - p1.y) * 0.33 },
						end: p2,
						startTiltX: 0,
						startTiltY: 0,
						endTiltX: 0,
						endTiltY: 0,
						startDeltaTime: 0,
						endDeltaTime: 0,
						isMoved: i === 0,
						isClosed: i === corners.length - 1 || undefined,
					};
				});
				return {
					id: "rect-integrity",
					type: "path",
					opacity: 1,
					blendMode: "normal",
					segments,
					transform: createIdentityTransform(),
				} as Path;
			}

			const rect = makeRectPath();
			tool.initWithSelectedPaths(
				[rect],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const crHandles = getControlPoints(ctx, HANDLES_KEY).filter(
				(cp) => cp.type === "corner-radius",
			);
			const crHandle = crHandles.find((h) => h.segmentIndex === 0)!;

			tool.onPointerDown(
				ev(crHandle.screenX, crHandle.screenY),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(crHandle.screenX - 20, crHandle.screenY + 20),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(crHandle.screenX - 20, crHandle.screenY + 20),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const segs = getCommittedSegments(
				ctx,
				"rect-integrity",
			)! as PathSegment[];

			// cornerRadius changed
			expect(segs[0].cornerRadius).toBeGreaterThan(0);

			// Anchor positions unchanged: end0 was world(100,100), end1 was world(100,-100)
			expect(segs[0].end.x).toBeCloseTo(100);
			expect(segs[0].end.y).toBeCloseTo(100);
			expect(segs[1].end.x).toBeCloseTo(100);
			expect(segs[1].end.y).toBeCloseTo(-100);
		});
	});

	describe("Face drag", () => {
		it("should translate all segments when dragging face of selected path", () => {
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Click on face of selected path at screen(450,300) -> world(50,0)
			ctx.findPathAtPoint.mockReturnValue(
				(tool as any).selectedPaths.get("path-1")!,
			);

			tool.onPointerDown(
				ev(450, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Drag to screen(480,280) -> world(80,20), delta = (30, 20)
			tool.onPointerMove(
				ev(480, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(480, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.batchPathUpdate).toHaveBeenCalled();

			const updatedSegments = getCommittedSegments(ctx, "path-1")!;

			// seg0.start was (0,0), should move by delta (30,20) -> (30,20)
			expect(updatedSegments[0].start?.x).toBeCloseTo(30);
			expect(updatedSegments[0].start?.y).toBeCloseTo(20);

			// seg0.end was (100,0), should move to (130,20)
			expect(updatedSegments[0].end.x).toBeCloseTo(130);
			expect(updatedSegments[0].end.y).toBeCloseTo(20);

			// seg1.end was (200,0), should move to (230,20)
			expect(updatedSegments[1].end.x).toBeCloseTo(230);
			expect(updatedSegments[1].end.y).toBeCloseTo(20);
		});

		it("should translate a rotated path straight along a multi-step world-space drag", () => {
			// Path with rotation=90°: local (0,0)→(100,0)→(200,0)
			// becomes world (100,-100)→(100,0)→(100,100).
			//
			// The render pivot is the bbox center of the path's own local
			// bounds (applyElementTransform / ViewportManager), which
			// translates together with the geometry: under
			// `world = R·S·(local − origin) + origin + t`, adding d to every
			// local point also adds d to origin, so the world image moves by
			// exactly d. A pure world-Y drag must therefore be stored as a
			// pure local-Y translation — inverse-rotating the delta (the old
			// bug) made the shape travel perpendicular to the drag.
			const rotatedPath: Path = {
				...testPath,
				id: "path-rot-face",
				segments: testPath.segments.map((seg) => ({
					...seg,
					start: seg.start ? { ...seg.start } : undefined,
					cp1: { ...seg.cp1 },
					cp2: { ...seg.cp2 },
					end: { ...seg.end },
				})),
				transform: { x: 0, y: 0, rotation: Math.PI / 2, scaleX: 1, scaleY: 1 },
			};

			tool.initWithSelectedPaths(
				[rotatedPath],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			ctx.findPathAtPoint.mockReturnValue(
				(tool as any).selectedPaths.get("path-rot-face")!,
			);

			// Click on face at world(100,15) -> screen(500,285). Deliberately
			// away from every handle (anchors at world y=-100/0/100, CPs at
			// y=-67/-34/33/66) so this registers as a face click, not a
			// vertex/CP handle click.
			tool.onPointerDown(
				ev(500, 285),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Drag straight up in world space across several small steps,
			// mimicking real mouse movement (many pointermove events per drag).
			const worldYSteps = [10, 20, 30, 50, 80, 120, 200];
			for (const worldY of worldYSteps) {
				tool.onPointerMove(
					ev(500, 285 - worldY),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);
			}
			tool.onPointerUp(
				ev(500, 285 - 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.batchPathUpdate).toHaveBeenCalled();
			const segs = getCommittedSegments(ctx, "path-rot-face")!;

			// World drag was (0, +200), so the stored local translation must
			// also be (0, +200) — see the pivot-follows-bounds note above.
			// Rendered world check for seg0.start: origin' = (100, 200),
			// R90·((0,200) − (100,200)) + (100,200) = (100, 100), i.e. the
			// pre-drag world position (100, -100) moved by exactly (0, +200).
			expect(segs[0].start?.x).toBeCloseTo(0, 5);
			expect(segs[0].start?.y).toBeCloseTo(200, 5);
			expect(segs[1].end.x).toBeCloseTo(200, 5);
			expect(segs[1].end.y).toBeCloseTo(200, 5);
		});
	});

	describe("Alt+drag duplicate", () => {
		/** Wire duplicateElements() so it returns `copyId` pointing at `copy`. */
		function stubDuplicate(ctx: MockToolContext, copyId: string, copy: Path) {
			ctx.duplicateElementsByIds.mockReturnValue([copyId]);
			ctx.getPathById.mockImplementation((id: string) =>
				id === copyId ? copy : null,
			);
		}

		it("duplicates the whole path on alt+drag over the face and drags the copy", () => {
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			const copy = { ...cloneTestPath(), id: "path-copy" };
			stubDuplicate(ctx, "path-copy", copy);
			ctx.findPathAtPoint.mockReturnValue(
				(tool as any).selectedPaths.get("path-1")!,
			);

			// Alt+press on the face at screen(450,300) -> world(50,0)
			tool.onPointerDown(
				ev(450, 300, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// First move promotes to faceDrag and duplicates (delta resets here)
			tool.onPointerMove(
				ev(480, 300, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Second move drags the copy by world (20,0)
			tool.onPointerMove(
				ev(500, 300, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 300, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.duplicateElementsByIds).toHaveBeenCalledWith(["path-1"], {
				x: 10,
				y: 10,
			});
			// The copy is committed, moved by the post-duplicate drag delta.
			const copySegs = getCommittedSegments(ctx, "path-copy")!;
			expect(copySegs).toBeDefined();
			expect(copySegs[0].start?.x).toBeCloseTo(20);
			expect(copySegs[1].end.x).toBeCloseTo(220);
			// The original path is never mutated.
			expect(getCommittedSegments(ctx, "path-1")).toBeUndefined();
		});

		it("does not duplicate on alt+drag over an already-selected vertex (reverts to anchor CP editing)", () => {
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Select the end0 anchor first (plain click, no alt).
			tool.onPointerDown(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const copy = { ...cloneTestPath(), id: "path-copy" };
			stubDuplicate(ctx, "path-copy", copy);

			// Alt+drag the selected vertex: must NOT duplicate — it stays anchor
			// CP editing, same as an unselected anchor.
			tool.onPointerDown(
				ev(500, 300, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(520, 300, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(520, 300, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.duplicateElementsByIds).not.toHaveBeenCalled();
			expect(getCommittedSegments(ctx, "path-copy")).toBeUndefined();
		});

		it("does not duplicate on alt+drag over an unselected anchor (keeps tangent creation)", () => {
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// No handle selected yet: alt+drag on the anchor must create a tangent,
			// not duplicate.
			tool.onPointerDown(
				ev(500, 300, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(500, 260, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 260, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.duplicateElementsByIds).not.toHaveBeenCalled();
		});
	});

	describe("Shift selection", () => {
		it("should toggle handle selection with Shift+click", () => {
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Click on end0 anchor at screen(500,300) without Shift -> selects it
			tool.onPointerDown(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const selectedAfterFirst = getControlPoints(ctx, HANDLES_KEY).filter(
				(cp) => cp.selected,
			);
			expect(selectedAfterFirst.length).toBe(1);

			// Shift+click on start at screen(400,300) -> adds to selection
			tool.onPointerDown(
				ev(400, 300, { shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(400, 300, { shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const selectedAfterSecond = getControlPoints(ctx, HANDLES_KEY).filter(
				(cp) => cp.selected,
			);
			expect(selectedAfterSecond.length).toBe(2);
		});
	});

	describe("Anchor deletion", () => {
		it("should erase the path when break-deleting leaves no drawable run", () => {
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Click on the middle anchor at screen(500,300) to select it
			tool.onPointerDown(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Delete breaks the path apart; both leftover runs are single
			// isolated anchors, so nothing drawable remains.
			const handled = tool.onKeyDown(
				{ code: "Delete" } as KeyboardEvent,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(handled).toBe(true);
			expect(ctx.eraseElement.mock.calls[0][0]).toBe("path-1");
		});

		it("should trim the path when break-deleting an end anchor", () => {
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Click on the start anchor at screen(400,300) to select it
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const handled = tool.onKeyDown(
				{ code: "Delete" } as KeyboardEvent,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(handled).toBe(true);
			const [pathId, segments] = ctx.pathUpdate.mock.calls[0];
			expect(pathId).toBe("path-1");
			expect(segments).toHaveLength(1);
			expect(segments[0].start).toEqual({ x: 100, y: 0 });
			expect(segments[0].end).toEqual({ x: 200, y: 0 });
		});

		it("should cut the path into two paths when break-deleting a middle anchor", () => {
			// 5 anchors at x = 0, 100, 200, 300, 400
			const path = makeStraightPath("path-5", [0, 100, 200, 300, 400]);
			tool.initWithSelectedPaths(
				[path],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Click on the center anchor world(200,0) = screen(600,300)
			tool.onPointerDown(
				ev(600, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(600, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const handled = tool.onKeyDown(
				{ code: "Delete" } as KeyboardEvent,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(handled).toBe(true);
			const [pathId, segmentLists] = ctx.replacePathWithPaths.mock.calls[0];
			expect(pathId).toBe("path-5");
			expect(segmentLists).toHaveLength(2);
			expect(segmentLists[0]).toHaveLength(1);
			expect(segmentLists[0][0].start).toEqual({ x: 0, y: 0 });
			expect(segmentLists[0][0].end).toEqual({ x: 100, y: 0 });
			expect(segmentLists[1]).toHaveLength(1);
			expect(segmentLists[1][0].start).toEqual({ x: 300, y: 0 });
			expect(segmentLists[1][0].end).toEqual({ x: 400, y: 0 });
		});

		it("should stash the doomed selection for undo restore when deleting", () => {
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Click on the middle anchor at screen(500,300) to select it
			tool.onPointerDown(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			tool.onKeyDown(
				{ code: "Delete" } as KeyboardEvent,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const [stashedKeys] = ctx.stashPathEditUndoSelection.mock.calls[0];
			expect(stashedKeys).toContain("path-1:0:end");
		});

		it("should re-select restored anchors via restoreAnchorSelectionAfterUndo", () => {
			ctx.getPathById.mockReturnValue(cloneTestPath());

			tool.restoreAnchorSelectionAfterUndo(
				["path-1:0:end"],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const selected = getControlPoints(ctx, HANDLES_KEY).filter(
				(cp) => cp.selected,
			);
			expect(selected.length).toBeGreaterThan(0);
		});

		it("should rejoin neighbors on Shift+Delete like long-press deletion", () => {
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Click on the middle anchor at screen(500,300) to select it
			tool.onPointerDown(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const handled = tool.onKeyDown(
				{ code: "Delete", shiftKey: true } as KeyboardEvent,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(handled).toBe(true);
			expect(ctx.replacePathWithPaths).not.toHaveBeenCalled();
			const [pathId, segments] = ctx.pathUpdate.mock.calls[0];
			expect(pathId).toBe("path-1");
			expect(segments).toHaveLength(1);
			expect(segments[0].start).toEqual({ x: 0, y: 0 });
			expect(segments[0].end).toEqual({ x: 200, y: 0 });
		});
	});

	describe("Cancel", () => {
		it("should reset state and clear UI", () => {
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			ctx.uiSetOverlay.mockClear();

			tool.onCancel();

			expect(tool.getCursor()).toBe("crosshair");
			expect(lastOverlayCall(ctx, HANDLES_KEY)).toBeNull();
		});
	});

	describe("Corner radius drag", () => {
		/**
		 * Rectangle path (world coords, Y-up):
		 *   seg0: (-100,-100) → (100,-100)  bottom edge
		 *   seg1: (100,-100)  → (100,100)   right edge
		 *   seg2: (100,100)   → (-100,100)  top edge
		 *   seg3: (-100,100)  → (-100,-100) left edge (isClosed)
		 *
		 * All segments are straight lines (cp1=cp2=endpoints).
		 * Each vertex has a 90° angle → corner-radius handles should appear.
		 *
		 * Screen coordinates (viewport=0,0, zoom=1, canvas=800x600):
		 *   world(-100,-100) → screen(300, 400)
		 *   world(100,-100)  → screen(500, 400)
		 *   world(100,100)   → screen(500, 200)
		 *   world(-100,100)  → screen(300, 200)
		 */
		/**
		 * Rectangle using the same structure as ShapeTool's createClosedPolygonSegments:
		 *   corners: 左上(-100,100) → 右上(100,100) → 右下(100,-100) → 左下(-100,-100)
		 *   cp1/cp2 are RELATIVE OFFSETS (1/3 of edge delta from respective anchors)
		 *   seg[0].isMoved = true (subpath start marker)
		 */
		function createRectPath(): Path {
			const corners = [
				{ x: -100, y: 100 }, // 左上
				{ x: 100, y: 100 }, // 右上
				{ x: 100, y: -100 }, // 右下
				{ x: -100, y: -100 }, // 左下
			];
			const segments = corners.map((p1, i) => {
				const p2 = corners[(i + 1) % corners.length];
				return {
					start: i === 0 ? p1 : undefined,
					// cp1 relative = (p2-p1)*0.33 (offset from start anchor)
					cp1: {
						x: (p2.x - p1.x) * 0.33,
						y: (p2.y - p1.y) * 0.33,
					},
					// cp2 relative = -(p2-p1)*0.33 (offset from end anchor)
					cp2: {
						x: -(p2.x - p1.x) * 0.33,
						y: -(p2.y - p1.y) * 0.33,
					},
					end: p2,
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
					isMoved: i === 0,
					isClosed: i === corners.length - 1 || undefined,
				};
			});
			return {
				id: "rect-1",
				type: "path",
				opacity: 1,
				blendMode: "normal",
				segments,
				transform: createIdentityTransform(),
			} as Path;
		}

		it("should generate corner-radius handles for 90° vertices", () => {
			const rect = createRectPath();
			tool.initWithSelectedPaths(
				[rect],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const crHandles = getControlPoints(ctx, HANDLES_KEY).filter(
				(cp) => cp.type === "corner-radius",
			);

			// All 4 corners of closed rectangle should have corner-radius handles
			expect(crHandles.length).toBe(4);
		});

		it("should place corner-radius handles on inner side of vertex", () => {
			const rect = createRectPath();
			tool.initWithSelectedPaths(
				[rect],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const crHandles = getControlPoints(ctx, HANDLES_KEY).filter(
				(cp) => cp.type === "corner-radius",
			);

			// seg0.end = top-right corner at world(100,100)
			// Inner side = toward center (0,0)
			const topRight = crHandles.find((h) => h.segmentIndex === 0)!;
			expect(topRight).toBeDefined();
			// Handle should be toward center from vertex:
			// vertex is at (100,100), inner direction is toward (0,0)
			// So handleX < 100 and handleY < 100
			expect(topRight.worldX).toBeLessThan(100);
			expect(topRight.worldY).toBeLessThan(100);

			// seg1.end = bottom-right corner at world(100,-100)
			const bottomRight = crHandles.find((h) => h.segmentIndex === 1)!;
			expect(bottomRight).toBeDefined();
			expect(bottomRight.worldX).toBeLessThan(100);
			expect(bottomRight.worldY).toBeGreaterThan(-100);
		});

		it("should update cornerRadius on single handle drag", () => {
			const rect = createRectPath();
			tool.initWithSelectedPaths(
				[rect],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Get bottom-right corner-radius handle position
			const crHandles = getControlPoints(ctx, HANDLES_KEY).filter(
				(cp) => cp.type === "corner-radius",
			);
			const brHandle = crHandles.find((h) => h.segmentIndex === 0)!;

			// Click on the corner-radius handle (seg0.end = top-right at world(100,100))
			tool.onPointerDown(
				ev(brHandle.screenX, brHandle.screenY),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Drag toward center (inner direction for top-right = toward bottom-left)
			// In screen coords: left = -x, down = +y (because world Y is flipped)
			tool.onPointerMove(
				ev(brHandle.screenX - 20, brHandle.screenY + 20),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(brHandle.screenX - 20, brHandle.screenY + 20),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.batchPathUpdate).toHaveBeenCalled();
			const updatedSegments = getCommittedSegments(
				ctx,
				"rect-1",
			)! as PathSegment[];

			// seg0 should have cornerRadius > 0
			expect(updatedSegments[0].cornerRadius).toBeGreaterThan(0);
			// Other segments should not have cornerRadius (only dragged one)
			expect(updatedSegments[1].cornerRadius ?? 0).toBe(0);
		});

		it("should apply same delta to all selected handles on multi-select drag", () => {
			const rect = createRectPath();
			tool.initWithSelectedPaths(
				[rect],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Get corner-radius handles
			const crHandles = getControlPoints(ctx, HANDLES_KEY).filter(
				(cp) => cp.type === "corner-radius",
			);
			const brHandle = crHandles.find((h) => h.segmentIndex === 0)!;
			const trHandle = crHandles.find((h) => h.segmentIndex === 1)!;

			// Select first corner-radius handle
			tool.onPointerDown(
				ev(brHandle.screenX, brHandle.screenY),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(brHandle.screenX, brHandle.screenY),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Shift+click second corner-radius handle
			tool.onPointerDown(
				ev(trHandle.screenX, trHandle.screenY, { shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(trHandle.screenX, trHandle.screenY, { shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Now both should be selected. Drag the first one toward center.
			tool.onPointerDown(
				ev(brHandle.screenX, brHandle.screenY),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(brHandle.screenX - 20, brHandle.screenY + 20),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(brHandle.screenX - 20, brHandle.screenY + 20),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.batchPathUpdate).toHaveBeenCalled();
			const updatedSegments = getCommittedSegments(
				ctx,
				"rect-1",
			)! as PathSegment[];

			// Both seg0 and seg1 should have cornerRadius > 0
			expect(updatedSegments[0].cornerRadius).toBeGreaterThan(0);
			expect(updatedSegments[1].cornerRadius).toBeGreaterThan(0);

			// They should have the same delta applied (starting from 0)
			expect(updatedSegments[0].cornerRadius).toBeCloseTo(
				updatedSegments[1].cornerRadius!,
			);
		});

		it("should select all corner-radius handles on fill click and drag all", () => {
			const rect = createRectPath();
			tool.initWithSelectedPaths(
				[rect],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Click on fill area (findPathAtPoint returns selected path)
			ctx.findPathAtPoint.mockReturnValue(
				(tool as any).selectedPaths.get("rect-1")!,
			);

			// PointerDown on fill → faceDragMode
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// PointerUp without move → selects all corner-radius handles
			tool.onPointerUp(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const selectedCR = getControlPoints(ctx, HANDLES_KEY).filter(
				(cp) => cp.type === "corner-radius" && cp.selected,
			);
			expect(selectedCR.length).toBe(4); // All 4 corners of closed rectangle

			// Now drag one of the selected handles
			const firstCR = selectedCR[0];
			tool.onPointerDown(
				ev(firstCR.screenX, firstCR.screenY),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Drag toward center
			tool.onPointerMove(
				ev(firstCR.screenX - 15, firstCR.screenY + 15),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(firstCR.screenX - 15, firstCR.screenY + 15),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.batchPathUpdate).toHaveBeenCalled();
			const updatedSegments = getCommittedSegments(
				ctx,
				"rect-1",
			)! as PathSegment[];

			// All 4 corners should have cornerRadius > 0
			expect(updatedSegments[0].cornerRadius).toBeGreaterThan(0);
			expect(updatedSegments[1].cornerRadius).toBeGreaterThan(0);
			expect(updatedSegments[2].cornerRadius).toBeGreaterThan(0);
			expect(updatedSegments[3].cornerRadius).toBeGreaterThan(0);

			// None should be at max (chord length / 2 ≈ 100 for this rect)
			expect(updatedSegments[0].cornerRadius).toBeLessThan(100);
			expect(updatedSegments[1].cornerRadius).toBeLessThan(100);
			expect(updatedSegments[2].cornerRadius).toBeLessThan(100);
			expect(updatedSegments[3].cornerRadius).toBeLessThan(100);
		});

		it("should update cornerRadius during drag (not stuck at max)", () => {
			const rect = createRectPath();
			tool.initWithSelectedPaths(
				[rect],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const crHandles = getControlPoints(ctx, HANDLES_KEY).filter(
				(cp) => cp.type === "corner-radius",
			);
			const brHandle = crHandles.find((h) => h.segmentIndex === 0)!;

			// Click on the handle
			tool.onPointerDown(
				ev(brHandle.screenX, brHandle.screenY),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Drag a small amount toward inner (for top-right vertex, inner = screen left+down)
			tool.onPointerMove(
				ev(brHandle.screenX - 10, brHandle.screenY + 10),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Check intermediate cornerRadius via the refreshed handles overlay
			const updatedCR1 = getControlPoints(ctx, HANDLES_KEY).filter(
				(cp) => cp.type === "corner-radius" && cp.segmentIndex === 0,
			)[0];
			const radius1WorldX = updatedCR1.worldX;

			// Drag further toward inner
			tool.onPointerMove(
				ev(brHandle.screenX - 30, brHandle.screenY + 30),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const updatedCR2 = getControlPoints(ctx, HANDLES_KEY).filter(
				(cp) => cp.type === "corner-radius" && cp.segmentIndex === 0,
			)[0];
			const radius2WorldX = updatedCR2.worldX;

			// Handle should have moved further from vertex (worldX decreased more)
			expect(radius2WorldX).toBeLessThan(radius1WorldX);

			tool.onPointerUp(
				ev(brHandle.screenX - 30, brHandle.screenY + 30),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const updatedSegments = getCommittedSegments(
				ctx,
				"rect-1",
			)! as PathSegment[];

			// Should NOT be at maxRadius
			expect(updatedSegments[0].cornerRadius).toBeGreaterThan(0);
			expect(updatedSegments[0].cornerRadius).toBeLessThan(100);
		});
	});

	describe("Face selection selects all vertices", () => {
		function createRectPath(): Path {
			const corners = [
				{ x: -100, y: 100 },
				{ x: 100, y: 100 },
				{ x: 100, y: -100 },
				{ x: -100, y: -100 },
			];
			const segments = corners.map((p1, i) => {
				const p2 = corners[(i + 1) % corners.length];
				return {
					start: i === 0 ? p1 : undefined,
					// cp1 relative = (p2-p1)*0.33 (offset from start anchor)
					cp1: {
						x: (p2.x - p1.x) * 0.33,
						y: (p2.y - p1.y) * 0.33,
					},
					// cp2 relative = -(p2-p1)*0.33 (offset from end anchor)
					cp2: {
						x: -(p2.x - p1.x) * 0.33,
						y: -(p2.y - p1.y) * 0.33,
					},
					end: p2,
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
					isMoved: i === 0,
					isClosed: i === corners.length - 1 || undefined,
				};
			});
			return {
				id: "rect-sel",
				type: "path",
				opacity: 1,
				blendMode: "normal",
				segments,
				transform: createIdentityTransform(),
			} as Path;
		}

		it("should select all anchor vertices when clicking on a path face", () => {
			const rect = createRectPath();
			// findPathAtPoint returns the rect when clicking its face
			ctx.findPathAtPoint.mockReturnValue(rect);

			// Click on the face area to select the path
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const controlPoints = getControlPoints(ctx, HANDLES_KEY);
			const selectedAnchors = controlPoints.filter(
				(cp) => cp.type === "anchor" && cp.pointType === "end" && cp.selected,
			);
			const selectedCR = controlPoints.filter(
				(cp) => cp.type === "corner-radius" && cp.selected,
			);

			// All 4 end-anchors and 4 corner-radius handles should be selected
			expect(selectedAnchors.length).toBe(4);
			expect(selectedCR.length).toBe(4);
		});

		it("should select all anchor vertices when Shift+clicking to add a path", () => {
			const rect = createRectPath();
			ctx.findPathAtPoint.mockReturnValue(rect);

			// Shift+click to add the path
			tool.onPointerDown(
				ev(400, 300, { shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(400, 300, { shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const controlPoints = getControlPoints(ctx, HANDLES_KEY);
			const selectedAnchors = controlPoints.filter(
				(cp) => cp.type === "anchor" && cp.pointType === "end" && cp.selected,
			);
			const selectedCR = controlPoints.filter(
				(cp) => cp.type === "corner-radius" && cp.selected,
			);

			expect(selectedAnchors.length).toBe(4);
			expect(selectedCR.length).toBe(4);
		});
	});

	describe("Cursor", () => {
		it("should return appropriate cursor for each state", () => {
			// Initial state: no selection
			expect(tool.getCursor()).toBe("crosshair");

			// After selecting a path
			tool.initWithSelectedPaths(
				[cloneTestPath()],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			expect(tool.getCursor()).toBe("grab");

			// During handle drag (pointerDown on a handle)
			tool.onPointerDown(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// After pointerDown, draggedHandles is populated -> "grabbing"
			expect(tool.getCursor()).toBe("grabbing");
		});
	});

	describe("Long-press operations", () => {
		let nowSpy: ReturnType<typeof vi.spyOn>;
		let currentTime: number;

		beforeEach(() => {
			currentTime = 1000;
			nowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);
		});

		afterEach(() => {
			nowSpy.mockRestore();
		});

		it("deletes anchor on long-press without drag", () => {
			const path = cloneTestPath();
			tool.initWithSelectedPaths(
				[path],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// pointerDown on the middle anchor at screen(500,300) → world(100,0)
			currentTime = 1000;
			tool.onPointerDown(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Advance time past LONG_PRESS_MS (400ms)
			currentTime = 1500;
			tool.onPointerUp(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Anchor at (100,0) was deleted → path should be updated with 1 segment
			expect(ctx.pathUpdate).toHaveBeenCalled();
			const updatedSegments = ctx.pathUpdate.mock.calls[0][1];
			// After deleting middle anchor, the path goes from 2 anchors remaining
			// Original: 3 anchors (0,0)→(100,0)→(200,0), delete middle → (0,0)→(200,0) = 1 segment
			expect(updatedSegments).toHaveLength(1);
		});

		it("does not delete on short click", () => {
			const path = cloneTestPath();
			tool.initWithSelectedPaths(
				[path],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// pointerDown on end anchor at screen(600,300) → world(200,0)
			currentTime = 1000;
			tool.onPointerDown(
				ev(600, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Release quickly (< 400ms)
			currentTime = 1100;
			tool.onPointerUp(
				ev(600, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Should NOT delete - just select the handle
			expect(ctx.batchPathUpdate).not.toHaveBeenCalled();
			expect(ctx.eraseElement).not.toHaveBeenCalled();
		});

		it("triggers CP creation on long-press + drag (Alt+drag equivalent)", () => {
			const path = cloneTestPath();
			tool.initWithSelectedPaths(
				[path],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// pointerDown on end anchor at screen(600,300) → world(200,0)
			currentTime = 1000;
			tool.onPointerDown(
				ev(600, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Advance time past LONG_PRESS_MS, then drag
			currentTime = 1500;
			tool.onPointerMove(
				ev(620, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// The cp2 of the last segment should have been reset to (0,0) and then
			// the CP creation drag should set it to the drag direction
			expect(lastOverlayCall(ctx, HANDLES_KEY)).not.toBeNull();

			// Verify CP was modified (the drag creates a new tangent)
			// Release to complete
			tool.onPointerUp(
				ev(620, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.batchPathUpdate).toHaveBeenCalled();
		});

		it("erases element when deleting leaves fewer than 2 anchors", () => {
			// Create a simple 1-segment path with only 2 anchors
			const simplePath: Path = {
				id: "simple-1",
				type: "path",
				opacity: 1,
				blendMode: "normal",
				segments: [
					{
						start: { x: 0, y: 0 },
						cp1: { x: 0, y: 0 },
						cp2: { x: 0, y: 0 },
						end: { x: 100, y: 0 },
						startTiltX: 0,
						startTiltY: 0,
						endTiltX: 0,
						endTiltY: 0,
						startDeltaTime: 0,
						endDeltaTime: 0,
						isMoved: true,
					},
				],
				transform: createIdentityTransform(),
			};

			tool.initWithSelectedPaths(
				[simplePath],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Long-press on end anchor at screen(500,300) → world(100,0)
			currentTime = 1000;
			tool.onPointerDown(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			currentTime = 1500;
			tool.onPointerUp(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// With only 1 anchor remaining, the element should be erased
			expect(ctx.eraseElement).toHaveBeenCalledWith("simple-1");
		});
	});

	describe("Merge endpoint selection", () => {
		/**
		 * Path B: 2-segment open path at world(300,0) → (400,0) → (500,0)
		 * screen positions (viewport 0,0 zoom=1, canvas 800x600):
		 *   start(300,0) → screen(700,300)
		 *   end0(400,0)  → screen(800,300)
		 *   end1(500,0)  → screen(900,300) — off-canvas but still world-valid
		 */
		const pathB: Path = {
			id: "path-2",
			type: "path",
			opacity: 1,
			blendMode: "normal",
			segments: [
				{
					start: { x: 300, y: 0 },
					cp1: { x: 33, y: 0 },
					cp2: { x: -34, y: 0 },
					end: { x: 400, y: 0 },
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
					isMoved: false,
				},
				{
					cp1: { x: 33, y: 0 },
					cp2: { x: -34, y: 0 },
					end: { x: 500, y: 0 },
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
					isMoved: false,
				},
			],
			transform: createIdentityTransform(),
		};

		function clonePathB(): Path {
			return {
				...pathB,
				segments: pathB.segments.map((seg) => ({
					...seg,
					start: seg.start ? { ...seg.start } : undefined,
					cp1: { ...seg.cp1 },
					cp2: { ...seg.cp2 },
					end: { ...seg.end },
				})),
			};
		}

		it("should publish 2 endpoints from 2 paths after shift+click on both path endpoints", () => {
			const pathA = cloneTestPath();
			const pB = clonePathB();

			// Init with pathA selected
			tool.initWithSelectedPaths(
				[pathA],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Configure: getAllEditablePaths returns both, getPathById returns pathB
			ctx.getAllEditablePaths.mockReturnValue([
				{ path: pathA, ancestorTransform: null },
				{ path: pB, ancestorTransform: null },
			]);
			ctx.getPathById.mockImplementation((id: string) => {
				if (id === pathA.id) return pathA;
				if (id === pB.id) return pB;
				return null;
			});

			// Click end of pathA (last segment end): world(200,0) → screen(600,300)
			tool.onPointerDown(
				ev(600, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(600, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			ctx.pathEditUpdateSelectedAnchors.mockClear();

			// Shift+click start of pathB: world(300,0) → screen(700,300)
			tool.onPointerDown(
				ev(700, 300, { shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(700, 300, { shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Verify updatePathEditSelectedAnchors was called
			const calls = ctx.pathEditUpdateSelectedAnchors.mock.calls;
			expect(calls.length).toBeGreaterThan(0);

			const lastAnchors = calls[calls.length - 1][0];
			const endpoints = lastAnchors.filter(
				(a: { isEndpoint: boolean }) => a.isEndpoint,
			);
			const uniquePathIds = new Set(
				endpoints.map((a: { pathId: string }) => a.pathId),
			);

			expect(endpoints.length).toBe(2);
			expect(uniquePathIds.size).toBe(2);
		});
	});

	describe("Multi-object vertex drag commit", () => {
		const testPath2: Path = {
			id: "path-2",
			type: "path",
			opacity: 1,
			blendMode: "normal",
			segments: [
				{
					start: { x: 0, y: 100 },
					cp1: { x: 33, y: 0 },
					cp2: { x: -34, y: 0 },
					end: { x: 100, y: 100 },
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
					isMoved: false,
				},
			],
			transform: createIdentityTransform(),
		};

		function clonePath(p: Path): Path {
			return {
				...p,
				segments: p.segments.map((seg) => ({
					...seg,
					start: seg.start ? { ...seg.start } : undefined,
					cp1: { ...seg.cp1 },
					cp2: { ...seg.cp2 },
					end: { ...seg.end },
				})),
			};
		}

		it("should commit all dragged paths via batchPathUpdate", () => {
			const path1 = clonePath(testPath);
			const path2 = clonePath(testPath2);

			// Setup: both paths editable
			ctx.getAllEditablePaths.mockReturnValue([
				{ path: path1, ancestorTransform: null },
				{ path: path2, ancestorTransform: null },
			]);
			ctx.getPathById.mockImplementation((id: string) => {
				if (id === "path-1") return path1;
				if (id === "path-2") return path2;
				return null;
			});
			ctx.pathEditGetSelectionMode.mockReturnValue("rectangle");

			// Init with both paths
			tool.initWithSelectedPaths(
				[path1, path2],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Select start anchors of both paths via marquee
			// path1 start at screen(400,300), path2 start at screen(400,200)
			// Marquee from screen(390,190) to screen(410,310)
			ctx.findPathAtPoint.mockReturnValue(null);
			tool.onPointerDown(
				ev(390, 190),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(410, 310),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(410, 310),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			ctx.batchPathUpdate.mockClear();

			// Now drag from one of the selected anchors
			// Click on path1's start at screen(400,300)
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Drag to screen(420,280) = delta(+20, +20 world because Y is flipped)
			tool.onPointerMove(
				ev(420, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(420, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// batchPathUpdate should have been called once with entries for dragged paths
			expect(ctx.batchPathUpdate).toHaveBeenCalledTimes(1);
			const batchArgs = ctx.batchPathUpdate.mock.calls[0][0] as Array<
				[string, unknown]
			>;

			// At least one path should be committed
			expect(batchArgs.length).toBeGreaterThan(0);

			// All committed entries should have path IDs from our test paths
			const committedIds = batchArgs.map(([id]) => id);
			for (const id of committedIds) {
				expect(["path-1", "path-2"]).toContain(id);
			}
		});
	});

	describe("Mesh cage editing", () => {
		function makeMesh(id = "mesh-1"): MeshArtObject {
			return {
				id,
				type: "mesh",
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
				childIds: ["child-1"],
				vertices: [
					{ x: 0, y: 0, src: { x: 0, y: 0 }, handles: {} },
					{ x: 100, y: 0, src: { x: 100, y: 0 }, handles: {} },
					{ x: 100, y: 100, src: { x: 100, y: 100 }, handles: {} },
					{ x: 0, y: 100, src: { x: 0, y: 100 }, handles: {} },
				],
				faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
			};
		}

		/**
		 * A cage as it comes out of real editing: the face was cut, then cut
		 * again inside, and vertices were dragged around. Taken from the mesh in
		 * `src/tests/test-document.papf`, moved to the origin.
		 */
		function makeEditedCage(): MeshArtObject {
			return {
				...makeMesh(),
				vertices: [
					{
						x: -124.35,
						y: -69.94,
						src: {
							x: -124.35,
							y: -69.94,
						},
						handles: {
							"1": {
								x: -66.06,
								y: -121.33,
							},
							"3": {
								x: -142.85,
								y: -17.36,
							},
							"4": {
								x: -61.57,
								y: -69.94,
							},
							"7": {
								x: -124.35,
								y: -34.14,
							},
							"9": {
								x: -89.83,
								y: -69.94,
							},
						},
					},
					{
						x: 125.4,
						y: -70.45,
						src: {
							x: 125.65,
							y: -69.94,
						},
						handles: {
							"0": {
								x: 28.31,
								y: -134.18,
							},
							"2": {
								x: 144.92,
								y: -28.47,
							},
							"4": {
								x: 104.84,
								y: -70.45,
							},
							"6": {
								x: 125.4,
								y: -34.65,
							},
						},
					},
					{
						x: 125.65,
						y: 70.06,
						src: {
							x: 125.65,
							y: 70.06,
						},
						handles: {
							"1": {
								x: 144.94,
								y: 19.31,
							},
							"3": {
								x: 79.87,
								y: 112.14,
							},
							"5": {
								x: 105.09,
								y: 70.06,
							},
							"6": {
								x: 125.65,
								y: 59.19,
							},
						},
					},
					{
						x: -124.35,
						y: 70.06,
						src: {
							x: -124.35,
							y: 70.06,
						},
						handles: {
							"0": {
								x: -135.32,
								y: 34.96,
							},
							"2": {
								x: -41.25,
								y: 116.5,
							},
							"5": {
								x: -61.57,
								y: 70.06,
							},
							"7": {
								x: -124.35,
								y: 59.19,
							},
							"11": {
								x: -89.83,
								y: 70.06,
							},
						},
					},
					{
						x: 54.53,
						y: -104.21,
						src: {
							x: 63.97,
							y: -69.94,
						},
						positionSource: {
							edgeVerts: [0, 1],
							t: 0.753264,
						},
						meshSource: {
							edgeVerts: [0, 1],
							t: 0.753264,
						},
						splitLineId: 1,
						subdivisionId: 1,
						handles: {
							"0": {
								x: -8.24,
								y: -104.21,
							},
							"1": {
								x: 75.09,
								y: -104.21,
							},
							"9": {
								x: 26.27,
								y: -104.21,
							},
						},
					},
					{
						x: 46.82,
						y: 101,
						src: {
							x: 63.97,
							y: 70.06,
						},
						positionSource: {
							edgeVerts: [2, 3],
							t: 0.380859,
						},
						meshSource: {
							edgeVerts: [2, 3],
							t: 0.246736,
						},
						splitLineId: 1,
						subdivisionId: 1,
						handles: {
							"2": {
								x: 67.38,
								y: 101,
							},
							"3": {
								x: -15.95,
								y: 101,
							},
							"11": {
								x: 18.56,
								y: 101,
							},
						},
					},
					{
						x: 138.1,
						y: -28.82,
						src: {
							x: 125.65,
							y: 37.46,
						},
						positionSource: {
							edgeVerts: [1, 2],
							t: 0.317383,
						},
						meshSource: {
							edgeVerts: [1, 2],
							t: 0.767197,
						},
						splitLineId: 2,
						subdivisionId: 1,
						handles: {
							"1": {
								x: 138.1,
								y: -64.62,
							},
							"2": {
								x: 138.1,
								y: -17.95,
							},
							"8": {
								x: 122.9,
								y: 0.01,
							},
						},
					},
					{
						x: -134.88,
						y: 15.52,
						src: {
							x: -124.35,
							y: 37.46,
						},
						positionSource: {
							edgeVerts: [3, 0],
							t: 0.4375,
						},
						meshSource: {
							edgeVerts: [3, 0],
							t: 0.232803,
						},
						splitLineId: 2,
						subdivisionId: 1,
						handles: {
							"0": {
								x: -134.88,
								y: -20.28,
							},
							"3": {
								x: -134.88,
								y: 26.39,
							},
							"8": {
								x: -109.14,
								y: -44.87,
							},
							"10": {
								x: -120.73,
								y: -17.68,
							},
						},
					},
					{
						x: 52.89,
						y: -16.79,
						src: {
							x: 63.97,
							y: 37.46,
						},
						splitLineId: 1,
						subdivisionId: 1,
						subdivisionSource: {
							id: 1,
							vertexCount: 4,
							faces: [
								{
									type: "quad",
									verts: [0, 1, 2, 3],
								},
							],
						},
						handles: {
							"6": {
								x: 80.49,
								y: -9.86,
							},
							"7": {
								x: -23.3,
								y: -37.35,
							},
							"10": {
								x: 18.59,
								y: -26.05,
							},
						},
					},
					{
						x: -35.73,
						y: -111.26,
						src: {
							x: -20.81,
							y: -69.94,
						},
						positionSource: {
							edgeVerts: [0, 4],
							t: 0.549805,
						},
						meshSource: {
							edgeVerts: [0, 4],
							t: 0.549805,
						},
						splitLineId: 3,
						subdivisionId: 2,
						handles: {
							"0": {
								x: -67.68,
								y: -101.93,
							},
							"4": {
								x: -9.58,
								y: -118.89,
							},
							"10": {
								x: -45.28,
								y: -82.45,
							},
						},
					},
					{
						x: -55.88,
						y: -31.31,
						src: {
							x: -20.81,
							y: 37.46,
						},
						positionSource: {
							edgeVerts: [8, 7],
							t: 0.480469,
						},
						meshSource: {
							edgeVerts: [8, 7],
							t: 0.450195,
						},
						splitLineId: 3,
						subdivisionId: 2,
						handles: {
							"7": {
								x: -91.17,
								y: -23.72,
							},
							"8": {
								x: -26.98,
								y: -37.52,
							},
							"9": {
								x: -52.07,
								y: -63.38,
							},
							"11": {
								x: -58.11,
								y: 19.8,
							},
						},
					},
					{
						x: -3.73,
						y: 102.9,
						src: {
							x: -20.81,
							y: 70.06,
						},
						positionSource: {
							edgeVerts: [5, 3],
							t: 0.297852,
						},
						meshSource: {
							edgeVerts: [5, 3],
							t: 0.450195,
						},
						splitLineId: 3,
						subdivisionId: 2,
						handles: {
							"3": {
								x: -33.57,
								y: 94.48,
							},
							"5": {
								x: 20.71,
								y: 109.79,
							},
							"10": {
								x: -32.6,
								y: 72.83,
							},
						},
					},
				] as MeshArtObject["vertices"],
				faces: [
					{
						type: "quad",
						verts: [0, 9, 10, 7],
					},
					{
						type: "quad",
						verts: [9, 4, 8, 10],
					},
					{
						type: "quad",
						verts: [4, 1, 6, 8],
					},
					{
						type: "quad",
						verts: [8, 6, 2, 5],
					},
					{
						type: "quad",
						verts: [7, 10, 11, 3],
					},
					{
						type: "quad",
						verts: [10, 8, 5, 11],
					},
				] as MeshArtObject["faces"],
			};
		}

		function initMesh(mesh: MeshArtObject): void {
			ctx.getCurrentLayerId.mockReturnValue("layer-1");
			tool.initWithSelectedPaths(
				[],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
				[mesh],
			);
		}

		/** Collect hitIds of cage handle proxies from the latest handles overlay. */
		function getMeshHandleHitIds(): string[] {
			const overlay = lastOverlayCall(ctx, HANDLES_KEY);
			if (!overlay) return [];
			return overlay.primitives
				.map((prim) => ("hitId" in prim ? prim.hitId : undefined))
				.filter(
					(id): id is string =>
						typeof id === "string" &&
						(id.startsWith("meshv:") || id.startsWith("meshcp:")),
				);
		}

		it("should show cage vertex handles when a mesh selection is carried over", () => {
			initMesh(makeMesh());

			const hitIds = getMeshHandleHitIds();
			expect(hitIds).toContain("meshv:mesh-1:0");
			expect(hitIds).toContain("meshv:mesh-1:2");
		});

		it("should preview a vertex drag and commit once on pointer-up without touching src", () => {
			initMesh(makeMesh());

			// Vertex 2 sits at world(100,100) -> screen(500,200).
			tool.onPointerDown(
				ev(500, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(540, 150),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(540, 150),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.previewDeformation.mock.calls.length).toBeGreaterThan(0);
			expect(ctx.applyDeformation).toHaveBeenCalledTimes(1);
			const [update] = ctx.applyDeformation.mock.calls[0][0];
			expect(update.elementId).toBe("mesh-1");
			const vertices = (update.updates as MeshArtObject).vertices;
			// screen(540,150) -> world(140,150)
			expect(vertices[2].x).toBeCloseTo(140, 6);
			expect(vertices[2].y).toBeCloseTo(150, 6);
			// The source parametrization must survive every cage edit.
			expect(vertices[2].src).toEqual({ x: 100, y: 100 });
		});

		it("should subdivide a face on double-click with new src on the source grid", () => {
			initMesh(makeMesh());

			// world(25,50) -> screen(425,250), inside the single quad face.
			tool.onDoubleClick(
				ev(425, 250),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.applyDeformation).toHaveBeenCalledTimes(1);
			const [update] = ctx.applyDeformation.mock.calls[0][0];
			const updated = update.updates as MeshArtObject;
			expect(updated.faces).toHaveLength(4);
			const newSrcs = updated.vertices
				.slice(4)
				.map((v) => `${v.src.x},${v.src.y}`)
				.sort();
			expect(newSrcs).toEqual(
				["25,0", "25,100", "100,50", "0,50", "25,50"].sort(),
			);
		});

		it("should promote a derived vertex to explicit on double-click without changing shape", () => {
			const base = makeMesh();
			const subdivided = subdivideWarpFace(
				base.vertices,
				base.faces,
				0,
				0.5,
				0.5,
			);
			expect(subdivided).not.toBeNull();
			if (!subdivided) return;
			const mesh: MeshArtObject = {
				...base,
				vertices: subdivided.vertices,
				faces: subdivided.faces,
			};
			const derivedIdx = mesh.vertices.findIndex(
				(v) => v.positionSource != null,
			);
			expect(derivedIdx).toBeGreaterThanOrEqual(0);
			initMesh(mesh);

			// Every derived vertex of the (0.5, 0.5) split sits on a cage edge or the
			// centre; double-click the one we found via its screen position.
			const vertex = mesh.vertices[derivedIdx];
			tool.onDoubleClick(
				ev(400 + vertex.x, 300 - vertex.y),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.applyDeformation).toHaveBeenCalledTimes(1);
			const [update] = ctx.applyDeformation.mock.calls[0][0];
			const updated = update.updates as MeshArtObject;
			// Promotion, not a face subdivision.
			expect(updated.faces).toBeUndefined();
			expect(updated.vertices[derivedIdx].positionSource).toBeUndefined();
			expect(updated.vertices[derivedIdx].meshSource).toBeUndefined();
			// Position is unchanged — only the derived linkage is removed.
			expect(updated.vertices[derivedIdx].x).toBeCloseTo(vertex.x, 6);
			expect(updated.vertices[derivedIdx].y).toBeCloseTo(vertex.y, 6);
		});

		it("should not move a cage vertex on a click with pointer jitter", () => {
			initMesh(makeMesh());

			// Press on vertex 2 (screen 500,200) and release after 1px of jitter.
			tool.onPointerDown(
				ev(500, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(501, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(501, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.previewDeformation).not.toHaveBeenCalled();
			expect(ctx.applyDeformation).not.toHaveBeenCalled();
		});

		it("should keep the grab offset instead of snapping the vertex to the cursor", () => {
			initMesh(makeMesh());

			// Grab 5px to the right of vertex 2 (still within the hit tolerance):
			// screen(505,200) -> world(105,100). Drag 20px right.
			tool.onPointerDown(
				ev(505, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(525, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(525, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.applyDeformation).toHaveBeenCalledTimes(1);
			const [update] = ctx.applyDeformation.mock.calls[0][0];
			const vertices = (update.updates as MeshArtObject).vertices;
			// Moved by the pointer delta (+20), not onto the cursor (125).
			expect(vertices[2].x).toBeCloseTo(120, 6);
			expect(vertices[2].y).toBeCloseTo(100, 6);
		});

		it("should insert a vertex on an edge when double-clicking near it", () => {
			initMesh(makeMesh());

			// world(40,2) -> screen(440,298): 2px from the bottom edge (y=0),
			// far from every vertex and well inside the 8px edge tolerance.
			tool.onDoubleClick(
				ev(440, 298),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.applyDeformation).toHaveBeenCalledTimes(1);
			const [update] = ctx.applyDeformation.mock.calls[0][0];
			const updated = update.updates as MeshArtObject;
			// A single cut line: two faces, no explicit face-center vertex.
			expect(updated.faces).toHaveLength(2);
			expect(updated.vertices).toHaveLength(6);
			// The new vertex sits on the clicked edge at the click parameter and
			// is the user's own: explicit, holding that position.
			const onEdge = updated.vertices.find(
				(v, i) => i >= 4 && Math.abs(v.y) < 1e-6,
			);
			expect(onEdge).toBeDefined();
			if (!onEdge) return;
			expect(onEdge.positionSource).toBeUndefined();
			// findClosestCurveT projects by sampling, so allow sub-pixel slack.
			expect(onEdge.x).toBeCloseTo(40, 1);
			// Identity cage: the source position matches the inserted position.
			expect(onEdge.src.x).toBeCloseTo(onEdge.x, 6);
			expect(onEdge.src.y).toBeCloseTo(0, 6);
			// The vertex the cut left on the far side still rides its edge.
			const opposite = updated.vertices.find(
				(v, i) => i >= 4 && Math.abs(v.y - 100) < 1e-6,
			);
			expect(opposite?.positionSource).toBeDefined();
		});

		it("should keep a bent cage's shape when inserting on one of its edges", () => {
			const base = makeMesh();
			// Bow the bottom edge downwards and pull a corner out.
			base.vertices[0].handles[1] = { x: 30, y: -25 };
			base.vertices[1].handles[0] = { x: 70, y: -25 };
			base.vertices[2] = { ...base.vertices[2], x: 130, y: 120 };
			initMesh(base);
			const warpBefore = createMeshWarpSampler(base.vertices, base.faces);

			// world(40,-22) -> screen(440,322): right on the bowed bottom edge.
			tool.onDoubleClick(
				ev(440, 322),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.applyDeformation).toHaveBeenCalledTimes(1);
			const [update] = ctx.applyDeformation.mock.calls[0][0];
			const updated = update.updates as MeshArtObject;
			const warpAfter = createMeshWarpSampler(updated.vertices, updated.faces);
			// The cage still maps every source point where it did before.
			for (let x = 0; x <= 100; x += 20) {
				for (let y = 0; y <= 100; y += 20) {
					const a = warpBefore({ x, y });
					const b = warpAfter({ x, y });
					expect(b.x).toBeCloseTo(a.x, 6);
					expect(b.y).toBeCloseTo(a.y, 6);
				}
			}
		});

		it("should run a new cut straight across when double-clicking a root edge of a cut cage", () => {
			const base = makeMesh();
			const grid = subdivideWarpFace(base.vertices, base.faces, 0, 0.5, 0.5);
			expect(grid).not.toBeNull();
			if (!grid) return;
			initMesh({ ...base, vertices: grid.vertices, faces: grid.faces });

			// world(25,2) -> screen(425,298): 2px above the bottom root edge, on
			// the half left of the existing cut at x=50.
			tool.onDoubleClick(
				ev(425, 298),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.applyDeformation).toHaveBeenCalledTimes(1);
			const [update] = ctx.applyDeformation.mock.calls[0][0];
			const updated = update.updates as MeshArtObject;
			// A cut line the full height of the cage: three new vertices, six faces.
			expect(updated.vertices).toHaveLength(grid.vertices.length + 3);
			expect(updated.faces).toHaveLength(6);
			for (const face of updated.faces) expect(face.type).toBe("quad");

			const inserted = updated.vertices.findIndex(
				(v) => Math.abs(v.y) < 1e-6 && Math.abs(v.x - 25) < 1,
			);
			expect(inserted).toBeGreaterThanOrEqual(0);
			const above = updated.vertices.findIndex(
				(v) => Math.abs(v.x - 25) < 1 && Math.abs(v.y - 50) < 1e-6,
			);
			expect(above).toBeGreaterThanOrEqual(0);
			// It joins the bottom edge's corner, the existing cut vertex at x=50
			// and the new one directly above it — nothing across the cage.
			expect([...getVertexNeighbors(updated.faces, inserted)].sort()).toEqual(
				[0, 4, above].sort(),
			);
		});

		it("should insert on the clicked spot of every root edge of a cut cage", () => {
			// world(x,y) -> screen(400+x, 300-y). Each case clicks 2px inside the
			// named root edge, a quarter of the way along it.
			const cases = [
				{ edge: "bottom", screen: { x: 425, y: 298 }, at: { x: 25, y: 0 } },
				{ edge: "top", screen: { x: 425, y: 202 }, at: { x: 25, y: 100 } },
				{ edge: "left", screen: { x: 402, y: 275 }, at: { x: 0, y: 25 } },
				{ edge: "right", screen: { x: 498, y: 275 }, at: { x: 100, y: 25 } },
			];

			for (const { edge, screen, at } of cases) {
				const base = makeMesh();
				const grid = subdivideWarpFace(base.vertices, base.faces, 0, 0.5, 0.5);
				expect(grid).not.toBeNull();
				if (!grid) return;
				ctx.applyDeformation.mockClear();
				tool = new PathEditTool(ctx);
				initMesh({ ...base, vertices: grid.vertices, faces: grid.faces });

				tool.onDoubleClick(
					ev(screen.x, screen.y),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);

				expect(ctx.applyDeformation, edge).toHaveBeenCalledTimes(1);
				const [update] = ctx.applyDeformation.mock.calls[0][0];
				const updated = update.updates as MeshArtObject;
				const added = updated.vertices.slice(grid.vertices.length);
				// The vertex lands where it was clicked, not mirrored along the edge.
				const inserted = added.find((v) =>
					Math.abs(v.x - at.x) < 1e-6 || Math.abs(v.y - at.y) < 1e-6
						? Math.hypot(v.x - at.x, v.y - at.y) < 2
						: false,
				);
				expect(
					inserted,
					`${edge}: ${JSON.stringify(added.map((v) => v.src))}`,
				).toBeDefined();
			}
		});

		it("should translate a derived vertex's handles while sliding it along its edge", () => {
			const base = makeMesh();
			const subdivided = subdivideWarpFace(
				base.vertices,
				base.faces,
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
			// Cross-edge handle owned by the derived vertex at (50,0).
			subdivided.vertices[derivedIdx].handles = { 99: { x: 55, y: 15 } };
			initMesh({
				...base,
				vertices: subdivided.vertices,
				faces: subdivided.faces,
			});

			// Drag the derived vertex from world(50,0) to world(70,0) along the
			// bottom edge: screen(450,300) -> screen(470,300).
			tool.onPointerDown(
				ev(450, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(470, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(470, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.applyDeformation).toHaveBeenCalledTimes(1);
			const [update] = ctx.applyDeformation.mock.calls[0][0];
			const vertices = (update.updates as MeshArtObject).vertices;
			// findClosestCurveT projects by sampling, so allow sub-pixel slack.
			expect(vertices[derivedIdx].x).toBeCloseTo(70, 1);
			expect(vertices[derivedIdx].y).toBeCloseTo(0, 6);
			// The handle followed the slide, keeping its (+5, +15) offset.
			expect(
				vertices[derivedIdx].handles[99].x - vertices[derivedIdx].x,
			).toBeCloseTo(5, 6);
			expect(vertices[derivedIdx].handles[99].y).toBeCloseTo(15, 6);
		});

		it("should keep an explicit vertex's handles on their neighbors on Alt+drag", () => {
			initMesh(makeMesh());

			// Alt+drag corner vertex 2 (world(100,100) -> screen(500,200)).
			tool.onPointerDown(
				ev(500, 200, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// First move gets the pointer clear of the vertex (world(160,100)).
			tool.onPointerMove(
				ev(560, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Second move: 80px out from the vertex, still at angle 0.
			tool.onPointerMove(
				ev(580, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(580, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.applyDeformation).toHaveBeenCalledTimes(1);
			const [update] = ctx.applyDeformation.mock.calls[0][0];
			const vertices = (update.updates as MeshArtObject).vertices;
			// The vertex itself never moves during a fan drag.
			expect(vertices[2].x).toBeCloseTo(100, 6);
			expect(vertices[2].y).toBeCloseTo(100, 6);
			// Each handle keeps its own neighbor's direction and takes the
			// pointer's distance (80). The fan turns only by how far the pointer
			// swung from where it first cleared the vertex — here, not at all.
			expect(vertices[2].handles[1].x).toBeCloseTo(100, 6);
			expect(vertices[2].handles[1].y).toBeCloseTo(20, 6);
			expect(vertices[2].handles[3].x).toBeCloseTo(20, 6);
			expect(vertices[2].handles[3].y).toBeCloseTo(100, 6);
		});

		it("should line a derived vertex's handles up with the pointer on Alt+drag", () => {
			const base = makeMesh();
			const subdivided = subdivideWarpFace(
				base.vertices,
				base.faces,
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
			const before = { ...subdivided.vertices[derivedIdx].handles };
			initMesh({
				...base,
				vertices: subdivided.vertices,
				faces: subdivided.faces,
			});

			// Alt+drag diagonally from the derived vertex at world(50,0) =
			// screen(450,300). Its cross-edge handle starts straight up, so a 45°
			// pointer tells the two rules apart: turning the fan by how far the
			// pointer swung would leave the handle upright.
			const diag = 80 * Math.SQRT1_2;
			tool.onPointerDown(
				ev(450, 300, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// First move gets the pointer clear of the vertex, already at 45°.
			tool.onPointerMove(
				ev(460, 290),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Second move: 80 out from the vertex, still at 45°.
			tool.onPointerMove(
				ev(450 + diag, 300 - diag),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(450 + diag, 300 - diag),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.applyDeformation).toHaveBeenCalledTimes(1);
			const [update] = ctx.applyDeformation.mock.calls[0][0];
			const after = (update.updates as MeshArtObject).vertices[derivedIdx]
				.handles;
			const rebuilt = Object.entries(after).filter(
				([slot, handle]) =>
					before[Number(slot)]?.x !== handle.x ||
					before[Number(slot)]?.y !== handle.y,
			);
			// The handles running along the edge are owned by its root curve; the
			// fan rebuilds the ones that leave the edge.
			expect(rebuilt.length).toBeGreaterThanOrEqual(1);
			for (const [, handle] of rebuilt) {
				expect(handle.x).toBeCloseTo(50 + diag, 6);
				expect(Math.abs(handle.y)).toBeCloseTo(diag, 6);
			}
		});

		it("should drag every Shift+clicked cage vertex by one shared delta", () => {
			initMesh(makeMesh());

			// Select vertex 0 (world(0,0) -> screen(400,300)), then add vertex 2
			// (world(100,100) -> screen(500,200)) with Shift.
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerDown(
				ev(500, 200, { shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 200, { shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Drag vertex 2 by (+30, 0) in world: screen(500,200) -> (530,200).
			tool.onPointerDown(
				ev(500, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(530, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(530, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.applyDeformation).toHaveBeenCalledTimes(1);
			const [update] = ctx.applyDeformation.mock.calls[0][0];
			const vertices = (update.updates as MeshArtObject).vertices;
			// Both selected vertices moved by the same delta; the rest stayed.
			expect(vertices[2].x).toBeCloseTo(130, 6);
			expect(vertices[2].y).toBeCloseTo(100, 6);
			expect(vertices[0].x).toBeCloseTo(30, 6);
			expect(vertices[0].y).toBeCloseTo(0, 6);
			expect(vertices[1].x).toBeCloseTo(100, 6);
			expect(vertices[3].x).toBeCloseTo(0, 6);
		});

		it("should select the cage vertices inside a marquee", () => {
			ctx.pathEditGetSelectionMode.mockReturnValue("rectangle");
			initMesh(makeMesh());

			// Marquee over the right half of the cage: world(50,-10)-(150,110)
			// -> screen(450,310) to (550,190). Catches vertices 1 and 2.
			tool.onPointerDown(
				ev(450, 310),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(550, 190),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(550, 190),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Dragging one of them moves the other: screen(500,200) -> (500,180)
			// is world(100,100) -> (100,120).
			tool.onPointerDown(
				ev(500, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(500, 180),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 180),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.applyDeformation).toHaveBeenCalledTimes(1);
			const [update] = ctx.applyDeformation.mock.calls[0][0];
			const vertices = (update.updates as MeshArtObject).vertices;
			expect(vertices[1].y).toBeCloseTo(20, 6);
			expect(vertices[2].y).toBeCloseTo(120, 6);
			expect(vertices[0].y).toBeCloseTo(0, 6);
			expect(vertices[3].y).toBeCloseTo(100, 6);
		});

		it("should select and move an image object clicked in the vertex tool", () => {
			const image: ImageObject = {
				id: "image-1",
				type: "image",
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
				fileUid: "file-1",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
			};
			const imageBounds = brandWorldBBox({
				minX: -50,
				minY: -50,
				maxX: 50,
				maxY: 50,
				width: 100,
				height: 100,
			});
			ctx.getCurrentLayerId.mockReturnValue("layer-1");
			ctx.findElementAtPoint.mockReturnValue(image);
			ctx.getBounds.mockReturnValue(imageBounds);
			ctx.getElement.mockReturnValue(image);

			// Click the image at world(0,0) -> screen(400,300), then drag by
			// (+40, +20) in world: screen(440,280).
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			expect(ctx.elementSelect).toHaveBeenCalledWith("image-1", imageBounds);

			tool.onPointerMove(
				ev(440, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			const preview = ctx.previewDeformation.mock.calls.at(-1)?.[0][0];
			expect(preview?.elementId).toBe("image-1");
			expect(preview?.updates.transform).toMatchObject({ x: 40, y: 20 });

			tool.onPointerUp(
				ev(440, 280),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			expect(ctx.clearDeformationPreview).toHaveBeenCalledWith(["image-1"]);
			expect(ctx.elementsMove).toHaveBeenCalledWith(["image-1"], 40, 20);
		});

		it("should return a promoted cage vertex to derived on Delete", () => {
			const base = makeMesh();
			const cut = subdivideWarpFace(base.vertices, base.faces, 0, 0.4, 0, {
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
			initMesh({ ...base, vertices: promoted, faces: cut.faces });

			// Select the promoted vertex at world(40,0) -> screen(440,300).
			tool.onPointerDown(
				ev(440, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(440, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const handled = tool.onKeyDown(
				new KeyboardEvent("keydown", { code: "Delete" }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(handled).toBe(true);
			expect(ctx.applyDeformation).toHaveBeenCalledTimes(1);
			const [update] = ctx.applyDeformation.mock.calls[0][0];
			const vertices = (update.updates as MeshArtObject).vertices;
			// The vertex stays on the cage, bound to the bottom edge again.
			expect(vertices).toHaveLength(promoted.length);
			expect(vertices[cut.centerIdx].positionSource?.edgeVerts).toEqual([0, 1]);
			expect(vertices[cut.centerIdx].y).toBeCloseTo(0, 6);
		});

		it("should not stir the cage when a second vertex joins the same root edge", () => {
			let mesh = makeEditedCage();
			initMesh(mesh);

			// Two double-clicks on the bottom root edge, at 30% and 60% along it.
			for (const t of [0.3, 0.6]) {
				const curve = getEffectiveMeshEdgeCurve(
					mesh.vertices,
					mesh.faces,
					0,
					1,
				);
				const at = cubicBez(curve[0], curve[1], curve[2], curve[3], t);
				const before = mesh.vertices.map((v) => ({ ...v }));
				ctx.applyDeformation.mockClear();
				tool.onDoubleClick(
					ev(400 + at.x, 300 - at.y),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);

				expect(ctx.applyDeformation, `insert at ${t}`).toHaveBeenCalledTimes(1);
				const [update] = ctx.applyDeformation.mock.calls[0][0];
				mesh = { ...mesh, ...(update.updates as MeshArtObject) };
				// Every vertex that was already there keeps its place. The cage
				// is stored to two decimals, so settling it moves things by that
				// much and no more.
				for (let vi = 0; vi < before.length; vi++) {
					expect(
						mesh.vertices[vi].x,
						`insert at ${t}, vertex ${vi}`,
					).toBeCloseTo(before[vi].x, 2);
					expect(
						mesh.vertices[vi].y,
						`insert at ${t}, vertex ${vi}`,
					).toBeCloseTo(before[vi].y, 2);
				}
			}
		});

		it("should refuse deleting one of the four protected corner vertices", () => {
			initMesh(makeMesh());

			// Click vertex 0 (world(0,0) -> screen(400,300)) to select it.
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const handled = tool.onKeyDown(
				new KeyboardEvent("keydown", { code: "Delete" }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(handled).toBe(false);
			expect(ctx.applyDeformation).not.toHaveBeenCalled();
		});

		describe("inserting on every cage edge", () => {
			it("should keep a quad grid over an axis-aligned source grid", () => {
				for (const cage of casesToInsertOn()) {
					for (const edge of edgesOf(cage)) {
						const updated = insertOnEdge(cage, edge);
						expect(updated, edge.label).toBeDefined();
						if (!updated) continue;
						expect(cageProblems(updated), edge.label).toEqual([]);
					}
				}
			});

			it("should leave the cage's outline untouched", () => {
				for (const cage of casesToInsertOn()) {
					const warpBefore = createMeshWarpSampler(cage.vertices, cage.faces);
					for (const edge of edgesOf(cage)) {
						const updated = insertOnEdge(cage, edge);
						if (!updated) continue;
						const warpAfter = createMeshWarpSampler(
							updated.vertices,
							updated.faces,
						);
						for (let t = 0; t <= 100; t += 10) {
							for (const p of [
								{ x: t, y: 0 },
								{ x: t, y: 100 },
								{ x: 0, y: t },
								{ x: 100, y: t },
							]) {
								const a = warpBefore(p);
								const b = warpAfter(p);
								expect(b.x, `${edge.label} (${p.x},${p.y})`).toBeCloseTo(
									a.x,
									6,
								);
								expect(b.y, `${edge.label} (${p.x},${p.y})`).toBeCloseTo(
									a.y,
									6,
								);
							}
						}
					}
				}
			});

			it("should move the interior no further than a straight cut line forces", () => {
				// A cut line is created straight (the implicit 1/3 handles), so
				// where the patch it splits was curved, the surface shifts by up to
				// this much. Everything else about the cage is preserved exactly.
				const CUT_INTERIOR_TOLERANCE = 2.4;
				let worst = 0;
				for (const cage of casesToInsertOn()) {
					const warpBefore = createMeshWarpSampler(cage.vertices, cage.faces);
					for (const edge of edgesOf(cage)) {
						const updated = insertOnEdge(cage, edge);
						if (!updated) continue;
						const warpAfter = createMeshWarpSampler(
							updated.vertices,
							updated.faces,
						);
						for (let x = 5; x < 100; x += 5) {
							for (let y = 5; y < 100; y += 5) {
								const a = warpBefore({ x, y });
								const b = warpAfter({ x, y });
								worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
							}
						}
					}
				}
				expect(worst).toBeLessThanOrEqual(CUT_INTERIOR_TOLERANCE);
			});

			it("should place the clicked vertex where it was clicked, as an explicit one", () => {
				for (const cage of casesToInsertOn()) {
					for (const edge of edgesOf(cage)) {
						const updated = insertOnEdge(cage, edge);
						if (!updated) continue;
						const added = updated.vertices.slice(cage.vertices.length);
						const placed = added.filter((v) => v.positionSource == null);
						// Exactly one vertex is the user's; the rest ride their edges.
						expect(placed, edge.label).toHaveLength(1);
						expect(
							Math.hypot(placed[0].x - edge.at.x, placed[0].y - edge.at.y),
							edge.label,
						).toBeLessThan(1);
					}
				}
			});

			it("should run the new cut clean across the cage in source space", () => {
				for (const cage of casesToInsertOn()) {
					for (const edge of edgesOf(cage)) {
						const updated = insertOnEdge(cage, edge);
						if (!updated) continue;
						const added = updated.vertices.slice(cage.vertices.length);
						// The cut is one straight source-space line: every vertex it
						// created shares the coordinate the line runs at.
						const sameX = added.every(
							(v) => Math.abs(v.src.x - added[0].src.x) < 1e-6,
						);
						const sameY = added.every(
							(v) => Math.abs(v.src.y - added[0].src.y) < 1e-6,
						);
						expect(
							sameX || sameY,
							`${edge.label}: ${JSON.stringify(added.map((v) => v.src))}`,
						).toBe(true);
					}
				}
			});

			it("should let the cut's derived vertices follow a corner while the clicked one stays", () => {
				for (const cage of casesToInsertOn()) {
					for (const edge of edgesOf(cage)) {
						const updated = insertOnEdge(cage, edge);
						if (!updated) continue;
						const added = updated.vertices.slice(cage.vertices.length);
						const placedIdx = updated.vertices.findIndex(
							(v, i) => i >= cage.vertices.length && v.positionSource == null,
						);
						const placedBefore = { ...updated.vertices[placedIdx] };
						const derivedBefore = added
							.filter((v) => v.positionSource != null)
							.map((v) => ({ ...v }));

						// Pull a corner out and settle the cage.
						updated.vertices[2] = {
							...updated.vertices[2],
							x: updated.vertices[2].x + 60,
							y: updated.vertices[2].y + 40,
						};
						syncDerivedVertices(updated.vertices, updated.faces);

						const placedAfter = updated.vertices[placedIdx];
						expect(placedAfter.x, edge.label).toBeCloseTo(placedBefore.x, 6);
						expect(placedAfter.y, edge.label).toBeCloseTo(placedBefore.y, 6);
						// Every derived vertex the cut created is bound to an edge, so
						// it must still sit on the curve that edge now traces.
						for (const vertex of updated.vertices) {
							const source = vertex.positionSource;
							if (!source) continue;
							const curve = getEffectiveMeshEdgeCurve(
								updated.vertices,
								updated.faces,
								source.edgeVerts[0],
								source.edgeVerts[1],
							);
							const onCurve = cubicBez(
								curve[0],
								curve[1],
								curve[2],
								curve[3],
								source.t,
							);
							expect(
								Math.hypot(vertex.x - onCurve.x, vertex.y - onCurve.y),
								edge.label,
							).toBeLessThan(1e-6);
						}
						// The corner move actually did something to them.
						expect(derivedBefore.length, edge.label).toBeGreaterThan(0);
					}
				}
			});

			/** A plain cage and a bent, already-cut one. */
			function casesToInsertOn(): MeshArtObject[] {
				const plain = makeMesh();

				const bentBase = makeMesh();
				bentBase.vertices[0].handles[1] = { x: 30, y: -25 };
				bentBase.vertices[1].handles[0] = { x: 70, y: -25 };
				bentBase.vertices[2] = { ...bentBase.vertices[2], x: 130, y: 120 };
				const grid = subdivideWarpFace(
					bentBase.vertices,
					bentBase.faces,
					0,
					0.5,
					0.5,
				);
				if (!grid) throw new Error("failed to build the cut cage");
				const bent = {
					...bentBase,
					vertices: grid.vertices,
					faces: grid.faces,
				};

				return [plain, bent];
			}

			/** Every distinct cage edge, with the world point at its middle. */
			function edgesOf(
				mesh: MeshArtObject,
			): Array<{ label: string; at: { x: number; y: number } }> {
				const edges: Array<{ label: string; at: { x: number; y: number } }> =
					[];
				const seen = new Set<string>();
				for (const face of mesh.faces) {
					for (let e = 0; e < face.verts.length; e++) {
						const i = face.verts[e];
						const j = face.verts[(e + 1) % face.verts.length];
						const key = [i, j].sort((a, b) => a - b).join(":");
						if (seen.has(key)) continue;
						seen.add(key);
						const curve = getEffectiveMeshEdgeCurve(
							mesh.vertices,
							mesh.faces,
							i,
							j,
						);
						edges.push({
							label: `${mesh.vertices.length}-vertex cage, edge ${i}->${j}`,
							at: cubicBez(curve[0], curve[1], curve[2], curve[3], 0.5),
						});
					}
				}
				return edges;
			}

			/** Double-click the middle of an edge and return the cage it produced. */
			function insertOnEdge(
				mesh: MeshArtObject,
				edge: { at: { x: number; y: number } },
			): MeshArtObject | undefined {
				ctx.applyDeformation.mockClear();
				tool = new PathEditTool(ctx);
				initMesh(structuredClone(mesh));
				// world(x,y) -> screen(400+x, 300-y) at testViewport.
				tool.onDoubleClick(
					ev(400 + edge.at.x, 300 - edge.at.y),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);
				if (ctx.applyDeformation.mock.calls.length !== 1) return undefined;
				const [update] = ctx.applyDeformation.mock.calls[0][0];
				return update.updates as MeshArtObject;
			}

			/** Everything the cage promises about itself, as a list of breakages. */
			function cageProblems(mesh: MeshArtObject): string[] {
				const problems: string[] = [];
				for (const face of mesh.faces) {
					if (face.type !== "quad") {
						problems.push(`face ${JSON.stringify(face.verts)} is not a quad`);
					}
					const xs = new Set(
						face.verts.map((vi) => Math.round(mesh.vertices[vi].src.x * 1e6)),
					);
					const ys = new Set(
						face.verts.map((vi) => Math.round(mesh.vertices[vi].src.y * 1e6)),
					);
					if (xs.size !== 2 || ys.size !== 2) {
						problems.push(
							`face ${JSON.stringify(face.verts)} is not a source-space rectangle`,
						);
					}
				}
				for (let vi = 0; vi < mesh.vertices.length; vi++) {
					for (const ni of getVertexNeighbors(mesh.faces, vi)) {
						const a = mesh.vertices[vi].src;
						const b = mesh.vertices[ni].src;
						if (Math.abs(a.x - b.x) > 1e-6 && Math.abs(a.y - b.y) > 1e-6) {
							problems.push(`${vi} and ${ni} join across the source grid`);
						}
					}
					const source = mesh.vertices[vi].positionSource;
					if (source && !mesh.vertices[source.edgeVerts[1]]) {
						problems.push(`${vi} is bound to a vertex that is gone`);
					}
				}
				return problems;
			}
		});
	});

	describe("cutting a path", () => {
		/** Closed triangle (0,0) -> (100,0) -> (0,100) -> back to (0,0). */
		function makeClosedTriangle(id: string): Path {
			const ends = [
				{ x: 100, y: 0 },
				{ x: 0, y: 100 },
				{ x: 0, y: 0 },
			];
			return {
				id,
				type: "path",
				opacity: 1,
				blendMode: "normal",
				segments: ends.map((end, i) => ({
					start: i === 0 ? { x: 0, y: 0 } : undefined,
					cp1: { x: 0, y: 0 },
					cp2: { x: 0, y: 0 },
					end,
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
					isMoved: i === 0,
					isClosed: i === ends.length - 1 ? true : undefined,
				})),
				transform: createIdentityTransform(),
			};
		}

		/** alt+shift-click at a screen point, the cut shortcut. */
		function cutClick(screenX: number, screenY: number) {
			tool.onPointerDown(
				ev(screenX, screenY, { altKey: true, shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
		}

		it("should split an open path into two elements when cutting inside a segment", () => {
			const path = makeStraightPath("path-1", [0, 100, 200]);
			ctx.getAllEditablePaths.mockReturnValue([
				{ path, ancestorTransform: null },
			]);

			// world(50,0) is the middle of the first segment
			cutClick(450, 300);

			expect(ctx.replacePathWithPaths).toHaveBeenCalledTimes(1);
			const [pathId, runs] = ctx.replacePathWithPaths.mock.calls[0];
			expect(pathId).toBe("path-1");
			expect(runs).toHaveLength(2);
			expect(runs[0].at(-1)?.end).toEqual({ x: 50, y: 0 });
			expect(runs[1][0].start).toEqual({ x: 50, y: 0 });
			expect(runs[1].at(-1)?.end).toEqual({ x: 200, y: 0 });
		});

		it("should split an open path into two elements when cutting at an anchor", () => {
			const path = makeStraightPath("path-1", [0, 100, 200]);
			ctx.getAllEditablePaths.mockReturnValue([
				{ path, ancestorTransform: null },
			]);

			// world(100,0) is the middle anchor
			cutClick(500, 300);

			expect(ctx.replacePathWithPaths).toHaveBeenCalledTimes(1);
			const [, runs] = ctx.replacePathWithPaths.mock.calls[0];
			expect(runs).toHaveLength(2);
			expect(runs[0].at(-1)?.end).toEqual({ x: 100, y: 0 });
			expect(runs[1][0].start).toEqual({ x: 100, y: 0 });
		});

		it("should leave a closed path as one open element ending where it was cut", () => {
			const path = makeClosedTriangle("path-c");
			ctx.getAllEditablePaths.mockReturnValue([
				{ path, ancestorTransform: null },
			]);

			// world(50,0) is the middle of the bottom edge
			cutClick(450, 300);

			expect(ctx.replacePathWithPaths).not.toHaveBeenCalled();
			expect(ctx.pathUpdate).toHaveBeenCalledTimes(1);
			const [pathId, segments] = ctx.pathUpdate.mock.calls[0];
			expect(pathId).toBe("path-c");
			expect(segments[0].start).toEqual({ x: 50, y: 0 });
			expect(segments.at(-1)?.end).toEqual({ x: 50, y: 0 });
			expect(segments.some((s: PathSegment) => s.isClosed)).toBe(false);
		});

		it("should not cut at the endpoint of an open path", () => {
			const path = makeStraightPath("path-1", [0, 100, 200]);
			ctx.getAllEditablePaths.mockReturnValue([
				{ path, ancestorTransform: null },
			]);

			// world(0,0) is the first anchor, with nothing before it to separate
			cutClick(400, 300);

			expect(ctx.replacePathWithPaths).not.toHaveBeenCalled();
			expect(ctx.pathUpdate).not.toHaveBeenCalled();
		});

		it("should cut on a plain click while cut mode is on, then leave the mode", () => {
			const path = makeStraightPath("path-1", [0, 100, 200]);
			ctx.getAllEditablePaths.mockReturnValue([
				{ path, ancestorTransform: null },
			]);
			ctx.pathEditGetCutMode.mockReturnValue(true);

			tool.onPointerDown(
				ev(450, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.replacePathWithPaths).toHaveBeenCalledTimes(1);
			expect(ctx.pathEditSetCutMode).toHaveBeenCalledWith(false);
		});

		it("should keep alt-click on an anchor building a tangent instead of cutting", () => {
			const path = makeStraightPath("path-1", [0, 100, 200]);
			ctx.getAllEditablePaths.mockReturnValue([
				{ path, ancestorTransform: null },
			]);
			ctx.getPathById.mockReturnValue(path);
			tool.initWithSelectedPaths(
				[path],
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			tool.onPointerDown(
				ev(500, 300, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.replacePathWithPaths).not.toHaveBeenCalled();
		});
	});
});
