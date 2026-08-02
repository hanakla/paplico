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
			sumDeltaTime += (p.deltaTime ?? 0) * w;
			totalWeight += w;
		}

		result[i] = {
			x: sumX / totalWeight,
			y: sumY / totalWeight,
			pressure: sumPressure / totalWeight,
			tiltX: sumTiltX / totalWeight,
			tiltY: sumTiltY / totalWeight,
			deltaTime: sumDeltaTime / totalWeight,
		};
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

	// Step 1: Smoothing (method-dependent)
	let smoothed: BezierPoint[];
	switch (smoothingMethod) {
		case "pulled-string":
			smoothed = pulledStringSmooth(deduped, stabilization);
			break;
		case "inertia":
			smoothed = inertiaSmooth(deduped, stabilization);
			break;
		default:
			smoothed = gaussianSmooth(deduped, stabilization);
			break;
	}

	// Step 2: Corner detection — split path at sharp turns (45° threshold)
	const corners = detectCorners(smoothed, 45);

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
	const segments: CubicBezierSegment[] = [];

	for (let i = 0; i < allBeziers.length; i++) {
		const [p0x, p0y, p1x, p1y, p2x, p2y, p3x, p3y] = allBeziers[i];

		// Find nearest original points for pressure/tilt/deltaTime metadata
		const startMeta = findNearestPoint(smoothed, p0x, p0y);
		const endMeta = findNearestPoint(smoothed, p3x, p3y);

		segments.push({
			start:
				i === 0 ? { x: p0x, y: p0y, pressure: startMeta.pressure } : undefined,
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
			startDeltaTime: startMeta.deltaTime ?? 0,
			endDeltaTime: endMeta.deltaTime ?? 0,
			isMoved: i === 0,
		});
	}

	return segments;
}
