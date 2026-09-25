/**
 * Brush stamp instances share one u32 between a path-meta index and a texture
 * array layer. Twenty-one meta bits cover every 64-byte stamp that can fit in
 * the store's 128 MiB hard budget; eleven layer bits cover 2,048 array layers.
 */
export const STAMP_META_INDEX_BITS = 21;
export const STAMP_META_INDEX_MASK = (1 << STAMP_META_INDEX_BITS) - 1;
export const STAMP_TEXTURE_LAYER_SHIFT = STAMP_META_INDEX_BITS;
export const STAMP_TEXTURE_LAYER_MASK =
	(0xffff_ffff << STAMP_TEXTURE_LAYER_SHIFT) >>> 0;

export function packStampPathIndex(
	pathIndex: number,
	textureLayer: number,
): number {
	return (
		((textureLayer << STAMP_TEXTURE_LAYER_SHIFT) & STAMP_TEXTURE_LAYER_MASK) |
		(pathIndex & STAMP_META_INDEX_MASK)
	);
}

export function replaceStampPathIndex(
	packed: number,
	pathIndex: number,
): number {
	return (
		(packed & STAMP_TEXTURE_LAYER_MASK) | (pathIndex & STAMP_META_INDEX_MASK)
	);
}
