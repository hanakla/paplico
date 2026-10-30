import { describe, expect, it } from "vitest";
import { subtractBackdrop } from "./rasterChunk";

describe("subtractBackdrop", () => {
	it("should make pixels the run left untouched transparent", () => {
		const layer = pixels([40, 120, 200, 255]);
		subtractBackdrop(layer, pixels([40, 120, 200, 255]));
		expect([...layer.data]).toEqual([0, 0, 0, 0]);
	});

	it("should give back the composite when drawn over an opaque backdrop", () => {
		const backdrop = [200, 60, 30, 255];
		const composite = [230, 140, 90, 255];
		const layer = pixels(composite);
		subtractBackdrop(layer, pixels(backdrop));

		expect(layer.data[3]).toBeLessThan(255);
		sourceOver([...layer.data], backdrop).forEach((value, i) => {
			expect(value).toBeCloseTo(composite[i], -0.5);
		});
	});

	it("should give back a darker composite over an opaque backdrop", () => {
		const backdrop = [200, 160, 120, 255];
		const composite = [100, 80, 120, 255];
		const layer = pixels(composite);
		subtractBackdrop(layer, pixels(backdrop));

		sourceOver([...layer.data], backdrop).forEach((value, i) => {
			expect(value).toBeCloseTo(composite[i], -0.5);
		});
	});

	it("should keep the composite as it is over a transparent backdrop", () => {
		const layer = pixels([10, 20, 30, 128]);
		subtractBackdrop(layer, pixels([0, 0, 0, 0]));
		expect([...layer.data]).toEqual([10, 20, 30, 128]);
	});
});

function pixels(rgba: number[]) {
	return { data: new Uint8ClampedArray(rgba) };
}

/** Straight-alpha source-over of one pixel, returned as straight RGBA. */
function sourceOver(top: number[], bottom: number[]): number[] {
	const alphaT = top[3] / 255;
	const alphaB = bottom[3] / 255;
	const alpha = alphaT + alphaB * (1 - alphaT);
	const rgb = [0, 1, 2].map(
		(c) =>
			((top[c] / 255) * alphaT + (bottom[c] / 255) * alphaB * (1 - alphaT)) /
			alpha,
	);
	return [...rgb.map((v) => v * 255), alpha * 255];
}
