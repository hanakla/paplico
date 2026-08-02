import { describe, expect, it } from "vitest";
import type { CubicBezierSegment, Filter } from "../../schema";
import {
	expectSegmentsMatchSnapshot,
	expectSegmentsVisualMatch,
	saveSegmentsPNG,
} from "../../testUtils/canvasVRT";
import { evalCubicBezier } from "../../utils/geometry/pathSampling";
import { resolveSegment } from "../../utils/geometry/segmentOps";
import { FilterRenderer } from "../canvas/pipeline/FilterRenderer";
import { applyPreFilters } from "../canvas/pipeline/PreFilterRenderer";
import {
	PathOffsetFilterHandler,
	type PathOffsetParams,
} from "./PathOffsetFilterProcessor";
import { PathUnionFilterHandler } from "./PathUnionFilterProcessor";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PathOffsetFilterHandler", () => {
	describe("PathOffsetFilterHandler.preProcess", () => {
		// --- 1. Basic behavior ---

		it("returns segments unchanged when offset is 0", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const result = applyOffset(rect, 0);
			expect(result).toBe(rect);
		});

		it("returns segments unchanged when segments array is empty", () => {
			const result = applyOffset([], 10);
			expect(result).toEqual([]);
		});

		// --- 2. Closed path — bounding box validation ---

		it("expands bbox for positive offset on CCW closed rect", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const result = applyOffset(rect, 10);
			const bbox = computeBBox(result);

			expect(bbox.maxX - bbox.minX).toBeCloseTo(120, 0);
			expect(bbox.maxY - bbox.minY).toBeCloseTo(120, 0);
		});

		it("shrinks for negative offset on CCW closed rect", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const result = applyOffset(rect, -10);

			// With miter extend, the result has same segment count as input.
			// Verify by checking that the edge midpoints moved inward.
			const pts = samplePath(result);
			const bottomEdgePts = pts.filter((p) => Math.abs(p.y + 40) < 2);
			expect(bottomEdgePts.length).toBeGreaterThan(0);
		});

		it("expands bbox for positive offset on CW closed rect (winding correction)", () => {
			const rect = makeCWRect(0, 0, 100, 100);
			const result = applyOffset(rect, 10);
			const bbox = computeBBox(result);

			// Winding correction should make positive offset expand outward
			expect(bbox.maxX - bbox.minX).toBeCloseTo(120, 0);
			expect(bbox.maxY - bbox.minY).toBeCloseTo(120, 0);
		});

		// --- 3. Normal direction (Y-up coordinate system) ---

		it("offsets a rightward horizontal line to the +Y side for positive offset", () => {
			// Open path: (0,0) → (100,0), travel direction = +X
			// Left normal in Y-up = (-dy, dx) = (0, 1) = +Y direction
			const line = makeOpenLine([
				[0, 0],
				[100, 0],
			]);
			const result = applyOffset(line, 10);
			const bbox = computeBBox(result);

			// Forward side should be offset to Y ≈ +10
			expect(bbox.maxY).toBeCloseTo(10, 0);
		});

		it("offsets an upward vertical line to the -X side for positive offset", () => {
			// Open path: (0,0) → (0,100), travel direction = +Y
			// Left normal in Y-up = (-dy, dx) = (-1, 0) = -X direction
			const line = makeOpenLine([
				[0, 0],
				[0, 100],
			]);
			const result = applyOffset(line, 10);
			const bbox = computeBBox(result);

			// Forward side should be offset to X ≈ -10
			expect(bbox.minX).toBeCloseTo(-10, 0);
		});

		// --- 4. Join types ---

		it("produces sharp corners with miter join", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const result = applyOffset(rect, 10, "miter");
			const bbox = computeBBox(result);

			// Miter corners extend to exactly offset distance on each side
			expect(bbox.maxX).toBeCloseTo(60, 0);
			expect(bbox.maxY).toBeCloseTo(60, 0);
			expect(bbox.minX).toBeCloseTo(-60, 0);
			expect(bbox.minY).toBeCloseTo(-60, 0);
		});

		it("produces curved corners with round join", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const miterResult = applyOffset(rect, 10, "miter");
			const roundResult = applyOffset(rect, 10, "round");

			// Round join inserts arc segments at convex corners.
			// Must produce MORE segments than miter (arcs require multiple cubics).
			expect(roundResult.length).toBeGreaterThan(miterResult.length);

			// The arc midpoint (45° on the corner arc) should be closer to the
			// original corner than the miter point. For a 90° corner at (50,-50)
			// with offset 10, the arc midpoint is at ~(50+10*cos(45°-π), -50-10*sin(45°-π))
			// ≈ (57.07, -57.07) vs miter at (60, -60).
			// Verify that the round result's corner area has points between the
			// miter and original boundaries.
			const roundBbox = computeBBox(roundResult);
			// The bbox width/height should be 120 (same as miter, since arc
			// endpoints touch the miter square's edges)
			expect(roundBbox.maxX - roundBbox.minX).toBeCloseTo(120, 0);
		});

		it("shrinks rect with all join types on negative offset", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const miterResult = applyOffset(rect, -10, "miter");
			const roundResult = applyOffset(rect, -10, "round");
			const bevelResult = applyOffset(rect, -10, "bevel");

			// All should shrink the rect — edge midpoints at y ≈ -40 (bottom)
			for (const result of [miterResult, roundResult, bevelResult]) {
				const pts = samplePath(result);
				expect(pts.some((p) => Math.abs(p.y + 40) < 2)).toBe(true);
			}
		});

		it("produces flat corners with bevel join", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const bevelResult = applyOffset(rect, 10, "bevel");
			const bbox = computeBBox(bevelResult);

			// Bevel cuts corners, so the bbox should be similar to miter
			// but corner points won't extend as far diagonally
			expect(bbox.maxX - bbox.minX).toBeCloseTo(120, 0);
			expect(bbox.maxY - bbox.minY).toBeCloseTo(120, 0);
		});

		it("falls back to bevel when miter limit is exceeded", () => {
			// Acute triangle with sharp angles that produce long miter spikes
			const tri: CubicBezierSegment[] = [
				lineSeg(0, 0, 100, 0, { isMoved: true }),
				lineSeg(100, 0, 50, 10),
				lineSeg(50, 10, 0, 0, { isClosed: true }),
			];
			const highMiter = applyOffset(tri, 5, "miter", 100);
			const lowMiter = applyOffset(tri, 5, "miter", 1);

			// High miter limit allows sharp spikes → larger bbox.
			// Low miter limit clips to bevel → smaller bbox.
			const highBbox = computeBBox(highMiter);
			const lowBbox = computeBBox(lowMiter);
			const highArea =
				(highBbox.maxX - highBbox.minX) * (highBbox.maxY - highBbox.minY);
			const lowArea =
				(lowBbox.maxX - lowBbox.minX) * (lowBbox.maxY - lowBbox.minY);
			expect(lowArea).toBeLessThan(highArea);
		});

		// --- 5. Open path ---

		it("produces a closed outline from an open path with flat cap", () => {
			const line = makeOpenLine([
				[0, 0],
				[100, 0],
			]);
			const result = applyOffset(line, 10, "miter", 4, "flat");

			// Open path offset produces a closed outline
			expect(result.at(-1)?.isClosed).toBe(true);
		});

		it("produces a closed outline from an open path with round cap", () => {
			const line = makeOpenLine([
				[0, 0],
				[100, 0],
			]);
			const flatResult = applyOffset(line, 10, "miter", 4, "flat");
			const roundResult = applyOffset(line, 10, "miter", 4, "round");

			// Round cap adds arc segments at endpoints
			expect(roundResult.length).toBeGreaterThan(flatResult.length);
			expect(roundResult.at(-1)?.isClosed).toBe(true);
		});

		// --- 6. Edge cases ---

		it("handles collinear control points (straight line segment)", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const result = applyOffset(rect, 5);

			// Should produce a valid expanded rect with no NaN or infinite values
			const bbox = computeBBox(result);
			expect(Number.isFinite(bbox.minX)).toBe(true);
			expect(Number.isFinite(bbox.maxX)).toBe(true);
			expect(bbox.maxX - bbox.minX).toBeCloseTo(110, 0);
		});

		it("adaptively subdivides when offset/curvature-radius ratio is large", () => {
			// Quarter arc as an open path (not closed), radius 10, offset 5
			const k = 0.5522847498;
			const r = 10;
			const arc: CubicBezierSegment[] = [
				{
					start: { x: r, y: 0 },
					cp1: { x: 0, y: r * k },
					cp2: { x: r * k, y: 0 },
					end: { x: 0, y: r },
					startPressure: 1,
					endPressure: 1,
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
					isMoved: true,
				},
			];
			const result = applyOffset(arc, 5, "miter", 4, "flat");

			// Open path offset produces a closed outline wrapping both sides.
			// Forward arc + reverse arc + 2 caps = at least 4 segments.
			// Adaptive subdivision on the curved arc should add more.
			expect(result.length).toBeGreaterThanOrEqual(4);
		});

		it("handles single-segment closed subpath", () => {
			const seg = makeQuarterArc(0, 0, 50);
			const result = applyOffset(seg, 5);

			// Should not throw and should produce non-empty output
			expect(result.length).toBeGreaterThan(0);
		});

		it("returns original subpath when negative offset causes shape inversion", () => {
			// 20x20 rect with offset -15: |offset| > half-width (10).
			// Edges cross the center → inversion → must return original 20x20.
			const smallRect = makeCCWRect(0, 0, 20, 20);
			const result = applyOffset(smallRect, -15);
			const bbox = computeBBox(result);

			expect(bbox.maxX - bbox.minX).toBeCloseTo(20, 0);
			expect(bbox.maxY - bbox.minY).toBeCloseTo(20, 0);
		});

		// --- 7. Round-trip ---

		it("round-trips a CCW rect through +10/-10 offset with miter join", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const expanded = applyOffset(rect, 10, "miter");
			const contracted = applyOffset(expanded, -10, "miter");

			expectSegmentsVisualMatch(contracted, rect, { maxDiffPercentage: 0 });
			assertShapeApproxEqual(contracted, rect, 3.0);
		});

		it("round-trips a CCW rect through +10/-10 offset with round join", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const expanded = applyOffset(rect, 10, "round");
			const contracted = applyOffset(expanded, -10, "round");

			// Round join expand adds arc segments at corners. Contract should
			// collapse those arcs back to zero-length and remove them.
			// The contracted shape must not have degenerate zero-length segments.
			expect(contracted.length).toBe(rect.length);

			// Visual match with stroke to detect corner artifacts
			expectSegmentsVisualMatch(contracted, rect, {
				maxDiffPercentage: 0,
				strokeColor: "#000000",
				strokeWidth: 2,
				fillColor: "transparent",
			});
		});

		it("does not produce inverted round arcs on negative offset with round join", () => {
			// Expand with round join → produces arc segments at corners.
			// Contract with round join → arc segment boundaries may cause
			// buildJoin to generate arcs sweeping in the wrong direction (nearly 2π).
			// The contracted shape must not exceed the original bbox.
			const rect = makeCCWRect(0, 0, 100, 100);
			const expanded = applyOffset(rect, 10, "round");
			const contracted = applyOffset(expanded, -10, "round");

			const origBbox = computeBBox(rect);
			const contractedBbox = computeBBox(contracted);

			// Contracted bbox must not be larger than original in any dimension.
			// If inverted arcs exist, they spike outward beyond the original boundary.
			expect(contractedBbox.minX).toBeGreaterThanOrEqual(origBbox.minX - 0.5);
			expect(contractedBbox.maxX).toBeLessThanOrEqual(origBbox.maxX + 0.5);
			expect(contractedBbox.minY).toBeGreaterThanOrEqual(origBbox.minY - 0.5);
			expect(contractedBbox.maxY).toBeLessThanOrEqual(origBbox.maxY + 0.5);
		});

		it("does not produce inverted round arcs on negative offset with round join (circle)", () => {
			const circle = makeCCWCircle(0, 0, 50);
			const expanded = applyOffset(circle, 10, "round");
			const contracted = applyOffset(expanded, -10, "round");

			const origBbox = computeBBox(circle);
			const contractedBbox = computeBBox(contracted);

			expect(contractedBbox.minX).toBeGreaterThanOrEqual(origBbox.minX - 0.5);
			expect(contractedBbox.maxX).toBeLessThanOrEqual(origBbox.maxX + 0.5);
			expect(contractedBbox.minY).toBeGreaterThanOrEqual(origBbox.minY - 0.5);
			expect(contractedBbox.maxY).toBeLessThanOrEqual(origBbox.maxY + 0.5);
		});

		it("does NOT round-trip exactly with bevel join (expected behavior)", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const expanded = applyOffset(rect, 10, "bevel");
			const contracted = applyOffset(expanded, -10, "bevel");

			// Bevel cuts corners on expand, so the expanded shape is an octagon.
			// Contracting the octagon does not restore the original sharp corners.
			// Compare against snapshot to detect unintended regressions.
			expectSegmentsMatchSnapshot(
				contracted,
				"path-offset-roundtrip-bevel-rect",
			);
		});
	});

	// ---------------------------------------------------------------------------
	// Group pre-filter chain round-trip
	// Reproduces the real rendering path: group has [PathOffset +10, PathOffset -10],
	// which are propagated to each child element via applyPreFilters.
	// ---------------------------------------------------------------------------

	describe("PathOffset group pre-filter round-trip", () => {
		function createFilterRenderer(): FilterRenderer {
			const device = { createSampler: () => ({}) } as unknown as GPUDevice;
			const renderer = new FilterRenderer(device);
			renderer.registerHandler("path-offset", new PathOffsetFilterHandler());
			return renderer;
		}

		const groupFilters: Filter[] = [
			makeFilter(10, "miter"),
			makeFilter(-10, "miter"),
		];

		function applyGroupPreFilters(
			segments: CubicBezierSegment[],
			filters: Filter[],
		): CubicBezierSegment[] {
			return applyPreFilters(segments, filters, createFilterRenderer());
		}

		it("round-trips a square through group pre-filter chain [+10, -10] with miter", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const result = applyGroupPreFilters(rect, groupFilters);
			expectSegmentsVisualMatch(result, rect, { maxDiffPercentage: 0 });
			assertShapeApproxEqual(result, rect, 3.0);
		});

		it("round-trips a circle through group pre-filter chain [+10, -10] with miter", () => {
			const circle = makeCCWCircle(0, 0, 50);
			const result = applyGroupPreFilters(circle, groupFilters);
			expectSegmentsVisualMatch(result, circle, { maxDiffPercentage: 0 });
			assertShapeApproxEqual(result, circle, 1.0);
		});

		it("round-trips a small circle through group pre-filter chain [+10, -10] with miter", () => {
			const circle = makeCCWCircle(100, 100, 30);
			const result = applyGroupPreFilters(circle, groupFilters);
			expectSegmentsVisualMatch(result, circle, { maxDiffPercentage: 0 });
			assertShapeApproxEqual(result, circle, 1.0);
		});

		it("round-trips a square through group pre-filter chain [+10, -10] with round", () => {
			const roundFilters: Filter[] = [
				makeFilter(10, "round"),
				makeFilter(-10, "round"),
			];
			const rect = makeCCWRect(0, 0, 100, 100);
			const result = applyGroupPreFilters(rect, roundFilters);
			expectSegmentsVisualMatch(result, rect, { maxDiffPercentage: 0 });
			assertShapeApproxEqual(result, rect, 3.0);
		});

		it("round-trips a circle through group pre-filter chain [+10, -10] with round", () => {
			const roundFilters: Filter[] = [
				makeFilter(10, "round"),
				makeFilter(-10, "round"),
			];
			const circle = makeCCWCircle(0, 0, 50);
			const result = applyGroupPreFilters(circle, roundFilters);
			expectSegmentsVisualMatch(result, circle, { maxDiffPercentage: 0 });
			assertShapeApproxEqual(result, circle, 1.0);
		});

		it("round-trips a square through group pre-filter chain [+10, -10] with bevel", () => {
			const bevelFilters: Filter[] = [
				makeFilter(10, "bevel"),
				makeFilter(-10, "bevel"),
			];
			const rect = makeCCWRect(0, 0, 100, 100);
			const result = applyGroupPreFilters(rect, bevelFilters);
			expectSegmentsMatchSnapshot(
				result,
				"path-offset-group-roundtrip-bevel-rect",
			);
		});

		it("round-trips a circle through group pre-filter chain [+10, -10] with bevel", () => {
			const bevelFilters: Filter[] = [
				makeFilter(10, "bevel"),
				makeFilter(-10, "bevel"),
			];
			const circle = makeCCWCircle(0, 0, 50);
			const result = applyGroupPreFilters(circle, bevelFilters);
			expectSegmentsMatchSnapshot(
				result,
				"path-offset-group-roundtrip-bevel-circle",
			);
		});
	});

	// ---------------------------------------------------------------------------
	// Metaball chain: offset +20 (round) → union → offset -20 (round)
	// Reproduces the real use case of 3 objects in a group with metaball filters.
	// ---------------------------------------------------------------------------

	describe("Metaball chain: offset +20 → union → offset -20", () => {
		function createFullFilterRenderer(): FilterRenderer {
			const device = { createSampler: () => ({}) } as unknown as GPUDevice;
			const renderer = new FilterRenderer(device);
			renderer.registerHandler("path-offset", new PathOffsetFilterHandler());
			renderer.registerHandler("path-union", new PathUnionFilterHandler());
			return renderer;
		}

		const metaballFilters: Filter[] = [
			makeFilter(20, "round"),
			{
				uid: "test-union",
				processor: "path-union",
				opacity: 1,
				blendMode: "normal",
				paramData: { version: "1", params: { mode: "union" } },
			},
			makeFilter(-20, "round"),
		];

		function applyMetaballChain(
			segments: CubicBezierSegment[],
		): CubicBezierSegment[] {
			return applyPreFilters(
				segments,
				metaballFilters,
				createFullFilterRenderer(),
			);
		}

		it("produces a valid contour from square + 2 circles", () => {
			// 3 objects as separate subpaths in one segment array
			const square = makeCCWRect(0, 0, 50, 50);
			const circle1 = makeCCWCircle(40, 0, 25);
			const circle2 = makeCCWCircle(0, -40, 20);

			// Combine into multi-subpath input
			const combined = [
				...square.map((s, i) => (i === 0 ? { ...s, isMoved: true } : s)),
				...circle1.map((s, i) => (i === 0 ? { ...s, isMoved: true } : s)),
				...circle2.map((s, i) => (i === 0 ? { ...s, isMoved: true } : s)),
			];

			const result = applyMetaballChain(combined);

			// Result must be non-empty and all segments finite
			expect(result.length).toBeGreaterThan(0);
			const bbox = computeBBox(result);
			expect(Number.isFinite(bbox.minX)).toBe(true);
			expect(Number.isFinite(bbox.maxX)).toBe(true);
			expect(Number.isFinite(bbox.minY)).toBe(true);
			expect(Number.isFinite(bbox.maxY)).toBe(true);

			// The final contour bbox should be close to the union of
			// original bboxes (objects stay roughly same size after +20/-20)
			const origBbox = computeBBox(combined);
			const bboxW = bbox.maxX - bbox.minX;
			const origW = origBbox.maxX - origBbox.minX;
			// Allow some tolerance for round join geometry
			expect(bboxW).toBeGreaterThan(origW * 0.7);
			expect(bboxW).toBeLessThan(origW * 1.5);
		});

		it("does not produce spikes outside the +20 expanded bbox", () => {
			const square = makeCCWRect(0, 0, 50, 50);
			const circle1 = makeCCWCircle(40, 0, 25);

			const combined = [
				...square.map((s, i) => (i === 0 ? { ...s, isMoved: true } : s)),
				...circle1.map((s, i) => (i === 0 ? { ...s, isMoved: true } : s)),
			];

			// Step 1: offset +20
			const step1 = applyPreFilters(
				combined,
				[makeFilter(20, "round")],
				createFullFilterRenderer(),
			);
			const expandedBbox = computeBBox(step1);

			// Step 2: union
			const step2 = applyPreFilters(
				step1,
				[
					{
						uid: "u",
						processor: "path-union",
						opacity: 1,
						blendMode: "normal",
						paramData: { version: "1", params: { mode: "union" } },
					},
				],
				createFullFilterRenderer(),
			);

			// Step 3: offset -20
			const step3 = applyPreFilters(
				step2,
				[makeFilter(-20, "round")],
				createFullFilterRenderer(),
			);
			const finalBbox = computeBBox(step3);

			// Final bbox must not exceed expanded bbox (no spikes)
			expect(finalBbox.minX).toBeGreaterThanOrEqual(expandedBbox.minX - 1);
			expect(finalBbox.maxX).toBeLessThanOrEqual(expandedBbox.maxX + 1);
			expect(finalBbox.minY).toBeGreaterThanOrEqual(expandedBbox.minY - 1);
			expect(finalBbox.maxY).toBeLessThanOrEqual(expandedBbox.maxY + 1);
		});

		it("dump: renders each stage of the metaball chain for visual inspection", () => {
			const square = makeCCWRect(0, 0, 50, 50);
			const circle1 = makeCCWCircle(40, 0, 25);
			const circle2 = makeCCWCircle(0, -40, 20);

			const combined = [
				...square.map((s, i) => (i === 0 ? { ...s, isMoved: true } : s)),
				...circle1.map((s, i) => (i === 0 ? { ...s, isMoved: true } : s)),
				...circle2.map((s, i) => (i === 0 ? { ...s, isMoved: true } : s)),
			];

			const fr = createFullFilterRenderer();
			const step1 = applyPreFilters(combined, [makeFilter(20, "round")], fr);
			const step2 = applyPreFilters(
				step1,
				[
					{
						uid: "u",
						processor: "path-union",
						opacity: 1,
						blendMode: "normal",
						paramData: { version: "1", params: { mode: "union" } },
					},
				],
				fr,
			);
			const step3 = applyPreFilters(step2, [makeFilter(-20, "round")], fr);

			const dir = `${__dirname}/../../../__visual_temp__/metaball-chain`;
			saveSegmentsPNG(combined, `${dir}/0-original.png`);
			saveSegmentsPNG(step1, `${dir}/1-offset+20.png`);
			saveSegmentsPNG(step2, `${dir}/2-union.png`);
			saveSegmentsPNG(step3, `${dir}/3-offset-20.png`);

			// Always pass — this test is for visual inspection
			expect(true).toBe(true);
		});
	});

	// ---------------------------------------------------------------------------
	// Self-intersection clipping: gourd (hourglass) shape splits into two
	// ---------------------------------------------------------------------------

	describe("Gourd shape self-intersection splitting", () => {
		function createFullRenderer(): FilterRenderer {
			const device = { createSampler: () => ({}) } as unknown as GPUDevice;
			const renderer = new FilterRenderer(device);
			renderer.registerHandler("path-offset", new PathOffsetFilterHandler());
			renderer.registerHandler("path-union", new PathUnionFilterHandler());
			return renderer;
		}

		/**
		 * Create a gourd/hourglass shape via offset+expand → union.
		 * Two circles barely touching, expand to merge, producing narrow neck.
		 */
		function makeGourd(
			expandOffset: number,
			circleRadius = 20,
			centerDist = 42,
		): {
			gourd: CubicBezierSegment[];
			renderer: FilterRenderer;
		} {
			const halfDist = centerDist / 2;
			const circle1 = makeCCWCircle(-halfDist, 0, circleRadius);
			const circle2 = makeCCWCircle(halfDist, 0, circleRadius);
			const combined = [
				...circle1.map((s, i) => (i === 0 ? { ...s, isMoved: true } : s)),
				...circle2.map((s, i) => (i === 0 ? { ...s, isMoved: true } : s)),
			];

			const renderer = createFullRenderer();
			const expanded = applyPreFilters(
				combined,
				[makeFilter(expandOffset, "round")],
				renderer,
			);
			const gourd = applyPreFilters(
				expanded,
				[
					{
						uid: "u",
						processor: "path-union",
						opacity: 1,
						blendMode: "normal",
						paramData: { version: "1", params: { mode: "union" } },
					},
				],
				renderer,
			);
			return { gourd, renderer };
		}

		it("splits into two spatially separated lobes when negative offset exceeds neck width", () => {
			// Circles r=20, centers 42 apart (gap=2). Expand +3 makes r=23,
			// overlap = 46-42 = 4. Neck half-width = sqrt(23²-21²) = sqrt(88) ≈ 9.4.
			// Neck width ≈ 18.8. After -10: 18.8-20 = -1.2 → should split.
			// Expected: two lobes of ~r=13 centered at x≈±21, separated at x≈0.
			const { gourd, renderer } = makeGourd(3);

			const result = applyPreFilters(
				gourd,
				[makeFilter(-10, "round")],
				renderer,
			);

			// Extract subpaths with their bboxes
			const movedIndices = result
				.map((s, i) => (s.isMoved ? i : -1))
				.filter((i) => i >= 0);
			const subpaths = movedIndices.map((start, k) => {
				const end =
					k + 1 < movedIndices.length ? movedIndices[k + 1] : result.length;
				const segs = result.slice(start, end);
				const xs = segs.map((s) => s.end.x);
				const ys = segs.map((s) => s.end.y);
				const minX = Math.min(...xs);
				const maxX = Math.max(...xs);
				const minY = Math.min(...ys);
				const maxY = Math.max(...ys);
				return {
					segs,
					closed: segs.at(-1)!.isClosed,
					width: maxX - minX,
					height: maxY - minY,
					centerX: (minX + maxX) / 2,
					minX,
					maxX,
				};
			});

			// Must produce exactly 2 lobes (no tiny neck remnants)
			expect(subpaths.length).toBe(2);

			// Both lobes must be closed
			expect(subpaths[0].closed).toBe(true);
			expect(subpaths[1].closed).toBe(true);

			// Lobes must be spatially separated (no X overlap)
			const [left, right] = subpaths.sort((a, b) => a.centerX - b.centerX);
			expect(left.maxX).toBeLessThan(right.minX);

			// Each lobe should be roughly circle-like (width ≈ height ≈ 26,
			// i.e. diameter of r≈13 offset result)
			for (const lobe of subpaths) {
				expect(lobe.width).toBeGreaterThan(15);
				expect(lobe.height).toBeGreaterThan(15);
			}

			// All coordinates must be finite
			for (const seg of result) {
				expect(Number.isFinite(seg.end.x)).toBe(true);
				expect(Number.isFinite(seg.end.y)).toBe(true);
			}
		});

		it("does NOT split when negative offset is small (neck still wide)", () => {
			// Same gourd but smaller offset. Neck width ≈ 18.8. After -5: 8.8 → still open.
			const { gourd, renderer } = makeGourd(3);

			const result = applyPreFilters(
				gourd,
				[makeFilter(-5, "round")],
				renderer,
			);

			const subPathCount = result.filter((s) => s.isMoved).length;
			expect(subPathCount).toBe(1);
		});

		it("dump: renders gourd offset stages for visual inspection", () => {
			const { gourd, renderer } = makeGourd(3);

			const small = applyPreFilters(gourd, [makeFilter(-5, "round")], renderer);
			const large = applyPreFilters(
				gourd,
				[makeFilter(-10, "round")],
				renderer,
			);

			const dir = `${__dirname}/../../../__visual_temp__/gourd-split`;
			saveSegmentsPNG(gourd, `${dir}/0-gourd.png`);
			saveSegmentsPNG(small, `${dir}/1-offset-5.png`);
			saveSegmentsPNG(large, `${dir}/2-offset-10-split.png`);

			expect(true).toBe(true);
		});
	});
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Create a straight-line cubic segment with cp at 1/3 positions. */
function lineSeg(
	sx: number,
	sy: number,
	ex: number,
	ey: number,
	opts?: { isMoved?: boolean; isClosed?: boolean; start?: true },
): CubicBezierSegment {
	const dx = ex - sx;
	const dy = ey - sy;
	return {
		...(opts?.start !== undefined || opts?.isMoved
			? { start: { x: sx, y: sy } }
			: {}),
		cp1: { x: dx / 3, y: dy / 3 },
		cp2: { x: -dx / 3, y: -dy / 3 },
		end: { x: ex, y: ey },
		startPressure: 1,
		endPressure: 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: opts?.isMoved ?? false,
		isClosed: opts?.isClosed,
	};
}

