import { growInt32, growUint8, growUint32, LineArena } from "./lineArena";
import { type ClipRect, type StripBatch, TILE_SIZE } from "./stripTypes";
import { TileArena, tileLines } from "./tiler";

interface RasterizeOptions {
	/**
	 * Emit fully covered gaps as dense alpha-255 slots instead of fill-gap
	 * spans, so every covered pixel owns a slot that per-pixel params can use.
	 */
	denseOnly: boolean;
}

/**
 * Turns clipped device-space lines into strips of exact nonzero coverage.
 *
 * Lines are appended through `lines` relative to the clip origin, then
 * `rasterize` tiles them, sorts the tiles row-major, and walks each tile row
 * accumulating signed area per pixel (the font-rs / Vello "area + cover"
 * integration): a line's vertical extent inside a pixel adds a trapezoid to
 * that pixel and carries its full height to every pixel on its right.
 * Scratch storage is reused across calls; the returned batch is a compact copy.
 */
export class StripRasterizer {
	public readonly lines = new LineArena();
	private readonly tiles = new TileArena();
	private strips = new Int32Array(4 * 256);
	private slots = new Uint32Array(256);
	private stripCount = 0;
	private alphas = new Uint8Array(4 * 4096);
	private slotCount = 0;
	private readonly loc = new Float32Array(TILE_SIZE * TILE_SIZE);
	private readonly accum = new Float32Array(TILE_SIZE);
	private minX = 0;
	private minY = 0;
	private maxX = 0;
	private maxY = 0;

	public rasterize(clip: ClipRect, options: RasterizeOptions): StripBatch {
		const tileColumns = Math.max(1, Math.ceil((clip.x1 - clip.x0) / TILE_SIZE));
		const tileRows = Math.max(1, Math.ceil((clip.y1 - clip.y0) / TILE_SIZE));
		this.tiles.reset();
		tileLines(this.lines, this.tiles, tileColumns, tileRows);
		this.tiles.sort();
		this.stripCount = 0;
		this.slotCount = 0;
		this.minX = Infinity;
		this.minY = Infinity;
		this.maxX = -Infinity;
		this.maxY = -Infinity;
		this.renderTiles(clip, options.denseOnly);
		this.lines.reset();

		const count = this.stripCount;
		return {
			strips: this.strips.slice(0, count * 4),
			slots: this.slots.slice(0, count),
			stripCount: count,
			alphas: this.alphas.slice(0, this.slotCount * 4),
			slotCount: this.slotCount,
			params: null,
			bounds:
				count === 0
					? { minX: 0, minY: 0, maxX: 0, maxY: 0 }
					: {
							minX: this.minX,
							minY: this.minY,
							maxX: this.maxX,
							maxY: this.maxY,
						},
		};
	}

	private renderTiles(clip: ClipRect, denseOnly: boolean): void {
		const tiles = this.tiles;
		const lines = this.lines;
		const loc = this.loc;
		const accum = this.accum;
		accum.fill(0);

		let curTx = -1;
		let curTy = -1;
		let locSlot = 0;
		let stripOpen = false;
		let stripX = 0;
		let stripY = 0;
		let stripSlot = 0;
		let stripDense = 0;

		const clipWidth = clip.x1 - clip.x0;

		const closeStrip = (width: number): void => {
			if (!stripOpen) return;
			this.pushStrip(
				stripX + clip.x0,
				stripY + clip.y0,
				width,
				stripDense,
				stripSlot,
			);
			stripOpen = false;
		};

		// Geometry right of the clip is dropped, so a band can end with winding
		// still open; everything up to the clip edge is then covered.
		const closeBand = (): void => {
			const winding = Math.round(accum[0]);
			if (winding !== 0 && denseOnly) {
				const gapSlots = clipWidth - (stripX + stripDense);
				if (gapSlots > 0) {
					this.fillSlots(gapSlots);
					stripDense += gapSlots;
				}
			}
			closeStrip(winding !== 0 ? clipWidth - stripX : stripDense);
		};

		for (let i = 0; i <= tiles.count; i++) {
			const atEnd = i === tiles.count;
			const key = atEnd ? 0 : tiles.keys[i];
			const tx = key & 0xffff;
			const ty = key >>> 16;

			if (atEnd || tx !== curTx || ty !== curTy) {
				if (curTx >= 0) this.flushLocation(locSlot);
				if (atEnd) {
					closeBand();
					break;
				}

				if (ty !== curTy) {
					closeBand();
					accum.fill(0);
				} else if (tx !== curTx + 1) {
					const gapWinding = Math.round(accum[0]);
					if (gapWinding !== 0 && denseOnly) {
						const gapSlots = (tx - curTx - 1) * TILE_SIZE;
						this.fillSlots(gapSlots);
						stripDense += gapSlots;
					} else {
						closeStrip(gapWinding !== 0 ? tx * TILE_SIZE - stripX : stripDense);
					}
					accum.fill(gapWinding);
				}

				curTx = tx;
				curTy = ty;
				for (let r = 0; r < TILE_SIZE; r++) {
					const w = accum[r];
					loc[r * TILE_SIZE] = w;
					loc[r * TILE_SIZE + 1] = w;
					loc[r * TILE_SIZE + 2] = w;
					loc[r * TILE_SIZE + 3] = w;
				}
				if (!stripOpen) {
					stripOpen = true;
					stripX = tx * TILE_SIZE;
					stripY = ty * TILE_SIZE;
					stripSlot = this.slotCount;
					stripDense = 0;
				}
				this.ensureSlots(TILE_SIZE);
				locSlot = this.slotCount;
				this.slotCount += TILE_SIZE;
				stripDense += TILE_SIZE;
			}

			const line = tiles.lines[i];
			this.accumulateLine(
				lines.xs0[line] - tx * TILE_SIZE,
				lines.ys0[line] - ty * TILE_SIZE,
				lines.xs1[line] - tx * TILE_SIZE,
				lines.ys1[line] - ty * TILE_SIZE,
			);
		}
	}

