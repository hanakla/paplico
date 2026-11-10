import {
	CMYK_PRESS_GRID_POINTS,
	CMYK_PRESS_TABLE_BASE64,
} from "./cmykPressTable.generated";

const POINTS = CMYK_PRESS_GRID_POINTS;
const LAST_POINT = POINTS - 1;
const STRIDE_K = 3;
const STRIDE_Y = STRIDE_K * POINTS;
const STRIDE_M = STRIDE_Y * POINTS;
const STRIDE_C = STRIDE_M * POINTS;

/** Which grid cell each 8-bit ink falls in. */
const GRID_CELL = Uint8Array.from(Array(256).keys(), (ink) =>
	Math.min(Math.floor((ink / 255) * LAST_POINT), LAST_POINT - 1),
);

/** How far into its grid cell each 8-bit ink is, from 0 to 1. */
const CELL_WEIGHT = Float64Array.from(
	Array(256).keys(),
	(ink) => (ink / 255) * LAST_POINT - GRID_CELL[ink],
);

/**
 * Converts interleaved 8-bit CMYK to interleaved 8-bit RGB the way a coated
 * offset press prints the inks, for colors that come without a profile.
 *
 * It interpolates a grid of colors sampled from the FOGRA39L coated profile;
 * cmykPressTable.generated.ts names the source and carries its license.
 */
export function approximateCmykToRgb(
	cmyk: Uint8Array,
): Uint8ClampedArray<ArrayBuffer> {
	const table = pressTable();
	const pixelCount = Math.trunc(cmyk.length / 4);
	const rgb = new Uint8ClampedArray(pixelCount * 3);
	let previous = -1;

	for (let pixel = 0, at = 0, out = 0; pixel < pixelCount; pixel++) {
		const c = cmyk[at++];
		const m = cmyk[at++];
		const y = cmyk[at++];
		const k = cmyk[at++];
		// Artwork repeats a color over long runs of pixels.
		const key = ((c << 24) | (m << 16) | (y << 8) | k) >>> 0;
		if (key === previous) {
			rgb[out] = rgb[out - 3];
			rgb[out + 1] = rgb[out - 2];
			rgb[out + 2] = rgb[out - 1];
			out += 3;
			continue;
		}
		previous = key;

		const cw = CELL_WEIGHT[c];
		const mw = CELL_WEIGHT[m];
		const yw = CELL_WEIGHT[y];
		const kw = CELL_WEIGHT[k];
		const base =
			((GRID_CELL[c] * POINTS + GRID_CELL[m]) * POINTS + GRID_CELL[y]) *
				POINTS +
			GRID_CELL[k];

		// Blend the 16 grid colors around the inks: along black, then yellow,
		// magenta and cyan, each by how far the inks are into the cell.
		for (let channel = 0; channel < 3; channel++) {
			const at0 = base * 3 + channel;
			const lerpK = (at: number) =>
				table[at] + (table[at + STRIDE_K] - table[at]) * kw;
			const y00 = lerpK(at0);
			const y01 = lerpK(at0 + STRIDE_Y);
			const y10 = lerpK(at0 + STRIDE_M);
			const y11 = lerpK(at0 + STRIDE_M + STRIDE_Y);
			const y20 = lerpK(at0 + STRIDE_C);
			const y21 = lerpK(at0 + STRIDE_C + STRIDE_Y);
			const y30 = lerpK(at0 + STRIDE_C + STRIDE_M);
			const y31 = lerpK(at0 + STRIDE_C + STRIDE_M + STRIDE_Y);
			const m0 = y00 + (y01 - y00) * yw;
			const m1 = y10 + (y11 - y10) * yw;
			const m2 = y20 + (y21 - y20) * yw;
			const m3 = y30 + (y31 - y30) * yw;
			const c0Value = m0 + (m1 - m0) * mw;
			const c1Value = m2 + (m3 - m2) * mw;
			rgb[out++] = c0Value + (c1Value - c0Value) * cw;
		}
	}
	return rgb;
}

let decodedTable: Uint8Array | undefined;

function pressTable(): Uint8Array {
	decodedTable ??= Uint8Array.from(atob(CMYK_PRESS_TABLE_BASE64), (char) =>
		char.charCodeAt(0),
	);
	return decodedTable;
}
