import type { GPUTransformAffine } from "../../../utils/geometry/geometry";
import type { LineArena } from "./lineArena";
import type { ClipRect, DeviceTransform, RasterFrame } from "./stripTypes";

/** Screen-space error budget of curve flattening and stroke arcs, in device px. */
export const DEVICE_CURVE_TOLERANCE_PX = 0.25;

const MIN_SCALE_BUCKET = -20;
const MAX_SCALE_BUCKET = 20;

/**
 * Local → device-pixel affine for one element in one pass, replicating the
 * vertex stage of `unified.wgsl` (element transform, viewport offset, zoom,
 * rotation, NDC → pixel with y down) so CPU coverage lands on the same texels
 * the GPU paint stage addresses.
 */
export function composeDeviceTransform(
	gt: GPUTransformAffine,
	frame: RasterFrame,
): DeviceTransform {
	const { viewport, width, height } = frame;
	const zoom = viewport.zoom;
	const rotSin = -Math.sin(viewport.rotation);
	const rotCos = Math.cos(viewport.rotation);

	// world = M · pos + b
	const bx = gt.originX + gt.tx - (gt.m00 * gt.originX + gt.m01 * gt.originY);
	const by = gt.originY + gt.ty - (gt.m10 * gt.originX + gt.m11 * gt.originY);

	// R · M
	const r00 = rotCos * gt.m00 - rotSin * gt.m10;
	const r01 = rotCos * gt.m01 - rotSin * gt.m11;
	const r10 = rotSin * gt.m00 + rotCos * gt.m10;
	const r11 = rotSin * gt.m01 + rotCos * gt.m11;

	const dx = bx - viewport.x;
	const dy = by - viewport.y;

	return {
		a: zoom * r00,
		c: zoom * r01,
		b: -zoom * r10,
		d: -zoom * r11,
		e: zoom * (rotCos * dx - rotSin * dy) + width / 2,
		f: -zoom * (rotSin * dx + rotCos * dy) + height / 2,
	};
}

/**
 * Power-of-two bucket of the transform's scale. Flattening local geometry at
 * `DEVICE_CURVE_TOLERANCE_PX / 2^bucket` keeps the device error within budget
 * for every scale in the bucket, so outlines survive small zoom changes.
 */
export function deviceScaleBucket(t: DeviceTransform): number {
	const scale = Math.sqrt(Math.abs(t.a * t.d - t.b * t.c));
	if (!(scale > 0)) return 0;
	return Math.min(
		MAX_SCALE_BUCKET,
		Math.max(MIN_SCALE_BUCKET, Math.ceil(Math.log2(scale))),
	);
}

/** Local-space flattening tolerance for a scale bucket. */
export function localCurveTolerance(scaleBucket: number): number {
	return DEVICE_CURVE_TOLERANCE_PX / 2 ** scaleBucket;
}

/**
 * Append the edges of closed polylines. `subpathOffsets` holds the start point
 * index of each subpath plus a trailing end index.
 */
export function appendFillLines(
	arena: LineArena,
	points: Float32Array,
	subpathOffsets: Int32Array,
	t: DeviceTransform,
	clip: ClipRect,
): void {
	for (let s = 0; s + 1 < subpathOffsets.length; s++) {
		const start = subpathOffsets[s];
		const end = subpathOffsets[s + 1];
		const n = end - start;
		if (n < 3) continue;
		for (let i = 0; i < n; i++) {
			const p = (start + i) * 2;
			const q = (start + ((i + 1) % n)) * 2;
			appendClippedLine(
				arena,
				points[p],
				points[p + 1],
				points[q],
				points[q + 1],
				t,
				clip,
			);
		}
	}
}

/**
 * Append the edges of a triangle list with every triangle oriented the same
 * way, so overlapping triangles add winding and their nonzero fill is the
 * exact union of the soup.
 */
export function appendTriangleSoupLines(
	arena: LineArena,
	vertices: Float32Array,
	t: DeviceTransform,
	clip: ClipRect,
): void {
	for (let i = 0; i + 5 < vertices.length; i += 6) {
		const x0 = t.a * vertices[i] + t.c * vertices[i + 1] + t.e;
		const y0 = t.b * vertices[i] + t.d * vertices[i + 1] + t.f;
		const x1 = t.a * vertices[i + 2] + t.c * vertices[i + 3] + t.e;
		const y1 = t.b * vertices[i + 2] + t.d * vertices[i + 3] + t.f;
		const x2 = t.a * vertices[i + 4] + t.c * vertices[i + 5] + t.e;
		const y2 = t.b * vertices[i + 4] + t.d * vertices[i + 5] + t.f;
		const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
		if (Math.abs(area) < 1e-9) continue;
		if (area > 0) {
			appendClippedDeviceLine(arena, x0, y0, x1, y1, clip);
			appendClippedDeviceLine(arena, x1, y1, x2, y2, clip);
			appendClippedDeviceLine(arena, x2, y2, x0, y0, clip);
		} else {
			appendClippedDeviceLine(arena, x0, y0, x2, y2, clip);
			appendClippedDeviceLine(arena, x2, y2, x1, y1, clip);
			appendClippedDeviceLine(arena, x1, y1, x0, y0, clip);
		}
	}
}

