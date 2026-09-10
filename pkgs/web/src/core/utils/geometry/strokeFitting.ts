/**
 * Stroke processing pipeline.
 *
 * Converts raw pointer input into optimized cubic Bézier segments using:
 * 1. Gaussian-weighted moving average for hand-tremor correction (stabilization)
 * 2. Schneider's algorithm for least-squares cubic Bézier curve fitting
 *
 * Replaces the previous RDP + Catmull-Rom pipeline which produced excessive segments
 * because RDP optimizes for polyline simplification, not Bézier curve fitting.
 */

import type { BezierPoint, CubicBezierSegment, Viewport } from "../../schema";
import { lerp } from "../math";

// Bézier Path Simplification
//
// Fits optimal cubic Bézier curves to polyline data.
//
// Algorithm and area-constrained fitting approach derived from kurbo
// by Raph Levien and contributors.
//
// Source: https://github.com/linebender/kurbo
// License: Apache-2.0 OR MIT
//   https://github.com/linebender/kurbo/blob/main/LICENSE-APACHE
//   https://github.com/linebender/kurbo/blob/main/LICENSE-MIT
// Copyright 2022 the Kurbo Authors
//
// SPDX-License-Identifier: Apache-2.0 OR MIT
//
// References:
// - Raph Levien, "Fitting cubic Bézier curves" (2021)
//   https://raphlinus.github.io/curves/2021/03/11/bezier-fitting.html
// - Raph Levien, "Simplifying Bézier paths" (2023)
//   https://raphlinus.github.io/curves/2023/04/18/bezpath-simplify.html
// - Philip Schneider, "An Algorithm for Automatically Fitting Digitized Curves"
//   (Graphics Gems, 1990)
//
// Core approach: tangent-constrained cubic fitting with signed area
// matching (Green's theorem) and recursive midpoint subdivision.

type Vec2 = { readonly x: number; readonly y: number };

export type FittedCubic = {
	readonly p0: Vec2;
	readonly p1: Vec2;
	readonly p2: Vec2;
	readonly p3: Vec2;
};

// -- Public API ---------------------------------------------------------------

/**
 * Fit cubic Bézier curves to a polyline within the given tolerance.
 *
 * @param points  Ordered polyline vertices (minimum 2)
 * @param tolerance  Maximum allowed distance from any source point
 *                   to the fitted curve (world-space units)
 * @returns Fitted cubic Bézier segments whose endpoints chain together
 */
export function fitCubicBeziers(
	points: ReadonlyArray<Vec2>,
	tolerance: number,
): FittedCubic[] {
	if (points.length < 2) return [];
	if (points.length === 2) return [makeLinear(points[0], points[1])];

	// Remove duplicate consecutive points
	const clean = dedup(points);
	if (clean.length < 2) return [];
	if (clean.length === 2) return [makeLinear(clean[0], clean[1])];

	const tHat1 = leftTangent(clean, 0);
	const tHat2 = rightTangent(clean, clean.length - 1);
	return fitImpl(clean, 0, clean.length - 1, tHat1, tHat2, tolerance, 0);
}

// -- Recursive subdivision ----------------------------------------------------

const MAX_DEPTH = 12;
const MAX_NR_ITERATIONS = 4;

function fitImpl(
	pts: ReadonlyArray<Vec2>,
	first: number,
	last: number,
	tHat1: Vec2,
	tHat2: Vec2,
	tol: number,
	depth: number,
): FittedCubic[] {
	const n = last - first + 1;

	if (n === 2) return [makeLinear(pts[first], pts[last])];

	// Heuristic: 3 points → single cubic through midpoint
	if (n === 3) {
		return [heuristic3pt(pts[first], pts[first + 1], pts[last], tHat1, tHat2)];
	}

	// Chord-length parameterization
	let u = chordLengthParam(pts, first, last);

	// Fit using area-constrained tangent fitting
	let bez = fitSingleCubic(pts, first, last, u, tHat1, tHat2);
	let { maxErr, splitIdx } = maxError(pts, first, last, bez, u);

	if (maxErr < tol) return [bez];

	// Newton-Raphson reparameterization
	if (maxErr < tol * tol && depth < MAX_DEPTH) {
		for (let iter = 0; iter < MAX_NR_ITERATIONS; iter++) {
			u = reparameterize(pts, first, last, u, bez);
			bez = fitSingleCubic(pts, first, last, u, tHat1, tHat2);
			const err = maxError(pts, first, last, bez, u);
			maxErr = err.maxErr;
			splitIdx = err.splitIdx;
			if (maxErr < tol) return [bez];
		}
	}

	if (depth >= MAX_DEPTH) return [bez];

	// Split at the point of maximum error
	const tHatC = centerTangent(pts, splitIdx);
	const left = fitImpl(
		pts,
		first,
		splitIdx,
		tHat1,
		negate(tHatC),
		tol,
		depth + 1,
	);
	const right = fitImpl(pts, splitIdx, last, tHatC, tHat2, tol, depth + 1);
	return [...left, ...right];
}

// -- Cubic fitting (Levien area-constrained + Schneider LS fallback) ----------

function fitSingleCubic(
	pts: ReadonlyArray<Vec2>,
	first: number,
	last: number,
	u: Float64Array,
	tHat1: Vec2,
	tHat2: Vec2,
): FittedCubic {
	const p0 = pts[first];
	const p3 = pts[last];
	const n = last - first + 1;

	// Schneider least-squares fitting (primary)
	// Solve for alpha1, alpha2 where:
	//   P1 = P0 + alpha1 * tHat1
	//   P2 = P3 + alpha2 * tHat2
	let c00 = 0;
	let c01 = 0;
	let c11 = 0;
	let x0 = 0;
	let x1 = 0;

	for (let i = 0; i < n; i++) {
		const t = u[i];
		const t1 = 1 - t;
		const b1 = 3 * t1 * t1 * t; // Bernstein B1,3
		const b2 = 3 * t1 * t * t; // Bernstein B2,3

		// A vectors (tangent contribution scaled by Bernstein basis)
		const a0x = tHat1.x * b1;
		const a0y = tHat1.y * b1;
		const a1x = tHat2.x * b2;
		const a1y = tHat2.y * b2;

		c00 += a0x * a0x + a0y * a0y;
		c01 += a0x * a1x + a0y * a1y;
		c11 += a1x * a1x + a1y * a1y;

		// Residual: point minus weighted baseline (endpoints only)
		const b0 = t1 * t1 * t1;
		const b3 = t * t * t;
		const pi = pts[first + i];
		const rx = pi.x - (b0 + b1) * p0.x - (b2 + b3) * p3.x;
		const ry = pi.y - (b0 + b1) * p0.y - (b2 + b3) * p3.y;

		x0 += a0x * rx + a0y * ry;
		x1 += a1x * rx + a1y * ry;
	}

	// Solve 2×2 linear system
	const det = c00 * c11 - c01 * c01;
	let alpha1: number;
	let alpha2: number;

	if (Math.abs(det) > 1e-12) {
		alpha1 = (c11 * x0 - c01 * x1) / det;
		alpha2 = (c00 * x1 - c01 * x0) / det;
	} else {
		alpha1 = 0;
		alpha2 = 0;
	}

	// Validate: negative or near-zero alphas indicate degenerate fit.
	// Use Levien's area-constrained estimation as fallback.
	const segLen = dist(p0, p3);
	const eps = 1e-6 * segLen;

	if (alpha1 < eps || alpha2 < eps) {
		return areaConstrainedFit(pts, first, last, u, tHat1, tHat2);
	}

	return {
		p0,
		p1: { x: p0.x + alpha1 * tHat1.x, y: p0.y + alpha1 * tHat1.y },
		p2: { x: p3.x + alpha2 * tHat2.x, y: p3.y + alpha2 * tHat2.y },
		p3,
	};
}

/**
 * Levien-style area-constrained fitting.
 *
 * In chord-space (P0 at origin, P3 at (1,0)):
 *   P1 = (d0·cos(th0), d0·sin(th0))
 *   P2 = (1 - d1·cos(th1), d1·sin(th1))
 *
 * Area of the cubic (Green's theorem):
 *   A = (3/20)(2·d0·sin(th0) + 2·d1·sin(th1) - d0·d1·sin(th0+th1))
 *
 * This gives d1 = f(d0). We search over d0 to minimize fitting error.
 */
function areaConstrainedFit(
	pts: ReadonlyArray<Vec2>,
	first: number,
	last: number,
	u: Float64Array,
	tHat1: Vec2,
	tHat2: Vec2,
): FittedCubic {
	const p0 = pts[first];
	const p3 = pts[last];
	const chordLen = dist(p0, p3);

	if (chordLen < 1e-12) {
		// Degenerate: endpoints overlap
		const d = chordLen / 3;
		return {
			p0,
			p1: { x: p0.x + d * tHat1.x, y: p0.y + d * tHat1.y },
			p2: { x: p3.x + d * tHat2.x, y: p3.y + d * tHat2.y },
			p3,
		};
	}

	// Transform to chord coordinate system
	const cdx = (p3.x - p0.x) / chordLen;
	const cdy = (p3.y - p0.y) / chordLen;

	// Tangent angles in chord space
	const th0 = Math.atan2(
		tHat1.x * -cdy + tHat1.y * cdx, // rotate tangent to chord frame
		tHat1.x * cdx + tHat1.y * cdy,
	);
	const th1 = Math.atan2(
		tHat2.x * -cdy + tHat2.y * cdx,
		tHat2.x * cdx + tHat2.y * cdy,
	);

	// Source polyline area in chord space (normalized by chord length²)
	const sourceArea = polylineAreaInChordSpace(
		pts,
		first,
		last,
		p0,
		cdx,
		cdy,
		chordLen,
	);

	const s0 = Math.sin(th0);
	const s1 = Math.sin(th1);
	const sSum = Math.sin(th0 + th1);
	const targetA = (20 / 3) * sourceArea;

	// d1 = (targetA - 2·d0·s0) / (2·s1 - d0·sSum)
	// Search over d0 in [0.01, 3.0] (normalized by chord length)
	const N_SEARCH = 20;
	let bestD0 = 1 / 3;
	let bestErr = Infinity;

	for (let k = 0; k <= N_SEARCH; k++) {
		const d0 = 0.01 + (k / N_SEARCH) * 2.99;
		const denom = 2 * s1 - d0 * sSum;
		if (Math.abs(denom) < 1e-10) continue;

		const d1 = (targetA - 2 * d0 * s0) / denom;
		if (d1 < 0.01) continue;

		// Construct cubic in world space
		const a1 = d0 * chordLen;
		const a2 = d1 * chordLen;
		const cubic: FittedCubic = {
			p0,
			p1: { x: p0.x + a1 * tHat1.x, y: p0.y + a1 * tHat1.y },
			p2: { x: p3.x + a2 * tHat2.x, y: p3.y + a2 * tHat2.y },
			p3,
		};

		const err = maxError(pts, first, last, cubic, u).maxErr;
		if (err < bestErr) {
			bestErr = err;
			bestD0 = d0;
		}
	}

	// Refine best d0 with golden section search
	const phi = (1 + Math.sqrt(5)) / 2;
	let lo = Math.max(0.01, bestD0 - 3 / N_SEARCH);
	let hi = Math.min(3.0, bestD0 + 3 / N_SEARCH);

	for (let iter = 0; iter < 16; iter++) {
		const m1 = hi - (hi - lo) / phi;
		const m2 = lo + (hi - lo) / phi;

		const e1 = evalD0(
			m1,
			s0,
			s1,
			sSum,
			targetA,
			chordLen,
			pts,
			first,
			last,
			u,
			tHat1,
			tHat2,
		);
		const e2 = evalD0(
			m2,
			s0,
			s1,
			sSum,
			targetA,
			chordLen,
			pts,
			first,
			last,
			u,
			tHat1,
			tHat2,
		);

		if (e1 < e2) {
			hi = m2;
		} else {
			lo = m1;
		}
	}

	const finalD0 = (lo + hi) / 2;
	const denom = 2 * s1 - finalD0 * sSum;
	const finalD1 =
		Math.abs(denom) > 1e-10
			? Math.max(0.01, (targetA - 2 * finalD0 * s0) / denom)
			: 1 / 3;

	const a1 = finalD0 * chordLen;
	const a2 = finalD1 * chordLen;
	return {
		p0,
		p1: { x: p0.x + a1 * tHat1.x, y: p0.y + a1 * tHat1.y },
		p2: { x: p3.x + a2 * tHat2.x, y: p3.y + a2 * tHat2.y },
		p3,
	};
}

