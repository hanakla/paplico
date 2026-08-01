import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStrokeBrushSettings } from "../document/factory";
import type { PerspectiveGuideData } from "../reference3d/perspective/vanishingPoints";
import type {
	Path,
	RGBColor,
	SolidColor,
	StrokeAppearance,
	Viewport,
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
import { PenTool } from "./PenTool";

const testStrokeAppearance: StrokeAppearance = {
	uid: "test-stroke",
	processor: "stroke",
	opacity: 1,
	blendMode: "normal",
	paramData: {
		version: "1",
		params: {
			strokeColor: {
				type: "solid",
				color: { type: "rgb" as const, r: 1, g: 0, b: 0, a: 1 },
			},
			brushSettings: createStrokeBrushSettings(2),
		},
	},
};

const mockDocumentStore = {
	elementOverrides: new Map(),
	transientElements: new Map(),
};

vi.mock("@/stores/documentStore", () => ({
	documentStore: mockDocumentStore,
}));

describe("PenTool", () => {
	let penTool: PenTool;
	let completedPaths: Path[] = [];

	beforeEach(() => {
		mockDocumentStore.elementOverrides.clear();
		mockDocumentStore.transientElements.clear();
		completedPaths = [];
		penTool = new PenTool(
			createMockToolContext({
				strokeComplete: (path) => {
					completedPaths.push(path);
				},
				getActiveStrokeAppearance: () => testStrokeAppearance,
			}),
			{ strokeWidth: 2 },
		);
	});

	describe("Basic functionality", () => {
		it("should have name 'pen'", () => {
			expect(penTool.name).toBe("pen");
		});

		it("should return crosshair cursor", () => {
			expect(penTool.getCursor()).toBe("crosshair");
		});
	});

	describe("Stroke creation", () => {
		it("should start stroke on pointer down", () => {
			const event = ev(400, 300);
			penTool.onPointerDown(
				event,
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const currentStroke = penTool.getCurrentStroke();
			expect(currentStroke).not.toBeNull();
			expect(currentStroke).toHaveLength(1);
			expect(currentStroke?.[0].x).toBeCloseTo(0);
			expect(currentStroke?.[0].y).toBeCloseTo(0);
		});

		it("should add points on pointer move", () => {
			penTool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			penTool.onPointerMove(
				ev(410, 310),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			penTool.onPointerMove(
				ev(420, 320),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const currentStroke = penTool.getCurrentStroke();
			expect(currentStroke).toHaveLength(3);
		});

		it("should not add points on pointer move without starting stroke", () => {
			penTool.onPointerMove(
				ev(410, 310),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const currentStroke = penTool.getCurrentStroke();
			expect(currentStroke).toBeNull();
		});

		it("should complete stroke on pointer up", () => {
			penTool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			penTool.onPointerMove(
				ev(410, 310),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			penTool.onPointerMove(
				ev(420, 320),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			penTool.onPointerUp(
				ev(420, 320),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(completedPaths).toHaveLength(1);
			expect(penTool.getCurrentStroke()).toBeNull();
		});

		it("should not complete stroke with less than 2 points", () => {
			penTool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			penTool.onPointerUp(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(completedPaths).toHaveLength(0);
			expect(penTool.getCurrentStroke()).toBeNull();
		});
	});

	describe("Path properties", () => {
		it("should create path with correct color", () => {
			penTool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			penTool.onPointerMove(
				ev(410, 310),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			penTool.onPointerUp(
				ev(420, 320),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const path = completedPaths[0];
			const strokeApp = path.filters?.find((f) => f.processor === "stroke") as
				| StrokeAppearance
				| undefined;
			expect(strokeApp).toBeDefined();
			const strokeColor = strokeApp?.paramData.params.strokeColor;
			expect(strokeColor?.type).toBe("solid");
			const solidColor = (strokeColor as SolidColor).color as RGBColor;
			expect(solidColor.r).toBe(1);
			expect(solidColor.g).toBe(0);
			expect(solidColor.b).toBe(0);
			expect(solidColor.a).toBe(1);
		});

		it("should create path with correct width", () => {
			penTool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			penTool.onPointerMove(
				ev(410, 310),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			penTool.onPointerUp(
				ev(420, 320),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const path = completedPaths[0];
			const strokeApp = path.filters?.find((f) => f.processor === "stroke") as
				| StrokeAppearance
				| undefined;
			expect(strokeApp?.paramData.params.brushSettings?.size).toBe(2);
		});

		it("should create path with segments", () => {
			penTool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			penTool.onPointerMove(
				ev(410, 310),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			penTool.onPointerMove(
				ev(420, 320),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			penTool.onPointerUp(
				ev(420, 320),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const path = completedPaths[0];
			expect(path.segments.length).toBeGreaterThan(0);
		});
	});

	describe("Pressure support", () => {
		it("should record pressure values", () => {
			penTool.onPointerDown(
				ev(400, 300, { pressure: 0.3 }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			penTool.onPointerMove(
				ev(410, 310, { pressure: 0.7 }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const currentStroke = penTool.getCurrentStroke();
			expect(currentStroke?.[0].pressure).toBe(0.3);
			expect(currentStroke?.[1].pressure).toBe(0.7);
		});
	});

	describe("Cancel operation", () => {
		it("should cancel current stroke", () => {
			penTool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			penTool.onPointerMove(
				ev(410, 310),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			penTool.onCancel();

			expect(penTool.getCurrentStroke()).toBeNull();
			expect(completedPaths).toHaveLength(0);
		});
	});

	describe("Perspective snap", () => {
		const horizontalGuides: PerspectiveGuideData = {
			elementId: "reference3d-el",
			axes: [{ axis: "x", kind: "infinite", direction: { x: 1, y: 0 } }],
			horizon: null,
		};

		function createSnapPen(
			options: { perspectiveSnap?: boolean } = {},
			guides: PerspectiveGuideData | null = horizontalGuides,
		): { tool: PenTool; context: MockToolContext } {
			const context = createMockToolContext({
				getActiveStrokeAppearance: () => testStrokeAppearance,
				getPerspectiveGuides: vi.fn(() => guides),
			});
			return {
				tool: new PenTool(context, { strokeWidth: 2, ...options }),
				context,
			};
		}

		function down(tool: PenTool, x: number, y: number): void {
			tool.onPointerDown(
				ev(x, y),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
		}

		function move(
			tool: PenTool,
			x: number,
			y: number,
			overrides: Parameters<typeof ev>[2] = {},
		): void {
			tool.onPointerMove(
				ev(x, y, overrides),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
		}

		it("should lock within 10° of a guide direction and project points onto the line", () => {
			const { tool } = createSnapPen();
			down(tool, 400, 300);
			// world (20, 2): 5.7° off the horizontal guide — inside the cone.
			move(tool, 420, 298);
			move(tool, 500, 290, { pressure: 0.9, tiltX: 30 });

			const stroke = tool.getCurrentStroke()!;
			expect(stroke[1].y).toBeCloseTo(0, 9);
			expect(stroke[2].y).toBeCloseTo(0, 9);
			expect(stroke[2].x).toBeCloseTo(100, 9);
			// Projection replaces x/y only — pressure and tilt pass through.
			expect(stroke[2].pressure).toBe(0.9);
			expect(stroke[2].tiltX).toBe(30);
		});

		it("should not lock when the initial motion is more than 10° off every guide", () => {
			const { tool } = createSnapPen();
			down(tool, 400, 300);
			// world (20, 6): 16.7° — outside the cone. No snap for this stroke.
			move(tool, 420, 294);
			move(tool, 500, 280);

			const stroke = tool.getCurrentStroke()!;
			expect(stroke[1].y).toBeCloseTo(6, 9);
			expect(stroke[2].y).toBeCloseTo(20, 9);
		});

		it("should resolve the 10° boundary per stroke (9.4° locks, 10.5° does not)", () => {
			const inside = createSnapPen();
			down(inside.tool, 400, 300);
			// world (20, 3.3): 9.37°
			move(inside.tool, 420, 296.7);
			expect(inside.tool.getCurrentStroke()![1].y).toBeCloseTo(0, 9);

			const outside = createSnapPen();
			down(outside.tool, 400, 300);
			// world (20, 3.71): 10.5°
			move(outside.tool, 420, 296.29);
			expect(outside.tool.getCurrentStroke()![1].y).toBeCloseTo(3.71, 9);
		});

		it("should snap along the line through a finite vanishing point and P0", () => {
			const { tool } = createSnapPen(
				{},
				{
					elementId: "reference3d-el",
					axes: [{ axis: "z", kind: "finite", point: { x: -1000, y: 0 } }],
					horizon: null,
				},
			);
			down(tool, 400, 300);
			// P0 = (0,0), VP = (-1000,0) → candidate direction (1,0).
			move(tool, 420, 298);

			expect(tool.getCurrentStroke()![1].y).toBeCloseTo(0, 9);
		});

		it("should bypass snapping while Alt is held", () => {
			const { tool } = createSnapPen();
			down(tool, 400, 300);
			// Lock first, then Alt frees the pointer temporarily.
			move(tool, 420, 298);
			move(tool, 460, 290, { altKey: true });
			move(tool, 500, 290);

			const stroke = tool.getCurrentStroke()!;
			expect(stroke[1].y).toBeCloseTo(0, 9);
			expect(stroke[2].y).toBeCloseTo(10, 9);
			expect(stroke[3].y).toBeCloseTo(0, 9);
		});

		it("should not snap when the perspectiveSnap setting is off", () => {
			const { tool } = createSnapPen({ perspectiveSnap: false });
			down(tool, 400, 300);
			move(tool, 420, 298);

			expect(tool.getCurrentStroke()![1].y).toBeCloseTo(2, 9);
		});

		it("should show radial + lock guide lines during the stroke and clear them on pointer-up", () => {
			const { tool, context } = createSnapPen(
				{},
				{
					elementId: "reference3d-el",
					axes: [{ axis: "z", kind: "finite", point: { x: -1000, y: 0 } }],
					horizon: null,
				},
			);
			down(tool, 400, 300);
			move(tool, 420, 298);

			const overlayCalls = context.uiSetOverlay.mock.calls.filter(
				([key]) => key === "pen/perspective",
			);
			const overlay = overlayCalls.at(-1)![1]!;
			// Radial line from the finite VP + the locked direction line.
			expect(overlay.primitives).toHaveLength(2);
			expect(overlay.primitives[0]).toMatchObject({
				kind: "line",
				x1: -1000,
				y1: 0,
			});

			tool.onPointerUp(
				ev(420, 298),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			expect(
				context.uiSetOverlay.mock.calls
					.filter(([key]) => key === "pen/perspective")
					.at(-1),
			).toEqual(["pen/perspective", null]);
		});
	});

	describe("Coordinate transformation", () => {
		it("should transform screen coordinates to world coordinates", () => {
			penTool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const currentStroke = penTool.getCurrentStroke();
			expect(currentStroke?.[0].x).toBeCloseTo(0);
			expect(currentStroke?.[0].y).toBeCloseTo(0);
		});

		it("should respect viewport zoom", () => {
			const zoomedViewport: Viewport = { x: 0, y: 0, zoom: 2, rotation: 0 };
			penTool.onPointerDown(
				ev(600, 300),
				zoomedViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const currentStroke = penTool.getCurrentStroke();
			expect(currentStroke?.[0].x).toBeCloseTo(100);
		});

		it("should respect viewport offset", () => {
			const offsetViewport: Viewport = { x: 100, y: 50, zoom: 1, rotation: 0 };
			penTool.onPointerDown(
				ev(400, 300),
				offsetViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const currentStroke = penTool.getCurrentStroke();
			expect(currentStroke?.[0].x).toBeCloseTo(100);
			expect(currentStroke?.[0].y).toBeCloseTo(50);
		});
	});
});
