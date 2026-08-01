import { describe, expect, it } from "vitest";
import type { CubicBezierSegment, Filter } from "../../schema";
import { evalCubicBezier } from "../../utils/geometry/pathSampling";
import { resolveSegment } from "../../utils/geometry/segmentOps";
import { PuckerBloatFilterHandler } from "./PuckerBloatFilterProcessor";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PuckerBloatFilterHandler", () => {
	describe("PuckerBloatFilterHandler.preProcess", () => {
		// --- 1. Basic behavior / no-ops ---

		it("returns segments unchanged when amount is 0", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const result = applyPuckerBloat(rect, 0);
			expect(result).toBe(rect);
		});

		it("returns segments unchanged when segments array is empty", () => {
			const result = applyPuckerBloat([], 0.5);
			expect(result).toEqual([]);
		});

		// --- 2. Bloat (positive amount) — closed paths ---

		it("moves anchors toward centroid for positive amount (bloat)", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const result = applyPuckerBloat(rect, 0.5);
			const anchors = extractAnchors(result);

			// Original anchors are at ±50 from center (0,0).
			// With amount=0.5, anchors move halfway to centroid (0,0).
			// So each anchor should be at ±25.
			for (const a of anchors) {
				expect(Math.abs(a.x)).toBeCloseTo(25, 0);
				expect(Math.abs(a.y)).toBeCloseTo(25, 0);
			}
		});

		it("at amount=1.0 all anchors collapse to centroid", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const result = applyPuckerBloat(rect, 1.0);
			const anchors = extractAnchors(result);

			for (const a of anchors) {
				expect(a.x).toBeCloseTo(0, 5);
				expect(a.y).toBeCloseTo(0, 5);
			}
		});

		it("moves control handles outward for positive amount (bloat)", () => {
			const circle = makeCCWCircle(0, 0, 50);
			const resultHandles = extractAbsoluteHandles(
				applyPuckerBloat(circle, 0.5),
			);
			const originalHandles = extractAbsoluteHandles(circle);

			// Handles should be further from centroid (0,0) than originals
			const origAvgDist = avgDistFromOrigin(originalHandles);
			const resultAvgDist = avgDistFromOrigin(resultHandles);
			expect(resultAvgDist).toBeGreaterThan(origAvgDist);
		});

		// --- 3. Pucker (negative amount) — closed paths ---

		it("moves anchors away from centroid for negative amount (pucker)", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const result = applyPuckerBloat(rect, -0.5);
			const bbox = computeBBox(result);

			// Anchors move outward: bbox should expand
			expect(bbox.maxX - bbox.minX).toBeGreaterThan(100);
			expect(bbox.maxY - bbox.minY).toBeGreaterThan(100);
		});

		it("at amount=-1.0 control handles collapse to centroid (star shape)", () => {
			const circle = makeCCWCircle(0, 0, 50);
			const result = applyPuckerBloat(circle, -1.0);
			const handles = extractAbsoluteHandles(result);

			// All handles should be at centroid (0,0)
			for (const h of handles) {
				expect(h.x).toBeCloseTo(0, 3);
				expect(h.y).toBeCloseTo(0, 3);
			}
		});

		// --- 4. Winding independence ---

		it("produces same result for CW and CCW rect with same amount", () => {
			const ccw = makeCCWRect(0, 0, 100, 100);
			const cw = makeCWRect(0, 0, 100, 100);
			const ccwResult = applyPuckerBloat(ccw, 0.5);
			const cwResult = applyPuckerBloat(cw, 0.5);

			// Sample both paths and verify they produce the same shape
			const ccwPoints = samplePath(ccwResult);
			const cwPoints = samplePath(cwResult);

			// Every point in CCW result should have a near neighbor in CW result
			for (const p of ccwPoints) {
				let minDist = Infinity;
				for (const q of cwPoints) {
					minDist = Math.min(minDist, Math.hypot(p.x - q.x, p.y - q.y));
				}
				expect(minDist).toBeLessThan(1);
			}
		});

		// --- 5. Circle (curved path) ---

		it("bloat on circle produces larger rendered shape", () => {
			const circle = makeCCWCircle(0, 0, 50);
			const bloated = applyPuckerBloat(circle, 0.3);

			// Anchors move inward but handles move outward more.
			// Net effect: curves bulge outward, so sampled points should extend further.
			const origPts = samplePath(circle);
			const bloatPts = samplePath(bloated);

			const origMaxDist = Math.max(...origPts.map((p) => Math.hypot(p.x, p.y)));
			const bloatMaxDist = Math.max(
				...bloatPts.map((p) => Math.hypot(p.x, p.y)),
			);
			expect(bloatMaxDist).toBeGreaterThan(origMaxDist);
		});

		it("pucker on circle produces star-like shape with varying distance from center", () => {
			const circle = makeCCWCircle(0, 0, 50);
			const puckered = applyPuckerBloat(circle, -0.5);

			const pts = samplePath(puckered);
			const dists = pts.map((p) => Math.hypot(p.x, p.y));
			const minDist = Math.min(...dists);
			const maxDist = Math.max(...dists);

			// Star shape: anchors are further out, curves dip inward
			// So min distance should be significantly less than max distance
			expect(maxDist / minDist).toBeGreaterThan(1.3);
		});

		// --- 6. Open paths ---

		it("handles open paths correctly", () => {
			const line = makeOpenLine([
				[0, 0],
				[100, 0],
				[100, 100],
			]);
			const result = applyPuckerBloat(line, 0.5);

			// Should not throw and should return same number of segments
			expect(result).toHaveLength(line.length);
			// Should not be closed
			expect(result.at(-1)?.isClosed).toBeUndefined();
		});

		it("does not close an originally open path", () => {
			const line = makeOpenLine([
				[0, 0],
				[50, 50],
			]);
			const result = applyPuckerBloat(line, 0.8);

			expect(result.at(-1)?.isClosed).toBeUndefined();
		});

		// --- 7. Multi-subpath ---

		it("processes each subpath independently with its own centroid", () => {
			// Two small squares far apart
			const sq1 = makeCCWRect(-200, 0, 20, 20);
			const sq2 = makeCCWRect(200, 0, 20, 20);
			const combined = [
				...sq1,
				...sq2.map((s, i) => ({ ...s, isMoved: i === 0 ? true : s.isMoved })),
			];

			const result = applyPuckerBloat(combined, 1.0);
			const anchors = extractAnchors(result);

			// Each closed 4-segment rect has 5 anchors (start + 4 ends).
			// At amount=1.0, all anchors collapse to their subpath's centroid.
			const sub1Anchors = anchors.slice(0, 5);
			const sub2Anchors = anchors.slice(5);

			for (const a of sub1Anchors) {
				expect(a.x).toBeCloseTo(-200, 0);
				expect(a.y).toBeCloseTo(0, 0);
			}
			for (const a of sub2Anchors) {
				expect(a.x).toBeCloseTo(200, 0);
				expect(a.y).toBeCloseTo(0, 0);
			}
		});

		// --- 8. Edge cases ---

		it("handles single-point path (all anchors at same position)", () => {
			// Degenerate: a single segment from (10,10) to (10,10)
			const segs: CubicBezierSegment[] = [
				{
					start: { x: 10, y: 10 },
					cp1: { x: 0, y: 0 },
					cp2: { x: 0, y: 0 },
					end: { x: 10, y: 10 },
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
			const result = applyPuckerBloat(segs, 0.5);

			// All points should remain at (10, 10) — centroid equals the point
			const anchors = extractAnchors(result);
			for (const a of anchors) {
				expect(a.x).toBeCloseTo(10, 5);
				expect(a.y).toBeCloseTo(10, 5);
			}
		});

		it("handles very large amount values (e.g., 2.0)", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const result = applyPuckerBloat(rect, 2.0);

			// Should not throw, all coordinates finite
			for (const seg of result) {
				expect(Number.isFinite(seg.end.x)).toBe(true);
				expect(Number.isFinite(seg.end.y)).toBe(true);
				expect(Number.isFinite(seg.cp1.x)).toBe(true);
				expect(Number.isFinite(seg.cp1.y)).toBe(true);
				expect(Number.isFinite(seg.cp2.x)).toBe(true);
				expect(Number.isFinite(seg.cp2.y)).toBe(true);
			}

			// amount=2.0: anchors overshoot past centroid
			const anchors = extractAnchors(result);
			// Original anchor at (-50,-50), centroid at (0,0)
			// New: (-50) + 2*(0-(-50)) = (-50) + 100 = 50. Flipped sign.
			for (const a of anchors) {
				expect(Math.abs(a.x)).toBeCloseTo(50, 0);
				expect(Math.abs(a.y)).toBeCloseTo(50, 0);
			}
		});

		it("preserves segment metadata (pressure, tilt, deltaTime, isMoved, isClosed)", () => {
			const rect = makeCCWRect(0, 0, 100, 100);
			const result = applyPuckerBloat(rect, 0.3);

			expect(result[0].isMoved).toBe(true);
			expect(result.at(-1)?.isClosed).toBe(true);

			for (const seg of result) {
				expect(seg.startPressure).toBe(1);
				expect(seg.endPressure).toBe(1);
				expect(seg.startTiltX).toBe(0);
				expect(seg.startTiltY).toBe(0);
				expect(seg.endTiltX).toBe(0);
				expect(seg.endTiltY).toBe(0);
				expect(seg.startDeltaTime).toBe(0);
				expect(seg.endDeltaTime).toBe(0);
			}
		});

		it("all output coordinates are finite (no NaN or Infinity)", () => {
			const circle = makeCCWCircle(0, 0, 50);
			for (const amount of [-2, -1, -0.5, 0.5, 1, 2]) {
				const result = applyPuckerBloat(circle, amount);
				for (const seg of result) {
					expect(Number.isFinite(seg.end.x)).toBe(true);
					expect(Number.isFinite(seg.end.y)).toBe(true);
					expect(Number.isFinite(seg.cp1.x)).toBe(true);
					expect(Number.isFinite(seg.cp1.y)).toBe(true);
					expect(Number.isFinite(seg.cp2.x)).toBe(true);
					expect(Number.isFinite(seg.cp2.y)).toBe(true);
				}
			}
		});
	});

	// --- 9. Animation interpolation ---

	describe("onInterpolate", () => {
		it("linearly interpolates amount", () => {
			const handler = new PuckerBloatFilterHandler();
			const result = handler.onInterpolate(
				{ amount: -1.0 },
				{ amount: 1.0 },
				0.5,
			) as { amount: number };

			expect(result.amount).toBeCloseTo(0, 5);
		});

		it("handles t outside [0,1] range", () => {
			const handler = new PuckerBloatFilterHandler();
			const result = handler.onInterpolate(
				{ amount: 0 },
				{ amount: 1.0 },
				1.5,
			) as { amount: number };

			expect(result.amount).toBeCloseTo(1.5, 5);
		});
	});
});

