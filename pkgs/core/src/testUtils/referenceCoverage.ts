import { appendClippedDeviceLine } from "../renderer/geometry/strips/deviceGeometry";
import { StripRasterizer } from "../renderer/geometry/strips/stripRenderer";
import type {
	ClipRect,
	StripBatch,
} from "../renderer/geometry/strips/stripTypes";
import { TILE_SIZE } from "../renderer/geometry/strips/stripTypes";

/** A closed polygon as `[x, y, x, y, ...]` in device pixels. */
export type ReferencePolygon = number[];

/**
 * How a pixel's supersampled windings reduce to one coverage value.
 * `nonzero` counts samples with nonzero winding. `winding-integral` averages
 * the winding and clamps, which is what area accumulation computes: the two
 * differ only where windings of different magnitude meet inside one pixel.
 */
export type ReferenceCoverageMode = "nonzero" | "winding-integral";

/**
 * Brute-force coverage of polygons by supersampled point-in-polygon, as one
 * float per pixel in row-major order.
 */
export function referenceCoverage(
	polygons: ReferencePolygon[],
	width: number,
	height: number,
	mode: ReferenceCoverageMode = "nonzero",
	samplesPerAxis = 16,
): Float32Array {
	const out = new Float32Array(width * height);
	const step = 1 / samplesPerAxis;
	const total = samplesPerAxis * samplesPerAxis;
	for (let py = 0; py < height; py++) {
		for (let px = 0; px < width; px++) {
			let inside = 0;
			let winding = 0;
			for (let sy = 0; sy < samplesPerAxis; sy++) {
				const y = py + (sy + 0.5) * step;
				for (let sx = 0; sx < samplesPerAxis; sx++) {
					const x = px + (sx + 0.5) * step;
					const w = windingAt(polygons, x, y);
					if (w !== 0) inside++;
					winding += w;
				}
			}
			out[py * width + px] =
				mode === "nonzero"
					? inside / total
					: Math.min(1, Math.abs(winding) / total);
		}
	}
	return out;
}

/**
 * Expand a strip batch into one float per pixel over `[0, width) × [0, height)`.
 * `alphas` holds 4 bytes per batch slot, `alphas[slot * 4 + row]`, as read
 * back from the alpha page.
 */
export function expandStripBatch(
	batch: StripBatch,
	alphas: Uint8Array,
	width: number,
	height: number,
): Float32Array {
	const out = new Float32Array(width * height);
	for (let s = 0; s < batch.stripCount; s++) {
		const x = batch.strips[s * 4];
		const y = batch.strips[s * 4 + 1];
		const w = batch.strips[s * 4 + 2];
		const dense = batch.strips[s * 4 + 3];
		const slot = batch.slots[s];
		for (let k = 0; k < w; k++) {
			const px = x + k;
			if (px < 0 || px >= width) continue;
			for (let r = 0; r < TILE_SIZE; r++) {
				const py = y + r;
				if (py < 0 || py >= height) continue;
				out[py * width + px] = k < dense ? alphas[(slot + k) * 4 + r] / 255 : 1;
			}
		}
	}
	return out;
}

/** Lay out the strips of closed polygons, as the path renderer does for a fill. */
export function layoutStrips(
	polygons: ReferencePolygon[],
	clip: ClipRect,
	denseOnly: boolean,
): StripBatch {
	const rasterizer = new StripRasterizer();
	for (const polygon of polygons) addPolygon(rasterizer, polygon, clip);
	return rasterizer.rasterize(clip, { denseOnly });
}

/** Add a closed polygon's edges to the lines a rasterizer lays out next. */
export function addPolygon(
	rasterizer: StripRasterizer,
	polygon: ReferencePolygon,
	clip: ClipRect,
): void {
	const n = polygon.length / 2;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		appendClippedDeviceLine(
			rasterizer.lines,
			polygon[i * 2],
			polygon[i * 2 + 1],
			polygon[j * 2],
			polygon[j * 2 + 1],
			clip,
		);
	}
}

export function rect(
	x: number,
	y: number,
	w: number,
	h: number,
): ReferencePolygon {
	return [x, y, x + w, y, x + w, y + h, x, y + h];
}

/** A self-intersecting five-point star, whose centre has winding 2. */
export function pentagram(
	cx: number,
	cy: number,
	radius: number,
): ReferencePolygon {
	const out: number[] = [];
	for (let i = 0; i < 5; i++) {
		const angle = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
		out.push(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
	}
	return out;
}

function windingAt(polygons: ReferencePolygon[], x: number, y: number): number {
	let winding = 0;
	for (const poly of polygons) {
		const n = poly.length / 2;
		for (let i = 0; i < n; i++) {
			const x0 = poly[i * 2];
			const y0 = poly[i * 2 + 1];
			const x1 = poly[((i + 1) % n) * 2];
			const y1 = poly[((i + 1) % n) * 2 + 1];
			if (y0 <= y) {
				if (y1 > y && cross(x0, y0, x1, y1, x, y) > 0) winding++;
			} else if (y1 <= y && cross(x0, y0, x1, y1, x, y) < 0) {
				winding--;
			}
		}
	}
	return winding;
}

function cross(
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	px: number,
	py: number,
): number {
	return (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0);
}
