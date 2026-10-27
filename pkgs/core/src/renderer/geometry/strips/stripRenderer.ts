import { growInt32, growUint32, LineArena } from "./lineArena";
import {
	type ClipRect,
	LOCATION_FIELDS,
	LOCATION_U32S,
	type StripBatch,
	TILE_SIZE,
} from "./stripTypes";
import { TileArena, tileLines } from "./tiler";

/**
 * Read once: dev builds and vitest turn each use of an imported binding into
 * a property read, which dominated these loops.
 */
const TILE = TILE_SIZE;

interface RasterizeOptions {
	/**
	 * Emit fully covered gaps as dense locations instead of fill-gap spans,
	 * so every covered pixel owns a slot that per-pixel params can use.
	 */
	denseOnly: boolean;
}

/**
 * Lays out clipped device-space lines as sparse strips; the coverage kernels
 * integrate the alphas on the GPU.
 *
 * Lines are appended through `lines` relative to the clip origin, then
 * `rasterize` tiles them, sorts the tiles row-major, and walks each tile row.
 * Every tile a line touches becomes a location of TILE_SIZE alpha slots, and
 * runs of adjacent locations become strips. Between runs the walk follows the
 * winding of the band's first pixel row only: it decides whether a gap is
 * covered, the same rule the backdrop kernel applies to its per-row windings.
 * Scratch storage is reused across calls; the returned batch is a compact copy.
 */
export class StripRasterizer {
	public readonly lines = new LineArena();
	private readonly tiles = new TileArena();
	private strips = new Int32Array(4 * 256);
	private slots = new Uint32Array(256);
	private stripCount = 0;
	private locations = new Uint32Array(LOCATION_U32S * 1024);
	private locationCount = 0;
	private bands = new Uint32Array(2 * 256);
	private bandCount = 0;
	private slotCount = 0;
	private stripOpen = false;
	private stripX = 0;
	private stripY = 0;
	private stripSlot = 0;
	private stripDense = 0;
	private minX = 0;
	private minY = 0;
	private maxX = 0;
	private maxY = 0;

