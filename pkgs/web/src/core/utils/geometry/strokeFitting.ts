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

	const sigma = stabilization * 4.0;
	const radius = Math.ceil(3 * sigma);
	const twoSigmaSq = 2 * sigma * sigma;

	// Pre-compute kernel weights
	const kernelWeights: number[] = [];
	for (let i = 0; i <= radius; i++) {
		kernelWeights[i] = Math.exp(-(i * i) / twoSigmaSq);
	}

	const result: BezierPoint[] = new Array(points.length);
	// Preserve endpoints
	result[0] = points[0];
	result[points.length - 1] = points[points.length - 1];

	for (let i = 1; i < points.length - 1; i++) {
		let sumX = 0;
		let sumY = 0;
		let sumPressure = 0;
		let sumTiltX = 0;
		let sumTiltY = 0;
		// Twist is angular (0-359 wraps): average sin/cos, not the raw degrees.
		let sumTwistSin = 0;
		let sumTwistCos = 0;
		let sumDeltaTime = 0;
		let totalWeight = 0;

		const lo = Math.max(0, i - radius);
		const hi = Math.min(points.length - 1, i + radius);

		for (let j = lo; j <= hi; j++) {
			const w = kernelWeights[Math.abs(j - i)];
			const p = points[j];
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
		result[i] = {
			x: sumX / totalWeight,
			y: sumY / totalWeight,
			pressure: sumPressure / totalWeight,
			tiltX: sumTiltX / totalWeight,
			tiltY: sumTiltY / totalWeight,
			twist: ((twistDeg % 360) + 360) % 360,
			deltaTime: sumDeltaTime / totalWeight,
		};
	}

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
	if (stabilization <= 0 || cornerIdxs.length <= 2) {
		return gaussianSmooth(points, stabilization);
	}
	const result: BezierPoint[] = [];
	for (let c = 0; c < cornerIdxs.length - 1; c++) {
		const section = gaussianSmooth(
			points.slice(cornerIdxs[c], cornerIdxs[c + 1] + 1),
			stabilization,
		);
		// Skip the boundary point shared with the previous section.
		for (let k = c === 0 ? 0 : 1; k < section.length; k++) {
			result.push(section[k]);
		}
	}
	return result;
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
	bestDev: number;
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
		const arc = cumulativeArcLengths(points);
		let group: CornerCandidateGroup | null = null;
		for (let i = 1; i < points.length - 1; i++) {
			const dev = rawCornerDeviationAt(points, arc, i, opts);
			if (dev < 0) continue;
			if (group && arc[i] - arc[group.lastIdx] <= opts.spanDistance) {
				if (dev > group.bestDev) {
					group.bestIdx = i;
					group.bestDev = dev;
				}
				group.lastIdx = i;
			} else {
				if (group) corners.push(group.bestIdx);
				group = { bestIdx: i, bestDev: dev, lastIdx: i };
			}
		}
		if (group) corners.push(group.bestIdx);
	}
	corners.push(points.length - 1);
	return corners;
}

/**
 * Apex deviation of a span-based corner candidate at index i, or -1 when the
 * point is no candidate. Walks are capped at `maxSpanPoints` indices so the
 * result depends only on a bounded neighborhood (required for incremental
 * confirmation to match batch detection).
 */
function rawCornerDeviationAt(
	points: BezierPoint[],
	arc: number[],
	i: number,
	opts: Required<RawCornerOptions>,
): number {
	if (i <= 0 || i >= points.length - 1) return -1;

	let j = i - 1;
	while (
		j > 0 &&
		arc[i] - arc[j] < opts.spanDistance &&
		i - j < opts.maxSpanPoints
	) {
		j--;
	}
	if (arc[i] - arc[j] < opts.spanDistance) return -1;

	let k = i + 1;
	while (
		k < points.length - 1 &&
		arc[k] - arc[i] < opts.spanDistance &&
		k - i < opts.maxSpanPoints
	) {
		k++;
	}
	if (arc[k] - arc[i] < opts.spanDistance) return -1;

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
	return maxDev >= opts.minDeviation ? maxDev : -1;
}

