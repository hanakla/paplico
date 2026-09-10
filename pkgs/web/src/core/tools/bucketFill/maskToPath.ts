/**
 * Mask → vector Path conversion for the bucket fill tool: marching squares
 * contour extraction followed by corner-preserving cubic bezier fitting.
 *
 * Simplification tolerances are constant in raster pixels (converted to world
 * via the raster scale), so the path is exactly as accurate as the raster the
 * fill actually ran on: a hi-res quality pass tightens the fit, a coarse
 * exploration raster does not get its stair-step noise chased.
 *
 * With a {@link SubpixelSource} the contour is extracted from the continuous
 * colour-difference field instead of the binary mask, so anti-aliased edges
 * position the boundary at the true `diff == tolerance` level with sub-pixel
 * precision.
 */

import { isoLines } from "marching-squares";
import { createIdentityTransform } from "../../document/factory";
import {
	type BoundingBox,
	type FillAppearance,
	type FillColor,
	generateUid,
	type Path,
	type PathSegment,
} from "../../schema";
import {
	type FittedCubic,
	fitCubicBeziers,
} from "../../utils/geometry/strokeFitting";
import type { SeedColor } from "./fill";
import { type FillRasterSpace, rasterToWorld } from "./rasterSpace";

// --- Types ---

/** Colour data to extract a sub-pixel contour from (the raster the fill ran
 *  on, its seed colour and tolerance). */
interface SubpixelSource {
	imageData: ImageData;
	seedColor: SeedColor;
	tolerance: number;
}

/** Bezier fitting tolerance / short-segment merge chord, in raster pixels. */
const FIT_TOLERANCE_PX = 2.5;
const MERGE_CHORD_PX = 1.5;

/** Floor for the world-space epsilons at extreme zoom-in scales. */
const MIN_EPS_WORLD = 0.02;

/** Outward contour expansion in raster px: the fill digs under the barrier's
 *  anti-aliased fringe (~1px) so semi-transparent edge pixels are fully
 *  covered and no halo remains between the fill and the line art. */
const FILL_OVERLAP_PX = 1;

// --- Functions ---

/**
 * Convert a filled mask to a Path using marching squares contour extraction.
 * World points are simplified via bezier fitting before converting to segments.
 */
export function maskToPath(
	mask: Uint8Array,
	space: FillRasterSpace,
	fill: FillColor,
	subpixel?: SubpixelSource,
): Path | null {
	const bounds = maskPixelBounds(mask, space.width, space.height);
	if (!bounds) return null;

	// Sample only the mask's bbox plus one pixel of outside values: the
	// contour never leaves mask-adjacent cells (outside pixels are clamped
	// below the threshold in both grid builders), so the crop is lossless
	// while grid construction and isoLines stop paying for the full raster.
	const crop: CropWindow = {
		x0: Math.max(0, bounds.minPx - 1),
		y0: Math.max(0, bounds.minPy - 1),
		x1: Math.min(space.width - 1, bounds.maxPx + 1),
		y1: Math.min(space.height - 1, bounds.maxPy + 1),
	};

	const grid = subpixel
		? buildFieldGrid(mask, space, subpixel, crop)
		: buildBinaryGrid(mask, space, crop);
	const threshold = subpixel ? 0 : 0.5;

	const rings = isoLines(grid, [threshold], { noFrame: true });
	if (!rings || rings.length === 0 || rings[0].length === 0) return null;

	const allRings = rings.flat();
	if (allRings.length === 0) return null;

	allRings.sort((a, b) => b.length - a.length);
	const ring = allRings[0];
	if (ring.length < 3) return null;

	const expanded = offsetRingOutward(ring, FILL_OVERLAP_PX);
	const worldPoints = expanded.map(([px, py]) =>
		rasterToWorld(space, px + crop.x0, py + crop.y0),
	);

	const epsFit = Math.max(FIT_TOLERANCE_PX / space.scale, MIN_EPS_WORLD);
	const minChord = Math.max(MERGE_CHORD_PX / space.scale, MIN_EPS_WORLD);

	// Split polyline at corners before fitting to preserve sharp angles.
	// Marching-squares staircases turn by exactly 45°, and the outward
	// offset perturbs those angles slightly across a 45° threshold — 60°
	// stays safely above the staircase while real corners (90°) still split.
	const spans = splitAtCorners(worldPoints, Math.PI / 3);
	const allCubics: FittedCubic[] = [];
	for (const span of spans) {
		if (span.length < 2) continue;
		const fitted = fitCubicBeziers(span, epsFit);
		allCubics.push(...fitted);
	}
	if (allCubics.length === 0) return null;

	// Multi-pass merge: collapse short bezier segments until stable
	let merged = allCubics;
	for (let pass = 0; pass < 8; pass++) {
		const next = mergeShortCubics(merged, minChord);
		if (next.length === merged.length) break;
		merged = next;
	}

	const segments: PathSegment[] = merged.map((c, i) => ({
		...(i === 0 ? { start: { x: c.p0.x, y: c.p0.y } } : {}),
		cp1: { x: c.p1.x - c.p0.x, y: c.p1.y - c.p0.y },
		cp2: { x: c.p2.x - c.p3.x, y: c.p2.y - c.p3.y },
		end: { x: c.p3.x, y: c.p3.y },
		isMoved: i === 0,
		isClosed: i === merged.length - 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
	}));

	return {
		id: generateUid("obj"),
		type: "path",
		segments,
		opacity: 1,
		blendMode: "normal",
		filters: [
			{
				uid: generateUid("app"),
				processor: "fill",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: { fill },
				},
			} satisfies FillAppearance,
		],
		transform: createIdentityTransform(),
	};
}

