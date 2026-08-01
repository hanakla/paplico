import { describe, expect, it, vi } from "vitest";
import type { BoundingBox } from "../../../schema";
import {
	type BackdropCaptureManager,
	type BackdropPixelRect,
	calculateBackdropCaptureRegion,
} from "./BackdropCaptureManager";
import {
	BackdropEffectCoordinator,
	type BackdropEffectRequest,
	boundsIntersect,
	FULL_PYRAMID_REBUILD_THRESHOLD,
	planBatchBounds,
	planPyramidDirtyUpdate,
	shouldRebuildFullPyramid,
	snapBoundsToRasterGrid,
} from "./BackdropEffectCoordinator";
import {
	MAX_PYRAMID_LEVELS,
	pyramidLevelVariance,
	requiredPyramidLevels,
	selectPyramidLevels,
} from "./BlurPyramid";
import type { TexturePool } from "./TexturePool";

describe("pyramidLevelVariance", () => {
	it("should be zero at level 0 (the sharp capture)", () => {
		expect(pyramidLevelVariance(0)).toBe(0);
	});

	it("should accumulate each pass's variance: σ²(k) = σ²(k-1) + (2·2^(k-1))²", () => {
		// Level 1 blurs σ=2 in level-0 texels → variance 4.
		expect(pyramidLevelVariance(1)).toBe(4);
		// Level 2 adds σ=2 in level-1 texels = 4 level-0 texels → +16.
		expect(pyramidLevelVariance(2)).toBe(20);
		expect(pyramidLevelVariance(3)).toBe(84);
	});
});

describe("requiredPyramidLevels", () => {
	it("should need no levels when nothing blurs", () => {
		expect(requiredPyramidLevels(0)).toBe(0);
	});

	it("should pick the first level whose effective sigma covers the target", () => {
		// σ_eff(1) = 2 covers sigma 2; σ_eff(2) ≈ 4.47 covers sigma 3.
		expect(requiredPyramidLevels(2)).toBe(1);
		expect(requiredPyramidLevels(3)).toBe(2);
	});

	it("should cap the depth for arbitrarily large sigmas", () => {
		expect(requiredPyramidLevels(10_000)).toBe(MAX_PYRAMID_LEVELS);
	});
});

describe("selectPyramidLevels", () => {
	it("should stay on the sharp level for sigma 0", () => {
		expect(selectPyramidLevels(0, 3)).toEqual({ lo: 0, hi: 0, mix: 0 });
	});

	it("should land exactly on a level whose effective sigma matches", () => {
		// σ_eff(1) = 2 exactly → lo = 1, no interpolation toward level 2.
		expect(selectPyramidLevels(2, 3)).toEqual({ lo: 1, hi: 2, mix: 0 });
	});

	it("should interpolate between the bracketing levels in variance space", () => {
		// σ = 3 → variance 9 between σ²(1) = 4 and σ²(2) = 20 → mix = 5/16.
		const { lo, hi, mix } = selectPyramidLevels(3, 3);
		expect(lo).toBe(1);
		expect(hi).toBe(2);
		expect(mix).toBeCloseTo(5 / 16, 10);
	});

	it("should clamp to the deepest available level", () => {
		expect(selectPyramidLevels(10_000, 2)).toEqual({ lo: 2, hi: 2, mix: 0 });
	});
});

describe("boundsIntersect", () => {
	it("should detect overlapping regions", () => {
		expect(boundsIntersect(box(0, 0, 10, 10), box(5, 5, 15, 15))).toBe(true);
	});

	it("should treat touching edges as intersecting (AA bleed)", () => {
		expect(boundsIntersect(box(0, 0, 10, 10), box(10, 0, 20, 10))).toBe(true);
	});

	it("should reject disjoint regions", () => {
		expect(boundsIntersect(box(0, 0, 10, 10), box(11, 0, 20, 10))).toBe(false);
	});
});

