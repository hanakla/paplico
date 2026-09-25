import { describe, expect, it } from "vitest";
import { generatePaperGrainPixels } from "./presets";

/**
 * The grain shader samples paper at a canvas-fixed UV through a repeating
 * sampler, so a texture that does not wrap would draw a seam grid across
 * every stroke.
 */
describe("generatePaperGrainPixels", () => {
	const SIZE = 64;

	it("should wrap across the edges as smoothly as it varies inside", () => {
		const pixels = generatePaperGrainPixels(SIZE, 8, 3);
		const at = (x: number, y: number) => pixels[(y * SIZE + x) * 4];

		let seamStep = 0;
		let interiorStep = 0;
		for (let y = 0; y < SIZE; y++) {
			seamStep = Math.max(seamStep, Math.abs(at(0, y) - at(SIZE - 1, y)));
			interiorStep = Math.max(interiorStep, Math.abs(at(1, y) - at(0, y)));
		}

		// A non-wrapping lattice makes the seam a discontinuity far larger
		// than any step inside the texture.
		expect(seamStep).toBeLessThanOrEqual(interiorStep * 2 + 2);
	});

	it("should stay inside the gentle range both grain modes assume", () => {
		const pixels = generatePaperGrainPixels(SIZE, 8, 3);
		const levels = [...Array(SIZE * SIZE).keys()].map((i) => pixels[i * 4]);

		expect(Math.min(...levels)).toBeGreaterThanOrEqual(0.35 * 255 - 1);
		expect(Math.max(...levels)).toBeLessThanOrEqual(255);
		// Opaque, and grey so the .r the shader reads matches the look.
		expect(pixels[3]).toBe(255);
		expect(pixels[1]).toBe(pixels[0]);
	});

	it("should make the coarse paper vary more slowly than the fine one", () => {
		const meanStep = (cells: number, octaves: number): number => {
			const pixels = generatePaperGrainPixels(SIZE, cells, octaves);
			let sum = 0;
			for (let y = 0; y < SIZE; y++) {
				for (let x = 1; x < SIZE; x++) {
					sum += Math.abs(
						pixels[(y * SIZE + x) * 4] - pixels[(y * SIZE + x - 1) * 4],
					);
				}
			}
			return sum / (SIZE * (SIZE - 1));
		};

		expect(meanStep(8, 4)).toBeLessThan(meanStep(24, 3));
	});
});
