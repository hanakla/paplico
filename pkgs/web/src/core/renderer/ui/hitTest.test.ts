import { ref, subscribe } from "valtio";
import { describe, expect, it } from "vitest";
import { createRendererState } from "../../document/rendererState";
import type { Viewport } from "../../schema";
import {
	testCanvasHeight,
	testCanvasWidth,
	testViewport,
} from "../../testUtils/pointerEvent";
import { hitTestOverlays } from "./hitTest";
import type { UIOverlay, UIPrimitive } from "./primitives";
import type { RGBA } from "./theme";

const RED: RGBA = [1, 0, 0, 1];

// Default tolerance: UI_THEME.hitTolerancePx (8) / zoom.

describe("hitTestOverlays", () => {
	describe("circle", () => {
		const overlays = single({
			kind: "circle",
			cx: 0,
			cy: 0,
			radius: 50,
			stroke: { color: RED, width: 1.5 },
			hitId: "c",
		});

		it("should hit inside and up to radius + tolerance", () => {
			expect(hit(overlays, screenAt(0, 0))?.hitId).toBe("c");
			expect(hit(overlays, screenAt(57.5, 0))?.hitId).toBe("c");
		});

		it("should miss beyond radius + tolerance", () => {
			expect(hit(overlays, screenAt(58.5, 0))).toBeNull();
		});
	});

	describe("rect", () => {
		const overlays = single({
			kind: "rect",
			cx: 0,
			cy: 0,
			width: 100,
			height: 60,
			stroke: { color: RED, width: 1.5 },
			hitId: "r",
		});

		it("should hit inside and within edge distance tolerance", () => {
			expect(hit(overlays, screenAt(0, 0))?.hitId).toBe("r");
			expect(hit(overlays, screenAt(0, 37.5))?.hitId).toBe("r");
			expect(hit(overlays, screenAt(-57.5, 0))?.hitId).toBe("r");
		});

		it("should miss beyond edge distance tolerance", () => {
			expect(hit(overlays, screenAt(0, 38.5))).toBeNull();
			// Corner: diagonal distance hypot(6.5, 6.5) ≈ 9.19 > 8
			expect(hit(overlays, screenAt(56.5, 36.5))).toBeNull();
		});
	});

	describe("diamond", () => {
		const overlays = single({
			kind: "diamond",
			cx: 0,
			cy: 0,
			halfSize: 40,
			fill: { color: RED },
			hitId: "d",
		});

		it("should hit inside and within edge distance tolerance", () => {
			expect(hit(overlays, screenAt(0, 0))?.hitId).toBe("d");
			// (25, 25): L1 = 50, edge distance = (50 - 40)/√2 ≈ 7.07 ≤ 8
			expect(hit(overlays, screenAt(25, 25))?.hitId).toBe("d");
		});

		it("should miss beyond edge distance tolerance", () => {
			// (30, 30): edge distance = (60 - 40)/√2 ≈ 14.1 > 8
			expect(hit(overlays, screenAt(30, 30))).toBeNull();
		});
	});

	describe("line", () => {
		const overlays = single({
			kind: "line",
			x1: -50,
			y1: 0,
			x2: 50,
			y2: 0,
			stroke: { color: RED, width: 4 },
			hitId: "l",
		});

		it("should hit within (resolved half-width) + tolerance of the segment", () => {
			// halfWidth = (4 + 1) / 2 = 2.5 → max distance 10.5
			expect(hit(overlays, screenAt(0, 10))?.hitId).toBe("l");
			expect(hit(overlays, screenAt(-50, -10))?.hitId).toBe("l");
		});

		it("should miss beyond the band and beyond segment ends", () => {
			expect(hit(overlays, screenAt(0, 11))).toBeNull();
			expect(hit(overlays, screenAt(61, 0))).toBeNull();
		});
	});

	describe("polyline", () => {
		it("should hit near any segment including the closing segment", () => {
			const overlays = single({
				kind: "polyline",
				points: [
					{ x: -50, y: -50 },
					{ x: 50, y: -50 },
					{ x: 50, y: 50 },
					{ x: -50, y: 50 },
				],
				closed: true,
				stroke: { color: RED, width: 2 },
				hitId: "p",
			});
			expect(hit(overlays, screenAt(0, -50))?.hitId).toBe("p");
			// Closing segment: (-50, 50) → (-50, -50)
			expect(hit(overlays, screenAt(-50, 0))?.hitId).toBe("p");
			// Interior far from all edges is not a hit (stroke band only)
			expect(hit(overlays, screenAt(0, 0))).toBeNull();
		});

		it("should not test the closing segment when open", () => {
			const overlays = single({
				kind: "polyline",
				points: [
					{ x: -50, y: -50 },
					{ x: 50, y: -50 },
					{ x: 50, y: 50 },
					{ x: -50, y: 50 },
				],
				stroke: { color: RED, width: 2 },
				hitId: "p",
			});
			expect(hit(overlays, screenAt(-50, 0))).toBeNull();
		});
	});

	describe("arc", () => {
		const overlays = single({
			kind: "arc",
			cx: 0,
			cy: 0,
			radiusX: 60,
			startAngle: 0,
			endAngle: Math.PI / 2,
			stroke: { color: RED, width: 1.5 },
			hitId: "a",
		});

		it("should hit on the ring within the sweep", () => {
			const x = 60 * Math.cos(Math.PI / 4);
			const y = 60 * Math.sin(Math.PI / 4);
			expect(hit(overlays, screenAt(x, y))?.hitId).toBe("a");
		});

		it("should miss outside the radial band", () => {
			const x = 40 * Math.cos(Math.PI / 4);
			const y = 40 * Math.sin(Math.PI / 4);
			expect(hit(overlays, screenAt(x, y))).toBeNull();
		});

		it("should miss on the ring outside the sweep", () => {
			const x = 60 * Math.cos(-Math.PI / 4);
			const y = 60 * Math.sin(-Math.PI / 4);
			expect(hit(overlays, screenAt(x, y))).toBeNull();
		});
	});

	describe("bezierPath", () => {
		const overlays = single({
			kind: "bezierPath",
			segments: [
				{
					start: { x: -100, y: 0 },
					cp1: { x: -50, y: 80 },
					cp2: { x: 50, y: 80 },
					end: { x: 100, y: 0 },
				},
			],
			stroke: { color: RED, width: 2 },
			hitId: "b",
		});

		it("should hit near the flattened curve", () => {
			// Curve midpoint: y = 0.125·0 + 0.375·80 + 0.375·80 + 0.125·0 = 60
			expect(hit(overlays, screenAt(0, 60))?.hitId).toBe("b");
			expect(hit(overlays, screenAt(-100, 0))?.hitId).toBe("b");
		});

		it("should miss far from the curve", () => {
			expect(hit(overlays, screenAt(0, 0))).toBeNull();
		});

		it("should hit inside a closed fill without a stroke", () => {
			const filled = single({
				kind: "bezierPath",
				closed: true,
				fill: { color: RED },
				segments: [
					straightBezier(-20, -20, 20, -20),
					straightBezier(20, -20, 20, 20),
					straightBezier(20, 20, -20, 20),
					straightBezier(-20, 20, -20, -20),
				],
				hitId: "filled-bezier",
			});

			expect(hit(filled, screenAt(0, 0))?.hitId).toBe("filled-bezier");
			expect(hit(filled, screenAt(30, 0))).toBeNull();
		});
	});

	describe("arrow", () => {
		const overlays = single({
			kind: "arrow",
			x1: -60,
			y1: 0,
			x2: 60,
			y2: 0,
			color: RED,
			width: 3,
			headLength: 16,
			headWidth: 20,
			hitId: "arrow",
		});

		it("should hit within the head half-width band", () => {
			// hw = max((3+1)/2, 20/2) = 10 → max distance 18
			expect(hit(overlays, screenAt(0, 17))?.hitId).toBe("arrow");
		});

		it("should miss beyond the band", () => {
			expect(hit(overlays, screenAt(0, 19))).toBeNull();
		});
	});

	describe("front-most resolution (reverse z/insertion order)", () => {
		const circleAt = (hitId: string, zIndex?: number): UIPrimitive => ({
			kind: "circle",
			cx: 0,
			cy: 0,
			radius: 30,
			stroke: { color: RED, width: 1.5 },
			hitId,
			zIndex,
		});

		it("should return the later primitive on equal z (array order)", () => {
			const overlays = {
				ov: { primitives: [circleAt("under"), circleAt("over")] },
			};
			expect(hit(overlays, screenAt(0, 0))?.hitId).toBe("over");
		});

		it("should let primitive zIndex override array order", () => {
			const overlays = {
				ov: { primitives: [circleAt("under", 5), circleAt("over")] },
			};
			expect(hit(overlays, screenAt(0, 0))?.hitId).toBe("under");
		});

		it("should order overlays by their zIndex", () => {
			const overlays = {
				high: { zIndex: 200, primitives: [circleAt("high-prim")] },
				low: { zIndex: 100, primitives: [circleAt("low-prim")] },
			};
			const result = hit(overlays, screenAt(0, 0));
			expect(result?.overlayKey).toBe("high");
			expect(result?.hitId).toBe("high-prim");
		});

		it("should break equal overlay z by insertion order", () => {
			const overlays = {
				first: { primitives: [circleAt("first-prim")] },
				second: { primitives: [circleAt("second-prim")] },
			};
			expect(hit(overlays, screenAt(0, 0))?.overlayKey).toBe("second");
		});

		it("should skip front primitives without hitId", () => {
			const overlays = {
				ov: {
					primitives: [
						circleAt("under"),
						{
							kind: "circle",
							cx: 0,
							cy: 0,
							radius: 30,
							stroke: { color: RED, width: 1.5 },
						} satisfies UIPrimitive,
					],
				},
			};
			expect(hit(overlays, screenAt(0, 0))?.hitId).toBe("under");
		});
	});

	describe("hitPadding and hitOnly", () => {
		it("should use hitPadding instead of the default tolerance", () => {
			const overlays = single({
				kind: "circle",
				cx: 0,
				cy: 0,
				radius: 10,
				stroke: { color: RED, width: 1.5 },
				hitId: "padded",
				hitPadding: 30,
			});
			expect(hit(overlays, screenAt(39, 0))?.hitId).toBe("padded");
			expect(hit(overlays, screenAt(41, 0))).toBeNull();
		});

		it("should resolve screen-space hitPadding through zoom", () => {
			const overlays = single({
				kind: "circle",
				cx: 0,
				cy: 0,
				radius: 10,
				stroke: { color: RED, width: 1.5 },
				hitId: "padded",
				hitPadding: { screen: 30 },
			});
			// zoom 2: padding = 30 / 2 = 15 world units
			expect(hit(overlays, screenAt(24, 0, 2), viewport(2))?.hitId).toBe(
				"padded",
			);
			expect(hit(overlays, screenAt(26, 0, 2), viewport(2))).toBeNull();
		});

		it("should hit-test hitOnly primitives", () => {
			const overlays = single({
				kind: "rect",
				cx: 0,
				cy: 0,
				width: 100,
				height: 60,
				hitOnly: true,
				hitId: "invisible",
			});
			expect(hit(overlays, screenAt(0, 0))?.hitId).toBe("invisible");
		});
	});

	describe("zoom handling (consistency with lowering Dim resolution)", () => {
		it("should convert the default tolerance to world units (hitTolerancePx / zoom)", () => {
			const overlays = single({
				kind: "circle",
				cx: 0,
				cy: 0,
				radius: 50,
				stroke: { color: RED, width: 1.5 },
				hitId: "c",
			});
			// zoom 2: tolerance = 8 / 2 = 4 world units
			expect(hit(overlays, screenAt(53.5, 0, 2), viewport(2))?.hitId).toBe("c");
			expect(hit(overlays, screenAt(54.5, 0, 2), viewport(2))).toBeNull();
		});

		it("should resolve screen-space size Dims through zoom like lowering does", () => {
			const overlays = single({
				kind: "circle",
				cx: 0,
				cy: 0,
				radius: { screen: 40 },
				stroke: { color: RED, width: 1.5 },
				hitId: "c",
			});
			// zoom 2: radius = 40 / 2 = 20 world, tolerance = 4 → boundary 24
			expect(hit(overlays, screenAt(23.5, 0, 2), viewport(2))?.hitId).toBe("c");
			expect(hit(overlays, screenAt(24.5, 0, 2), viewport(2))).toBeNull();
		});

		it("should apply screenOffset divided by zoom like lowering does", () => {
			const overlays = single({
				kind: "circle",
				cx: 0,
				cy: 0,
				radius: 10,
				screenOffset: { x: 40, y: 0 },
				stroke: { color: RED, width: 1.5 },
				hitId: "c",
			});
			// zoom 2: center shifts to world (20, 0)
			expect(hit(overlays, screenAt(20, 0, 2), viewport(2))?.hitId).toBe("c");
			expect(hit(overlays, screenAt(0, 0, 2), viewport(2))).toBeNull();
		});
	});
});

