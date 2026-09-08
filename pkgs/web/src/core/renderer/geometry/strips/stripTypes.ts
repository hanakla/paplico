import type { Viewport } from "../../../schema";

/** Tile edge in device pixels; also the strip height. */
export const TILE_SIZE = 4;

/** Texel space of one render pass: the viewport that maps world to it and its size. */
export interface RasterFrame {
	viewport: Viewport;
	width: number;
	height: number;
}

/** Local → device-pixel affine: `x' = a·x + c·y + e`, `y' = b·x + d·y + f` (y down). */
export interface DeviceTransform {
	a: number;
	b: number;
	c: number;
	d: number;
	e: number;
	f: number;
}

/** Half-open pixel rectangle `[x0, x1) × [y0, y1)`; `x0`/`y0` are multiples of TILE_SIZE. */
export interface ClipRect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/**
 * Coverage of one outline as horizontal strips of TILE_SIZE rows.
 *
 * A pixel slot is one pixel column of a strip band: 4 alphas, one per row.
 * A strip's dense region is `denseWidth` consecutive slots from `slots[i]`;
 * pixels past the dense region up to `width` are fully covered.
 * Coordinates are relative to the generation anchor; `y` is a multiple of TILE_SIZE.
 */
export interface StripBatch {
	/** 4 ints per strip: x, y, width, denseWidth. */
	strips: Int32Array;
	/** First pixel slot per strip. */
	slots: Uint32Array;
	stripCount: number;
	/** 4 bytes per slot: `alphas[slot * 4 + row]`. */
	alphas: Uint8Array;
	slotCount: number;
	/** 8 bytes per slot: `params[slot * 8 + row * 2]` = t, `+1` = u. Null unless requested. */
	params: Uint8Array | null;
	/** Device-pixel bounds of the emitted strips, anchor-relative. */
	bounds: { minX: number; minY: number; maxX: number; maxY: number };
}
