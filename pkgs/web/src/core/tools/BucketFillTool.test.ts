import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockToolContext } from "../testUtils/mockToolContext";
import {
	ev,
	testCanvasHeight,
	testCanvasWidth,
	testViewport,
} from "../testUtils/pointerEvent";
import { BucketFillTool } from "./BucketFillTool";
import { maskToPath } from "./bucketFill/maskToPath";
import {
	createRasterSpace,
	rasterToWorld,
	type WorldRegion,
} from "./bucketFill/rasterSpace";

// Default viewport (0,0,zoom=1), canvas 800x600:
//   screen(400,300) → world(0,0)
//   screen(410,300) → world(10,0)

function createMockCallbacks() {
	const ctx = createMockToolContext({
		renderWorldRegionToImageData: vi.fn(async () => null),
	});
	return ctx;
}

describe("BucketFillTool", () => {
	let tool: BucketFillTool;
	let ctx: ReturnType<typeof createMockCallbacks>;

	beforeEach(() => {
		ctx = createMockCallbacks();
		tool = new BucketFillTool(ctx);
	});

	describe("click (no drag)", () => {
		it("calls renderWorldRegionToImageData on pointer up after a stationary click", async () => {
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Move within threshold (< 4px)
			tool.onPointerMove(
				ev(402, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(402, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// Give the async computeAndPreviewArea a tick to run
			await vi.waitFor(() => {
				expect(ctx.renderWorldRegionToImageData).toHaveBeenCalledOnce();
			});
		});

		it("does not call requestRender(cursor) during a stationary click", () => {
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(402, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(402, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.requestRender).not.toHaveBeenCalledWith("cursor");
		});
	});

	describe("drag (cut path)", () => {
		// Cutting requires an existing fill area with a targetAreaId.
		// Create one via a click first, then drag on it.
		function setupWithFillArea() {
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
			vi.clearAllMocks();
		}

		it("transitions to cutting state when pointer moves beyond 4px threshold", () => {
			setupWithFillArea();
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Move 5px — crosses threshold
			tool.onPointerMove(
				ev(405, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.requestRender).toHaveBeenCalledWith("cursor");
		});

		it("does not transition to cutting when movement is below 4px threshold", () => {
			setupWithFillArea();
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Move only 3px — stays pending
			tool.onPointerMove(
				ev(403, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			expect(ctx.requestRender).not.toHaveBeenCalledWith("cursor");
		});

		it("accumulates points in cutting state as pointer moves", () => {
			setupWithFillArea();
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// First move — crosses threshold, starts cutting with 1 point
			tool.onPointerMove(
				ev(405, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Subsequent moves add more points
			tool.onPointerMove(
				ev(410, 305),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(415, 310),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			// requestRender should be called for each move while cutting
			expect(ctx.requestRender).toHaveBeenCalledTimes(3);
		});

		it("calls renderWorldRegionToImageData after drag with >2 points on pointer up", async () => {
			setupWithFillArea();
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Cross threshold
			tool.onPointerMove(
				ev(405, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Add 2 more points
			tool.onPointerMove(
				ev(410, 305),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerMove(
				ev(415, 310),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onPointerUp(
				ev(415, 310),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			await vi.waitFor(() => {
				expect(ctx.renderWorldRegionToImageData).toHaveBeenCalledOnce();
			});
		});

		it("does not call renderWorldRegionToImageData after drag with ≤2 points on pointer up", async () => {
			setupWithFillArea();
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Cross threshold — 1 point
			tool.onPointerMove(
				ev(405, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Only 1 point in cutting state — should not commit cut
			tool.onPointerUp(
				ev(405, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			await new Promise((r) => setTimeout(r, 0));
			expect(ctx.renderWorldRegionToImageData).not.toHaveBeenCalled();
		});
	});

	describe("pointer-down must not trigger immediate decisions", () => {
		it("does not call renderWorldRegionToImageData on pointer-down alone", async () => {
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			await new Promise((r) => setTimeout(r, 0));
			expect(ctx.renderWorldRegionToImageData).not.toHaveBeenCalled();
		});

		it("does not call previewUpdate on pointer-down alone", async () => {
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			await new Promise((r) => setTimeout(r, 0));
			expect(ctx.previewUpdate).not.toHaveBeenCalled();
		});

		it("does not remove a simulated hit area on pointer-down alone", async () => {
			// Simulate: click to create a fill area first
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
			// Reset call counts
			vi.clearAllMocks();

			// Now simulate a second pointer-down at the same spot
			// (even if hitExisting would be true in real usage, previewUpdate must not fire yet)
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			await new Promise((r) => setTimeout(r, 0));
			// No area deletion should happen until pointer-up
			expect(ctx.previewUpdate).not.toHaveBeenCalled();
			expect(ctx.renderWorldRegionToImageData).not.toHaveBeenCalled();
		});

		it("only triggers flood fill after pointer-up, not during pointer-down or pointer-move within threshold", async () => {
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			// Move within threshold
			tool.onPointerMove(
				ev(401, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			await new Promise((r) => setTimeout(r, 0));
			expect(ctx.renderWorldRegionToImageData).not.toHaveBeenCalled();

			// Only after pointer-up should the flood fill execute
			tool.onPointerUp(
				ev(401, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);

			await vi.waitFor(() => {
				expect(ctx.renderWorldRegionToImageData).toHaveBeenCalledOnce();
			});
		});
	});

	describe("onCancel", () => {
		it("clears preview and resets state", () => {
			tool.onPointerDown(
				ev(400, 300),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			tool.onCancel();

			expect(ctx.previewUpdate).toHaveBeenCalledWith(null);
		});
	});
});

// --- Document-wide expanding-window fill ---

type Rgba = [number, number, number, number];

/** Mock renderer that rasterizes a world-space scene for any region/scale. */
function createSyntheticRegionRenderer(
	sampleWorld: (wx: number, wy: number) => Rgba,
) {
	return vi.fn(async (region: WorldRegion, scale: number) => {
		const space = createRasterSpace(region, scale);
		const data = new Uint8ClampedArray(space.width * space.height * 4);
		for (let y = 0; y < space.height; y++) {
			for (let x = 0; x < space.width; x++) {
				const w = rasterToWorld(space, x, y);
				const [r, g, b, a] = sampleWorld(w.x, w.y);
				const i = (y * space.width + x) * 4;
				data[i] = r;
				data[i + 1] = g;
				data[i + 2] = b;
				data[i + 3] = a;
			}
		}
		return { width: space.width, height: space.height, data } as ImageData;
	});
}

/** Ring barrier centered at world origin. gapAngle opens the ring at angle 0. */
function ringScene(radius: number, thickness: number, gapAngle: number | null) {
	return (wx: number, wy: number): Rgba => {
		const d = Math.hypot(wx, wy);
		if (Math.abs(d - radius) <= thickness) {
			if (gapAngle != null && Math.abs(Math.atan2(wy, wx)) < gapAngle) {
				return [0, 0, 0, 0];
			}
			return [0, 0, 0, 255];
		}
		return [0, 0, 0, 0];
	};
}

/** Square outline barrier centered at world origin. */
function boxScene(innerHalf: number, outerHalf: number) {
	return (wx: number, wy: number): Rgba => {
		const m = Math.max(Math.abs(wx), Math.abs(wy));
		return m >= innerHalf && m <= outerHalf ? [0, 0, 0, 255] : [0, 0, 0, 0];
	};
}

/** White artboard (square, half-size abHalf) with a black ring on it. */
function artboardRingScene(
	abHalf: number,
	radius: number,
	thickness: number,
	gapAngle: number | null,
) {
	return (wx: number, wy: number): Rgba => {
		if (Math.abs(wx) > abHalf || Math.abs(wy) > abHalf) return [0, 0, 0, 0];
		const d = Math.hypot(wx, wy);
		if (Math.abs(d - radius) <= thickness) {
			if (gapAngle != null && Math.abs(Math.atan2(wy, wx)) < gapAngle) {
				return [255, 255, 255, 255];
			}
			return [0, 0, 0, 255];
		}
		return [255, 255, 255, 255];
	};
}

describe("BucketFillTool document-wide fill", () => {
	const RING_R = 600;
	const fillColor = {
		type: "solid" as const,
		color: { type: "rgb" as const, r: 1, g: 0, b: 0, a: 1 },
	};

	function setupWithScene(
		sampleWorld: (wx: number, wy: number) => Rgba,
		docHalf: number,
	) {
		const render = createSyntheticRegionRenderer(sampleWorld);
		const ctx = createMockToolContext({
			renderWorldRegionToImageData: render,
			getDocumentContentBounds: vi.fn(() => ({
				centerX: 0,
				centerY: 0,
				width: docHalf * 2,
				height: docHalf * 2,
			})),
			getMaxRasterDimension: vi.fn(() => 2048),
		});
		const tool = new BucketFillTool(ctx);
		return { render, ctx, tool };
	}

	function clickAt(tool: BucketFillTool, x: number, y: number) {
		tool.onPointerDown(
			ev(x, y),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		tool.onPointerUp(ev(x, y), testViewport, testCanvasWidth, testCanvasHeight);
	}

	async function waitForPreview(ctx: ReturnType<typeof createMockToolContext>) {
		await vi.waitFor(
			() => {
				const nonNull = ctx.previewUpdate.mock.calls.filter(
					(c) => c[0] !== null,
				);
				expect(nonNull.length).toBeGreaterThan(0);
			},
			{ timeout: 10_000 },
		);
	}

	it("should fill a closed region larger than the viewport by expanding the window", async () => {
		const { render, ctx, tool } = setupWithScene(
			ringScene(RING_R, 4, null),
			RING_R + 8,
		);
		clickAt(tool, 400, 300); // world (0,0), inside the ring

		await waitForPreview(ctx);

		// Window expanded beyond the initial viewport-sized request
		expect(render.mock.calls.length).toBeGreaterThanOrEqual(2);
		const firstRegion = render.mock.calls[0][0];
		expect(firstRegion.centerX).toBeCloseTo(0);
		expect(firstRegion.worldWidth).toBeCloseTo(800);

		tool.confirmFill(fillColor);
		expect(ctx.addPaths.mock.calls.length).toBe(1);
		const path = ctx.addPaths.mock.calls[0][0][0];
		const xs = path.segments.map((s: { end: { x: number } }) => s.end.x);
		expect(Math.max(...xs)).toBeGreaterThan(RING_R * 0.9);
		expect(Math.min(...xs)).toBeLessThan(-RING_R * 0.9);
	});

	it("should produce no fill when the region is unbounded (open ring)", async () => {
		const { ctx, tool } = setupWithScene(
			ringScene(RING_R, 4, 0.06),
			RING_R + 8,
		);
		clickAt(tool, 400, 300);

		// The unbounded area produces no fill preview
		await vi.waitFor(
			() => {
				expect(ctx.previewUpdate.mock.calls.length).toBeGreaterThan(0);
			},
			{ timeout: 10_000 },
		);
		expect(
			ctx.previewUpdate.mock.calls.filter((c) => c[0] !== null).length,
		).toBe(0);

		tool.confirmFill(fillColor);
		expect(ctx.addPaths.mock.calls.length).toBe(0);
	});

	it("should report leak markers near the opening of an unbounded region", async () => {
		const { ctx, tool } = setupWithScene(
			ringScene(RING_R, 4, 0.06),
			RING_R + 8,
		);
		clickAt(tool, 400, 300);

		await vi.waitFor(
			() => {
				const states = ctx.setBucketFillLeaks.mock.calls.map((c) => c[0]);
				expect(states.some((s) => s !== null && s.count >= 1)).toBe(true);
			},
			{ timeout: 10_000 },
		);

		const state = ctx.setBucketFillLeaks.mock.calls.at(-1)?.[0];
		if (!state) throw new Error("expected a leak state to be published");
		expect(state.count).toBeGreaterThanOrEqual(1);
		expect(state.noBarriers).toBe(false);
		expect(state.canSealFill).toBe(true);

		// Overlay contains the leak marker near the ring opening at world (R, 0)
		const lastOverlay = ctx.uiSetOverlay.mock.calls.at(-1)?.[1];
		if (!lastOverlay) throw new Error("expected a bucket fill overlay");
		const circles = lastOverlay.primitives.filter(
			(p): p is Extract<typeof p, { kind: "circle" }> => p.kind === "circle",
		);
		expect(circles.length).toBeGreaterThanOrEqual(3);
		const marker = circles.find((p) => p.hitId != null);
		if (!marker) throw new Error("expected a hit-testable leak marker");
		expect(Math.abs(marker.cx - RING_R)).toBeLessThan(30);
		expect(Math.abs(marker.cy)).toBeLessThan(30);
	});

	it("should report noBarriers for a click with nothing around it", async () => {
		const render = createSyntheticRegionRenderer(() => [0, 0, 0, 0]);
		const ctx = createMockToolContext({
			renderWorldRegionToImageData: render,
			getDocumentContentBounds: vi.fn(() => null),
			getMaxRasterDimension: vi.fn(() => 2048),
		});
		const tool = new BucketFillTool(ctx);
		clickAt(tool, 400, 300);

		await vi.waitFor(
			() => {
				const states = ctx.setBucketFillLeaks.mock.calls.map((c) => c[0]);
				expect(states.some((s) => s !== null)).toBe(true);
			},
			{ timeout: 10_000 },
		);

		const state = ctx.setBucketFillLeaks.mock.calls.at(-1)?.[0];
		if (!state) throw new Error("expected a leak state to be published");
		expect(state.count).toBe(0);
		expect(state.noBarriers).toBe(true);
		expect(state.canSealFill).toBe(false);
	});

	it("should clear leak markers on the next pointer-down", async () => {
		const { ctx, tool } = setupWithScene(
			ringScene(RING_R, 4, 0.06),
			RING_R + 8,
		);
		clickAt(tool, 400, 300);

		await vi.waitFor(
			() => {
				const states = ctx.setBucketFillLeaks.mock.calls.map((c) => c[0]);
				expect(states.some((s) => s !== null && s.count >= 1)).toBe(true);
			},
			{ timeout: 10_000 },
		);

		tool.onPointerDown(
			ev(100, 100),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		expect(ctx.setBucketFillLeaks.mock.calls.at(-1)?.[0]).toBeNull();
	});

	it("should commit the sealed region via confirmSealedFill", async () => {
		const { ctx, tool } = setupWithScene(
			ringScene(RING_R, 4, 0.06),
			RING_R + 8,
		);
		clickAt(tool, 400, 300);

		await vi.waitFor(
			() => {
				const states = ctx.setBucketFillLeaks.mock.calls.map((c) => c[0]);
				expect(states.some((s) => s !== null && s.canSealFill)).toBe(true);
			},
			{ timeout: 10_000 },
		);

		tool.confirmSealedFill(fillColor);

		expect(ctx.addPaths.mock.calls.length).toBe(1);
		const path = ctx.addPaths.mock.calls[0][0][0];
		const xs = path.segments.map((s: { end: { x: number } }) => s.end.x);
		expect(Math.max(...xs)).toBeGreaterThan(RING_R * 0.8);
		expect(Math.min(...xs)).toBeLessThan(-RING_R * 0.8);
		expect(ctx.setBucketFillLeaks.mock.calls.at(-1)?.[0]).toBeNull();
	});

	it("should jump the view to the gap when a leak marker is clicked", async () => {
		const { ctx, tool } = setupWithScene(
			ringScene(RING_R, 4, 0.06),
			RING_R + 8,
		);
		clickAt(tool, 400, 300);

		await vi.waitFor(
			() => {
				const states = ctx.setBucketFillLeaks.mock.calls.map((c) => c[0]);
				expect(states.some((s) => s !== null && s.count >= 1)).toBe(true);
			},
			{ timeout: 10_000 },
		);

		// The ring opening is at world (R, 0) → screen (400 + R, 300)
		tool.onPointerDown(
			ev(400 + RING_R, 300),
			testViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(ctx.panToWorldPoint.mock.calls.length).toBe(1);
		const [point, zoom] = ctx.panToWorldPoint.mock.calls[0];
		expect(Math.abs(point.x - RING_R)).toBeLessThan(30);
		expect(Math.abs(point.y)).toBeLessThan(30);
		expect(zoom).toBeGreaterThanOrEqual(testViewport.zoom);
		// Markers stay visible after the jump
		expect(ctx.setBucketFillLeaks.mock.calls.at(-1)?.[0]).not.toBeNull();
	});

	it("should fill a small closed region with a single render request", async () => {
		const { render, ctx, tool } = setupWithScene(boxScene(90, 100), 100);
		clickAt(tool, 400, 300);

		await waitForPreview(ctx);

		expect(render.mock.calls.length).toBe(1);

		tool.confirmFill(fillColor);
		const path = ctx.addPaths.mock.calls[0][0][0];
		const xs = path.segments.map((s: { end: { x: number } }) => s.end.x);
		expect(Math.max(...xs)).toBeLessThanOrEqual(95);
		expect(Math.max(...xs)).toBeGreaterThan(80);
	});

	describe("artboard spill", () => {
		const AB_HALF = 500;
		const SPILL_R = 200;

		function setupOnArtboard(gapAngle: number | null) {
			const render = createSyntheticRegionRenderer(
				artboardRingScene(AB_HALF, SPILL_R, 4, gapAngle),
			);
			const ctx = createMockToolContext({
				renderWorldRegionToImageData: render,
				getDocumentContentBounds: vi.fn(() => ({
					centerX: 0,
					centerY: 0,
					width: AB_HALF * 2,
					height: AB_HALF * 2,
				})),
				getMaxRasterDimension: vi.fn(() => 2048),
				getArtboards: vi.fn(() => [
					{
						id: "ab1",
						name: "Artboard 1",
						x: 0,
						y: 0,
						width: AB_HALF * 2,
						height: AB_HALF * 2,
					},
				]),
			});
			const tool = new BucketFillTool(ctx);
			return { render, ctx, tool };
		}

		it("should warn with markers when a bounded fill spills across the artboard", async () => {
			const { ctx, tool } = setupOnArtboard(0.1);
			clickAt(tool, 400, 300); // world (0,0), inside the leaky ring

			await vi.waitFor(
				() => {
					const states = ctx.setBucketFillLeaks.mock.calls.map((c) => c[0]);
					expect(states.some((s) => s !== null && s.spill)).toBe(true);
				},
				{ timeout: 10_000 },
			);

			const state = ctx.setBucketFillLeaks.mock.calls.at(-1)?.[0];
			if (!state) throw new Error("expected a leak state to be published");
			expect(state.spill).toBe(true);
			expect(state.count).toBeGreaterThanOrEqual(1);
			expect(state.canSealFill).toBe(true);

			// The (leaky) fill preview is kept on screen
			expect(
				ctx.previewUpdate.mock.calls.filter((c) => c[0] !== null).length,
			).toBeGreaterThan(0);

			// Marker sits near the ring opening at world (R, 0)
			const lastOverlay = ctx.uiSetOverlay.mock.calls.at(-1)?.[1];
			if (!lastOverlay) throw new Error("expected a bucket fill overlay");
			const marker = lastOverlay.primitives.find(
				(p): p is Extract<typeof p, { kind: "circle" }> =>
					p.kind === "circle" && p.hitId != null,
			);
			if (!marker) throw new Error("expected a hit-testable leak marker");
			expect(Math.abs(marker.cx - SPILL_R)).toBeLessThan(30);
			expect(Math.abs(marker.cy)).toBeLessThan(30);

			// Seal-and-fill commits the ring interior, not the whole artboard
			tool.confirmSealedFill(fillColor);
			expect(ctx.addPaths.mock.calls.length).toBe(1);
			const path = ctx.addPaths.mock.calls[0][0][0];
			const xs = path.segments.map((s: { end: { x: number } }) => s.end.x);
			expect(Math.max(...xs)).toBeLessThan(SPILL_R * 1.5);
			expect(Math.max(...xs)).toBeGreaterThan(SPILL_R * 0.7);
		});

		it("should not warn when the artboard background is filled on purpose", async () => {
			const { ctx, tool } = setupOnArtboard(null); // closed ring
			clickAt(tool, 750, 300); // world (350, 0): open background area

			await waitForPreview(ctx);

			expect(ctx.setBucketFillLeaks.mock.calls.at(-1)?.[0] ?? null).toBeNull();
		});
	});

	it("should not apply results computed before onCancel (stale-run guard)", async () => {
		const { render, ctx, tool } = setupWithScene(boxScene(90, 100), 100);
		clickAt(tool, 400, 300);
		tool.onCancel();
		ctx.previewUpdate.mockClear();

		await vi.waitFor(() => {
			expect(render.mock.calls.length).toBeGreaterThan(0);
		});
		await new Promise((r) => setTimeout(r, 20));

		expect(
			ctx.previewUpdate.mock.calls.filter((c) => c[0] !== null).length,
		).toBe(0);
	});
});

// --- maskToPath simplification tests ---

function buildCircleMask(
	width: number,
	height: number,
	cx: number,
	cy: number,
	r: number,
): Uint8Array {
	const mask = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const dx = x - cx;
			const dy = y - cy;
			if (dx * dx + dy * dy < r * r) mask[y * width + x] = 1;
		}
	}
	return mask;
}

function buildRectMask(
	width: number,
	height: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): Uint8Array {
	const mask = new Uint8Array(width * height);
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			mask[y * width + x] = 1;
		}
	}
	return mask;
}

function buildLShapeMask(width: number, height: number): Uint8Array {
	const mask = new Uint8Array(width * height);
	// Horizontal bar
	for (let y = 40; y < 60; y++) {
		for (let x = 20; x < 80; x++) mask[y * width + x] = 1;
	}
	// Vertical bar (left)
	for (let y = 20; y < 80; y++) {
		for (let x = 20; x < 40; x++) mask[y * width + x] = 1;
	}
	return mask;
}

const W = 200;
const H = 150;
const simplifySpace = createRasterSpace(
	{ centerX: 0, centerY: 0, worldWidth: W, worldHeight: H },
	1,
);
const defaultFill = {
	type: "solid" as const,
	color: { type: "rgb" as const, r: 0, g: 0, b: 1, a: 1 },
};

describe("maskToPath simplification", () => {
	it("should reduce a 50px-radius circle to fewer than 10 segments", () => {
		const mask = buildCircleMask(W, H, 100, 75, 50);
		const path = maskToPath(mask, simplifySpace, defaultFill);

		expect(path).not.toBeNull();
		expect(path!.segments.length).toBeLessThan(10);
	});

	it("should reduce a 40x40 rectangle to fewer than 10 segments", () => {
		const mask = buildRectMask(W, H, 30, 30, 70, 70);
		const path = maskToPath(mask, simplifySpace, defaultFill);

		expect(path).not.toBeNull();
		expect(path!.segments.length).toBeLessThan(10);
	});

	it("should handle L-shaped regions preserving corners", () => {
		const mask = buildLShapeMask(W, H);
		const path = maskToPath(mask, simplifySpace, defaultFill);

		expect(path).not.toBeNull();
		// L-shape has 6 corners; segments should be in a reasonable range
		expect(path!.segments.length).toBeLessThan(20);
		expect(path!.segments.length).toBeGreaterThanOrEqual(6);
	});

	it("should not produce segments with chord length below 1.5 world units", () => {
		const mask = buildCircleMask(W, H, 100, 75, 50);
		const path = maskToPath(mask, simplifySpace, defaultFill);
		if (!path) return;

		for (let i = 0; i < path.segments.length; i++) {
			const seg = path.segments[i];
			const prev = i === 0 ? seg.start! : path.segments[i - 1].end;
			const dx = seg.end.x - prev.x;
			const dy = seg.end.y - prev.y;
			const chord = Math.sqrt(dx * dx + dy * dy);
			expect(chord).toBeGreaterThanOrEqual(1.5);
		}
	});

	it("should produce fewer segments at larger canvas scale (800x600)", () => {
		const bigW = 800;
		const bigH = 600;
		const bigSpace = createRasterSpace(
			{ centerX: 0, centerY: 0, worldWidth: bigW, worldHeight: bigH },
			1,
		);
		const mask = buildCircleMask(bigW, bigH, 400, 300, 150);
		const path = maskToPath(mask, bigSpace, defaultFill);

		expect(path).not.toBeNull();
		// A large circle should still simplify to a reasonable number of segments
		expect(path!.segments.length).toBeLessThan(16);
	});
});
