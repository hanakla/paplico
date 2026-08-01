import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	CirclePrimitive,
	PolylinePrimitive,
	UIOverlay,
} from "../renderer/ui/primitives";
import { UI_THEME } from "../renderer/ui/theme";
import type {
	AnyArtObject,
	BoundingBox,
	ElementTransform,
	FillAppearance,
	ImageObject,
	MeshArtObject,
	Path,
} from "../schema";
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
	brandWorldBBox,
	calculateElementBounds,
	type WorldBBox,
} from "../utils/geometry/bounds";
import {
	evalEdge,
	getDisplayedMeshHandle,
} from "../utils/geometry/meshGradient";
import {
	getMeshWorldBoundarySegments,
	getWorldSegments,
} from "../utils/geometry/segmentOps";
import { MeshDeformTool } from "./MeshDeformTool";

// --- Factories ---

const identityTransform: ElementTransform = {
	x: 0,
	y: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
};

/** 正方形パス: 4セグメント (0,0)→(100,0)→(100,100)→(0,100)→(0,0) */
function createSquarePath(id = "path-square"): Path {
	return {
		id,
		type: "path",
		width: 1,
		opacity: 1,
		blendMode: "normal",
		visible: true,
		locked: false,
		filters: [],
		transform: { ...identityTransform },
		segments: [
			{
				start: { x: 0, y: 0 },
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: 100, y: 0 },
			},
			{
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: 100, y: 100 },
			},
			{
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: 0, y: 100 },
			},
			{
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: 0, y: 0 },
			},
		],
		closed: true,
		bounds: {
			minX: 0,
			minY: 0,
			maxX: 100,
			maxY: 100,
			width: 100,
			height: 100,
		},
	} as unknown as Path;
}

function createImage(id = "img-1", x = 50, y = 50): ImageObject {
	return {
		id,
		type: "image",
		opacity: 1,
		blendMode: "normal",
		visible: true,
		locked: false,
		filters: [],
		transform: { ...identityTransform },
		x,
		y,
		width: 100,
		height: 100,
		fileUid: "file-1",
		bounds: {
			minX: x,
			minY: y,
			maxX: x + 100,
			maxY: y + 100,
			width: 100,
			height: 100,
		},
	} as unknown as ImageObject;
}

function createMesh(id = "mesh-1"): MeshArtObject {
	return {
		id,
		type: "mesh",
		opacity: 1,
		blendMode: "normal",
		visible: true,
		locked: false,
		filters: [],
		transform: { ...identityTransform, x: 100, y: 40 },
		childIds: [],
		vertices: [
			{ x: 0, y: 0, src: { x: 0, y: 0 }, handles: {} },
			{ x: 100, y: 0, src: { x: 100, y: 0 }, handles: {} },
			{ x: 100, y: 100, src: { x: 100, y: 100 }, handles: {} },
			{ x: 0, y: 100, src: { x: 0, y: 100 }, handles: {} },
		],
		faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
	};
}

/** elements / bounds を保持するレジストリ */
function createElementRegistry(elements: AnyArtObject[]) {
	const map = new Map<string, AnyArtObject>();
	const boundsMap = new Map<string, WorldBBox>();
	for (const el of elements) {
		map.set(el.id, el);
		if ("bounds" in el && el.bounds)
			boundsMap.set(el.id, brandWorldBBox(el.bounds as BoundingBox));
	}
	return {
		getElement: (id: string) => map.get(id) ?? null,
		getBounds: (id: string) => boundsMap.get(id) ?? null,
	};
}

/** Last "mesh-deform/handles" overlay pushed through the generic channel. */
function lastDeformOverlay(ctx: MockToolContext): UIOverlay | null {
	const call = ctx.uiSetOverlay.mock.calls
		.filter(([key]) => key === "mesh-deform/handles")
		.at(-1);
	return call ? call[1] : null;
}

/** Handle circles carry hitId; selection is encoded in the fill color. */
function getHandles(
	ctx: MockToolContext,
): Array<{ id: string; x: number; y: number; selected: boolean }> {
	const overlay = lastDeformOverlay(ctx);
	if (!overlay) return [];
	return overlay.primitives
		.filter(
			(p): p is CirclePrimitive & { hitId: string } =>
				p.kind === "circle" && p.hitId != null,
		)
		.map((p) => ({
			id: p.hitId,
			x: p.cx,
			y: p.cy,
			selected: p.fill?.color === UI_THEME.colors.meshHandleFillSelected,
		}));
}

/** Lasso polyline primitive from the last overlay (undefined when absent). */
function getLassoPolyline(ctx: MockToolContext): PolylinePrimitive | undefined {
	return lastDeformOverlay(ctx)?.primitives.find(
		(p): p is PolylinePrimitive => p.kind === "polyline",
	);
}

/** Click to add a handle at a world coordinate */
function addHandle(tool: MeshDeformTool, worldX: number, worldY: number) {
	const sx = 400 + worldX;
	const sy = 300 - worldY;
	tool.onPointerDown(
		ev(sx, sy),
		testViewport,
		testCanvasWidth,
		testCanvasHeight,
	);
	tool.onPointerUp(ev(sx, sy), testViewport, testCanvasWidth, testCanvasHeight);
}

// --- Tests ---