function evalD0(
	d0: number,
	s0: number,
	s1: number,
	sSum: number,
	targetA: number,
	chordLen: number,
	pts: ReadonlyArray<Vec2>,
	first: number,
	last: number,
	u: Float64Array,
	tHat1: Vec2,
	tHat2: Vec2,
): number {
	const denom = 2 * s1 - d0 * sSum;
	if (Math.abs(denom) < 1e-10) return Infinity;
	const d1 = (targetA - 2 * d0 * s0) / denom;
	if (d1 < 0.01) return Infinity;

	const a1 = d0 * chordLen;
	const a2 = d1 * chordLen;
	const p0 = pts[first];
	const p3 = pts[last];
	const cubic: FittedCubic = {
		p0,
		p1: { x: p0.x + a1 * tHat1.x, y: p0.y + a1 * tHat1.y },
		p2: { x: p3.x + a2 * tHat2.x, y: p3.y + a2 * tHat2.y },
		p3,
	};
	return maxError(pts, first, last, cubic, u).maxErr;
}

// -- Source area computation --------------------------------------------------

function polylineAreaInChordSpace(
	pts: ReadonlyArray<Vec2>,
	first: number,
	last: number,
	origin: Vec2,
	cdx: number,
	cdy: number,
	chordLen: number,
): number {
	// Transform polyline to chord space and compute signed area
	// between the polyline and the x-axis using trapezoidal rule.
	let area = 0;
	for (let i = first; i < last; i++) {
		const ax = pts[i].x - origin.x;
		const ay = pts[i].y - origin.y;
		const bx = pts[i + 1].x - origin.x;
		const by = pts[i + 1].y - origin.y;

		// Rotate to chord frame and normalize
		const cx0 = (ax * cdx + ay * cdy) / chordLen;
		const cy0 = (-ax * cdy + ay * cdx) / chordLen;
		const cx1 = (bx * cdx + by * cdy) / chordLen;
		const cy1 = (-bx * cdy + by * cdx) / chordLen;

		area += (cy0 + cy1) * (cx1 - cx0) * 0.5;
	}
	return area;
}

// -- Error evaluation ---------------------------------------------------------

function maxError(
	pts: ReadonlyArray<Vec2>,
	first: number,
	last: number,
	bez: FittedCubic,
	u: Float64Array,
): { maxErr: number; splitIdx: number } {
	let maxErr = 0;
	let splitIdx = (first + last) >> 1;

	for (let i = first + 1; i < last; i++) {
		const p = evalCubic(bez, u[i - first]);
		const dx = p.x - pts[i].x;
		const dy = p.y - pts[i].y;
		const errSq = dx * dx + dy * dy;
		if (errSq > maxErr) {
			maxErr = errSq;
			splitIdx = i;
		}
	}

	return { maxErr: Math.sqrt(maxErr), splitIdx };
}

// -- Newton-Raphson reparameterization ----------------------------------------

function reparameterize(
	pts: ReadonlyArray<Vec2>,
	first: number,
	last: number,
	u: Float64Array,
	bez: FittedCubic,
): Float64Array {
	const uPrime = new Float64Array(last - first + 1);
	uPrime[0] = 0;
	uPrime[uPrime.length - 1] = 1;

	for (let i = first + 1; i < last; i++) {
		uPrime[i - first] = newtonRaphsonFind(bez, pts[i], u[i - first]);
	}
	return uPrime;
}

function newtonRaphsonFind(bez: FittedCubic, pt: Vec2, u: number): number {
	// Q(u): point on curve
	const q = evalCubic(bez, u);
	const qp = evalCubicDeriv(bez, u);
	const qpp = evalCubicDeriv2(bez, u);

	const dx = q.x - pt.x;
	const dy = q.y - pt.y;

	// f(u) = (Q(u) - P) · Q'(u)
	const num = dx * qp.x + dy * qp.y;
	// f'(u) = Q'(u)·Q'(u) + (Q(u)-P)·Q''(u)
	const den = qp.x * qp.x + qp.y * qp.y + dx * qpp.x + dy * qpp.y;

	if (Math.abs(den) < 1e-12) return u;

	const uPrime = u - num / den;
	return Math.max(0, Math.min(1, uPrime));
}

// -- Cubic evaluation ---------------------------------------------------------

function evalCubic(b: FittedCubic, t: number): Vec2 {
	const s = 1 - t;
	const s2 = s * s;
	const t2 = t * t;
	const b0 = s2 * s;
	const b1 = 3 * s2 * t;
	const b2 = 3 * s * t2;
	const b3 = t2 * t;
	return {
		x: b0 * b.p0.x + b1 * b.p1.x + b2 * b.p2.x + b3 * b.p3.x,
		y: b0 * b.p0.y + b1 * b.p1.y + b2 * b.p2.y + b3 * b.p3.y,
	};
}

function evalCubicDeriv(b: FittedCubic, t: number): Vec2 {
	const s = 1 - t;
	const c0 = 3 * s * s;
	const c1 = 6 * s * t;
	const c2 = 3 * t * t;
	return {
		x: c0 * (b.p1.x - b.p0.x) + c1 * (b.p2.x - b.p1.x) + c2 * (b.p3.x - b.p2.x),
		y: c0 * (b.p1.y - b.p0.y) + c1 * (b.p2.y - b.p1.y) + c2 * (b.p3.y - b.p2.y),
	};
}

function evalCubicDeriv2(b: FittedCubic, t: number): Vec2 {
	const s = 1 - t;
	return {
		x:
			6 * s * (b.p2.x - 2 * b.p1.x + b.p0.x) +
			6 * t * (b.p3.x - 2 * b.p2.x + b.p1.x),
		y:
			6 * s * (b.p2.y - 2 * b.p1.y + b.p0.y) +
			6 * t * (b.p3.y - 2 * b.p2.y + b.p1.y),
	};
}

// -- Parameterization ---------------------------------------------------------

function chordLengthParam(
	pts: ReadonlyArray<Vec2>,
	first: number,
	last: number,
): Float64Array {
	const n = last - first + 1;
	const u = new Float64Array(n);
	u[0] = 0;
	for (let i = 1; i < n; i++) {
		u[i] = u[i - 1] + dist(pts[first + i - 1], pts[first + i]);
	}
	const total = u[n - 1];
	if (total > 0) {
		for (let i = 1; i < n; i++) u[i] /= total;
	}
	u[n - 1] = 1;
	return u;
}

// -- Tangent computation ------------------------------------------------------

function leftTangent(pts: ReadonlyArray<Vec2>, idx: number): Vec2 {
	return normalize(sub(pts[idx + 1], pts[idx]));
}

function rightTangent(pts: ReadonlyArray<Vec2>, idx: number): Vec2 {
	return normalize(sub(pts[idx - 1], pts[idx]));
}

function centerTangent(pts: ReadonlyArray<Vec2>, idx: number): Vec2 {
	const v1 = sub(pts[idx], pts[idx - 1]);
	const v2 = sub(pts[idx + 1], pts[idx]);
	return normalize({ x: (v1.x + v2.x) * 0.5, y: (v1.y + v2.y) * 0.5 });
}

// -- Heuristic for 3-point case -----------------------------------------------

function heuristic3pt(
	p0: Vec2,
	_pMid: Vec2,
	p3: Vec2,
	tHat1: Vec2,
	tHat2: Vec2,
): FittedCubic {
	const d = dist(p0, p3) / 3;
	return {
		p0,
		p1: { x: p0.x + d * tHat1.x, y: p0.y + d * tHat1.y },
		p2: { x: p3.x + d * tHat2.x, y: p3.y + d * tHat2.y },
		p3,
	};
}

// -- Helpers ------------------------------------------------------------------

function makeLinear(a: Vec2, b: Vec2): FittedCubic {
	// Linear bezier: control points at 1/3 and 2/3
	return {
		p0: a,
		p1: { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 },
		p2: { x: b.x - (b.x - a.x) / 3, y: b.y - (b.y - a.y) / 3 },
		p3: b,
	};
}

function dedup(pts: ReadonlyArray<Vec2>): Vec2[] {
	const out: Vec2[] = [pts[0]];
	for (let i = 1; i < pts.length; i++) {
		if (distSq(pts[i], pts[i - 1]) > 1e-12) {
			out.push(pts[i]);
		}
	}
	return out;
}

function sub(a: Vec2, b: Vec2): Vec2 {
	return { x: a.x - b.x, y: a.y - b.y };
}

function negate(v: Vec2): Vec2 {
	return { x: -v.x, y: -v.y };
}

function dist(a: Vec2, b: Vec2): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return Math.sqrt(dx * dx + dy * dy);
}

function distSq(a: Vec2, b: Vec2): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return dx * dx + dy * dy;
}

function normalize(v: Vec2): Vec2 {
	const len = Math.sqrt(v.x * v.x + v.y * v.y);
	if (len < 1e-12) return { x: 1, y: 0 };
	return { x: v.x / len, y: v.y / len };
}

/** Available smoothing methods for stroke stabilization */
export type SmoothingMethod = "smooth" | "pulled-string" | "inertia";

// ---------------------------------------------------------------------------
// 1. Gaussian-weighted moving average (hand-tremor correction)
// ---------------------------------------------------------------------------

/**
 * Smooths a sequence of points using a Gaussian-weighted moving average.
 * The stabilization parameter controls smoothing strength (0 = none, 1 = strong).
 *
 * First and last points are always preserved to maintain stroke endpoint accuracy.
 * Pressure, tilt, and deltaTime are smoothed with the same kernel.
 *
 * @see https://github.com/KDE/krita/blob/master/libs/ui/tool/kis_tool_freehand_helper.cpp
 *      (Krita's "Weighted" smoothing mode uses Gaussian weighting)
 */
function gaussianSmooth(
	points: BezierPoint[],
	stabilization: number,
): BezierPoint[] {
	if (stabilization <= 0 || points.length <= 2) return points;

	const weights = gaussianKernelWeights(stabilization);
	const last = points.length - 1;
	return points.map((_point, i) => kernelMean(points, i, 0, last, weights));
}

/** Kernel weights by sample distance, `weights[d]` for d in 0..radius. */
function gaussianKernelWeights(stabilization: number): number[] {
	const sigma = stabilization * 4.0;
	const radius = Math.ceil(3 * sigma);
	const twoSigmaSq = 2 * sigma * sigma;
	const weights: number[] = [];
	for (let d = 0; d <= radius; d++) {
		weights[d] = Math.exp(-(d * d) / twoSigmaSq);
	}
	return weights;
}

/**
 * Weighted mean of the run [lo, hi] around index i, with `weights[d]` for
 * each sample distance d. The kernel runs its full width even next to an
 * end, reading points past it as the run's own trend continued (see
 * extendedSample): truncating the window instead averages only the points on
 * one side, which pulls every point near an end inward. Twist is angular
 * (0–359 wraps) and is averaged through sin/cos, not the raw degrees.
 */
function kernelMean(
	points: BezierPoint[],
	i: number,
	lo: number,
	hi: number,
	weights: readonly number[],
): BezierPoint {
	const radius = weights.length - 1;
	let sumX = 0;
	let sumY = 0;
	let sumPressure = 0;
	let sumTiltX = 0;
	let sumTiltY = 0;
	let sumTwistSin = 0;
	let sumTwistCos = 0;
	let sumDeltaTime = 0;
	let totalWeight = 0;

	for (let j = i - radius; j <= i + radius; j++) {
		const w = weights[Math.abs(j - i)];
		const p = extendedSample(points, j, lo, hi);
		sumX += p.x * w;
		sumY += p.y * w;
		sumPressure += (p.pressure ?? 0.5) * w;
		sumTiltX += (p.tiltX ?? 0) * w;
		sumTiltY += (p.tiltY ?? 0) * w;
		const twistRad = ((p.twist ?? 0) * Math.PI) / 180;
		sumTwistSin += Math.sin(twistRad) * w;
		sumTwistCos += Math.cos(twistRad) * w;
		sumDeltaTime += (p.deltaTime ?? 0) * w;
		totalWeight += w;
	}

	const twistDeg = (Math.atan2(sumTwistSin, sumTwistCos) * 180) / Math.PI;
	return {
		x: sumX / totalWeight,
		y: sumY / totalWeight,
		pressure: sumPressure / totalWeight,
		tiltX: sumTiltX / totalWeight,
		tiltY: sumTiltY / totalWeight,
		twist: ((twistDeg % 360) + 360) % 360,
		deltaTime: sumDeltaTime / totalWeight,
	};
}