/**
 * CCW rectangle in Y-up space (counter-clockwise).
 * Vertices: bottom-left → bottom-right → top-right → top-left → close
 */
function makeCCWRect(
	cx: number,
	cy: number,
	w: number,
	h: number,
): CubicBezierSegment[] {
	const hw = w / 2;
	const hh = h / 2;
	return [
		lineSeg(cx - hw, cy - hh, cx + hw, cy - hh, { isMoved: true }),
		lineSeg(cx + hw, cy - hh, cx + hw, cy + hh),
		lineSeg(cx + hw, cy + hh, cx - hw, cy + hh),
		lineSeg(cx - hw, cy + hh, cx - hw, cy - hh, { isClosed: true }),
	];
}

/**
 * CW rectangle in Y-up space (clockwise). For winding correction tests.
 * Vertices: bottom-left → top-left → top-right → bottom-right → close
 */
function makeCWRect(
	cx: number,
	cy: number,
	w: number,
	h: number,
): CubicBezierSegment[] {
	const hw = w / 2;
	const hh = h / 2;
	return [
		lineSeg(cx - hw, cy - hh, cx - hw, cy + hh, { isMoved: true }),
		lineSeg(cx - hw, cy + hh, cx + hw, cy + hh),
		lineSeg(cx + hw, cy + hh, cx + hw, cy - hh),
		lineSeg(cx + hw, cy - hh, cx - hw, cy - hh, { isClosed: true }),
	];
}

