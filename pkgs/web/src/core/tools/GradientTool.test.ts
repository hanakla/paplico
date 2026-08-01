import { beforeEach, describe, expect, it } from "vitest";
import { createIdentityTransform } from "../document/factory";
import type {
	AnyArtObject,
	BoundingBox,
	FillAppearance,
	FreeGradient,
	LinearGradient,
	MeshArtObject,
	MeshGeometryVertex,
	MeshGradient,
	RadialGradient,
} from "../schema";
import { toRGBColor } from "../schema";
import {
	createMockToolContext,
	type MockToolContext,
} from "../testUtils/mockToolContext";
import {
	ev,
	testCanvasHeight,
	testCanvasWidth,
	testViewport,
} from "../testUtils/pointerEvent";
import {
	cubicBez,
	getDisplayedMeshHandle,
	getEffectiveMeshEdgeCurve,
} from "../utils/geometry/meshGradient";
import { GradientTool } from "./GradientTool";

describe("GradientTool", () => {
	let tool: GradientTool;
	let ctx: MockToolContext;

	beforeEach(() => {
		ctx = createMockToolContext();
		tool = new GradientTool(ctx);
	});

	it("should update the root boundary handle when dragging a visible root-owned mesh CP", () => {
		const fill = createBoundaryMeshGradientFill();
		const element = createGradientHost(fill);
		const bounds = createBounds();

		ctx.getSelectedElement.mockImplementation(() => element);
		ctx.getSelectedElementBounds.mockImplementation(() => bounds);
		ctx.updateFill.mockImplementation((nextFill) => {
			(element.filters?.[0] as FillAppearance).paramData.params.fill =
				nextFill as MeshGradient;
		});

		const vertex0 = fill.vertices[0];
		const vertexScreen = screenPoint(bounds, vertex0.x, vertex0.y);
		tool.onPointerDown(
			ev(vertexScreen.x, vertexScreen.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const visibleCP = getDisplayedMeshHandle(fill.vertices, fill.faces, 0, 4);
		const cpScreen = screenPoint(bounds, visibleCP.x, visibleCP.y);
		const dragTarget = { x: visibleCP.x + 0.06, y: visibleCP.y - 0.04 };
		const dragScreen = screenPoint(bounds, dragTarget.x, dragTarget.y);

		tool.onPointerDown(
			ev(cpScreen.x, cpScreen.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(dragScreen.x, dragScreen.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(ev(0, 0), testViewport, testCanvasWidth, testCanvasHeight);

		expect(ctx.updateFill).toHaveBeenCalled();
		const updated = ctx.updateFill.mock.calls.at(-1)?.[0] as MeshGradient;
		expect(updated.vertices[0].handles[1].x).toBeCloseTo(dragTarget.x, 6);
		expect(updated.vertices[0].handles[1].y).toBeCloseTo(dragTarget.y, 6);
		expect(updated.vertices[0].handles[4]).toEqual(fill.vertices[0].handles[4]);
	});

	it("should keep a boundary-derived vertex on the root cubic while dragging", () => {
		const fill = createBoundaryMeshGradientFill();
		const element = createGradientHost(fill);
		const bounds = createBounds();
		const originalHandles = structuredClone(fill.vertices[4].handles);

		ctx.getSelectedElement.mockImplementation(() => element);
		ctx.getSelectedElementBounds.mockImplementation(() => bounds);
		ctx.updateFill.mockImplementation((nextFill) => {
			(element.filters?.[0] as FillAppearance).paramData.params.fill =
				nextFill as MeshGradient;
		});

		const start = screenPoint(bounds, fill.vertices[4].x, fill.vertices[4].y);
		const dragTarget = { x: 0.32, y: -0.38 };
		const dragScreen = screenPoint(bounds, dragTarget.x, dragTarget.y);

		tool.onPointerDown(
			ev(start.x, start.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(dragScreen.x, dragScreen.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(ev(0, 0), testViewport, testCanvasWidth, testCanvasHeight);

		expect(ctx.updateFill).toHaveBeenCalled();
		const updated = ctx.updateFill.mock.calls.at(-1)?.[0] as MeshGradient;
		const updatedV4 = updated.vertices[4];
		const projected = cubicBez(
			{ x: updated.vertices[0].x, y: updated.vertices[0].y },
			updated.vertices[0].handles[1],
			updated.vertices[1].handles[0],
			{ x: updated.vertices[1].x, y: updated.vertices[1].y },
			updatedV4.positionSource!.t,
		);

		expect(updatedV4.x).toBeCloseTo(projected.x, 6);
		expect(updatedV4.y).toBeCloseTo(projected.y, 6);
		expect(updatedV4.x).not.toBeCloseTo(dragTarget.x, 2);
		expect(updatedV4.y).not.toBeCloseTo(dragTarget.y, 2);
		// Handles along the owning edge ride rigidly with the slide...
		const dx = updatedV4.x - fill.vertices[4].x;
		const dy = updatedV4.y - fill.vertices[4].y;
		for (const ni of [0, 1]) {
			expect(updatedV4.handles[ni].x).toBeCloseTo(
				originalHandles[ni].x + dx,
				6,
			);
			expect(updatedV4.handles[ni].y).toBeCloseTo(
				originalHandles[ni].y + dy,
				6,
			);
		}
		// ...while the split-line handle also turns with the edge tangent, so
		// the cut stays attached to the edge frame instead of creasing.
		const expectedCross = rotatedCrossHandle(
			fill,
			updated,
			4,
			[0, 1],
			originalHandles[5],
		);
		expect(updatedV4.handles[5].x).toBeCloseTo(expectedCross.x, 6);
		expect(updatedV4.handles[5].y).toBeCloseTo(expectedCross.y, 6);
	});

	it("should keep an interior-derived vertex on the boundary-to-explicit root segment while dragging", () => {
		const fill = createInteriorRootSegmentMeshGradientFill();
		const element = createGradientHost(fill);
		const bounds = createBounds();
		const originalHandles = structuredClone(fill.vertices[9].handles);

		ctx.getSelectedElement.mockImplementation(() => element);
		ctx.getSelectedElementBounds.mockImplementation(() => bounds);
		ctx.updateFill.mockImplementation((nextFill) => {
			(element.filters?.[0] as FillAppearance).paramData.params.fill =
				nextFill as MeshGradient;
		});

		const start = screenPoint(bounds, fill.vertices[9].x, fill.vertices[9].y);
		const dragTarget = { x: 0.86, y: -0.08 };
		const dragScreen = screenPoint(bounds, dragTarget.x, dragTarget.y);

		tool.onPointerDown(
			ev(start.x, start.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(dragScreen.x, dragScreen.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(ev(0, 0), testViewport, testCanvasWidth, testCanvasHeight);

		expect(ctx.updateFill).toHaveBeenCalled();
		const updated = ctx.updateFill.mock.calls.at(-1)?.[0] as MeshGradient;
		const updatedV9 = updated.vertices[9];
		const projected = cubicBez(
			{ x: updated.vertices[4].x, y: updated.vertices[4].y },
			updated.vertices[4].handles[8],
			updated.vertices[8].handles[4],
			{ x: updated.vertices[8].x, y: updated.vertices[8].y },
			updatedV9.positionSource!.t,
		);

		expect(updatedV9.positionSource).toBeDefined();
		expect(updatedV9.x).toBeCloseTo(projected.x, 6);
		expect(updatedV9.y).toBeCloseTo(projected.y, 6);
		expect(updatedV9.x).not.toBeCloseTo(dragTarget.x, 2);
		expect(updatedV9.y).not.toBeCloseTo(dragTarget.y, 2);
		// Handles along the owning root segment ride rigidly with the slide...
		const dx = updatedV9.x - fill.vertices[9].x;
		const dy = updatedV9.y - fill.vertices[9].y;
		for (const ni of [4, 8]) {
			expect(updatedV9.handles[ni].x).toBeCloseTo(
				originalHandles[ni].x + dx,
				6,
			);
			expect(updatedV9.handles[ni].y).toBeCloseTo(
				originalHandles[ni].y + dy,
				6,
			);
		}
		// ...while the split-line handle also turns with the edge tangent.
		const expectedCross = rotatedCrossHandle(
			fill,
			updated,
			9,
			[4, 8],
			originalHandles[7],
		);
		expect(updatedV9.handles[7].x).toBeCloseTo(expectedCross.x, 6);
		expect(updatedV9.handles[7].y).toBeCloseTo(expectedCross.y, 6);
	});

	it("should keep an explicit mesh vertex's handles on their neighbors on Alt+drag", () => {
		const fill = createBoundaryMeshGradientFill();
		const element = createGradientHost(fill);
		const bounds = createBounds();

		ctx.getSelectedElement.mockImplementation(() => element);
		ctx.getSelectedElementBounds.mockImplementation(() => bounds);
		ctx.updateFill.mockImplementation((nextFill) => {
			(element.filters?.[0] as FillAppearance).paramData.params.fill =
				nextFill as MeshGradient;
		});

		// Alt+drag corner vertex 2 at rel(1,1) -> screen(500,200).
		const start = screenPoint(bounds, 1, 1);
		tool.onPointerDown(
			ev(start.x, start.y, { altKey: true }),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		// First move gets the pointer clear of the vertex (60px right).
		tool.onPointerMove(
			ev(start.x + 60, start.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		// Second move: 80px out from the vertex, still at angle 0.
		tool.onPointerMove(
			ev(start.x + 80, start.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(ev(0, 0), testViewport, testCanvasWidth, testCanvasHeight);

		expect(ctx.updateFill).toHaveBeenCalled();
		const updated = ctx.updateFill.mock.calls.at(-1)?.[0] as MeshGradient;
		const updatedV2 = updated.vertices[2];
		// The vertex itself never moves during a fan drag.
		expect(updatedV2.x).toBeCloseTo(1, 6);
		expect(updatedV2.y).toBeCloseTo(1, 6);
		// Each handle keeps its own neighbor's direction and takes the pointer's
		// distance (80px on a 100x100 bounds). The fan turns only by how far the
		// pointer swung from where it first cleared the vertex — here, not at all.
		expect(updatedV2.handles[1].x).toBeCloseTo(1, 6);
		expect(updatedV2.handles[1].y).toBeCloseTo(1 - 0.8, 6);
		expect(updatedV2.handles[3].x).toBeCloseTo(1 - 0.8, 6);
		expect(updatedV2.handles[3].y).toBeCloseTo(1, 6);
	});

	it("previews a mesh vertex drag and commits one fill on pointer-up", () => {
		const fill = createBoundaryMeshGradientFill();
		const element = createGradientHost(fill);
		const bounds = createBounds();

		ctx.getSelectedElement.mockImplementation(() => element);
		ctx.getSelectedElementBounds.mockImplementation(() => bounds);
		ctx.getCurrentLayerId.mockReturnValue("layer-1");

		// Drag corner vertex 2 at rel(1,1) by two move frames.
		const start = screenPoint(bounds, 1, 1);
		tool.onPointerDown(
			ev(start.x, start.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		for (const target of [
			screenPoint(bounds, 1.1, 1.05),
			screenPoint(bounds, 1.2, 1.1),
		]) {
			tool.onPointerMove(
				ev(target.x, target.y),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
		}

		// While dragging: preview only, nothing written to the document.
		expect(ctx.updateFill).not.toHaveBeenCalled();
		expect(ctx.previewDeformation).toHaveBeenCalled();
		const [previewed] = ctx.previewDeformation.mock.calls.at(-1)?.[0] ?? [];
		expect(previewed?.elementId).toBe(element.id);

		tool.onPointerUp(ev(0, 0), testViewport, testCanvasWidth, testCanvasHeight);

		// One commit for the whole drag — one undo step.
		expect(ctx.clearDeformationPreview).toHaveBeenCalledWith([element.id]);
		expect(ctx.updateFill).toHaveBeenCalledTimes(1);
		const committed = ctx.updateFill.mock.calls[0][0] as MeshGradient;
		expect(committed.vertices[2].x).toBeCloseTo(1.2, 6);
		expect(committed.vertices[2].y).toBeCloseTo(1.1, 6);
	});

	it("keeps the grab offset and ignores sub-threshold moves on a mesh vertex", () => {
		const fill = createBoundaryMeshGradientFill();
		const element = createGradientHost(fill);
		const bounds = createBounds();

		ctx.getSelectedElement.mockImplementation(() => element);
		ctx.getSelectedElementBounds.mockImplementation(() => bounds);
		ctx.getCurrentLayerId.mockReturnValue("layer-1");

		// Grab 4px right of vertex 2 (inside the hit tolerance).
		const vertexScreen = screenPoint(bounds, 1, 1);
		tool.onPointerDown(
			ev(vertexScreen.x + 4, vertexScreen.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		// 2px of movement is a click, not a drag.
		tool.onPointerMove(
			ev(vertexScreen.x + 6, vertexScreen.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		expect(ctx.previewDeformation).not.toHaveBeenCalled();

		// 20px right: the vertex moves by the pointer delta, not onto the
		// cursor (which sits 4px further right than the vertex).
		tool.onPointerMove(
			ev(vertexScreen.x + 24, vertexScreen.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(ev(0, 0), testViewport, testCanvasWidth, testCanvasHeight);
		const committed = ctx.updateFill.mock.calls.at(-1)?.[0] as MeshGradient;
		// 20px on a 100px-wide bounds = +0.2 in rel space.
		expect(committed.vertices[2].x).toBeCloseTo(1.2, 6);
		expect(committed.vertices[2].y).toBeCloseTo(1, 6);
	});

	it("promotes a derived mesh vertex on double-click", () => {
		const fill = createBoundaryMeshGradientFill();
		const element = createGradientHost(fill);
		const bounds = createBounds();
		ctx.getSelectedElement.mockImplementation(() => element);
		ctx.getSelectedElementBounds.mockImplementation(() => bounds);

		// Vertex 4 is the derived one on the bottom edge at rel(0.5, 0).
		const at = screenPoint(bounds, fill.vertices[4].x, fill.vertices[4].y);
		tool.onDoubleClick(
			ev(at.x, at.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(ctx.updateFill).toHaveBeenCalledTimes(1);
		const updated = ctx.updateFill.mock.calls[0][0] as MeshGradient;
		expect(updated.vertices[4].colorMode).toBe("explicit");
		expect(updated.vertices[4].positionSource).toBeUndefined();
		expect(updated.vertices[4].colorSource).toBeUndefined();
		// A vertex hit never subdivides anything.
		expect(updated.faces).toEqual(fill.faces);
		expect(updated.vertices).toHaveLength(fill.vertices.length);
	});

	it("cuts a mesh edge one-directionally on double-click near it", () => {
		const fill = createBoundaryMeshGradientFill();
		const element = createGradientHost(fill);
		const bounds = createBounds();
		ctx.getSelectedElement.mockImplementation(() => element);
		ctx.getSelectedElementBounds.mockImplementation(() => bounds);

		// rel(0.52, 0.5): 2px right of the straight interior edge between the
		// two derived mid vertices, far from every vertex.
		const at = screenPoint(bounds, 0.52, 0.5);
		tool.onDoubleClick(
			ev(at.x, at.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(ctx.updateFill).toHaveBeenCalledTimes(1);
		const updated = ctx.updateFill.mock.calls[0][0] as MeshGradient;
		// A single cut line straight across the mesh: each face splits once,
		// no explicit face-center vertex appears anywhere else.
		expect(updated.faces.length).toBe(fill.faces.length + 2);
		// The inserted vertex sits on the clicked edge and is the user's own.
		const inserted = updated.vertices.find(
			(v, i) =>
				i >= fill.vertices.length &&
				v.colorMode === "explicit" &&
				Math.abs(v.x - 0.5) < 0.02,
		);
		expect(inserted).toBeDefined();
		// The bowed bottom edge drags the whole interior edge down a little,
		// so pin only "near the click along the edge", not an exact midpoint.
		expect(Math.abs((inserted?.y ?? 0) - 0.5)).toBeLessThan(0.15);
		expect(inserted?.positionSource).toBeUndefined();
	});

	it("splits a face crosswise on double-click inside it", () => {
		const fill = createBoundaryMeshGradientFill();
		const element = createGradientHost(fill);
		const bounds = createBounds();
		ctx.getSelectedElement.mockImplementation(() => element);
		ctx.getSelectedElementBounds.mockImplementation(() => bounds);

		// Deep inside the left face, away from vertices and edges.
		const at = screenPoint(bounds, 0.25, 0.5);
		tool.onDoubleClick(
			ev(at.x, at.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(ctx.updateFill).toHaveBeenCalledTimes(1);
		const updated = ctx.updateFill.mock.calls[0][0] as MeshGradient;
		// A cross split: exactly one explicit face-center vertex appears (its
		// exact spot is the Coons position, pulled around by the bowed face),
		// and the face count grows past what a single-direction cut adds.
		const centers = updated.vertices.filter(
			(v, i) => i >= fill.vertices.length && v.colorMode === "explicit",
		);
		expect(centers).toHaveLength(1);
		expect(updated.faces.length).toBeGreaterThan(fill.faces.length + 2);
	});

	it("consumes Delete when deleting the selected explicit mesh vertex is rejected", () => {
		const fill = createInteriorRootSegmentMeshGradientFill();
		const element = createGradientHost(fill);
		const bounds = createBounds();
		ctx.getSelectedElement.mockImplementation(() => element);
		ctx.getSelectedElementBounds.mockImplementation(() => bounds);
		ctx.deleteSelectedGradientStop.mockReturnValue(false);
		const firstAddedExplicit = fill.vertices[8];
		const point = screenPoint(
			bounds,
			firstAddedExplicit.x,
			firstAddedExplicit.y,
		);
		tool.onPointerDown(
			ev(point.x, point.y),
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

		expect(ctx.deleteSelectedGradientStop).toHaveBeenCalledOnce();
		expect(handled).toBe(true);
	});
});

describe("GradientTool midpoint handle", () => {
	let tool: GradientTool;
	let ctx: MockToolContext;

	beforeEach(() => {
		ctx = createMockToolContext();
		tool = new GradientTool(ctx);
	});

	it("drags a linear gradient's midpoint without changing stop offsets or order", () => {
		const fill = createLinearGradientFill();
		const element = createFillHost(fill);
		const bounds = createBounds();

		ctx.getSelectedElement.mockImplementation(() => element);
		ctx.getSelectedElementBounds.mockImplementation(() => bounds);
		ctx.updateFill.mockImplementation((nextFill) => {
			(element.filters?.[0] as FillAppearance).paramData.params.fill =
				nextFill as LinearGradient;
		});

		// Midpoint marker starts at t=0.5 along the x1→x2 line (y1===y2===0.5).
		const midStart = screenPoint(bounds, 0.5, 0.5);
		tool.onPointerDown(
			ev(midStart.x, midStart.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const dragTarget = screenPoint(bounds, 0.3, 0.5);
		tool.onPointerMove(
			ev(dragTarget.x, dragTarget.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(ev(0, 0), testViewport, testCanvasWidth, testCanvasHeight);

		expect(ctx.updateFill).toHaveBeenCalled();
		const updated = ctx.updateFill.mock.calls.at(-1)?.[0] as LinearGradient;
		expect(updated.stops[0].offset).toBe(0);
		expect(updated.stops[1].offset).toBe(1);
		expect(updated.stops[0].midpoint).toBeCloseTo(0.3, 2);
		expect(updated.stops[1].midpoint).toBe(0.5);
	});

	it("clamps a linear gradient's midpoint away from 0 and 1", () => {
		const fill = createLinearGradientFill();
		const element = createFillHost(fill);
		const bounds = createBounds();

		ctx.getSelectedElement.mockImplementation(() => element);
		ctx.getSelectedElementBounds.mockImplementation(() => bounds);
		ctx.updateFill.mockImplementation((nextFill) => {
			(element.filters?.[0] as FillAppearance).paramData.params.fill =
				nextFill as LinearGradient;
		});

		const midStart = screenPoint(bounds, 0.5, 0.5);
		tool.onPointerDown(
			ev(midStart.x, midStart.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		// Drag far past the left edge — midpoint must clamp, not hit exactly 0.
		const dragTarget = screenPoint(bounds, -5, 0.5);
		tool.onPointerMove(
			ev(dragTarget.x, dragTarget.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(ev(0, 0), testViewport, testCanvasWidth, testCanvasHeight);

		const updated = ctx.updateFill.mock.calls.at(-1)?.[0] as LinearGradient;
		expect(updated.stops[0].midpoint).toBeGreaterThan(0);
		expect(updated.stops[0].midpoint).toBeLessThan(0.001);
	});

	it("drags a radial gradient's midpoint without changing stop offsets or order", () => {
		const fill = createRadialGradientFill();
		const element = createFillHost(fill);
		const bounds = createBounds();

		ctx.getSelectedElement.mockImplementation(() => element);
		ctx.getSelectedElementBounds.mockImplementation(() => bounds);
		ctx.updateFill.mockImplementation((nextFill) => {
			(element.filters?.[0] as FillAppearance).paramData.params.fill =
				nextFill as RadialGradient;
		});

		// Midpoint marker starts at t=0.5 along the rotated X-axis (rotation=0).
		const midStart = screenPoint(bounds, 0.75, 0.5);
		tool.onPointerDown(
			ev(midStart.x, midStart.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const dragTarget = screenPoint(bounds, 0.65, 0.5);
		tool.onPointerMove(
			ev(dragTarget.x, dragTarget.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(ev(0, 0), testViewport, testCanvasWidth, testCanvasHeight);

		expect(ctx.updateFill).toHaveBeenCalled();
		const updated = ctx.updateFill.mock.calls.at(-1)?.[0] as RadialGradient;
		expect(updated.stops[0].offset).toBe(0);
		expect(updated.stops[1].offset).toBe(1);
		expect(updated.stops[0].midpoint).toBeCloseTo(0.3, 2);
		expect(updated.stops[1].midpoint).toBe(0.5);
	});
});

describe("GradientTool free-gradient CP alt-drag", () => {
	let tool: GradientTool;
	let ctx: MockToolContext;

	beforeEach(() => {
		ctx = createMockToolContext();
		tool = new GradientTool(ctx);
	});

	it("rotates and scales every other CP hanging off the same stop when dragging with Alt", () => {
		const fill = createFreeGradientFill();
		const element = createFillHost(fill);
		const bounds = createBounds();

		ctx.getSelectedElement.mockImplementation(() => element);
		ctx.getSelectedElementBounds.mockImplementation(() => bounds);
		ctx.updateFill.mockImplementation((nextFill) => {
			(element.filters?.[0] as FillAppearance).paramData.params.fill =
				nextFill as FreeGradient;
		});

		// Select stop "a" first — CP handles for its Delaunay-adjacent
		// neighbors ("b", "c") only render once their owning stop is selected.
		const stopA = screenPoint(bounds, 0.5, 0.5);
		tool.onPointerDown(
			ev(stopA.x, stopA.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(
			ev(stopA.x, stopA.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		// cp:a:b defaults to a + (b - a) / 3 = (0.8333, 0.5) — angle 0, distance
		// 1/3 from a. cp:a:c defaults to (0.5, 0.8333) — angle π/2, distance 1/3.
		const cpAB = screenPoint(bounds, 5 / 6, 0.5);
		tool.onPointerDown(
			ev(cpAB.x, cpAB.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		// Drag cp:a:b to (0.5, 0.8333): same distance (1/3) from "a", rotated
		// by +90°. Alt should apply that same +90°/+0 delta to cp:a:c.
		const dragTarget = screenPoint(bounds, 0.5, 5 / 6);
		tool.onPointerMove(
			ev(dragTarget.x, dragTarget.y, { altKey: true }),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(ev(0, 0), testViewport, testCanvasWidth, testCanvasHeight);

		const updated = ctx.updateFill.mock.calls.at(-1)?.[0] as FreeGradient;
		const stopAUpdated = updated.stops.find((s) => s.id === "a")!;
		expect(stopAUpdated.edgeCPs?.b.x).toBeCloseTo(0.5, 5);
		expect(stopAUpdated.edgeCPs?.b.y).toBeCloseTo(5 / 6, 5);
		// cp:a:c starts at angle π/2; rotating it by the same +90° lands it at
		// angle π, distance unchanged (1/3) — i.e. (0.1667, 0.5).
		expect(stopAUpdated.edgeCPs?.c.x).toBeCloseTo(1 / 6, 5);
		expect(stopAUpdated.edgeCPs?.c.y).toBeCloseTo(0.5, 5);
	});

	it("moves only the grabbed CP when dragging without Alt", () => {
		const fill = createFreeGradientFill();
		const element = createFillHost(fill);
		const bounds = createBounds();

		ctx.getSelectedElement.mockImplementation(() => element);
		ctx.getSelectedElementBounds.mockImplementation(() => bounds);
		ctx.updateFill.mockImplementation((nextFill) => {
			(element.filters?.[0] as FillAppearance).paramData.params.fill =
				nextFill as FreeGradient;
		});

		const stopA = screenPoint(bounds, 0.5, 0.5);
		tool.onPointerDown(
			ev(stopA.x, stopA.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(
			ev(stopA.x, stopA.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const cpAB = screenPoint(bounds, 5 / 6, 0.5);
		tool.onPointerDown(
			ev(cpAB.x, cpAB.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const dragTarget = screenPoint(bounds, 0.5, 5 / 6);
		tool.onPointerMove(
			ev(dragTarget.x, dragTarget.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(ev(0, 0), testViewport, testCanvasWidth, testCanvasHeight);

		const updated = ctx.updateFill.mock.calls.at(-1)?.[0] as FreeGradient;
		const stopAUpdated = updated.stops.find((s) => s.id === "a")!;
		expect(stopAUpdated.edgeCPs?.b.x).toBeCloseTo(0.5, 5);
		expect(stopAUpdated.edgeCPs?.b.y).toBeCloseTo(5 / 6, 5);
		// cp:a:c was never explicitly set, so it stays absent (still defaults).
		expect(stopAUpdated.edgeCPs?.c).toBeUndefined();
	});
});

describe("GradientTool start/end handle grab offset", () => {
	let tool: GradientTool;
	let ctx: MockToolContext;

	beforeEach(() => {
		ctx = createMockToolContext();
		tool = new GradientTool(ctx);
	});

	it("does not snap x1/y1 to the cursor when grabbing the offset start handle", () => {
		const fill = createLinearGradientFill();
		const element = createFillHost(fill);
		const bounds = createBounds();

		ctx.getSelectedElement.mockImplementation(() => element);
		ctx.getSelectedElementBounds.mockImplementation(() => bounds);
		ctx.updateFill.mockImplementation((nextFill) => {
			(element.filters?.[0] as FillAppearance).paramData.params.fill =
				nextFill as LinearGradient;
		});

		// The start handle renders 16 world-units outward from (x1,y1) along
		// the line direction so it doesn't overlap the first color stop —
		// with bounds width 100 that's rel x = -0.16.
		const handlePos = screenPoint(bounds, -0.16, 0.5);
		tool.onPointerDown(
			ev(handlePos.x, handlePos.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		// A move at the exact same position the handle was grabbed at is a
		// click, not a drag: nothing is written, so x1/y1 cannot jump to the
		// (offset) handle position and no undo entry appears.
		tool.onPointerMove(
			ev(handlePos.x, handlePos.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(ev(0, 0), testViewport, testCanvasWidth, testCanvasHeight);

		expect(ctx.updateFill).not.toHaveBeenCalled();
	});

	it("moves x1/y1 by the drag delta once the pointer moves", () => {
		const fill = createLinearGradientFill();
		const element = createFillHost(fill);
		const bounds = createBounds();

		ctx.getSelectedElement.mockImplementation(() => element);
		ctx.getSelectedElementBounds.mockImplementation(() => bounds);
		ctx.updateFill.mockImplementation((nextFill) => {
			(element.filters?.[0] as FillAppearance).paramData.params.fill =
				nextFill as LinearGradient;
		});

		const handlePos = screenPoint(bounds, -0.16, 0.5);
		tool.onPointerDown(
			ev(handlePos.x, handlePos.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		const dragTarget = screenPoint(bounds, -0.16 + 0.2, 0.5);
		tool.onPointerMove(
			ev(dragTarget.x, dragTarget.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(ev(0, 0), testViewport, testCanvasWidth, testCanvasHeight);

		const updated = ctx.updateFill.mock.calls.at(-1)?.[0] as LinearGradient;
		expect(updated.x1).toBeCloseTo(0.2, 5);
		expect(updated.y1).toBeCloseTo(0.5, 5);
	});

	it("does not snap x2/y2 to the cursor when grabbing the offset end handle", () => {
		const fill = createLinearGradientFill();
		const element = createFillHost(fill);
		const bounds = createBounds();

		ctx.getSelectedElement.mockImplementation(() => element);
		ctx.getSelectedElementBounds.mockImplementation(() => bounds);
		ctx.updateFill.mockImplementation((nextFill) => {
			(element.filters?.[0] as FillAppearance).paramData.params.fill =
				nextFill as LinearGradient;
		});

		// The end handle renders 16 world-units outward from (x2,y2) — with
		// bounds width 100 that's rel x = 1.16.
		const handlePos = screenPoint(bounds, 1.16, 0.5);
		tool.onPointerDown(
			ev(handlePos.x, handlePos.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		// A zero-distance "drag" is a click: nothing is written, so x2/y2
		// cannot jump to the (offset) handle position.
		tool.onPointerMove(
			ev(handlePos.x, handlePos.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(ev(0, 0), testViewport, testCanvasWidth, testCanvasHeight);

		expect(ctx.updateFill).not.toHaveBeenCalled();
	});
});

/**
 * Where a derived vertex's split-line handle lands after a slide: it keeps
 * its offset from the vertex, turned by how much the owning edge's tangent
 * turned between the old and new edge parameters.
 */
function rotatedCrossHandle(
	before: MeshGradient,
	after: MeshGradient,
	vertexIndex: number,
	edge: [number, number],
	originalHandle: { x: number; y: number },
): { x: number; y: number } {
	const tangentAt = (fill: MeshGradient, t: number): number => {
		const curve = getEffectiveMeshEdgeCurve(
			fill.vertices,
			fill.faces,
			edge[0],
			edge[1],
		);
		const h = 1e-3;
		const t0 = Math.max(0, Math.min(1 - h, t - h / 2));
		const a = cubicBez(curve[0], curve[1], curve[2], curve[3], t0);
		const b = cubicBez(curve[0], curve[1], curve[2], curve[3], t0 + h);
		return Math.atan2(b.y - a.y, b.x - a.x);
	};
	const oldVertex = before.vertices[vertexIndex];
	const newVertex = after.vertices[vertexIndex];
	const delta =
		tangentAt(after, newVertex.positionSource!.t) -
		tangentAt(before, oldVertex.positionSource!.t);
	const ox = originalHandle.x - oldVertex.x;
	const oy = originalHandle.y - oldVertex.y;
	return {
		x: newVertex.x + ox * Math.cos(delta) - oy * Math.sin(delta),
		y: newVertex.y + ox * Math.sin(delta) + oy * Math.cos(delta),
	};
}

function createBoundaryMeshGradientFill(): MeshGradient {
	const red = toRGBColor({ r: 255, g: 0, b: 0, a: 1 });
	const green = toRGBColor({ r: 0, g: 255, b: 0, a: 1 });
	const blue = toRGBColor({ r: 0, g: 0, b: 255, a: 1 });
	const yellow = toRGBColor({ r: 255, g: 255, b: 0, a: 1 });

	return {
		type: "mesh",
		vertices: [
			{
				x: 0,
				y: 0,
				color: red,
				colorMode: "explicit",
				handles: {
					1: { x: 0.25, y: -0.2 },
					4: { x: 0.12, y: -0.35 },
					3: { x: 0, y: 0.33 },
				},
			},
			{
				x: 1,
				y: 0,
				color: green,
				colorMode: "explicit",
				handles: {
					0: { x: 0.75, y: -0.2 },
					4: { x: 0.88, y: -0.35 },
					2: { x: 1, y: 0.33 },
				},
			},
			{
				x: 1,
				y: 1,
				color: blue,
				colorMode: "explicit",
				handles: {
					1: { x: 1, y: 0.66 },
					5: { x: 0.88, y: 1 },
				},
			},
			{
				x: 0,
				y: 1,
				color: yellow,
				colorMode: "explicit",
				handles: {
					0: { x: 0, y: 0.66 },
					5: { x: 0.12, y: 1 },
				},
			},
			{
				x: 0.5,
				y: 0,
				color: toRGBColor({ r: 255, g: 128, b: 0, a: 1 }),
				colorMode: "derived",
				colorSource: { kind: "edge", edgeVerts: [0, 1], t: 0.5 },
				positionSource: { edgeVerts: [0, 1], t: 0.5 },
				meshSource: { edgeVerts: [0, 1], t: 0.5 },
				handles: {
					0: { x: 0.1, y: -0.55 },
					1: { x: 0.9, y: -0.1 },
					5: { x: 0.5, y: 0.24 },
				},
			},
			{
				x: 0.5,
				y: 1,
				color: toRGBColor({ r: 0, g: 200, b: 255, a: 1 }),
				colorMode: "derived",
				colorSource: { kind: "edge", edgeVerts: [3, 2], t: 0.5 },
				positionSource: { edgeVerts: [3, 2], t: 0.5 },
				meshSource: { edgeVerts: [3, 2], t: 0.5 },
				handles: {
					3: { x: 0.12, y: 1 },
					2: { x: 0.88, y: 1 },
					4: { x: 0.5, y: 0.76 },
				},
			},
		],
		faces: [
			{ type: "quad", verts: [0, 4, 5, 3] },
			{ type: "quad", verts: [4, 1, 2, 5] },
		],
	};
}

function createInteriorRootSegmentMeshGradientFill(): MeshGradient {
	const red = toRGBColor({ r: 255, g: 0, b: 0, a: 1 });
	const green = toRGBColor({ r: 0, g: 255, b: 0, a: 1 });
	const blue = toRGBColor({ r: 0, g: 0, b: 255, a: 1 });
	const yellow = toRGBColor({ r: 255, g: 255, b: 0, a: 1 });
	const cyan = toRGBColor({ r: 0, g: 220, b: 255, a: 1 });
	const magenta = toRGBColor({ r: 255, g: 0, b: 220, a: 1 });

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

	return {
		type: "mesh",
		vertices: [
			{
				x: 0,
				y: 0,
				color: red,
				colorMode: "explicit",
				handles: { 4: { x: 0.25, y: 0 }, 7: { x: 0, y: 0.25 } },
			},
			{
				x: 1,
				y: 0,
				color: green,
				colorMode: "explicit",
				handles: { 4: { x: 0.75, y: 0 }, 5: { x: 1, y: 0.25 } },
			},
			{
				x: 1,
				y: 1,
				color: blue,
				colorMode: "explicit",
				handles: { 5: { x: 1, y: 0.75 }, 6: { x: 0.75, y: 1 } },
			},
			{
				x: 0,
				y: 1,
				color: yellow,
				colorMode: "explicit",
				handles: { 6: { x: 0.25, y: 1 }, 7: { x: 0, y: 0.75 } },
			},
			{
				x: 0.5,
				y: 0,
				color: toRGBColor({ r: 255, g: 128, b: 0, a: 1 }),
				colorMode: "derived",
				colorSource: { kind: "edge", edgeVerts: [0, 1], t: 0.5 },
				positionSource: { edgeVerts: [0, 1], t: 0.5 },
				meshSource: { edgeVerts: [0, 1], t: 0.5 },
				handles: {
					0: { x: 0.16, y: -0.05 },
					1: { x: 0.84, y: -0.05 },
					8: rootCurve[1],
					9: { x: 0.98, y: -0.22 },
				},
			},
			{
				x: 1,
				y: 0.5,
				color: cyan,
				colorMode: "derived",
				colorSource: { kind: "edge", edgeVerts: [1, 2], t: 0.5 },
				positionSource: { edgeVerts: [1, 2], t: 0.5 },
				meshSource: { edgeVerts: [1, 2], t: 0.5 },
				handles: {
					1: { x: 1.05, y: 0.16 },
					2: { x: 1.05, y: 0.84 },
					8: { x: 0.84, y: 0.5 },
				},
			},
			{
				x: 0.5,
				y: 1,
				color: magenta,
				colorMode: "derived",
				colorSource: { kind: "edge", edgeVerts: [3, 2], t: 0.5 },
				positionSource: { edgeVerts: [3, 2], t: 0.5 },
				meshSource: { edgeVerts: [3, 2], t: 0.5 },
				handles: {
					2: { x: 0.84, y: 1.05 },
					3: { x: 0.16, y: 1.05 },
					8: { x: 0.5, y: 0.84 },
				},
			},
			{
				x: 0,
				y: 0.5,
				color: toRGBColor({ r: 255, g: 128, b: 128, a: 1 }),
				colorMode: "derived",
				colorSource: { kind: "edge", edgeVerts: [0, 3], t: 0.5 },
				positionSource: { edgeVerts: [0, 3], t: 0.5 },
				meshSource: { edgeVerts: [0, 3], t: 0.5 },
				handles: {
					0: { x: -0.05, y: 0.16 },
					3: { x: -0.05, y: 0.84 },
					9: { x: 0.08, y: 0.56 },
				},
			},
			{
				x: 0.5,
				y: 0.5,
				color: toRGBColor({ r: 180, g: 180, b: 180, a: 1 }),
				colorMode: "explicit",
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
				color: toRGBColor({ r: 255, g: 64, b: 64, a: 1 }),
				colorMode: "derived",
				colorSource: { kind: "edge", edgeVerts: [4, 8], t: 0.5 },
				positionSource: { edgeVerts: [4, 8], t: 0.5 },
				meshSource: { edgeVerts: [4, 8], t: 0.5 },
				handles: {
					4: { x: 0.97, y: 0.46 },
					7: { x: 0.12, y: 0.46 },
					8: { x: 0.04, y: -0.02 },
				},
			},
		],
		faces: [
			{ type: "quad", verts: [0, 4, 9, 7] },
			{ type: "quad", verts: [4, 1, 5, 8] },
			{ type: "tri", verts: [4, 8, 9] },
			{ type: "quad", verts: [7, 9, 8, 6] },
			{ type: "quad", verts: [8, 5, 2, 6] },
			{ type: "quad", verts: [0, 7, 6, 3] },
		],
	};
}

function createGradientHost(fill: MeshGradient): MeshArtObject {
	const vertices: MeshGeometryVertex[] = [
		{
			x: 0,
			y: 0,
			src: { x: 0, y: 0 },
			handles: { 1: { x: 33, y: 0 }, 3: { x: 0, y: 33 } },
		},
		{
			x: 100,
			y: 0,
			src: { x: 100, y: 0 },
			handles: { 0: { x: 66, y: 0 }, 2: { x: 100, y: 33 } },
		},
		{
			x: 100,
			y: 100,
			src: { x: 100, y: 100 },
			handles: { 1: { x: 100, y: 66 }, 3: { x: 66, y: 100 } },
		},
		{
			x: 0,
			y: 100,
			src: { x: 0, y: 100 },
			handles: { 0: { x: 0, y: 66 }, 2: { x: 33, y: 100 } },
		},
	];

	return {
		id: "mesh-host",
		type: "mesh",
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		childIds: [],
		vertices,
		faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
		filters: [
			{
				uid: "fill-appearance",
				processor: "fill",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: { fill },
				},
			} satisfies FillAppearance,
		],
	};
}

function createBounds(): BoundingBox {
	return {
		minX: 0,
		minY: 0,
		maxX: 100,
		maxY: 100,
		width: 100,
		height: 100,
	};
}

function screenPoint(bounds: BoundingBox, relX: number, relY: number) {
	const worldX = bounds.minX + relX * bounds.width;
	const worldY = bounds.minY + relY * bounds.height;
	return {
		x: testCanvasWidth / 2 + worldX,
		y: testCanvasHeight / 2 - worldY,
	};
}

function createLinearGradientFill(): LinearGradient {
	return {
		type: "linear",
		x1: 0,
		y1: 0.5,
		x2: 1,
		y2: 0.5,
		stops: [
			{
				offset: 0,
				color: toRGBColor({ r: 255, g: 0, b: 0, a: 1 }),
				midpoint: 0.5,
			},
			{
				offset: 1,
				color: toRGBColor({ r: 0, g: 0, b: 255, a: 1 }),
				midpoint: 0.5,
			},
		],
	};
}

function createRadialGradientFill(): RadialGradient {
	return {
		type: "radial",
		cx: 0.5,
		cy: 0.5,
		radiusX: 0.5,
		radiusY: 0.5,
		rotation: 0,
		stops: [
			{
				offset: 0,
				color: toRGBColor({ r: 255, g: 0, b: 0, a: 1 }),
				midpoint: 0.5,
			},
			{
				offset: 1,
				color: toRGBColor({ r: 0, g: 0, b: 255, a: 1 }),
				midpoint: 0.5,
			},
		],
	};
}

// Stops are spaced 1.0 relative-unit (100 world-units) apart, so each
// default edge-CP (1/3 of the way to its neighbor, ~33 world-units out)
// sits well clear of a stop handle's ~10px hit radius — a distance
// matching that hit radius made the CP drag misfire onto the stop itself.
function createFreeGradientFill(): FreeGradient {
	return {
		type: "free",
		stops: [
			{
				id: "a",
				x: 0.5,
				y: 0.5,
				color: { type: "hsv", h: 0, s: 1, v: 1, a: 1 },
			},
			{
				id: "b",
				x: 1.5,
				y: 0.5,
				color: { type: "hsv", h: 1 / 3, s: 1, v: 1, a: 1 },
			},
			{
				id: "c",
				x: 0.5,
				y: 1.5,
				color: { type: "hsv", h: 2 / 3, s: 1, v: 1, a: 1 },
			},
		],
	};
}

function createFillHost(
	fill: LinearGradient | RadialGradient | FreeGradient,
): AnyArtObject {
	return {
		id: "fill-host",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		segments: [],
		filters: [
			{
				uid: "fill-appearance",
				processor: "fill",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: { fill },
				},
			} satisfies FillAppearance,
		],
	} as AnyArtObject;
}