describe("overlays channel store wiring", () => {
	const overlay: UIOverlay = {
		primitives: [
			{
				kind: "circle",
				cx: 0,
				cy: 0,
				radius: 50,
				stroke: { color: RED, width: 1.5 },
				hitId: "c",
			},
		],
	};

	it("should fire the uiOverlayState deep watch on overlay set and delete", async () => {
		const store = createRendererState();
		let calls = 0;
		const unsubscribe = subscribe(store.uiOverlayState, () => {
			calls++;
		});

		store.uiOverlayState.overlays!["test-tool"] = ref(overlay);
		await flushValtio();
		expect(calls).toBe(1);

		delete store.uiOverlayState.overlays!["test-tool"];
		await flushValtio();
		expect(calls).toBe(2);

		unsubscribe();
	});

	it("should hit-test overlays read back from the store", () => {
		const store = createRendererState();
		store.uiOverlayState.overlays!["test-tool"] = ref(overlay);

		const result = hitTestOverlays(
			store.uiOverlayState.overlays!,
			screenAt(0, 0),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		expect(result).toEqual({ overlayKey: "test-tool", hitId: "c" });
	});
});

// --- Test helpers ---

/** Screen point for a world point under viewport (0, 0, zoom) on 800×600. */
function screenAt(worldX: number, worldY: number, zoom = 1) {
	return {
		x: testCanvasWidth / 2 + worldX * zoom,
		y: testCanvasHeight / 2 - worldY * zoom,
	};
}

function viewport(zoom: number): Viewport {
	return { ...testViewport, zoom };
}

function single(prim: UIPrimitive): Record<string, UIOverlay> {
	return { ov: { primitives: [prim] } };
}

function hit(
	overlays: Record<string, UIOverlay>,
	point: { x: number; y: number },
	vp: Viewport = testViewport,
) {
	return hitTestOverlays(
		overlays,
		point,
		vp,
		testCanvasWidth,
		testCanvasHeight,
	);
}

function straightBezier(
	startX: number,
	startY: number,
	endX: number,
	endY: number,
) {
	return {
		start: { x: startX, y: startY },
		cp1: { x: startX, y: startY },
		cp2: { x: endX, y: endY },
		end: { x: endX, y: endY },
	};
}

/** Valtio batches subscription callbacks in a microtask. */
async function flushValtio(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}
