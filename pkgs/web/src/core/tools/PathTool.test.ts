import { beforeEach, describe, expect, it, type vi } from "vitest";
import { createIdentityTransform } from "../document/factory";
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
	toolClick,
	toolDrag,
} from "../testUtils/pointerEvent";
import { PathTool } from "./PathTool";

const HANDLES_KEY = "path/handles";

describe("PathTool", () => {
	let tool: PathTool;
	let ctx: MockToolContext;

	beforeEach(() => {
		ctx = createMockToolContext({
			getCurrentLayerId: () => "layer-1",
		});

		tool = new PathTool(ctx);
	});

	it("creates draft path on second vertex and updates on subsequent vertices", () => {
		// First click: 1 anchor only — no draft path yet (single anchor produces no segment)
		toolClick(tool, 400, 300);
		expect(ctx.pathDraftCreate).toHaveBeenCalledTimes(0);
		expect(ctx.pathDraftUpdate).toHaveBeenCalledTimes(0);

		// Second click: 2 anchors → first segment → pathDraftCreate
		toolClick(tool, 420, 300);
		expect(ctx.pathDraftCreate).toHaveBeenCalledTimes(1);
		expect(ctx.pathDraftUpdate).toHaveBeenCalledTimes(0);

		const createdPath = (ctx.pathDraftCreate as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		expect(createdPath.segments).toHaveLength(1);

		// Third click: 3 anchors → 2 segments → pathDraftUpdate
		toolClick(tool, 440, 300);
		expect(ctx.pathDraftCreate).toHaveBeenCalledTimes(1);
		expect(ctx.pathDraftUpdate).toHaveBeenCalledTimes(1);
		expect(
			(ctx.pathDraftUpdate as ReturnType<typeof vi.fn>).mock.calls[0][1],
		).toBe(createdPath.id);
		expect(
			(ctx.pathDraftUpdate as ReturnType<typeof vi.fn>).mock.calls[0][2],
		).toHaveLength(2);
	});

	it("clears the preview at pointerup when the tail is positionally degenerate", () => {
		// Each vertex is placed by moving the cursor to the target and clicking
		// there, so at pointerup `currentMouseWorld` coincides with the just-placed
		// vertex — the case that used to emit a zero-length preview stroke.
		tool.onPointerMove(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		toolClick(tool, 400, 300);

		// Second vertex: hasDraftPath becomes true, so emitPreview takes the
		// tail-only branch.
		tool.onPointerMove(
			ev(420, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		toolClick(tool, 420, 300);
		expect(ctx.pathDraftCreate).toHaveBeenCalledTimes(1);

		const calls = (ctx.previewUpdate as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls.at(-1)?.[0]).toBeNull();
	});

	it("still shows the rubber-band tail while moving between vertices", () => {
		tool.onPointerMove(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		toolClick(tool, 400, 300);
		tool.onPointerMove(
			ev(420, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		toolClick(tool, 420, 300);

		// Cursor moves away from the last vertex → a real, non-degenerate tail.
		(ctx.previewUpdate as ReturnType<typeof vi.fn>).mockClear();
		tool.onPointerMove(
			ev(460, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const lastArg = (
			ctx.previewUpdate as ReturnType<typeof vi.fn>
		).mock.calls.at(-1)?.[0];
		expect(lastArg).not.toBeNull();
		expect(lastArg.segments).toHaveLength(1);
	});

	it("deletes draft path when backspace removes all committed vertices", () => {
		// 2 clicks → pathDraftCreate on second click
		toolClick(tool, 400, 300);
		toolClick(tool, 420, 300);

		const createdPath = (ctx.pathDraftCreate as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		const backspaceEvent = new KeyboardEvent("keydown", { key: "Backspace" });

		// Backspace: 2 anchors → 1 anchor → buildDraftSegments returns [] → early return
		// pathDraftUpdate is NOT called (no segment to write)
		tool.onKeyDown(
			backspaceEvent,
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		expect(ctx.pathDraftUpdate).toHaveBeenCalledTimes(0);
		expect(ctx.pathDraftDelete).toHaveBeenCalledTimes(0);

		// Backspace: 1 anchor → 0 anchors → pathDraftDelete
		tool.onKeyDown(
			backspaceEvent,
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		expect(ctx.pathDraftDelete).toHaveBeenCalledTimes(1);
		expect(
			(ctx.pathDraftDelete as ReturnType<typeof vi.fn>).mock.calls[0][1],
		).toBe(createdPath.id);
	});

	it("shows pending cp1 on a committed vertex and applies it to the next segment", () => {
		toolClick(tool, 400, 300);
		toolDrag(tool, 450, 300, 470, 300);

		ctx.uiSetOverlay.mockClear();
		tool.onPointerMove(
			ev(401, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const overlay = lastOverlayCall(ctx, HANDLES_KEY);
		expect(overlay).toBeDefined();
		expect(overlay).not.toBeNull();

		const pendingCp1 = getControlPoints(ctx, HANDLES_KEY).find(
			(handle) =>
				handle.type === "control" &&
				handle.pointType === "cp1" &&
				handle.segmentIndex === 1,
		);
		expect(pendingCp1).toBeDefined();
		expect(pendingCp1?.worldX).toBeCloseTo(70);
		expect(pendingCp1?.worldY).toBeCloseTo(0);

		tool.onPointerMove(
			ev(480, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		toolClick(tool, 480, 300);

		const latestDraftUpdateCall = (
			ctx.pathDraftUpdate as ReturnType<typeof vi.fn>
		).mock.calls.at(-1);
		expect(latestDraftUpdateCall).toBeDefined();
		const updatedSegments = latestDraftUpdateCall?.[2];
		expect(updatedSegments).toHaveLength(2);
		expect(updatedSegments?.[1].cp1.x).toBeCloseTo(20);
		expect(updatedSegments?.[1].cp1.y).toBeCloseTo(0);
	});

	it("preserves pending cp1 across syncFromDocument and applies it to the next segment", () => {
		// 1st click → 1 anchor; drag → 2 anchors → pathDraftCreate (no pathDraftUpdate yet)
		toolClick(tool, 400, 300);
		toolDrag(tool, 450, 300, 470, 300);

		const createdPathCall = (
			ctx.pathDraftCreate as ReturnType<typeof vi.fn>
		).mock.calls.at(-1);
		expect(createdPathCall).toBeDefined();

		const createdPath = createdPathCall?.[0];
		expect(createdPath).toBeDefined();
		if (!createdPath) throw new Error("Draft path was not created");

		// pathDraftUpdate has not been called yet at this point; pass createdPath directly
		tool.syncFromDocument(createdPath);
		tool.onPointerMove(
			ev(480, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		toolClick(tool, 480, 300);

		const newestDraftUpdateCall = (
			ctx.pathDraftUpdate as ReturnType<typeof vi.fn>
		).mock.calls.at(-1);
		expect(newestDraftUpdateCall).toBeDefined();
		const updatedSegments = newestDraftUpdateCall?.[2];
		expect(updatedSegments).toHaveLength(2);
		expect(updatedSegments?.[1].cp1.x).toBeCloseTo(20);
		expect(updatedSegments?.[1].cp1.y).toBeCloseTo(0);
	});

	it("restores the remaining last anchor's own handleOut after undo, not the undone anchor's", () => {
		// 1st click, 2nd drag -> 2 anchors -> pathDraftCreate (1 segment).
		// 2nd anchor: pos world(50,0), handleOut world(70,0)
		toolClick(tool, 400, 300);
		toolDrag(tool, 450, 300, 470, 300);

		const createdPath = (ctx.pathDraftCreate as ReturnType<typeof vi.fn>).mock
			.calls[0][0];

		// 3rd drag -> 3 anchors -> pathDraftUpdate (2 segments).
		// 3rd anchor: pos world(100,0), handleOut world(120,0)
		toolDrag(tool, 500, 300, 520, 300);
		expect(ctx.pathDraftUpdate).toHaveBeenCalledTimes(1);

		// Simulate Undo: the document reverts to the 2-anchor path created
		// on the 2nd vertex. The 2nd anchor (now last again) keeps its own
		// handleOut — which was only stored in the undone segment's cp1 —
		// and must not inherit the undone 3rd anchor's handleOut.
		tool.syncFromDocument(createdPath);

		const points = getControlPoints(ctx, HANDLES_KEY);
		const secondAnchorHandleOut = points.find(
			(p) =>
				p.type === "control" && p.pointType === "cp1" && p.segmentIndex === 1,
		);
		expect(secondAnchorHandleOut).toBeDefined();
		expect(secondAnchorHandleOut?.worldX).toBeCloseTo(70);
		expect(secondAnchorHandleOut?.worldY).toBeCloseTo(0);

		const secondAnchorHandleIn = points.find(
			(p) =>
				p.type === "control" && p.pointType === "cp2" && p.segmentIndex === 0,
		);
		expect(secondAnchorHandleIn).toBeDefined();
		expect(secondAnchorHandleIn?.worldX).toBeCloseTo(30);
		expect(secondAnchorHandleIn?.worldY).toBeCloseTo(0);
	});

	it("allows closing drag to define cp2 of the last segment", () => {
		toolClick(tool, 400, 300);
		toolClick(tool, 450, 300);

		tool.onPointerMove(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerDown(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(380, 320),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(
			ev(380, 320),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const latestDraftUpdateCall = (
			ctx.pathDraftUpdate as ReturnType<typeof vi.fn>
		).mock.calls.at(-1);
		expect(latestDraftUpdateCall).toBeDefined();
		const updatedSegments = latestDraftUpdateCall?.[2];
		expect(updatedSegments).toHaveLength(2);

		const closingSegment = updatedSegments?.[1];
		expect(closingSegment).toBeDefined();
		expect(closingSegment?.isClosed).toBe(true);
		// handleOut follows the drag, so handleIn (closing cp2) is the mirror of drag(-20,-20) = (20,20)
		expect(closingSegment?.cp2.x).toBeCloseTo(20);
		expect(closingSegment?.cp2.y).toBeCloseTo(20);
		// First segment cp1 = handleOut = drag position (-20,-20)
		expect(updatedSegments?.[0].cp1.x).toBeCloseTo(-20);
		expect(updatedSegments?.[0].cp1.y).toBeCloseTo(-20);
		expect(ctx.pathComplete).toHaveBeenCalledTimes(1);
	});

	describe("Path continuation", () => {
		const existingPath = {
			id: "existing-1",
			type: "path" as const,
			opacity: 1,
			blendMode: "normal" as const,
			transform: createIdentityTransform(),
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
		};

		function setupContinuation() {
			(ctx.getCurrentLayer as ReturnType<typeof vi.fn>).mockReturnValue({
				id: "layer-1",
				elementIds: ["existing-1"],
			});
			(ctx.getObjects as ReturnType<typeof vi.fn>).mockReturnValue({
				"existing-1": existingPath,
			});
		}

		it("continues from end point of existing path", () => {
			setupContinuation();
			// screen(500,300) → world(100,0) = end point of existingPath
			toolClick(tool, 500, 300);

			// Should use pathDraftUpdate (not pathDraftCreate) with existing path's id
			expect(ctx.pathDraftCreate).toHaveBeenCalledTimes(0);
			expect(ctx.pathDraftUpdate).toHaveBeenCalledTimes(1);
			const updateArgs = (ctx.pathDraftUpdate as ReturnType<typeof vi.fn>).mock
				.calls[0];
			expect(updateArgs[1]).toBe("existing-1");
		});

		it("continues from start point of existing path (reverses anchors)", () => {
			setupContinuation();
			// screen(400,300) → world(0,0) = start point of existingPath
			toolClick(tool, 400, 300);

			expect(ctx.pathDraftCreate).toHaveBeenCalledTimes(0);
			expect(ctx.pathDraftUpdate).toHaveBeenCalledTimes(1);
			const updateArgs = (ctx.pathDraftUpdate as ReturnType<typeof vi.fn>).mock
				.calls[0];
			expect(updateArgs[1]).toBe("existing-1");
		});

		it("shows pointer cursor when hovering over continuable endpoint", () => {
			setupContinuation();
			// Hover over end point
			tool.onPointerMove(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			expect(tool.getCursor()).toBe("pointer");
		});

		it("skips closed paths for continuation", () => {
			const closedPath = {
				...existingPath,
				id: "closed-1",
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
					{
						cp1: { x: 0, y: 0 },
						cp2: { x: 0, y: 0 },
						end: { x: 0, y: 0 },
						startTiltX: 0,
						startTiltY: 0,
						endTiltX: 0,
						endTiltY: 0,
						startDeltaTime: 0,
						endDeltaTime: 0,
						isMoved: false,
						isClosed: true,
					},
				],
			};
			(ctx.getCurrentLayer as ReturnType<typeof vi.fn>).mockReturnValue({
				id: "layer-1",
				elementIds: ["closed-1"],
			});
			(ctx.getObjects as ReturnType<typeof vi.fn>).mockReturnValue({
				"closed-1": closedPath,
			});

			// Click on start point of closed path → should create new path, not continue
			// Need 2 clicks to produce a segment (single-anchor produces no draft)
			toolClick(tool, 400, 300);
			toolClick(tool, 420, 300);
			expect(ctx.pathDraftCreate).toHaveBeenCalledTimes(1);
		});
	});

	describe("Vertex insertion on curve", () => {
		const straightPath = {
			id: "path-v1",
			type: "path" as const,
			opacity: 1,
			blendMode: "normal" as const,
			transform: createIdentityTransform(),
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
		};

		function setupVertexInsertion() {
			(ctx.getCurrentLayer as ReturnType<typeof vi.fn>).mockReturnValue({
				id: "layer-1",
				elementIds: ["path-v1"],
			});
			(ctx.getObjects as ReturnType<typeof vi.fn>).mockReturnValue({
				"path-v1": straightPath,
			});
		}

		it("inserts vertex on existing curve via pathUpdate", () => {
			setupVertexInsertion();
			// screen(450,300) → world(50,0) = midpoint of straight line (0,0)→(100,0)
			toolClick(tool, 450, 300);

			// Should call pathUpdate (not pathDraftCreate)
			expect(ctx.pathDraftCreate).toHaveBeenCalledTimes(0);
			expect(ctx.pathUpdate).toHaveBeenCalledTimes(1);
			const updateArgs = (ctx.pathUpdate as ReturnType<typeof vi.fn>).mock
				.calls[0];
			expect(updateArgs[0]).toBe("path-v1");
			// Original 1 segment → split into 2 segments
			expect(updateArgs[1]).toHaveLength(2);
		});

		it("preserves start and end points after split", () => {
			setupVertexInsertion();
			toolClick(tool, 450, 300);

			const newSegments = (ctx.pathUpdate as ReturnType<typeof vi.fn>).mock
				.calls[0][1];
			// First segment should start at (0,0)
			expect(newSegments[0].start.x).toBeCloseTo(0);
			expect(newSegments[0].start.y).toBeCloseTo(0);
			// Last segment should end at (100,0)
			expect(newSegments[1].end.x).toBeCloseTo(100);
			expect(newSegments[1].end.y).toBeCloseTo(0);
		});

		it("creates new path when clicking off any curve", () => {
			setupVertexInsertion();
			// screen(450,200) → world(50,100), screen(430,200) → world(30,100)
			// Both are far from the straight path (0,0)→(100,0), so no vertex insertion
			toolClick(tool, 450, 200);
			toolClick(tool, 430, 200);

			expect(ctx.pathUpdate).toHaveBeenCalledTimes(0);
			expect(ctx.pathDraftCreate).toHaveBeenCalledTimes(1);
		});

		it("sets symmetric relative handles on the inserted vertex during drag", () => {
			setupVertexInsertion();
			// Insert at midpoint world(50,0)=screen(450,300), then drag up to
			// world(50,20)=screen(450,280) to pull symmetric handles.
			toolDrag(tool, 450, 300, 450, 280);

			const segs = (ctx.pathUpdate as ReturnType<typeof vi.fn>).mock.calls.at(
				-1,
			)?.[1];
			expect(segs).toHaveLength(2);
			// cp1/cp2 are offsets relative to the inserted anchor (= ±delta),
			// NOT absolute positions. Regression: previously the anchor coordinate
			// leaked into these fields and blew the handles far off the curve.
			expect(segs[0].cp2.x).toBeCloseTo(0);
			expect(segs[0].cp2.y).toBeCloseTo(-20);
			expect(segs[1].cp1.x).toBeCloseTo(0);
			expect(segs[1].cp1.y).toBeCloseTo(20);
		});

		it("hit-tests against the visible curve of a moved (transformed) path", () => {
			const movedPath = {
				...straightPath,
				id: "path-moved",
				transform: { ...createIdentityTransform(), x: 200 },
			};
			(ctx.getCurrentLayer as ReturnType<typeof vi.fn>).mockReturnValue({
				id: "layer-1",
				elementIds: ["path-moved"],
			});
			(ctx.getObjects as ReturnType<typeof vi.fn>).mockReturnValue({
				"path-moved": movedPath,
			});

			// Local curve (0,0)→(100,0) is offset by transform.x=200, so the visible
			// curve spans world (200,0)→(300,0). Its midpoint is world(250,0)=screen(650,300).
			toolClick(tool, 650, 300);
			expect(ctx.pathUpdate).toHaveBeenCalledTimes(1);
			expect(ctx.pathDraftCreate).toHaveBeenCalledTimes(0);

			// The pre-transform local midpoint world(50,0)=screen(450,300) is NOT on
			// the visible curve and must not be treated as an edge hit.
			(ctx.pathUpdate as ReturnType<typeof vi.fn>).mockClear();
			toolClick(tool, 450, 300);
			expect(ctx.pathUpdate).toHaveBeenCalledTimes(0);
		});
	});

	describe("Path continuation - append vertex deduplication", () => {
		const existingPath = {
			id: "existing-1",
			type: "path" as const,
			opacity: 1,
			blendMode: "normal" as const,
			transform: createIdentityTransform(),
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
		};

		function setupContinuation() {
			(ctx.getCurrentLayer as ReturnType<typeof vi.fn>).mockReturnValue({
				id: "layer-1",
				elementIds: ["existing-1"],
			});
			(ctx.getObjects as ReturnType<typeof vi.fn>).mockReturnValue({
				"existing-1": existingPath,
			});
		}

		it("does not duplicate the endpoint when appending with click only", () => {
			setupContinuation();
			// Click on end point: screen(500,300) → world(100,0)
			toolClick(tool, 500, 300);

			const updateArgs = (ctx.pathDraftUpdate as ReturnType<typeof vi.fn>).mock
				.calls[0];
			// Original path has 1 segment (2 anchors).
			// Append click should NOT add a duplicate anchor, so still 1 segment.
			expect(updateArgs[2]).toHaveLength(1);
		});

		it("does not duplicate the endpoint when appending with drag", () => {
			setupContinuation();
			// Drag from end point to set handle
			toolDrag(tool, 500, 300, 520, 280);

			const updateArgs = (ctx.pathDraftUpdate as ReturnType<typeof vi.fn>).mock
				.calls[0];
			// Still 1 segment (append drag only sets handleOut on last anchor)
			expect(updateArgs[2]).toHaveLength(1);

			// The last anchor should have a handleOut from the drag
			// Next click adds a real new vertex → 2 segments
			toolClick(tool, 550, 300);
			const secondUpdate = (
				ctx.pathDraftUpdate as ReturnType<typeof vi.fn>
			).mock.calls.at(-1);
			expect(secondUpdate?.[2]).toHaveLength(2);
		});
	});

	describe("Closing drag - symmetric CP adjustment", () => {
		it("sets both cp1 and cp2 on the closing segment when dragging to close", () => {
			// Create 3 vertices so closing segment is meaningful
			toolClick(tool, 400, 300); // world(0,0)
			toolClick(tool, 500, 300); // world(100,0)
			toolClick(tool, 450, 200); // world(50,100)

			// Move near first vertex to trigger isNearFirstVertex
			tool.onPointerMove(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Closing drag: down on first vertex, drag to define handles
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(380, 320),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(380, 320),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const updateArgs = (
				ctx.pathDraftUpdate as ReturnType<typeof vi.fn>
			).mock.calls.at(-1);
			expect(updateArgs).toBeDefined();
			const segments = updateArgs?.[2];
			expect(segments).toHaveLength(3);

			// First segment (anchor[0] → anchor[1]):
			// cp1 = anchor[0].handleOut offset = drag position (-20, -20)
			const firstSeg = segments?.[0];
			expect(firstSeg?.cp1.x).toBeCloseTo(-20);
			expect(firstSeg?.cp1.y).toBeCloseTo(-20);

			// Closing segment (anchor[2] → anchor[0]):
			const closingSeg = segments?.[2];
			expect(closingSeg?.isClosed).toBe(true);

			// cp2 = anchors[0].handleIn offset = mirrorHandle((0,0),(-20,-20)) = (20, 20)
			expect(closingSeg?.cp2.x).toBeCloseTo(20);
			expect(closingSeg?.cp2.y).toBeCloseTo(20);

			// cp1 = anchors[2].handleOut offset (click-only → null → (0,0))
			expect(closingSeg?.cp1.x).toBeCloseTo(0);
			expect(closingSeg?.cp1.y).toBeCloseTo(0);
		});

		it("updates draft first segment cp1 symmetrically during closing drag", () => {
			// 3 vertices: A(0,0), B(100,0), C(50,100)
			toolClick(tool, 400, 300);
			toolClick(tool, 500, 300);
			toolClick(tool, 450, 200);

			tool.onPointerMove(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			(ctx.previewUpdate as ReturnType<typeof vi.fn>).mockClear();
			(ctx.pathDraftUpdate as ReturnType<typeof vi.fn>).mockClear();

			// Drag: screen(380,320) → world(-20,-20)
			tool.onPointerMove(
				ev(380, 320),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// No infinite loop: each callback called at most once per onPointerMove
			expect(
				(ctx.previewUpdate as ReturnType<typeof vi.fn>).mock.calls.length,
			).toBeLessThanOrEqual(1);
			expect(
				(ctx.pathDraftUpdate as ReturnType<typeof vi.fn>).mock.calls.length,
			).toBeLessThanOrEqual(1);

			// Draft path updated with symmetric cp1 on first segment
			const draftCall = (
				ctx.pathDraftUpdate as ReturnType<typeof vi.fn>
			).mock.calls.at(-1);
			expect(draftCall).toBeDefined();
			const draftSegments = draftCall?.[2];
			expect(draftSegments).toHaveLength(2);

			// seg[0].cp1 = firstAnchor.handleOut offset = drag position (-20, -20)
			expect(draftSegments[0].cp1.x).toBeCloseTo(-20);
			expect(draftSegments[0].cp1.y).toBeCloseTo(-20);
		});
	});

	it("shows cp2-to-anchor line for closing segment during closing drag", () => {
		// 3 vertices: A(0,0), B(100,0), C(50,100)
		toolClick(tool, 400, 300);
		toolClick(tool, 500, 300);
		toolClick(tool, 450, 200);

		tool.onPointerMove(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerDown(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		ctx.uiSetOverlay.mockClear();
		tool.onPointerMove(
			ev(380, 320),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const cps = getControlPoints(ctx, HANDLES_KEY);

		// Closing segment index = 2 (3 anchors - 1)
		// cp2 at segmentIndex=2 must exist (firstAnchor.handleIn)
		const closingCp2 = cps.find(
			(h) =>
				h.type === "control" && h.pointType === "cp2" && h.segmentIndex === 2,
		);
		expect(closingCp2).toBeDefined();

		// For UILayer to draw the line from cp2 to anchor,
		// there must be an "end" anchor at segmentIndex=2
		const closingEnd = cps.find(
			(h) =>
				h.type === "anchor" && h.pointType === "end" && h.segmentIndex === 2,
		);
		expect(closingEnd).toBeDefined();
		// Closing segment end = firstAnchor position = world(0, 0)
		expect(closingEnd?.worldX).toBeCloseTo(0);
		expect(closingEnd?.worldY).toBeCloseTo(0);
	});

	it("shows firstAnchor cp1 and closing cp2 in controlPoints during closing drag", () => {
		// 3 vertices: A(0,0), B(100,0), C(50,100)
		toolClick(tool, 400, 300); // world(0,0)
		toolClick(tool, 500, 300); // world(100,0)
		toolClick(tool, 450, 200); // world(50,100)

		// Move near first vertex to trigger isNearFirstVertex
		tool.onPointerMove(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		// Start closing drag on first vertex
		tool.onPointerDown(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		// Clear mocks to capture only the closing drag move
		ctx.uiSetOverlay.mockClear();

		// Drag away from first vertex: screen(380,320) → world(-20,-20)
		tool.onPointerMove(
			ev(380, 320),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(lastOverlayCall(ctx, HANDLES_KEY)).toBeDefined();
		const cps = getControlPoints(ctx, HANDLES_KEY);

		// firstAnchor cp1 (handleOut) at segmentIndex=0
		// handleOut follows the drag = world(-20, -20)
		const firstCp1 = cps.find(
			(h) =>
				h.type === "control" && h.pointType === "cp1" && h.segmentIndex === 0,
		);
		expect(firstCp1).toBeDefined();
		expect(firstCp1?.worldX).toBeCloseTo(-20);
		expect(firstCp1?.worldY).toBeCloseTo(-20);

		// firstAnchor cp2 (handleIn) for closing segment at segmentIndex=2
		// handleIn = mirrorHandle((0,0), (-20,-20)) = (20, 20)
		const closingCp2 = cps.find(
			(h) =>
				h.type === "control" && h.pointType === "cp2" && h.segmentIndex === 2,
		);
		expect(closingCp2).toBeDefined();
		expect(closingCp2?.worldX).toBeCloseTo(20);
		expect(closingCp2?.worldY).toBeCloseTo(20);
	});

	it("completes open path without extra segment update", () => {
		// 2 anchors: pathDraftCreate on second click, no pathDraftUpdate yet
		toolClick(tool, 400, 300);
		toolClick(tool, 420, 300);

		const createdPath = (ctx.pathDraftCreate as ReturnType<typeof vi.fn>).mock
			.calls[0][0];
		const event = new KeyboardEvent("keydown", { key: "Enter" });
		tool.onKeyDown(event, testViewport, testCanvasWidth, testCanvasHeight);

		expect(ctx.pathComplete).toHaveBeenCalledTimes(1);
		expect(
			(ctx.pathComplete as ReturnType<typeof vi.fn>).mock.calls[0][0],
		).toBe(createdPath.id);
		// completePath(false) with hasDraftPath=true does not call pathDraftUpdate
		expect(ctx.pathDraftUpdate).toHaveBeenCalledTimes(0);
		expect(ctx.pathDraftDelete).toHaveBeenCalledTimes(0);
	});

	describe("Node editing of the selected path", () => {
		// Open path with 3 anchors: world (0,0)-(100,0)-(200,0).
		// Endpoints: world(0,0)/screen(400,300), world(200,0)/screen(600,300).
		// Interior vertex: world(100,0)/screen(500,300) = end of segment 0.
		const seg = (
			end: { x: number; y: number },
			start?: { x: number; y: number },
		) => ({
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
			isMoved: start !== undefined,
		});

		const selectedPath = {
			id: "sel-1",
			type: "path" as const,
			opacity: 1,
			blendMode: "normal" as const,
			transform: createIdentityTransform(),
			segments: [seg({ x: 100, y: 0 }, { x: 0, y: 0 }), seg({ x: 200, y: 0 })],
		};

		function setupSelectedPath() {
			(ctx.getSelectedElementIds as ReturnType<typeof vi.fn>).mockReturnValue([
				"sel-1",
			]);
			(ctx.getPathById as ReturnType<typeof vi.fn>).mockImplementation(
				(id: string) => (id === "sel-1" ? selectedPath : null),
			);
			(ctx.getViewport as ReturnType<typeof vi.fn>).mockReturnValue({
				viewport: testViewport,
				canvasWidth: testCanvasWidth,
				canvasHeight: testCanvasHeight,
			});
		}

		it("should delete an interior vertex when clicked", () => {
			setupSelectedPath();

			// Click the interior vertex (world 100,0 = screen 500,300), no drag
			toolClick(tool, 500, 300);

			expect(ctx.eraseElement).toHaveBeenCalledTimes(0);
			expect(ctx.pathUpdate).toHaveBeenCalledTimes(1);
			const [updatedId, updatedSegments] = (
				ctx.pathUpdate as ReturnType<typeof vi.fn>
			).mock.calls[0];
			expect(updatedId).toBe("sel-1");
			// 3 anchors -> 2 after delete -> 1 segment for an open path
			expect(updatedSegments).toHaveLength(1);
		});

		it("should continue drawing when an endpoint is clicked", () => {
			setupSelectedPath();
			// The path must be on the current layer for continuation to find it
			(ctx.getCurrentLayer as ReturnType<typeof vi.fn>).mockReturnValue({
				id: "layer-1",
				elementIds: ["sel-1"],
			});
			(ctx.getObjects as ReturnType<typeof vi.fn>).mockReturnValue({
				"sel-1": selectedPath,
			});

			// Click the end endpoint (world 200,0 = screen 600,300)
			toolClick(tool, 600, 300);

			// Endpoint click must NOT delete; it enters the continue-drawing flow
			expect(ctx.eraseElement).toHaveBeenCalledTimes(0);
			expect(ctx.pathUpdate).toHaveBeenCalledTimes(0);
			expect(ctx.pathDraftUpdate).toHaveBeenCalledTimes(1);
			expect(
				(ctx.pathDraftUpdate as ReturnType<typeof vi.fn>).mock.calls[0][1],
			).toBe("sel-1");
		});

		it("should pull out tangent handles on alt+drag of a vertex", () => {
			setupSelectedPath();

			// Alt+drag from the interior vertex (screen 500,300 = world 100,0)
			// to screen(500,250) = world(100,50): dx=0, dy=50
			tool.onPointerDown(
				ev(500, 300, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(500, 250, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 250, { altKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.pathUpdate).toHaveBeenCalledTimes(1);
			const [updatedId, segments] = (ctx.pathUpdate as ReturnType<typeof vi.fn>)
				.mock.calls[0];
			expect(updatedId).toBe("sel-1");
			// End anchor of segment 0: this.cp2 = -delta, next.cp1 = +delta
			expect(segments[0].cp2.x).toBeCloseTo(0);
			expect(segments[0].cp2.y).toBeCloseTo(-50);
			expect(segments[1].cp1.x).toBeCloseTo(0);
			expect(segments[1].cp1.y).toBeCloseTo(50);
		});

		it("plain drag from a vertex starts a new path", () => {
			setupSelectedPath();

			// Plain drag (no alt) from the interior vertex past the threshold.
			// A click would delete, but a drag starts a fresh path from this point.
			tool.onPointerDown(
				ev(500, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(540, 320),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(540, 320),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// No delete happened
			expect(ctx.eraseElement).toHaveBeenCalledTimes(0);
			expect(ctx.pathUpdate).toHaveBeenCalledTimes(0);

			// A new draft path was started from the vertex (not editing "sel-1")
			const activeId = tool.getActivePathId();
			expect(activeId).not.toBeNull();
			expect(activeId).not.toBe("sel-1");
		});

		it("shift+drag from an endpoint starts a new path instead of continuing", () => {
			setupSelectedPath();
			// Path must be on the current layer so continuation would otherwise find it
			(ctx.getCurrentLayer as ReturnType<typeof vi.fn>).mockReturnValue({
				id: "layer-1",
				elementIds: ["sel-1"],
			});
			(ctx.getObjects as ReturnType<typeof vi.fn>).mockReturnValue({
				"sel-1": selectedPath,
			});

			// Shift+drag from the end endpoint (world 200,0 = screen 600,300)
			tool.onPointerDown(
				ev(600, 300, { shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(640, 300, { shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(640, 300, { shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Continuation must NOT happen for the selected path
			const continuedSel1 = (
				ctx.pathDraftUpdate as ReturnType<typeof vi.fn>
			).mock.calls.some((call) => call[1] === "sel-1");
			expect(continuedSel1).toBe(false);

			// A new draft path was started from the endpoint (not "sel-1")
			const activeId = tool.getActivePathId();
			expect(activeId).not.toBeNull();
			expect(activeId).not.toBe("sel-1");
		});

		it("deletes the join point of a closed path", () => {
			// Closed path with 4 anchors so deletion keeps a valid (3-anchor) path.
			// Anchor 0 / join is at world(0,0) = screen(400,300).
			const closedPath = {
				id: "closed-1",
				type: "path" as const,
				opacity: 1,
				blendMode: "normal" as const,
				transform: createIdentityTransform(),
				segments: [
					seg({ x: 100, y: 0 }, { x: 0, y: 0 }),
					seg({ x: 100, y: 100 }),
					seg({ x: 0, y: 100 }),
					{ ...seg({ x: 0, y: 0 }), isClosed: true },
				],
			};

			(ctx.getSelectedElementIds as ReturnType<typeof vi.fn>).mockReturnValue([
				"closed-1",
			]);
			(ctx.getPathById as ReturnType<typeof vi.fn>).mockImplementation(
				(id: string) => (id === "closed-1" ? closedPath : null),
			);
			(ctx.getViewport as ReturnType<typeof vi.fn>).mockReturnValue({
				viewport: testViewport,
				canvasWidth: testCanvasWidth,
				canvasHeight: testCanvasHeight,
			});

			// Click the join / anchor-0 (world 0,0 = screen 400,300), no drag
			toolClick(tool, 400, 300);

			expect(ctx.eraseElement).toHaveBeenCalledTimes(0);
			expect(ctx.pathUpdate).toHaveBeenCalledTimes(1);
			const [updatedId, updatedSegments] = (
				ctx.pathUpdate as ReturnType<typeof vi.fn>
			).mock.calls[0];
			expect(updatedId).toBe("closed-1");
			// 4 anchors -> 3 after deleting the join; a closed path keeps 3 segments
			expect(updatedSegments).toHaveLength(3);
		});
	});
});
