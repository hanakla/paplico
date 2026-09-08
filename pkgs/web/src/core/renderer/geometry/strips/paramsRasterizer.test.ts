import { describe, expect, it } from "vitest";
import { appendTriangleSoupLines } from "./deviceGeometry";
import { rasterizeStrokeParams } from "./paramsRasterizer";
import { StripRasterizer } from "./stripRenderer";
import type { ClipRect, DeviceTransform } from "./stripTypes";

const CLIP: ClipRect = { x0: 0, y0: 0, x1: 32, y1: 32 };
const IDENTITY: DeviceTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

describe("rasterizeStrokeParams", () => {
	it("should interpolate t along and u across a stroke quad", () => {
		// A horizontal stroke body from x=4 to x=28, y=8..16, as two triangles.
		const vertices = new Float32Array([
			4, 8, 28, 8, 4, 16, 28, 8, 28, 16, 4, 16,
		]);
		const params = new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);
		const rasterizer = new StripRasterizer();
		appendTriangleSoupLines(rasterizer.lines, vertices, IDENTITY, CLIP);
		const batch = rasterizer.rasterize(CLIP, { denseOnly: true });
		rasterizeStrokeParams(batch, vertices, params, IDENTITY, CLIP);

		const read = (px: number, py: number) => {
			const band = Math.floor(py / 4);
			const strip = findStrip(batch, band * 4, px);
			const slot = batch.slots[strip] + (px - batch.strips[strip * 4]);
			const at = slot * 8 + (py - band * 4) * 2;
			return { t: batch.params![at] / 255, u: batch.params![at + 1] / 255 };
		};

		const left = read(4, 8);
		expect(left.t).toBeCloseTo(0.5 / 24, 1);
		expect(left.u).toBeCloseTo(0.5 / 8, 1);
		const middle = read(16, 12);
		expect(middle.t).toBeCloseTo(12.5 / 24, 1);
		expect(middle.u).toBeCloseTo(4.5 / 8, 1);
		const right = read(27, 15);
		expect(right.t).toBeCloseTo(23.5 / 24, 1);
		expect(right.u).toBeCloseTo(7.5 / 8, 1);
	});

	it("should give params to pixels a sub-pixel stroke covers without containing their centre", () => {
		// A 0.3px tall line from x=4 to x=28 at y=8.1..8.4: every covered pixel
		// centre (y=8.5) lies outside both triangles.
		const vertices = new Float32Array([
			4, 8.1, 28, 8.1, 4, 8.4, 28, 8.1, 28, 8.4, 4, 8.4,
		]);
		const params = new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);
		const rasterizer = new StripRasterizer();
		appendTriangleSoupLines(rasterizer.lines, vertices, IDENTITY, CLIP);
		const batch = rasterizer.rasterize(CLIP, { denseOnly: true });
		rasterizeStrokeParams(batch, vertices, params, IDENTITY, CLIP);

		const strip = findStrip(batch, 8, 16);
		const slot = batch.slots[strip] + (16 - batch.strips[strip * 4]);
		expect(batch.params![slot * 8] / 255).toBeCloseTo(12.5 / 24, 1);
		const last = batch.slots[strip] + (27 - batch.strips[strip * 4]);
		expect(batch.params![last * 8] / 255).toBeCloseTo(23.5 / 24, 1);
	});
});

function findStrip(
	batch: ReturnType<StripRasterizer["rasterize"]>,
	y: number,
	px: number,
): number {
	for (let s = 0; s < batch.stripCount; s++) {
		const sx = batch.strips[s * 4];
		if (batch.strips[s * 4 + 1] !== y) continue;
		if (px >= sx && px < sx + batch.strips[s * 4 + 3]) return s;
	}
	throw new Error(`no strip at (${px}, ${y})`);
}