/**
 * Compute world-space bounding box of the filled mask region.
 */
export function computeMaskBounds(
	mask: Uint8Array,
	space: FillRasterSpace,
): BoundingBox {
	const { width, height } = space;
	const { minPx, minPy, maxPx, maxPy } = maskPixelBounds(
		mask,
		width,
		height,
	) ?? { minPx: width, minPy: height, maxPx: 0, maxPy: 0 };

	const topLeft = rasterToWorld(space, minPx, minPy);
	const bottomRight = rasterToWorld(space, maxPx, maxPy);

	const minX = Math.min(topLeft.x, bottomRight.x);
	const maxX = Math.max(topLeft.x, bottomRight.x);
	const minY = Math.min(topLeft.y, bottomRight.y);
	const maxY = Math.max(topLeft.y, bottomRight.y);

	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	};
}

// --- Helper functions ---

/** Inclusive raster-pixel window the contour grids are sampled over. */
interface CropWindow {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** Inclusive raster bbox of the set mask pixels; null for an empty mask. */
function maskPixelBounds(
	mask: Uint8Array,
	width: number,
	height: number,
): { minPx: number; minPy: number; maxPx: number; maxPy: number } | null {
	let minPx = width;
	let minPy = height;
	let maxPx = -1;
	let maxPy = -1;

	for (let y = 0; y < height; y++) {
		const rowBase = y * width;
		for (let x = 0; x < width; x++) {
			if (mask[rowBase + x]) {
				if (x < minPx) minPx = x;
				if (x > maxPx) maxPx = x;
				if (y < minPy) minPy = y;
				if (y > maxPy) maxPy = y;
			}
		}
	}

	return maxPx < 0 ? null : { minPx, minPy, maxPx, maxPy };
}

/** Grid of the raw 0/1 mask; the contour sits midway between pixels. */
function buildBinaryGrid(
	mask: Uint8Array,
	space: FillRasterSpace,
	crop: CropWindow,
): number[][] {
	const { width } = space;
	const grid: number[][] = [];
	for (let y = crop.y0; y <= crop.y1; y++) {
		const row: number[] = [];
		for (let x = crop.x0; x <= crop.x1; x++) {
			row.push(mask[y * width + x]);
		}
		grid.push(row);
	}
	return grid;
}

/**
 * Signed colour-difference field for sub-pixel contours: positive inside the
 * fill, negative outside, zero exactly at `diff == tolerance` — the true
 * flood-fill boundary. Anti-aliased pixels take graded values, so the iso
 * crossing interpolates the boundary between pixel centers. Pixels whose
 * colour disagrees with their mask side (cut barriers, gap-closing stops)
 * are forced to a full-strength value, which keeps those hard boundaries at
 * the pixel midpoint like the binary contour.
 */
function buildFieldGrid(
	mask: Uint8Array,
	space: FillRasterSpace,
	subpixel: SubpixelSource,
	crop: CropWindow,
): number[][] {
	const { width } = space;
	const { data } = subpixel.imageData;
	const { r: sr, g: sg, b: sb, a: sa } = subpixel.seedColor;
	const effTol = Math.max(subpixel.tolerance, 1);

	const grid: number[][] = [];
	for (let y = crop.y0; y <= crop.y1; y++) {
		const row: number[] = [];
		for (let x = crop.x0; x <= crop.x1; x++) {
			const i = y * width + x;
			const pi = i * 4;
			const dr = data[pi] - sr;
			const dg = data[pi + 1] - sg;
			const db = data[pi + 2] - sb;
			const da = data[pi + 3] - sa;
			const diff = Math.sqrt(dr * dr + dg * dg + db * db + da * da);
			const v = Math.max(-1, Math.min(1, (effTol - diff) / effTol));
			row.push(mask[i] === 1 ? Math.max(v, 0.05) : v < 0 ? v : -1);
		}
		grid.push(row);
	}
	return grid;
}

/**
 * Push a closed contour ring outward (away from the enclosed fill) along the
 * per-vertex normal. The outward sign is derived at the rightmost vertex,
 * where the outward normal must have a positive x component, and applied to
 * the whole ring (consistent winding).
 */
function offsetRingOutward(
	ring: Array<[number, number]>,
	amount: number,
): Array<[number, number]> {
	// Drop a duplicated closing point so wrap-around tangents stay non-zero
	const first = ring[0];
	const last = ring[ring.length - 1];
	const points =
		ring.length > 1 &&
		Math.abs(first[0] - last[0]) < 1e-9 &&
		Math.abs(first[1] - last[1]) < 1e-9
			? ring.slice(0, -1)
			: ring;
	const n = points.length;
	if (n < 3) return ring;

	// Wide tangent window: marching-squares rings are 1px staircases whose
	// per-vertex tangents oscillate ±45°; averaging over ±K vertices (≈8px of
	// arc) keeps the offset normals (and thus the offset ring) smooth.
	const K = Math.min(8, Math.floor((n - 1) / 2));
	const tangentAt = (i: number): [number, number] => {
		const p = points[(i - K + n) % n];
		const q = points[(i + K) % n];
		return [q[0] - p[0], q[1] - p[1]];
	};

	let rightmost = 0;
	for (let i = 1; i < n; i++) {
		if (points[i][0] > points[rightmost][0]) rightmost = i;
	}
	const [, rty] = tangentAt(rightmost);
	// Candidate normal is (ty, -tx); at the rightmost vertex its x component
	// (= ty) must point outward (+x)
	const sign = rty >= 0 ? 1 : -1;

	const offsets: Array<[number, number]> = new Array(n);
	for (let i = 0; i < n; i++) {
		const [tx, ty] = tangentAt(i);
		const len = Math.hypot(tx, ty);
		offsets[i] =
			len < 1e-9
				? [0, 0]
				: [(sign * ty * amount) / len, (-sign * tx * amount) / len];
	}

	// Box-average the offset vectors so residual staircase jitter in the
	// normals does not wrinkle the ring (base vertices stay untouched, so
	// corners keep their position).
	const S = Math.min(2, Math.floor((n - 1) / 2));
	const out: Array<[number, number]> = new Array(n);
	for (let i = 0; i < n; i++) {
		let ox = 0;
		let oy = 0;
		for (let k = -S; k <= S; k++) {
			const o = offsets[(i + k + n) % n];
			ox += o[0];
			oy += o[1];
		}
		const count = S * 2 + 1;
		out[i] = [points[i][0] + ox / count, points[i][1] + oy / count];
	}
	return out;
}

/**
 * Split a closed polyline into spans at corner points where the turning
 * angle exceeds `threshold` radians. Each span shares its boundary point
 * with the next so that bezier fitting preserves exact corner positions.
 */
function splitAtCorners(
	points: Array<{ x: number; y: number }>,
	threshold: number,
): Array<Array<{ x: number; y: number }>> {
	if (points.length < 3) return [points];

	const cornerIndices: number[] = [0];
	for (let i = 1; i < points.length - 1; i++) {
		const prev = points[i - 1];
		const curr = points[i];
		const next = points[i + 1];
		const dx1 = curr.x - prev.x;
		const dy1 = curr.y - prev.y;
		const dx2 = next.x - curr.x;
		const dy2 = next.y - curr.y;
		const angle = Math.abs(
			Math.atan2(dx1 * dy2 - dy1 * dx2, dx1 * dx2 + dy1 * dy2),
		);
		if (angle > threshold) {
			cornerIndices.push(i);
		}
	}
	cornerIndices.push(points.length - 1);

	const spans: Array<Array<{ x: number; y: number }>> = [];
	for (let i = 0; i < cornerIndices.length - 1; i++) {
		spans.push(points.slice(cornerIndices[i], cornerIndices[i + 1] + 1));
	}
	return spans;
}

/**
 * Merge consecutive bezier segments whose chord length is below `minChord`.
 * Short segments are absorbed into the preceding or following segment by
 * re-fitting the combined span as a single linear bezier. Runs one pass;
 * caller should repeat until stable.
 */
function mergeShortCubics(
	cubics: FittedCubic[],
	minChord: number,
): FittedCubic[] {
	if (cubics.length <= 1) return cubics;
	const minChordSq = minChord * minChord;

	// Mark which segments are short
	const isShort = cubics.map((c) => {
		const dx = c.p3.x - c.p0.x;
		const dy = c.p3.y - c.p0.y;
		return dx * dx + dy * dy < minChordSq;
	});

	// Group consecutive segments: absorb short ones into the preceding group
	const groups: Array<{ start: number; end: number }> = [];
	let gi = 0;
	while (gi < cubics.length) {
		const groupStart = gi;
		gi++;
		// Absorb following short segments into this group
		while (gi < cubics.length && isShort[gi]) gi++;
		groups.push({ start: groupStart, end: gi - 1 });
	}

	// Each group → one linear bezier from group's first p0 to last p3
	return groups.map(({ start, end }) => {
		if (start === end) return cubics[start];
		const p0 = cubics[start].p0;
		const p3 = cubics[end].p3;
		const mx = (p3.x - p0.x) / 3;
		const my = (p3.y - p0.y) / 3;
		return {
			p0,
			p1: { x: p0.x + mx, y: p0.y + my },
			p2: { x: p3.x - mx, y: p3.y - my },
			p3,
		};
	});
}
