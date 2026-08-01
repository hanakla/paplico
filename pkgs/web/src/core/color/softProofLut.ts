/**
 * Pure helpers for baking size^3 3D LUTs used by GPU soft proofing.
 *
 * Grid layout matches a WebGPU `texture_3d` upload where the sampling
 * coordinate is (r, g, b): red varies fastest (x axis), then green (y rows),
 * then blue (z slices) — entry index = (b * size + g) * size + r.
 */

/**
 * Generates the RGB sample grid for a size^3 LUT as flat RGB triplets.
 * Channel values are evenly spaced over 0-255 inclusive.
 */
export function buildLutGridRgb(size: number): Uint8ClampedArray {
	assertGridSize(size);
	const grid = new Uint8ClampedArray(size ** 3 * 3);
	const step = 255 / (size - 1);
	let pos = 0;
	for (let b = 0; b < size; b++) {
		const blue = Math.round(b * step);
		for (let g = 0; g < size; g++) {
			const green = Math.round(g * step);
			for (let r = 0; r < size; r++) {
				grid[pos++] = Math.round(r * step);
				grid[pos++] = green;
				grid[pos++] = blue;
			}
		}
	}
	return grid;
}

/** Packs flat RGB triplets into RGBA bytes with alpha fixed to 255. */
export function packRgbToRgba(rgb: Uint8ClampedArray | Uint8Array): Uint8Array {
	const pixelCount = rgb.length / 3;
	if (!Number.isInteger(pixelCount)) {
		throw new Error(
			`RGB data length must be a multiple of 3, got ${rgb.length}`,
		);
	}
	const rgba = new Uint8Array(pixelCount * 4);
	for (let i = 0; i < pixelCount; i++) {
		rgba[i * 4] = rgb[i * 3];
		rgba[i * 4 + 1] = rgb[i * 3 + 1];
		rgba[i * 4 + 2] = rgb[i * 3 + 2];
		rgba[i * 4 + 3] = 255;
	}
	return rgba;
}

function assertGridSize(size: number): void {
	if (!Number.isInteger(size) || size < 2) {
		throw new Error(`LUT grid size must be an integer >= 2, got ${size}`);
	}
}
