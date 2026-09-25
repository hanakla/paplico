import { describe, expect, it } from "vitest";
import { buildGapDistanceMap, GAP_NONE, gapClosingFloodFill } from "./fill";

// Alpha map helpers: 1 = fillable, 0 = barrier.

function makeAlphaMap(width: number, height: number): Uint8Array {
	return new Uint8Array(width * height).fill(1);
}

function drawVerticalBarrier(
	map: Uint8Array,
	width: number,
	x: number,
	y0: number,
	y1: number,
): void {
	for (let y = y0; y < y1; y++) {
		map[y * width + x] = 0;
	}
}

function anyFilledRightOf(
	mask: Uint8Array,
	width: number,
	height: number,
	x: number,
): boolean {
	for (let y = 0; y < height; y++) {
		for (let px = x + 1; px < width; px++) {
			if (mask[y * width + px] === 1) return true;
		}
	}
	return false;
}

describe("buildGapDistanceMap", () => {
	it("should mark non-gap pixels with the GAP_NONE sentinel on large rasters", () => {
		// 256×256 is the regression size: the former `2 * width * height`
		// sentinel wrapped to exactly 0 in the Uint16Array here, which made
		// drawGapLine unable to record any gap (0 is already the minimum).
		const W = 256;
		const H = 256;
		const alpha = makeAlphaMap(W, H);
		drawVerticalBarrier(alpha, W, 128, 0, 126);
		drawVerticalBarrier(alpha, W, 128, 130, H);

		const distMap = buildGapDistanceMap(alpha, W, H, 6);

		// A far-away free pixel carries the sentinel
		expect(distMap[10 * W + 10]).toBe(GAP_NONE);
		// The 4px gap at (128, 126..129) is recorded with a real distance
		expect(distMap[127 * W + 128]).toBeLessThan(GAP_NONE);
	});
});

describe("gapClosingFloodFill", () => {
	const W = 256;
	const H = 256;

	it("should not leak through a gap smaller than the closing radius", () => {
		const alpha = makeAlphaMap(W, H);
		drawVerticalBarrier(alpha, W, 128, 0, 126);
		drawVerticalBarrier(alpha, W, 128, 130, H);

		const distMap = buildGapDistanceMap(alpha, W, H, 6);
		const mask = gapClosingFloodFill(alpha, distMap, W, H, 10, 128, null);

		expect(mask[128 * W + 10]).toBe(1);
		// The gap-line raster is double-width, so up to 1px may bleed just past
		// the barrier; the fill must not spread into the open right region.
		expect(anyFilledRightOf(mask, W, H, 130)).toBe(false);
	});

	it("should flow through a gap wider than the closing radius", () => {
		const alpha = makeAlphaMap(W, H);
		drawVerticalBarrier(alpha, W, 128, 0, 100);
		drawVerticalBarrier(alpha, W, 128, 140, H);

		const distMap = buildGapDistanceMap(alpha, W, H, 3);
		const mask = gapClosingFloodFill(alpha, distMap, W, H, 10, 128, null);

		expect(anyFilledRightOf(mask, W, H, 128)).toBe(true);
	});

	it("should fill the whole region when there is no barrier", () => {
		const alpha = makeAlphaMap(W, H);
		const distMap = buildGapDistanceMap(alpha, W, H, 6);
		const mask = gapClosingFloodFill(alpha, distMap, W, H, 10, 128, null);

		expect(mask[0]).toBe(1);
		expect(mask[W * H - 1]).toBe(1);
	});
});
