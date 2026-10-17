import type { ElementTransform } from "../../../schema";
import { linearMatrixToTransform, transformLinearMatrix } from "./coordinates";

/** 2x3 affine: point (x, y) maps to (a*x + c*y + e, b*x + d*y + f). */
export interface Affine2D {
	a: number;
	b: number;
	c: number;
	d: number;
	e: number;
	f: number;
}

export const IDENTITY_AFFINE: Affine2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** True when the affine moves nothing, within floating point noise. */
export function isIdentityAffine(m: Affine2D): boolean {
	const eps = 1e-9;
	return (
		Math.abs(m.a - 1) < eps &&
		Math.abs(m.b) < eps &&
		Math.abs(m.c) < eps &&
		Math.abs(m.d - 1) < eps &&
		Math.abs(m.e) < eps &&
		Math.abs(m.f) < eps
	);
}

// ── Affine helpers ──────────────────────────────────────────────────────────

/** Convert an ElementTransform to an affine on the local origin. */
export function elementTransformToAffine(t: ElementTransform): Affine2D {
	const m = transformLinearMatrix(t);
	return { a: m.m00, b: m.m10, c: m.m01, d: m.m11, e: t.x, f: t.y };
}

/** Inverse of elementTransformToAffine: the transform whose matrix is `m`. */
export function affineToElementTransform(m: Affine2D): ElementTransform {
	return linearMatrixToTransform(
		{ m00: m.a, m01: m.c, m10: m.b, m11: m.d },
		m.e,
		m.f,
	);
}

/** Compose two affines so the result maps p -> outer(inner(p)). */
export function composeAffine(outer: Affine2D, inner: Affine2D): Affine2D {
	return {
		a: outer.a * inner.a + outer.c * inner.b,
		b: outer.b * inner.a + outer.d * inner.b,
		c: outer.a * inner.c + outer.c * inner.d,
		d: outer.b * inner.c + outer.d * inner.d,
		e: outer.a * inner.e + outer.c * inner.f + outer.e,
		f: outer.b * inner.e + outer.d * inner.f + outer.f,
	};
}

/** Inverse of an affine, or identity when it is singular. */
export function invertAffine(m: Affine2D): Affine2D {
	const det = m.a * m.d - m.b * m.c;
	if (Math.abs(det) < 1e-12) return IDENTITY_AFFINE;
	const inv = 1 / det;
	return {
		a: m.d * inv,
		b: -m.b * inv,
		c: -m.c * inv,
		d: m.a * inv,
		e: (m.c * m.f - m.d * m.e) * inv,
		f: (m.b * m.e - m.a * m.f) * inv,
	};
}

export function applyAffineToPoint(
	m: Affine2D,
	p: { x: number; y: number },
): { x: number; y: number } {
	return {
		x: m.a * p.x + m.c * p.y + m.e,
		y: m.b * p.x + m.d * p.y + m.f,
	};
}
