import { clamp } from "../../../utils/math";
import { growUint32, type LineArena } from "./lineArena";
import { TILE_SIZE } from "./stripTypes";

const INSERTION_SORT_MAX = 64;
const RADIX_BITS = 8;
const RADIX_BUCKETS = 1 << RADIX_BITS;

/** Tile entries `(ty << 16 | tx, lineIndex)` in insertion order until sorted. */
export class TileArena {
	public keys = new Uint32Array(4096);
	public lines = new Uint32Array(4096);
	public count = 0;
	private scratchKeys = new Uint32Array(4096);
	private scratchLines = new Uint32Array(4096);
	private readonly histogram = new Uint32Array(RADIX_BUCKETS);

	public reset(): void {
		this.count = 0;
	}

	public push(key: number, line: number): void {
		if (this.count === this.keys.length) {
			const next = this.keys.length * 2;
			this.keys = growUint32(this.keys, next);
			this.lines = growUint32(this.lines, next);
			this.scratchKeys = new Uint32Array(next);
			this.scratchLines = new Uint32Array(next);
		}
		const i = this.count++;
		this.keys[i] = key;
		this.lines[i] = line;
	}

	/** Stable ascending sort by key, so entries run row by row and left to right. */
	public sort(): void {
		const n = this.count;
		if (n <= INSERTION_SORT_MAX) {
			this.insertionSort(n);
			return;
		}
		let keys = this.keys;
		let lines = this.lines;
		let outKeys = this.scratchKeys;
		let outLines = this.scratchLines;
		const hist = this.histogram;
		for (let shift = 0; shift < 32; shift += RADIX_BITS) {
			hist.fill(0);
			for (let i = 0; i < n; i++) hist[(keys[i] >>> shift) & 0xff]++;
			let sum = 0;
			for (let b = 0; b < RADIX_BUCKETS; b++) {
				const c = hist[b];
				hist[b] = sum;
				sum += c;
			}
			for (let i = 0; i < n; i++) {
				const k = keys[i];
				const dst = hist[(k >>> shift) & 0xff]++;
				outKeys[dst] = k;
				outLines[dst] = lines[i];
			}
			[keys, outKeys] = [outKeys, keys];
			[lines, outLines] = [outLines, lines];
		}
		this.keys = keys;
		this.lines = lines;
		this.scratchKeys = outKeys;
		this.scratchLines = outLines;
	}

	private insertionSort(n: number): void {
		const keys = this.keys;
		const lines = this.lines;
		for (let i = 1; i < n; i++) {
			const k = keys[i];
			const l = lines[i];
			let j = i - 1;
			while (j >= 0 && keys[j] > k) {
				keys[j + 1] = keys[j];
				lines[j + 1] = lines[j];
				j--;
			}
			keys[j + 1] = k;
			lines[j + 1] = l;
		}
	}
}

/**
 * Emit one tile entry for every TILE_SIZE² tile a line touches. Lines are in
 * clip-relative device pixels within `[0, tileColumns·4) × [0, tileRows·4)`.
 */
export function tileLines(
	lines: LineArena,
	tiles: TileArena,
	tileColumns: number,
	tileRows: number,
): void {
	const maxTx = tileColumns - 1;
	const maxTy = tileRows - 1;
	for (let i = 0; i < lines.count; i++) {
		const x0 = lines.xs0[i];
		const y0 = lines.ys0[i];
		const x1 = lines.xs1[i];
		const y1 = lines.ys1[i];
		if (y0 === y1) {
			// Carries no winding, but keeps per-row windings flowing through
			// the tiles it crosses. A line on the tile grid separates two bands
			// and touches neither.
			if (y0 % TILE_SIZE === 0) continue;
			const ty = clamp(Math.floor(y0 / TILE_SIZE), 0, maxTy);
			const left = Math.min(x0, x1);
			const right = Math.max(x0, x1);
			const txStart = clamp(Math.floor(left / TILE_SIZE), 0, maxTx);
			const txEnd = clamp(Math.ceil(right / TILE_SIZE) - 1, txStart, maxTx);
			for (let tx = txStart; tx <= txEnd; tx++) {
				tiles.push((ty << 16) | tx, i);
			}
			continue;
		}

		const topY = Math.min(y0, y1);
		const bottomY = Math.max(y0, y1);
		const tyStart = clamp(Math.floor(topY / TILE_SIZE), 0, maxTy);
		const tyEnd = clamp(Math.ceil(bottomY / TILE_SIZE) - 1, tyStart, maxTy);
		const xSlope = (x1 - x0) / (y1 - y0);

		for (let ty = tyStart; ty <= tyEnd; ty++) {
			const rowTop = Math.max(topY, ty * TILE_SIZE);
			const rowBottom = Math.min(bottomY, (ty + 1) * TILE_SIZE);
			const xa = x0 + (rowTop - y0) * xSlope;
			const xb = x0 + (rowBottom - y0) * xSlope;
			const left = Math.min(xa, xb);
			const right = Math.max(xa, xb);
			const txStart = clamp(Math.floor(left / TILE_SIZE), 0, maxTx);
			const txEnd = clamp(Math.ceil(right / TILE_SIZE) - 1, txStart, maxTx);
			for (let tx = txStart; tx <= txEnd; tx++) {
				tiles.push((ty << 16) | tx, i);
			}
		}
	}
}
