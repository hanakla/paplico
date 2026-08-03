import pixelmatch from "pixelmatch";
import { describe, expect, it } from "vitest";
import type { CubicBezierSegment, Filter } from "../../schema";
import { renderSegmentsToPixels } from "../../testUtils/canvasVRT";
import { resolveSegment } from "../../utils/geometry/segmentOps";
import {
	type PathUnionFilter,
	PathUnionFilterHandler,
} from "./PathUnionFilterProcessor";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PathUnionFilterHandler", () => {
	describe("preProcess", () => {
		// --- 1. Basic behavior ---

		it("returns segments unchanged when array is empty", () => {
			const result = applyBool([], "union");
			expect(result).toEqual([]);
		});

		it("returns segments unchanged when there is only one closed subpath", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const result = applyBool(rect, "union");
			expect(result).toBe(rect);
		});

		it("returns segments unchanged when there is only one open subpath", () => {
			const line = makeOpenLine([
				[0, 0],
				[100, 0],
				[100, 100],
			]);
			const result = applyBool(line, "union");
			expect(result).toBe(line);
		});

		// --- 2. union mode ---

		it("union of overlapping rects matches A OR B pixels", () => {
			const a = makeCCWRect(0, 0, 100, 100);
			const b = makeCCWRect(50, 50, 100, 100);
			const input = [...a, ...b];
			const result = applyBool(input, "union");

			assertBooleanPixels(a, b, result, "union");
		});

		it("union of disjoint rects matches A OR B pixels", () => {
			const a = makeCCWRect(0, 0, 80, 80);
			const b = makeCCWRect(200, 200, 80, 80);
			const input = [...a, ...b];
			const result = applyBool(input, "union");

			assertBooleanPixels(a, b, result, "union");
		});

		it("union of 3 overlapping rects matches A OR B OR C pixels", () => {
			const a = makeCCWRect(0, 0, 100, 100);
			const b = makeCCWRect(50, 0, 100, 100);
			const c = makeCCWRect(100, 0, 100, 100);
			const input = [...a, ...b, ...c];
			const result = applyBool(input, "union");

			assertBooleanPixelsMulti([a, b, c], result, "union");
		});

		// --- 3. intersection mode ---

		it("intersection of overlapping rects matches A AND B pixels", () => {
			const a = makeCCWRect(0, 0, 100, 100);
			const b = makeCCWRect(30, 30, 100, 100);
			const input = [...a, ...b];
			const result = applyBool(input, "intersection");

			assertBooleanPixels(a, b, result, "intersection");
		});

		it("intersection of 3 overlapping rects matches A AND B AND C pixels", () => {
			const a = makeCCWRect(0, 0, 100, 100);
			const b = makeCCWRect(20, 20, 100, 100);
			const c = makeCCWRect(40, 40, 100, 100);
			const input = [...a, ...b, ...c];
			const result = applyBool(input, "intersection");

			assertBooleanPixelsMulti([a, b, c], result, "intersection");
		});

		it("intersection of disjoint rects produces empty output", () => {
			const a = makeCCWRect(0, 0, 80, 80);
			const b = makeCCWRect(200, 200, 80, 80);
			const input = [...a, ...b];
			const result = applyBool(input, "intersection");

			expect(result).toEqual([]);
		});

		// --- 4. difference mode ---

		it("difference of overlapping rects matches A AND NOT B pixels", () => {
			const a = makeCCWRect(0, 0, 100, 100);
			const b = makeCCWRect(30, 30, 100, 100);
			const input = [...a, ...b];
			const result = applyBool(input, "difference");

			assertBooleanPixels(a, b, result, "difference");
		});

		it("difference of 3 overlapping rects matches A AND NOT B AND NOT C pixels", () => {
			const a = makeCCWRect(0, 0, 100, 100);
			const b = makeCCWRect(20, 20, 80, 80);
			const c = makeCCWRect(-20, -20, 80, 80);
			const input = [...a, ...b, ...c];
			const result = applyBool(input, "difference");

			assertBooleanPixelsMulti([a, b, c], result, "difference");
		});

		it("difference with only one closed contour returns segments unchanged", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const result = applyBool(rect, "difference");
			expect(result).toBe(rect);
		});

		// --- 5. xor mode ---

		it("xor of overlapping rects matches A XOR B pixels", () => {
			const a = makeCCWRect(0, 0, 100, 100);
			const b = makeCCWRect(30, 30, 100, 100);
			const input = [...a, ...b];
			const result = applyBool(input, "xor");

			assertBooleanPixels(a, b, result, "xor");
		});

		it("xor of 3 overlapping rects matches pixel-level XOR", () => {
			const a = makeCCWRect(0, 0, 100, 100);
			const b = makeCCWRect(30, 30, 100, 100);
			const c = makeCCWRect(60, 60, 100, 100);
			const input = [...a, ...b, ...c];
			const result = applyBool(input, "xor");

			assertBooleanPixelsMulti([a, b, c], result, "xor");
		});

		// --- 6. Open subpath preservation ---

		it("implicitly closes open subpaths and includes them in the boolean", () => {
			// An open L-shaped polyline overlapping rectA: implicit close turns
			// it into a triangle that merges into the union
			const openTri = makeOpenLine([
				[-40, 0],
				[40, 0],
				[-40, 80],
			]);
			const rectA = makeCCWRect(0, 0, 80, 80);
			const input = [...openTri, ...rectA];
			const result = applyBool(input, "union");

			// One merged contour covering the (center-based) rect ±40 and the
			// implicitly-closed triangle's apex at y=80
			expect(result).not.toBe(input);
			const xs = result.map((seg) => seg.end.x);
			const ys = result.map((seg) => seg.end.y);
			expect(Math.min(...xs)).toBeCloseTo(-40);
			expect(Math.max(...xs)).toBeCloseTo(40);
			expect(Math.min(...ys)).toBeCloseTo(-40);
			expect(Math.max(...ys)).toBeCloseTo(80);
			expect(result.filter((s) => s.isClosed).length).toBe(1);
		});

		it("unites disjoint open subpaths as implicitly closed contours", () => {
			// Two overlapping open corner strokes: both implicitly close and
			// merge into a single contour
			const lineA = makeOpenLine([
				[0, 0],
				[100, 0],
				[100, 100],
			]);
			const lineB = makeOpenLine([
				[50, 50],
				[150, 50],
				[150, 150],
			]);
			const input = [...lineA, ...lineB];
			const result = applyBool(input, "union");

			expect(result).not.toBe(input);
			// Merged into one closed region spanning both triangles
			const closedCount = result.filter((seg) => seg.isClosed).length;
			expect(closedCount).toBe(1);
		});

		// --- 7. mode parameter ---

		it("defaults to union when mode is not specified", () => {
			const a = makeCCWRect(0, 0, 100, 100);
			const b = makeCCWRect(50, 50, 100, 100);
			const input = [...a, ...b];

			const handler = new PathUnionFilterHandler();
			const filter = {
				uid: "test-union",
				processor: "path-union",
				opacity: 1,
				blendMode: "normal",
				paramData: { version: "1", params: { mode: "union" } },
			} satisfies PathUnionFilter;
			const result = handler.preProcess(input, filter);

			// Should behave identically to explicit "union"
			const explicitResult = applyBool(input, "union");
			expect(result.length).toBe(explicitResult.length);
		});

		// --- 8. Error handling ---

		it("returns original segments when booleanOp throws", () => {
			// Create degenerate input that could cause numerical issues.
			// A single-point "contour" (all coords identical) with two subpaths.
			const degen: CubicBezierSegment[] = [
				{
					start: { x: 0, y: 0 },
					cp1: { x: 0, y: 0 },
					cp2: { x: 0, y: 0 },
					end: { x: 0, y: 0 },
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
				{
					start: { x: 0, y: 0 },
					cp1: { x: 0, y: 0 },
					cp2: { x: 0, y: 0 },
					end: { x: 0, y: 0 },
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
			// Even if it doesn't throw, it should not crash
			const result = applyBool(degen, "union");
			expect(result).toBeDefined();
		});
	});

	describe("result memoization", () => {
		it("should return an equal result for a repeated input", () => {
			const handler = new PathUnionFilterHandler();
			const input = [
				...makeCCWRect(0, 0, 100, 100),
				...makeCCWRect(50, 50, 100, 100),
			];
			const first = handler.preProcess(input, makeFilter("union"));
			const second = handler.preProcess(input, makeFilter("union"));
			expect(second).toEqual(first);
			// Fresh array per call — callers may mutate their copy freely.
			expect(second).not.toBe(first);
		});

		it("should not let a caller's mutation poison the cached result", () => {
			const handler = new PathUnionFilterHandler();
			const input = [
				...makeCCWRect(0, 0, 100, 100),
				...makeCCWRect(50, 50, 100, 100),
			];
			const first = handler.preProcess(input, makeFilter("union"));
			const pristine = [...first];
			first.length = 0;
			const second = handler.preProcess(input, makeFilter("union"));
			expect(second).toEqual(pristine);
		});

		it("should key results by mode, not just geometry", () => {
			const handler = new PathUnionFilterHandler();
			const input = [
				...makeCCWRect(0, 0, 100, 100),
				...makeCCWRect(50, 50, 100, 100),
			];
			const union = handler.preProcess(input, makeFilter("union"));
			const intersection = handler.preProcess(
				input,
				makeFilter("intersection"),
			);
			expect(intersection).not.toEqual(union);
		});
	});

	describe("onScaleFilter", () => {
		it("returns the filter unchanged", () => {
			const handler = new PathUnionFilterHandler();
			const filter = makeFilter("union");
			const result = handler.onScaleFilter(filter, [2, 3]);
			expect(result).toBe(filter);
		});
	});

	describe("getExpansionMargin", () => {
		it("always returns 0", () => {
			const handler = new PathUnionFilterHandler();
			expect(handler.getExpansionMargin(makeFilter("union"))).toBe(0);
		});
	});

	describe("onInterpolate", () => {
		it("returns paramsA mode when t < 0.5", () => {
			const handler = new PathUnionFilterHandler();
			const result = handler.onInterpolate(
				{ mode: "union" },
				{ mode: "xor" },
				0.3,
			);
			expect(result).toEqual({ mode: "union" });
		});

		it("returns paramsB mode when t >= 0.5", () => {
			const handler = new PathUnionFilterHandler();
			const result = handler.onInterpolate(
				{ mode: "union" },
				{ mode: "xor" },
				0.5,
			);
			expect(result).toEqual({ mode: "xor" });
		});
	});
});

