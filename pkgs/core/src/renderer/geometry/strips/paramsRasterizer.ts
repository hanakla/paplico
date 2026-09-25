import {
	type ClipRect,
	type DeviceTransform,
	type StripBatch,
	TILE_SIZE,
} from "./stripTypes";

/** Farthest a pixel centre can sit outside a triangle that still covers part of the pixel. */
const PIXEL_REACH = Math.SQRT1_2;

/**
 * Write per-pixel stroke gradient params (t along, u across) into a batch
 * rasterized with `denseOnly`, so every covered pixel owns a slot. Each
 * triangle's params are interpolated barycentrically at the pixel centre;
 * where triangles overlap the last one written wins. A pixel whose centre
 * falls outside every triangle that partially covers it takes the params of
 * the nearest point of such a triangle, and never overrides an interior hit.
 */
export function rasterizeStrokeParams(
	batch: StripBatch,
	vertices: Float32Array,
	vertexParams: Float32Array,
	t: DeviceTransform,
	clip: ClipRect,
): void {
	const params = new Uint8Array(batch.slotCount * 8);
	batch.params = params;
	if (batch.stripCount === 0) return;
	const interior = new Uint8Array(batch.slotCount * 4);
	const index = buildStripIndex(batch);
	const { bounds } = batch;
	const minClipX = Math.max(clip.x0, bounds.minX);
	const minClipY = Math.max(clip.y0, bounds.minY);
	const maxClipX = Math.min(clip.x1, bounds.maxX);
	const maxClipY = Math.min(clip.y1, bounds.maxY);

	for (let i = 0; i + 5 < vertices.length; i += 6) {
		const x0 = t.a * vertices[i] + t.c * vertices[i + 1] + t.e;
		const y0 = t.b * vertices[i] + t.d * vertices[i + 1] + t.f;
		const x1 = t.a * vertices[i + 2] + t.c * vertices[i + 3] + t.e;
		const y1 = t.b * vertices[i + 2] + t.d * vertices[i + 3] + t.f;
		const x2 = t.a * vertices[i + 4] + t.c * vertices[i + 5] + t.e;
		const y2 = t.b * vertices[i + 4] + t.d * vertices[i + 5] + t.f;
		const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
		if (Math.abs(det) < 1e-9) continue;
		const invDet = 1 / det;
		// A barycentric weight times its vertex's height over the opposite
		// edge is the signed distance from that edge.
		const absDet = Math.abs(det);
		const h0 = absDet / Math.hypot(x2 - x1, y2 - y1);
		const h1 = absDet / Math.hypot(x2 - x0, y2 - y0);
		const h2 = absDet / Math.hypot(x1 - x0, y1 - y0);

		const pStart = i;
		const t0 = vertexParams[pStart];
		const u0 = vertexParams[pStart + 1];
		const t1 = vertexParams[pStart + 2];
		const u1 = vertexParams[pStart + 3];
		const t2 = vertexParams[pStart + 4];
		const u2 = vertexParams[pStart + 5];

		const pxStart = Math.max(minClipX, Math.floor(Math.min(x0, x1, x2) - 1));
		const pxEnd = Math.min(maxClipX, Math.ceil(Math.max(x0, x1, x2) + 1));
		const pyStart = Math.max(minClipY, Math.floor(Math.min(y0, y1, y2) - 1));
		const pyEnd = Math.min(maxClipY, Math.ceil(Math.max(y0, y1, y2) + 1));

		for (let py = pyStart; py < pyEnd; py++) {
			const cy = py + 0.5;
			for (let px = pxStart; px < pxEnd; px++) {
				const cx = px + 0.5;
				const w1 = ((cx - x0) * (y2 - y0) - (x2 - x0) * (cy - y0)) * invDet;
				const w2 = ((x1 - x0) * (cy - y0) - (cx - x0) * (y1 - y0)) * invDet;
				const w0 = 1 - w1 - w2;
				const inside = w0 >= -1e-4 && w1 >= -1e-4 && w2 >= -1e-4;
				if (
					!inside &&
					(w0 * h0 < -PIXEL_REACH ||
						w1 * h1 < -PIXEL_REACH ||
						w2 * h2 < -PIXEL_REACH)
				) {
					continue;
				}
				const slot = findSlot(batch, index, px, py);
				if (slot < 0) continue;
				const row = py - Math.floor(py / TILE_SIZE) * TILE_SIZE;
				const cell = slot * 4 + row;
				const at = cell * 2;
				if (inside) {
					interior[cell] = 1;
					params[at] = toByte(w0 * t0 + w1 * t1 + w2 * t2);
					params[at + 1] = toByte(w0 * u0 + w1 * u1 + w2 * u2);
					continue;
				}
				if (interior[cell]) continue;
				// Outside across one edge: the nearest point is on that edge.
				// Outside across two edges: it is the vertex between them.
				if (w0 < 0 && w1 < 0) {
					params[at] = toByte(t2);
					params[at + 1] = toByte(u2);
				} else if (w1 < 0 && w2 < 0) {
					params[at] = toByte(t0);
					params[at + 1] = toByte(u0);
				} else if (w2 < 0 && w0 < 0) {
					params[at] = toByte(t1);
					params[at + 1] = toByte(u1);
				} else if (w0 < 0) {
					const s = edgeParameter(cx, cy, x1, y1, x2, y2);
					params[at] = toByte(t1 + (t2 - t1) * s);
					params[at + 1] = toByte(u1 + (u2 - u1) * s);
				} else if (w1 < 0) {
					const s = edgeParameter(cx, cy, x2, y2, x0, y0);
					params[at] = toByte(t2 + (t0 - t2) * s);
					params[at + 1] = toByte(u2 + (u0 - u2) * s);
				} else {
					const s = edgeParameter(cx, cy, x0, y0, x1, y1);
					params[at] = toByte(t0 + (t1 - t0) * s);
					params[at + 1] = toByte(u0 + (u1 - u0) * s);
				}
			}
		}
	}
}

