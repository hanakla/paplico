/**
 * Leak localization for unbounded bucket fills.
 *
 * When a flood fill escapes the maximum search window, the clicked region is
 * not closed. This module answers WHERE it escapes: a 3-4 chamfer distance
 * transform gives each free pixel its distance to the nearest barrier, and a
 * bucket-queue Dijkstra finds the maximum-bottleneck (widest) path from the
 * seed to the raster border. The narrowest passage on that path is the leak.
 * Each found leak is virtually sealed — a straight chord between the walls
 * flanking the passage, like a continuation of the line art — and the search
 * repeats, enumerating multiple leaks until the region closes or maxLeaks is
 * reached.
 */

import { type FillRasterSpace, rasterToWorld } from "./rasterSpace";

// --- Types ---

export interface LeakPoint {
	/** World position of the narrowest passage on the escape path. */
	x: number;
	y: number;
	/** Approximate passage width in world units. */
	gapWidthWorld: number;
}

export interface LeakResult {
	leaks: LeakPoint[];
	/** True when nothing meaningfully encloses the seed (e.g. a click on a
	 *  blank area) — "leak location" is not a useful concept there. */
	noBarriers: boolean;
	/** Fill mask recomputed with all found leaks sealed; null when sealing
	 *  maxLeaks passages still leaves the region unbounded (or there was
	 *  nothing to seal). */
	sealedMask: Uint8Array | null;
}

/** Chamfer 3-4 distance value meaning "no barrier anywhere". */
const CHAMFER_INF = 0xffff;

/** Orthogonal/diagonal step costs of the 3-4 chamfer metric (≈ 3×Euclid). */
const CHAMFER_ORTHO = 3;
const CHAMFER_DIAG = 4;

// --- Functions ---

/**
 * Two-pass 3-4 chamfer distance transform: distance from each free pixel
 * (fillable=1) to the nearest barrier pixel (fillable=0), in units of
 * ~3 × pixel. Barrier pixels get 0; a raster with no barrier stays at
 * CHAMFER_INF everywhere.
 */
export function chamferDistanceTransform(
	fillable: Uint8Array,
	width: number,
	height: number,
): Uint16Array {
	const size = width * height;
	const dist = new Uint16Array(size);
	for (let i = 0; i < size; i++) {
		dist[i] = fillable[i] === 0 ? 0 : CHAMFER_INF;
	}

	// Forward pass (top-left → bottom-right)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = y * width + x;
			if (dist[i] === 0) continue;
			let d = dist[i];
			if (x > 0) d = Math.min(d, dist[i - 1] + CHAMFER_ORTHO);
			if (y > 0) {
				d = Math.min(d, dist[i - width] + CHAMFER_ORTHO);
				if (x > 0) d = Math.min(d, dist[i - width - 1] + CHAMFER_DIAG);
				if (x < width - 1) d = Math.min(d, dist[i - width + 1] + CHAMFER_DIAG);
			}
			dist[i] = Math.min(d, CHAMFER_INF);
		}
	}

	// Backward pass (bottom-right → top-left)
	for (let y = height - 1; y >= 0; y--) {
		for (let x = width - 1; x >= 0; x--) {
			const i = y * width + x;
			if (dist[i] === 0) continue;
			let d = dist[i];
			if (x < width - 1) d = Math.min(d, dist[i + 1] + CHAMFER_ORTHO);
			if (y < height - 1) {
				d = Math.min(d, dist[i + width] + CHAMFER_ORTHO);
				if (x < width - 1) d = Math.min(d, dist[i + width + 1] + CHAMFER_DIAG);
				if (x > 0) d = Math.min(d, dist[i + width - 1] + CHAMFER_DIAG);
			}
			dist[i] = Math.min(d, CHAMFER_INF);
		}
	}

	return dist;
}