/** `smoothed` with its first and last points replaced by `raw`'s. */
function withRawEnds(
	smoothed: BezierPoint[],
	raw: BezierPoint[],
): BezierPoint[] {
	if (smoothed === raw || smoothed.length === 0) return smoothed;
	const result = [...smoothed];
	result[0] = raw[0];
	result[result.length - 1] = raw[raw.length - 1];
	return result;
}

/**
 * Applies gaussianSmooth independently to each section between the given
 * corner indices ([0, ...interior, last]) so corner geometry survives:
 * section endpoints keep their raw values and the kernel window never
 * crosses a corner. Length-preserving like gaussianSmooth itself.
 */
function gaussianSmoothSections(
	points: BezierPoint[],
	cornerIdxs: number[],
	stabilization: number,
): BezierPoint[] {
	if (stabilization <= 0) return points;
	// Where the pen landed and lifted is not up for smoothing, whether the
	// run has corners or not.
	if (cornerIdxs.length <= 2) {
		return withRawEnds(gaussianSmooth(points, stabilization), points);
	}

	// Each section is smoothed on its own, so no kernel averages across a
	// corner and the turn there stays as sharp as the hand made it. The
	// corner point itself is not pinned to its raw sample, though: the pen
	// jitters at a turn like anywhere else, and a raw corner between two
	// smoothed legs stands out as a spike the fitted path travels out to and
	// back from. Each side's kernel reads its own leg continued past the
	// corner, which leaves a straight leg's endpoint exactly where it was and
	// pulls a wavering one onto its trend; the two sides then agree on one
	// position for the shared corner.
	const sections: BezierPoint[][] = [];
	for (let c = 0; c < cornerIdxs.length - 1; c++) {
		sections.push(
			gaussianSmooth(
				points.slice(cornerIdxs[c], cornerIdxs[c + 1] + 1),
				stabilization,
			),
		);
	}

	const result: BezierPoint[] = [];
	for (let c = 0; c < sections.length; c++) {
		const section = sections[c];
		if (c > 0) {
			// The corner was pushed as the previous section's last point;
			// settle it where the two sides agree, then continue past it.
			result[result.length - 1] = averagePoints(
				result[result.length - 1],
				section[0],
			);
		}
		for (let k = c === 0 ? 0 : 1; k < section.length; k++) {
			result.push(section[k]);
		}
	}
	return withRawEnds(result, points);
}

/** Midpoint of two samples, every per-point value included. */
function averagePoints(a: BezierPoint, b: BezierPoint): BezierPoint {
	const mid = (x: number | undefined, y: number | undefined) =>
		x == null || y == null ? (x ?? y) : (x + y) / 2;
	const aTwist = ((a.twist ?? 0) * Math.PI) / 180;
	const bTwist = ((b.twist ?? 0) * Math.PI) / 180;
	const twist =
		(Math.atan2(
			Math.sin(aTwist) + Math.sin(bTwist),
			Math.cos(aTwist) + Math.cos(bTwist),
		) *
			180) /
		Math.PI;
	return {
		x: (a.x + b.x) / 2,
		y: (a.y + b.y) / 2,
		pressure: mid(a.pressure, b.pressure),
		tiltX: mid(a.tiltX, b.tiltX),
		tiltY: mid(a.tiltY, b.tiltY),
		twist: ((twist % 360) + 360) % 360,
		deltaTime: mid(a.deltaTime, b.deltaTime),
	};
}

/**
 * The sample a kernel reads at index `j`, which may lie past the run's ends
 * [lo, hi].
 *
 * Past an end, position and time continue the run's own trend: the point is
 * extrapolated through the endpoint from its mirror image inside. A straight
 * leg therefore averages to exactly where it ends, and a wavering one to the
 * line it was following — where a plain mirror would hand the endpoint only
 * its interior neighbours and drag it inward. The bounded values (pressure,
 * tilt, twist) are simply mirrored; a trend has no meaning for them and an
 * extrapolation could leave their range.
 */
function extendedSample(
	points: BezierPoint[],
	j: number,
	lo: number,
	hi: number,
): BezierPoint {
	if (j >= lo && j <= hi) return points[j];
	if (hi <= lo) return points[lo];

	const end = j < lo ? lo : hi;
	const anchor = points[end];
	// The mirror image may fall beyond the run's other end on a run shorter
	// than the overshoot. Take the farthest point the run has in that
	// direction and extend the same trend proportionally, so a straight leg
	// still lands exactly on its own line however short it is.
	let inside = 2 * end - j;
	if (inside < lo) inside = lo;
	if (inside > hi) inside = hi;
	if (inside === end) return anchor;
	const mirror = points[inside];
	const reach = (j - end) / (end - inside);

	const along = (a: number | undefined, m: number | undefined) =>
		a == null || m == null ? (a ?? m) : a + (a - m) * reach;

	return {
		x: anchor.x + (anchor.x - mirror.x) * reach,
		y: anchor.y + (anchor.y - mirror.y) * reach,
		pressure: mirror.pressure,
		tiltX: mirror.tiltX,
		tiltY: mirror.tiltY,
		twist: mirror.twist,
		deltaTime: along(anchor.deltaTime, mirror.deltaTime),
	};
}

// ---------------------------------------------------------------------------
// 1b. Pulled-string smoothing
// ---------------------------------------------------------------------------

/**
 * Smooths points using the "pulled string" method.
 * The brush position follows the cursor like a string being pulled —
 * it only moves when the cursor exceeds a fixed distance (string length).
 * Produces sharp corners cleanly because the brush snaps to direction changes.
 *
 * String length = stabilization × 20 world units.
 * When stabilization is 0, returns original points unchanged.
 *
 * @see https://lazynezumi.com (Lazy Nezumi Pro's "Pulled String" mode)
 */
function pulledStringSmooth(
	points: BezierPoint[],
	stabilization: number,
): BezierPoint[] {
	if (stabilization <= 0 || points.length <= 2) return points;

	const stringLength = stabilization * 20.0;
	const result: BezierPoint[] = [points[0]];

	let anchorX = points[0].x;
	let anchorY = points[0].y;

	for (let i = 1; i < points.length; i++) {
		const dx = points[i].x - anchorX;
		const dy = points[i].y - anchorY;
		const dist = Math.sqrt(dx * dx + dy * dy);

		if (dist > stringLength) {
			// Move anchor along the string direction by (dist - stringLength)
			const move = dist - stringLength;
			anchorX += (dx / dist) * move;
			anchorY += (dy / dist) * move;

			result.push({
				x: anchorX,
				y: anchorY,
				pressure: points[i].pressure,
				tiltX: points[i].tiltX,
				tiltY: points[i].tiltY,
				twist: points[i].twist,
				deltaTime: points[i].deltaTime,
			});
		}
	}

	// Always include the endpoint for stroke completeness
	const last = points[points.length - 1];
	const lastResult = result[result.length - 1];
	if (lastResult.x !== last.x || lastResult.y !== last.y) {
		result.push(last);
	}

	return result;
}

// ---------------------------------------------------------------------------
// 1c. Inertia (spring-damper) smoothing
// ---------------------------------------------------------------------------

/**
 * Smooths points using a spring-damper (inertia) model.
 * The brush has mass and is pulled toward the cursor by a spring force,
 * with critical damping to prevent oscillation.
 * Preserves momentum from fast strokes, producing flowing calligraphic lines.
 *
 * Spring stiffness = 1 - stabilization (higher stabilization = weaker spring = more inertia).
 * When stabilization is 0, returns original points unchanged.
 *
 * @see https://lazynezumi.com (Lazy Nezumi Pro's "Inertia" mode)
 */
function inertiaSmooth(
	points: BezierPoint[],
	stabilization: number,
): BezierPoint[] {
	if (stabilization <= 0 || points.length <= 2) return points;

	// Spring parameters: higher stabilization = weaker spring = more inertia
	const stiffness = 4.0 * (1 - stabilization * 0.8); // range [0.8, 4.0]
	const damping = 2 * Math.sqrt(stiffness); // critical damping

	const result: BezierPoint[] = [points[0]];

	let posX = points[0].x;
	let posY = points[0].y;
	let velX = 0;
	let velY = 0;

	for (let i = 1; i < points.length; i++) {
		const dt = Math.min(
			((points[i].deltaTime ?? 0) - (points[i - 1].deltaTime ?? 0)) / 1000,
			0.1, // Cap dt to prevent instability
		);
		if (dt <= 0) {
			// No time delta — use simple interpolation fallback
			posX = posX + (points[i].x - posX) * 0.5;
			posY = posY + (points[i].y - posY) * 0.5;
		} else {
			// Spring-damper: F = -k*(pos - target) - c*vel
			const fx = stiffness * (points[i].x - posX) - damping * velX;
			const fy = stiffness * (points[i].y - posY) - damping * velY;

			velX += fx * dt;
			velY += fy * dt;
			posX += velX * dt;
			posY += velY * dt;
		}

		result.push({
			x: posX,
			y: posY,
			pressure: points[i].pressure,
			tiltX: points[i].tiltX,
			tiltY: points[i].tiltY,
			twist: points[i].twist,
			deltaTime: points[i].deltaTime,
		});
	}

	// Snap final point to actual endpoint
	result[result.length - 1] = points[points.length - 1];

	return result;
}

// ---------------------------------------------------------------------------
// 2. Schneider's algorithm — cubic Bézier curve fitting
// ---------------------------------------------------------------------------

/**
 * Detects corners where the angle between consecutive segments exceeds a threshold.
 * Returns indices of corner points (always includes 0 and points.length - 1).
 */
function detectCorners(
	points: BezierPoint[],
	angleThresholdDeg: number,
): number[] {
	const corners: number[] = [0];
	const cosThreshold = Math.cos((angleThresholdDeg * Math.PI) / 180);

	for (let i = 1; i < points.length - 1; i++) {
		const prev = points[i - 1];
		const curr = points[i];
		const next = points[i + 1];

		const dx1 = curr.x - prev.x;
		const dy1 = curr.y - prev.y;
		const dx2 = next.x - curr.x;
		const dy2 = next.y - curr.y;

		const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
		const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

		if (len1 < 1e-9 || len2 < 1e-9) continue;

		const dot = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
		if (dot < cosThreshold) {
			corners.push(i);
		}
	}

	corners.push(points.length - 1);
	return corners;
}

// ---------------------------------------------------------------------------
// Raw-input corner detection (span-based)
// ---------------------------------------------------------------------------

/** One-sided arc-length span used to measure the turn angle at a candidate. */
const CORNER_SPAN_DIST = 3.0;
/**
 * Index cap for span walks. Also the lookahead IncrementalStrokeFitter needs
 * before a corner decision is final: with the 0.5-unit dedupe spacing the
 * arc-length span is always satisfied well within this many indices, so a
 * decision at index i never depends on data beyond i + CORNER_MAX_SPAN_POINTS.
 */
const CORNER_MAX_SPAN_POINTS = 24;
/**
 * How many samples past a cluster's best candidate the cluster stays open.
 *
 * Candidates cluster on chord distance, so the approach to a turn and the
 * departure from it — a pixel apart in space, many samples apart along the
 * stroke — can still fall into one cluster; this bounds how far the departure
 * may trail the apex. Measured from the best candidate rather than the last:
 * a run where every sample scores as a candidate would otherwise keep the
 * cluster open for its whole length. Counting samples rather than distance
 * keeps the closing final, which the incremental fitter needs — a chord test
 * could be reopened by a stroke wandering back — and the batch detector
 * closes on the same count so both agree on where each corner lands. It is
 * also the bound on how late a corner is decided after its apex, which the
 * smoothing settlement waits out.
 */
const CORNER_CLUSTER_CLOSE_POINTS = 8;
/** Base apex-deviation gate (world units); scaled up with stabilization. */
const CORNER_MIN_DEVIATION = 0.75;
const CORNER_ANGLE_THRESHOLD_DEG = 45;

export interface RawCornerOptions {
	/** One-sided arc-length span for turn measurement (world units). */
	spanDistance?: number;
	/** Index cap for span walks (bounds the data a decision depends on). */
	maxSpanPoints?: number;
	angleThresholdDeg?: number;
	/** Minimum apex deviation from the window chord (world units). */
	minDeviation?: number;
}

