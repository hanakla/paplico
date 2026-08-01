import { describe, expect, it } from "vitest";
import {
	createIdentityTransform,
	createRepeatObject,
} from "../document/factory";
import type { UIPrimitive } from "../renderer/ui/primitives";
import type { SelectionUIData } from "../renderer/ui/types";
import {
	type AnyArtObject,
	type CubicBezierSegment,
	type Extrude3DAppearance,
	type Extrude3DParams,
	type Group,
	getTransform,
	type ImageObject,
	type Layer,
	type Path,
	type Revolve3DAppearance,
	type Revolve3DParams,
	type TextElement,
	type Vec3,
} from "../schema";
import { createMockToolContext } from "../testUtils/mockToolContext";
import {
	ev,
	testCanvasHeight,
	testCanvasWidth,
	testViewport,
} from "../testUtils/pointerEvent";
import {
	brandWorldBBox,
	calculateElementBounds,
	calculateLocalElementBounds,
} from "../utils/geometry/bounds";
import { toWorld, type WorldBezierSegment } from "../utils/geometry/geometry";
import { getWorldSegments } from "../utils/geometry/segmentOps";
import { SelectTool } from "./SelectTool";
import { createDefaultTextStyle } from "./TextTool";

describe("SelectTool", () => {
	it("commits the last preview delta even when pointerup coordinates are stale", () => {
		const elementId = "path-1";
		const layer: Layer = {
			id: "layer-1",
			name: "Layer 1",
			visible: true,
			locked: false,
			opacity: 1,
			blendMode: "normal",
			elementIds: [elementId],
		};
		const bounds = brandWorldBBox({
			minX: -100,
			minY: -100,
			maxX: 100,
			maxY: 100,
			width: 200,
			height: 200,
		});
		const element: AnyArtObject = {
			id: elementId,
			type: "path",
			segments: [],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};

		const context = createMockToolContext({
			getCurrentLayer: () => layer,
			getSelectedElementIds: () => [elementId],
			findElementAtPoint: () => element,
			getBounds: () => bounds,
			snapElements: (
				_ids,
				_originalBounds,
				proposedDeltaX,
				proposedDeltaY,
			) => ({
				deltaX: proposedDeltaX,
				deltaY: proposedDeltaY,
				snapLines: [],
			}),
		});
		const tool = new SelectTool(context);
		tool.refreshUI();

		tool.onPointerDown(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(500, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		// Simulate stale pointerup coordinates from drag start.
		tool.onPointerUp(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(context.elementMove).toHaveBeenCalledTimes(1);
		const [movedId, deltaX, deltaY] = context.elementMove.mock.calls[0];
		expect(movedId).toBe(elementId);
		expect(deltaX).toBe(100);
		expect(deltaY).toBe(0);
	});
});

describe("SelectTool extrude gizmo", () => {
	const EXTRUDE_KEY = "select/extrude-gizmo";

	function makeExtrudeElement(params?: Partial<Extrude3DParams>): Path {
		return {
			id: "path-ex",
			type: "path",
			segments: [
				seg(
					{ x: -50, y: -50 },
					{ x: 0, y: 0 },
					{ x: 0, y: 0 },
					{ x: 50, y: 50 },
				),
			],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			filters: [
				{
					uid: "app-ex",
					processor: "extrude3d",
					opacity: 1,
					blendMode: "normal",
					paramData: {
						version: "1",
						params: {
							depth: 40,
							rotationDeg: [0, 0, 0] as Vec3,
							perspective: 0,
							material: { shading: "lambert", lightDir: [-0.5, 0.7, 1] },
							...params,
						},
					},
				} as Extrude3DAppearance,
			],
		};
	}

	function createGizmoHarness(element: Path) {
		const bounds = calculateElementBounds(element);
		const context = createMockToolContext({
			getSelectedElementIds: () => [element.id],
			getElement: () => element,
			getBounds: () => bounds,
		});
		const tool = new SelectTool(context);
		tool.refreshUI();
		return { tool, context };
	}

	function lastExtrudeOverlay(
		context: ReturnType<typeof createMockToolContext>,
	): { primitives: readonly UIPrimitive[] } | null {
		const calls = context.uiSetOverlay.mock.calls.filter(
			([key]) => key === EXTRUDE_KEY,
		);
		return (
			(calls.at(-1)?.[1] as { primitives: readonly UIPrimitive[] } | null) ??
			null
		);
	}

	/** Canvas world → screen for the fixed test viewport (zoom 1, 800×600). */
	function screenOf(p: { x: number; y: number }): { x: number; y: number } {
		return { x: testCanvasWidth / 2 + p.x, y: testCanvasHeight / 2 - p.y };
	}

	it("should show rotation rings and a depth handle for a path with an extrude appearance", () => {
		const { context } = createGizmoHarness(makeExtrudeElement());

		const overlay = lastExtrudeOverlay(context);
		expect(overlay).not.toBeNull();
		const hitIds = overlay!.primitives.map((p) => p.hitId);
		expect(hitIds).toContain("extrude-rotate-x");
		expect(hitIds).toContain("extrude-rotate-y");
		expect(hitIds).toContain("extrude-rotate-z");
		expect(hitIds).toContain("extrude-depth");
	});

	it("should not show the gizmo without an extrude appearance", () => {
		const element = makeExtrudeElement();
		element.filters = [];
		const { context } = createGizmoHarness(element);

		expect(lastExtrudeOverlay(context)).toBeNull();
	});

	it("should show the gizmo for a group with an extrude appearance", () => {
		const path = makeExtrudeElement();
		const group: Group = {
			id: "group-ex",
			type: "group",
			childIds: [path.id],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			filters: path.filters,
		};
		// A group extrudes its world-space outline, so the gizmo reads its world
		// bounds (context.getBounds) rather than element-local bounds.
		const bounds = calculateElementBounds(path);
		const context = createMockToolContext({
			getSelectedElementIds: () => [group.id],
			getElement: () => group,
			getBounds: () => bounds,
		});
		new SelectTool(context).refreshUI();

		const overlay = lastExtrudeOverlay(context);
		expect(overlay).not.toBeNull();
		const hitIds = overlay!.primitives.map((p) => p.hitId);
		expect(hitIds).toContain("extrude-rotate-z");
		expect(hitIds).toContain("extrude-depth");
	});

	it("should rotate around Z by dragging along the Z ring", () => {
		const { tool, context } = createGizmoHarness(makeExtrudeElement());
		const ring = lastExtrudeOverlay(context)!.primitives.find(
			(p): p is Extract<UIPrimitive, { kind: "polyline" }> =>
				p.hitId === "extrude-rotate-z",
		)!;
		// A quarter of the ring parametrization = +90° around the axis.
		const start = screenOf(ring.points[0]);
		const quarter = screenOf(ring.points[8]);

		tool.onPointerDown(
			ev(start.x, start.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(quarter.x, quarter.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(
			ev(quarter.x, quarter.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(context.updateSelectedElementFilter).toHaveBeenCalled();
		const [index, patch] =
			context.updateSelectedElementFilter.mock.calls.at(-1)!;
		expect(index).toBe(0);
		const rotationDeg = (patch as { rotationDeg: Vec3 }).rotationDeg;
		expect(rotationDeg[0]).toBeCloseTo(0, 4);
		expect(rotationDeg[1]).toBeCloseTo(0, 4);
		expect(rotationDeg[2]).toBeCloseTo(90, 4);
		// The drag stayed a gizmo interaction — no element move happened.
		expect(context.elementMove).not.toHaveBeenCalled();
	});

	it("should grow the depth by dragging the depth handle outward", () => {
		const { tool, context } = createGizmoHarness(makeExtrudeElement());
		const arrow = lastExtrudeOverlay(context)!.primitives.find(
			(p): p is Extract<UIPrimitive, { kind: "arrow" }> =>
				p.hitId === "extrude-depth",
		)!;
		const grab = screenOf({ x: arrow.x2, y: arrow.y2 });
		// Head-on fallback mapping: 1 canvas unit along the screen diagonal
		// = +1 depth, so +30 units along the diagonal = depth 40 → 70.
		const d = 30 * Math.SQRT1_2;
		const drop = screenOf({ x: arrow.x2 + d, y: arrow.y2 + d });

		tool.onPointerDown(
			ev(grab.x, grab.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(drop.x, drop.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(
			ev(drop.x, drop.y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const [index, patch] =
			context.updateSelectedElementFilter.mock.calls.at(-1)!;
		expect(index).toBe(0);
		expect((patch as { depth: number }).depth).toBeCloseTo(70, 4);
	});

	describe("revolve3d", () => {
		function makeRevolveElement(params?: Partial<Revolve3DParams>): Path {
			const element = makeExtrudeElement();
			element.filters = [
				{
					uid: "app-rv",
					processor: "revolve3d",
					opacity: 1,
					blendMode: "normal",
					paramData: {
						version: "1",
						params: {
							angleDeg: 360,
							offset: 0,
							axis: "left",
							cap: true,
							rotationDeg: [0, 0, 0] as Vec3,
							perspective: 0,
							material: { shading: "lambert", lightDir: [-0.5, 0.7, 1] },
							...params,
						},
					},
				} as Revolve3DAppearance,
			];
			return element;
		}

		it("should show rotation rings without a depth handle", () => {
			const { context } = createGizmoHarness(makeRevolveElement());

			const overlay = lastExtrudeOverlay(context);
			expect(overlay).not.toBeNull();
			const hitIds = overlay!.primitives.map((p) => p.hitId);
			expect(hitIds).toContain("extrude-rotate-x");
			expect(hitIds).toContain("extrude-rotate-y");
			expect(hitIds).toContain("extrude-rotate-z");
			expect(hitIds).not.toContain("extrude-depth");
		});

		it("should hide the gizmo when the sweep angle is zero", () => {
			const { context } = createGizmoHarness(
				makeRevolveElement({ angleDeg: 0 }),
			);
			expect(lastExtrudeOverlay(context)).toBeNull();
		});

		it("should rotate the revolved solid around Z by dragging the Z ring", () => {
			const { tool, context } = createGizmoHarness(makeRevolveElement());
			const ring = lastExtrudeOverlay(context)!.primitives.find(
				(p): p is Extract<UIPrimitive, { kind: "polyline" }> =>
					p.hitId === "extrude-rotate-z",
			)!;
			// A quarter of the ring parametrization = +90° around the axis.
			const start = screenOf(ring.points[0]);
			const quarter = screenOf(ring.points[8]);

			tool.onPointerDown(
				ev(start.x, start.y),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(quarter.x, quarter.y),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(quarter.x, quarter.y),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(context.updateSelectedElementFilter).toHaveBeenCalled();
			const [index, patch] =
				context.updateSelectedElementFilter.mock.calls.at(-1)!;
			expect(index).toBe(0);
			const rotationDeg = (patch as { rotationDeg: Vec3 }).rotationDeg;
			expect(rotationDeg[2]).toBeCloseTo(90, 4);
			expect(context.elementMove).not.toHaveBeenCalled();
		});

		it("should center the rings on the revolve axis, not the profile", () => {
			// Profile x ∈ [-50, 50], axis "left" → axisX = -50: the full sweep
			// spans x ∈ [-150, 50], so the ring centers sit at x = -50 (the solid's
			// 3D box center), not the profile center x = 0.
			const { context } = createGizmoHarness(makeRevolveElement());
			const ring = lastExtrudeOverlay(context)!.primitives.find(
				(p): p is Extract<UIPrimitive, { kind: "polyline" }> =>
					p.hitId === "extrude-rotate-z",
			)!;
			const cx =
				ring.points.reduce((sum, p) => sum + p.x, 0) / ring.points.length;
			expect(cx).toBeCloseTo(-50, 1);
		});
	});
});

// -- Helpers for rotation tests --

function seg(
	start: { x: number; y: number } | undefined,
	cp1Offset: { x: number; y: number },
	cp2Offset: { x: number; y: number },
	end: { x: number; y: number },
): CubicBezierSegment {
	return {
		start: start ? { x: start.x, y: start.y } : undefined,
		cp1: { x: cp1Offset.x, y: cp1Offset.y },
		cp2: { x: cp2Offset.x, y: cp2Offset.y },
		end: { x: end.x, y: end.y },
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: false,
	};
}

/** Replicate handleRotateDrag's preview: rotate world-space points around center. */
function computePreview(
	worldSegs: WorldBezierSegment[],
	angleDelta: number,
	cx: number,
	cy: number,
): WorldBezierSegment[] {
	const cos = Math.cos(angleDelta);
	const sin = Math.sin(angleDelta);
	const rp = (p: { x: number; y: number }) =>
		toWorld(
			cx + (p.x - cx) * cos - (p.y - cy) * sin,
			cy + (p.x - cx) * sin + (p.y - cy) * cos,
		);
	return worldSegs.map((ws) => ({
		start: ws.start ? rp(ws.start) : undefined,
		cp1: rp(ws.cp1),
		cp2: rp(ws.cp2),
		end: rp(ws.end),
	}));
}

/** Assert two WorldBezierSegment arrays are numerically equal. */
function assertSegmentsClose(
	actual: WorldBezierSegment[],
	expected: WorldBezierSegment[],
	precision = 6,
) {
	expect(actual.length).toBe(expected.length);
	for (let i = 0; i < actual.length; i++) {
		const a = actual[i];
		const e = expected[i];
		if (a.start && e.start) {
			expect(a.start.x).toBeCloseTo(e.start.x, precision);
			expect(a.start.y).toBeCloseTo(e.start.y, precision);
		}
		expect(a.cp1.x).toBeCloseTo(e.cp1.x, precision);
		expect(a.cp1.y).toBeCloseTo(e.cp1.y, precision);
		expect(a.cp2.x).toBeCloseTo(e.cp2.x, precision);
		expect(a.cp2.y).toBeCloseTo(e.cp2.y, precision);
		expect(a.end.x).toBeCloseTo(e.end.x, precision);
		expect(a.end.y).toBeCloseTo(e.end.y, precision);
	}
}

describe("rotation: preview vs finalized coordinate consistency", () => {
	it("single element, identity transform, 45° rotation", () => {
		// Segments: start(-40,-30), cp1(-40,-30), cp2(40,30), end(40,30)
		// localBounds center = (0,0), identity → rotation center = (0,0)
		// 45° rotation of (-40,-30) around (0,0):
		//   x = -40·cos45 + 30·sin45 = (-40+30)·√2/2 = -10·0.70711 ≈ -7.0711
		//   y = -40·sin45 - 30·cos45 = (-40-30)·√2/2 = -70·0.70711 ≈ -49.4975
		const element: Path = {
			id: "p1",
			type: "path",
			segments: [
				seg(
					{ x: -40, y: -30 },
					{ x: 0, y: 0 },
					{ x: 0, y: 0 },
					{ x: 40, y: 30 },
				),
			],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};

		const angleDelta = Math.PI / 4;
		const bounds = calculateElementBounds(element);
		const cx = (bounds.minX + bounds.maxX) / 2;
		const cy = (bounds.minY + bounds.maxY) / 2;
		expect(cx).toBeCloseTo(0, 10);
		expect(cy).toBeCloseTo(0, 10);

		const preview = computePreview(
			getWorldSegments(element),
			angleDelta,
			cx,
			cy,
		);

		const t = getTransform(element);
		const updated: Path = {
			...element,
			transform: { ...t, rotation: t.rotation + angleDelta },
		};
		const finalized = getWorldSegments(updated);

		// Absolute value check (hand-computed)
		const S = Math.SQRT2 / 2; // ≈ 0.70711
		expect(finalized[0].start!.x).toBeCloseTo(-10 * S, 4);
		expect(finalized[0].start!.y).toBeCloseTo(-70 * S, 4);
		expect(finalized[0].end.x).toBeCloseTo(10 * S, 4);
		expect(finalized[0].end.y).toBeCloseTo(70 * S, 4);

		// Relative check (preview ≈ finalized)
		assertSegmentsClose(finalized, preview);
	});

	it("single element, existing rotation + translation, 60° rotation", () => {
		// Initial transform: rotation=π/6, translation=(15,-10)
		// localBounds center=(0,0), origin=(0,0)
		// Total rotation after adding 60° = π/6+π/3 = π/2 (90°)
		// For start(-40,-30) with total rot=π/2:
		//   sx=-40, sy=-30, cos(π/2)=0, sin(π/2)=1
		//   x = -40·0 - (-30)·1 + 0 + 15 = 30 + 15 = 45
		//   y = -40·1 + (-30)·0 + 0 + (-10) = -40 - 10 = -50
		const element: Path = {
			id: "p1",
			type: "path",
			segments: [
				seg(
					{ x: -40, y: -30 },
					{ x: 5, y: 3 },
					{ x: -5, y: -3 },
					{ x: 40, y: 30 },
				),
			],
			opacity: 1,
			blendMode: "normal",
			transform: { x: 15, y: -10, rotation: Math.PI / 6, scaleX: 1, scaleY: 1 },
		};

		const angleDelta = Math.PI / 3;
		const bounds = calculateElementBounds(element);
		const cx = (bounds.minX + bounds.maxX) / 2;
		const cy = (bounds.minY + bounds.maxY) / 2;

		const preview = computePreview(
			getWorldSegments(element),
			angleDelta,
			cx,
			cy,
		);

		const t = getTransform(element);
		const updated: Path = {
			...element,
			transform: { ...t, rotation: t.rotation + angleDelta },
		};
		const finalized = getWorldSegments(updated);

		// Absolute value check — total rotation = π/2, so cos=0, sin=1
		expect(finalized[0].start!.x).toBeCloseTo(45, 4);
		expect(finalized[0].start!.y).toBeCloseTo(-50, 4);
		expect(finalized[0].end.x).toBeCloseTo(-15, 4);
		expect(finalized[0].end.y).toBeCloseTo(30, 4);
		// cp1 resolved = (-40+5, -30+3) = (-35, -27)
		// With rot=π/2: x = -35·0-(-27)·1+15 = 27+15 = 42, y = -35·1+(-27)·0-10 = -45
		expect(finalized[0].cp1.x).toBeCloseTo(42, 4);
		expect(finalized[0].cp1.y).toBeCloseTo(-45, 4);

		assertSegmentsClose(finalized, preview);
	});

	it("single element, non-uniform scale, 90° rotation", () => {
		// transform: {x:5, y:-3, rotation:π/6, scaleX:2, scaleY:0.5}
		// localBounds center=(0,0), origin=(0,0)
		// After adding π/2: total rotation = π/6 + π/2 = 2π/3
		// cos(2π/3)=-0.5, sin(2π/3)=√3/2
		// For start(-40,-30): sx=-40·2=-80, sy=-30·0.5=-15
		//   x = -80·(-0.5) - (-15)·(√3/2) + 0 + 5 = 40 + 15·√3/2 + 5 ≈ 57.990
		//   y = -80·(√3/2) + (-15)·(-0.5) + 0 + (-3) = -80·√3/2 + 7.5 - 3 ≈ -64.782
		const element: Path = {
			id: "p1",
			type: "path",
			segments: [
				seg(
					{ x: -40, y: -30 },
					{ x: 0, y: 0 },
					{ x: 0, y: 0 },
					{ x: 40, y: 30 },
				),
			],
			opacity: 1,
			blendMode: "normal",
			transform: { x: 5, y: -3, rotation: Math.PI / 6, scaleX: 2, scaleY: 0.5 },
		};

		const angleDelta = Math.PI / 2;
		const bounds = calculateElementBounds(element);
		const cx = (bounds.minX + bounds.maxX) / 2;
		const cy = (bounds.minY + bounds.maxY) / 2;

		const preview = computePreview(
			getWorldSegments(element),
			angleDelta,
			cx,
			cy,
		);

		const t = getTransform(element);
		const updated: Path = {
			...element,
			transform: { ...t, rotation: t.rotation + angleDelta },
		};
		const finalized = getWorldSegments(updated);

		// Absolute value check
		const S3h = Math.sqrt(3) / 2; // √3/2 ≈ 0.86603
		expect(finalized[0].start!.x).toBeCloseTo(40 + 15 * S3h + 5, 3);
		expect(finalized[0].start!.y).toBeCloseTo(-80 * S3h + 7.5 - 3, 3);
		expect(finalized[0].end.x).toBeCloseTo(-40 - 15 * S3h + 5, 3);
		expect(finalized[0].end.y).toBeCloseTo(80 * S3h - 7.5 - 3, 3);

		assertSegmentsClose(finalized, preview);
	});

	it("two elements, identity transforms, 45° rotation around group center", () => {
		// el1: start(-40,-30), end(-20,-10). localBoundsCenter=(-30,-20)
		// el2: start(20,10), end(40,30). localBoundsCenter=(30,20)
		// Group bounds: min(-40,-30), max(40,30) → group center=(0,0)
		// 45° rotation of el1.start(-40,-30) around (0,0):
		//   x = (-40+30)·√2/2 = -10·0.70711 ≈ -7.0711
		//   y = (-40-30)·√2/2 = -70·0.70711 ≈ -49.4975
		const el1: Path = {
			id: "p1",
			type: "path",
			segments: [
				seg(
					{ x: -40, y: -30 },
					{ x: 0, y: 0 },
					{ x: 0, y: 0 },
					{ x: -20, y: -10 },
				),
			],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};
		const el2: Path = {
			id: "p2",
			type: "path",
			segments: [
				seg({ x: 20, y: 10 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 40, y: 30 }),
			],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};

		const angleDelta = Math.PI / 4;

		const b1 = calculateElementBounds(el1);
		const b2 = calculateElementBounds(el2);
		const cx = (Math.min(b1.minX, b2.minX) + Math.max(b1.maxX, b2.maxX)) / 2;
		const cy = (Math.min(b1.minY, b2.minY) + Math.max(b1.maxY, b2.maxY)) / 2;
		expect(cx).toBeCloseTo(0, 10);
		expect(cy).toBeCloseTo(0, 10);

		const preview1 = computePreview(getWorldSegments(el1), angleDelta, cx, cy);
		const preview2 = computePreview(getWorldSegments(el2), angleDelta, cx, cy);

		const cos = Math.cos(angleDelta);
		const sin = Math.sin(angleDelta);
		const elementsMap = new Map<string, AnyArtObject>([
			[el1.id, el1],
			[el2.id, el2],
		]);

		function applyMultiRotation(el: Path): Path {
			const t = getTransform(el);
			const localBounds = calculateLocalElementBounds(el, elementsMap);
			const localCx = (localBounds.minX + localBounds.maxX) / 2;
			const localCy = (localBounds.minY + localBounds.maxY) / 2;
			const vcx = localCx + t.x;
			const vcy = localCy + t.y;
			const newVcx = cx + (vcx - cx) * cos - (vcy - cy) * sin;
			const newVcy = cy + (vcx - cx) * sin + (vcy - cy) * cos;
			return {
				...el,
				transform: {
					...t,
					x: newVcx - localCx,
					y: newVcy - localCy,
					rotation: t.rotation + angleDelta,
				},
			};
		}

		const finalized1 = getWorldSegments(applyMultiRotation(el1));
		const finalized2 = getWorldSegments(applyMultiRotation(el2));

		// Absolute value check for el1.start
		const S = Math.SQRT2 / 2;
		expect(finalized1[0].start!.x).toBeCloseTo(-10 * S, 4);
		expect(finalized1[0].start!.y).toBeCloseTo(-70 * S, 4);
		// el1.end(-20,-10): x = (-20+10)·S = -10·S, y = (-20-10)·S = -30·S
		expect(finalized1[0].end.x).toBeCloseTo(-10 * S, 4);
		expect(finalized1[0].end.y).toBeCloseTo(-30 * S, 4);
		// el2.start(20,10): x = (20-10)·S = 10·S, y = (20+10)·S = 30·S
		expect(finalized2[0].start!.x).toBeCloseTo(10 * S, 4);
		expect(finalized2[0].start!.y).toBeCloseTo(30 * S, 4);
		// el2.end(40,30): x = (40-30)·S = 10·S, y = (40+30)·S = 70·S
		expect(finalized2[0].end.x).toBeCloseTo(10 * S, 4);
		expect(finalized2[0].end.y).toBeCloseTo(70 * S, 4);

		assertSegmentsClose(finalized1, preview1);
		assertSegmentsClose(finalized2, preview2);
	});

	it("two elements with offsets, 30° rotation around group center", () => {
		const el1: Path = {
			id: "p1",
			type: "path",
			segments: [
				seg(
					{ x: -40, y: -30 },
					{ x: 3, y: 2 },
					{ x: -3, y: -2 },
					{ x: -20, y: -10 },
				),
			],
			opacity: 1,
			blendMode: "normal",
			transform: { x: -50, y: 20, rotation: Math.PI / 8, scaleX: 1, scaleY: 1 },
		};
		const el2: Path = {
			id: "p2",
			type: "path",
			segments: [
				seg(
					{ x: 20, y: 10 },
					{ x: -2, y: 4 },
					{ x: 2, y: -4 },
					{ x: 40, y: 30 },
				),
			],
			opacity: 1,
			blendMode: "normal",
			transform: {
				x: 30,
				y: -15,
				rotation: -Math.PI / 4,
				scaleX: 1.5,
				scaleY: 0.8,
			},
		};

		const angleDelta = Math.PI / 6;

		const b1 = calculateElementBounds(el1);
		const b2 = calculateElementBounds(el2);
		const cx = (Math.min(b1.minX, b2.minX) + Math.max(b1.maxX, b2.maxX)) / 2;
		const cy = (Math.min(b1.minY, b2.minY) + Math.max(b1.maxY, b2.maxY)) / 2;

		const preview1 = computePreview(getWorldSegments(el1), angleDelta, cx, cy);
		const preview2 = computePreview(getWorldSegments(el2), angleDelta, cx, cy);

		const cos = Math.cos(angleDelta);
		const sin = Math.sin(angleDelta);
		const elementsMap = new Map<string, AnyArtObject>([
			[el1.id, el1],
			[el2.id, el2],
		]);

		function applyMultiRotation(el: Path): Path {
			const t = getTransform(el);
			const localBounds = calculateLocalElementBounds(el, elementsMap);
			const localCx = (localBounds.minX + localBounds.maxX) / 2;
			const localCy = (localBounds.minY + localBounds.maxY) / 2;
			const vcx = localCx + t.x;
			const vcy = localCy + t.y;
			const newVcx = cx + (vcx - cx) * cos - (vcy - cy) * sin;
			const newVcy = cy + (vcx - cx) * sin + (vcy - cy) * cos;
			return {
				...el,
				transform: {
					...t,
					x: newVcx - localCx,
					y: newVcy - localCy,
					rotation: t.rotation + angleDelta,
				},
			};
		}

		const finalized1 = getWorldSegments(applyMultiRotation(el1));
		const finalized2 = getWorldSegments(applyMultiRotation(el2));

		// Absolute: verify finalized values are not all-zero or identity
		// (guards against getWorldSegments silently returning raw coords)
		const el1OrigWorld = getWorldSegments(el1);
		expect(finalized1[0].start!.x).not.toBeCloseTo(el1OrigWorld[0].start!.x, 2);
		expect(finalized2[0].start!.x).not.toBeCloseTo(
			getWorldSegments(el2)[0].start!.x,
			2,
		);

		assertSegmentsClose(finalized1, preview1);
		assertSegmentsClose(finalized2, preview2);
	});
});

describe("SelectTool rotation integration", () => {
	it("rotation drag: pathSegments preview matches getWorldSegments after commit", () => {
		const elementId = "path-1";
		const layer: Layer = {
			id: "layer-1",
			name: "Layer 1",
			visible: true,
			locked: false,
			opacity: 1,
			blendMode: "normal",
			elementIds: [elementId],
		};

		const element: Path = {
			id: elementId,
			type: "path",
			segments: [
				seg(
					{ x: -50, y: -50 },
					{ x: 0, y: 0 },
					{ x: 0, y: 0 },
					{ x: 50, y: 50 },
				),
			],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};

		const bounds = calculateElementBounds(element);

		const context = createMockToolContext({
			getCurrentLayer: () => layer,
			getSelectedElementIds: () => [elementId],
			findElementAtPoint: () => element,
			getElement: () => element,
			getBounds: () => bounds,
			getElementWorldSegments: () => getWorldSegments(element),
			getAncestorTransform: () => null,
		});

		const tool = new SelectTool(context);
		tool.refreshUI();

		// Rotation handle is at (midX, maxY + 24/zoom).
		// bounds center = (0, 0), maxY = 50, so handle at world (0, 74).
		// screen coords: (400, 300 - 74) = (400, 226)
		const handleScreenX = 400;
		const handleScreenY = 226;

		tool.onPointerDown(
			ev(handleScreenX, handleScreenY),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		// Move to create rotation. The rotation center is (0, 0).
		// Start angle = atan2(74, 0) = π/2
		// Move to world(-74, 0) → screen(400-74, 300) = (326, 300)
		// Current angle = atan2(0, -74) = π
		// angleDelta = π - π/2 = π/2 (90°)
		tool.onPointerMove(
			ev(326, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		// Capture preview pathSegments from the last uiUpdateSelectionUI call
		const uiCalls = context.uiUpdateSelectionUI.mock.calls;
		expect(uiCalls.length).toBeGreaterThan(0);
		const lastUI = uiCalls.at(-1)![0] as SelectionUIData;
		expect("pathSegments" in lastUI).toBe(true);
		const previewSegments = lastUI.pathSegments;
		expect(previewSegments).toBeDefined();
		expect(previewSegments!.length).toBe(1);

		// Now release → finalizeRotateDrag should call elementRotate
		tool.onPointerUp(
			ev(326, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(context.elementRotate).toHaveBeenCalledTimes(1);
		const [rotId, angleDeg] = context.elementRotate.mock.calls[0];
		expect(rotId).toBe(elementId);
		// angleDelta should be ≈ 90°
		expect(angleDeg).toBeCloseTo(90, 1);

		// Apply the committed rotation to the element
		const angleRad = (angleDeg * Math.PI) / 180;
		const t = getTransform(element);
		const updatedElement: Path = {
			...element,
			transform: { ...t, rotation: t.rotation + angleRad },
		};

		const finalizedSegs = getWorldSegments(updatedElement);

		// Absolute value check: 90° rotation of (-50,-50) around (0,0)
		// cos(π/2)=0, sin(π/2)=1
		// x = -50·0 - (-50)·1 = 50,  y = -50·1 + (-50)·0 = -50
		expect(finalizedSegs[0].start!.x).toBeCloseTo(50, 3);
		expect(finalizedSegs[0].start!.y).toBeCloseTo(-50, 3);
		// end(50,50) → x = 50·0 - 50·1 = -50,  y = 50·1 + 50·0 = 50
		expect(finalizedSegs[0].end.x).toBeCloseTo(-50, 3);
		expect(finalizedSegs[0].end.y).toBeCloseTo(50, 3);

		// Preview from handleRotateDrag should also match these absolute values
		expect(previewSegments![0][0].start!.x).toBeCloseTo(50, 3);
		expect(previewSegments![0][0].start!.y).toBeCloseTo(-50, 3);
		expect(previewSegments![0][0].end.x).toBeCloseTo(-50, 3);
		expect(previewSegments![0][0].end.y).toBeCloseTo(50, 3);

		// And preview ≈ finalized
		assertSegmentsClose(finalizedSegs, previewSegments![0]);
	});
});

describe("SelectTool selection outline", () => {
	it("shows the clip path outline (not the clipped children) while dragging a clip group", () => {
		const clipPath: Path = {
			id: "clip-path",
			type: "path",
			segments: [
				seg(
					{ x: -50, y: -50 },
					{ x: 0, y: 0 },
					{ x: 0, y: 0 },
					{ x: 50, y: 50 },
				),
			],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};
		const content: Path = {
			id: "content",
			type: "path",
			segments: [
				seg(
					{ x: -10, y: -10 },
					{ x: 0, y: 0 },
					{ x: 0, y: 0 },
					{ x: 10, y: 10 },
				),
			],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};
		const clipGroup: Group = {
			id: "clip-group",
			type: "group",
			childIds: ["clip-path", "content"],
			clipPathId: "clip-path",
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};
		const objects: Record<string, AnyArtObject> = {
			"clip-group": clipGroup,
			"clip-path": clipPath,
			content,
		};
		const layer: Layer = {
			id: "layer-1",
			name: "Layer 1",
			visible: true,
			locked: false,
			opacity: 1,
			blendMode: "normal",
			elementIds: ["clip-group"],
		};
		const bounds = brandWorldBBox({
			minX: -50,
			minY: -50,
			maxX: 50,
			maxY: 50,
			width: 100,
			height: 100,
		});

		const context = createMockToolContext({
			getCurrentLayer: () => layer,
			getSelectedElementIds: () => ["clip-group"],
			findElementAtPoint: () => clipGroup,
			getElement: (id) => objects[id] ?? null,
			getBounds: () => bounds,
			getElementWorldSegments: (id) =>
				id === "clip-path" ? getWorldSegments(clipPath) : null,
			getAncestorTransform: () => null,
			snapElements: (
				_ids,
				_originalBounds,
				proposedDeltaX,
				proposedDeltaY,
			) => ({
				deltaX: proposedDeltaX,
				deltaY: proposedDeltaY,
				snapLines: [],
			}),
		});

		const tool = new SelectTool(context);
		tool.refreshUI();

		// Start a move drag on the already-selected clip group.
		tool.onPointerDown(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(430, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const uiCalls = context.uiUpdateSelectionUI.mock.calls;
		expect(uiCalls.length).toBeGreaterThan(0);
		const lastUI = uiCalls.at(-1)![0] as SelectionUIData;
		const outlines = lastUI.pathSegments;
		expect(outlines).toBeDefined();
		// Only the clip path shape is outlined — the clipped children are not.
		expect(outlines!.length).toBe(1);
		expect(outlines![0][0].start!.x).toBeCloseTo(-50, 3);
		expect(outlines![0][0].start!.y).toBeCloseTo(-50, 3);
		expect(outlines![0][0].end.x).toBeCloseTo(50, 3);
		expect(outlines![0][0].end.y).toBeCloseTo(50, 3);
	});
});

describe("SelectTool onDoubleClick (editing scope)", () => {
	const layer: Layer = {
		id: "layer-1",
		name: "Layer 1",
		visible: true,
		locked: false,
		opacity: 1,
		blendMode: "normal",
		elementIds: ["path-1"],
	};

	function makePath(id: string): Path {
		return {
			id,
			type: "path",
			segments: [],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};
	}

	function doubleClick(tool: SelectTool) {
		tool.onDoubleClick(
			ev(400, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
	}

	it("should enter an editing scope when double-clicking a single path", () => {
		const element = makePath("path-1");
		const context = createMockToolContext({
			getCurrentLayer: () => layer,
			findElementAtPoint: () => element,
		});
		const tool = new SelectTool(context);

		doubleClick(tool);

		expect(context.enterEditingScope.mock.calls[0][0]).toBe("path-1");
	});

	it("should open the text editor instead of a scope when double-clicking a text element", () => {
		const style = createDefaultTextStyle();
		const element: TextElement = {
			id: "text-1",
			type: "text",
			x: 0,
			y: 0,
			content: {
				paragraphs: [
					{
						runs: [{ text: "hello", style: { ...style } }],
						alignment: "left",
						lineHeight: 1.2,
						indent: 0,
						spacing: { before: 0, after: 0 },
					},
				],
			},
			defaultStyle: { ...style },
			layout: {
				writingMode: "horizontal-tb",
				boxWidth: "auto",
				boxHeight: "auto",
				overflow: "visible",
				wordWrap: false,
			},
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};
		const context = createMockToolContext({
			getCurrentLayer: () => layer,
			findElementAtPoint: () => element,
		});
		const tool = new SelectTool(context);

		doubleClick(tool);

		expect(context.textEdit).toHaveBeenCalledTimes(1);
		expect(context.enterEditingScope).not.toHaveBeenCalled();
	});

	it("should nest into an editable single child inside a container scope", () => {
		const child = makePath("child-path");
		const context = createMockToolContext({
			getCurrentLayer: () => layer,
			getEditingScopeId: () => "group-1",
			isElementEditable: () => true,
			findElementAtPoint: () => child,
		});
		const tool = new SelectTool(context);

		doubleClick(tool);

		expect(context.enterEditingScope.mock.calls[0][0]).toBe("child-path");
	});

	it("should do nothing when double-clicking the scope element itself", () => {
		const element = makePath("path-1");
		const context = createMockToolContext({
			getCurrentLayer: () => layer,
			getEditingScopeId: () => "path-1",
			isElementEditable: (id: string) => id === "path-1",
			findElementAtPoint: () => element,
		});
		const tool = new SelectTool(context);

		doubleClick(tool);

		expect(context.enterEditingScope).not.toHaveBeenCalled();
		expect(context.exitEditingScopeOneLevel).not.toHaveBeenCalled();
	});

	it("should exit one level when double-clicking outside any editable element in a scope", () => {
		const context = createMockToolContext({
			getCurrentLayer: () => layer,
			getEditingScopeId: () => "path-1",
			findElementAtPoint: () => null,
		});
		const tool = new SelectTool(context);

		doubleClick(tool);

		expect(context.exitEditingScopeOneLevel).toHaveBeenCalledTimes(1);
		expect(context.enterEditingScope).not.toHaveBeenCalled();
	});
});

describe("SelectTool key object selection", () => {
	const layer: Layer = {
		id: "layer-1",
		name: "Layer 1",
		visible: true,
		locked: false,
		opacity: 1,
		blendMode: "normal",
		elementIds: ["el-1", "el-2"],
	};
	const clicked: AnyArtObject = {
		id: "el-1",
		type: "path",
		segments: [],
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
	const clickedBounds = brandWorldBBox({
		minX: -50,
		minY: -50,
		maxX: 50,
		maxY: 50,
		width: 100,
		height: 100,
	});

	function contextWith(selectedIds: string[]) {
		return createMockToolContext({
			getCurrentLayer: () => layer,
			getSelectedElementIds: () => selectedIds,
			findElementAtPoint: () => clicked,
			getBounds: () => clickedBounds,
		});
	}

	it("makes an already-selected element the key object on a plain click within a multi-selection", () => {
		const context = contextWith(["el-1", "el-2"]);
		const tool = new SelectTool(context);

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

		expect(context.setKeyObject).toHaveBeenCalledWith("el-1");
		// Selection must not collapse to the single clicked element.
		expect(context.elementSelect).not.toHaveBeenCalled();
	});

	it("collapses to a single selection (no key object) with a single element selected", () => {
		const context = contextWith(["el-1"]);
		const tool = new SelectTool(context);

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

		expect(context.setKeyObject).not.toHaveBeenCalled();
		expect(context.elementSelect).toHaveBeenCalledWith("el-1", clickedBounds);
	});

	it("does not set a key object when a modifier key is held", () => {
		const context = contextWith(["el-1", "el-2"]);
		const tool = new SelectTool(context);

		tool.onPointerDown(
			ev(400, 300, { altKey: true }),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(
			ev(400, 300, { altKey: true }),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(context.setKeyObject).not.toHaveBeenCalled();
		expect(context.elementSelect).toHaveBeenCalledWith("el-1", clickedBounds);
	});
});

describe("SelectTool repeat grid gizmo", () => {
	function imageSource(): ImageObject {
		return {
			id: "src-1",
			type: "image",
			fileUid: "file-1",
			x: 0,
			y: 0,
			width: 100,
			height: 100,
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};
	}

	function makeRepeatHarness() {
		const source = imageSource();
		// A 2x2 fill region so bounds are (-50,-170)..(170,50).
		const repeat: AnyArtObject = {
			...createRepeatObject([source.id]),
			grid: { width: 120, height: 120, spacingX: 120, spacingY: 120 },
		};
		const objects: Record<string, AnyArtObject> = {
			[repeat.id]: repeat,
			[source.id]: source,
		};
		const bounds = calculateElementBounds(
			repeat,
			new Map(Object.entries(objects)),
		);
		const context = createMockToolContext({
			getSelectedElementIds: () => [repeat.id],
			getElement: (id) => objects[id] ?? null,
			getBounds: () => bounds,
			getObjects: () => objects,
		});
		const tool = new SelectTool(context);
		tool.refreshUI();
		return { tool, context, repeat };
	}

	it("should set the fill region when dragging the region-resize handle", () => {
		const { tool, context, repeat } = makeRepeatHarness();

		// Grid bounds == the fill region (-50,-70)..(70,50). The region handle sits
		// ~22px past the bottom-right corner (70,-70) → world (92,-92) = screen
		// (492,392). The drag is delta-based: moving +40,+40 in world (to screen
		// 532,432) grows width/height from 120 to 160.
		tool.onPointerDown(
			ev(492, 392),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(532, 432),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const call = context.mockCommands.updateRepeatGrid.mock.calls.at(-1);
		expect(call?.[0]).toBe(repeat.id);
		expect(call?.[1]).toEqual({ width: 160, height: 160 });
	});

	it("should change column spacing when dragging the spacing-x handle", () => {
		const { tool, context, repeat } = makeRepeatHarness();

		// Grid bounds == the fill region (-50,-70)..(70,50), width 120. The column
		// spacing handle sits ON the top edge a quarter-span in from the left
		// corner: world (-20,50) = screen (380,250). Dragging +40 right widens the
		// column gap: 120 → 160.
		tool.onPointerDown(
			ev(380, 250),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(420, 250),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const call = context.mockCommands.updateRepeatGrid.mock.calls.at(-1);
		expect(call?.[0]).toBe(repeat.id);
		expect(call?.[1]).toEqual({ spacingX: 160 });
	});
});

describe("SelectTool repeat radial gizmo", () => {
	function imageSource(): ImageObject {
		return {
			id: "src-1",
			type: "image",
			fileUid: "file-1",
			x: 0,
			y: 0,
			width: 100,
			height: 100,
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};
	}

	it("should set radius and start angle when dragging the radius handle", () => {
		const source = imageSource();
		const repeat: AnyArtObject = {
			...createRepeatObject([source.id]),
			mode: "radial",
			radial: {
				count: 6,
				radius: 160,
				startAngle: 0,
				sweep: Math.PI * 2,
				rotateInstances: true,
			},
		};
		const objects: Record<string, AnyArtObject> = {
			[repeat.id]: repeat,
			[source.id]: source,
		};
		const bounds = calculateElementBounds(
			repeat,
			new Map(Object.entries(objects)),
		);
		const context = createMockToolContext({
			getSelectedElementIds: () => [repeat.id],
			getElement: (id) => objects[id] ?? null,
			getBounds: () => bounds,
			getObjects: () => objects,
		});
		const tool = new SelectTool(context);
		tool.refreshUI();

		// Source center (0,0); the first-copy (radius) handle sits one radius up at
		// world (0,-160) = screen (400,460). Dragging to world (0,-200) = screen
		// (400,500) sets radius 200, start angle 0.
		tool.onPointerDown(
			ev(400, 460),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerMove(
			ev(400, 500),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		const call = context.mockCommands.updateRepeatRadial.mock.calls.at(-1);
		expect(call?.[0]).toBe(repeat.id);
		expect(call?.[1].radius).toBeCloseTo(200, 4);
		expect(call?.[1].startAngle).toBeCloseTo(0, 4);
	});
});
