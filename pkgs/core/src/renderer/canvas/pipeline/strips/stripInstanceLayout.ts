/**
 * Vertex layouts shared by `StripFrame` (writer) and `strip.wgsl` (reader).
 * One instance draws one strip as a quad; a cache entry's strips stay
 * resident in its page, and each draw adds one draw record that every
 * instance of the draw reads (stride 0).
 *
 * Strip instance, per strip:
 *
 * | u32 | field                                                          |
 * | --- | -------------------------------------------------------------- |
 * | 0   | x — anchor-relative pixels, signed                             |
 * | 1   | y — anchor-relative pixels, signed                             |
 * | 2   | `width \| denseWidth << 16` — pixels; beyond `denseWidth` is alpha 1 |
 * | 3   | first alpha slot in the page                                   |
 *
 * Draw record, per draw:
 *
 * | u32 | field                                                       |
 * | --- | ----------------------------------------------------------- |
 * | 0-1 | anchor in pass pixels, signed                               |
 * | 2   | element transform slot                                      |
 * | 3   | flags (`STRIP_DRAW_HAS_PARAMS`)                             |
 * | 4-7 | straight RGBA paint colour; alpha carries the opacity multiplier |
 */
export const STRIP_INSTANCE_U32S = 4;
export const STRIP_INSTANCE_BYTES = STRIP_INSTANCE_U32S * 4;
export const STRIP_DRAW_U32S = 8;
export const STRIP_DRAW_BYTES = STRIP_DRAW_U32S * 4;

/** The draw's strips carry stroke gradient params. */
export const STRIP_DRAW_HAS_PARAMS = 1;

/**
 * Alpha pages are `2^STRIP_PAGE_WIDTH_BITS` texels wide; one texel holds one
 * slot, its four channels the slot's four rows. A params page has two texel
 * rows per alpha texel row: (t, u) of rows 0-1, then of rows 2-3.
 */
export const STRIP_PAGE_WIDTH_BITS = 12;
export const STRIP_PAGE_WIDTH = 1 << STRIP_PAGE_WIDTH_BITS;
export const STRIP_PARAMS_ROWS_PER_ALPHA_ROW = 2;

export const STRIP_INSTANCE_LAYOUT: GPUVertexBufferLayout = {
	arrayStride: STRIP_INSTANCE_BYTES,
	stepMode: "instance",
	attributes: [
		{ shaderLocation: 0, offset: 0, format: "sint32x2" },
		{ shaderLocation: 1, offset: 8, format: "uint32" },
		{ shaderLocation: 2, offset: 12, format: "uint32" },
	],
};

export const STRIP_DRAW_LAYOUT: GPUVertexBufferLayout = {
	arrayStride: 0,
	stepMode: "instance",
	attributes: [
		{ shaderLocation: 3, offset: 0, format: "sint32x2" },
		{ shaderLocation: 4, offset: 8, format: "uint32" },
		{ shaderLocation: 5, offset: 12, format: "uint32" },
		{ shaderLocation: 6, offset: 16, format: "float32x4" },
	],
};
