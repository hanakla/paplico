/**
 * Flood-fill primitives for the bucket fill tool. All functions operate on a
 * raster described by a {@link FillRasterSpace}; nothing here touches the DOM
 * or the renderer.
 */

import { type FillRasterSpace, worldToRaster } from "./rasterSpace";

// --- Types ---

export interface SeedColor {
	r: number;
	g: number;
	b: number;
	a: number;
}

/**
 * Sentinel for "no gap detected at this pixel" in the gap distance map.
 * Must fit in Uint16 — the previous `2 * width * height` sentinel wrapped
 * on rasters of 181×181 and larger, silently corrupting gap detection
 * (at 256×256 it wrapped to exactly 0, disabling gap closing entirely).
 * Real gap values are squared distances ≤ 401 (radius 20), far below this.
 */
export const GAP_NONE = 0xffff;

// --- Functions ---

/** Sample the RGBA seed color at a raster pixel. */
export function sampleSeedColor(
	imageData: ImageData,
	x: number,
	y: number,
): SeedColor {
	const i = (y * imageData.width + x) * 4;
	return {
		r: imageData.data[i],
		g: imageData.data[i + 1],
		b: imageData.data[i + 2],
		a: imageData.data[i + 3],
	};
}

/**
 * Queue-based flood fill. Returns a Uint8Array mask (1 = filled, 0 = not).
 * The seed color is passed explicitly so that re-fills on a re-rendered
 * raster (where anti-aliasing may shift the seed pixel slightly) stay
 * consistent with the first sample.
 */
export function floodFill(
	imageData: ImageData,
	startX: number,
	startY: number,
	seedColor: SeedColor,
	tolerance: number,
	cutMask: Uint8Array | null,
): Uint8Array {
	const { width, height, data } = imageData;
	const size = width * height;
	const mask = new Uint8Array(size);
	const visited = new Uint8Array(size);

	const { r: sr, g: sg, b: sb, a: sa } = seedColor;
	// Compare squared distances; sqrt-per-pixel is measurable on
	// document-sized rasters and the comparison is equivalent.
	const toleranceSq = tolerance * tolerance;

	// LIFO stack of flat indices. `visited` admits each pixel at most once,
	// so `size` slots suffice and the loop allocates nothing per pixel
	// (per-pixel arrays would dominate GC time).
	const stack = new Int32Array(size);
	let top = 0;
	const startPos = startY * width + startX;
	stack[top++] = startPos;
	visited[startPos] = 1;

	const push = (n: number): void => {
		if (!visited[n]) {
			visited[n] = 1;
			stack[top++] = n;
		}
	};

	while (top > 0) {
		const pos = stack[--top];
		const x = pos % width;
		const y = (pos - x) / width;

		if (cutMask && cutMask[pos] === 1) continue;

		const pi = pos * 4;
		const dr = data[pi] - sr;
		const dg = data[pi + 1] - sg;
		const db = data[pi + 2] - sb;
		const da = data[pi + 3] - sa;
		if (dr * dr + dg * dg + db * db + da * da > toleranceSq) continue;

		mask[pos] = 1;

		if (x > 0) push(pos - 1);
		if (x < width - 1) push(pos + 1);
		if (y > 0) push(pos - width);
		if (y < height - 1) push(pos + width);
	}

	return mask;
}

// --- Gap Distance Map (Krita/MyPaint approach) ---

/**
 * Build a binary alpha map from image data: 1 = fillable (seed-like color),
 * 0 = barrier (different color / line art). Uses the same colour-distance
 * metric as {@link floodFill}.
 */
export function buildAlphaMap(
	imageData: ImageData,
	seedColor: SeedColor,
	tolerance: number,
): Uint8Array {
	const { width, height, data } = imageData;
	const size = width * height;
	const map = new Uint8Array(size);

	const { r: sr, g: sg, b: sb, a: sa } = seedColor;
	const toleranceSq = tolerance * tolerance;

	for (let i = 0; i < size; i++) {
		const pi = i * 4;
		const dr = data[pi] - sr;
		const dg = data[pi + 1] - sg;
		const db = data[pi + 2] - sb;
		const da = data[pi + 3] - sa;
		map[i] = dr * dr + dg * dg + db * db + da * da <= toleranceSq ? 1 : 0;
	}

	return map;
}

/**
 * Octant rotation coefficients for the gap search. Each row (a, b, c, d)
 * maps an octant offset (xo, yo) to raster deltas: tx = x + a*xo + b*yo,
 * ty = y + c*xo + d*yo. Plain integer math instead of tuple-returning
 * closures keeps the per-barrier-pixel scan allocation-free.
 */