/**
 * Locate the leaks of an unbounded fill. `fillable` is the free-space mask
 * the flood fill ran on (colour-tolerance pass minus cut barriers); it is
 * copied, not mutated.
 *
 * By default the escape target is the raster border (a fill reaching it is
 * unbounded). `escapeTargetPos` retargets the search to a single cell — used
 * for bounded fills that spilled into a wide open area (e.g. an artboard
 * background), where the deepest spilled cell plays the role of "outside".
 */
export function findLeaks(opts: {
	fillable: Uint8Array;
	width: number;
	height: number;
	seedX: number;
	seedY: number;
	space: FillRasterSpace;
	maxLeaks?: number;
	escapeTargetPos?: number;
	/** Chamfer field and round-0 bottleneck a caller already computed for the
	 *  same fillable (see findSpillLeaks). Ownership of `dist` transfers here —
	 *  the field is mutated as found leaks get sealed. */
	precomputedRound0?: { dist: Uint16Array; bottleneck: number };
}): LeakResult {
	const { width, height, space, seedX, seedY, escapeTargetPos } = opts;
	const maxLeaks = opts.maxLeaks ?? 4;
	const fillable = opts.fillable.slice();
	const leaks: LeakPoint[] = [];
	let noBarriers = false;
	let sealedTight = false;

	const escapeSpec = escapeSpecOf(width, height, escapeTargetPos);
	const sealedCells: Array<{ x: number; y: number; r: number }> = [];

	// The chamfer field is computed once and incrementally relaxed after each
	// seal — a full per-round recompute over a document-sized raster was the
	// single largest cost of leak analysis.
	const dist =
		opts.precomputedRound0?.dist ??
		chamferDistanceTransform(fillable, width, height);

	for (let round = 0; round <= maxLeaks; round++) {
		const bottleneck =
			round === 0 && opts.precomputedRound0
				? opts.precomputedRound0.bottleneck
				: escapeBottleneck(
						fillable,
						dist,
						width,
						height,
						seedX,
						seedY,
						escapeSpec,
					);
		if (bottleneck === null) {
			sealedTight = true;
			break;
		}
		// A bottleneck comparable to the raster itself means the seed is not
		// enclosed by anything — report "no barriers" instead of a leak marker.
		// (Cell-targeted searches decide intentionality in findSpillLeaks.)
		if (
			escapeTargetPos === undefined &&
			round === 0 &&
			bottleneck / CHAMFER_ORTHO > Math.min(width, height) / 4
		) {
			noBarriers = true;
			break;
		}
		if (round === maxLeaks) break; // more leaks than we enumerate

		const cell = locateLeakCell(
			fillable,
			dist,
			width,
			height,
			seedX,
			seedY,
			bottleneck,
			escapeSpec,
		);
		const gapHalfPx = bottleneck / CHAMFER_ORTHO;

		// A previously sealed passage detected again means its chord seal did
		// not block it (unusual wall geometry) — brute-force it with a disc
		// instead of reporting a duplicate marker.
		const resealed = sealedCells.some(
			(s) => (cell.x - s.x) ** 2 + (cell.y - s.y) ** 2 <= (s.r + 2) ** 2,
		);
		if (resealed) {
			const stamped = stampBarrierDisc(
				fillable,
				width,
				height,
				cell.x,
				cell.y,
				Math.ceil(gapHalfPx) + 2,
			);
			relaxChamferForNewBarriers(dist, width, height, stamped);
			continue;
		}

		const world = rasterToWorld(space, cell.x, cell.y);
		leaks.push({
			x: world.x,
			y: world.y,
			gapWidthWorld: (gapHalfPx * 2) / space.scale,
		});
		sealedCells.push({ x: cell.x, y: cell.y, r: Math.ceil(gapHalfPx) + 2 });
		const stamped = sealLeak(
			fillable,
			width,
			height,
			cell.x,
			cell.y,
			gapHalfPx,
		);
		relaxChamferForNewBarriers(dist, width, height, stamped);
	}

	const sealedMask =
		sealedTight && leaks.length > 0
			? floodFillFillable(fillable, width, height, seedX, seedY)
			: null;

	return { leaks, noBarriers, sealedMask };
}

