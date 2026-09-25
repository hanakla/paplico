/** A blit quad's corners, ordered TL → TR → BR → BL. */
export type QuadCorners = readonly [
	{ x: number; y: number },
	{ x: number; y: number },
	{ x: number; y: number },
	{ x: number; y: number },
];

/**
 * Per-corner homogeneous weights that turn a quad blit's bilinear UV
 * interpolation into a projective one.
 *
 * A GPU interpolates a varying linearly across each of the quad's two
 * triangles, which bends straight lines in the source image whenever the quad
 * is not a parallelogram (a rotated 3D solid's projected footprint, an image
 * warped by a 3d-rotate filter). Scaling the UV by `q` per corner and dividing
 * by the interpolated `q` in the fragment shader restores the projective
 * mapping: `q` is the reciprocal of the corner's normalized distance along its
 * diagonal to the diagonals' intersection.
 *
 * Returns `[1, 1, 1, 1]` (plain bilinear) for degenerate or non-convex quads,
 * where the diagonals do not cross strictly inside the quad and the correction
 * is undefined.
 */
export function computeQuadProjectiveWeights(
	corners: QuadCorners,
): [number, number, number, number] {
	const [tl, tr, br, bl] = corners;
	const acX = br.x - tl.x;
	const acY = br.y - tl.y;
	const bdX = bl.x - tr.x;
	const bdY = bl.y - tr.y;
	const originX = tr.x - tl.x;
	const originY = tr.y - tl.y;
	const det = cross(acX, acY, bdX, bdY);

	if (Math.abs(det) < 1e-9) return [1, 1, 1, 1];

	const diagonalT = cross(originX, originY, bdX, bdY) / det;
	const otherDiagonalT = cross(originX, originY, acX, acY) / det;

	if (
		diagonalT <= 1e-6 ||
		diagonalT >= 1 - 1e-6 ||
		otherDiagonalT <= 1e-6 ||
		otherDiagonalT >= 1 - 1e-6
	) {
		return [1, 1, 1, 1];
	}

	return [
		1 / (1 - diagonalT),
		1 / (1 - otherDiagonalT),
		1 / diagonalT,
		1 / otherDiagonalT,
	];
}

/** The axis-aligned rectangle's corners in quad order (TL → TR → BR → BL). */
export function quadOfBounds(bounds: {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}): QuadCorners {
	return [
		{ x: bounds.minX, y: bounds.maxY },
		{ x: bounds.maxX, y: bounds.maxY },
		{ x: bounds.maxX, y: bounds.minY },
		{ x: bounds.minX, y: bounds.minY },
	];
}

function cross(ax: number, ay: number, bx: number, by: number): number {
	return ax * by - ay * bx;
}
