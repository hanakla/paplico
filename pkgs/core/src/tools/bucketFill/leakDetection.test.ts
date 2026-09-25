import { describe, expect, it } from "vitest";
import { findLeaks, findSpillLeaks } from "./leakDetection";
import { createRasterSpace } from "./rasterSpace";

// fillable: 1 = free space, 0 = barrier.

const W = 200;
const H = 200;
// World origin at raster center, scale 1 → world == raster - 100 (Y flipped)
const space = createRasterSpace(
	{ centerX: 0, centerY: 0, worldWidth: W, worldHeight: H },
	1,
);

function makeFillable(): Uint8Array {
	return new Uint8Array(W * H).fill(1);
}

/** Draw a rectangle outline barrier with optional gaps (list of [x, y0, y1] on
 * the right edge column). */
function drawBoxOutline(
	fillable: Uint8Array,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	gaps: Array<{ edgeX: number; gapY0: number; gapY1: number }> = [],
): void {
	const isGap = (x: number, y: number) =>
		gaps.some((g) => x === g.edgeX && y >= g.gapY0 && y < g.gapY1);
	for (let x = x0; x <= x1; x++) {
		for (const y of [y0, y1]) {
			if (!isGap(x, y)) fillable[y * W + x] = 0;
		}
	}
	for (let y = y0; y <= y1; y++) {
		for (const x of [x0, x1]) {
			if (!isGap(x, y)) fillable[y * W + x] = 0;
		}
	}
}

describe("findLeaks", () => {
	it("should locate a single small gap with its position and width", () => {
		const fillable = makeFillable();
		// Box 60..140 with a 4px gap on the right edge (x=140, y=98..102)
		drawBoxOutline(fillable, 60, 60, 140, 140, [
			{ edgeX: 140, gapY0: 98, gapY1: 102 },
		]);

		const result = findLeaks({
			fillable,
			width: W,
			height: H,
			seedX: 100,
			seedY: 100,
			space,
		});

		expect(result.noBarriers).toBe(false);
		expect(result.leaks.length).toBe(1);
		const leak = result.leaks[0];
		// Gap center: raster (140, 100) → world (40, 0)
		expect(Math.abs(leak.x - 40)).toBeLessThanOrEqual(4);
		expect(Math.abs(leak.y - 0)).toBeLessThanOrEqual(4);
		expect(leak.gapWidthWorld).toBeGreaterThanOrEqual(1);
		expect(leak.gapWidthWorld).toBeLessThanOrEqual(8);
	});

	it("should enumerate two gaps and yield a sealed fill mask", () => {
		const fillable = makeFillable();
		drawBoxOutline(fillable, 60, 60, 140, 140, [
			{ edgeX: 140, gapY0: 98, gapY1: 102 },
			{ edgeX: 60, gapY0: 78, gapY1: 82 },
		]);

		const result = findLeaks({
			fillable,
			width: W,
			height: H,
			seedX: 100,
			seedY: 100,
			space,
		});

		expect(result.leaks.length).toBe(2);
		expect(result.sealedMask).not.toBeNull();
		// The sealed fill stays inside the box (no border contact)
		const mask = result.sealedMask;
		expect(mask).not.toBeNull();
		expect(mask![100 * W + 100]).toBe(1);
		for (let x = 0; x < W; x++) {
			expect(mask![x]).toBe(0);
			expect(mask![(H - 1) * W + x]).toBe(0);
		}
		// Seals are straight chords along the wall line, not discs: the cell
		// just inside the gap (which a disc seal would swallow) stays filled
		expect(mask![100 * W + 137]).toBe(1);
	});

	it("should report noBarriers when nothing encloses the seed", () => {
		const fillable = makeFillable();

		const result = findLeaks({
			fillable,
			width: W,
			height: H,
			seedX: 100,
			seedY: 100,
			space,
		});

		expect(result.noBarriers).toBe(true);
		expect(result.leaks.length).toBe(0);
		expect(result.sealedMask).toBeNull();
	});

	it("should return no leaks for a fully closed region", () => {
		const fillable = makeFillable();
		drawBoxOutline(fillable, 60, 60, 140, 140);

		const result = findLeaks({
			fillable,
			width: W,
			height: H,
			seedX: 100,
			seedY: 100,
			space,
		});

		expect(result.leaks.length).toBe(0);
		expect(result.noBarriers).toBe(false);
		expect(result.sealedMask).toBeNull();
	});
});

describe("findSpillLeaks", () => {
	// A bounded scene: outer frame (artboard edge stand-in) at 5..195 with a
	// small leaky box at 85..115 — the surrounding area is decisively wider
	// than the box interior, as an artboard background is around a shape.
	// fillMask = everything the fill covered.
	function makeSpillScene(gaps: Parameters<typeof drawBoxOutline>[5]) {
		const fillable = makeFillable();
		drawBoxOutline(fillable, 5, 5, 195, 195);
		drawBoxOutline(fillable, 85, 85, 115, 115, gaps);
		// The fill covered the frame interior except the inner box walls
		const fillMask = new Uint8Array(W * H);
		for (let y = 6; y < 195; y++) {
			for (let x = 6; x < 195; x++) {
				const i = y * W + x;
				if (fillable[i] === 1) fillMask[i] = 1;
			}
		}
		return { fillable, fillMask };
	}

	it("should locate the gap when the fill escaped a shape into the wide area", () => {
		const { fillable, fillMask } = makeSpillScene([
			{ edgeX: 115, gapY0: 98, gapY1: 102 },
		]);

		const result = findSpillLeaks({
			fillable,
			width: W,
			height: H,
			seedX: 100,
			seedY: 100,
			space,
			fillMask,
		});

		expect(result).not.toBeNull();
		expect(result?.leaks.length).toBe(1);
		const leak = result?.leaks[0];
		// Gap center: raster (115, 100) → world (15, 0)
		expect(Math.abs((leak?.x ?? 0) - 15)).toBeLessThanOrEqual(4);
		expect(Math.abs(leak?.y ?? 0)).toBeLessThanOrEqual(4);
		// Sealing the gap closes the shape again
		const mask = result?.sealedMask;
		expect(mask).not.toBeNull();
		expect(mask?.[100 * W + 100]).toBe(1);
		expect(mask?.[100 * W + 170]).toBe(0);
		// The seal is a straight chord along the wall line, not a disc: the
		// cell just inside the gap (which a disc would swallow) stays filled
		expect(mask?.[100 * W + 112]).toBe(1);
	});

	it("should return null when the seed sits in the wide area itself", () => {
		const { fillable, fillMask } = makeSpillScene([
			{ edgeX: 115, gapY0: 98, gapY1: 102 },
		]);

		const result = findSpillLeaks({
			fillable,
			width: W,
			height: H,
			seedX: 170,
			seedY: 100,
			space,
			fillMask,
		});

		expect(result).toBeNull();
	});
});