/** Open non-max-suppression cluster of corner candidates. */
interface CornerCandidateGroup {
	bestIdx: number;
	bestScore: number;
	lastIdx: number;
}

/**
 * Raw-corner options with the deviation gate scaled by stabilization: the
 * stronger the requested smoothing, the larger a wiggle must be to count as
 * an intentional corner.
 */
function rawCornerOptionsFor(
	stabilization: number,
): Required<RawCornerOptions> {
	return {
		spanDistance: CORNER_SPAN_DIST,
		maxSpanPoints: CORNER_MAX_SPAN_POINTS,
		angleThresholdDeg: CORNER_ANGLE_THRESHOLD_DEG,
		minDeviation: CORNER_MIN_DEVIATION * (1 + stabilization),
	};
}

/**
 * Detects intentional corners on raw (pre-smoothing) input.
 *
 * detectCorners cannot run before smoothing (adjacent-triplet angles are
 * dominated by pointer jitter) nor after it (gaussian smoothing spreads a
 * corner's turn across the kernel window until it drops under the
 * threshold). This variant is jitter-tolerant by construction:
 *
 * 1. The turn angle at a point is measured between chords spanning
 *    `spanDistance` of arc length on each side.
 * 2. A candidate must deviate from the straight chord across its window by
 *    `minDeviation` — jitter on a straight run turns sharply but stays near
 *    the chord.
 * 3. Non-max suppression keeps only the deepest point of each candidate
 *    cluster, which is also what locates the apex.
 *
 * Returns indices shaped like detectCorners: [0, ...interior corners, last].
 */
export function detectRawCorners(
	points: BezierPoint[],
	options?: RawCornerOptions,
): number[] {
	const opts = { ...rawCornerOptionsFor(0), ...options };
	const corners: number[] = [0];
	if (points.length > 2) {
		let group: CornerCandidateGroup | null = null;
		for (let i = 1; i < points.length - 1; i++) {
			// A cluster is over once the walk is CORNER_CLUSTER_CLOSE_POINTS past
			// its best member; the incremental fitter closes on the same count,
			// so the two agree on where each corner lands. Counting from the
			// best member, not the last, is what bounds a cluster: candidates
			// that keep arriving would otherwise keep it open indefinitely.
			if (group && i - group.bestIdx > CORNER_CLUSTER_CLOSE_POINTS) {
				corners.push(group.bestIdx);
				group = null;
			}
			const score = rawCornerScoreAt(points, i, opts);
			if (score < 0) continue;
			// Cluster on CHORD distance, the same measure the scoring walks use.
			// A turn doubles the stroke back on itself, so the way in and the
			// way out are metres apart in arc while sitting on top of each
			// other in space — clustering on arc leaves one anchor per side and
			// the corner ends up carrying a pair.
			if (
				group &&
				chordDistance(points, i, group.lastIdx) <= opts.spanDistance
			) {
				if (score > group.bestScore) {
					group.bestIdx = i;
					group.bestScore = score;
				}
				group.lastIdx = i;
			} else {
				if (group) corners.push(group.bestIdx);
				group = { bestIdx: i, bestScore: score, lastIdx: i };
			}
		}
		if (group) corners.push(group.bestIdx);
	}
	corners.push(points.length - 1);
	return corners;
}

/**
 * Turn-angle score (radians) of a span-based corner candidate at index i, or
 * -1 when the point is no candidate (angle or apex-deviation gate failed).
 * Walks are capped at `maxSpanPoints` indices so the result depends only on a
 * bounded neighborhood (required for incremental confirmation to match batch
 * detection).
 */
function rawCornerScoreAt(
	points: BezierPoint[],
	i: number,
	opts: Required<RawCornerOptions>,
): number {
	if (i <= 0 || i >= points.length - 1) return -1;

	// Span walks measure CHORD distance (net displacement), not arc length:
	// a pen dwelling at a corner piles up arc from jitter alone, so an arc
	// window collapses into the dwell cluster and the measured directions
	// turn into noise (several false corner anchors per real corner). Chord
	// spans step across the dwell to real geometry.
	let j = i - 1;
	while (
		j > 0 &&
		Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) <
			opts.spanDistance &&
		i - j < opts.maxSpanPoints
	) {
		j--;
	}
	if (
		Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) <
		opts.spanDistance
	) {
		return -1;
	}

	let k = i + 1;
	while (
		k < points.length - 1 &&
		Math.hypot(points[k].x - points[i].x, points[k].y - points[i].y) <
			opts.spanDistance &&
		k - i < opts.maxSpanPoints
	) {
		k++;
	}
	if (
		Math.hypot(points[k].x - points[i].x, points[k].y - points[i].y) <
		opts.spanDistance
	) {
		return -1;
	}

	const v1x = points[i].x - points[j].x;
	const v1y = points[i].y - points[j].y;
	const v2x = points[k].x - points[i].x;
	const v2y = points[k].y - points[i].y;
	const len1 = Math.hypot(v1x, v1y);
	const len2 = Math.hypot(v2x, v2y);
	if (len1 < 1e-9 || len2 < 1e-9) return -1;
	const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
	if (dot >= Math.cos((opts.angleThresholdDeg * Math.PI) / 180)) return -1;

	// Apex deviation gate: how far the window bulges away from its chord.
	const cx = points[k].x - points[j].x;
	const cy = points[k].y - points[j].y;
	const chordLen = Math.hypot(cx, cy);
	let maxDev = 0;
	for (let m = j + 1; m < k; m++) {
		const dx = points[m].x - points[j].x;
		const dy = points[m].y - points[j].y;
		// Degenerate chord (full reversal): fall back to distance from P[j].
		const dev =
			chordLen < 1e-9
				? Math.hypot(dx, dy)
				: Math.abs(dx * cy - dy * cx) / chordLen;
		if (dev > maxDev) maxDev = dev;
	}
	if (maxDev < opts.minDeviation) return -1;

	// Score by turn angle, not by deviation: chord windows are asymmetric, and
	// an off-apex window bulges further from its chord than the apex's own, so
	// deviation-based non-max suppression drifts the anchor off the apex. The
	// turn angle peaks at the apex itself.
	return Math.acos(Math.min(Math.max(dot, -1), 1));
}

/** Straight-line distance between two points of a run. */
function chordDistance(points: BezierPoint[], a: number, b: number): number {
	return Math.hypot(points[a].x - points[b].x, points[a].y - points[b].y);
}

/** Compute chord-length parameterization for points. */
function chordLengthParameterize(points: BezierPoint[]): number[] {
	const u = new Array<number>(points.length);
	u[0] = 0;
	for (let i = 1; i < points.length; i++) {
		const dx = points[i].x - points[i - 1].x;
		const dy = points[i].y - points[i - 1].y;
		u[i] = u[i - 1] + Math.sqrt(dx * dx + dy * dy);
	}
	// Normalize to [0, 1]
	const totalLen = u[points.length - 1];
	if (totalLen > 1e-9) {
		for (let i = 1; i < points.length; i++) {
			u[i] /= totalLen;
		}
	}
	return u;
}

/** Evaluate cubic Bézier at parameter t. */
function bezierEval(
	p0x: number,
	p0y: number,
	p1x: number,
	p1y: number,
	p2x: number,
	p2y: number,
	p3x: number,
	p3y: number,
	t: number,
): [number, number] {
	const mt = 1 - t;
	const mt2 = mt * mt;
	const t2 = t * t;
	return [
		mt2 * mt * p0x + 3 * mt2 * t * p1x + 3 * mt * t2 * p2x + t2 * t * p3x,
		mt2 * mt * p0y + 3 * mt2 * t * p1y + 3 * mt * t2 * p2y + t2 * t * p3y,
	];
}

/** Evaluate cubic Bézier first derivative at parameter t. */
function bezierDerivative(
	p0x: number,
	p0y: number,
	p1x: number,
	p1y: number,
	p2x: number,
	p2y: number,
	p3x: number,
	p3y: number,
	t: number,
): [number, number] {
	const mt = 1 - t;
	return [
		3 * mt * mt * (p1x - p0x) +
			6 * mt * t * (p2x - p1x) +
			3 * t * t * (p3x - p2x),
		3 * mt * mt * (p1y - p0y) +
			6 * mt * t * (p2y - p1y) +
			3 * t * t * (p3y - p2y),
	];
}

/** Evaluate cubic Bézier second derivative at parameter t. */
function bezierSecondDerivative(
	p0x: number,
	p0y: number,
	p1x: number,
	p1y: number,
	p2x: number,
	p2y: number,
	p3x: number,
	p3y: number,
	t: number,
): [number, number] {
	return [
		6 * (1 - t) * (p2x - 2 * p1x + p0x) + 6 * t * (p3x - 2 * p2x + p1x),
		6 * (1 - t) * (p2y - 2 * p1y + p0y) + 6 * t * (p3y - 2 * p2y + p1y),
	];
}

/** Compute left tangent at start of point sequence. */
/**
 * End tangents measure direction over a minimum chord so a single noisy
 * sample next to the endpoint (dense slow-motion input, dwell jitter at a
 * corner anchor) cannot skew the fitted handle. Inputs sampled coarser than
 * the span behave exactly as the classic adjacent-point tangent.
 */
const TANGENT_SPAN_DIST = 2.0;
/**
 * Ceiling for a fitted handle, as a multiple of its segment's chord. The
 * least-squares solve has no upper bound of its own: it minimizes distance at
 * the sample points only, so a handle that overshoots between them costs it
 * nothing.
 */
const MAX_HANDLE_TO_CHORD = 1.0;
/**
 * A handle pointing against its chord by less than this share of the chord
 * is read as jitter rather than a hook: on a run this short the end tangent
 * is noise, and such a handle folds the curve back by a fraction of a pixel
 * where a hook's handle, pointing well against the chord, does not.
 */
const HANDLE_JITTER_FRACTION = 0.25;
/**
 * How many tangent spans long a chord must be before its end tangents are
 * trusted to describe a hook or a U. Tangents are read over TANGENT_SPAN_DIST
 * of input; a chord not much longer than that is a few jittered samples, and
 * a handle pointing against it is noise, not a turn.
 */
const HANDLE_TREND_SPANS = 3;

function computeLeftTangent(points: BezierPoint[]): [number, number] {
	const p0 = points[0];
	let idx = 1;
	while (
		idx < points.length - 1 &&
		Math.hypot(points[idx].x - p0.x, points[idx].y - p0.y) < TANGENT_SPAN_DIST
	) {
		idx++;
	}
	const dx = points[idx].x - p0.x;
	const dy = points[idx].y - p0.y;
	const len = Math.sqrt(dx * dx + dy * dy);
	if (len < 1e-9) return [1, 0];
	return [dx / len, dy / len];
}

/** Compute right tangent at end of point sequence. */
function computeRightTangent(points: BezierPoint[]): [number, number] {
	const n = points.length;
	const pn = points[n - 1];
	let idx = n - 2;
	while (
		idx > 0 &&
		Math.hypot(points[idx].x - pn.x, points[idx].y - pn.y) < TANGENT_SPAN_DIST
	) {
		idx--;
	}
	const dx = points[idx].x - pn.x;
	const dy = points[idx].y - pn.y;
	const len = Math.sqrt(dx * dx + dy * dy);
	if (len < 1e-9) return [-1, 0];
	return [dx / len, dy / len];
}

/** Compute center tangent at a split point. */
function computeCenterTangent(
	points: BezierPoint[],
	center: number,
): [number, number] {
	const dx = points[center - 1].x - points[center + 1].x;
	const dy = points[center - 1].y - points[center + 1].y;
	const len = Math.sqrt(dx * dx + dy * dy);
	if (len < 1e-9) return [1, 0];
	return [dx / len, dy / len];
}

const MAX_ITERATIONS = 4;

/**
 * Newton-Raphson reparameterization: improve parameter values
 * by finding nearest point on the current Bézier curve.
 *
 * @see https://lhf.impa.br/cursos/tmg/Schneider-1990.pdf (Section 4)
 * @see https://github.com/erich666/GraphicsGems/blob/master/gems/FitCurves.c
 */
