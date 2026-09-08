import { describe, expect, it } from "vitest";
import type { Viewport } from "../../../schema";
import {
	type GPUElementTransform,
	IDENTITY_GPU_TRANSFORM,
	worldToScreen,
} from "../../../utils/geometry/geometry";
import {
	composeDeviceTransform,
	deviceScaleBucket,
	localCurveTolerance,
} from "./deviceGeometry";
import type { DeviceTransform, RasterFrame } from "./stripTypes";

describe("composeDeviceTransform", () => {
	it("should map world points like worldToScreen for an identity element", () => {
		const viewport: Viewport = { x: 120, y: -40, zoom: 2.5, rotation: 0.4 };
		const frame: RasterFrame = { viewport, width: 800, height: 600 };
		const t = composeDeviceTransform(IDENTITY_GPU_TRANSFORM, frame);
		for (const [wx, wy] of [
			[0, 0],
			[130, -20],
			[-300, 200],
		]) {
			const expected = worldToScreen(wx, wy, viewport, 800, 600);
			const p = apply(t, wx, wy);
			expect(p.x).toBeCloseTo(expected.x, 6);
			expect(p.y).toBeCloseTo(expected.y, 6);
		}
	});

	it("should apply the element transform around its origin before the viewport", () => {
		const gt: GPUElementTransform = {
			...IDENTITY_GPU_TRANSFORM,
			tx: 10,
			ty: 5,
			originX: 50,
			originY: 50,
			m00: 0,
			m01: -2,
			m10: 2,
			m11: 0,
		};
		const viewport: Viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
		const t = composeDeviceTransform(gt, {
			viewport,
			width: 200,
			height: 200,
		});
		// local (60, 50) → relative (10, 0) → mapped (0, 20) → world (60, 75)
		const expected = worldToScreen(60, 75, viewport, 200, 200);
		const p = apply(t, 60, 50);
		expect(p.x).toBeCloseTo(expected.x, 6);
		expect(p.y).toBeCloseTo(expected.y, 6);
	});
});

describe("deviceScaleBucket", () => {
	it("should bound the local tolerance so the device error stays within budget", () => {
		for (const zoom of [0.3, 1, 1.5, 4, 640]) {
			const t = composeDeviceTransform(IDENTITY_GPU_TRANSFORM, {
				viewport: { x: 0, y: 0, zoom, rotation: 0.2 },
				width: 100,
				height: 100,
			});
			const bucket = deviceScaleBucket(t);
			expect(2 ** bucket).toBeGreaterThanOrEqual(zoom - 1e-9);
			expect(2 ** bucket).toBeLessThan(zoom * 2);
			expect(localCurveTolerance(bucket) * zoom).toBeLessThanOrEqual(
				0.25 + 1e-9,
			);
		}
	});
});

function apply(t: DeviceTransform, x: number, y: number) {
	return { x: t.a * x + t.c * y + t.e, y: t.b * x + t.d * y + t.f };
}
