/**
 * Per-strip instance layout shared by `StripFrame` (writer) and
 * `strip.wgsl` (reader). One instance draws one strip as a quad.
 *
 * | u32 | field                                                            |
 * | --- | ---------------------------------------------------------------- |
 * | 0   | `x \| y << 16` — strip origin in pass pixels                     |
 * | 1   | `width \| denseWidth << 16` — pixels; beyond `denseWidth` is alpha 1 |
 * | 2   | first alpha slot                                                 |
 * | 3   | `paramsSlot (24 bits) \| rowOffset << 24 \| height << 26 \| hasParams << 31` |
 * | 4   | element transform slot                                           |
 * | 5-8 | straight RGBA paint colour; alpha carries the opacity multiplier |
 */
export const STRIP_INSTANCE_U32S = 9;
export const STRIP_INSTANCE_BYTES = STRIP_INSTANCE_U32S * 4;

export const STRIP_PARAMS_SLOT_MASK = 0x00ff_ffff;
export const STRIP_ROW_OFFSET_SHIFT = 24;
export const STRIP_HEIGHT_SHIFT = 26;
export const STRIP_HAS_PARAMS_BIT = 0x8000_0000;

/** Alpha and params pages are `2^STRIP_PAGE_WIDTH_BITS` texels wide. */
export const STRIP_PAGE_WIDTH_BITS = 12;
export const STRIP_PAGE_WIDTH = 1 << STRIP_PAGE_WIDTH_BITS;

export const STRIP_INSTANCE_LAYOUT: GPUVertexBufferLayout = {
	arrayStride: STRIP_INSTANCE_BYTES,
	stepMode: "instance",
	attributes: [
		{ shaderLocation: 0, offset: 0, format: "uint32" },
		{ shaderLocation: 1, offset: 4, format: "uint32" },
		{ shaderLocation: 2, offset: 8, format: "uint32" },
		{ shaderLocation: 3, offset: 12, format: "uint32" },
		{ shaderLocation: 4, offset: 16, format: "uint32" },
		{ shaderLocation: 5, offset: 20, format: "float32x4" },
	],
};