describe("planBatchBounds", () => {
	it("should union pending requests into one capture", () => {
		const target = request(box(0, 0, 10, 10));
		const near = request(box(12, 0, 22, 10));
		expect(planBatchBounds(target, [near])).toEqual(box(0, 0, 22, 10));
	});

	it("should union even distant requests — the region clamps to the canvas, and one shared capture beats per-effect pass overhead", () => {
		const target = request(box(0, 0, 10, 10));
		const far = request(box(1000, 1000, 1010, 1010));
		expect(planBatchBounds(target, [far])).toEqual(box(0, 0, 1010, 1010));
	});

	it("should not depend on blur sigmas", () => {
		const target = request(box(0, 0, 10, 10), 0);
		const other = request(box(5, 0, 15, 10), 40);
		expect(planBatchBounds(target, [other])).toEqual(box(0, 0, 15, 10));
	});
});

describe("planPyramidDirtyUpdate", () => {
	it("should expand and downsample a dirty rectangle for every pyramid pass", () => {
		const update = planPyramidDirtyUpdate(
			[{ x: 40, y: 40, width: 10, height: 10 }],
			100,
			100,
			2,
		);

		expect(update.sharp).toEqual([{ x: 40, y: 40, width: 10, height: 10 }]);
		expect(update.levels).toEqual([
			{
				horizontal: [{ x: 17, y: 40, width: 11, height: 10 }],
				vertical: [{ x: 17, y: 17, width: 11, height: 11 }],
			},
			{
				horizontal: [{ x: 5, y: 17, width: 12, height: 11 }],
				vertical: [{ x: 5, y: 5, width: 12, height: 12 }],
			},
		]);
	});

	it("should clip expanded dirty rectangles to each level's bounds", () => {
		const update = planPyramidDirtyUpdate(
			[{ x: 0, y: 0, width: 1, height: 1 }],
			16,
			16,
			2,
		);

		for (const level of update.levels) {
			for (const rect of [...level.horizontal, ...level.vertical]) {
				expect(rect.x).toBeGreaterThanOrEqual(0);
				expect(rect.y).toBeGreaterThanOrEqual(0);
			}
		}
	});
});

describe("shouldRebuildFullPyramid", () => {
	it("should switch to a full pass at the configured coverage threshold", () => {
		expect(FULL_PYRAMID_REBUILD_THRESHOLD).toBe(0.5);
		expect(
			shouldRebuildFullPyramid(
				[{ x: 0, y: 0, width: 49, height: 100 }],
				100,
				100,
			),
		).toBe(false);
		expect(
			shouldRebuildFullPyramid(
				[{ x: 0, y: 0, width: 50, height: 100 }],
				100,
				100,
			),
		).toBe(true);
	});
});

