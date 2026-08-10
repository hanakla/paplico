/**
 * World Cell Hash WGSL - a stable per-cell random value on a world-space grid,
 * shared by the filters that scatter something across the canvas.
 *
 * Hashing the world cell rather than the pixel is what keeps a scattered
 * pattern anchored to the artwork: pan, zoom or a change of render scale move
 * the pixels but not the cells, so the pattern stays put instead of crawling.
 */
export const WORLD_CELL_HASH_WGSL = /* wgsl */ `
fn hash(p: vec2u, seed: u32) -> u32 {
	var state = p.x ^ (p.y << 8u) ^ seed;
	state = state ^ (state >> 16u);
	state = state * 0x45d9f3bu;
	state = state ^ (state >> 16u);
	state = state * 0x45d9f3bu;
	state = state ^ (state >> 16u);
	return state;
}

fn hashToFloat(h: u32) -> f32 {
	return f32(h) / 4294967295.0;
}

// Hashable cell index on a world-px grid. floor + i32->u32 bitcast stays
// bijective for negative world coordinates, which vec2u(floor(...)) would
// collapse to 0.
fn worldCell(pos: vec2f, cellSize: f32) -> vec2u {
	return bitcast<vec2u>(vec2i(floor(pos / cellSize)));
}
`;