function reparameterizeNewton(
	points: BezierPoint[],
	u: number[],
	p0x: number,
	p0y: number,
	p1x: number,
	p1y: number,
	p2x: number,
	p2y: number,
	p3x: number,
	p3y: number,
): number[] {
	const uPrime = new Array<number>(u.length);
	for (let i = 0; i < u.length; i++) {
		const [qx, qy] = bezierEval(p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y, u[i]);
		const [q1x, q1y] = bezierDerivative(
			p0x,
			p0y,
			p1x,
			p1y,
			p2x,
			p2y,
			p3x,
			p3y,
			u[i],
		);
		const [q2x, q2y] = bezierSecondDerivative(
			p0x,
			p0y,
			p1x,
			p1y,
			p2x,
			p2y,
			p3x,
			p3y,
			u[i],
		);

		const dx = qx - points[i].x;
		const dy = qy - points[i].y;

		const numerator = dx * q1x + dy * q1y;
		const denominator = q1x * q1x + q1y * q1y + dx * q2x + dy * q2y;

		if (Math.abs(denominator) < 1e-12) {
			uPrime[i] = u[i];
		} else {
			uPrime[i] = u[i] - numerator / denominator;
		}
	}
	return uPrime;
}

/**
 * Fit a single cubic Bézier curve to a set of points with given endpoint tangents.
 * Returns absolute control point positions [p0, p1, p2, p3].
 *
 * Uses least-squares fitting to solve for optimal control point distances (alpha1, alpha2)
 * along the given tangent directions.
 *
 * @see https://lhf.impa.br/cursos/tmg/Schneider-1990.pdf (Algorithm description)
 * @see https://github.com/erich666/GraphicsGems/blob/master/gems/FitCurves.c (GenerateBezier)
 * @see https://github.com/soswow/fit-curve (JavaScript reference implementation)
 */
function generateBezier(
	points: BezierPoint[],
	u: number[],
	tHat1: [number, number],
	tHat2: [number, number],
): [number, number, number, number, number, number, number, number] {
	const n = points.length;
	const p0x = points[0].x;
	const p0y = points[0].y;
	const p3x = points[n - 1].x;
	const p3y = points[n - 1].y;

	// Build A matrix columns and C matrix
	let c00 = 0;
	let c01 = 0;
	let c11 = 0;
	let x0 = 0;
	let x1 = 0;

	for (let i = 0; i < n; i++) {
		const t = u[i];
		const mt = 1 - t;
		const b1 = 3 * mt * mt * t;
		const b2 = 3 * mt * t * t;

		const a1x = tHat1[0] * b1;
		const a1y = tHat1[1] * b1;
		const a2x = tHat2[0] * b2;
		const a2y = tHat2[1] * b2;

		c00 += a1x * a1x + a1y * a1y;
		c01 += a1x * a2x + a1y * a2y;
		c11 += a2x * a2x + a2y * a2y;

		// tmp = point - bezier(t) using only endpoints (cp1=p0, cp2=p3 initially)
		const b0 = mt * mt * mt;
		const b3 = t * t * t;
		const tmpX = points[i].x - (b0 * p0x + b1 * p0x + b2 * p3x + b3 * p3x);
		const tmpY = points[i].y - (b0 * p0y + b1 * p0y + b2 * p3y + b3 * p3y);

		x0 += a1x * tmpX + a1y * tmpY;
		x1 += a2x * tmpX + a2y * tmpY;
	}

	// Solve 2x2 system
	const det = c00 * c11 - c01 * c01;
	const segLength = Math.sqrt(
		(p3x - p0x) * (p3x - p0x) + (p3y - p0y) * (p3y - p0y),
	);
	let alpha1: number;
	let alpha2: number;

	// Relative conditioning test. A near-straight run makes both tangents
	// almost parallel, which leaves the two columns collinear and the system
	// without a meaningful solution — but its determinant still sits far above
	// any absolute floor at world-space magnitudes, so the solved handles come
	// out arbitrarily long.
	if (Math.abs(det) < 1e-9 * c00 * c11 || !(c00 > 0 && c11 > 0)) {
		alpha1 = segLength / 3;
		alpha2 = segLength / 3;
	} else {
		alpha1 = (c11 * x0 - c01 * x1) / det;
		alpha2 = (c00 * x1 - c01 * x0) / det;
	}

	// If alpha is negative or zero, use chord-length heuristic
	const epsilon = 1e-6 * segLength;

	if (alpha1 < epsilon || alpha2 < epsilon) {
		const dist = segLength / 3;
		alpha1 = dist;
		alpha2 = dist;
	}

	alpha1 = Math.min(alpha1, segLength * MAX_HANDLE_TO_CHORD);
	alpha2 = Math.min(alpha2, segLength * MAX_HANDLE_TO_CHORD);

	// Chord-direction speed must stay positive, or the curve leaves the start,
	// overshoots and travels back — the visible fold-back on a stroke drawn in
	// one direction. With the handles' chord projections a and b, the speed
	// dips below zero exactly when segLength - a - b < -sqrt(a * b).
	if (segLength > 0) {
		const ux = (p3x - p0x) / segLength;
		const uy = (p3y - p0y) / segLength;
		const a = alpha1 * (tHat1[0] * ux + tHat1[1] * uy);
		const b = -alpha2 * (tHat2[0] * ux + tHat2[1] * uy);
		// Only handles that both point forward along the chord can produce the
		// overshoot-and-return this guards against. A handle across the chord
		// (a U) or well against it (a hook) belongs to a curve that is meant to
		// leave the chord, and rejecting it would only force extra splits —
		// but only once the chord is long enough for its end tangents to mean
		// anything. On a run of a few pixels the tangents are jitter, and a
		// handle against the chord there folds the curve back by a fraction of
		// a pixel; so is a handle only slightly against a longer chord.
		const tangentsMeaningful =
			segLength >= TANGENT_SPAN_DIST * HANDLE_TREND_SPANS;
		const backwardByJitter = (projection: number) =>
			projection < 0 &&
			(!tangentsMeaningful || -projection < segLength * HANDLE_JITTER_FRACTION);
		if (
			backwardByJitter(a) ||
			backwardByJitter(b) ||
			(a > 0 && b > 0 && segLength - a - b < -Math.sqrt(a * b))
		) {
			const dist = segLength / 3;
			alpha1 = dist;
			alpha2 = dist;
		}
	}

	return [
		p0x,
		p0y,
		p0x + tHat1[0] * alpha1,
		p0y + tHat1[1] * alpha1,
		p3x + tHat2[0] * alpha2,
		p3y + tHat2[1] * alpha2,
		p3x,
		p3y,
	];
}

/**
 * Compute maximum error between points and the fitted Bézier curve.
 * Returns [maxError, splitIndex].
 */
function computeMaxError(
	points: BezierPoint[],
	p0x: number,
	p0y: number,
	p1x: number,
	p1y: number,
	p2x: number,
	p2y: number,
	p3x: number,
	p3y: number,
	u: number[],
): [number, number] {
	let maxDist = 0;
	let splitPoint = Math.floor(points.length / 2);

	for (let i = 1; i < points.length - 1; i++) {
		const [bx, by] = bezierEval(p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y, u[i]);
		const dx = bx - points[i].x;
		const dy = by - points[i].y;
		const distSq = dx * dx + dy * dy;
		if (distSq > maxDist) {
			maxDist = distSq;
			splitPoint = i;
		}
	}

	return [maxDist, splitPoint];
}

/**
 * Recursively fit cubic Bézier curves to a sequence of points.
 *
 * Based on Schneider's algorithm: fit a single curve, check error,
 * and if the error exceeds tolerance, split at the worst point and recurse.
 *
 * @see https://lhf.impa.br/cursos/tmg/Schneider-1990.pdf
 * @see https://github.com/erich666/GraphicsGems/blob/master/gems/FitCurves.c (FitCubic)
 * @see https://github.com/soswow/fit-curve (JavaScript reference)
 */
function fitCubicBeziersImpl(
	points: BezierPoint[],
	tHat1: [number, number],
	tHat2: [number, number],
	tolerance: number,
	result: Array<
		[number, number, number, number, number, number, number, number]
	>,
): void {
	const toleranceSq = tolerance * tolerance;

	if (points.length === 2) {
		const dist =
			Math.sqrt(
				(points[1].x - points[0].x) ** 2 + (points[1].y - points[0].y) ** 2,
			) / 3;
		result.push([
			points[0].x,
			points[0].y,
			points[0].x + tHat1[0] * dist,
			points[0].y + tHat1[1] * dist,
			points[1].x + tHat2[0] * dist,
			points[1].y + tHat2[1] * dist,
			points[1].x,
			points[1].y,
		]);
		return;
	}

	let u = chordLengthParameterize(points);

	let bezier = generateBezier(points, u, tHat1, tHat2);
	let [maxErr, splitPoint] = computeMaxError(
		points,
		bezier[0],
		bezier[1],
		bezier[2],
		bezier[3],
		bezier[4],
		bezier[5],
		bezier[6],
		bezier[7],
		u,
	);

	if (maxErr < toleranceSq) {
		result.push(bezier);
		return;
	}

	// Try reparameterization to improve fit
	if (maxErr < toleranceSq * 4) {
		for (let i = 0; i < MAX_ITERATIONS; i++) {
			u = reparameterizeNewton(
				points,
				u,
				bezier[0],
				bezier[1],
				bezier[2],
				bezier[3],
				bezier[4],
				bezier[5],
				bezier[6],
				bezier[7],
			);
			bezier = generateBezier(points, u, tHat1, tHat2);
			[maxErr, splitPoint] = computeMaxError(
				points,
				bezier[0],
				bezier[1],
				bezier[2],
				bezier[3],
				bezier[4],
				bezier[5],
				bezier[6],
				bezier[7],
				u,
			);
			if (maxErr < toleranceSq) {
				result.push(bezier);
				return;
			}
		}
	}

	// Split at point of maximum error and recurse
	const tHatCenter = computeCenterTangent(points, splitPoint);
	fitCubicBeziersImpl(
		points.slice(0, splitPoint + 1),
		tHat1,
		tHatCenter,
		tolerance,
		result,
	);
	fitCubicBeziersImpl(
		points.slice(splitPoint),
		[-tHatCenter[0], -tHatCenter[1]],
		tHat2,
		tolerance,
		result,
	);
}

// ---------------------------------------------------------------------------
// 3. Main pipeline
// ---------------------------------------------------------------------------

/**
 * Find the point in `points` nearest to the Bézier endpoint for metadata lookup.
 * Uses a simple distance-based nearest-neighbor search.
 */
function findNearestPoint(
	points: BezierPoint[],
	x: number,
	y: number,
): BezierPoint {
	return points[nearestIndex(points, x, y)];
}

/**
 * Processes raw stroke points into optimized cubic Bézier segments.
 *
 * Pipeline:
 * 1. Gaussian smoothing (hand-tremor correction)
 * 2. Corner detection (split at sharp angles)
 * 3. Schneider's algorithm (least-squares cubic Bézier fitting per section)
 *
 * @param points Raw input points in world space
 * @param stabilization Smoothing strength (0 = none, 1 = maximum)
 * @param viewport Current viewport (zoom used to scale tolerance)
 * @returns Array of CubicBezierSegments with relative control point offsets
 */