describe("BackdropEffectCoordinator (epoch batching)", () => {
	it("should serve multiple requests with different sigmas from one capture", () => {
		const { coordinator, captureRegion } = createCoordinator();
		const a = request(box(-10, -10, 0, 0));
		const b = request(box(0, 0, 10, 10));
		coordinator.beginFrame();
		coordinator.planFrame([a, b]);

		acquire(coordinator, a);
		acquire(coordinator, b);

		expect(captureRegion).toHaveBeenCalledTimes(1);
	});

	it("should patch the current capture when a draw touches the next request's region", () => {
		const { coordinator, captureRegion, patchCapturedRegion } =
			createCoordinator();
		const a = request(box(-10, -10, 0, 0));
		const b = request(box(0, 0, 10, 10));
		coordinator.beginFrame();
		coordinator.planFrame([a, b]);

		acquire(coordinator, a);
		coordinator.noteDraw(box(-5, -5, 5, 5));
		acquire(coordinator, b);

		expect(captureRegion).toHaveBeenCalledTimes(1);
		expect(patchCapturedRegion).toHaveBeenCalledTimes(1);
	});

	it("should retain one capture through five overlapping exact glass composites", () => {
		const { coordinator, captureRegion, patchCapturedRegion } =
			createCoordinator();
		const requests = [
			request(box(-10, -10, 10, 10)),
			request(box(-8, -8, 12, 12)),
			request(box(-6, -6, 14, 14)),
			request(box(-4, -4, 16, 16)),
			request(box(-2, -2, 18, 18)),
		];
		coordinator.beginFrame();
		coordinator.planFrame(requests);

		for (const [index, request] of requests.entries()) {
			acquire(coordinator, request);
			if (index < requests.length - 1) coordinator.noteDraw(request.bounds);
		}

		expect(captureRegion).toHaveBeenCalledTimes(1);
		expect(patchCapturedRegion).toHaveBeenCalledTimes(4);
	});

	it("should keep the batch when draws since the capture miss its region", () => {
		const { coordinator, captureRegion } = createCoordinator();
		const a = request(box(-10, -10, 0, 0));
		const b = request(box(0, 0, 10, 10));
		coordinator.beginFrame();
		coordinator.planFrame([a, b]);

		acquire(coordinator, a);
		coordinator.noteDraw(box(500, 500, 600, 600));
		acquire(coordinator, b);

		expect(captureRegion).toHaveBeenCalledTimes(1);
	});

	it("should keep the batch when an earlier compose only touched its own region", () => {
		// The regression that rebuilt the pyramid once per glass: every compose
		// reports its bounds via noteDraw, and judging staleness against the
		// WHOLE batch region made each following glass recapture. Non-overlapping
		// glasses must share one capture — only the request whose own region got
		// painted over needs a fresh one.
		const { coordinator, captureRegion } = createCoordinator();
		const a = request(box(-10, -10, 0, 0));
		const b = request(box(2, 2, 10, 10));
		coordinator.beginFrame();
		coordinator.planFrame([a, b]);

		acquire(coordinator, a);
		// a's compose repaints its own (batch-interior) region, away from b.
		coordinator.noteDraw(box(-10, -10, 0, 0));
		acquire(coordinator, b);

		expect(captureRegion).toHaveBeenCalledTimes(1);
	});

	it("should recapture after an unconditional invalidation", () => {
		const { coordinator, captureRegion } = createCoordinator();
		const a = request(box(-10, -10, 0, 0));
		const b = request(box(0, 0, 10, 10));
		coordinator.beginFrame();
		coordinator.planFrame([a, b]);

		acquire(coordinator, a);
		coordinator.invalidate();
		acquire(coordinator, b);

		expect(captureRegion).toHaveBeenCalledTimes(2);
	});

	it("should share one capture across effects regardless of their spacing", () => {
		// Effect count must not multiply captures: N well-separated on-screen
		// glasses still cost one capture + one pyramid per epoch.
		const { coordinator, captureRegion } = createCoordinator();
		const a = request(box(-300, -200, -250, -150));
		const b = request(box(250, 150, 300, 200));
		coordinator.beginFrame();
		coordinator.planFrame([a, b]);

		acquire(coordinator, a);
		acquire(coordinator, b);

		expect(captureRegion).toHaveBeenCalledTimes(1);
	});

	it("should not let off-screen pending requests inflate the capture region", () => {
		const { coordinator, captureRegion } = createCoordinator();
		const onScreen = request(box(0, 0, 10, 10));
		// Far outside the 800×600 viewport around the origin.
		const offScreen = request(box(5_000, 5_000, 5_010, 5_010));
		coordinator.beginFrame();
		coordinator.planFrame([onScreen, offScreen]);

		const sample = acquire(coordinator, onScreen);

		expect(captureRegion).toHaveBeenCalledTimes(1);
		// The capture covers only the on-screen request — an identity remap.
		// A rect stretched toward the off-screen request would clamp to the
		// whole canvas and remap this effect into a sub-region of it.
		expect(sample.backdropRemap).toEqual([0, 0, 1, 1]);
	});

	it("should map each request's compose rect into the shared capture region", () => {
		const { coordinator } = createCoordinator();
		const a = request(box(-100, -100, 0, 0));
		const b = request(box(0, 0, 100, 100));
		coordinator.beginFrame();
		coordinator.planFrame([a, b]);

		acquire(coordinator, a);
		const sample = acquire(coordinator, b);

		// Batch spans world (-100..100)² → screen 200×200 at (300,200) on the
		// 800×600 canvas; b's region is its bottom-left screen quadrant (world Y
		// up flips to screen Y down): offset (.5, 0), scale (.5, .5).
		expect(sample.rect).toEqual({ x: 400, y: 200, width: 100, height: 100 });
		expect(sample.backdropRemap).toEqual([0.5, 0, 0.5, 0.5]);
	});
});

