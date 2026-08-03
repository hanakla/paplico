import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStrokeBrushSettings } from "../document/factory";
import type { StrokeAppearance } from "../schema";
import { createMockToolContext } from "../testUtils/mockToolContext";
import {
	ev,
	testCanvasHeight,
	testCanvasWidth,
	testViewport,
} from "../testUtils/pointerEvent";
import { ShapeTool, type ShapeToolOptions } from "./ShapeTool";

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

// Default viewport (0,0,zoom=1), canvas 800×600:
//   screen(400,300) → world(0,0)
//   screen(500,300) → world(100,0)
//   screen(400,200) → world(0,100)

type ShapeToolMockOptions = ShapeToolOptions & {
	shapeComplete: ReturnType<typeof vi.fn<(path: unknown) => void>>;
	previewUpdate: ReturnType<typeof vi.fn<(preview: unknown | null) => void>>;
};

function createMockOptions(
	overrides: Partial<ShapeToolOptions> = {},
): ShapeToolMockOptions {
	const shapeComplete = vi.fn<(path: unknown) => void>();
	const previewUpdate = vi.fn<(preview: unknown | null) => void>();
	return {
		shapeType: "rectangle",
		shapeComplete,
		previewUpdate,
		...overrides,
	};
}

function createTool(
	opts: ShapeToolMockOptions,
	contextOverrides: Record<string, unknown> = {},
): ShapeTool {
	return new ShapeTool(
		createMockToolContext({
			shapeComplete: (path) => opts.shapeComplete(path),
			previewUpdate: (preview) => opts.previewUpdate(preview),
			getActiveStrokeAppearance: () => testStrokeAppearance,
			...contextOverrides,
		}),
		opts,
	);
}