const OCTANT_COEFFS = new Int8Array([
	1, 0, 0, 1, 0, -1, -1, 0, 0, -1, 1, 0, 1, 0, 0, -1,
]);

/**
 * Draw a double-width Bresenham-style line on the gap distance map between two
 * barrier pixels, writing `sqDist` at every pixel along the line. Only writes
 * if the new value is smaller (minimum wins).
 */
function drawGapLine(
	distMap: Uint16Array,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	sqDist: number,
	width: number,
	height: number,
): void {
	const dx = x1 - x0;
	const dy = y1 - y0;
	const steps = Math.max(Math.abs(dx), Math.abs(dy));
	if (steps === 0) return;

	const sx = dx / steps;
	const sy = dy / steps;

	// Perpendicular direction for double-width
	const len = Math.sqrt(dx * dx + dy * dy);
	const px = len > 0 ? -dy / len : 0;
	const py = len > 0 ? dx / len : 0;

	for (let i = 1; i < steps; i++) {
		const cx = Math.round(x0 + sx * i);
		const cy = Math.round(y0 + sy * i);

		// Main pixel
		if (cx >= 0 && cx < width && cy >= 0 && cy < height) {
			const idx = cy * width + cx;
			if (sqDist < distMap[idx]) distMap[idx] = sqDist;
		}

		// +1 width pixel (perpendicular offset)
		const cx2 = Math.round(x0 + sx * i + px);
		const cy2 = Math.round(y0 + sy * i + py);
		if (cx2 >= 0 && cx2 < width && cy2 >= 0 && cy2 < height) {
			const idx2 = cy2 * width + cx2;
			if (sqDist < distMap[idx2]) distMap[idx2] = sqDist;
		}
	}
}

/**
 * Build a gap distance map from the alpha map. For each barrier pixel, search
 * in 4 octant directions for a nearby barrier pixel across a fillable gap. When
 * found, draw the squared Euclidean distance along the gap line into the map.
 *
 * Based on MyPaint's `find_gaps()` / `dist_search()` algorithm.
 *
 * @returns Uint16Array where each pixel stores the squared distance of the
 *          smallest gap passing through it, or GAP_NONE if no gap was detected.
 */
export function buildGapDistanceMap(
	alphaMap: Uint8Array,
	width: number,
	height: number,
	gapRadius: number,
): Uint16Array {
	const size = width * height;
	const distMap = new Uint16Array(size).fill(GAP_NONE);
	const gapRadiusSq = 1 + gapRadius * gapRadius;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (alphaMap[y * width + x] !== 0) continue; // skip fillable pixels

			for (let o = 0; o < OCTANT_COEFFS.length; o += 4) {
				const a = OCTANT_COEFFS[o];
				const b = OCTANT_COEFFS[o + 1];
				const c = OCTANT_COEFFS[o + 2];
				const d = OCTANT_COEFFS[o + 3];

				// Octant neighbours: rotate(1, 0) → (x+a, y+c), rotate(0, 1) → (x+b, y+d)
				const nx1 = x + a;
				const ny1 = y + c;
				const nx2 = x + b;
				const ny2 = y + d;
				if (
					nx1 >= 0 &&
					nx1 < width &&
					ny1 >= 0 &&
					ny1 < height &&
					alphaMap[ny1 * width + nx1] === 0 &&
					nx2 >= 0 &&
					nx2 < width &&
					ny2 >= 0 &&
					ny2 < height &&
					alphaMap[ny2 * width + nx2] === 0
				) {
					continue;
				}

				for (let yoffs = 2; yoffs <= gapRadius + 1; yoffs++) {
					let broke = false;
					for (let xoffs = 0; xoffs <= yoffs; xoffs++) {
						const sqDist = (yoffs - 1) * (yoffs - 1) + xoffs * xoffs;
						if (sqDist >= gapRadiusSq) {
							broke = true;
							break;
						}

						const tx = x + a * xoffs + b * yoffs;
						const ty = y + c * xoffs + d * yoffs;
						if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;

						if (alphaMap[ty * width + tx] === 0) {
							drawGapLine(distMap, x, y, tx, ty, sqDist, width, height);
						}
					}
					if (broke) break;
				}
			}
		}
	}

	return distMap;
}

/** sqrt-distance jump threshold for gap-closing fill (from MyPaint). */
const GC_DIFF_LIMIT = 2.0;