/** A fill counts as an unintended spill only when the passage into the wide
 *  area is at least this many times narrower than the area's clearance. */
const SPILL_CLEARANCE_RATIO = 4;

/**
 * Analyze a BOUNDED fill that reached a wide open area (e.g. spilled across
 * an artboard background): did it escape a smaller enclosure through a narrow
 * passage, and where? The deepest cell of the fill (max clearance) plays the
 * role of "outside". Returns null when the seed connects to that cell through
 * a passage comparable to the area's clearance — i.e. the user filled the
 * open area on purpose and there is nothing to warn about.
 */
export function findSpillLeaks(opts: {
	fillable: Uint8Array;
	width: number;
	height: number;
	seedX: number;
	seedY: number;
	space: FillRasterSpace;
	/** The bounded fill result whose deepest cell defines the spill target. */
	fillMask: Uint8Array;
	maxLeaks?: number;
}): LeakResult | null {
	const { fillable, width, height, seedX, seedY, fillMask } = opts;

	const dist = chamferDistanceTransform(fillable, width, height);
	let targetPos = -1;
	let targetDist = -1;
	for (let i = 0; i < fillMask.length; i++) {
		if (fillMask[i] === 1 && dist[i] > targetDist) {
			targetDist = dist[i];
			targetPos = i;
		}
	}
	if (targetPos < 0) return null;

	const bottleneck = escapeBottleneck(
		fillable,
		dist,
		width,
		height,
		seedX,
		seedY,
		escapeSpecOf(width, height, targetPos),
	);
	if (bottleneck === null) return null;
	if (bottleneck > targetDist / SPILL_CLEARANCE_RATIO) return null;

	// findLeaks' round 0 would redo exactly this chamfer transform and
	// bottleneck search — hand both over (including `dist` ownership).
	return findLeaks({
		...opts,
		escapeTargetPos: targetPos,
		precomputedRound0: { dist, bottleneck },
	});
}

// --- Helper functions ---

/** Where an escaping fill is considered to have "gotten out". */
interface EscapeSpec {
	isEscape: (pos: number, x: number, y: number) => boolean;
	/** Flood seeds for the outside component in leak localization. */
	targetStarts: () => number[];
}

function escapeSpecOf(
	width: number,
	height: number,
	targetPos: number | undefined,
): EscapeSpec {
	if (targetPos !== undefined) {
		return {
			isEscape: (pos) => pos === targetPos,
			targetStarts: () => [targetPos],
		};
	}
	return {
		isEscape: (_pos, x, y) =>
			x === 0 || y === 0 || x === width - 1 || y === height - 1,
		targetStarts: () => {
			const starts: number[] = [];
			for (let x = 0; x < width; x++) {
				starts.push(x, (height - 1) * width + x);
			}
			for (let y = 1; y < height - 1; y++) {
				starts.push(y * width, y * width + width - 1);
			}
			return starts;
		},
	};
}

/**
 * Capacity of the maximum-bottleneck (widest) path from the seed to any
 * escape cell over free space, via bucket-queue Dijkstra (capacities are
 * small chamfer integers). Returns null when the seed's component does not
 * reach any escape cell (the region is closed).
 */