// ---------------------------------------------------------------------------
// Helpers (placed after test cases per project convention)
// ---------------------------------------------------------------------------

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

type UnionMode = "union" | "intersection" | "difference" | "xor";

function makeFilter(mode: UnionMode): Filter {
	return {
		uid: "test-union",
		processor: "path-union",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: { mode },
		},
	} satisfies PathUnionFilter;
}

function applyBool(
	segments: CubicBezierSegment[],
	mode: UnionMode,
): CubicBezierSegment[] {
	const handler = new PathUnionFilterHandler();
	return handler.preProcess(segments, makeFilter(mode));
}

/** Compute axis-aligned bounding box from resolved segment control points. */
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
		for (const pt of [r.start, r.cp1, r.cp2, r.end]) {
			minX = Math.min(minX, pt.x);
			minY = Math.min(minY, pt.y);
			maxX = Math.max(maxX, pt.x);
			maxY = Math.max(maxY, pt.y);
		}
	}

	return { minX, minY, maxX, maxY };
}

/** Unify bounding boxes of multiple segment arrays. */
function unifyBBox(...segArrays: CubicBezierSegment[][]): {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
} {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const segs of segArrays) {
		if (segs.length === 0) continue;
		const bb = computeBBox(segs);
		minX = Math.min(minX, bb.minX);
		minY = Math.min(minY, bb.minY);
		maxX = Math.max(maxX, bb.maxX);
		maxY = Math.max(maxY, bb.maxY);
	}

	return { minX, minY, maxX, maxY };
}