	public rasterize(clip: ClipRect, options: RasterizeOptions): StripBatch {
		const tileColumns = Math.max(1, Math.ceil((clip.x1 - clip.x0) / TILE));
		const tileRows = Math.max(1, Math.ceil((clip.y1 - clip.y0) / TILE));
		this.tiles.reset();
		tileLines(this.lines, this.tiles, tileColumns, tileRows);
		this.tiles.sort();
		this.stripCount = 0;
		this.locationCount = 0;
		this.bandCount = 0;
		this.slotCount = 0;
		this.stripOpen = false;
		this.minX = Infinity;
		this.minY = Infinity;
		this.maxX = -Infinity;
		this.maxY = -Infinity;
		this.layoutTiles(clip, options.denseOnly);

		const count = this.stripCount;
		const batch: StripBatch = {
			strips: this.strips.slice(0, count * 4),
			slots: this.slots.slice(0, count),
			stripCount: count,
			slotCount: this.slotCount,
			lines: this.packLines(),
			entries: this.tiles.lines.slice(0, this.tiles.count),
			locations: this.locations.slice(0, this.locationCount * LOCATION_U32S),
			locationCount: this.locationCount,
			bands: this.bands.slice(0, this.bandCount * 2),
			bandCount: this.bandCount,
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
		this.lines.reset();
		return batch;
	}

	private layoutTiles(clip: ClipRect, denseOnly: boolean): void {
		const tiles = this.tiles;
		const lines = this.lines;
		const clipWidth = clip.x1 - clip.x0;
		let curTx = -1;
		let curTy = -1;
		let winding = 0;

		for (let i = 0; i <= tiles.count; i++) {
			const atEnd = i === tiles.count;
			const key = atEnd ? 0 : tiles.keys[i];
			const tx = key & 0xffff;
			const ty = key >>> 16;

			if (atEnd || tx !== curTx || ty !== curTy) {
				if (atEnd) {
					this.closeBand(clip, clipWidth, winding, denseOnly, curTy, i);
					break;
				}
				if (ty !== curTy) {
					if (curTy >= 0) {
						this.closeBand(clip, clipWidth, winding, denseOnly, curTy, i);
					}
					winding = 0;
					this.openBand();
				} else if (tx !== curTx + 1) {
					const gapWinding = Math.round(winding);
					if (gapWinding !== 0 && denseOnly) {
						this.fillGap(curTx + 1, tx, ty, i);
					} else {
						this.closeStrip(
							clip,
							gapWinding !== 0 ? tx * TILE - this.stripX : this.stripDense,
						);
					}
					winding = gapWinding;
				}

				curTx = tx;
				curTy = ty;
				if (!this.stripOpen) {
					this.stripOpen = true;
					this.stripX = tx * TILE;
					this.stripY = ty * TILE;
					this.stripSlot = this.slotCount;
					this.stripDense = 0;
				}
				this.pushLocation(tx, ty, i);
			}

			const line = tiles.lines[i];
			winding += rowZeroCarry(
				lines.xs0[line] - tx * TILE,
				lines.ys0[line] - ty * TILE,
				lines.xs1[line] - tx * TILE,
				lines.ys1[line] - ty * TILE,
			);
		}
	}

	/**
	 * Geometry right of the clip is dropped, so a band can end with winding
	 * still open; everything up to the clip edge is then covered. `entry` is
	 * the first entry after the band: the fill locations start there, so the
	 * band's last tile ends its entries there too.
	 */
	private closeBand(
		clip: ClipRect,
		clipWidth: number,
		winding: number,
		denseOnly: boolean,
		ty: number,
		entry: number,
	): void {
		if (!this.stripOpen) return;
		const bandWinding = Math.round(winding);
		if (bandWinding !== 0 && denseOnly) {
			const from = (this.stripX + this.stripDense) / TILE;
			this.fillGap(from, clipWidth / TILE, ty, entry);
		}
		this.closeStrip(
			clip,
			bandWinding !== 0 ? clipWidth - this.stripX : this.stripDense,
		);
		const band = (this.bandCount - 1) * 2;
		this.bands[band + 1] = this.locationCount - this.bands[band];
	}

	private openBand(): void {
		if (this.bandCount * 2 === this.bands.length) {
			this.bands = growUint32(this.bands, this.bands.length * 2);
		}
		this.bands[this.bandCount * 2] = this.locationCount;
		this.bands[this.bandCount * 2 + 1] = 0;
		this.bandCount++;
	}

	/** Covered gap tiles `[fromTx, toTx)` join the open strip as dense locations. */
	private fillGap(fromTx: number, toTx: number, ty: number, entry: number) {
		for (let tx = fromTx; tx < toTx; tx++) {
			this.pushLocation(tx, ty, entry);
		}
	}

	/** Append a location whose entries start at `entryStart`. */
	private pushLocation(tx: number, ty: number, entryStart: number): void {
		if ((this.locationCount + 1) * LOCATION_U32S > this.locations.length) {
			this.locations = growUint32(this.locations, this.locations.length * 2);
		}
		const at = this.locationCount++ * LOCATION_U32S;
		this.locations[at + LOCATION_FIELDS.tile] = tx | (ty << 16);
		this.locations[at + LOCATION_FIELDS.entryStart] = entryStart;
		this.slotCount += TILE;
		this.stripDense += TILE;
	}

	private closeStrip(clip: ClipRect, width: number): void {
		if (!this.stripOpen) return;
		this.stripOpen = false;
		if (this.stripCount * 4 === this.strips.length) {
			this.strips = growInt32(this.strips, this.strips.length * 2);
			this.slots = growUint32(this.slots, this.slots.length * 2);
		}
		const x = this.stripX + clip.x0;
		const y = this.stripY + clip.y0;
		const i = this.stripCount++;
		this.strips[i * 4] = x;
		this.strips[i * 4 + 1] = y;
		this.strips[i * 4 + 2] = width;
		this.strips[i * 4 + 3] = this.stripDense;
		this.slots[i] = this.stripSlot;
		if (x < this.minX) this.minX = x;
		if (y < this.minY) this.minY = y;
		if (x + width > this.maxX) this.maxX = x + width;
		if (y + TILE > this.maxY) this.maxY = y + TILE;
	}

	/** Interleave the arena's lines as x0, y0, x1, y1 for the GPU. */
	private packLines(): Float32Array {
		const lines = this.lines;
		const packed = new Float32Array(lines.count * 4);
		for (let i = 0; i < lines.count; i++) {
			packed[i * 4] = lines.xs0[i];
			packed[i * 4 + 1] = lines.ys0[i];
			packed[i * 4 + 2] = lines.xs1[i];
			packed[i * 4 + 3] = lines.ys1[i];
		}
		return packed;
	}
}

/**
 * Winding a line (tile-local coordinates) carries past the tile's right edge
 * in the first pixel row: its vertical extent there between x = 0 and
 * x = TILE_SIZE, signed upward-positive. A vertical line on the left edge
 * belongs to the tile, so an edge position resolves to the row's top.
 */
function rowZeroCarry(x0: number, y0: number, x1: number, y1: number): number {
	if (y0 === y1) return 0;
	const sign = y0 > y1 ? 1 : -1;
	const topY = y0 < y1 ? y0 : y1;
	const topX = y0 < y1 ? x0 : x1;
	const bottomY = y0 < y1 ? y1 : y0;
	const bottomX = y0 < y1 ? x1 : x0;
	const yMin = topY > 0 ? topY : 0;
	const yMax = bottomY < 1 ? bottomY : 1;
	if (yMin >= yMax) return 0;
	const ySlope = (bottomY - topY) / (bottomX - topX);
	let yLeft = -topX * ySlope + topY;
	if (!(yLeft > yMin)) yLeft = yMin;
	if (yLeft > yMax) yLeft = yMax;
	let yRight = (TILE - topX) * ySlope + topY;
	if (!(yRight > yMin)) yRight = yMin;
	if (yRight > yMax) yRight = yMax;
	return Math.abs(yRight - yLeft) * sign;
}