function escapeBottleneck(
	fillable: Uint8Array,
	dist: Uint16Array,
	width: number,
	height: number,
	seedX: number,
	seedY: number,
	escapeSpec: EscapeSpec,
): number | null {
	const size = width * height;
	const seedPos = seedY * width + seedX;
	if (fillable[seedPos] === 0) return null;
	const seedCap = dist[seedPos];
	if (seedCap === 0) return null;

	if (escapeSpec.isEscape(seedPos, seedX, seedY)) return seedCap;

	const cap = new Uint16Array(size);
	const buckets: Array<number[] | undefined> = new Array(seedCap + 1);
	cap[seedPos] = seedCap;
	buckets[seedCap] = [seedPos];

	for (let c = seedCap; c >= 1; c--) {
		const bucket = buckets[c];
		if (!bucket) continue;
		const relax = (n: number): void => {
			if (fillable[n] === 0) return;
			const nc = Math.min(c, dist[n]);
			if (nc > cap[n]) {
				cap[n] = nc;
				buckets[nc] ??= [];
				buckets[nc].push(n);
			}
		};
		while (bucket.length > 0) {
			// biome-ignore lint/style/noNonNullAssertion: bucket is non-empty
			const pos = bucket.pop()!;
			if (cap[pos] !== c) continue; // superseded by a higher capacity
			const x = pos % width;
			const y = (pos - x) / width;

			if (escapeSpec.isEscape(pos, x, y)) return c;

			if (x > 0) relax(pos - 1);
			if (x < width - 1) relax(pos + 1);
			if (y > 0) relax(pos - width);
			if (y < height - 1) relax(pos + width);
		}
	}

	return null;
}

/**
 * Locate the narrowest passage of the escape. Any widest path may brush other
 * barriers at exactly the bottleneck distance, so the path itself does not
 * pinpoint the gap. Instead use a threshold decomposition: with capacity B,
 * the seed component S and border component T of {dist > B} are separated —
 * the leak is the corridor of {dist ≤ B} cells joining them. A BFS from the
 * S boundary through the corridor finds the first T contact; the max-dist
 * cell of that crossing chain is the passage center.
 */
function locateLeakCell(
	fillable: Uint8Array,
	dist: Uint16Array,
	width: number,
	height: number,
	seedX: number,
	seedY: number,
	bottleneck: number,
	escapeSpec: EscapeSpec,
): { x: number; y: number } {
	const size = width * height;
	const label = new Uint8Array(size); // 1 = S, 2 = T
	const seedPos = seedY * width + seedX;

	// One queue buffer shared by both floods and the corridor BFS below —
	// each phase admits a cell at most once, so `size` slots suffice and the
	// hot loops allocate nothing per cell.
	const queue = new Int32Array(size);

	const flood = (starts: number[], mark: 1 | 2): void => {
		let head = 0;
		let tail = 0;
		const visit = (n: number): void => {
			if (label[n] === 0 && fillable[n] === 1 && dist[n] > bottleneck) {
				label[n] = mark;
				queue[tail++] = n;
			}
		};
		for (const s of starts) {
			visit(s);
		}
		while (head < tail) {
			const pos = queue[head++];
			const x = pos % width;
			const y = (pos - x) / width;
			if (x > 0) visit(pos - 1);
			if (x < width - 1) visit(pos + 1);
			if (y > 0) visit(pos - width);
			if (y < height - 1) visit(pos + width);
		}
	};

	flood([seedPos], 1);
	// Degenerate: the seed area itself is no wider than the bottleneck —
	// the whole region is the passage.
	if (label[seedPos] !== 1) return { x: seedX, y: seedY };

	flood(escapeSpec.targetStarts(), 2);

	// Corridor BFS through {dist ≤ B} from every cell adjacent to S
	const parent = new Int32Array(size).fill(-2); // -2 = unvisited, -1 = root
	let head = 0;
	let tail = 0;
	for (let pos = 0; pos < size; pos++) {
		if (fillable[pos] === 0 || dist[pos] > bottleneck) continue;
		const x = pos % width;
		const y = (pos - x) / width;
		const nearS =
			(x > 0 && label[pos - 1] === 1) ||
			(x < width - 1 && label[pos + 1] === 1) ||
			(y > 0 && label[pos - width] === 1) ||
			(y < height - 1 && label[pos + width] === 1);
		if (nearS) {
			parent[pos] = -1;
			queue[tail++] = pos;
		}
	}

	const enqueue = (n: number, from: number): void => {
		if (parent[n] === -2 && fillable[n] === 1 && dist[n] <= bottleneck) {
			parent[n] = from;
			queue[tail++] = n;
		}
	};
	while (head < tail) {
		const pos = queue[head++];
		const x = pos % width;
		const y = (pos - x) / width;
		const nearT =
			escapeSpec.isEscape(pos, x, y) ||
			(x > 0 && label[pos - 1] === 2) ||
			(x < width - 1 && label[pos + 1] === 2) ||
			(y > 0 && label[pos - width] === 2) ||
			(y < height - 1 && label[pos + width] === 2);
		if (nearT) {
			// Crossing found: the widest cell on the chain is the passage center
			let best = pos;
			for (let p: number = pos; p !== -1; p = parent[p]) {
				if (dist[p] > dist[best]) best = p;
			}
			const bx = best % width;
			return { x: bx, y: (best - bx) / width };
		}
		if (x > 0) enqueue(pos - 1, pos);
		if (x < width - 1) enqueue(pos + 1, pos);
		if (y > 0) enqueue(pos - width, pos);
		if (y < height - 1) enqueue(pos + width, pos);
	}

	// No crossing found (should not happen when an escape exists)
	return { x: seedX, y: seedY };
}