/** Cumulative arc length per point ([0] = 0). */
function cumulativeArcLengths(points: BezierPoint[]): number[] {
	const arc = new Array<number>(points.length);
	arc[0] = 0;
	for (let i = 1; i < points.length; i++) {
		arc[i] =
			arc[i - 1] +
			Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
	}
	return arc;
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
function computeLeftTangent(points: BezierPoint[]): [number, number] {
	const dx = points[1].x - points[0].x;
	const dy = points[1].y - points[0].y;
	const len = Math.sqrt(dx * dx + dy * dy);
	if (len < 1e-9) return [1, 0];
	return [dx / len, dy / len];
}

/** Compute right tangent at end of point sequence. */
function computeRightTangent(points: BezierPoint[]): [number, number] {
	const n = points.length;
	const dx = points[n - 2].x - points[n - 1].x;
	const dy = points[n - 2].y - points[n - 1].y;
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
	let alpha1: number;
	let alpha2: number;

	if (Math.abs(det) < 1e-12) {
		// Degenerate: use chord length heuristic
		const dist =
			Math.sqrt((p3x - p0x) * (p3x - p0x) + (p3y - p0y) * (p3y - p0y)) / 3;
		alpha1 = dist;
		alpha2 = dist;
	} else {
		alpha1 = (c11 * x0 - c01 * x1) / det;
		alpha2 = (c00 * x1 - c01 * x0) / det;
	}

	// If alpha is negative or zero, use chord-length heuristic
	const segLength = Math.sqrt(
		(p3x - p0x) * (p3x - p0x) + (p3y - p0y) * (p3y - p0y),
	);
	const epsilon = 1e-6 * segLength;

	if (alpha1 < epsilon || alpha2 < epsilon) {
		const dist = segLength / 3;
		alpha1 = dist;
		alpha2 = dist;
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
	let best = points[0];
	let bestDist = Number.POSITIVE_INFINITY;
	for (const p of points) {
		const d = (p.x - x) ** 2 + (p.y - y) ** 2;
		if (d < bestDist) {
			bestDist = d;
			best = p;
		}
	}
	return best;
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

	// Step 4: Convert absolute Bézier control points to CubicBezierSegments
	// (cp1/cp2 stored as relative offsets from anchors)
	return convertBeziersToSegments(allBeziers, smoothed, true);
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
	private readonly rawCornerOptions: Required<RawCornerOptions>;
	/** Cumulative arc length of `deduped`. */
	private readonly arc: number[] = [];
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
		this.rawCornerOptions = rawCornerOptionsFor(options.stabilization);
		this.method = options.smoothingMethod ?? "smooth";
		const baseTolerance =
			options.stabilization <= 0 ? 0.5 : 1.0 + options.stabilization * 3.0;
		this.tolerance = baseTolerance / options.zoom;
		this.gaussianRadius =
			this.method === "smooth" && options.stabilization > 0
				? Math.ceil(3 * options.stabilization * 4.0)
				: 0;
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
		this.arc.push(
			prev
				? this.arc[this.arc.length - 1] +
						Math.hypot(point.x - prev.x, point.y - prev.y)
				: 0,
		);
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
		const tail =
			tailPts.length >= 2
				? fitPointSequence(tailPts, this.tolerance, this.frozen.length === 0)
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
				// now in the past — held back by CORNER_MAX_SPAN_POINTS beyond
				// the radius so every corner a settling window could touch is
				// already decided.
				this.smoothed.push(point);
				const settleUpTo =
					this.deduped.length -
					1 -
					this.gaussianRadius -
					CORNER_MAX_SPAN_POINTS;
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
		if (i === 0) return points[0];
		// Clamp the kernel window to the section between confirmed corners and
		// pin the corners themselves (mirrors gaussianSmoothSections).
		let sectionLo = 0;
		let sectionHi = points.length - 1;
		for (let c = this.rawCorners.length - 1; c >= 0; c--) {
			const cornerIdx = this.rawCorners[c];
			if (cornerIdx <= i) {
				sectionLo = cornerIdx;
				break;
			}
			sectionHi = cornerIdx;
		}
		if (i === sectionLo || i === sectionHi) return points[i];
		const radius = this.gaussianRadius;
		const sigma = this.stabilization * 4.0;
		const twoSigmaSq = 2 * sigma * sigma;

		let sumX = 0;
		let sumY = 0;
		let sumPressure = 0;
		let sumTiltX = 0;
		let sumTiltY = 0;
		let sumTwistSin = 0;
		let sumTwistCos = 0;
		let sumDeltaTime = 0;
		let totalWeight = 0;
		const lo = Math.max(sectionLo, i - radius);
		const hi = Math.min(sectionHi, i + radius);
		for (let j = lo; j <= hi; j++) {
			const d = Math.abs(j - i);
			const w = Math.exp(-(d * d) / twoSigmaSq);
			const p = points[j];
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
			const dev = rawCornerDeviationAt(this.deduped, this.arc, i, opts);
			const group = this.pendingCornerGroup;
			if (dev >= 0) {
				if (
					group &&
					this.arc[i] - this.arc[group.lastIdx] <= opts.spanDistance
				) {
					if (dev > group.bestDev) {
						group.bestIdx = i;
						group.bestDev = dev;
					}
					group.lastIdx = i;
				} else {
					if (group) this.rawCorners.push(group.bestIdx);
					this.pendingCornerGroup = { bestIdx: i, bestDev: dev, lastIdx: i };
				}
			} else if (
				group &&
				this.arc[i] - this.arc[group.lastIdx] > opts.spanDistance
			) {
				// No later candidate can rejoin this cluster: finalize it.
				this.rawCorners.push(group.bestIdx);
				this.pendingCornerGroup = null;
			}
			this.rawCornerCheckedUpTo = i;
			this.lastProcessedPoints += 1;
		}
	}

	// --- freezing ----------------------------------------------------------

	private maybeFreeze(): void {
		// Corner freeze: a confirmed corner splits the fit exactly like
		// processStroke's corner split, so freezing there is lossless.
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
		const fitted = fitPointSequence(
			section,
			this.tolerance,
			this.frozen.length === 0,
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