	/** Add one line's signed area to the open tile location (tile-local coordinates). */
	private accumulateLine(x0: number, y0: number, x1: number, y1: number): void {
		if (y0 === y1) return;
		const loc = this.loc;
		const accum = this.accum;
		// Upward lines (decreasing y) add winding, downward lines subtract.
		const sign = y0 > y1 ? 1 : -1;
		let topY: number;
		let topX: number;
		let bottomY: number;
		let bottomX: number;
		if (y0 < y1) {
			topY = y0;
			topX = x0;
			bottomY = y1;
			bottomX = x1;
		} else {
			topY = y1;
			topX = x1;
			bottomY = y0;
			bottomX = x0;
		}
		const ySlope = (bottomY - topY) / (bottomX - topX);
		const xSlope = 1 / ySlope;
		const baseYX = topX - topY * xSlope;

		for (let r = 0; r < TILE_SIZE; r++) {
			const yMin = Math.max(topY, r);
			const yMax = Math.min(bottomY, r + 1);
			if (yMin >= yMax) continue;
			let acc = 0;
			for (let c = 0; c < TILE_SIZE; c++) {
				// Vertical lines make the slope infinite; a pixel edge on the
				// line itself yields NaN, which must resolve to yMin so the line
				// belongs to the pixel on whose left edge it sits.
				let yL = (c - topX) * ySlope + topY;
				if (!(yL > yMin)) yL = yMin;
				if (yL > yMax) yL = yMax;
				let yR = (c + 1 - topX) * ySlope + topY;
				if (!(yR > yMin)) yR = yMin;
				if (yR > yMax) yR = yMax;
				const xL = yL * xSlope + baseYX;
				const xR = yR * xSlope + baseYX;
				const h = Math.abs(yR - yL);
				const area = h * (c + 1 - 0.5 * (xR + xL));
				loc[r * TILE_SIZE + c] += area * sign + acc;
				acc += h * sign;
			}
			accum[r] += acc;
		}
	}

	private flushLocation(slot: number): void {
		const loc = this.loc;
		const alphas = this.alphas;
		for (let c = 0; c < TILE_SIZE; c++) {
			const base = (slot + c) * 4;
			for (let r = 0; r < TILE_SIZE; r++) {
				const v = Math.abs(loc[r * TILE_SIZE + c]) * 255 + 0.5;
				alphas[base + r] = v > 255 ? 255 : v;
			}
		}
	}

	/** Append fully covered slots. */
	private fillSlots(count: number): void {
		this.ensureSlots(count);
		this.alphas.fill(255, this.slotCount * 4, (this.slotCount + count) * 4);
		this.slotCount += count;
	}

	private ensureSlots(add: number): void {
		const needed = (this.slotCount + add) * 4;
		if (needed <= this.alphas.length) return;
		let next = this.alphas.length * 2;
		while (next < needed) next *= 2;
		this.alphas = growUint8(this.alphas, next);
	}

	private pushStrip(
		x: number,
		y: number,
		width: number,
		denseWidth: number,
		slot: number,
	): void {
		if (this.stripCount * 4 === this.strips.length) {
			this.strips = growInt32(this.strips, this.strips.length * 2);
			this.slots = growUint32(this.slots, this.slots.length * 2);
		}
		const i = this.stripCount++;
		this.strips[i * 4] = x;
		this.strips[i * 4 + 1] = y;
		this.strips[i * 4 + 2] = width;
		this.strips[i * 4 + 3] = denseWidth;
		this.slots[i] = slot;
		if (x < this.minX) this.minX = x;
		if (y < this.minY) this.minY = y;
		if (x + width > this.maxX) this.maxX = x + width;
		if (y + TILE_SIZE > this.maxY) this.maxY = y + TILE_SIZE;
	}
}