export function processStroke(
	points: BezierPoint[],
	stabilization: number,
	viewport: Viewport,
	smoothingMethod: SmoothingMethod = "smooth",
): CubicBezierSegment[] {
	if (points.length < 2) return [];

	// Step 0: Remove consecutive near-duplicate points.
	// onPointerDown and the first onPointerMove often produce points at
	// nearly identical positions, creating degenerate micro-segments at the
	// stroke start.
	const minDistSq = 0.5 * 0.5; // 0.5 world units
	const deduped: BezierPoint[] = [points[0]];
	for (let i = 1; i < points.length; i++) {
		const prev = deduped[deduped.length - 1];
		const dx = points[i].x - prev.x;
		const dy = points[i].y - prev.y;
		if (dx * dx + dy * dy >= minDistSq) {
			deduped.push(points[i]);
		}
	}
	// Always keep the last point so the stroke reaches the pen-up position
	if (deduped[deduped.length - 1] !== points[points.length - 1]) {
		deduped.push(points[points.length - 1]);
	}
	if (deduped.length < 2) return [];

	// Steps 1-2: Smoothing + corner detection (method-dependent).
	// The gaussian method detects corners on the raw input first — smoothing
	// spreads a corner's turn across the kernel window, which both hides it
	// from detection and rounds the geometry — then smooths each section
	// independently so corners survive as sharp anchors (where lineJoin
	// applies).
	let smoothed: BezierPoint[];
	let corners: number[];
	switch (smoothingMethod) {
		case "pulled-string":
			smoothed = pulledStringSmooth(deduped, stabilization);
			corners = detectCorners(smoothed, 45);
			break;
		case "inertia":
			smoothed = inertiaSmooth(deduped, stabilization);
			corners = detectCorners(smoothed, 45);
			break;
		default:
			corners = detectRawCorners(deduped, rawCornerOptionsFor(stabilization));
			smoothed = gaussianSmoothSections(deduped, corners, stabilization);
			break;
	}

	// Step 3: Fit cubic Béziers to each section between corners
	// Scale tolerance by stabilization so that stabilization=0 produces near-raw input.
	const baseTolerance = stabilization <= 0 ? 0.5 : 1.0 + stabilization * 3.0;
	const tolerance = baseTolerance / viewport.zoom;
	const allBeziers: Array<
		[number, number, number, number, number, number, number, number]
	> = [];

	for (let c = 0; c < corners.length - 1; c++) {
		const section = smoothed.slice(corners[c], corners[c + 1] + 1);
		if (section.length < 2) continue;

		const tHat1 = computeLeftTangent(section);
		const tHat2 = computeRightTangent(section);
		fitCubicBeziersImpl(section, tHat1, tHat2, tolerance, allBeziers);
	}

	// Step 4: Merge what one cubic can carry, across the corner splits.
	const simplified = simplifyFittedPath(allBeziers, smoothed, tolerance);

	// Step 5: Convert absolute Bézier control points to CubicBezierSegments
	// (cp1/cp2 stored as relative offsets from anchors)
	return convertBeziersToSegments(simplified, smoothed, true);
}

// ---------------------------------------------------------------------------
// Incremental fitting (live preview)
// ---------------------------------------------------------------------------

export interface IncrementalStrokeFitterOptions {
	stabilization: number;
	zoom: number;
	smoothingMethod?: SmoothingMethod;
}

/** Force-freeze threshold: stable tail points beyond this get fitted out. */
const FITTER_TAIL_MAX_POINTS = 128;
/** Points held back from a forced freeze so the visible tail stays supple. */
const FITTER_TAIL_HOLDBACK = 16;
const FITTER_DEDUPE_DIST_SQ = 0.5 * 0.5;

/**
 * Incremental variant of processStroke for live drawing: sections behind the
 * last settled corner (or beyond the tail window) are fitted once and frozen;
 * every push only re-smooths and re-fits the tail. The committed stroke is
 * still produced by the full processStroke — this class only serves the
 * preview, so its output may differ from the final fit in the tail region.
 */
export class IncrementalStrokeFitter {
	/** Points touched by the last push+getSegments cycle (instrumentation). */
	public lastProcessedPoints = 0;

	private readonly stabilization: number;
	private readonly tolerance: number;
	private readonly method: SmoothingMethod;
	private readonly gaussianRadius: number;
	/** Kernel weights by sample distance (see gaussianKernelWeights). */
	private readonly kernelWeights: readonly number[];
	/** Corner detection options; fixed for the stroke's stabilization. */
	private readonly rawCornerOptions: Required<RawCornerOptions>;

	/** Deduped raw input. */
	private readonly deduped: BezierPoint[] = [];
	/** Raw last point that fell under the dedupe threshold. */
	private floatingLast: BezierPoint | null = null;

	/**
	 * Smoothed points. Causal methods (pulled-string/inertia) append final
	 * values; gaussian entries are final only below stableSmoothedCount.
	 */
	private readonly smoothed: BezierPoint[] = [];
	private stableSmoothedCount = 0;

	// Causal smoother state.
	private pulledAnchorX = 0;
	private pulledAnchorY = 0;
	private inertiaPosX = 0;
	private inertiaPosY = 0;
	private inertiaVelX = 0;
	private inertiaVelY = 0;

	private frozen: CubicBezierSegment[] = [];
	/** Smoothed index where the live tail begins (= last freeze boundary). */
	private tailStart = 0;
	/** Highest smoothed index already checked for a freezable corner. */
	private cornerCheckedUpTo = 0;

	// Raw-corner state (gaussian method only; mirrors detectRawCorners).
	/** Confirmed raw-corner indices (deduped index space), ascending. */
	private readonly rawCorners: number[] = [];
	/** Highest deduped index whose corner candidacy is decided. */
	private rawCornerCheckedUpTo = 0;
	/** Open candidate cluster still awaiting non-max suppression. */
	private pendingCornerGroup: CornerCandidateGroup | null = null;
	/** rawCorners entries already consumed as freeze boundaries. */
	private frozenCornerCount = 0;

	private cachedSegments: CubicBezierSegment[] | null = null;

	public constructor(options: IncrementalStrokeFitterOptions) {
		this.stabilization = options.stabilization;
		this.method = options.smoothingMethod ?? "smooth";
		const baseTolerance =
			options.stabilization <= 0 ? 0.5 : 1.0 + options.stabilization * 3.0;
		this.tolerance = baseTolerance / options.zoom;
		this.gaussianRadius =
			this.method === "smooth" && options.stabilization > 0
				? Math.ceil(3 * options.stabilization * 4.0)
				: 0;
		this.kernelWeights =
			this.gaussianRadius > 0
				? gaussianKernelWeights(options.stabilization)
				: [1];
		this.rawCornerOptions = rawCornerOptionsFor(options.stabilization);
	}

	public get frozenSegmentCount(): number {
		return this.frozen.length;
	}

	public push(point: BezierPoint): void {
		this.cachedSegments = null;
		this.lastProcessedPoints = 0;

		const prev = this.deduped[this.deduped.length - 1];
		if (prev) {
			const dx = point.x - prev.x;
			const dy = point.y - prev.y;
			if (dx * dx + dy * dy < FITTER_DEDUPE_DIST_SQ) {
				this.floatingLast = point;
				return;
			}
		}
		this.floatingLast = null;
		this.deduped.push(point);
		// Corner decisions must precede smoothing settlement: a settled kernel
		// window must never gain a section boundary afterwards.
		if (this.method === "smooth") this.confirmRawCorners();
		this.appendSmoothed(point);
		this.maybeFreeze();
	}

	public getSegments(): CubicBezierSegment[] {
		if (this.cachedSegments) return this.cachedSegments;

		const tailPts = this.buildTailPoints();
		this.lastProcessedPoints += tailPts.length;
		// Time-knot subdivision keeps the live tail's speed readable: one fit
		// over the whole tail would linearize its timing and flatten
		// speed-driven brush width until the next freeze.
		const tail =
			tailPts.length >= 2
				? subdivideSegmentsAtTimeKnots(
						fitPointSequence(tailPts, this.tolerance, this.frozen.length === 0),
						tailPts,
					)
				: [];
		this.cachedSegments = [...this.frozen, ...tail];
		return this.cachedSegments;
	}

	// --- smoothing ---------------------------------------------------------

	private appendSmoothed(point: BezierPoint): void {
		if (this.stabilization <= 0) {
			this.smoothed.push(point);
			this.stableSmoothedCount = this.smoothed.length;
			this.lastProcessedPoints += 1;
			return;
		}

		switch (this.method) {
			case "pulled-string": {
				if (this.smoothed.length === 0) {
					this.smoothed.push(point);
					this.pulledAnchorX = point.x;
					this.pulledAnchorY = point.y;
				} else {
					const stringLength = this.stabilization * 20.0;
					const dx = point.x - this.pulledAnchorX;
					const dy = point.y - this.pulledAnchorY;
					const dist = Math.sqrt(dx * dx + dy * dy);
					if (dist > stringLength) {
						const move = dist - stringLength;
						this.pulledAnchorX += (dx / dist) * move;
						this.pulledAnchorY += (dy / dist) * move;
						this.smoothed.push({
							x: this.pulledAnchorX,
							y: this.pulledAnchorY,
							pressure: point.pressure,
							tiltX: point.tiltX,
							tiltY: point.tiltY,
							twist: point.twist,
							deltaTime: point.deltaTime,
						});
					}
				}
				this.stableSmoothedCount = this.smoothed.length;
				this.lastProcessedPoints += 1;
				break;
			}
			case "inertia": {
				if (this.smoothed.length === 0) {
					this.smoothed.push(point);
					this.inertiaPosX = point.x;
					this.inertiaPosY = point.y;
				} else {
					const stiffness = 4.0 * (1 - this.stabilization * 0.8);
					const damping = 2 * Math.sqrt(stiffness);
					const prevRaw = this.deduped[this.deduped.length - 2];
					const dt = Math.min(
						((point.deltaTime ?? 0) - (prevRaw?.deltaTime ?? 0)) / 1000,
						0.1,
					);
					if (dt <= 0) {
						this.inertiaPosX += (point.x - this.inertiaPosX) * 0.5;
						this.inertiaPosY += (point.y - this.inertiaPosY) * 0.5;
					} else {
						const fx =
							stiffness * (point.x - this.inertiaPosX) -
							damping * this.inertiaVelX;
						const fy =
							stiffness * (point.y - this.inertiaPosY) -
							damping * this.inertiaVelY;
						this.inertiaVelX += fx * dt;
						this.inertiaVelY += fy * dt;
						this.inertiaPosX += this.inertiaVelX * dt;
						this.inertiaPosY += this.inertiaVelY * dt;
					}
					this.smoothed.push({
						x: this.inertiaPosX,
						y: this.inertiaPosY,
						pressure: point.pressure,
						tiltX: point.tiltX,
						tiltY: point.tiltY,
						twist: point.twist,
						deltaTime: point.deltaTime,
					});
				}
				this.stableSmoothedCount = this.smoothed.length;
				this.lastProcessedPoints += 1;
				break;
			}
			default: {
				// Gaussian: entries within `radius` of the end still shift as
				// points arrive. Settle every index whose full kernel window is
				// now in the past — held back beyond the radius by how late a
				// corner can be decided (its scoring lookahead plus the cluster
				// close window), so every corner a settling window could touch
				// is already decided.
				this.smoothed.push(point);
				const settleUpTo =
					this.deduped.length -
					1 -
					this.gaussianRadius -
					CORNER_MAX_SPAN_POINTS -
					CORNER_CLUSTER_CLOSE_POINTS;
				for (let i = this.stableSmoothedCount; i < settleUpTo; i++) {
					this.smoothed[i] = this.gaussianAt(i);
					this.lastProcessedPoints += 1;
				}
				this.stableSmoothedCount = Math.max(
					this.stableSmoothedCount,
					settleUpTo,
				);
				break;
			}
		}
	}

	/** Gaussian-smoothed value of deduped[i] (index 0 passes through). */
	private gaussianAt(i: number): BezierPoint {
		const points = this.deduped;
		const last = points.length - 1;
		if (i === 0 || i === last) return points[i];

		// The section between confirmed corners that holds i, and the corner
		// before it (mirrors gaussianSmoothSections).
		let sectionLo = 0;
		let sectionHi = last;
		let previousLo = 0;
		for (let c = this.rawCorners.length - 1; c >= 0; c--) {
			const cornerIdx = this.rawCorners[c];
			if (cornerIdx <= i) {
				sectionLo = cornerIdx;
				previousLo = c > 0 ? this.rawCorners[c - 1] : 0;
				break;
			}
			sectionHi = cornerIdx;
		}

		// A corner belongs to both of its sections. Each side smooths it with
		// its own leg only — a straight leg leaves it where it is, a wavering
		// one pulls it onto the leg's trend — and the two sides then agree on
		// one position, as gaussianSmoothSections does on commit.
		if (i === sectionLo && i > 0) {
			return averagePoints(
				kernelMean(points, i, previousLo, i, this.kernelWeights),
				kernelMean(points, i, i, sectionHi, this.kernelWeights),
			);
		}
		return kernelMean(points, i, sectionLo, sectionHi, this.kernelWeights);
	}

	// --- raw corners -------------------------------------------------------