// ---------------------------------------------------------------------------
// Test fixtures
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

function makeFilter(amount: number): Filter {
	return {
		uid: "test-pucker-bloat",
		processor: "pucker-bloat",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: { amount },
		},
	};
}

function applyPuckerBloat(
	segments: CubicBezierSegment[],
	amount: number,
): CubicBezierSegment[] {
	const handler = new PuckerBloatFilterHandler();
	return handler.preProcess(segments, makeFilter(amount));
}

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

function extractAnchors(
	segments: CubicBezierSegment[],
): { x: number; y: number }[] {
	const anchors: { x: number; y: number }[] = [];
	for (let i = 0; i < segments.length; i++) {
		const prevEnd = i > 0 ? segments[i - 1].end : undefined;
		const r = resolveSegment(segments[i], prevEnd);
		if (segments[i].isMoved) anchors.push({ x: r.start.x, y: r.start.y });
		anchors.push({ x: r.end.x, y: r.end.y });
	}
	return anchors;
}

function extractAbsoluteHandles(
	segments: CubicBezierSegment[],
): { x: number; y: number }[] {
	const handles: { x: number; y: number }[] = [];
	for (let i = 0; i < segments.length; i++) {
		const prevEnd = i > 0 ? segments[i - 1].end : undefined;
		const r = resolveSegment(segments[i], prevEnd);
		handles.push({ x: r.cp1.x, y: r.cp1.y });
		handles.push({ x: r.cp2.x, y: r.cp2.y });
	}
	return handles;
}

function avgDistFromOrigin(points: { x: number; y: number }[]): number {
	return (
		points.reduce((sum, p) => sum + Math.hypot(p.x, p.y), 0) / points.length
	);
}

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
	const lastSeg = segments.at(-1)!;
	const prevEnd =
		segments.length > 1 ? segments[segments.length - 2].end : undefined;
	const lastR = resolveSegment(lastSeg, prevEnd);
	points.push(evalCubicBezier(lastR.start, lastR.cp1, lastR.cp2, lastR.end, 1));
	return points;
}