describe("BackdropEffectCoordinator (fixed-R regions)", () => {
	it("should serve every fixed-R request from one shared capture", () => {
		const { coordinator, captureRegion, encoder } = createFixedRCoordinator();
		const a = request(box(0, 0, 10, 10), 0, 2);
		const b = request(box(20, -10, 30, 10), 0, 2);
		coordinator.beginFrame();
		coordinator.planFrame([a, b]);

		acquireR(coordinator, encoder, a);
		acquireR(coordinator, encoder, b);

		expect(captureRegion).toHaveBeenCalledTimes(1);
		// The one capture spans the union of both requests, on the R grid.
		expect(captureRegion.mock.calls[0][2]).toEqual(box(0, -10, 30, 10));
		expect(captureRegion.mock.calls[0][8]).toBe(2);
		expect(encoder.copyTextureToTexture).toHaveBeenCalledTimes(2);
	});

	it("should crop each request at integer texel offsets on the shared R grid", () => {
		const { coordinator, encoder } = createFixedRCoordinator();
		const a = request(box(0, 0, 10, 10), 0, 2);
		const b = request(box(20, -10, 30, 10), 0, 2);
		coordinator.beginFrame();
		coordinator.planFrame([a, b]);

		const regionA = acquireR(coordinator, encoder, a);
		const regionB = acquireR(coordinator, encoder, b);

		// Batch covers world (0,-10)-(30,10) at R=2 → 60×40 texels, world maxY
		// at texel row 0. a = (0,0)-(10,10): origin (0,0), 20×20.
		const copies = vi.mocked(encoder.copyTextureToTexture).mock.calls;
		expect(copies[0][0].origin).toEqual({ x: 0, y: 0 });
		expect(copies[0][2]).toEqual({ width: 20, height: 20 });
		expect(regionA?.actualBounds).toEqual(box(0, 0, 10, 10));
		// b = (20,-10)-(30,10): 40 texels right of batch minX, at the top row.
		expect(copies[1][0].origin).toEqual({ x: 40, y: 0 });
		expect(copies[1][2]).toEqual({ width: 20, height: 40 });
		expect(regionB?.actualBounds).toEqual(box(20, -10, 30, 10));
	});

	it("should map the cropped region back to prebuf UVs", () => {
		const { coordinator, encoder } = createFixedRCoordinator();
		const a = request(box(0, 0, 10, 10), 0, 2);
		coordinator.beginFrame();
		coordinator.planFrame([a]);

		const region = acquireR(coordinator, encoder, a);

		// 800×600 canvas at zoom 1 around the origin: world (0,0)-(10,10) is
		// screen x 400..410 (U 0.5..0.5125), y 290..300 (V ~0.4833..0.5).
		expect(region?.sourceUV.minU).toBeCloseTo(0.5, 10);
		expect(region?.sourceUV.maxU).toBeCloseTo(0.5125, 10);
		expect(region?.sourceUV.minV).toBeCloseTo(290 / 600, 10);
		expect(region?.sourceUV.maxV).toBeCloseTo(0.5, 10);
	});

	it("should recapture when a reported draw intersects the next request", () => {
		const { coordinator, captureRegion, encoder } = createFixedRCoordinator();
		const a = request(box(0, 0, 10, 10), 0, 2);
		const b = request(box(20, -10, 30, 10), 0, 2);
		coordinator.beginFrame();
		coordinator.planFrame([a, b]);

		acquireR(coordinator, encoder, a);
		coordinator.noteDraw(box(25, 0, 28, 5));
		acquireR(coordinator, encoder, b);

		expect(captureRegion).toHaveBeenCalledTimes(2);
	});

	it("should keep the shared capture when draws miss the request", () => {
		const { coordinator, captureRegion, encoder } = createFixedRCoordinator();
		const a = request(box(0, 0, 10, 10), 0, 2);
		const b = request(box(20, -10, 30, 10), 0, 2);
		coordinator.beginFrame();
		coordinator.planFrame([a, b]);

		acquireR(coordinator, encoder, a);
		coordinator.noteDraw(box(0, 0, 10, 10));
		acquireR(coordinator, encoder, b);

		expect(captureRegion).toHaveBeenCalledTimes(1);
	});

	it("should batch display and fixed-R requests separately", () => {
		const { coordinator, captureRegion, encoder } = createFixedRCoordinator();
		const glass = request(box(-50, -50, -40, -40));
		const filter = request(box(0, 0, 10, 10), 0, 2);
		coordinator.beginFrame();
		coordinator.planFrame([glass, filter]);

		coordinator.acquireSample(
			encoder,
			{ format: "rgba8unorm" } as GPUTexture,
			VIEWPORT,
			CANVAS_WIDTH,
			CANVAS_HEIGHT,
			glass,
		);
		acquireR(coordinator, encoder, filter);

		expect(captureRegion).toHaveBeenCalledTimes(2);
		// Neither domain's capture is inflated by the other's requests.
		expect(captureRegion.mock.calls[0][2]).toEqual(glass.bounds);
		expect(captureRegion.mock.calls[1][2]).toEqual(filter.bounds);
	});

	it("should return null for a fully off-screen fixed-R request", () => {
		const { coordinator, captureRegion, encoder } = createFixedRCoordinator();
		const offScreen = request(box(5_000, 5_000, 5_010, 5_010), 0, 2);
		coordinator.beginFrame();
		coordinator.planFrame([offScreen]);

		expect(acquireR(coordinator, encoder, offScreen)).toBeNull();
		expect(captureRegion).not.toHaveBeenCalled();
	});

	it("should recapture fixed-R batches after an unconditional invalidation", () => {
		const { coordinator, captureRegion, encoder } = createFixedRCoordinator();
		const a = request(box(0, 0, 10, 10), 0, 2);
		const b = request(box(20, -10, 30, 10), 0, 2);
		coordinator.beginFrame();
		coordinator.planFrame([a, b]);

		acquireR(coordinator, encoder, a);
		coordinator.invalidate();
		acquireR(coordinator, encoder, b);

		expect(captureRegion).toHaveBeenCalledTimes(2);
	});

	it("should fall back to an individual uncropped capture when the batch texture was clamped off the R grid", () => {
		// Simulate the device texture-size limit compressing the union capture:
		// integer-offset crops would read the wrong texels, so the request gets
		// its own capture, returned whole.
		const { coordinator, captureRegion, encoder } = createFixedRCoordinator({
			maxTextureDim: 30,
		});
		const a = request(box(0, 0, 10, 10), 0, 2);
		const b = request(box(20, -10, 30, 10), 0, 2);
		coordinator.beginFrame();
		coordinator.planFrame([a, b]);

		const region = acquireR(coordinator, encoder, a);

		// Union capture (60 texels wide, clamped to 30) + individual recapture.
		expect(captureRegion).toHaveBeenCalledTimes(2);
		expect(captureRegion.mock.calls[1][2]).toEqual(a.bounds);
		expect(encoder.copyTextureToTexture).not.toHaveBeenCalled();
		expect(region?.actualBounds).toEqual(box(0, 0, 10, 10));
	});
});

