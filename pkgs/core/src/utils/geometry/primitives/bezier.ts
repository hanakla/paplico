import type { BezierPoint, Point } from "../../../schema";

export type Vec2 = [number, number];

export abstract class Geometry {
	public abstract snap0(v: number): number;
	public abstract snap01(v: number): number;
	public abstract isCollinear(p1: Vec2, p2: Vec2, p3: Vec2): boolean;
	public abstract solveCubic(
		a: number,
		b: number,
		c: number,
		d: number,
	): number[];
	public abstract isEqualVec2(a: Vec2, b: Vec2): boolean;
	public abstract compareVec2(a: Vec2, b: Vec2): number;
}

export class GeometryEpsilon extends Geometry {
	private readonly epsilon: number;

	public constructor(epsilon = 0.0000000001) {
		super();
		this.epsilon = epsilon;
	}

	public snap0(v: number) {
		if (Math.abs(v) < this.epsilon) {
			return 0;
		}
		return v;
	}

	public snap01(v: number) {
		if (Math.abs(v) < this.epsilon) {
			return 0;
		}
		if (Math.abs(1 - v) < this.epsilon) {
			return 1;
		}
		return v;
	}

	public isCollinear(p1: Vec2, p2: Vec2, p3: Vec2) {
		// does pt1->pt2->pt3 make a straight line?
		// essentially this is just checking to see if
		//   slope(pt1->pt2) === slope(pt2->pt3)
		// if slopes are equal, then they must be collinear, because they share pt2
		const dx1 = p1[0] - p2[0];
		const dy1 = p1[1] - p2[1];
		const dx2 = p2[0] - p3[0];
		const dy2 = p2[1] - p3[1];
		return Math.abs(dx1 * dy2 - dx2 * dy1) < this.epsilon;
	}

	private solveCubicNormalized(a: number, b: number, c: number) {
		// based somewhat on gsl_poly_solve_cubic from GNU Scientific Library
		const a3 = a / 3;
		const b3 = b / 3;
		const Q = a3 * a3 - b3;
		const R = a3 * (a3 * a3 - b / 2) + c / 2;
		if (Math.abs(R) < this.epsilon && Math.abs(Q) < this.epsilon) {
			return [-a3];
		}
		const F =
			a3 * (a3 * (4 * a3 * c - b3 * b) - 2 * b * c) + 4 * b3 * b3 * b3 + c * c;
		if (Math.abs(F) < this.epsilon) {
			const sqrtQ = Math.sqrt(Q);
			return R > 0
				? [-2 * sqrtQ - a / 3, sqrtQ - a / 3]
				: [-sqrtQ - a / 3, 2 * sqrtQ - a / 3];
		}
		const Q3 = Q * Q * Q;
		const R2 = R * R;
		if (R2 < Q3) {
			const ratio = (R < 0 ? -1 : 1) * Math.sqrt(R2 / Q3);
			const theta = Math.acos(ratio);
			const norm = -2 * Math.sqrt(Q);
			const x0 = norm * Math.cos(theta / 3) - a3;
			const x1 = norm * Math.cos((theta + 2 * Math.PI) / 3) - a3;
			const x2 = norm * Math.cos((theta - 2 * Math.PI) / 3) - a3;
			return [x0, x1, x2].sort((x, y) => x - y);
		} else {
			const A =
				(R < 0 ? 1 : -1) * (Math.abs(R) + Math.sqrt(R2 - Q3)) ** (1 / 3);
			const B = Math.abs(A) >= this.epsilon ? Q / A : 0;
			return [A + B - a3];
		}
	}

	public solveCubic(a: number, b: number, c: number, d: number) {
		if (Math.abs(a) < this.epsilon) {
			// quadratic
			if (Math.abs(b) < this.epsilon) {
				// linear case
				if (Math.abs(c) < this.epsilon) {
					// horizontal line
					return Math.abs(d) < this.epsilon ? [0] : [];
				}
				return [-d / c];
			}
			const b2 = 2 * b;
			let D = c * c - 4 * b * d;
			if (Math.abs(D) < this.epsilon) {
				return [-c / b2];
			} else if (D > 0) {
				D = Math.sqrt(D);
				return [(-c + D) / b2, (-c - D) / b2].sort((x, y) => x - y);
			}
			return [];
		}
		return this.solveCubicNormalized(b / a, c / a, d / a);
	}

	public isEqualVec2(a: Vec2, b: Vec2) {
		return (
			Math.abs(a[0] - b[0]) < this.epsilon &&
			Math.abs(a[1] - b[1]) < this.epsilon
		);
	}