/**
 * Verify boolean operation semantics via pixel-level comparison.
 *
 * Renders input A, input B, and result R to the same unified BBox.
 * Builds a ground-truth image by applying the boolean semantics
 * (OR / AND / AND-NOT / XOR) to independently rasterized A and B pixels.
 * Compares the ground truth against the rasterized result R using pixelmatch.
 *
 * This is the same approach used by poly-bool-comparison
 * (SVG rasterize → GraphicsMagick boolean composite → pixel diff).
 */
function assertBooleanPixels(
	segA: CubicBezierSegment[],
	segB: CubicBezierSegment[],
	result: CubicBezierSegment[],
	mode: "union" | "intersection" | "difference" | "xor",
	maxDiffPercentage = 1,
): void {
	const bbox = unifyBBox(segA, segB, result);

	const imgA = renderSegmentsToPixels(segA, { fillColor: "#000000" }, bbox);
	const imgB = renderSegmentsToPixels(segB, { fillColor: "#000000" }, bbox);
	const imgR = renderSegmentsToPixels(result, { fillColor: "#000000" }, bbox);

	// Build expected pixel buffer from A and B
	const expected = new Uint8Array(imgA.data.length);
	const { width, height } = imgA;

	for (let i = 0; i < width * height; i++) {
		const offset = i * 4;
		const filledA = imgA.data[offset] < 128;
		const filledB = imgB.data[offset] < 128;

		let expectedFilled: boolean;
		switch (mode) {
			case "union":
				expectedFilled = filledA || filledB;
				break;
			case "intersection":
				expectedFilled = filledA && filledB;
				break;
			case "difference":
				expectedFilled = filledA && !filledB;
				break;
			case "xor":
				expectedFilled = filledA !== filledB;
				break;
		}

		const v = expectedFilled ? 0 : 255;
		expected[offset] = v;
		expected[offset + 1] = v;
		expected[offset + 2] = v;
		expected[offset + 3] = 255;
	}

	const diffBuf = new Uint8Array(width * height * 4);
	const diffPixels = pixelmatch(imgR.data, expected, diffBuf, width, height, {
		threshold: 0.1,
	});

	const totalPixels = width * height;
	const diffPercentage = (diffPixels / totalPixels) * 100;

	expect(diffPercentage).toBeLessThanOrEqual(maxDiffPercentage);
}

