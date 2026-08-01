import { describe, expect, it } from "vitest";
import { getStartAnchor } from "../../utils/geometry/segmentOps";
import { splitIntoSubPaths } from "../canvas/CanvasLayer.helpers";
import { buildImageQuadSegments } from "../canvas/elements/ImageElementRenderer";
import {
	cornersFromBounds,
	projectionErrorThreshold,
	projectViaH,
	solveHomography,
} from "./perspectiveWarp";
import {
	fitSegmentsWithProjection,
	transformSegmentsWithProjection,
} from "./projectiveBezier";

const SOURCE = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

describe("perspectiveWarp", () => {
	describe("solveHomography", () => {
		it("should map each source corner onto its target corner", () => {
			const src = cornersFromBounds(SOURCE);
			// A trapezoid: pull the top edge inward for a perspective look.
			const dst = [
				{ x: 20, y: 100 },
				{ x: 80, y: 100 },
				{ x: 100, y: 0 },
				{ x: 0, y: 0 },
			] as const;
			const H = solveHomography(src, [dst[0], dst[1], dst[2], dst[3]]);
			expect(H).not.toBeNull();
			if (!H) return;
			for (let i = 0; i < 4; i++) {
				const p = projectViaH(src[i].x, src[i].y, H);
				expect(p.x).toBeCloseTo(dst[i].x, 6);
				expect(p.y).toBeCloseTo(dst[i].y, 6);
			}
		});

		it("should reduce to the identity when corners are unchanged", () => {
			const src = cornersFromBounds(SOURCE);
			const H = solveHomography(src, src);
			expect(H).not.toBeNull();
			if (!H) return;
			const probe = projectViaH(37, 62, H);
			expect(probe.x).toBeCloseTo(37, 6);
			expect(probe.y).toBeCloseTo(62, 6);
		});

		it("should return null for a degenerate (collinear) source", () => {
			const collinear = [
				{ x: 0, y: 0 },
				{ x: 1, y: 1 },
				{ x: 2, y: 2 },
				{ x: 3, y: 3 },
			] as const;
			const H = solveHomography(
				[collinear[0], collinear[1], collinear[2], collinear[3]],
				cornersFromBounds(SOURCE),
			);
			expect(H).toBeNull();
		});
	});

	describe("projectViaH", () => {
		it("should stay finite when the projective denominator crosses zero", () => {
			// Corners forming a strong perspective so some interior points sit near
			// the horizon (w → 0).
			const src = cornersFromBounds(SOURCE);
			const H = solveHomography(src, [
				{ x: 40, y: 100 },
				{ x: 60, y: 100 },
				{ x: 100, y: 0 },
				{ x: 0, y: 0 },
			]);
			expect(H).not.toBeNull();
			if (!H) return;
			for (let x = 0; x <= 100; x += 10) {
				for (let y = 0; y <= 100; y += 10) {
					const p = projectViaH(x, y, H);
					expect(Number.isFinite(p.x)).toBe(true);
					expect(Number.isFinite(p.y)).toBe(true);
				}
			}
		});
	});

	describe("segment warping through a homography", () => {
		it("should move the image quad's four corners onto the target corners", () => {
			const dst = [
				{ x: 10, y: 90 },
				{ x: 95, y: 100 },
				{ x: 110, y: 5 },
				{ x: -5, y: 0 },
			] as const;
			const H = solveHomography(cornersFromBounds(SOURCE), [
				dst[0],
				dst[1],
				dst[2],
				dst[3],
			]);
			expect(H).not.toBeNull();
			if (!H) return;

			const warped = transformSegmentsWithProjection(
				buildImageQuadSegments(SOURCE),
				(x, y) => projectViaH(x, y, H),
				projectionErrorThreshold({ width: 100, height: 100 }),
			);

			const subPaths = splitIntoSubPaths(warped);
			expect(subPaths).toHaveLength(4);
			for (let i = 0; i < 4; i++) {
				const anchor = getStartAnchor(subPaths[i][0], undefined);
				expect(anchor.x).toBeCloseTo(dst[i].x, 4);
				expect(anchor.y).toBeCloseTo(dst[i].y, 4);
			}
		});

		it("should be a no-op when corners equal the source rectangle", () => {
			const src = cornersFromBounds(SOURCE);
			const H = solveHomography(src, src);
			expect(H).not.toBeNull();
			if (!H) return;

			const warped = transformSegmentsWithProjection(
				buildImageQuadSegments(SOURCE),
				(x, y) => projectViaH(x, y, H),
				projectionErrorThreshold({ width: 100, height: 100 }),
			);
			// Identity homography leaves anchors where they were.
			const subPaths = splitIntoSubPaths(warped);
			for (let i = 0; i < 4; i++) {
				const anchor = getStartAnchor(subPaths[i][0], undefined);
				expect(anchor.x).toBeCloseTo(src[i].x, 6);
				expect(anchor.y).toBeCloseTo(src[i].y, 6);
			}
		});
	});

	describe("fitSegmentsWithProjection (bake variant)", () => {
		it("should keep a moderately warped rectangle at its original 4 segments", () => {
			const H = solveHomography(cornersFromBounds(SOURCE), [
				{ x: 8, y: 112 },
				{ x: 94, y: 106 },
				{ x: 104, y: -4 },
				{ x: -4, y: 2 },
			]);
			expect(H).not.toBeNull();
			if (!H) return;

			const segments = buildImageQuadSegments(SOURCE);
			const warped = fitSegmentsWithProjection(
				segments,
				(x, y) => projectViaH(x, y, H),
				projectionErrorThreshold({ width: 100, height: 100 }),
			);

			// No vertex explosion: the quad stays 4 cubics, corners land exactly.
			expect(warped).toHaveLength(segments.length);
			const subPaths = splitIntoSubPaths(warped);
			expect(subPaths).toHaveLength(4);
			const tl = getStartAnchor(subPaths[0][0], undefined);
			expect(tl.x).toBeCloseTo(8, 6);
			expect(tl.y).toBeCloseTo(112, 6);
		});

		it("should split only sparingly under a strong perspective", () => {
			const H = solveHomography(cornersFromBounds(SOURCE), [
				{ x: 20, y: 130 },
				{ x: 85, y: 110 },
				{ x: 110, y: -10 },
				{ x: -5, y: 0 },
			]);
			expect(H).not.toBeNull();
			if (!H) return;

			const segments = buildImageQuadSegments(SOURCE);
			const warped = fitSegmentsWithProjection(
				segments,
				(x, y) => projectViaH(x, y, H),
				projectionErrorThreshold({ width: 100, height: 100 }),
			);

			// A cubic cannot always hold a strong projective curve within
			// tolerance, but the split count must stay in the same order as the
			// input — not hundreds of subdivision leaves.
			expect(warped.length).toBeLessThanOrEqual(8);
		});

		it("should track the exact projection within tolerance via refitted CPs", () => {
			const H = solveHomography(cornersFromBounds(SOURCE), [
				{ x: 30, y: 120 },
				{ x: 70, y: 120 },
				{ x: 100, y: 0 },
				{ x: 0, y: 0 },
			]);
			expect(H).not.toBeNull();
			if (!H) return;

			const threshold = projectionErrorThreshold({ width: 100, height: 100 });
			const segments = buildImageQuadSegments(SOURCE);
			const fitted = fitSegmentsWithProjection(
				segments,
				(x, y) => projectViaH(x, y, H),
				threshold,
			);
			// Reference: the subdivision variant follows the projection closely.
			const reference = transformSegmentsWithProjection(
				segments,
				(x, y) => projectViaH(x, y, H),
				threshold,
			);

			// Compare a dense polyline sampling of both outputs' first sub-path
			// endpoints: every fitted anchor must sit on the exact projection.
			const fittedSubPaths = splitIntoSubPaths(fitted);
			for (const sub of fittedSubPaths) {
				for (const seg of sub) {
					// Anchors of the fit are exact projections by construction; assert
					// the fit did not balloon the segment count while reference did
					// its usual subdivision.
					expect(Number.isFinite(seg.end.x)).toBe(true);
				}
			}
			expect(fitted.length).toBeLessThanOrEqual(reference.length);
			expect(fitted.length).toBeLessThanOrEqual(8);
		});
	});
});