	/**
	 * Advance raw-corner detection over indices whose bounded lookahead
	 * window is fully available, mirroring detectRawCorners' candidate and
	 * non-max-suppression logic so confirmed corners match the batch result.
	 */
	private confirmRawCorners(): void {
		const opts = this.rawCornerOptions;
		const decidableUpTo = this.deduped.length - 1 - opts.maxSpanPoints;
		for (
			let i = Math.max(this.rawCornerCheckedUpTo + 1, 1);
			i <= decidableUpTo;
			i++
		) {
			// Same closing rule as detectRawCorners, so preview and commit
			// place each corner at the same sample.
			if (
				this.pendingCornerGroup &&
				i - this.pendingCornerGroup.bestIdx > CORNER_CLUSTER_CLOSE_POINTS
			) {
				this.rawCorners.push(this.pendingCornerGroup.bestIdx);
				this.pendingCornerGroup = null;
			}
			const score = rawCornerScoreAt(this.deduped, i, opts);
			const group = this.pendingCornerGroup;
			if (score >= 0) {
				if (
					group &&
					chordDistance(this.deduped, i, group.lastIdx) <= opts.spanDistance
				) {
					if (score > group.bestScore) {
						group.bestIdx = i;
						group.bestScore = score;
					}
					group.lastIdx = i;
				} else {
					if (group) this.rawCorners.push(group.bestIdx);
					this.pendingCornerGroup = {
						bestIdx: i,
						bestScore: score,
						lastIdx: i,
					};
				}
			}
			this.rawCornerCheckedUpTo = i;
			this.lastProcessedPoints += 1;
		}
	}

	// --- freezing ----------------------------------------------------------

	private maybeFreeze(): void {
		// Corner freeze: a confirmed corner is a section boundary for the
		// commit fit too, so the frozen prefix shares its anchors with the
		// committed path up to whatever the commit's merge pass folds away.
		if (this.method === "smooth") {
			while (this.frozenCornerCount < this.rawCorners.length) {
				const idx = this.rawCorners[this.frozenCornerCount];
				// Everything up to the corner must be settled before fitting.
				if (idx >= this.stableSmoothedCount) break;
				if (idx > this.tailStart) this.freezeUpTo(idx);
				this.frozenCornerCount++;
			}
		} else {
			const checkLimit = this.stableSmoothedCount - 1;
			for (let i = Math.max(this.cornerCheckedUpTo, 1); i < checkLimit; i++) {
				if (isCornerAt(this.smoothed, i) && i > this.tailStart) {
					this.freezeUpTo(i);
				}
			}
			this.cornerCheckedUpTo = Math.max(this.cornerCheckedUpTo, checkLimit);
		}

		// Forced freeze keeps the tail bounded on corner-less strokes. The
		// split is an artificial anchor (C0-continuous with the next fit).
		if (this.stableSmoothedCount - this.tailStart > FITTER_TAIL_MAX_POINTS) {
			this.freezeUpTo(this.stableSmoothedCount - 1 - FITTER_TAIL_HOLDBACK);
		}
	}

	private freezeUpTo(index: number): void {
		if (index <= this.tailStart) return;
		const section = this.smoothed.slice(this.tailStart, index + 1);
		this.lastProcessedPoints += section.length;
		// Subdivided once here, then immutable — the live dab accumulator's
		// frozen prefix keeps stable segment identities.
		const fitted = subdivideSegmentsAtTimeKnots(
			fitPointSequence(section, this.tolerance, this.frozen.length === 0),
			section,
		);
		this.frozen = [...this.frozen, ...fitted];
		this.tailStart = index;
	}

	// --- tail --------------------------------------------------------------

	private buildTailPoints(): BezierPoint[] {
		const tail = this.smoothed.slice(this.tailStart);

		if (this.method === "smooth" && this.stabilization > 0) {
			// Re-smooth the unsettled window; the raw endpoint stays exact
			// (processStroke preserves endpoints the same way).
			const len = this.deduped.length;
			for (let k = 0; k < tail.length; k++) {
				const i = this.tailStart + k;
				if (i < this.stableSmoothedCount) continue;
				tail[k] = i === len - 1 ? this.deduped[i] : this.gaussianAt(i);
				this.lastProcessedPoints += 1;
			}
		} else if (this.method === "inertia" && tail.length > 0) {
			// Snap the visible endpoint to the raw position (processStroke's
			// final-point behavior) without disturbing the smoother state.
			const rawLast = this.deduped[this.deduped.length - 1];
			if (rawLast) tail[tail.length - 1] = rawLast;
		} else if (this.method === "pulled-string") {
			const rawLast = this.deduped[this.deduped.length - 1];
			const lastSmoothed = tail[tail.length - 1];
			if (
				rawLast &&
				lastSmoothed &&
				(lastSmoothed.x !== rawLast.x || lastSmoothed.y !== rawLast.y)
			) {
				tail.push(rawLast);
			}
		}

		if (this.floatingLast) tail.push(this.floatingLast);
		return tail;
	}
}

/** Max time knots inserted per subdivided section. */
const TIME_KNOT_MAX = 16;
/** Deviation from the section-linear time schedule that earns a knot (ms). */
const TIME_KNOT_TOLERANCE_MS = 8;

/**
 * Subdivide fitted segments at points where the input's timing deviates from
 * the segments' endpoint-linear time schedule. The geometry is unchanged (de
 * Casteljau splits); only the anchors' time/pressure resolution grows, so the
 * dab evaluator can read real speed instead of a whole-fit average. Serves
 * the live preview — committed strokes carry their speed in the baked
 * strokeWidths profile and stay unsplit (extra stored anchors would surface
 * in path editing).
 */
export function subdivideSegmentsAtTimeKnots(
	segments: CubicBezierSegment[],
	sourcePoints: BezierPoint[],
): CubicBezierSegment[] {
	if (segments.length === 0 || sourcePoints.length < 3) return segments;
	// Multi-subpath fits have no single arc mapping; skip (pen strokes are one).
	for (let i = 1; i < segments.length; i++) {
		if (segments[i].isMoved) return segments;
	}

	// Source arc-length / time table.
	const arcs = new Float64Array(sourcePoints.length);
	for (let i = 1; i < sourcePoints.length; i++) {
		arcs[i] =
			arcs[i - 1] +
			Math.hypot(
				sourcePoints[i].x - sourcePoints[i - 1].x,
				sourcePoints[i].y - sourcePoints[i - 1].y,
			);
	}
	const totalArc = arcs[arcs.length - 1];
	if (totalArc <= 0) return segments;

	const knotIndices = pickTimeKnotIndices(arcs, sourcePoints);
	if (knotIndices.length === 0) return segments;

	// Resolve fitted segments to absolute cubics + their arc spans.
	const abs: Array<
		[number, number, number, number, number, number, number, number]
	> = [];
	const segLens: number[] = [];
	let totalFit = 0;
	{
		// A fit chunk's first segment may omit `start` (it chains from the
		// previous chunk's end anchor, which equals the section's first source
		// point — Schneider fits interpolate their endpoints).
		let px = sourcePoints[0].x;
		let py = sourcePoints[0].y;
		for (const segment of segments) {
			const sx = segment.start?.x ?? px;
			const sy = segment.start?.y ?? py;
			const cubic: [
				number,
				number,
				number,
				number,
				number,
				number,
				number,
				number,
			] = [
				sx,
				sy,
				sx + segment.cp1.x,
				sy + segment.cp1.y,
				segment.end.x + segment.cp2.x,
				segment.end.y + segment.cp2.y,
				segment.end.x,
				segment.end.y,
			];
			abs.push(cubic);
			const len = sampledCubicLength(cubic);
			segLens.push(len);
			totalFit += len;
			px = segment.end.x;
			py = segment.end.y;
		}
	}
	if (totalFit <= 0) return segments;

	const result: CubicBezierSegment[] = [];
	let knotCursor = 0;
	let cumFit = 0;
	for (let si = 0; si < segments.length; si++) {
		const segment = segments[si];
		const segStart = cumFit;
		const segEnd = cumFit + segLens[si];
		cumFit = segEnd;

		// Knots strictly inside this segment's arc span (fraction space).
		const cuts: Array<{ localT: number; point: BezierPoint }> = [];
		while (knotCursor < knotIndices.length) {
			const src = sourcePoints[knotIndices[knotCursor]];
			const target = (arcs[knotIndices[knotCursor]] / totalArc) * totalFit;
			if (target >= segEnd - 1e-6) break;
			knotCursor++;
			if (target <= segStart + 1e-6 || segLens[si] <= 1e-6) continue;
			cuts.push({
				localT: cubicParamAtArcLength(abs[si], target - segStart),
				point: src,
			});
		}
		if (cuts.length === 0) {
			result.push(segment);
			continue;
		}

		// Split into pieces at ascending params; renormalize into the remainder.
		let remainder = abs[si];
		let prevT = 0;
		const pieces: Array<{
			cubic: [number, number, number, number, number, number, number, number];
			endPoint: BezierPoint | null;
			endFraction: number;
		}> = [];
		for (const cut of cuts) {
			const relT = (cut.localT - prevT) / Math.max(1 - prevT, 1e-9);
			const [head, tailPart] = splitAbsCubic(
				remainder,
				Math.min(Math.max(relT, 0), 1),
			);
			pieces.push({
				cubic: head,
				endPoint: cut.point,
				endFraction: cut.localT,
			});
			remainder = tailPart;
			prevT = cut.localT;
		}
		pieces.push({ cubic: remainder, endPoint: null, endFraction: 1 });

		let pieceStartPressure = segment.startPressure;
		let pieceStartTime = segment.startDeltaTime;
		let pieceStartFraction = 0;
		for (let pi = 0; pi < pieces.length; pi++) {
			const piece = pieces[pi];
			const isFirst = pi === 0;
			const isLast = pi === pieces.length - 1;
			const endFraction = piece.endFraction;
			result.push({
				start:
					isFirst && segment.start
						? { x: piece.cubic[0], y: piece.cubic[1] }
						: undefined,
				cp1: {
					x: piece.cubic[2] - piece.cubic[0],
					y: piece.cubic[3] - piece.cubic[1],
				},
				cp2: {
					x: piece.cubic[4] - piece.cubic[6],
					y: piece.cubic[5] - piece.cubic[7],
				},
				end: { x: piece.cubic[6], y: piece.cubic[7] },
				isMoved: isFirst ? segment.isMoved : false,
				isClosed: isLast ? segment.isClosed : undefined,
				startPressure: pieceStartPressure,
				endPressure: isLast
					? segment.endPressure
					: (piece.endPoint?.pressure ?? segment.endPressure),
				startDeltaTime: pieceStartTime,
				endDeltaTime: isLast
					? segment.endDeltaTime
					: (piece.endPoint?.deltaTime ?? segment.endDeltaTime),
				startTiltX: lerp(
					segment.startTiltX,
					segment.endTiltX,
					pieceStartFraction,
				),
				startTiltY: lerp(
					segment.startTiltY,
					segment.endTiltY,
					pieceStartFraction,
				),
				endTiltX: lerp(segment.startTiltX, segment.endTiltX, endFraction),
				endTiltY: lerp(segment.startTiltY, segment.endTiltY, endFraction),
				startTwist: segment.startTwist,
				endTwist: isLast ? segment.endTwist : segment.startTwist,
			});
			pieceStartPressure = isLast
				? segment.endPressure
				: (piece.endPoint?.pressure ?? segment.endPressure);
			pieceStartTime = isLast
				? segment.endDeltaTime
				: (piece.endPoint?.deltaTime ?? segment.endDeltaTime);
			pieceStartFraction = endFraction;
		}
	}
	return result;
}

/**
 * Indices of source points whose time deviates most from the endpoint-linear
 * schedule (greedy max-error refinement, same shape as the profile
 * simplification in strokeHalfWidth). Ascending order, capped at
 * TIME_KNOT_MAX by keeping the largest deviations.
 */
function pickTimeKnotIndices(
	arcs: Float64Array,
	points: BezierPoint[],
): number[] {
	const last = points.length - 1;
	const chosen: Array<{ idx: number; error: number }> = [];
	const stack: Array<[number, number]> = [[0, last]];
	while (stack.length > 0) {
		const [a, b] = stack.pop()!;
		if (b - a < 2) continue;
		const arcSpan = arcs[b] - arcs[a];
		if (arcSpan <= 1e-9) continue;
		const timeA = points[a].deltaTime ?? 0;
		const timeB = points[b].deltaTime ?? 0;
		let worst = -1;
		let worstError = TIME_KNOT_TOLERANCE_MS;
		for (let i = a + 1; i < b; i++) {
			const f = (arcs[i] - arcs[a]) / arcSpan;
			const error = Math.abs(
				(points[i].deltaTime ?? 0) - (timeA + (timeB - timeA) * f),
			);
			if (error > worstError) {
				worstError = error;
				worst = i;
			}
		}
		if (worst >= 0) {
			chosen.push({ idx: worst, error: worstError });
			stack.push([a, worst], [worst, b]);
		}
	}
	return chosen
		.sort((a, b) => b.error - a.error)
		.slice(0, TIME_KNOT_MAX)
		.map((entry) => entry.idx)
		.sort((a, b) => a - b);
}

