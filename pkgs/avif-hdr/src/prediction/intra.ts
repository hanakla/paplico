import type { BitDepth } from "../types";

export function dcPredict(
	pixels: Int32Array,
	stride: number,
	y0: number,
	x0: number,
	h: number,
	w: number,
	bitDepth: BitDepth,
	tileX0 = 0,
	tileY0 = 0,
): void {
	const haveLeft = x0 > tileX0;
	const haveAbove = y0 > tileY0;
	const maxVal = (1 << bitDepth) - 1;

	let sum = 0;
	if (haveAbove) {
		for (let j = 0; j < w; j++) {
			sum += pixels[(y0 - 1) * stride + x0 + j];
		}
	}
	if (haveLeft) {
		for (let i = 0; i < h; i++) {
			sum += pixels[(y0 + i) * stride + x0 - 1];
		}
	}

	let avg: number;
	if (haveAbove && haveLeft) {
		avg = Math.floor((sum + (w + h) / 2) / (w + h));
	} else if (haveAbove) {
		avg = Math.floor((sum + w / 2) / w);
	} else if (haveLeft) {
		avg = Math.floor((sum + h / 2) / h);
	} else {
		avg = 1 << (bitDepth - 1);
	}

	avg = Math.max(0, Math.min(maxVal, avg));

	for (let i = 0; i < h; i++) {
		for (let j = 0; j < w; j++) {
			pixels[(y0 + i) * stride + x0 + j] = avg;
		}
	}
}