/** Position of the projection of (px, py) onto the edge a→b, clamped to 0..1. */
function edgeParameter(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number,
): number {
	const dx = bx - ax;
	const dy = by - ay;
	const s = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
	return s < 0 ? 0 : s > 1 ? 1 : s;
}

interface StripIndex {
	/** Strip band y (px) per band, ascending. */
	bandY: Int32Array;
	/** Strip index where each band starts, plus a trailing end. */
	bandStart: Int32Array;
}

/** Strips are emitted row-major, so bands are contiguous runs of equal y. */
function buildStripIndex(batch: StripBatch): StripIndex {
	const bandY: number[] = [];
	const bandStart: number[] = [];
	let lastY = Number.NaN;
	for (let s = 0; s < batch.stripCount; s++) {
		const y = batch.strips[s * 4 + 1];
		if (y !== lastY) {
			bandY.push(y);
			bandStart.push(s);
			lastY = y;
		}
	}
	bandStart.push(batch.stripCount);
	return {
		bandY: Int32Array.from(bandY),
		bandStart: Int32Array.from(bandStart),
	};
}

function findSlot(
	batch: StripBatch,
	index: StripIndex,
	px: number,
	py: number,
): number {
	const y = Math.floor(py / TILE_SIZE) * TILE_SIZE;
	let lo = 0;
	let hi = index.bandY.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const v = index.bandY[mid];
		if (v < y) lo = mid + 1;
		else if (v > y) hi = mid - 1;
		else {
			return findSlotInBand(
				batch,
				index.bandStart[mid],
				index.bandStart[mid + 1],
				px,
			);
		}
	}
	return -1;
}

function findSlotInBand(
	batch: StripBatch,
	start: number,
	end: number,
	px: number,
): number {
	let lo = start;
	let hi = end - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const x = batch.strips[mid * 4];
		if (px < x) {
			hi = mid - 1;
			continue;
		}
		const dense = batch.strips[mid * 4 + 3];
		if (px < x + dense) return batch.slots[mid] + (px - x);
		lo = mid + 1;
	}
	return -1;
}

function toByte(v: number): number {
	const c = v < 0 ? 0 : v > 1 ? 1 : v;
	return Math.round(c * 255);
}