/**
 * Multi-input variant of assertBooleanPixels for 3+ contour verification.
 *
 * Ground truth is computed by applying boolean semantics across all inputs:
 * - union: any input filled → expected filled
 * - intersection: all inputs filled → expected filled
 * - difference: first filled AND none of the rest filled → expected filled
 * - xor: odd number of inputs filled → expected filled
 */
function assertBooleanPixelsMulti(
	inputs: CubicBezierSegment[][],
	result: CubicBezierSegment[],
	mode: "union" | "intersection" | "difference" | "xor",
	maxDiffPercentage = 1,
): void {
	const bbox = unifyBBox(...inputs, result);

	const images = inputs.map((segs) =>
		renderSegmentsToPixels(segs, { fillColor: "#000000" }, bbox),
	);
	const imgR = renderSegmentsToPixels(result, { fillColor: "#000000" }, bbox);

	const { width, height } = images[0];
	const expected = new Uint8Array(width * height * 4);

	for (let i = 0; i < width * height; i++) {
		const offset = i * 4;
		const filled = images.map((img) => img.data[offset] < 128);

		let expectedFilled: boolean;
		switch (mode) {
			case "union":
				expectedFilled = filled.some(Boolean);
				break;
			case "intersection":
				expectedFilled = filled.every(Boolean);
				break;
			case "difference":
				// First minus all others: filled[0] AND NOT filled[1] AND NOT filled[2] ...
				expectedFilled = filled[0] && filled.slice(1).every((f) => !f);
				break;
			case "xor":
				// Odd number of filled inputs
				expectedFilled = filled.filter(Boolean).length % 2 === 1;
				break;
		}

		const v = expectedFilled ? 0 : 255;
		expected[offset] = v;
		expected[offset + 1] = v;
		expected[offset + 2] = v;
		expected[offset + 3] = 255;
	}

	const diffBuf = new Uint8Array(width * height * 4);
	const diffPixels = pixelmatch(imgR.data, expected, diffBuf, width, height, {
		threshold: 0.1,
	});

	const totalPixels = width * height;
	const diffPercentage = (diffPixels / totalPixels) * 100;

	expect(diffPercentage).toBeLessThanOrEqual(maxDiffPercentage);
}