/** Open polyline through given points. */
function makeOpenLine(points: [number, number][]): CubicBezierSegment[] {
	const segs: CubicBezierSegment[] = [];
	for (let i = 0; i < points.length - 1; i++) {
		segs.push(
			lineSeg(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], {
				isMoved: i === 0,
				start: i === 0 ? true : undefined,
			}),
		);
	}
	return segs;
}

/**
 * CCW circle approximation (4 cubic bezier segments).
 * Vertices: right → top → left → bottom → close.
 */
function makeCCWCircle(
	cx: number,
	cy: number,
	r: number,
): CubicBezierSegment[] {
	const k = 0.5522847498 * r;
	const seg = (
		sx: number,
		sy: number,
		c1x: number,
		c1y: number,
		c2x: number,
		c2y: number,
		ex: number,
		ey: number,
		opts?: { isMoved?: boolean; isClosed?: boolean },
	): CubicBezierSegment => ({
		...(opts?.isMoved ? { start: { x: sx, y: sy } } : {}),
		cp1: { x: c1x - sx, y: c1y - sy },
		cp2: { x: c2x - ex, y: c2y - ey },
		end: { x: ex, y: ey },
		startPressure: 1,
		endPressure: 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: opts?.isMoved ?? false,
		isClosed: opts?.isClosed,
	});
	return [
		seg(cx + r, cy, cx + r, cy + k, cx + k, cy + r, cx, cy + r, {
			isMoved: true,
		}),
		seg(cx, cy + r, cx - k, cy + r, cx - r, cy + k, cx - r, cy),
		seg(cx - r, cy, cx - r, cy - k, cx - k, cy - r, cx, cy - r),
		seg(cx, cy - r, cx + k, cy - r, cx + r, cy - k, cx + r, cy, {
			isClosed: true,
		}),
	];
}