// Helpers

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const VIEWPORT = { x: 0, y: 0, zoom: 1 };

function box(minX: number, minY: number, maxX: number, maxY: number) {
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function request(
	bounds: BoundingBox,
	blurSigma = 0,
	rasterScale?: number,
): BackdropEffectRequest {
	return { bounds, blurSigma, rasterScale };
}

/** Coordinator with a spy capture manager and inert GPU deps. sigma-0
 *  requests never reach the pyramid pipeline, so no real device is needed. */
function createCoordinator() {
	const fakeTexture = {
		width: 1024,
		height: 1024,
		createView: () => ({}),
	} as unknown as GPUTexture;
	const captureRegion = vi.fn(() => ({
		texture: fakeTexture,
		actualBounds: box(0, 0, 1, 1),
		sourceUV: { minU: 0, minV: 0, maxU: 1, maxV: 1 },
		filtered: false,
	}));
	const patchCapturedRegion = vi.fn(
		(): BackdropPixelRect => ({ x: 0, y: 0, width: 1, height: 1 }),
	);
	const coordinator = new BackdropEffectCoordinator(
		{} as GPUDevice,
		{
			acquire: vi.fn(() => fakeTexture),
			release: vi.fn(),
		} as unknown as TexturePool,
		{ captureRegion, patchCapturedRegion } as unknown as BackdropCaptureManager,
	);
	return { coordinator, captureRegion, patchCapturedRegion };
}

function acquire(
	coordinator: BackdropEffectCoordinator,
	req: BackdropEffectRequest,
) {
	const sample = coordinator.acquireSample(
		{} as GPUCommandEncoder,
		{ format: "rgba8unorm" } as GPUTexture,
		VIEWPORT,
		CANVAS_WIDTH,
		CANVAS_HEIGHT,
		req,
	);
	if (!sample) throw new Error("acquireSample returned null");
	return sample;
}

/** Coordinator whose capture manager mimics the real fixed-R path: canvas
 *  clamp → R-grid snap → an R-sized texture (clamped to maxTextureDim). */
function createFixedRCoordinator({ maxTextureDim = 8192 } = {}) {
	const fakeTexture = (width: number, height: number) =>
		({
			width,
			height,
			format: "rgba8unorm",
			createView: () => ({}),
		}) as unknown as GPUTexture;
	const captureRegion = vi.fn(
		(
			_encoder: GPUCommandEncoder,
			_source: GPUTexture,
			bounds: BoundingBox,
			viewport: { x: number; y: number; zoom: number },
			canvasWidth: number,
			canvasHeight: number,
			_filters?: unknown,
			_mask?: unknown,
			rasterScale?: number,
		) => {
			const region = calculateBackdropCaptureRegion(
				bounds,
				viewport,
				canvasWidth,
				canvasHeight,
			);
			if (rasterScale == null) {
				return {
					texture: fakeTexture(region.copySize.width, region.copySize.height),
					actualBounds: region.actualBounds,
					sourceUV: region.sourceUV,
					filtered: false,
				};
			}
			const snapped = snapBoundsToRasterGrid(region.actualBounds, rasterScale);
			return {
				texture: fakeTexture(
					Math.min(
						Math.max(1, Math.round(snapped.width * rasterScale)),
						maxTextureDim,
					),
					Math.min(
						Math.max(1, Math.round(snapped.height * rasterScale)),
						maxTextureDim,
					),
				),
				actualBounds: snapped,
				sourceUV: region.sourceUV,
				filtered: false,
			};
		},
	);
	const device = {
		createTexture: vi.fn((desc: { size: { width: number; height: number } }) =>
			fakeTexture(desc.size.width, desc.size.height),
		),
	} as unknown as GPUDevice;
	const encoder = {
		copyTextureToTexture: vi.fn(),
	} as unknown as GPUCommandEncoder;
	const coordinator = new BackdropEffectCoordinator(
		device,
		{
			acquire: vi.fn(),
			acquireExact: vi.fn((width: number, height: number) =>
				fakeTexture(width, height),
			),
			release: vi.fn(),
		} as unknown as TexturePool,
		{ captureRegion } as unknown as BackdropCaptureManager,
	);
	return { coordinator, captureRegion, encoder };
}

function acquireR(
	coordinator: BackdropEffectCoordinator,
	encoder: GPUCommandEncoder,
	req: BackdropEffectRequest,
) {
	return coordinator.acquireFixedRRegion(
		encoder,
		{ format: "rgba8unorm" } as GPUTexture,
		VIEWPORT,
		CANVAS_WIDTH,
		CANVAS_HEIGHT,
		req,
	);
}