describe("ShapeTool", () => {
	let tool: ShapeTool;
	let opts: ReturnType<typeof createMockOptions>;

	beforeEach(() => {
		opts = createMockOptions();
		tool = createTool(opts);
	});

	it("should have name 'shape'", () => {
		expect(tool.name).toBe("shape");
	});

	it("should return crosshair cursor", () => {
		expect(tool.getCursor()).toBe("crosshair");
	});

	describe("Rectangle", () => {
		it("should create rectangle path with 4 segments on drag", () => {
			// Drag from world(0,0) to world(100,100)
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(500, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(opts.shapeComplete).toHaveBeenCalledTimes(1);

			const path = (opts.shapeComplete as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			expect(path.type).toBe("path");
			expect(path.segments).toHaveLength(4);

			// Last segment should be closed
			expect(path.segments[3].isClosed).toBe(true);
		});

		it("should apply color and width to the created path", () => {
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const path = (opts.shapeComplete as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const strokeFilter = path.filters.find(
				(f: any) => f.processor === "stroke",
			);
			expect(strokeFilter.paramData.params.strokeColor).toMatchObject({
				type: "solid",
				color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
			});
			expect(strokeFilter.paramData.params.brushSettings?.size).toBe(2);
		});
	});

	describe("Ellipse", () => {
		it("should create ellipse path with 4 segments on drag", () => {
			opts = createMockOptions({ shapeType: "ellipse" });
			tool = createTool(opts);

			// Drag from world(0,0) to world(100,100)
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(opts.shapeComplete).toHaveBeenCalledTimes(1);

			const path = (opts.shapeComplete as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			expect(path.segments).toHaveLength(4);

			// Last segment should be closed
			expect(path.segments[3].isClosed).toBe(true);
		});
	});

	describe("Line", () => {
		it("should create line path with 1 segment on drag", () => {
			opts = createMockOptions({ shapeType: "line" });
			tool = createTool(opts);

			// Drag from world(0,0) to world(100,0)
			tool.onPointerDown(
				ev(400, 300),
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

			expect(opts.shapeComplete).toHaveBeenCalledTimes(1);

			const path = (opts.shapeComplete as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			expect(path.segments).toHaveLength(1);

			// Line: start at world(0,0), end at world(100,0)
			expect(path.segments[0].start).toMatchObject({
				x: expect.closeTo(0),
				y: expect.closeTo(0),
			});
			expect(path.segments[0].end).toMatchObject({
				x: expect.closeTo(100),
				y: expect.closeTo(0),
			});
		});
	});

	describe("Star", () => {
		it("should create star path with 2*points segments", () => {
			opts = createMockOptions({
				shapeType: "star",
				starPoints: 5,
				starInnerRatio: 0.5,
			});
			tool = createTool(opts);

			// Drag from world(0,0) to world(100,0)
			tool.onPointerDown(
				ev(400, 300),
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

			expect(opts.shapeComplete).toHaveBeenCalledTimes(1);

			const path = (opts.shapeComplete as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			// Star with 5 points → 10 vertices → 10 segments (closed polygon)
			expect(path.segments).toHaveLength(10);
			expect(path.segments[9].isClosed).toBe(true);
		});
	});

	describe("Minimum size check", () => {
		it("should not create shape when drag distance < 3", () => {
			// Drag from world(0,0) to world(1,1) → distance ≈ 1.41 < 3
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(401, 299),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(opts.shapeComplete).not.toHaveBeenCalled();
		});

		it("should create shape when drag distance >= 3", () => {
			// Drag from world(0,0) to world(5,0) → distance = 5 >= 3
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(405, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(opts.shapeComplete).toHaveBeenCalledTimes(1);
		});
	});

	describe("Preview", () => {
		it("should call previewUpdate during pointer move", () => {
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(500, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(opts.previewUpdate).toHaveBeenCalledTimes(1);

			const previewPath = (opts.previewUpdate as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			expect(previewPath).not.toBeNull();
			expect(previewPath.id).toBe("preview");
		});

		it("should not call previewUpdate on move without prior pointer down", () => {
			tool.onPointerMove(
				ev(500, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(opts.previewUpdate).not.toHaveBeenCalled();
		});

		it("should call previewUpdate(null) on cancel", () => {
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(500, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onCancel();

			// Last call to previewUpdate should be null (from reset)
			const calls = (opts.previewUpdate as ReturnType<typeof vi.fn>).mock.calls;
			const lastCall = calls[calls.length - 1][0];
			expect(lastCall).toBeNull();
		});
	});

	describe("Shift constraint", () => {
		it("should constrain rectangle to square when shift is pressed", () => {
			// Drag from world(0,0) to world(100,50) with shift
			// Constraint: max(|dx|,|dy|) = 100 → square 100×100
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 250, { shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(opts.shapeComplete).toHaveBeenCalledTimes(1);

			const path = (opts.shapeComplete as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const segments = path.segments;

			// For a square, all sides should have equal length.
			// Collect all end points to verify squareness.
			const endPoints = segments.map(
				(s: { end: { x: number; y: number } }) => s.end,
			);
			const startPoint = segments[0].start;

			// Width and height of bounding box should be equal
			const allX = [startPoint.x, ...endPoints.map((p: { x: number }) => p.x)];
			const allY = [startPoint.y, ...endPoints.map((p: { y: number }) => p.y)];
			const bboxW = Math.max(...allX) - Math.min(...allX);
			const bboxH = Math.max(...allY) - Math.min(...allY);
			expect(bboxW).toBeCloseTo(bboxH, 5);
		});

		it("should snap line to 45-degree angles when shift is pressed", () => {
			opts = createMockOptions({ shapeType: "line" });
			tool = createTool(opts);

			// Drag from world(0,0) to world(100,30) with shift
			// Angle ≈ 16.7° → snaps to 0° → end should be (100, 0)
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 270, { shiftKey: true }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(opts.shapeComplete).toHaveBeenCalledTimes(1);

			const path = (opts.shapeComplete as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const endPoint = path.segments[0].end;

			// Snapped to 0° → y should be ≈ 0
			expect(endPoint.y).toBeCloseTo(0, 0);
		});
	});

	describe("Snapping", () => {
		it("should snap the drag end point to artboard/element edges", () => {
			const snapArtboardToElements = vi.fn(() => ({
				deltaX: 5,
				deltaY: -3,
				snapLines: [],
			}));
			tool = createTool(opts, { snapArtboardToElements });

			// Drag from world(0,0) to world(100,100), end point snapped by (+5,-3)
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(snapArtboardToElements).toHaveBeenCalled();

			const path = (opts.shapeComplete as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const allX = path.segments.map((s: { end: { x: number } }) => s.end.x);
			const allY = path.segments.map((s: { end: { y: number } }) => s.end.y);
			expect(Math.max(...allX)).toBeCloseTo(105, 5);
			expect(Math.max(...allY)).toBeCloseTo(97, 5);
		});

		it("should show a snap-line overlay while dragging when a snap line is returned", () => {
			const snapArtboardToElements = vi.fn(() => ({
				deltaX: 0,
				deltaY: 0,
				snapLines: [
					{
						axis: "vertical" as const,
						position: 100,
						extentMin: 0,
						extentMax: 100,
					},
				],
			}));
			const uiSetOverlay = vi.fn();
			tool = createTool(opts, { snapArtboardToElements, uiSetOverlay });

			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(500, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const calls = uiSetOverlay.mock.calls.filter(
				([key]) => key === "shape/snap-lines",
			);
			expect(calls.length).toBeGreaterThan(0);
			expect(calls.at(-1)?.[1]).not.toBeNull();
		});

		it("should clear the snap-line overlay once the drag ends", () => {
			const uiSetOverlay = vi.fn();
			tool = createTool(opts, { uiSetOverlay });

			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(500, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onCancel();

			const calls = uiSetOverlay.mock.calls.filter(
				([key]) => key === "shape/snap-lines",
			);
			expect(calls.at(-1)?.[1]).toBeNull();
		});
	});

	describe("Fill color", () => {
		it("should include fill when fillAppearance is active", () => {
			opts = createMockOptions();
			tool = createTool(opts, {
				getActiveFillAppearance: () => ({
					uid: "test-fill",
					processor: "fill",
					enabled: true,
					opacity: 1,
					blendMode: "normal",
					paramData: {
						version: "1",
						params: {
							fill: {
								type: "solid",
								color: {
									type: "rgb" as const,
									r: 0,
									g: 1,
									b: 0,
									a: 0.5,
								},
							},
						},
					},
				}),
			});

			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const path = (opts.shapeComplete as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const fillFilter = path.filters.find((f: any) => f.processor === "fill");
			expect(fillFilter.paramData.params.fill).toMatchObject({
				type: "solid",
				color: { type: "rgb", r: 0, g: 1, b: 0, a: 0.5 },
			});
		});

		it("should not include fill when fillColor is not set", () => {
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(500, 200),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			const path = (opts.shapeComplete as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			const fillFilter = path.filters?.find((f: any) => f.processor === "fill");
			expect(fillFilter).toBeUndefined();
		});
	});
});
