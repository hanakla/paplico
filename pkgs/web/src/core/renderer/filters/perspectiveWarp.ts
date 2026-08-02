/**
 * Perspective-warp math (CLIP STUDIO「自由変形」/ Illustrator Free Distort
 * equivalent) — pure homography functions, no filter registration.
 *
 * A 3x3 homography H maps four source corners onto four dragged corners with
 * real perspective foreshortening — something an affine transform cannot
 * express. `PaplicoCommands.computePerspectiveWarpUpdates` combines these with
 * the shared bake machinery (`utils/geometry/pointDeform.ts`) and the adaptive
 * bezier subdivision in `projectiveBezier.ts` (shared with the Rotate3D
 * pre-filter, which is why this file lives beside it) to destructively bake
 * the warp into element geometry.
 */

import type { BoundingBox } from "../../schema";
import type { Point } from "./projectiveBezier";

/** Row-major 3x3 homography [ h0 h1 h2 ; h3 h4 h5 ; h6 h7 h8 ]. */
export type Homography = [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
];

// Bake tolerance: geometry written into the document should favour a stable
// anchor count over sub-pixel projection accuracy (unlike the render-time
// Rotate3D tolerance) — refitted control points absorb the difference.
const PROJECTION_ERROR_THRESHOLD_RATIO = 0.005; // 0.5% of source diagonal
const MIN_PROJECTION_ERROR_THRESHOLD = 0.1;
/** Keep the projective denominator away from 0 (point at/behind the horizon). */
const MIN_W_MARGIN = 1e-3;

/** The four corners of a rectangle in TL, TR, BR, BL order (world Y up). */
export function cornersFromBounds(
	bounds: Pick<BoundingBox, "minX" | "minY" | "maxX" | "maxY">,
): [Point, Point, Point, Point] {
	return [
		{ x: bounds.minX, y: bounds.maxY }, // TL
		{ x: bounds.maxX, y: bounds.maxY }, // TR
		{ x: bounds.maxX, y: bounds.minY }, // BR
		{ x: bounds.minX, y: bounds.minY }, // BL
	];
}

/**
 * Adaptive-subdivision error tolerance for projecting geometry of the given
 * source size (matches the Rotate3D pre-filter's tolerance scaling).
 */
export function projectionErrorThreshold(size: {
	width: number;
	height: number;
}): number {
	const halfDiag = Math.sqrt(size.width ** 2 + size.height ** 2) / 2;
	return Math.max(
		halfDiag * PROJECTION_ERROR_THRESHOLD_RATIO,
		MIN_PROJECTION_ERROR_THRESHOLD,
	);
}

/** Apply a homography with a near-plane clamp so w never crosses 0. */
export function projectViaH(x: number, y: number, H: Homography): Point {
	const w = H[6] * x + H[7] * y + H[8];
	const denom =
		Math.abs(w) < MIN_W_MARGIN ? (w < 0 ? -MIN_W_MARGIN : MIN_W_MARGIN) : w;
	return {
		x: (H[0] * x + H[1] * y + H[2]) / denom,
		y: (H[3] * x + H[4] * y + H[5]) / denom,
	};
}

/**
 * Solve the homography H (h8 = 1) mapping `src[i]` to `dst[i]` for 4 point
 * pairs, via the standard 8x8 linear system with partial-pivot Gaussian
 * elimination. Returns null when the system is singular (degenerate quad).
 */
export function solveHomography(
	src: [Point, Point, Point, Point],
	dst: [Point, Point, Point, Point],
): Homography | null {
	// Each correspondence contributes two rows of an 8x8 system A·h = b.
	const A: number[][] = [];
	const b: number[] = [];
	for (let i = 0; i < 4; i++) {
		const { x: sx, y: sy } = src[i];
		const { x: dx, y: dy } = dst[i];
		A.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx]);
		b.push(dx);
		A.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy]);
		b.push(dy);
	}

	const h = solveLinearSystem(A, b);
	if (!h) return null;
	return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Gaussian elimination with partial pivoting for an n×n system; null if singular. */
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
	const n = b.length;
	// Augmented matrix.
	const m = A.map((row, i) => [...row, b[i]]);

	for (let col = 0; col < n; col++) {
		let pivot = col;
		for (let r = col + 1; r < n; r++) {
			if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
		}
		if (Math.abs(m[pivot][col]) < 1e-12) return null;
		[m[col], m[pivot]] = [m[pivot], m[col]];

		const pivotVal = m[col][col];
		for (let r = 0; r < n; r++) {
			if (r === col) continue;
			const factor = m[r][col] / pivotVal;
			if (factor === 0) continue;
			for (let c = col; c <= n; c++) {
				m[r][c] -= factor * m[col][c];
			}
		}
	}

	const x = new Array<number>(n);
	for (let i = 0; i < n; i++) x[i] = m[i][n] / m[i][i];
	return x;
}