/** Arc length of an absolute cubic via 32-step polyline sampling. */
function sampledCubicLength(
	c: [number, number, number, number, number, number, number, number],
): number {
	let len = 0;
	let px = c[0];
	let py = c[1];
	for (let i = 1; i <= 32; i++) {
		const t = i / 32;
		const [x, y] = evalAbsCubic(c, t);
		len += Math.hypot(x - px, y - py);
		px = x;
		py = y;
	}
	return len;
}

/** Curve parameter whose sampled arc length from t=0 reaches `target`. */
function cubicParamAtArcLength(
	c: [number, number, number, number, number, number, number, number],
	target: number,
): number {
	let len = 0;
	let px = c[0];
	let py = c[1];
	for (let i = 1; i <= 32; i++) {
		const t = i / 32;
		const [x, y] = evalAbsCubic(c, t);
		const step = Math.hypot(x - px, y - py);
		if (len + step >= target) {
			const f = step > 1e-9 ? (target - len) / step : 0;
			return (i - 1 + f) / 32;
		}
		len += step;
		px = x;
		py = y;
	}
	return 1;
}

function evalAbsCubic(
	c: [number, number, number, number, number, number, number, number],
	t: number,
): [number, number] {
	const u = 1 - t;
	const a = u * u * u;
	const b = 3 * u * u * t;
	const d = 3 * u * t * t;
	const e = t * t * t;
	return [
		a * c[0] + b * c[2] + d * c[4] + e * c[6],
		a * c[1] + b * c[3] + d * c[5] + e * c[7],
	];
}

/** De Casteljau split of an absolute cubic at parameter t. */
function splitAbsCubic(
	c: [number, number, number, number, number, number, number, number],
	t: number,
): [
	[number, number, number, number, number, number, number, number],
	[number, number, number, number, number, number, number, number],
] {
	const mix = (ax: number, ay: number, bx: number, by: number) =>
		[ax + (bx - ax) * t, ay + (by - ay) * t] as const;
	const [abx, aby] = mix(c[0], c[1], c[2], c[3]);
	const [bcx, bcy] = mix(c[2], c[3], c[4], c[5]);
	const [cdx, cdy] = mix(c[4], c[5], c[6], c[7]);
	const [abcx, abcy] = mix(abx, aby, bcx, bcy);
	const [bcdx, bcdy] = mix(bcx, bcy, cdx, cdy);
	const [mx, my] = mix(abcx, abcy, bcdx, bcdy);
	return [
		[c[0], c[1], abx, aby, abcx, abcy, mx, my],
		[mx, my, bcdx, bcdy, cdx, cdy, c[6], c[7]],
	];
}

/** detectCorners' predicate for a single interior index. */
function isCornerAt(points: BezierPoint[], i: number): boolean {
	if (i <= 0 || i >= points.length - 1) return false;
	const prev = points[i - 1];
	const curr = points[i];
	const next = points[i + 1];
	const dx1 = curr.x - prev.x;
	const dy1 = curr.y - prev.y;
	const dx2 = next.x - curr.x;
	const dy2 = next.y - curr.y;
	const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
	const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
	if (len1 < 1e-9 || len2 < 1e-9) return false;
	const dot = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
	return dot < Math.cos((45 * Math.PI) / 180);
}

/**
 * Corner-split + Schneider fit for one point run (processStroke steps 2-3),
 * converted with section-scoped metadata.
 */
function fitPointSequence(
	points: BezierPoint[],
	tolerance: number,
	isFirstOfPath: boolean,
): CubicBezierSegment[] {
	if (points.length < 2) return [];
	const corners = detectCorners(points, 45);
	const beziers: Array<
		[number, number, number, number, number, number, number, number]
	> = [];
	for (let c = 0; c < corners.length - 1; c++) {
		const section = points.slice(corners[c], corners[c + 1] + 1);
		if (section.length < 2) continue;
		fitCubicBeziersImpl(
			section,
			computeLeftTangent(section),
			computeRightTangent(section),
			tolerance,
			beziers,
		);
	}
	return convertBeziersToSegments(beziers, points, isFirstOfPath);
}

type AbsoluteCubic = [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
];

/**
 * Final pass over the fitted path: merge neighbouring cubics wherever one
 * cubic can carry both within the fit's own tolerance.
 *
 * Two things put anchors on a stroke that its shape does not call for. The
 * corner detector reads a hand wavering into a turn as several corners, and
 * every corner is a forced section boundary — on a wavy line the crests come
 * out studded with anchors. Then Schneider splits a section whenever it
 * misses the tolerance and never reconsiders, so a stretch that needed three
 * curves early in the recursion keeps all three once the later splits have
 * left each one nearly straight.
 *
 * This pass decides by geometry alone, across section boundaries: a merge is
 * kept when the merged curve stays within tolerance of the input points it
 * spans, unless the two cubics meet at a corner-sized turn (mergeAllowed).
 * The tolerance test on its own cannot tell a deliberate corner from a
 * wobble once the legs are short enough for one cubic to pass within
 * tolerance of both, so the turn the smoothing preserved is what decides.
 * The error is always measured against the original input, never against
 * the curves being replaced, so repeated merges cannot drift.
 *
 * Every surviving anchor is still an input point, so pressure, tilt, twist
 * and time at the anchors are read back from the input exactly (see
 * convertBeziersToSegments). Between anchors the width profile is what
 * carries pressure and speed, and PenTool bakes that from the raw points
 * independently of how many segments the geometry ends up with.
 */
function simplifyFittedPath(
	beziers: AbsoluteCubic[],
	points: BezierPoint[],
	tolerance: number,
): AbsoluteCubic[] {
	if (beziers.length < 2) return beziers;

	// Schneider interpolates its endpoints, so every anchor is one of the
	// input points and each cubic covers a contiguous index range of them.
	const result = [...beziers];
	const ranges = result.map((cubic) => [
		nearestIndex(points, cubic[0], cubic[1]),
		nearestIndex(points, cubic[6], cubic[7]),
	]);

	let merged = true;
	while (merged) {
		merged = false;
		for (let i = 0; i < result.length - 1; ) {
			const [aStart, aEnd] = ranges[i];
			const [bStart, bEnd] = ranges[i + 1];
			const contiguous = aStart < aEnd && aEnd === bStart && bStart < bEnd;
			const candidate =
				contiguous && mergeAllowed(result[i], result[i + 1])
					? fitAcross(points, aStart, bEnd, result[i], result[i + 1], tolerance)
					: null;
			if (!candidate) {
				i++;
				continue;
			}
			result.splice(i, 2, candidate);
			ranges.splice(i, 2, [aStart, bEnd]);
			merged = true;
		}
	}

	return result;
}

/**
 * One cubic through `points[from..to]` carrying `a`'s start tangent and
 * `b`'s end tangent, or null when none stays within `tolerance`. Keeping the
 * outer tangents means the merged curve meets its neighbours exactly as the
 * pair it replaces did.
 */
function fitAcross(
	points: BezierPoint[],
	from: number,
	to: number,
	a: AbsoluteCubic,
	b: AbsoluteCubic,
	tolerance: number,
): AbsoluteCubic | null {
	const tHat1 = unitVector(a[2] - a[0], a[3] - a[1]);
	const tHat2 = unitVector(b[4] - b[6], b[5] - b[7]);
	if (!tHat1 || !tHat2) return null;

	const section = points.slice(from, to + 1);
	const toleranceSq = tolerance * tolerance;

	let u = chordLengthParameterize(section);
	let bezier = generateBezier(section, u, tHat1, tHat2);
	let [maxErr] = computeMaxError(section, ...bezier, u);
	if (maxErr <= toleranceSq) return bezier;

	// Same second chance the fit itself gives a near miss.
	if (maxErr > toleranceSq * 4) return null;
	for (let i = 0; i < MAX_ITERATIONS; i++) {
		u = reparameterizeNewton(section, u, ...bezier);
		bezier = generateBezier(section, u, tHat1, tHat2);
		[maxErr] = computeMaxError(section, ...bezier, u);
		if (maxErr <= toleranceSq) return bezier;
	}
	return null;
}

/**
 * Whether a pair may merge across the anchor they share.
 *
 * The tolerance test alone is not enough to keep a corner: a corner whose
 * legs are short deviates from a single cubic by less than the tolerance,
 * and merging it rounds a turn the hand made into a curve. What tells such
 * a corner from a wobble the detector promoted is what the smoothing left
 * behind — a section-preserved corner still turns sharply where its two
 * cubics meet, a wobble no longer does. A turn at the corner threshold or
 * beyond therefore refuses the merge, whatever the tolerance would allow.
 */
function mergeAllowed(a: AbsoluteCubic, b: AbsoluteCubic): boolean {
	const inX = a[6] - a[4];
	const inY = a[7] - a[5];
	const outX = b[2] - b[0];
	const outY = b[3] - b[1];
	const lenIn = Math.hypot(inX, inY);
	const lenOut = Math.hypot(outX, outY);
	if (lenIn < 1e-9 || lenOut < 1e-9) return true;
	const cos = (inX * outX + inY * outY) / (lenIn * lenOut);
	return cos >= Math.cos((CORNER_ANGLE_THRESHOLD_DEG * Math.PI) / 180);
}

function nearestIndex(points: BezierPoint[], x: number, y: number): number {
	let best = Number.POSITIVE_INFINITY;
	let at = 0;
	for (let i = 0; i < points.length; i++) {
		const d = (points[i].x - x) ** 2 + (points[i].y - y) ** 2;
		if (d < best) {
			best = d;
			at = i;
		}
	}
	return at;
}

function unitVector(x: number, y: number): [number, number] | null {
	const len = Math.hypot(x, y);
	return len < 1e-9 ? null : [x / len, y / len];
}

/**
 * Convert absolute fitted cubics to CubicBezierSegments, resolving
 * pressure/tilt/twist/deltaTime metadata from the nearest point in
 * `metaSource`. Only the very first segment of a path carries `start` and
 * `isMoved` — continuation chunks pass isFirstOfPath=false.
 */
function convertBeziersToSegments(
	beziers: Array<
		[number, number, number, number, number, number, number, number]
	>,
	metaSource: BezierPoint[],
	isFirstOfPath: boolean,
): CubicBezierSegment[] {
	const segments: CubicBezierSegment[] = [];

	for (let i = 0; i < beziers.length; i++) {
		const [p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y] = beziers[i];

		// Find nearest original points for pressure/tilt/deltaTime metadata.
		// The last anchor always maps to the last input point: a nearest-point
		// scan ties at distance 0 when an airbrush hold repeats the position
		// with only deltaTime advanced, and would pick the stale twin.
		const startMeta = findNearestPoint(metaSource, p0x, p0y);
		const endMeta =
			i === beziers.length - 1
				? metaSource[metaSource.length - 1]
				: findNearestPoint(metaSource, p3x, p3y);
		const first = isFirstOfPath && i === 0;

		segments.push({
			start: first
				? { x: p0x, y: p0y, pressure: startMeta.pressure }
				: undefined,
			cp1: {
				x: p1x - p0x,
				y: p1y - p0y,
				pressure: startMeta.pressure,
			},
			cp2: {
				x: p2x - p3x,
				y: p2y - p3y,
				pressure: endMeta.pressure,
			},
			end: { x: p3x, y: p3y, pressure: endMeta.pressure },
			startPressure: startMeta.pressure ?? 0.5,
			endPressure: endMeta.pressure ?? 0.5,
			startTiltX: startMeta.tiltX ?? 0,
			startTiltY: startMeta.tiltY ?? 0,
			endTiltX: endMeta.tiltX ?? 0,
			endTiltY: endMeta.tiltY ?? 0,
			startTwist: startMeta.twist,
			endTwist: endMeta.twist,
			startDeltaTime: startMeta.deltaTime ?? 0,
			endDeltaTime: endMeta.deltaTime ?? 0,
			isMoved: first,
		});
	}

	return segments;
}