	public compareVec2(a: Vec2, b: Vec2) {
		// returns -1 if a is smaller, 1 if b is smaller, 0 if equal
		if (Math.abs(b[0] - a[0]) < this.epsilon) {
			return Math.abs(b[1] - a[1]) < this.epsilon ? 0 : a[1] < b[1] ? -1 : 1;
		}
		return a[0] < b[0] ? -1 : 1;
	}
}

export type CubicCurve = [Point, Point, Point, Point];

function lerpPoint(a: Point, b: Point, t: number): Point {
	return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function splitCurve(
	curve: CubicCurve,
	t: number,
): { left: CubicCurve; right: CubicCurve } {
	const p01 = lerpPoint(curve[0], curve[1], t);
	const p12 = lerpPoint(curve[1], curve[2], t);
	const p23 = lerpPoint(curve[2], curve[3], t);
	const p012 = lerpPoint(p01, p12, t);
	const p123 = lerpPoint(p12, p23, t);
	const p = lerpPoint(p012, p123, t);
	return {
		left: [curve[0], p01, p012, p],
		right: [p, p123, p23, curve[3]],
	};
}

function reverseCurve(curve: CubicCurve): CubicCurve {
	return [curve[3], curve[2], curve[1], curve[0]];
}

export function getCurveInterval(
	curve: CubicCurve,
	t0: number,
	t1: number,
): CubicCurve {
	if (Math.abs(t1 - t0) < 1e-8) {
		const p = evalCubicBezier(curve[0], curve[1], curve[2], curve[3], t0);
		return [p, p, p, p];
	}
	if (t0 > t1) return reverseCurve(getCurveInterval(curve, t1, t0));
	if (t0 <= 0 && t1 >= 1) return curve.map((p) => ({ ...p })) as CubicCurve;
	const { left } = splitCurve(curve, t1);
	if (t0 <= 0) return left;
	return splitCurve(left, t0 / t1).right;
}

/**
 * Split a cubic Bezier curve at parameter t
 * Returns two new cubic Bezier segments
 */
export function splitBezierAtT(
	p0: BezierPoint,
	p1: BezierPoint,
	p2: BezierPoint,
	p3: BezierPoint,
	t: number,
): [
	{ p0: BezierPoint; p1: BezierPoint; p2: BezierPoint; p3: BezierPoint },
	{ p0: BezierPoint; p1: BezierPoint; p2: BezierPoint; p3: BezierPoint },
] {
	// De Casteljau's algorithm for subdivision
	const q0 = {
		x: p0.x + (p1.x - p0.x) * t,
		y: p0.y + (p1.y - p0.y) * t,
		pressure: p0.pressure,
	};
	const q1 = {
		x: p1.x + (p2.x - p1.x) * t,
		y: p1.y + (p2.y - p1.y) * t,
		pressure: p1.pressure,
	};
	const q2 = {
		x: p2.x + (p3.x - p2.x) * t,
		y: p2.y + (p3.y - p2.y) * t,
		pressure: p3.pressure,
	};

	const r0 = {
		x: q0.x + (q1.x - q0.x) * t,
		y: q0.y + (q1.y - q0.y) * t,
		pressure: q0.pressure,
	};
	const r1 = {
		x: q1.x + (q2.x - q1.x) * t,
		y: q1.y + (q2.y - q1.y) * t,
		pressure: q1.pressure,
	};

	// Interpolate pressure linearly between start and end at parameter t
	const splitPressure =
		p0.pressure != null && p3.pressure != null
			? p0.pressure + (p3.pressure - p0.pressure) * t
			: (p0.pressure ?? p3.pressure);

	const s = {
		x: r0.x + (r1.x - r0.x) * t,
		y: r0.y + (r1.y - r0.y) * t,
		pressure: splitPressure,
	};

	return [
		{ p0, p1: q0, p2: r0, p3: s },
		{ p0: s, p1: r1, p2: q2, p3 },
	];
}

/** Evaluate cubic bezier at parameter t */
export function evalCubicBezier(
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	t: number,
): Point {
	const u = 1 - t;
	const tt = t * t;
	const uu = u * u;
	const uuu = uu * u;
	const ttt = tt * t;

	return {
		x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
		y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
	};
}

/** Evaluate cubic bezier second derivative at parameter t */
/** Evaluate cubic bezier derivative (tangent) at parameter t */
export function evalCubicBezierDerivative(
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	t: number,
): Point {
	const u = 1 - t;
	const tt = t * t;
	const uu = u * u;

	return {
		x:
			3 * uu * (p1.x - p0.x) +
			6 * u * t * (p2.x - p1.x) +
			3 * tt * (p3.x - p2.x),
		y:
			3 * uu * (p1.y - p0.y) +
			6 * u * t * (p2.y - p1.y) +
			3 * tt * (p3.y - p2.y),
	};
}
