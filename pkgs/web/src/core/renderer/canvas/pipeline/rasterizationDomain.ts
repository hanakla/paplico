import type { BoundingBox } from "../../../schema";

/**
 * Fixed-R rasterization domain (design §9, appendix B-2).
 *
 * Paths that read neighboring texels (wet-ink seeding/diffusion, wet-edge
 * erosion/blur, mix-pass footprints) must rasterize at a resolution derived
 * from the stroke itself — never from the viewport zoom or export scale —
 * so the result stays a pure function of (content, settings). The domain is
 * bounded by the device texture limit and splits into overlapping tiles
 * when a stroke outgrows a single texture.
 */

const MAX_SIMULATION_WORLD_PER_TEXEL = 1;
const SIMULATION_TEXELS_PER_BRUSH_SIZE = 96;
const MIN_SIMULATION_WORLD_PER_TEXEL = 0.125;
const MAX_SIMULATION_TEXTURE_SIDE = 2048;
const TILE_OVERLAP_TEXELS = 48;

export type SimulationDomainTile = {
	worldOrigin: { x: number; y: number };
	textureSize: { width: number; height: number };
	innerOffset: { x: number; y: number };
	innerSize: { width: number; height: number };
};

/**
 * Resolve the fixed-R domain for `bounds`: world-per-texel follows the brush
 * size (96 texels per brush diameter, clamped to [0.125, 1]), zoom-free.
 */
export function resolveSimulationDomain(
	bounds: BoundingBox,
	brushSize: number,
	deviceMaxTextureSide: number,
): {
	tiles: SimulationDomainTile[];
	worldPerPixel: number;
} {
	const maxSide = Math.max(
		1,
		Math.min(MAX_SIMULATION_TEXTURE_SIDE, deviceMaxTextureSide),
	);
	const brushWorldPerPixel =
		Math.max(brushSize, 1) / SIMULATION_TEXELS_PER_BRUSH_SIZE;
	const worldPerPixel = Math.max(
		MIN_SIMULATION_WORLD_PER_TEXEL,
		Math.min(MAX_SIMULATION_WORLD_PER_TEXEL, brushWorldPerPixel),
	);
	const fullWidth = Math.max(1, Math.ceil(bounds.width / worldPerPixel));
	const fullHeight = Math.max(1, Math.ceil(bounds.height / worldPerPixel));

	if (fullWidth <= maxSide && fullHeight <= maxSide) {
		return {
			tiles: [
				{
					worldOrigin: { x: bounds.minX, y: bounds.maxY },
					textureSize: { width: fullWidth, height: fullHeight },
					innerOffset: { x: 0, y: 0 },
					innerSize: { width: fullWidth, height: fullHeight },
				},
			],
			worldPerPixel,
		};
	}

	const overlap = TILE_OVERLAP_TEXELS;
	const tileInner = Math.max(1, maxSide - 2 * overlap);
	const numTilesX = Math.max(1, Math.ceil(fullWidth / tileInner));
	const numTilesY = Math.max(1, Math.ceil(fullHeight / tileInner));
	const tiles: SimulationDomainTile[] = [];

	for (let ty = 0; ty < numTilesY; ty++) {
		for (let tx = 0; tx < numTilesX; tx++) {
			const innerStartX = tx * tileInner;
			const innerStartY = ty * tileInner;
			const innerW = Math.min(tileInner, fullWidth - innerStartX);
			const innerH = Math.min(tileInner, fullHeight - innerStartY);
			if (innerW <= 0 || innerH <= 0) continue;

			const padStartX = Math.max(0, innerStartX - overlap);
			const padStartY = Math.max(0, innerStartY - overlap);
			const padEndX = Math.min(fullWidth, innerStartX + innerW + overlap);
			const padEndY = Math.min(fullHeight, innerStartY + innerH + overlap);
			const texW = padEndX - padStartX;
			const texH = padEndY - padStartY;

			tiles.push({
				worldOrigin: {
					x: bounds.minX + padStartX * worldPerPixel,
					y: bounds.maxY - padStartY * worldPerPixel,
				},
				textureSize: { width: texW, height: texH },
				innerOffset: {
					x: innerStartX - padStartX,
					y: innerStartY - padStartY,
				},
				innerSize: { width: innerW, height: innerH },
			});
		}
	}

	return { tiles, worldPerPixel };
}