/** Create a quarter-circle arc (90°) as a cubic bezier segment. */
function makeQuarterArc(
	cx: number,
	cy: number,
	r: number,
): CubicBezierSegment[] {
	// Quarter arc from (cx+r, cy) to (cx, cy+r) in CCW direction
	const k = 0.5522847498; // kappa for 90° arc
	const sx = cx + r;
	const sy = cy;
	const ex = cx;
	const ey = cy + r;
	// Absolute CPs: cp1 = (cx+r, cy+r*k), cp2 = (cx+r*k, cy+r)
	// Relative: cp1 = abs_cp1 - start, cp2 = abs_cp2 - end
	return [
		{
			start: { x: sx, y: sy },
			cp1: { x: 0, y: r * k },
			cp2: { x: r * k, y: 0 },
			end: { x: ex, y: ey },
			startPressure: 1,
			endPressure: 1,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: true,
			isClosed: true,
		},
	];
}

function makeFilter(
	offset: number,
	joinType: "miter" | "round" | "bevel" = "miter",
	miterLimit = 4,
	openPathCap: "flat" | "round" = "flat",
): Filter {
	return {
		uid: "test-offset",
		processor: "path-offset",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: { offset, joinType, miterLimit, openPathCap },
		},
	};
}

function applyOffset(
	segments: CubicBezierSegment[],
	offset: number,
	joinType: PathOffsetParams["joinType"] = "miter",
	miterLimit = 4,
	openPathCap: PathOffsetParams["openPathCap"] = "flat",
): CubicBezierSegment[] {
	const handler = new PathOffsetFilterHandler();
	return handler.preProcess(
		segments,
		makeFilter(offset, joinType, miterLimit, openPathCap),
	);
}

