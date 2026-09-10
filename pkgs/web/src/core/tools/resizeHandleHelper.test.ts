import { describe, expect, it } from "vitest";
import type { BoundingBox, Viewport } from "../schema";
import {
	calculateResizedBounds,
	createResizeHandles,
	getResizeCursor,
	hitTestResizeHandle,
} from "./resizeHandleHelper";

const box100: BoundingBox = {
	minX: 0,
	minY: 0,
	maxX: 100,
	maxY: 100,
	width: 100,
	height: 100,
};

const box200x100: BoundingBox = {
	minX: 50,
	minY: 50,
	maxX: 250,
	maxY: 150,
	width: 200,
	height: 100,
};

describe("createResizeHandles", () => {
	it("returns 8 handles at correct positions", () => {
		const handles = createResizeHandles(box100);
		expect(handles).toHaveLength(8);

		const byPos = Object.fromEntries(handles.map((h) => [h.position, h]));
		expect(byPos.nw).toEqual({ x: 0, y: 100, position: "nw" });
		expect(byPos.ne).toEqual({ x: 100, y: 100, position: "ne" });
		expect(byPos.se).toEqual({ x: 100, y: 0, position: "se" });
		expect(byPos.sw).toEqual({ x: 0, y: 0, position: "sw" });
		expect(byPos.n).toEqual({ x: 50, y: 100, position: "n" });
		expect(byPos.s).toEqual({ x: 50, y: 0, position: "s" });
		expect(byPos.e).toEqual({ x: 100, y: 50, position: "e" });
		expect(byPos.w).toEqual({ x: 0, y: 50, position: "w" });
	});
});

describe("hitTestResizeHandle", () => {
	const viewport: Viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

	it("returns handle position when pointer is within hit area", () => {
		expect(hitTestResizeHandle(0, 100, box100, viewport)).toBe("nw");
		expect(hitTestResizeHandle(100, 0, box100, viewport)).toBe("se");
	});

	it("returns null when pointer is outside all handles", () => {
		expect(hitTestResizeHandle(50, 50, box100, viewport)).toBeNull();
	});

	it("scales hit area by viewport zoom", () => {
		const zoomedViewport: Viewport = { x: 0, y: 0, zoom: 4, rotation: 0 };
		// At zoom=4, hit radius = 12/4/2 = 1.5px
		expect(hitTestResizeHandle(1.4, 100, box100, zoomedViewport)).toBe("nw");
		expect(hitTestResizeHandle(3, 100, box100, zoomedViewport)).toBeNull();
	});
});

