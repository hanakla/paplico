import type { Viewport } from "../../../schema";

/** Tile edge in device pixels; also the strip height. */
export const TILE_SIZE = 4;

/**
 * u32 offsets of one tile location in `StripBatch.locations`, shared by
 * `StripRasterizer` and `binStrokeParams` (writers) and the coverage kernels
 * (reader), whose `Location` struct is generated from this table. Indices
 * stay batch-local; the kernels add the batch's bases.
 *
 * A location's entries run up to the next location's `entryStart`, or to the
 * end of the batch's entries for its last location; its triangle entries end
 * the same way. A location without entries is a covered gap tile, whose
 * coverage is the winding carried into it. Its TILE_SIZE alpha slots follow
 * those of the previous location, so they come from its index.
 */
export const LOCATION_FIELDS = {
	/** `tx | ty << 16` — tile, clip-relative. */
	tile: 0,
	/** First entry in `entries`. */
	entryStart: 1,
	/** First triangle entry, set by `binStrokeParams`. */
	triStart: 2,
} as const;
export const LOCATION_U32S = Object.keys(LOCATION_FIELDS).length;

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
 * Strip layout of one outline plus the work the GPU needs to integrate its
 * coverage.
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
	slotCount: number;
	/** Clip-relative lines, 4 floats each: x0, y0, x1, y1. */
	lines: Float32Array;
	/** Line index per tile entry; a location's entries are contiguous. */
	entries: Uint32Array;
	/** `LOCATION_U32S` per location, row-major and left to right. */
	locations: Uint32Array;
	locationCount: number;
	/** 2 per band (one tile row): first location, location count. */
	bands: Uint32Array;
	bandCount: number;
	/** Stroke gradient inputs binned to the locations; null unless requested. */
	params: StrokeParamsBins | null;
	/** Device-pixel bounds of the emitted strips, anchor-relative. */
	bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Stroke triangles and the locations they reach, for the params kernel. */
interface StrokeParamsBins {
	/**
	 * 12 floats per triangle, clip-relative:
	 * x0 y0 x1 y1 | x2 y2 t0 u0 | t1 u1 t2 u2.
	 */
	triangles: Float32Array;
	/** Triangle index per (location, triangle) pair, grouped by location in triangle order. */
	entries: Uint32Array;
}