/**
 * Virtually seal a located leak. The seal is what the committed
 * "seal and fill" edge looks like, so prefer a straight chord between the
 * two barrier walls flanking the passage — the natural continuation of the
 * line art — and fall back to a disc when no flanking pair exists.
 * Returns the newly stamped barrier positions for incremental chamfer
 * relaxation.
 */
function sealLeak(
	fillable: Uint8Array,
	width: number,
	height: number,
	cx: number,
	cy: number,
	gapHalfPx: number,
): number[] {
	const searchRadius = Math.ceil(gapHalfPx) + 4;
	const p1 = nearestBarrier(
		fillable,
		width,
		height,
		cx,
		cy,
		searchRadius,
		null,
	);
	const p2 = p1
		? nearestBarrier(fillable, width, height, cx, cy, searchRadius, p1)
		: null;
	if (!p1 || !p2) {
		return stampBarrierDisc(
			fillable,
			width,
			height,
			cx,
			cy,
			Math.ceil(gapHalfPx) + 2,
		);
	}
	return stampBarrierLine(fillable, width, height, p1, p2);
}

/**
 * Incrementally update a chamfer distance field after new barrier pixels
 * were stamped. Distances can only decrease, so a FIFO relaxation seeded at
 * the stamped cells converges to exactly the field a full recompute would
 * produce, while touching only the neighbourhood the seal actually changed.
 */
function relaxChamferForNewBarriers(
	dist: Uint16Array,
	width: number,
	height: number,
	stamped: number[],
): void {
	const queue: number[] = [];
	for (const pos of stamped) {
		if (dist[pos] !== 0) {
			dist[pos] = 0;
			queue.push(pos);
		}
	}
	const relax = (n: number, nd: number): void => {
		if (nd < dist[n]) {
			dist[n] = nd;
			queue.push(n);
		}
	};
	let head = 0;
	while (head < queue.length) {
		const pos = queue[head++];
		const x = pos % width;
		const y = (pos - x) / width;
		const d = dist[pos];
		if (x > 0) relax(pos - 1, d + CHAMFER_ORTHO);
		if (x < width - 1) relax(pos + 1, d + CHAMFER_ORTHO);
		if (y > 0) {
			relax(pos - width, d + CHAMFER_ORTHO);
			if (x > 0) relax(pos - width - 1, d + CHAMFER_DIAG);
			if (x < width - 1) relax(pos - width + 1, d + CHAMFER_DIAG);
		}
		if (y < height - 1) {
			relax(pos + width, d + CHAMFER_ORTHO);
			if (x > 0) relax(pos + width - 1, d + CHAMFER_DIAG);
			if (x < width - 1) relax(pos + width + 1, d + CHAMFER_DIAG);
		}
	}
}

/**
 * Nearest barrier pixel within a box around (cx, cy). With `oppositeTo`, only
 * pixels in the half-plane opposite to that point qualify — used to find the
 * wall on the other side of a passage.
 */