describe("MeshDeformTool", () => {
	// viewport(0,0,zoom=1), canvas 800x600:
	//   screen(400,300) → world(0,0)
	//   screen(500,300) → world(100,0)
	//   screen(600,300) → world(200,0)
	//   screen(400,200) → world(0,100)

	describe("gradient deformation", () => {
		it("deforms free-gradient stops and explicit edge handles in world space without mutating appearance data", () => {
			const path = createSquarePath();
			const appearance = {
				uid: "free-gradient-fill",
				processor: "fill",
				enabled: false,
				opacity: 0.65,
				blendMode: "multiply",
				applyToBackdrop: false,
				paramData: {
					version: "7",
					params: {
						fill: {
							type: "free",
							stops: [
								{
									id: "stop-a",
									x: 0.2,
									y: 0.3,
									color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
									edgeCPs: { "stop-b": { x: -0.2, y: 0.3 } },
								},
								{
									id: "stop-b",
									x: 0.8,
									y: 0.7,
									color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
									edgeCPs: { "stop-a": { x: 0.6, y: 0.7 } },
								},
							],
						},
					},
				},
			} satisfies FillAppearance;
			const secondAppearance = {
				...appearance,
				uid: "second-free-gradient-fill",
				enabled: true,
				paramData: {
					version: "1",
					params: {
						fill: {
							type: "free",
							stops: [
								{
									id: "second-stop",
									x: 0.5,
									y: 0.2,
									color: { type: "rgb", r: 0, g: 1, b: 0, a: 1 },
								},
							],
						},
					},
				},
			} satisfies FillAppearance;
			path.filters = [appearance, secondAppearance];
			const originalPath = structuredClone(path);
			const reg = createElementRegistry([path]);
			const ctx = createMockToolContext({
				getSelectedElementIds: vi.fn(() => [path.id]),
				getElement: vi.fn((id) => reg.getElement(id)),
				getBounds: vi.fn((id) => reg.getBounds(id)),
				getCurrentLayerId: vi.fn(() => "layer-1"),
			});
			const tool = new MeshDeformTool(ctx);
			const sourceHandles = [
				{ x: 0, y: 0 },
				{ x: 100, y: 0 },
				{ x: 0, y: 100 },
			];
			for (const point of sourceHandles) addHandle(tool, point.x, point.y);
			const handleIds = getHandles(ctx).map(({ id }) => id);
			const affine = ({ x, y }: { x: number; y: number }) => ({
				x: x + 0.2 * y + 10,
				y: y + 0.1 * x + 5,
			});
			for (const [index, source] of sourceHandles.entries()) {
				moveHandle(tool, ctx, handleIds[index], affine(source));
			}

			tool.applyDeformation({ complete: false });

			expect(ctx.applyDeformation).toHaveBeenCalledTimes(1);
			expect(ctx.complete).not.toHaveBeenCalled();
			const update = vi.mocked(ctx.applyDeformation).mock.calls[0][0][0]
				.updates;
			if (!("segments" in update) || !update.segments || !update.transform) {
				throw new Error("Expected committed path geometry");
			}
			const fillAppearance = update.filters?.find(
				(filter) => filter.uid === appearance.uid,
			) as FillAppearance | undefined;
			if (
				!fillAppearance ||
				fillAppearance.paramData.params.fill.type !== "free"
			) {
				throw new Error("Expected committed free-gradient appearance");
			}
			const gradient = fillAppearance.paramData.params.fill;
			const updatedPath = {
				...path,
				segments: update.segments,
				transform: update.transform,
				filters: update.filters,
			};
			const updatedBounds = calculateElementBounds(updatedPath);
			const toWorld = ({ x, y }: { x: number; y: number }) => ({
				x: updatedBounds.minX + x * updatedBounds.width,
				y: updatedBounds.minY + y * updatedBounds.height,
			});
			const stopA = gradient.stops.find((stop) => stop.id === "stop-a");
			const edgeA = stopA?.edgeCPs?.["stop-b"];
			if (!stopA || !edgeA)
				throw new Error("Expected stop-a and its edge handle");
			const stopAWorld = toWorld(stopA);
			const edgeAWorld = toWorld(edgeA);
			const expectedStopA = affine({ x: 20, y: 30 });
			const expectedEdgeA = affine({ x: -20, y: 30 });
			expect(stopAWorld.x).toBeCloseTo(expectedStopA.x);
			expect(stopAWorld.y).toBeCloseTo(expectedStopA.y);
			expect(edgeAWorld.x).toBeCloseTo(expectedEdgeA.x);
			expect(edgeAWorld.y).toBeCloseTo(expectedEdgeA.y);
			const secondFill = update.filters?.find(
				(filter) => filter.uid === secondAppearance.uid,
			) as FillAppearance | undefined;
			if (!secondFill || secondFill.paramData.params.fill.type !== "free") {
				throw new Error("Expected second committed free-gradient appearance");
			}
			const secondStopWorld = toWorld(
				secondFill.paramData.params.fill.stops[0],
			);
			const expectedSecondStop = affine({ x: 50, y: 20 });
			expect(secondStopWorld.x).toBeCloseTo(expectedSecondStop.x);
			expect(secondStopWorld.y).toBeCloseTo(expectedSecondStop.y);
			expect(gradient.stops.map(({ id, color }) => ({ id, color }))).toEqual(
				appearance.paramData.params.fill.stops.map(({ id, color }) => ({
					id,
					color,
				})),
			);
			expect(fillAppearance).toMatchObject({
				uid: appearance.uid,
				processor: appearance.processor,
				enabled: appearance.enabled,
				opacity: appearance.opacity,
				blendMode: appearance.blendMode,
				applyToBackdrop: appearance.applyToBackdrop,
				paramData: { version: appearance.paramData.version },
			});
			expect(path).toEqual(originalPath);
		});

		it("commits mesh geometry and mesh-gradient deformation while preserving topology and vertex metadata", () => {
			const mesh = createMesh();
			mesh.vertices[0] = {
				...mesh.vertices[0],
				handles: { 1: { x: 30, y: 0 } },
			};
			const appearance = {
				uid: "mesh-gradient-fill",
				processor: "fill",
				opacity: 0.8,
				blendMode: "screen",
				paramData: {
					version: "3",
					params: {
						fill: {
							type: "mesh",
							vertices: [
								{
									x: 0.2,
									y: 0.3,
									color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
									colorMode: "explicit",
									handles: { 1: { x: 0.35, y: 0.3 } },
								},
								{
									x: 0.8,
									y: 0.3,
									color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
									colorMode: "explicit",
									handles: {},
								},
								{
									x: 0.8,
									y: 0.8,
									color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
									colorMode: "explicit",
									handles: {},
								},
								{
									x: 0.2,
									y: 0.8,
									color: { type: "rgb", r: 0, g: 1, b: 0, a: 1 },
									colorMode: "explicit",
									handles: {},
								},
								{
									x: 0.5,
									y: 0.3,
									color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
									colorMode: "derived",
									hidden: true,
									colorSource: {
										kind: "edge",
										edgeVerts: [0, 1],
										t: 0.5,
									},
									meshSource: { edgeVerts: [0, 1], t: 0.5 },
									positionSource: { edgeVerts: [0, 1], t: 0.5 },
									splitLineId: 17,
									subdivisionId: 23,
									subdivisionSource: {
										id: 23,
										vertexCount: 4,
										faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
									},
									handles: {},
								},
							],
							faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
						},
					},
				},
			} satisfies FillAppearance;
			mesh.filters = [appearance];
			const originalMesh = structuredClone(mesh);
			const worldBounds = calculateElementBounds(mesh);
			const ctx = createMockToolContext({
				getSelectedElementIds: vi.fn(() => [mesh.id]),
				getElement: vi.fn(() => mesh),
				getBounds: vi.fn(() => worldBounds),
				getCurrentLayerId: vi.fn(() => "layer-1"),
			});
			const tool = new MeshDeformTool(ctx);
			const sourceHandles = [
				{ x: 100, y: 40 },
				{ x: 200, y: 40 },
				{ x: 100, y: 140 },
			];
			for (const point of sourceHandles) addHandle(tool, point.x, point.y);
			const handleIds = getHandles(ctx).map(({ id }) => id);
			const affine = ({ x, y }: { x: number; y: number }) => ({
				x: x + 0.2 * y + 10,
				y: y + 0.1 * x + 5,
			});
			for (const [index, source] of sourceHandles.entries()) {
				moveHandle(tool, ctx, handleIds[index], affine(source));
			}

			tool.applyDeformation({ complete: false });

			expect(ctx.applyDeformation).toHaveBeenCalledTimes(1);
			expect(ctx.complete).not.toHaveBeenCalled();
			const update = vi.mocked(ctx.applyDeformation).mock.calls[0][0][0]
				.updates;
			if (!("vertices" in update) || !update.vertices || !update.transform) {
				throw new Error("Expected committed mesh geometry");
			}
			expect(update.filters).toBeDefined();
			const updatedMesh = { ...mesh, ...update } as MeshArtObject;
			const updatedBounds = calculateElementBounds(updatedMesh);
			const fillAppearance = update.filters?.find(
				(filter) => filter.uid === appearance.uid,
			) as FillAppearance | undefined;
			if (
				!fillAppearance ||
				fillAppearance.paramData.params.fill.type !== "mesh"
			) {
				throw new Error("Expected committed mesh-gradient appearance");
			}
			const gradient = fillAppearance.paramData.params.fill;
			const toWorld = ({ x, y }: { x: number; y: number }) => ({
				x: updatedBounds.minX + x * updatedBounds.width,
				y: updatedBounds.minY + y * updatedBounds.height,
			});
			const explicitWorld = toWorld(gradient.vertices[0]);
			const explicitHandleWorld = toWorld(gradient.vertices[0].handles[1]);
			const expectedExplicit = affine({ x: 120, y: 70 });
			const expectedHandle = affine({ x: 135, y: 70 });
			expect(explicitWorld.x).toBeCloseTo(expectedExplicit.x);
			expect(explicitWorld.y).toBeCloseTo(expectedExplicit.y);
			expect(explicitHandleWorld.x).toBeCloseTo(expectedHandle.x);
			expect(explicitHandleWorld.y).toBeCloseTo(expectedHandle.y);
			const geometryHandle = update.vertices[0].handles[1];
			const expectedGeometryHandle = affine({ x: 130, y: 40 });
			expect(update.transform.x + geometryHandle.x).toBeCloseTo(
				expectedGeometryHandle.x,
			);
			expect(update.transform.y + geometryHandle.y).toBeCloseTo(
				expectedGeometryHandle.y,
			);
			expect(updatedMesh.faces).toEqual(originalMesh.faces);
			expect(gradient.faces).toEqual(appearance.paramData.params.fill.faces);
			expect(gradient.vertices.map((vertex) => vertex.color)).toEqual(
				appearance.paramData.params.fill.vertices.map((vertex) => vertex.color),
			);
			const derived = gradient.vertices[4];
			const derivedOnEdge = evalEdge(
				gradient.vertices,
				gradient.faces,
				0,
				1,
				0.5,
			);
			expect(derived.x).toBeCloseTo(derivedOnEdge.x);
			expect(derived.y).toBeCloseTo(derivedOnEdge.y);
			expect(derived).toMatchObject({
				colorMode: "derived",
				hidden: true,
				colorSource: appearance.paramData.params.fill.vertices[4].colorSource,
				meshSource: appearance.paramData.params.fill.vertices[4].meshSource,
				positionSource:
					appearance.paramData.params.fill.vertices[4].positionSource,
				splitLineId: 17,
				subdivisionId: 23,
				subdivisionSource:
					appearance.paramData.params.fill.vertices[4].subdivisionSource,
			});
			expect(fillAppearance).toMatchObject({
				uid: appearance.uid,
				processor: appearance.processor,
				opacity: appearance.opacity,
				blendMode: appearance.blendMode,
				paramData: { version: appearance.paramData.version },
			});
			expect(mesh).toEqual(originalMesh);
		});
	});

	describe("初期化", () => {
		it("選択要素がない場合、completeが即座に呼ばれる", () => {
			const ctx = createMockToolContext({
				getSelectedElementIds: vi.fn(() => []),
				getCurrentLayerId: vi.fn(() => "layer-1"),
			});
			const tool = new MeshDeformTool(ctx);
			expect(ctx.complete).toHaveBeenCalledTimes(1);
			expect(tool.name).toBe("mesh-deform");
		});

		it("パスを選択した状態でツールを起動すると、ハンドルなしのメッシュUIが生成される", () => {
			const path = createSquarePath();
			const reg = createElementRegistry([path]);
			const ctx = createMockToolContext({
				getSelectedElementIds: vi.fn(() => [path.id]),
				getElement: vi.fn((id) => reg.getElement(id)),
				getBounds: vi.fn((id) => reg.getBounds(id)),
				getCurrentLayerId: vi.fn(() => "layer-1"),
			});
			new MeshDeformTool(ctx);

			const overlay = lastDeformOverlay(ctx);
			expect(overlay).not.toBeNull();
			// Mesh edges render as line primitives
			expect(
				overlay?.primitives.filter((p) => p.kind === "line").length,
			).toBeGreaterThan(0);
			expect(getHandles(ctx)).toHaveLength(0);
			// Original bounds (0,0)-(100,100) renders as a center+size rect
			const rect = overlay?.primitives.find((p) => p.kind === "rect");
			expect(rect).toMatchObject({ cx: 50, cy: 50, width: 100, height: 100 });
		});
	});

	describe("toolSession", () => {
		it("ハンドル0個でhandleCount=0のセッションが発行され、追加で1になり、キャンセルでクリアされる", () => {
			const path = createSquarePath();
			const reg = createElementRegistry([path]);
			const ctx = createMockToolContext({
				getSelectedElementIds: vi.fn(() => [path.id]),
				getElement: vi.fn((id) => reg.getElement(id)),
				getBounds: vi.fn((id) => reg.getBounds(id)),
				getCurrentLayerId: vi.fn(() => "layer-1"),
			});
			const tool = new MeshDeformTool(ctx);

			// Hint visibility boundary: handleCount === 0 right after init
			expect(ctx.uiSetToolSession.mock.calls.at(-1)?.[0]).toMatchObject({
				type: "mesh-deform",
				handleCount: 0,
				originalBounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
			});

			// Adding a handle crosses the boundary: handleCount === 1
			addHandle(tool, 25, 25);
			expect(ctx.uiSetToolSession.mock.calls.at(-1)?.[0]).toMatchObject({
				handleCount: 1,
			});

			// Cancel clears the session slot
			tool.onCancel();
			expect(ctx.uiSetToolSession.mock.calls.at(-1)?.[0]).toBeNull();
		});
	});

	describe("ハンドル操作", () => {
		let tool: MeshDeformTool;
		let ctx: MockToolContext;

		beforeEach(() => {
			const path = createSquarePath();
			const reg = createElementRegistry([path]);
			ctx = createMockToolContext({
				getSelectedElementIds: vi.fn(() => [path.id]),
				getElement: vi.fn((id) => reg.getElement(id)),
				getBounds: vi.fn((id) => reg.getBounds(id)),
				getCurrentLayerId: vi.fn(() => "layer-1"),
			});
			tool = new MeshDeformTool(ctx);

			// Add 2 handles via clicking
			addHandle(tool, 25, 25);
			addHandle(tool, 75, 75);
		});

		it("メッシュ上の空いた場所をクリックすると新しいハンドルが追加される", () => {
			const initialHandleCount = getHandles(ctx).length;

			// world(50,50) = screen(450,250) をクリック
			// ハンドルのない位置をクリック → 新ハンドル追加
			// PointerDown + PointerUp (ドラッグなし) で新ハンドル追加
			tool.onPointerDown(
				ev(450, 250),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(450, 250),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const handles = getHandles(ctx);
			expect(handles.length).toBe(initialHandleCount + 1);

			// Just-added handle: current position equals the click position
			const newHandle = handles.at(-1);
			expect(newHandle?.x).toBeCloseTo(50);
			expect(newHandle?.y).toBeCloseTo(50);
		});

		it("ハンドルをクリック(ドラッグなし)で選択がトグルされる", () => {
			vi.spyOn(performance, "now").mockReturnValue(0);

			const firstHandle = getHandles(ctx)[0];

			// ハンドル位置をscreen座標に変換: world→screen
			// world(hx, hy) → screen(400 + hx, 300 - hy)
			const sx = 400 + firstHandle.x;
			const sy = 300 - firstHandle.y;

			// PointerDown on handle → PointerUp (no move) → toggle
			vi.spyOn(performance, "now").mockReturnValue(1000);
			tool.onPointerDown(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const toggledHandle = getHandles(ctx).find(
				(h) => h.id === firstHandle.id,
			);
			expect(toggledHandle?.selected).toBe(true);

			// もう一度クリックで選択解除 (300ms以上空けてダブルクリックにならないようにする)
			vi.spyOn(performance, "now").mockReturnValue(2000);
			tool.onPointerDown(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const toggledHandle2 = getHandles(ctx).find(
				(h) => h.id === firstHandle.id,
			);
			expect(toggledHandle2?.selected).toBe(false);

			vi.restoreAllMocks();
		});

		it("ハンドルをドラッグするとpreviewDeformationが呼ばれる", () => {
			const firstHandle = getHandles(ctx)[0];

			const sx = 400 + firstHandle.x;
			const sy = 300 - firstHandle.y;

			tool.onPointerDown(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// 十分なドラッグ距離（>3px screen）で移動
			tool.onPointerMove(
				ev(sx + 30, sy - 30),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.previewDeformation).toHaveBeenCalled();
			const previewCalls = (ctx.previewDeformation as ReturnType<typeof vi.fn>)
				.mock.calls;
			const updates = previewCalls[0][0];
			expect(updates.length).toBeGreaterThan(0);
			expect(updates[0].elementId).toBe("path-square");
			expect(updates[0].layerId).toBe("layer-1");
		});

		it("ドラッグ距離が3px未満だとドラッグモードに遷移しない", () => {
			const firstHandle = getHandles(ctx)[0];

			const sx = 400 + firstHandle.x;
			const sy = 300 - firstHandle.y;

			tool.onPointerDown(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// 1px だけ移動
			tool.onPointerMove(
				ev(sx + 1, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.previewDeformation).not.toHaveBeenCalled();
		});
	});

	describe("確定・キャンセル", () => {
		let tool: MeshDeformTool;
		let ctx: MockToolContext;

		beforeEach(() => {
			const path = createSquarePath();
			const reg = createElementRegistry([path]);
			ctx = createMockToolContext({
				getSelectedElementIds: vi.fn(() => [path.id]),
				getElement: vi.fn((id) => reg.getElement(id)),
				getBounds: vi.fn((id) => reg.getBounds(id)),
				getCurrentLayerId: vi.fn(() => "layer-1"),
			});
			tool = new MeshDeformTool(ctx);

			// Add a handle via clicking
			addHandle(tool, 50, 50);
		});

		it("ハンドル未移動でEnterを押すとapplyDeformation無しでcompleteが呼ばれる", () => {
			const handled = tool.onKeyDown?.(
				{ code: "Enter" } as unknown as KeyboardEvent,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(handled).toBe(true);
			// 変位がないのでapplyDeformationは呼ばれない
			expect(ctx.applyDeformation).not.toHaveBeenCalled();
			expect(ctx.complete).toHaveBeenCalled();
			// UIがクリアされる
			expect(lastDeformOverlay(ctx)).toBeNull();
		});

		it("ハンドルを移動後にEnterを押すとapplyDeformationが呼ばれる", () => {
			const firstHandle = getHandles(ctx)[0];

			const sx = 400 + firstHandle.x;
			const sy = 300 - firstHandle.y;

			// ドラッグしてハンドルを移動
			tool.onPointerDown(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(sx + 50, sy - 50),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(sx + 50, sy - 50),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Enter確定
			tool.onKeyDown?.(
				{ code: "Enter" } as unknown as KeyboardEvent,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.applyDeformation).toHaveBeenCalledTimes(1);
			expect(ctx.complete).toHaveBeenCalled();
		});

		it("applyDeformation()でもEnterと同様に確定される", () => {
			const firstHandle = getHandles(ctx)[0];

			const sx = 400 + firstHandle.x;
			const sy = 300 - firstHandle.y;

			tool.onPointerDown(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(sx + 50, sy - 50),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(sx + 50, sy - 50),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			tool.applyDeformation();

			expect(ctx.applyDeformation).toHaveBeenCalledTimes(1);
			expect(ctx.complete).toHaveBeenCalled();
		});

		it("commits deformation without completing during a tool switch", () => {
			addHandle(tool, 50, 50);
			const handle = getHandles(ctx)[0];
			const screenX = 400 + handle.x;
			const screenY = 300 - handle.y;

			tool.onPointerDown(
				ev(screenX, screenY),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(screenX + 20, screenY - 10),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(screenX + 20, screenY - 10),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			tool.applyDeformation({ complete: false });
			tool.applyDeformation({ complete: false });
			tool.onCancel();

			expect(ctx.applyDeformation).toHaveBeenCalledTimes(1);
			expect(ctx.restoreOriginal).not.toHaveBeenCalled();
			expect(ctx.complete).not.toHaveBeenCalled();
		});

		it("clears only the preview when switching tools without displacement", () => {
			tool.applyDeformation({ complete: false });

			expect(ctx.clearDeformationPreview).toHaveBeenCalledWith(["path-square"]);
			expect(ctx.applyDeformation).not.toHaveBeenCalled();
			expect(ctx.complete).not.toHaveBeenCalled();
		});

		it("clears the deformation preview and restores data on cancel", () => {
			tool.onCancel();

			expect(ctx.clearDeformationPreview).toHaveBeenCalledWith(["path-square"]);
			expect(ctx.restoreOriginal).toHaveBeenCalledTimes(1);
			expect(ctx.complete).toHaveBeenCalledTimes(1);
		});

		it("祖先transform付きpathをworldで変形してlocal geometryへ保存する", () => {
			const path = createSquarePath();
			path.transform = { ...identityTransform, x: 30 };
			const ancestorTransform = { ...identityTransform, x: 70 };
			const worldBounds = brandWorldBBox({
				minX: 100,
				minY: 0,
				maxX: 200,
				maxY: 100,
				width: 100,
				height: 100,
			});
			const ctx = createMockToolContext({
				getSelectedElementIds: vi.fn(() => [path.id]),
				getElement: vi.fn(() => path),
				getBounds: vi.fn(() => worldBounds),
				getAncestorTransform: vi.fn(() => ancestorTransform),
				getCurrentLayerId: vi.fn(() => "layer-1"),
			});
			const tool = new MeshDeformTool(ctx);
			addHandle(tool, 150, 50);
			const handle = getHandles(ctx)[0];
			const screenX = 400 + handle.x;
			const screenY = 300 - handle.y;

			tool.onPointerDown(
				ev(screenX, screenY),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(screenX + 25, screenY - 15),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(screenX + 25, screenY - 15),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.applyDeformation();

			const update = vi.mocked(ctx.applyDeformation).mock.calls[0][0][0]
				.updates;
			if (!("segments" in update)) throw new Error("Expected path update");
			expect(update.segments).toBeDefined();
			expect(update.transform).toBeDefined();
			if (!update.segments || !update.transform)
				throw new Error("Expected path geometry and transform");
			const updatedPath = {
				...path,
				segments: update.segments,
				transform: update.transform,
			};
			const before = getWorldSegments(path, ancestorTransform);
			const after = getWorldSegments(updatedPath, ancestorTransform);
			for (let index = 0; index < before.length; index++) {
				const beforeSegment = before[index];
				const afterSegment = after[index];
				if (!beforeSegment || !afterSegment)
					throw new Error("Expected matching path segments");
				if (beforeSegment.start || afterSegment.start) {
					expect(afterSegment.start?.x).toBeCloseTo(
						(beforeSegment.start?.x ?? 0) + 25,
					);
					expect(afterSegment.start?.y).toBeCloseTo(
						(beforeSegment.start?.y ?? 0) + 15,
					);
				}
				for (const point of ["cp1", "cp2", "end"] as const) {
					expect(afterSegment[point].x).toBeCloseTo(
						beforeSegment[point].x + 25,
					);
					expect(afterSegment[point].y).toBeCloseTo(
						beforeSegment[point].y + 15,
					);
				}
			}
		});

		it("mesh変形後もBBoxとgeometryが選択移動と同じ差分で移動する", () => {
			const mesh = createMesh();
			const worldBounds = calculateElementBounds(mesh);
			const ctx = createMockToolContext({
				getSelectedElementIds: vi.fn(() => [mesh.id]),
				getElement: vi.fn(() => mesh),
				getBounds: vi.fn(() => worldBounds),
				getCurrentLayerId: vi.fn(() => "layer-1"),
			});
			const tool = new MeshDeformTool(ctx);
			addHandle(
				tool,
				(worldBounds.minX + worldBounds.maxX) / 2,
				(worldBounds.minY + worldBounds.maxY) / 2,
			);
			const handle = getHandles(ctx)[0];
			const screenX = 400 + handle.x;
			const screenY = 300 - handle.y;

			tool.onPointerDown(
				ev(screenX, screenY),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(screenX + 30, screenY - 20),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(screenX + 30, screenY - 20),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.applyDeformation();

			const update = vi.mocked(ctx.applyDeformation).mock.calls[0][0][0]
				.updates;
			if (!("vertices" in update)) throw new Error("Expected mesh update");
			expect(update.vertices).toBeDefined();
			expect(update.transform).toBeDefined();
			if (!update.vertices || !update.transform)
				throw new Error("Expected mesh geometry and transform");
			const updatedMesh: MeshArtObject = {
				...mesh,
				vertices: update.vertices,
				transform: update.transform,
			};
			// Cage vertices moved but their source parametrization must survive.
			for (let index = 0; index < updatedMesh.vertices.length; index++) {
				expect(updatedMesh.vertices[index].src).toEqual(
					mesh.vertices[index].src,
				);
			}
			const deformedBoundary = getMeshWorldBoundarySegments(updatedMesh);
			const movedMesh: MeshArtObject = {
				...updatedMesh,
				transform: {
					...updatedMesh.transform,
					x: updatedMesh.transform.x + 25,
					y: updatedMesh.transform.y - 10,
				},
			};
			const movedBoundary = getMeshWorldBoundarySegments(movedMesh);
			for (let index = 0; index < deformedBoundary.length; index++) {
				const deformedSegment = deformedBoundary[index];
				const movedSegment = movedBoundary[index];
				if (!deformedSegment || !movedSegment)
					throw new Error("Expected matching mesh boundary segments");
				if (deformedSegment.start || movedSegment.start) {
					expect(movedSegment.start?.x).toBeCloseTo(
						(deformedSegment.start?.x ?? 0) + 25,
					);
					expect(movedSegment.start?.y).toBeCloseTo(
						(deformedSegment.start?.y ?? 0) - 10,
					);
				}
				for (const point of ["cp1", "cp2", "end"] as const) {
					expect(movedSegment[point].x).toBeCloseTo(
						deformedSegment[point].x + 25,
					);
					expect(movedSegment[point].y).toBeCloseTo(
						deformedSegment[point].y - 10,
					);
				}
			}
			const deformedBounds = calculateElementBounds(updatedMesh);
			const movedBounds = calculateElementBounds(movedMesh);
			expect(movedBounds.minX).toBeCloseTo(deformedBounds.minX + 25);
			expect(movedBounds.minY).toBeCloseTo(deformedBounds.minY - 10);
			expect(movedBounds.maxX).toBeCloseTo(deformedBounds.maxX + 25);
			expect(movedBounds.maxY).toBeCloseTo(deformedBounds.maxY - 10);
		});

		it("onCancelでrestoreOriginalが呼ばれ、元のジオメトリに戻る", () => {
			const firstHandle = getHandles(ctx)[0];

			const sx = 400 + firstHandle.x;
			const sy = 300 - firstHandle.y;

			// ドラッグで変形
			tool.onPointerDown(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(sx + 50, sy - 50),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(sx + 50, sy - 50),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			tool.onCancel();

			expect(ctx.restoreOriginal).toHaveBeenCalledTimes(1);
			const restoreUpdates = (ctx.restoreOriginal as ReturnType<typeof vi.fn>)
				.mock.calls[0][0];
			expect(restoreUpdates[0].elementId).toBe("path-square");
			expect(restoreUpdates[0].updates.segments).toBeDefined();

			expect(ctx.complete).toHaveBeenCalled();
			// UIクリア
			expect(lastDeformOverlay(ctx)).toBeNull();
		});
	});

	describe("Delete/Backspaceでハンドル削除", () => {
		let tool: MeshDeformTool;
		let ctx: MockToolContext;

		beforeEach(() => {
			const path = createSquarePath();
			const reg = createElementRegistry([path]);
			ctx = createMockToolContext({
				getSelectedElementIds: vi.fn(() => [path.id]),
				getElement: vi.fn((id) => reg.getElement(id)),
				getBounds: vi.fn((id) => reg.getBounds(id)),
				getCurrentLayerId: vi.fn(() => "layer-1"),
			});
			tool = new MeshDeformTool(ctx);

			// Add 2 handles via clicking
			addHandle(tool, 25, 25);
			addHandle(tool, 75, 75);
		});

		it("選択中のハンドルがない状態でDeleteを押しても何も起きない", () => {
			const handled = tool.onKeyDown?.(
				{ code: "Delete" } as unknown as KeyboardEvent,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			expect(handled).toBe(false);
		});

		it("ハンドルを選択してDeleteを押すとハンドルが削除される", () => {
			const firstHandle = getHandles(ctx)[0];
			const initialCount = getHandles(ctx).length;

			const sx = 400 + firstHandle.x;
			const sy = 300 - firstHandle.y;

			// クリックで選択
			tool.onPointerDown(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Delete
			const handled = tool.onKeyDown?.(
				{ code: "Delete" } as unknown as KeyboardEvent,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(handled).toBe(true);
			const handles = getHandles(ctx);
			expect(handles.length).toBe(initialCount - 1);
			const deletedHandle = handles.find((h) => h.id === firstHandle.id);
			expect(deletedHandle).toBeUndefined();
		});
	});

	describe("ダブルクリックでハンドル削除", () => {
		let tool: MeshDeformTool;
		let ctx: MockToolContext;

		beforeEach(() => {
			vi.spyOn(performance, "now").mockReturnValue(0);

			const path = createSquarePath();
			const reg = createElementRegistry([path]);
			ctx = createMockToolContext({
				getSelectedElementIds: vi.fn(() => [path.id]),
				getElement: vi.fn((id) => reg.getElement(id)),
				getBounds: vi.fn((id) => reg.getBounds(id)),
				getCurrentLayerId: vi.fn(() => "layer-1"),
			});
			tool = new MeshDeformTool(ctx);

			// Add 2 handles via clicking
			addHandle(tool, 25, 25);
			addHandle(tool, 75, 75);
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("同じハンドルを300ms以内に2回クリックすると削除される", () => {
			const firstHandle = getHandles(ctx)[0];
			const initialCount = getHandles(ctx).length;

			const sx = 400 + firstHandle.x;
			const sy = 300 - firstHandle.y;

			// 1回目クリック (t=1000)
			vi.spyOn(performance, "now").mockReturnValue(1000);
			tool.onPointerDown(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// 2回目クリック (t=1200, 200ms後 < 300ms)
			vi.spyOn(performance, "now").mockReturnValue(1200);
			tool.onPointerDown(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const handles = getHandles(ctx);
			expect(handles.length).toBe(initialCount - 1);
			const deleted = handles.find((h) => h.id === firstHandle.id);
			expect(deleted).toBeUndefined();
		});

		it("300ms以上経過した2回目のクリックはダブルクリックにならない", () => {
			const firstHandle = getHandles(ctx)[0];
			const initialCount = getHandles(ctx).length;

			const sx = 400 + firstHandle.x;
			const sy = 300 - firstHandle.y;

			// 1回目クリック (t=1000)
			vi.spyOn(performance, "now").mockReturnValue(1000);
			tool.onPointerDown(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// 2回目クリック (t=1500, 500ms後 > 300ms)
			vi.spyOn(performance, "now").mockReturnValue(1500);
			tool.onPointerDown(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// ハンドル数は変わらない（選択トグルのみ）
			expect(getHandles(ctx).length).toBe(initialCount);
		});

		it("ダブルクリック後にクリック状態がリセットされ、直後のクリックでダブルクリックにならない", () => {
			const handles = getHandles(ctx);
			if (handles.length < 2) return;

			const h0 = handles[0];
			const h1 = handles[1];

			// h0をダブルクリックで削除
			vi.spyOn(performance, "now").mockReturnValue(1000);
			tool.onPointerDown(
				ev(400 + h0.x, 300 - h0.y),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(400 + h0.x, 300 - h0.y),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			vi.spyOn(performance, "now").mockReturnValue(1100);
			tool.onPointerDown(
				ev(400 + h0.x, 300 - h0.y),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(400 + h0.x, 300 - h0.y),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const countAfterDelete = getHandles(ctx).length;

			// すぐにh1をクリック → ダブルクリックにならず削除されない
			vi.spyOn(performance, "now").mockReturnValue(1200);
			tool.onPointerDown(
				ev(400 + h1.x, 300 - h1.y),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(400 + h1.x, 300 - h1.y),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(getHandles(ctx).length).toBe(countAfterDelete);
		});
	});

	describe("カーソル", () => {
		it("初期状態ではcrosshairを返す", () => {
			const path = createSquarePath();
			const reg = createElementRegistry([path]);
			const ctx = createMockToolContext({
				getSelectedElementIds: vi.fn(() => [path.id]),
				getElement: vi.fn((id) => reg.getElement(id)),
				getBounds: vi.fn((id) => reg.getBounds(id)),
				getCurrentLayerId: vi.fn(() => "layer-1"),
			});
			const tool = new MeshDeformTool(ctx);

			expect(tool.getCursor()).toBe("crosshair");
		});
	});

	describe("画像要素の変形", () => {
		it("画像ハンドルをドラッグするとtransformが更新されたプレビューが生成される", () => {
			const img = createImage("img-1", 50, 50);
			const reg = createElementRegistry([img]);
			const ctx = createMockToolContext({
				getSelectedElementIds: vi.fn(() => [img.id]),
				getElement: vi.fn((id) => reg.getElement(id)),
				getBounds: vi.fn((id) => reg.getBounds(id)),
				getCurrentLayerId: vi.fn(() => "layer-1"),
			});
			const tool = new MeshDeformTool(ctx);

			// Add a handle at the image anchor position
			addHandle(tool, 50, 50);

			const firstHandle = getHandles(ctx)[0];

			// 画像ハンドルの位置 → screen座標
			const sx = 400 + firstHandle.x;
			const sy = 300 - firstHandle.y;

			tool.onPointerDown(
				ev(sx, sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(sx + 30, sy - 30),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.previewDeformation).toHaveBeenCalled();
			const updates = (ctx.previewDeformation as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			expect(updates[0].elementId).toBe("img-1");
			expect(updates[0].updates.transform).toMatchObject({ x: 30, y: 30 });
			expect(updates[0].updates.x).toBeUndefined();
			expect(updates[0].updates.y).toBeUndefined();
		});
	});

	describe("複数要素の同時変形", () => {
		it("パスと画像を同時に選択して変形できる", () => {
			const path = createSquarePath("p1");
			const img = createImage("img-1", 120, 50);
			const reg = createElementRegistry([path, img]);
			const ctx = createMockToolContext({
				getSelectedElementIds: vi.fn(() => ["p1", "img-1"]),
				getElement: vi.fn((id) => reg.getElement(id)),
				getBounds: vi.fn((id) => reg.getBounds(id)),
				getCurrentLayerId: vi.fn(() => "layer-1"),
			});
			const tool = new MeshDeformTool(ctx);

			// Add handles for both elements
			addHandle(tool, 50, 50);
			addHandle(tool, 120, 50);

			// パスのハンドル + 画像のハンドル が存在する
			expect(getHandles(ctx).length).toBeGreaterThan(1);
			// combinedBoundsがパスと画像を包含する:
			// bounds (0,·)-(220,·) → rect cx=110, width=220 (img.x + img.width)
			const rect = lastDeformOverlay(ctx)?.primitives.find(
				(p) => p.kind === "rect",
			);
			expect(rect).toMatchObject({ cx: 110, width: 220 });
		});
	});

	describe("投げ縄選択", () => {
		let tool: MeshDeformTool;
		let ctx: MockToolContext;

		beforeEach(() => {
			const path = createSquarePath();
			const reg = createElementRegistry([path]);
			ctx = createMockToolContext({
				getSelectedElementIds: vi.fn(() => [path.id]),
				getElement: vi.fn((id) => reg.getElement(id)),
				getBounds: vi.fn((id) => reg.getBounds(id)),
				getCurrentLayerId: vi.fn(() => "layer-1"),
			});
			tool = new MeshDeformTool(ctx);

			// Add 2 handles via clicking
			addHandle(tool, 25, 25);
			addHandle(tool, 75, 75);
		});

		it("空き領域をクリック(ドラッグなし)すると新ハンドルが追加される", () => {
			const initialCount = getHandles(ctx).length;

			// world(50,50) = screen(450,250)
			tool.onPointerDown(
				ev(450, 250),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(450, 250),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(getHandles(ctx).length).toBe(initialCount + 1);
		});

		it("空き領域からドラッグすると投げ縄モードになり、lassoPathがUIに含まれる", () => {
			// screen(700, 100) = world(300, 200) → ハンドルのない場所
			tool.onPointerDown(
				ev(700, 100),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// ドラッグ開始（3px超え）
			tool.onPointerMove(
				ev(710, 110),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// さらに移動
			tool.onPointerMove(
				ev(720, 120),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Lasso path renders as a closed polyline primitive
			const lasso = getLassoPolyline(ctx);
			expect(lasso).toBeDefined();
			expect(lasso?.points.length).toBeGreaterThanOrEqual(2);
		});

		it("投げ縄で囲んだハンドルが選択される", () => {
			const handles = getHandles(ctx);

			// ハンドルの1つを囲む大きな投げ縄を描く
			// ハンドル位置を取得: handles[0]
			const h = handles[0];
			const margin = 20;

			// 投げ縄の4隅 (ハンドルを囲む矩形)
			// world座標→screen座標: screen = (400 + wx, 300 - wy)
			const corners = [
				{ sx: 400 + h.x - margin, sy: 300 - h.y - margin },
				{ sx: 400 + h.x + margin, sy: 300 - h.y - margin },
				{ sx: 400 + h.x + margin, sy: 300 - h.y + margin },
				{ sx: 400 + h.x - margin, sy: 300 - h.y + margin },
			];

			// pointerDown (空き領域)
			tool.onPointerDown(
				ev(corners[0].sx, corners[0].sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// ドラッグで投げ縄描画
			for (const c of corners.slice(1)) {
				tool.onPointerMove(
					ev(c.sx, c.sy),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);
			}

			// pointerUp → 投げ縄確定
			tool.onPointerUp(
				ev(corners[3].sx, corners[3].sy),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const selectedHandle = getHandles(ctx).find(
				(handle) => handle.id === h.id,
			);
			expect(selectedHandle?.selected).toBe(true);

			// lassoPathはクリア（updateUIでlassoPathはplacing時undefinedになる）
			expect(getLassoPolyline(ctx)).toBeUndefined();
		});

		it("複数選択したハンドルを同時にドラッグできる", () => {
			vi.spyOn(performance, "now").mockReturnValue(0);

			const handles = getHandles(ctx);
			if (handles.length < 2) return; // テスト不要

			const h0 = handles[0];
			const h1 = handles[1];

			// 2つのハンドルをクリックして選択 (異なるハンドルなのでダブルクリックにはならないが念のためタイミングを離す)
			let t = 1000;
			for (const h of [h0, h1]) {
				vi.spyOn(performance, "now").mockReturnValue(t);
				const sx = 400 + h.x;
				const sy = 300 - h.y;
				tool.onPointerDown(
					ev(sx, sy),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);
				tool.onPointerUp(
					ev(sx, sy),
					testViewport,
					testCanvasWidth,
					testCanvasHeight,
				);
				t += 500;
			}

			// h0をドラッグ → h0とh1の両方が移動する
			const sx0 = 400 + h0.x;
			const sy0 = 300 - h0.y;

			tool.onPointerDown(
				ev(sx0, sy0),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(sx0 + 30, sy0 - 30),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.previewDeformation).toHaveBeenCalled();

			tool.onPointerUp(
				ev(sx0 + 30, sy0 - 30),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const moved = getHandles(ctx);
			const movedH0 = moved.find((handle) => handle.id === h0.id);
			const movedH1 = moved.find((handle) => handle.id === h1.id);

			// 両方とも移動している (h0/h1.x,y はドラッグ前の位置)
			expect(movedH0?.x).toBeCloseTo(h0.x + 30);
			expect(movedH0?.y).toBeCloseTo(h0.y + 30);
			expect(movedH1?.x).toBeCloseTo(h1.x + 30);
			expect(movedH1?.y).toBeCloseTo(h1.y + 30);

			vi.restoreAllMocks();
		});
	});
});

describe("MeshDeformTool mesh-gradient default root handles", () => {
	it("materializes and curves an unstored root handle under a local bump deform", () => {
		// Mesh gradient whose root edges have NO stored handles (implicit straight
		// 1/3 defaults). Before the fix, deform left them unstored, so the edge
		// stayed straight and the displayed handle snapped to the root-root line.
		const mesh = createMesh();
		const appearance = {
			uid: "mesh-gradient-fill",
			processor: "fill",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "3",
				params: {
					fill: {
						type: "mesh",
						vertices: [
							{
								x: 0,
								y: 0,
								color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
								colorMode: "explicit",
								handles: {},
							},
							{
								x: 1,
								y: 0,
								color: { type: "rgb", r: 0, g: 1, b: 0, a: 1 },
								colorMode: "explicit",
								handles: {},
							},
							{
								x: 1,
								y: 1,
								color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
								colorMode: "explicit",
								handles: {},
							},
							{
								x: 0,
								y: 1,
								color: { type: "rgb", r: 1, g: 1, b: 0, a: 1 },
								colorMode: "explicit",
								handles: {},
							},
						],
						faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
					},
				},
			},
		} satisfies FillAppearance;
		mesh.filters = [appearance];
		const worldBounds = calculateElementBounds(mesh);
		const ctx = createMockToolContext({
			getSelectedElementIds: vi.fn(() => [mesh.id]),
			getElement: vi.fn(() => mesh),
			getBounds: vi.fn(() => worldBounds),
			getCurrentLayerId: vi.fn(() => "layer-1"),
		});
		const tool = new MeshDeformTool(ctx);

		// Local bump: pin the 4 mesh corners, pull the left-edge midpoint outward
		// so the left edge (vertices 0↔3) bows left — a non-affine field.
		const pins = [
			{ x: 100, y: 40 },
			{ x: 200, y: 40 },
			{ x: 200, y: 140 },
			{ x: 100, y: 140 },
		];
		const midLeft = { x: 100, y: 90 };
		for (const p of pins) addHandle(tool, p.x, p.y);
		addHandle(tool, midLeft.x, midLeft.y);
		const ids = getHandles(ctx).map(({ id }) => id);
		for (let i = 0; i < pins.length; i++)
			moveHandle(tool, ctx, ids[i], pins[i]);
		moveHandle(tool, ctx, ids[4], { x: 55, y: 90 });

		tool.applyDeformation({ complete: false });

		const update = vi.mocked(ctx.applyDeformation).mock.calls[0][0][0].updates;
		const committed = update.filters?.find((f) => f.uid === appearance.uid) as
			| FillAppearance
			| undefined;
		if (!committed || committed.paramData.params.fill.type !== "mesh") {
			throw new Error("Expected committed mesh-gradient fill");
		}
		const fill = committed.paramData.params.fill;
		const v0 = fill.vertices[0];
		const v3 = fill.vertices[3];

		// Check what the user actually SEES: the displayed root handle for the
		// left edge (getDisplayedMeshHandle, the exact call the overlay makes),
		// not just the stored data. It must deviate from the straight-line 1/3
		// default between the deformed endpoints — i.e. the edge curved to follow
		// the warp instead of snapping back to the root-root line.
		const displayed = getDisplayedMeshHandle(fill.vertices, fill.faces, 0, 3);
		const straight13 = {
			x: v0.x + (v3.x - v0.x) / 3,
			y: v0.y + (v3.y - v0.y) / 3,
		};
		const deviation = Math.hypot(
			displayed.x - straight13.x,
			displayed.y - straight13.y,
		);
		expect(deviation).toBeGreaterThan(0.02);
	});

	it("curves the displayed root handle across a subdivided boundary edge", () => {
		// Subdivided top edge: root v0 ─ derived v4 ─ root v1. The face-neighbor of
		// v0 is v4 (derived), NOT v1, but the display resolves the edge to the root
		// segment and reads vertices[0].handles[1]. A materializer that only walks
		// direct face-neighbors never creates handles[1], so the displayed handle
		// snaps to the deformed root-root line. This is the real failing case.
		const mesh = createMesh();
		const red = { type: "rgb", r: 1, g: 0, b: 0, a: 1 } as const;
		const appearance = {
			uid: "mesh-gradient-fill",
			processor: "fill",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "3",
				params: {
					fill: {
						type: "mesh",
						vertices: [
							// root corners — edge 0↔1 has NO stored handle (default straight)
							{ x: 0, y: 0, color: red, colorMode: "explicit", handles: {} },
							{ x: 1, y: 0, color: red, colorMode: "explicit", handles: {} },
							{
								x: 1,
								y: 1,
								color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
								colorMode: "explicit",
								handles: {},
							},
							{
								x: 0,
								y: 1,
								color: { type: "rgb", r: 0, g: 1, b: 0, a: 1 },
								colorMode: "explicit",
								handles: {},
							},
							// v4: derived on edge [0,1] at t=0.5 (splits the top edge)
							{
								x: 0.5,
								y: 0,
								color: red,
								colorMode: "derived",
								colorSource: { kind: "edge", edgeVerts: [0, 1], t: 0.5 },
								positionSource: { edgeVerts: [0, 1], t: 0.5 },
								handles: {},
							},
							// v5: explicit interior center (splits the quad into two)
							{
								x: 0.5,
								y: 0.5,
								color: red,
								colorMode: "explicit",
								handles: {},
							},
						],
						faces: [
							{ type: "quad", verts: [0, 4, 5, 3] },
							{ type: "quad", verts: [4, 1, 2, 5] },
						],
					},
				},
			},
		} satisfies FillAppearance;
		mesh.filters = [appearance];
		const worldBounds = calculateElementBounds(mesh);
		const ctx = createMockToolContext({
			getSelectedElementIds: vi.fn(() => [mesh.id]),
			getElement: vi.fn(() => mesh),
			getBounds: vi.fn(() => worldBounds),
			getCurrentLayerId: vi.fn(() => "layer-1"),
		});
		const tool = new MeshDeformTool(ctx);

		// Non-affine bump on the top edge: pin the corners, pull its midpoint.
		const pins = [
			{ x: 100, y: 40 },
			{ x: 200, y: 40 },
			{ x: 200, y: 140 },
			{ x: 100, y: 140 },
		];
		for (const p of pins) addHandle(tool, p.x, p.y);
		addHandle(tool, 150, 40);
		const ids = getHandles(ctx).map(({ id }) => id);
		for (let i = 0; i < pins.length; i++)
			moveHandle(tool, ctx, ids[i], pins[i]);
		moveHandle(tool, ctx, ids[4], { x: 150, y: 95 });

		tool.applyDeformation({ complete: false });

		const update = vi.mocked(ctx.applyDeformation).mock.calls[0][0][0].updates;
		const committed = update.filters?.find((f) => f.uid === appearance.uid) as
			| FillAppearance
			| undefined;
		if (!committed || committed.paramData.params.fill.type !== "mesh") {
			throw new Error("Expected committed mesh-gradient fill");
		}
		const fill = committed.paramData.params.fill;

		// Displayed handle for the subdivided edge (overlay calls this with the
		// derived neighbor 4); it resolves to the root segment and reads
		// vertices[0].handles[1].
		const displayed = getDisplayedMeshHandle(fill.vertices, fill.faces, 0, 4);
		const v0 = fill.vertices[0];
		const v1 = fill.vertices[1];
		const straight13 = {
			x: v0.x + (v1.x - v0.x) / 3,
			y: v0.y + (v1.y - v0.y) / 3,
		};
		const deviation = Math.hypot(
			displayed.x - straight13.x,
			displayed.y - straight13.y,
		);
		expect(deviation).toBeGreaterThan(0.02);
	});
});

function moveHandle(
	tool: MeshDeformTool,
	ctx: MockToolContext,
	handleId: string | undefined,
	target: { x: number; y: number },
): void {
	const handle = getHandles(ctx).find(({ id }) => id === handleId);
	if (!handle) throw new Error("Expected deformation handle");
	const startX = 400 + handle.x;
	const startY = 300 - handle.y;
	const targetX = 400 + target.x;
	const targetY = 300 - target.y;
	tool.onPointerDown(
		ev(startX, startY),
		testViewport,
		testCanvasWidth,
		testCanvasHeight,
	);
	tool.onPointerMove(
		ev(targetX, targetY),
		testViewport,
		testCanvasWidth,
		testCanvasHeight,
	);
	tool.onPointerUp(
		ev(targetX, targetY),
		testViewport,
		testCanvasWidth,
		testCanvasHeight,
	);
}
