import { describe, expect, it, vi } from "vitest";
import type { BoundingBox, Viewport } from "../../../schema";
import { degToRad } from "../../../testUtils/pointerEvent";
import { worldToScreen } from "../../../utils/geometry/geometry";
import type { GPUTimingProfiler } from "../../GPUTimingProfiler";
import {
	BackdropCaptureManager,
	calculateBackdropCaptureRegion,
} from "./BackdropCaptureManager";

const canvasWidth = 800;
const canvasHeight = 600;

describe("BackdropCaptureManager", () => {
	const viewport: Viewport = {
		x: 10,
		y: -5,
		zoom: 1.2,
		rotation: 0,
	};

	it("should keep prebuf UV stable when viewport rotation changes", () => {
		const captureBounds: BoundingBox = {
			minX: -32,
			minY: -24,
			maxX: 32,
			maxY: 24,
			width: 64,
			height: 48,
		};
		const viewportAtRotation0: Viewport = { ...viewport, rotation: 0 };
		const viewportAtRotation37: Viewport = {
			...viewport,
			rotation: degToRad(37),
		};

		const atRotation0 = calculateBackdropCaptureRegion(
			captureBounds,
			viewportAtRotation0,
			canvasWidth,
			canvasHeight,
		);
		const atRotation37 = calculateBackdropCaptureRegion(
			captureBounds,
			viewportAtRotation37,
			canvasWidth,
			canvasHeight,
		);

		expect(atRotation37.sourceUV).toEqual(atRotation0.sourceUV);
		expect(atRotation37.actualBounds).toEqual(atRotation0.actualBounds);
	});

	it("should avoid legacy screen-space drift for the same world point", () => {
		const worldPoint = { x: 40, y: -10 };

		const legacyAtRotation0 = worldToScreen(
			worldPoint.x,
			worldPoint.y,
			{ ...viewport, rotation: 0 },
			canvasWidth,
			canvasHeight,
		);
		const legacyAtRotation37 = worldToScreen(
			worldPoint.x,
			worldPoint.y,
			{ ...viewport, rotation: 37 },
			canvasWidth,
			canvasHeight,
		);

		expect(legacyAtRotation37.x).not.toBeCloseTo(legacyAtRotation0.x);
		expect(legacyAtRotation37.y).not.toBeCloseTo(legacyAtRotation0.y);

		const captureBounds: BoundingBox = {
			minX: worldPoint.x - 0.5,
			minY: worldPoint.y - 0.5,
			maxX: worldPoint.x + 0.5,
			maxY: worldPoint.y + 0.5,
			width: 1,
			height: 1,
		};
		const viewportAtRotation0: Viewport = { ...viewport, rotation: 0 };
		const viewportAtRotation37: Viewport = {
			...viewport,
			rotation: degToRad(37),
		};
		const prebufAtRotation0 = calculateBackdropCaptureRegion(
			captureBounds,
			viewportAtRotation0,
			canvasWidth,
			canvasHeight,
		);
		const prebufAtRotation37 = calculateBackdropCaptureRegion(
			captureBounds,
			viewportAtRotation37,
			canvasWidth,
			canvasHeight,
		);

		expect(prebufAtRotation37.sourceUV).toEqual(prebufAtRotation0.sourceUV);
		expect(prebufAtRotation37.actualBounds).toEqual(
			prebufAtRotation0.actualBounds,
		);
	});

	it("should copy only a dirty intersection into an existing capture", () => {
		const copyTextureToTexture = vi.fn();
		const manager = Object.create(
			BackdropCaptureManager.prototype,
		) as BackdropCaptureManager;
		Object.assign(manager, {
			device: { limits: { maxTextureDimension2D: 8192 } },
		});
		const dirtyBounds: BoundingBox = {
			minX: -10,
			minY: -10,
			maxX: 10,
			maxY: 10,
			width: 20,
			height: 20,
		};

		const localRect = manager.patchCapturedRegion(
			{ copyTextureToTexture } as unknown as GPUCommandEncoder,
			{} as GPUTexture,
			{} as GPUTexture,
			{ x: 350, y: 250, width: 100, height: 100 },
			dirtyBounds,
			{ x: 0, y: 0, zoom: 1 },
			800,
			600,
		);

		expect(localRect).toEqual({ x: 40, y: 40, width: 20, height: 20 });
		expect(copyTextureToTexture).toHaveBeenCalledWith(
			{ texture: expect.anything(), origin: { x: 390, y: 290 } },
			{ texture: expect.anything(), origin: { x: 40, y: 40 } },
			{ width: 20, height: 20 },
		);
	});

	it("should copy a display capture into the caller-owned content origin", () => {
		const copyTextureToTexture = vi.fn();
		const manager = Object.create(
			BackdropCaptureManager.prototype,
		) as BackdropCaptureManager;
		Object.assign(manager, {
			device: { limits: { maxTextureDimension2D: 8192 } },
		});

		const result = manager.captureInto(
			{ copyTextureToTexture } as unknown as GPUCommandEncoder,
			{
				sourceTexture: {} as GPUTexture,
				sourceWorldBounds: {
					minX: -10,
					minY: -10,
					maxX: 10,
					maxY: 10,
					width: 20,
					height: 20,
				},
				viewport: { x: 0, y: 0, zoom: 1 },
				canvasWidth,
				canvasHeight,
				destination: {
					texture: { width: 2048, height: 2048 } as GPUTexture,
					origin: { x: 256, y: 512 },
					contentRect: { x: 8, y: 8, width: 20, height: 20 },
				},
				domain: { kind: "display-density" },
			},
		);

		expect(result?.writtenRect).toEqual({
			x: 264,
			y: 520,
			width: 20,
			height: 20,
		});
		expect(copyTextureToTexture).toHaveBeenCalledWith(
			{ texture: expect.anything(), origin: { x: 390, y: 290 } },
			{
				texture: expect.anything(),
				origin: { x: 264, y: 520 },
			},
			{ width: 20, height: 20 },
		);
	});

	it("should snap resampled caller-owned captures to the world density grid", () => {
		const manager = Object.create(
			BackdropCaptureManager.prototype,
		) as BackdropCaptureManager;
		const resampleToTarget = vi.fn();
		Object.assign(manager, {
			device: { limits: { maxTextureDimension2D: 8192 } },
			resampleToTarget,
		});
		const profiler = {} as GPUTimingProfiler;

		const result = manager.captureInto({} as GPUCommandEncoder, {
			sourceTexture: {} as GPUTexture,
			sourceWorldBounds: {
				minX: 0.1,
				minY: 0.1,
				maxX: 1.1,
				maxY: 1.1,
				width: 1,
				height: 1,
			},
			viewport: { x: 0, y: 0, zoom: 10 },
			canvasWidth,
			canvasHeight,
			destination: {
				texture: { width: 2048, height: 2048 } as GPUTexture,
				origin: { x: 32, y: 64 },
				contentRect: { x: 0, y: 0, width: 4, height: 4 },
			},
			domain: { kind: "fixed-r", rasterScale: 2 },
			profiler,
		});

		expect(result?.actualBounds).toEqual({
			minX: 0,
			minY: 0,
			maxX: 1.5,
			maxY: 1.5,
			width: 1.5,
			height: 1.5,
		});
		expect(resampleToTarget).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			{ x: 32, y: 64, width: 4, height: 4 },
			profiler,
		);
	});

	it("should implement captureRegion through caller-owned captureInto", () => {
		const regionTexture = {
			width: 20,
			height: 20,
			format: "rgba8unorm",
			destroy: vi.fn(),
		} as unknown as GPUTexture;
		const manager = new BackdropCaptureManager(
			{
				limits: { maxTextureDimension2D: 8192 },
				createTexture: vi.fn(() => regionTexture),
			} as unknown as GPUDevice,
			{} as never,
		);
		const captureInto = vi.spyOn(manager, "captureInto").mockReturnValue({
			actualBounds: bounds(-10, -10, 10, 10),
			sourceUV: { minU: 0.4, minV: 0.4, maxU: 0.6, maxV: 0.6 },
			writtenRect: { x: 0, y: 0, width: 20, height: 20 },
		});

		const result = manager.captureRegion(
			{} as GPUCommandEncoder,
			{ format: "rgba8unorm" } as GPUTexture,
			bounds(-10, -10, 10, 10),
			{ x: 0, y: 0, zoom: 1 },
			canvasWidth,
			canvasHeight,
		);

		expect(result.texture).toBe(regionTexture);
		expect(captureInto).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				destination: expect.objectContaining({ texture: regionTexture }),
				domain: { kind: "display-density" },
			}),
		);
	});
});

function bounds(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): BoundingBox {
	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	};
}