function nearestBarrier(
	fillable: Uint8Array,
	width: number,
	height: number,
	cx: number,
	cy: number,
	radius: number,
	oppositeTo: { x: number; y: number } | null,
): { x: number; y: number } | null {
	const x0 = Math.max(0, cx - radius);
	const x1 = Math.min(width - 1, cx + radius);
	const y0 = Math.max(0, cy - radius);
	const y1 = Math.min(height - 1, cy + radius);
	let best: { x: number; y: number } | null = null;
	let bestD = Infinity;
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			if (fillable[y * width + x] !== 0) continue;
			const dx = x - cx;
			const dy = y - cy;
			if (
				oppositeTo &&
				dx * (oppositeTo.x - cx) + dy * (oppositeTo.y - cy) > 0
			) {
				continue;
			}
			const d = dx * dx + dy * dy;
			if (d < bestD) {
				bestD = d;
				best = { x, y };
			}
		}
	}
	return best;
}

/** Stamp a 3px-thick barrier line (fillable → 0) between two pixels.
 *  Returns the positions newly turned into barriers. */
function stampBarrierLine(
	fillable: Uint8Array,
	width: number,
	height: number,
	p1: { x: number; y: number },
	p2: { x: number; y: number },
): number[] {
	const stamped: number[] = [];
	const steps = Math.max(Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y), 1);
	for (let s = 0; s <= steps; s++) {
		const cx = Math.round(p1.x + ((p2.x - p1.x) * s) / steps);
		const cy = Math.round(p1.y + ((p2.y - p1.y) * s) / steps);
		for (let y = Math.max(0, cy - 1); y <= Math.min(height - 1, cy + 1); y++) {
			for (let x = Math.max(0, cx - 1); x <= Math.min(width - 1, cx + 1); x++) {
				const idx = y * width + x;
				if (fillable[idx] === 1) {
					fillable[idx] = 0;
					stamped.push(idx);
				}
			}
		}
	}
	return stamped;
}

/** Stamp a barrier disc (fillable → 0) used to virtually seal a found leak.
 *  Returns the positions newly turned into barriers. */
function stampBarrierDisc(
	fillable: Uint8Array,
	width: number,
	height: number,
	cx: number,
	cy: number,
	radius: number,
): number[] {
	const stamped: number[] = [];
	const r2 = radius * radius;
	const x0 = Math.max(0, cx - radius);
	const x1 = Math.min(width - 1, cx + radius);
	const y0 = Math.max(0, cy - radius);
	const y1 = Math.min(height - 1, cy + radius);
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			const dx = x - cx;
			const dy = y - cy;
			if (dx * dx + dy * dy > r2) continue;
			const idx = y * width + x;
			if (fillable[idx] === 1) {
				fillable[idx] = 0;
				stamped.push(idx);
			}
		}
	}
	return stamped;
}

/** Plain 4-connected BFS fill over the (sealed) fillable mask. */
function floodFillFillable(
	fillable: Uint8Array,
	width: number,
	height: number,
	seedX: number,
	seedY: number,
): Uint8Array {
	const size = width * height;
	const mask = new Uint8Array(size);
	const seedPos = seedY * width + seedX;
	if (fillable[seedPos] === 0) return mask;

	const queue = new Int32Array(size);
	let head = 0;
	let tail = 0;
	queue[tail++] = seedPos;
	mask[seedPos] = 1;
	const visit = (n: number): void => {
		if (fillable[n] === 1 && mask[n] === 0) {
			mask[n] = 1;
			queue[tail++] = n;
		}
	};
	while (head < tail) {
		const pos = queue[head++];
		const x = pos % width;
		const y = (pos - x) / width;
		if (x > 0) visit(pos - 1);
		if (x < width - 1) visit(pos + 1);
		if (y > 0) visit(pos - width);
		if (y < height - 1) visit(pos + width);
	}
	return mask;
}