function appendClippedLine(
	arena: LineArena,
	lx0: number,
	ly0: number,
	lx1: number,
	ly1: number,
	t: DeviceTransform,
	clip: ClipRect,
): void {
	appendClippedDeviceLine(
		arena,
		t.a * lx0 + t.c * ly0 + t.e,
		t.b * lx0 + t.d * ly0 + t.f,
		t.a * lx1 + t.c * ly1 + t.e,
		t.b * lx1 + t.d * ly1 + t.f,
		clip,
	);
}

/**
 * Clip one device-space edge to the rect and append it relative to the rect
 * origin. Rows outside the rect are cut away. The part left of the rect is
 * projected onto the left edge as a vertical segment, which keeps the winding
 * it contributes to every pixel on its right; the part right of the rect
 * covers nothing inside and is dropped.
 */
export function appendClippedDeviceLine(
	arena: LineArena,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	clip: ClipRect,
): void {
	if (!(Number.isFinite(x0) && Number.isFinite(y0))) return;
	if (!(Number.isFinite(x1) && Number.isFinite(y1))) return;
	if (y0 === y1) {
		appendHorizontalLine(arena, x0, x1, y0, clip);
		return;
	}

	const dy = y1 - y0;
	let t0 = 0;
	let t1 = 1;
	const tTop = (clip.y0 - y0) / dy;
	const tBottom = (clip.y1 - y0) / dy;
	const tLo = Math.min(tTop, tBottom);
	const tHi = Math.max(tTop, tBottom);
	if (tLo > t0) t0 = tLo;
	if (tHi < t1) t1 = tHi;
	if (t0 >= t1) return;

	const dx = x1 - x0;
	// Split at the vertical clip edges so each piece is wholly left of, inside,
	// or right of the rect.
	let ta = t0;
	let tb = t1;
	let tc = t1;
	if (dx !== 0) {
		const tLeft = (clip.x0 - x0) / dx;
		const tRight = (clip.x1 - x0) / dx;
		const tSplitLo = Math.min(tLeft, tRight);
		const tSplitHi = Math.max(tLeft, tRight);
		ta = Math.min(Math.max(tSplitLo, t0), t1);
		tb = Math.min(Math.max(tSplitHi, t0), t1);
		tc = t1;
	}

	appendPiece(arena, x0, y0, dx, dy, t0, ta, clip);
	appendPiece(arena, x0, y0, dx, dy, ta, tb, clip);
	appendPiece(arena, x0, y0, dx, dy, tb, tc, clip);
}

/**
 * A horizontal line adds no winding, but the tile it lies in must still exist:
 * rows above and below it can hold different windings, and the strip walker
 * only carries per-row windings through tiles. Only the part inside the rect
 * matters, so it is clipped rather than projected.
 */
function appendHorizontalLine(
	arena: LineArena,
	x0: number,
	x1: number,
	y: number,
	clip: ClipRect,
): void {
	if (y < clip.y0 || y >= clip.y1) return;
	const left = Math.max(Math.min(x0, x1), clip.x0);
	const right = Math.min(Math.max(x0, x1), clip.x1);
	if (left >= right) return;
	arena.push(left - clip.x0, y - clip.y0, right - clip.x0, y - clip.y0);
}

function appendPiece(
	arena: LineArena,
	x0: number,
	y0: number,
	dx: number,
	dy: number,
	ta: number,
	tb: number,
	clip: ClipRect,
): void {
	if (ta >= tb) return;
	const ax = x0 + dx * ta;
	const ay = y0 + dy * ta;
	const bx = x0 + dx * tb;
	const by = y0 + dy * tb;
	const midX = (ax + bx) * 0.5;
	if (midX >= clip.x1) return;
	if (midX < clip.x0) {
		arena.push(0, ay - clip.y0, 0, by - clip.y0);
		return;
	}
	arena.push(ax - clip.x0, ay - clip.y0, bx - clip.x0, by - clip.y0);
}