describe("calculateResizedBounds", () => {
	// dragStart = handle position for each test

	describe("corner handles - basic resize", () => {
		it("se: dragging bottom-right corner expands maxX and shrinks minY", () => {
			const result = calculateResizedBounds(box100, "se", 120, -20, 100, 0);
			expect(result.maxX).toBe(120);
			expect(result.minY).toBe(-20);
			expect(result.minX).toBe(0);
			expect(result.maxY).toBe(100);
		});

		it("nw: dragging top-left corner moves minX and maxY", () => {
			const result = calculateResizedBounds(box100, "nw", -10, 110, 0, 100);
			expect(result.minX).toBe(-10);
			expect(result.maxY).toBe(110);
			expect(result.maxX).toBe(100);
			expect(result.minY).toBe(0);
		});
	});

	describe("edge handles - single-axis resize", () => {
		it("e: only maxX changes", () => {
			const result = calculateResizedBounds(box100, "e", 150, 50, 100, 50);
			expect(result.maxX).toBe(150);
			expect(result.minX).toBe(0);
			expect(result.minY).toBe(0);
			expect(result.maxY).toBe(100);
		});

		it("w: only minX changes", () => {
			const result = calculateResizedBounds(box100, "w", -30, 50, 0, 50);
			expect(result.minX).toBe(-30);
			expect(result.maxX).toBe(100);
		});

		it("n: only maxY changes", () => {
			const result = calculateResizedBounds(box100, "n", 50, 130, 50, 100);
			expect(result.maxY).toBe(130);
			expect(result.minY).toBe(0);
		});

		it("s: only minY changes", () => {
			const result = calculateResizedBounds(box100, "s", 50, -20, 50, 0);
			expect(result.minY).toBe(-20);
			expect(result.maxY).toBe(100);
		});
	});

	describe("minimum size enforcement", () => {
		it("prevents width from going below minSize", () => {
			const result = calculateResizedBounds(box100, "e", 5, 50, 100, 50, {
				minSize: 10,
			});
			expect(result.maxX).toBe(10);
			expect(result.width).toBe(10);
		});

		it("prevents height from going below minSize", () => {
			const result = calculateResizedBounds(box100, "n", 50, 5, 50, 100, {
				minSize: 10,
			});
			expect(result.maxY).toBe(10);
			expect(result.height).toBe(10);
		});
	});

	describe("aspect ratio constraint (constrainAspect=true)", () => {
		it("e handle: adjusts height symmetrically around centerY", () => {
			const result = calculateResizedBounds(
				box200x100,
				"e",
				300,
				100,
				250,
				100,
				{ constrainAspect: true },
			);
			// width goes from 200 to 250, aspect = 2:1, so height = 125
			expect(result.width).toBe(250);
			expect(result.height).toBe(125);
			// center Y should remain at 100
			expect((result.minY + result.maxY) / 2).toBeCloseTo(100);
		});

		it("ne handle: horizontal dominant preserves aspect via width", () => {
			const result = calculateResizedBounds(box100, "ne", 150, 105, 100, 100, {
				constrainAspect: true,
			});
			// deltaX=50, deltaY=5 → horizontal dominant
			expect(result.maxX).toBe(150);
			expect(result.width).toBe(150);
			expect(result.height).toBe(150);
		});
	});

	describe("mirroring (allowFlip=true)", () => {
		it("w: dragging past the right edge mirrors the bounds", () => {
			const result = calculateResizedBounds(box100, "w", 150, 50, 0, 50, {
				allowFlip: true,
			});
			expect(result.flipX).toBe(true);
			expect(result.minX).toBe(100);
			expect(result.maxX).toBe(150);
			expect(result.width).toBe(50);
		});

		it("w: the same drag only shrinks to minSize without allowFlip", () => {
			const result = calculateResizedBounds(box100, "w", 150, 50, 0, 50, {
				minSize: 10,
			});
			expect(result.flipX).toBe(false);
			expect(result.minX).toBe(90);
			expect(result.maxX).toBe(100);
		});

		it("follows the pointer through the crossing without a dead zone", () => {
			const result = calculateResizedBounds(box100, "w", 102, 50, 0, 50, {
				allowFlip: true,
				minSize: 10,
			});
			expect(result.flipX).toBe(true);
			expect(result.width).toBeCloseTo(2);
		});

		it("se: dragging past the opposite corner mirrors both axes", () => {
			const result = calculateResizedBounds(box100, "se", -40, 160, 100, 0, {
				allowFlip: true,
			});
			expect(result.flipX).toBe(true);
			expect(result.flipY).toBe(true);
			expect(result.minX).toBe(-40);
			expect(result.maxX).toBe(0);
			expect(result.minY).toBe(100);
			expect(result.maxY).toBe(160);
		});

		it("keeps the aspect ratio while mirrored", () => {
			const result = calculateResizedBounds(box100, "w", 150, 50, 0, 50, {
				constrainAspect: true,
				allowFlip: true,
			});
			expect(result.flipX).toBe(true);
			expect(result.width).toBe(50);
			expect(result.height).toBe(50);
			expect((result.minY + result.maxY) / 2).toBeCloseTo(50);
		});

		it("mirrors around the center under anchorCenter", () => {
			const result = calculateResizedBounds(box100, "w", 90, 50, 0, 50, {
				anchorCenter: true,
				allowFlip: true,
			});
			expect(result.flipX).toBe(true);
			expect(result.minX).toBe(10);
			expect(result.maxX).toBe(90);
			expect((result.minX + result.maxX) / 2).toBeCloseTo(50);
		});
	});

	describe("anchorCenter - center-anchored resize", () => {
		it("e handle: expands symmetrically from center", () => {
			const result = calculateResizedBounds(box100, "e", 130, 50, 100, 50, {
				anchorCenter: true,
			});
			// Normal: maxX moves from 100 to 130, dMaxX = +30
			// anchorCenter mirrors: minX also moves by -30
			expect(result.maxX).toBe(130);
			expect(result.minX).toBe(-30);
			expect(result.width).toBe(160);
			// Center should remain at 50
			expect((result.minX + result.maxX) / 2).toBeCloseTo(50);
		});

		it("w handle: expands symmetrically from center", () => {
			const result = calculateResizedBounds(box100, "w", -20, 50, 0, 50, {
				anchorCenter: true,
			});
			// Normal: minX moves from 0 to -20, dMinX = -20
			// anchorCenter mirrors: maxX also moves by +20
			expect(result.minX).toBe(-20);
			expect(result.maxX).toBe(120);
			expect(result.width).toBe(140);
			expect((result.minX + result.maxX) / 2).toBeCloseTo(50);
		});

		it("n handle: expands symmetrically from center vertically", () => {
			const result = calculateResizedBounds(box100, "n", 50, 140, 50, 100, {
				anchorCenter: true,
			});
			// Normal: maxY moves from 100 to 140, dMaxY = +40
			// anchorCenter mirrors: minY also moves by -40
			expect(result.maxY).toBe(140);
			expect(result.minY).toBe(-40);
			expect(result.height).toBe(180);
			expect((result.minY + result.maxY) / 2).toBeCloseTo(50);
		});

		it("se corner: expands both axes symmetrically", () => {
			const result = calculateResizedBounds(box100, "se", 120, -10, 100, 0, {
				anchorCenter: true,
			});
			// Normal: maxX 100→120 (+20), minY 0→-10 (-10)
			// anchorCenter: minX also -20, maxY also +10
			expect(result.maxX).toBe(120);
			expect(result.minX).toBe(-20);
			expect(result.minY).toBe(-10);
			expect(result.maxY).toBe(110);
			expect((result.minX + result.maxX) / 2).toBeCloseTo(50);
			expect((result.minY + result.maxY) / 2).toBeCloseTo(50);
		});

		it("nw corner: expands both axes symmetrically", () => {
			const result = calculateResizedBounds(box100, "nw", -15, 120, 0, 100, {
				anchorCenter: true,
			});
			// Normal: minX 0→-15 (-15), maxY 100→120 (+20)
			// anchorCenter: maxX also +15, minY also -20
			expect(result.minX).toBe(-15);
			expect(result.maxX).toBe(115);
			expect(result.maxY).toBe(120);
			expect(result.minY).toBe(-20);
			expect((result.minX + result.maxX) / 2).toBeCloseTo(50);
			expect((result.minY + result.maxY) / 2).toBeCloseTo(50);
		});

		it("enforces minimum size around center", () => {
			const result = calculateResizedBounds(box100, "e", 51, 50, 100, 50, {
				anchorCenter: true,
				minSize: 10,
			});
			// Normal: maxX clamps to minX + minSize = 10
			// anchorCenter: result should be centered at 50 with minSize
			expect(result.width).toBeGreaterThanOrEqual(10);
			expect((result.minX + result.maxX) / 2).toBeCloseTo(50);
		});

		it("works with non-origin-based bounding box", () => {
			const box: BoundingBox = {
				minX: 100,
				minY: 200,
				maxX: 300,
				maxY: 400,
				width: 200,
				height: 200,
			};
			const result = calculateResizedBounds(box, "e", 350, 300, 300, 300, {
				anchorCenter: true,
			});
			// Center at (200, 300). maxX: 300→350 (+50), mirror minX: 100→50 (-50)
			expect(result.maxX).toBe(350);
			expect(result.minX).toBe(50);
			expect((result.minX + result.maxX) / 2).toBeCloseTo(200);
		});

		it("combined with aspect ratio constraint", () => {
			const result = calculateResizedBounds(
				box200x100,
				"e",
				300,
				100,
				250,
				100,
				{ constrainAspect: true, anchorCenter: true },
			);
			// Center at (150, 100)
			expect((result.minX + result.maxX) / 2).toBeCloseTo(150);
			expect((result.minY + result.maxY) / 2).toBeCloseTo(100);
			// Aspect ratio should be maintained: width/height ≈ 2
			expect(result.width / result.height).toBeCloseTo(2, 0);
		});
	});
});

describe("getResizeCursor", () => {
	it("returns correct cursor for each handle", () => {
		expect(getResizeCursor("nw")).toBe("nwse-resize");
		expect(getResizeCursor("se")).toBe("nwse-resize");
		expect(getResizeCursor("ne")).toBe("nesw-resize");
		expect(getResizeCursor("sw")).toBe("nesw-resize");
		expect(getResizeCursor("n")).toBe("ns-resize");
		expect(getResizeCursor("s")).toBe("ns-resize");
		expect(getResizeCursor("e")).toBe("ew-resize");
		expect(getResizeCursor("w")).toBe("ew-resize");
	});
});