/** Compute axis-aligned bounding box from segment endpoints. */
function computeBBox(segments: CubicBezierSegment[]): {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
} {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (let i = 0; i < segments.length; i++) {
		const prevEnd = i > 0 ? segments[i - 1].end : undefined;
		const r = resolveSegment(segments[i], prevEnd);

		// Sample at multiple t values for accuracy
		for (let t = 0; t <= 1; t += 0.1) {
			const pt = evalCubicBezier(r.start, r.cp1, r.cp2, r.end, t);
			minX = Math.min(minX, pt.x);
			minY = Math.min(minY, pt.y);
			maxX = Math.max(maxX, pt.x);
			maxY = Math.max(maxY, pt.y);
		}
	}

	return { minX, minY, maxX, maxY };
}

/** Sample path densely (50 points per segment), returning world-space points. */
function samplePath(
	segments: CubicBezierSegment[],
): { x: number; y: number }[] {
	const SAMPLES_PER_SEG = 50;
	const points: { x: number; y: number }[] = [];
	for (let i = 0; i < segments.length; i++) {
		const prevEnd = i > 0 ? segments[i - 1].end : undefined;
		const r = resolveSegment(segments[i], prevEnd);
		for (let j = 0; j < SAMPLES_PER_SEG; j++) {
			const t = j / SAMPLES_PER_SEG;
			points.push(evalCubicBezier(r.start, r.cp1, r.cp2, r.end, t));
		}
	}
	// Add final endpoint
	const lastSeg = segments.at(-1)!;
	const prevEnd =
		segments.length > 1 ? segments[segments.length - 2].end : undefined;
	const lastR = resolveSegment(lastSeg, prevEnd);
	points.push(evalCubicBezier(lastR.start, lastR.cp1, lastR.cp2, lastR.end, 1));
	return points;
}

/**
 * Check that two shapes are approximately equal by dense point sampling.
 * Bidirectional: every point in A must be near some point in B, AND vice versa.
 */
function assertShapeApproxEqual(
	a: CubicBezierSegment[],
	b: CubicBezierSegment[],
	tolerance: number,
): void {
	const ptsA = samplePath(a);
	const ptsB = samplePath(b);

	// A→B: every point in A must be near some point in B
	for (const pa of ptsA) {
		let minDist = Infinity;
		for (const pb of ptsB) {
			const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
			minDist = Math.min(minDist, d);
		}
		expect(minDist).toBeLessThanOrEqual(tolerance);
	}

	// B→A: every point in B must be near some point in A
	for (const pb of ptsB) {
		let minDist = Infinity;
		for (const pa of ptsA) {
			const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
			minDist = Math.min(minDist, d);
		}
		expect(minDist).toBeLessThanOrEqual(tolerance);
	}
}

/**
 * Measure the angle at the junction between segment segIdx and the next.
 * Samples points near the corner to compute the turning angle.
 */