/**
 * BFS flood fill that uses a gap distance map to block propagation through
 * gaps. Each queued pixel carries the minimum gap distance encountered along
 * its BFS path. Propagation stops when the distance jumps abruptly (indicating
 * the fill is trying to cross through a gap).
 *
 * Based on MyPaint's `GapClosingFiller::fill()`.
 */
export function gapClosingFloodFill(
	alphaMap: Uint8Array,
	gapDistMap: Uint16Array,
	width: number,
	height: number,
	startX: number,
	startY: number,
	cutMask: Uint8Array | null,
): Uint8Array {
	const size = width * height;
	const mask = new Uint8Array(size);
	const visited = new Uint8Array(size);

	// FIFO queue as two parallel typed arrays (flat index + propagated min
	// distance). `visited` admits each pixel at most once, so `size` slots
	// suffice; the previous per-pixel tuple arrays dominated GC time on
	// document-sized rasters.
	const queuePos = new Int32Array(size);
	const queueDist = new Uint16Array(size);
	let head = 0;
	let tail = 0;
	const startPos = startY * width + startX;
	queuePos[tail] = startPos;
	queueDist[tail++] = GAP_NONE;
	visited[startPos] = 1;

	while (head < tail) {
		const pos = queuePos[head];
		const prevDist = queueDist[head++];
		const x = pos % width;
		const y = (pos - x) / width;

		if (cutMask?.[pos] === 1) continue;
		if (alphaMap[pos] === 0) continue;

		const currDist = gapDistMap[pos];

		// Stop condition: distance jumps indicate crossing a gap
		if (prevDist < currDist) {
			if (currDist >= GAP_NONE) continue;
			if (Math.sqrt(currDist) - Math.sqrt(prevDist) > GC_DIFF_LIMIT) continue;
		}

		const propagateDist = Math.min(prevDist, currDist);
		mask[pos] = 1;

		if (x > 0 && !visited[pos - 1]) {
			visited[pos - 1] = 1;
			queuePos[tail] = pos - 1;
			queueDist[tail++] = propagateDist;
		}
		if (x < width - 1 && !visited[pos + 1]) {
			visited[pos + 1] = 1;
			queuePos[tail] = pos + 1;
			queueDist[tail++] = propagateDist;
		}
		if (y > 0 && !visited[pos - width]) {
			visited[pos - width] = 1;
			queuePos[tail] = pos - width;
			queueDist[tail++] = propagateDist;
		}
		if (y < height - 1 && !visited[pos + width]) {
			visited[pos + width] = 1;
			queuePos[tail] = pos + width;
			queueDist[tail++] = propagateDist;
		}
	}

	return mask;
}

/**
 * Rasterize cut paths (world coords) into a pixel barrier mask. Each polyline
 * segment is walked with a Bresenham-style step and stamped with a square of
 * Chebyshev radius derived from the desired world-space line width. The stamp
 * is at least 3px wide so the barrier stays 8-connected and a 4-connected
 * flood fill can never slip diagonally through it.
 */
export function buildCutMask(
	cutPaths: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>,
	space: FillRasterSpace,
	cutWidthWorld: number,
): Uint8Array {
	const { width, height } = space;
	const mask = new Uint8Array(width * height);
	const radius = Math.max(1, Math.round((cutWidthWorld * space.scale) / 2));

	const stamp = (cx: number, cy: number): void => {
		const x0 = Math.max(0, cx - radius);
		const x1 = Math.min(width - 1, cx + radius);
		const y0 = Math.max(0, cy - radius);
		const y1 = Math.min(height - 1, cy + radius);
		for (let y = y0; y <= y1; y++) {
			for (let x = x0; x <= x1; x++) {
				mask[y * width + x] = 1;
			}
		}
	};

	for (const path of cutPaths) {
		if (path.length < 2) continue;
		let prev = worldToRaster(space, path[0].x, path[0].y);
		for (let i = 1; i < path.length; i++) {
			const curr = worldToRaster(space, path[i].x, path[i].y);
			const x0 = Math.round(prev.x);
			const y0 = Math.round(prev.y);
			const x1 = Math.round(curr.x);
			const y1 = Math.round(curr.y);
			const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
			if (steps === 0) {
				stamp(x0, y0);
			} else {
				for (let s = 0; s <= steps; s++) {
					stamp(
						Math.round(x0 + ((x1 - x0) * s) / steps),
						Math.round(y0 + ((y1 - y0) * s) / steps),
					);
				}
			}
			prev = curr;
		}
	}

	return mask;
}
