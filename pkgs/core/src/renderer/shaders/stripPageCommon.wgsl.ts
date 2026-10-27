/**
 * Strip Page Common WGSL - where a strip slot lives in its page, shared by the
 * coverage kernels that write the pages and the strip shader that reads them.
 */

import {
	STRIP_PAGE_WIDTH,
	STRIP_PAGE_WIDTH_BITS,
	STRIP_PARAMS_ROWS_PER_ALPHA_ROW,
} from "../canvas/pipeline/strips/stripInstanceLayout";

export const STRIP_PAGE_COMMON_WGSL = /* wgsl */ `
const PAGE_WIDTH_BITS: u32 = ${STRIP_PAGE_WIDTH_BITS}u;
const PAGE_WIDTH_MASK: u32 = ${STRIP_PAGE_WIDTH - 1}u;

/** Alpha page texel holding a slot's four rows. */
fn slotTexel(slot: u32) -> vec2u {
	return vec2u(slot & PAGE_WIDTH_MASK, slot >> PAGE_WIDTH_BITS);
}

/** Params page texel holding (t, u) of a slot's row: rg for an even row, ba for the odd row after it. */
fn paramsTexel(slot: u32, row: u32) -> vec2u {
	let texel = slotTexel(slot);
	return vec2u(texel.x, texel.y * ${STRIP_PARAMS_ROWS_PER_ALPHA_ROW}u + (row >> 1u));
}
`;
