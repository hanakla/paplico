/**
 * Bezier boolean operations (union, intersection, difference, xor).
 * Based on polybool by Sean Connelly (@velipso)
 * Original: https://github.com/velipso/polybool
 * SPDX-License-Identifier: 0BSD
 */
import { lerp } from "../math";

type Vec2 = [number, number];

function lerpVec2(a: Vec2, b: Vec2, t: number): Vec2 {
	return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
}

function boundingBoxesIntersect(bbox1: [Vec2, Vec2], bbox2: [Vec2, Vec2]) {
	const [b1min, b1max] = bbox1;
	const [b2min, b2max] = bbox2;
	return !(
		b1min[0] > b2max[0] ||
		b1max[0] < b2min[0] ||
		b1min[1] > b2max[1] ||
		b1max[1] < b2min[1]
	);
}

abstract class Geometry {
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

interface SegmentDrawReceiver {
	moveTo: (x: number, y: number) => void;
	lineTo: (x: number, y: number) => void;
	bezierCurveTo: (
		cp1x: number,
		cp1y: number,
		cp2x: number,
		cp2y: number,
		x: number,
		y: number,
	) => void;
}

interface SegmentTValuePairs {
	kind: "tValuePairs";
	tValuePairs: Vec2[]; // [seg1T, seg2T][]
}

interface SegmentTRangePairs {
	kind: "tRangePairs";
	tStart: Vec2; // [seg1TStart, seg2TStart]
	tEnd: Vec2; // [seg1TEnd, seg2TEnd]
}

class SegmentTValuesBuilder {
	private tValues: number[] = [];
	private geo: Geometry;

	public constructor(geo: Geometry) {
		this.geo = geo;
	}

	public addArray(ts: number[]) {
		for (const t of ts) {
			this.tValues.push(t);
		}
		return this;
	}

	public add(t: number) {
		t = this.geo.snap01(t);
		// ignore values outside 0-1 range
		if (t < 0 || t > 1) {
			return this;
		}
		for (const tv of this.tValues) {
			if (this.geo.snap0(t - tv) === 0) {
				// already have this location
				return this;
			}
		}
		this.tValues.push(t);
		return this;
	}

	public list() {
		this.tValues.sort((a, b) => a - b);
		return this.tValues;
	}
}

class SegmentTValuePairsBuilder {
	private tValuePairs: Vec2[] = [];
	private allowOutOfRange: boolean;
	private geo: Geometry;

	public constructor(allowOutOfRange: boolean, geo: Geometry) {
		this.allowOutOfRange = allowOutOfRange;
		this.geo = geo;
	}

	public add(t1: number, t2: number) {
		t1 = this.geo.snap01(t1);
		t2 = this.geo.snap01(t2);
		// ignore values outside 0-1 range
		if (!this.allowOutOfRange && (t1 < 0 || t1 > 1 || t2 < 0 || t2 > 1)) {
			return this;
		}
		for (const tv of this.tValuePairs) {
			if (
				this.geo.snap0(t1 - tv[0]) === 0 ||
				this.geo.snap0(t2 - tv[1]) === 0
			) {
				// already have this location
				return this;
			}
		}
		this.tValuePairs.push([t1, t2]);
		return this;
	}

	public list() {
		this.tValuePairs.sort((a, b) => a[0] - b[0]);
		return this.tValuePairs;
	}

	public done(): SegmentTValuePairs | null {
		return this.tValuePairs.length <= 0
			? null
			: {
					kind: "tValuePairs",
					tValuePairs: this.list(),
				};
	}
}

abstract class SegmentBase<T> {
	public abstract copy(): T;
	public abstract isEqual(other: T): boolean;
	public abstract start(): Vec2;
	public abstract start2(): Vec2;
	public abstract end2(): Vec2;
	public abstract end(): Vec2;
	public abstract setStart(p: Vec2): void;
	public abstract setEnd(p: Vec2): void;
	public abstract point(t: number): Vec2;
	public abstract split(t: number[]): T[];
	public abstract reverse(): T;
	public abstract boundingBox(): [Vec2, Vec2];
	public abstract pointOn(p: Vec2): boolean;
	public abstract draw<TRecv extends SegmentDrawReceiver>(ctx: TRecv): TRecv;
}

export class SegmentLine extends SegmentBase<SegmentLine> {
	public p0: Vec2;
	public p1: Vec2;
	public geo: Geometry;

	public constructor(p0: Vec2, p1: Vec2, geo: Geometry) {
		super();
		this.p0 = p0;
		this.p1 = p1;
		this.geo = geo;
	}

	public copy() {
		return new SegmentLine(this.p0, this.p1, this.geo);
	}

	public isEqual(other: SegmentLine) {
		return (
			this.geo.isEqualVec2(this.p0, other.p0) &&
			this.geo.isEqualVec2(this.p1, other.p1)
		);
	}

	public start() {
		return this.p0;
	}

	public start2() {
		return this.p1;
	}

	public end2() {
		return this.p0;
	}

	public end() {
		return this.p1;
	}

	public setStart(p0: Vec2) {
		this.p0 = p0;
	}

	public setEnd(p1: Vec2) {
		this.p1 = p1;
	}

	public point(t: number): Vec2 {
		const p0 = this.p0;
		const p1 = this.p1;

		if (t === 0) {
			return p0;
		} else if (t === 1) {
			return p1;
		}

		return [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
	}

	public split(ts: number[]): SegmentLine[] {
		if (ts.length <= 0) {
			return [this];
		}
		const pts = ts.map((t) => this.point(t));
		pts.push(this.p1);
		const result: SegmentLine[] = [];
		let last = this.p0;
		for (const p of pts) {
			result.push(new SegmentLine(last, p, this.geo));
			last = p;
		}
		return result;
	}

	public reverse() {
		return new SegmentLine(this.p1, this.p0, this.geo);
	}

	public boundingBox(): [Vec2, Vec2] {
		const p0 = this.p0;
		const p1 = this.p1;
		return [
			[Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1])],
			[Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])],
		];
	}

	public pointOn(p: Vec2) {
		return this.geo.isCollinear(p, this.p0, this.p1);
	}

	public draw<TRecv extends SegmentDrawReceiver>(ctx: TRecv): TRecv {
		const p0 = this.p0;
		const p1 = this.p1;
		ctx.moveTo(p0[0], p0[1]);
		ctx.lineTo(p1[0], p1[1]);
		return ctx;
	}
}

export class SegmentCurve extends SegmentBase<SegmentCurve> {
	public p0: Vec2;
	public p1: Vec2;
	public p2: Vec2;
	public p3: Vec2;
	public geo: Geometry;

	public constructor(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, geo: Geometry) {
		super();
		this.p0 = p0;
		this.p1 = p1;
		this.p2 = p2;
		this.p3 = p3;
		this.geo = geo;
	}

	public copy() {
		return new SegmentCurve(this.p0, this.p1, this.p2, this.p3, this.geo);
	}

	public isEqual(other: SegmentCurve) {
		return (
			this.geo.isEqualVec2(this.p0, other.p0) &&
			this.geo.isEqualVec2(this.p1, other.p1) &&
			this.geo.isEqualVec2(this.p2, other.p2) &&
			this.geo.isEqualVec2(this.p3, other.p3)
		);
	}

	public start() {
		return this.p0;
	}

	public start2() {
		return this.p1;
	}

	public end2() {
		return this.p2;
	}

	public end() {
		return this.p3;
	}

	public setStart(p0: Vec2) {
		this.p0 = p0;
	}

	public setEnd(p3: Vec2) {
		this.p3 = p3;
	}

	public point(t: number): Vec2 {
		const p0 = this.p0;
		const p1 = this.p1;
		const p2 = this.p2;
		const p3 = this.p3;

		if (t === 0) {
			return p0;
		} else if (t === 1) {
			return p3;
		}

		const t1t = (1 - t) * (1 - t);
		const tt = t * t;
		const t0 = t1t * (1 - t);
		const t1 = 3 * t1t * t;
		const t2 = 3 * tt * (1 - t);
		const t3 = tt * t;

		return [
			p0[0] * t0 + p1[0] * t1 + p2[0] * t2 + p3[0] * t3,
			p0[1] * t0 + p1[1] * t1 + p2[1] * t2 + p3[1] * t3,
		];
	}

	public split(ts: number[]): SegmentCurve[] {
		if (ts.length <= 0) {
			return [this];
		}
		const result: SegmentCurve[] = [];
		const splitSingle = (
			pts: [Vec2, Vec2, Vec2, Vec2],
			t: number,
		): [Vec2, Vec2, Vec2, Vec2] => {
			const [p0, p1, p2, p3] = pts;
			const p4 = lerpVec2(p0, p1, t);
			const p5 = lerpVec2(p1, p2, t);
			const p6 = lerpVec2(p2, p3, t);
			const p7 = lerpVec2(p4, p5, t);
			const p8 = lerpVec2(p5, p6, t);
			const p9 = lerpVec2(p7, p8, t);
			result.push(new SegmentCurve(p0, p4, p7, p9, this.geo));
			return [p9, p8, p6, p3];
		};
		let last: [Vec2, Vec2, Vec2, Vec2] = [this.p0, this.p1, this.p2, this.p3];
		let lastT = 0;
		for (const t of ts) {
			last = splitSingle(last, (t - lastT) / (1 - lastT));
			lastT = t;
		}
		result.push(new SegmentCurve(last[0], last[1], last[2], last[3], this.geo));
		return result;
	}

	public reverse() {
		return new SegmentCurve(this.p3, this.p2, this.p1, this.p0, this.geo);
	}

	public getCubicCoefficients(axis: number): [number, number, number, number] {
		const p0 = this.p0[axis];
		const p1 = this.p1[axis];
		const p2 = this.p2[axis];
		const p3 = this.p3[axis];
		return [
			p3 - 3 * p2 + 3 * p1 - p0,
			3 * p2 - 6 * p1 + 3 * p0,
			3 * p1 - 3 * p0,
			p0,
		];
	}

	private boundingTValues() {
		const result = new SegmentTValuesBuilder(this.geo);
		const bounds = (x0: number, x1: number, x2: number, x3: number) => {
			const a = 3 * x3 - 9 * x2 + 9 * x1 - 3 * x0;
			const b = 6 * x0 - 12 * x1 + 6 * x2;
			const c = 3 * x1 - 3 * x0;
			if (this.geo.snap0(a) === 0) {
				result.add(-c / b);
			} else {
				const disc = b * b - 4 * a * c;
				if (disc >= 0) {
					const sq = Math.sqrt(disc);
					result.add((-b + sq) / (2 * a));
					result.add((-b - sq) / (2 * a));
				}
			}
			return result;
		};

		const p0 = this.p0;
		const p1 = this.p1;
		const p2 = this.p2;
		const p3 = this.p3;
		bounds(p0[0], p1[0], p2[0], p3[0]);
		bounds(p0[1], p1[1], p2[1], p3[1]);

		return result.list();
	}

	public inflectionTValues(): number[] {
		const result = new SegmentTValuesBuilder(this.geo);
		result.addArray(this.boundingTValues());
		const p0 = this.p0;
		const p1 = this.p1;
		const p2 = this.p2;
		const p3 = this.p3;
		const p10x = 3 * (p1[0] - p0[0]);
		const p10y = 3 * (p1[1] - p0[1]);
		const p21x = 6 * (p2[0] - p1[0]);
		const p21y = 6 * (p2[1] - p1[1]);
		const p32x = 3 * (p3[0] - p2[0]);
		const p32y = 3 * (p3[1] - p2[1]);
		const p210x = 6 * (p2[0] - 2 * p1[0] + p0[0]);
		const p210y = 6 * (p2[1] - 2 * p1[1] + p0[1]);
		const p321x = 6 * (p3[0] - 2 * p2[0] + p1[0]);
		const p321y = 6 * (p3[1] - 2 * p2[1] + p1[1]);
		const qx = p10x - p21x + p32x;
		const qy = p10y - p21y + p32y;
		const rx = p21x - 2 * p10x;
		const ry = p21y - 2 * p10y;
		const sx = p10x;
		const sy = p10y;
		const ux = p321x - p210x;
		const uy = p321y - p210y;
		const vx = p210x;
		const vy = p210y;
		const A = qx * uy - qy * ux;
		const B = qx * vy + rx * uy - qy * vx - ry * ux;
		const C = rx * vy + sx * uy - ry * vx - sy * ux;
		const D = sx * vy - sy * vx;
		for (const s of this.geo.solveCubic(A, B, C, D)) {
			result.add(s);
		}
		return result.list();
	}

	public boundingBox(): [Vec2, Vec2] {
		const p0 = this.p0;
		const p3 = this.p3;
		const min: Vec2 = [Math.min(p0[0], p3[0]), Math.min(p0[1], p3[1])];
		const max: Vec2 = [Math.max(p0[0], p3[0]), Math.max(p0[1], p3[1])];
		for (const t of this.boundingTValues()) {
			const p = this.point(t);
			min[0] = Math.min(min[0], p[0]);
			min[1] = Math.min(min[1], p[1]);
			max[0] = Math.max(max[0], p[0]);
			max[1] = Math.max(max[1], p[1]);
		}
		return [min, max];
	}

	public mapXtoT(x: number, force = false): number | false {
		if (this.geo.snap0(this.p0[0] - x) === 0) {
			return 0;
		}
		if (this.geo.snap0(this.p3[0] - x) === 0) {
			return 1;
		}
		const p0 = this.p0[0] - x;
		const p1 = this.p1[0] - x;
		const p2 = this.p2[0] - x;
		const p3 = this.p3[0] - x;
		const R = [
			p3 - 3 * p2 + 3 * p1 - p0,
			3 * p2 - 6 * p1 + 3 * p0,
			3 * p1 - 3 * p0,
			p0,
		];
		for (const t of this.geo.solveCubic(R[0], R[1], R[2], R[3])) {
			const ts = this.geo.snap01(t);
			if (ts >= 0 && ts <= 1) {
				return t;
			}
		}
		// force a solution if we know there is one...
		if (
			force ||
			(x >= Math.min(this.p0[0], this.p3[0]) &&
				x <= Math.max(this.p0[0], this.p3[0]))
		) {
			for (let attempt = 0; attempt < 4; attempt++) {
				// collapse an R value to 0, this is so wrong!!!
				let ii = -1;
				for (let i = 0; i < 4; i++) {
					if (R[i] !== 0 && (ii < 0 || Math.abs(R[i]) < Math.abs(R[ii]))) {
						ii = i;
					}
				}
				if (ii < 0) {
					return 0;
				}
				R[ii] = 0;

				// solve again, but with another 0 to help
				for (const t of this.geo.solveCubic(R[0], R[1], R[2], R[3])) {
					const ts = this.geo.snap01(t);
					if (ts >= 0 && ts <= 1) {
						return t;
					}
				}
			}
		}
		return false;
	}

	public mapXtoY(x: number, force = false): number | false {
		const t = this.mapXtoT(x, force);
		if (t === false) {
			return false;
		}
		return this.point(t)[1];
	}

	public pointOn(p: Vec2) {
		if (this.geo.isEqualVec2(this.p0, p) || this.geo.isEqualVec2(this.p3, p)) {
			return true;
		}
		const y = this.mapXtoY(p[0]);
		if (y === false) {
			return false;
		}
		return this.geo.snap0(y - p[1]) === 0;
	}

	public toLine(): SegmentLine | null {
		// note: this won't work for arbitrary curves, because they could loop back on themselves,
		// but will work fine for curves that have already been split at all inflection points
		const p0 = this.p0;
		const p1 = this.p1;
		const p2 = this.p2;
		const p3 = this.p3;
		if (
			// vertical line
			(this.geo.snap0(p0[0] - p1[0]) === 0 &&
				this.geo.snap0(p0[0] - p2[0]) === 0 &&
				this.geo.snap0(p0[0] - p3[0]) === 0) || // horizontal line
			(this.geo.snap0(p0[1] - p1[1]) === 0 &&
				this.geo.snap0(p0[1] - p2[1]) === 0 &&
				this.geo.snap0(p0[1] - p3[1]) === 0)
		) {
			return new SegmentLine(p0, p3, this.geo);
		}
		return null;
	}

	public draw<TRecv extends SegmentDrawReceiver>(ctx: TRecv): TRecv {
		const p0 = this.p0;
		const p1 = this.p1;
		const p2 = this.p2;
		const p3 = this.p3;
		ctx.moveTo(p0[0], p0[1]);
		ctx.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
		return ctx;
	}
}

export type Segment = SegmentLine | SegmentCurve;

function projectPointOntoSegmentLine(p: Vec2, seg: SegmentLine) {
	const dx = seg.p1[0] - seg.p0[0];
	const dy = seg.p1[1] - seg.p0[1];
	const px = p[0] - seg.p0[0];
	const py = p[1] - seg.p0[1];
	const dist = dx * dx + dy * dy;
	const dot = px * dx + py * dy;
	return dot / dist;
}

function segmentLineIntersectSegmentLine(
	segA: SegmentLine,
	segB: SegmentLine,
	allowOutOfRange: boolean,
): SegmentTValuePairs | SegmentTRangePairs | null {
	const geo = segA.geo;
	const a0 = segA.p0;
	const a1 = segA.p1;
	const b0 = segB.p0;
	const b1 = segB.p1;
	const adx = a1[0] - a0[0];
	const ady = a1[1] - a0[1];
	const bdx = b1[0] - b0[0];
	const bdy = b1[1] - b0[1];

	const axb = adx * bdy - ady * bdx;
	if (geo.snap0(axb) === 0) {
		// lines are coincident or parallel
		if (!geo.isCollinear(a0, a1, b0)) {
			// they're not coincident, so they're parallel, with no intersections
			return null;
		}
		// otherwise, segments are on top of each other somehow (aka coincident)
		const tB0onA = projectPointOntoSegmentLine(segB.p0, segA);
		const tB1onA = projectPointOntoSegmentLine(segB.p1, segA);
		const tAMin = geo.snap01(Math.min(tB0onA, tB1onA));
		const tAMax = geo.snap01(Math.max(tB0onA, tB1onA));
		if (tAMax < 0 || tAMin > 1) {
			return null;
		}

		const tA0onB = projectPointOntoSegmentLine(segA.p0, segB);
		const tA1onB = projectPointOntoSegmentLine(segA.p1, segB);
		const tBMin = geo.snap01(Math.min(tA0onB, tA1onB));
		const tBMax = geo.snap01(Math.max(tA0onB, tA1onB));
		if (tBMax < 0 || tBMin > 1) {
			return null;
		}

		return {
			kind: "tRangePairs",
			tStart: [Math.max(0, tAMin), Math.max(0, tBMin)],
			tEnd: [Math.min(1, tAMax), Math.min(1, tBMax)],
		};
	}

	// otherwise, not coincident, so they intersect somewhere
	const dx = a0[0] - b0[0];
	const dy = a0[1] - b0[1];
	return new SegmentTValuePairsBuilder(allowOutOfRange, geo)
		.add((bdx * dy - bdy * dx) / axb, (adx * dy - ady * dx) / axb)
		.done();
}

function segmentLineIntersectSegmentCurve(
	segA: SegmentLine,
	segB: SegmentCurve,
	allowOutOfRange: boolean,
	invert: boolean,
): SegmentTValuePairs | null {
	const geo = segA.geo;
	const a0 = segA.p0;
	const a1 = segA.p1;

	const A = a1[1] - a0[1];
	const B = a0[0] - a1[0];

	if (geo.snap0(B) === 0) {
		// vertical line
		const t = segB.mapXtoT(a0[0], false);
		if (t === false) {
			return null;
		}
		const y = segB.point(t)[1];
		const s = (y - a0[1]) / A;
		const result = new SegmentTValuePairsBuilder(allowOutOfRange, geo);
		if (invert) {
			result.add(t, s);
		} else {
			result.add(s, t);
		}
		return result.done();
	}

	const C = A * a0[0] + B * a0[1];

	const bx = segB.getCubicCoefficients(0);
	const by = segB.getCubicCoefficients(1);

	const rA = A * bx[0] + B * by[0];
	const rB = A * bx[1] + B * by[1];
	const rC = A * bx[2] + B * by[2];
	const rD = A * bx[3] + B * by[3] - C;

	const roots = geo.solveCubic(rA, rB, rC, rD);

	const result = new SegmentTValuePairsBuilder(allowOutOfRange, geo);

	if (geo.snap0(A) === 0) {
		// project curve's X component onto line
		for (const t of roots) {
			const X = bx[0] * t * t * t + bx[1] * t * t + bx[2] * t + bx[3];
			const s = (a0[0] - X) / B;
			if (invert) {
				result.add(t, s);
			} else {
				result.add(s, t);
			}
		}
	} else {
		// project curve's Y component onto line
		for (const t of roots) {
			const Y = by[0] * t * t * t + by[1] * t * t + by[2] * t + by[3];
			const s = (Y - a0[1]) / A;
			if (invert) {
				result.add(t, s);
			} else {
				result.add(s, t);
			}
		}
	}

	return result.done();
}

function segmentCurveIntersectSegmentCurve(
	segA: SegmentCurve,
	segB: SegmentCurve,
	allowOutOfRange: boolean,
): SegmentTValuePairs | SegmentTRangePairs | null {
	const geo = segA.geo;

	// dummy coincident calculation for now
	// TODO: implement actual range/equality testing
	if (geo.isEqualVec2(segA.p0, segB.p0)) {
		if (geo.isEqualVec2(segA.p3, segB.p3)) {
			if (
				geo.isEqualVec2(segA.p1, segB.p1) &&
				geo.isEqualVec2(segA.p2, segB.p2)
			) {
				return {
					kind: "tRangePairs",
					tStart: [0, 0],
					tEnd: [1, 1],
				};
			} else {
				return {
					kind: "tValuePairs",
					tValuePairs: [
						[0, 0],
						[1, 1],
					],
				};
			}
		} else {
			return {
				kind: "tValuePairs",
				tValuePairs: [[0, 0]],
			};
		}
	} else if (geo.isEqualVec2(segA.p0, segB.p3)) {
		return {
			kind: "tValuePairs",
			tValuePairs: [[0, 1]],
		};
	} else if (geo.isEqualVec2(segA.p3, segB.p0)) {
		return {
			kind: "tValuePairs",
			tValuePairs: [[1, 0]],
		};
	} else if (geo.isEqualVec2(segA.p3, segB.p3)) {
		return {
			kind: "tValuePairs",
			tValuePairs: [[1, 1]],
		};
	}

	const result = new SegmentTValuePairsBuilder(allowOutOfRange, geo);

	const checkCurves = (
		c1: SegmentCurve,
		t1L: number,
		t1R: number,
		c2: SegmentCurve,
		t2L: number,
		t2R: number,
	) => {
		const bbox1 = c1.boundingBox();
		const bbox2 = c2.boundingBox();

		if (!boundingBoxesIntersect(bbox1, bbox2)) {
			return;
		}

		const t1M = (t1L + t1R) / 2;
		const t2M = (t2L + t2R) / 2;

		if (geo.snap0(t1R - t1L) === 0 && geo.snap0(t2R - t2L) === 0) {
			result.add(t1M, t2M);
			return;
		}

		const [c1L, c1R] = c1.split([0.5]);
		const [c2L, c2R] = c2.split([0.5]);
		checkCurves(c1L, t1L, t1M, c2L, t2L, t2M);
		checkCurves(c1R, t1M, t1R, c2L, t2L, t2M);
		checkCurves(c1L, t1L, t1M, c2R, t2M, t2R);
		checkCurves(c1R, t1M, t1R, c2R, t2M, t2R);
	};

	checkCurves(segA, 0, 1, segB, 0, 1);
	return result.done();
}

// return value:
//   null               => no intersection
//   SegmentTValuePairs => the segments intersect along a series of points, whose position is
//                         represented by T values pairs [segA_tValue, segB_tValue]
//                         note: a T value pair is returned even if it's just a shared vertex!
//   SegmentTRangePairs => the segments are coincident (on top of each other), and intersect along a
//                         segment, ranged by T values
function segmentsIntersect(
	segA: Segment,
	segB: Segment,
	allowOutOfRange: boolean,
): SegmentTValuePairs | SegmentTRangePairs | null {
	if (segA instanceof SegmentLine) {
		if (segB instanceof SegmentLine) {
			return segmentLineIntersectSegmentLine(segA, segB, allowOutOfRange);
		} else if (segB instanceof SegmentCurve) {
			return segmentLineIntersectSegmentCurve(
				segA,
				segB,
				allowOutOfRange,
				false,
			);
		}
	} else if (segA instanceof SegmentCurve) {
		if (segB instanceof SegmentLine) {
			return segmentLineIntersectSegmentCurve(
				segB,
				segA,
				allowOutOfRange,
				true,
			);
		} else if (segB instanceof SegmentCurve) {
			return segmentCurveIntersectSegmentCurve(segA, segB, allowOutOfRange);
		}
	}
	throw new Error("PolyBool: Unknown segment instance in segmentsIntersect");
}

interface SegmentBoolFill {
	above: boolean | null;
	below: boolean | null;
}

interface ListBoolTransition<T> {
	before: T | null;
	after: T | null;
	insert: (node: T) => T;
}

class SegmentBoolBase<T> {
	public id: number;
	public data: T;
	public myFill: SegmentBoolFill;
	public otherFill: SegmentBoolFill | null = null;
	public closed: boolean;

	public constructor(
		data: T,
		fill: SegmentBoolFill | null = null,
		closed = false,
	) {
		this.id = -1;
		this.data = data;
		this.myFill = {
			above: fill?.above ?? null,
			below: fill?.below ?? null,
		};
		this.closed = closed;
	}
}

class SegmentBoolLine extends SegmentBoolBase<SegmentLine> {}
class SegmentBoolCurve extends SegmentBoolBase<SegmentCurve> {}

type SegmentBool = SegmentBoolLine | SegmentBoolCurve;

class EventBool {
	public isStart: boolean;
	public p: Vec2;
	public seg: SegmentBool;
	public primary: boolean;
	public other!: EventBool;
	public status: EventBool | null = null;

	public constructor(
		isStart: boolean,
		p: Vec2,
		seg: SegmentBool,
		primary: boolean,
	) {
		this.isStart = isStart;
		this.p = p;
		this.seg = seg;
		this.primary = primary;
	}
}

class ListBool<T> {
	public readonly nodes: T[] = [];

	public remove(node: T) {
		const i = this.nodes.indexOf(node);
		if (i >= 0) {
			this.nodes.splice(i, 1);
		}
	}

	public getIndex(node: T) {
		return this.nodes.indexOf(node);
	}

	public isEmpty() {
		return this.nodes.length <= 0;
	}

	public getHead() {
		return this.nodes[0];
	}

	public removeHead() {
		this.nodes.shift();
	}

	public insertBefore(node: T, check: (node: T) => number) {
		this.findTransition(node, check).insert(node);
	}

	public findTransition(
		node: T,
		check: (node: T) => number,
	): ListBoolTransition<T> {
		// bisect to find the transition point
		const compare = (a: T, b: T) => check(b) - check(a);
		let i = 0;
		let high = this.nodes.length;
		while (i < high) {
			const mid = (i + high) >> 1;
			if (compare(this.nodes[mid], node) > 0) {
				high = mid;
			} else {
				i = mid + 1;
			}
		}
		return {
			before: i <= 0 ? null : (this.nodes[i - 1] ?? null),
			after: this.nodes[i] ?? null,
			insert: (node: T) => {
				this.nodes.splice(i, 0, node);
				return node;
			},
		};
	}
}

class Intersecter {
	private readonly selfIntersection: boolean;
	private readonly geo: Geometry;
	private readonly events = new ListBool<EventBool>();
	private readonly status = new ListBool<EventBool>();
	private currentPath: SegmentBool[] = [];

	public constructor(selfIntersection: boolean, geo: Geometry) {
		this.selfIntersection = selfIntersection;
		this.geo = geo;
	}

	private compareEvents(
		aStart: boolean,
		a1: Vec2,
		a2: Vec2,
		aSeg: Segment,
		bStart: boolean,
		b1: Vec2,
		b2: Vec2,
		bSeg: Segment,
	): number {
		// compare the selected points first
		const comp = this.geo.compareVec2(a1, b1);
		if (comp !== 0) {
			return comp;
		}
		// the selected points are the same

		if (
			aSeg instanceof SegmentLine &&
			bSeg instanceof SegmentLine &&
			this.geo.isEqualVec2(a2, b2)
		) {
			// if the non-selected points are the same too...
			return 0; // then the segments are equal
		}

		if (aStart !== bStart) {
			// if one is a start and the other isn't...
			return aStart ? 1 : -1; // favor the one that isn't the start
		}

		return this.compareSegments(bSeg, aSeg);
	}

	private addEvent(ev: EventBool) {
		this.events.insertBefore(ev, (here: EventBool) => {
			if (here === ev) {
				return 0;
			}
			return this.compareEvents(
				ev.isStart,
				ev.p,
				ev.other.p,
				ev.seg.data,
				here.isStart,
				here.p,
				here.other.p,
				here.seg.data,
			);
		});
	}

	private divideEvent(ev: EventBool, t: number, p: Vec2) {
		const [left, right] = ev.seg.data.split([t]) as [Segment, Segment];

		// set the *exact* intersection point
		left.setEnd(p);
		right.setStart(p);

		const ns =
			right instanceof SegmentLine
				? new SegmentBoolLine(right, ev.seg.myFill, ev.seg.closed)
				: right instanceof SegmentCurve
					? new SegmentBoolCurve(right, ev.seg.myFill, ev.seg.closed)
					: null;
		if (!ns) {
			throw new Error("PolyBool: Unknown segment data in divideEvent");
		}
		// slides an end backwards
		//   (start)------------(end)    to:
		//   (start)---(end)
		this.events.remove(ev.other);
		ev.seg.data = left;
		ev.other.p = p;
		this.addEvent(ev.other);
		return this.addSegment(ns, ev.primary);
	}

	public beginPath() {
		this.currentPath = [];
	}

	public closePath() {
		for (const seg of this.currentPath) {
			seg.closed = true;
		}
	}

	public addSegment(seg: SegmentBool, primary: boolean) {
		const evStart = new EventBool(true, seg.data.start(), seg, primary);
		const evEnd = new EventBool(false, seg.data.end(), seg, primary);
		evStart.other = evEnd;
		evEnd.other = evStart;
		this.addEvent(evStart);
		this.addEvent(evEnd);
		return evStart;
	}

	public addLine(from: Vec2, to: Vec2, primary = true) {
		const f = this.geo.compareVec2(from, to);
		if (f === 0) {
			// points are equal, so we have a zero-length segment
			return; // skip it
		}
		const seg = new SegmentBoolLine(
			new SegmentLine(f < 0 ? from : to, f < 0 ? to : from, this.geo),
			null,
			false,
		);
		this.currentPath.push(seg);
		this.addSegment(seg, primary);
	}

	public addCurve(from: Vec2, c1: Vec2, c2: Vec2, to: Vec2, primary = true) {
		const original = new SegmentCurve(from, c1, c2, to, this.geo);
		const curves = original.split(original.inflectionTValues());
		for (const curve of curves) {
			const f = this.geo.compareVec2(curve.start(), curve.end());
			if (f === 0) {
				// points are equal AFTER splitting... this only happens for zero-length segments
				continue; // skip it
			}
			// convert horizontal/vertical curves to lines
			const line = curve.toLine();
			if (line) {
				this.addLine(line.p0, line.p1, primary);
			} else {
				const seg = new SegmentBoolCurve(
					f < 0 ? curve : curve.reverse(),
					null,
					false,
				);
				this.currentPath.push(seg);
				this.addSegment(seg, primary);
			}
		}
	}

	private compareSegments(seg1: Segment, seg2: Segment): number {
		// TODO:
		//  This is where some of the curve instability comes from... we need to reliably sort
		//  segments, but this is surprisingly hard when it comes to curves.
		//
		//  The easy case is something like:
		//
		//             C   A - - - D
		//               \
		//                 \
		//                   B
		//  A is clearly above line C-B, which is easily calculated... however, once curves are
		//  introduced, it's not so obvious without using some heuristic which will fail at times.
		//
		let A = seg1.start();
		let B = seg2.start2();
		const C = seg2.start();
		if (seg2.pointOn(A)) {
			// A intersects seg2 somehow (possibly sharing a start point, or maybe just splitting it)
			//
			//   AC - - - - D
			//      \
			//        \
			//          B
			//
			// so grab seg1's second point (D) instead
			A = seg1.start2();
			if (seg2.pointOn(A)) {
				if (seg1 instanceof SegmentLine) {
					if (seg2 instanceof SegmentLine) {
						// oh... D is on the line too... so these are the same
						return 0;
					}
					if (seg2 instanceof SegmentCurve) {
						A = seg1.point(0.5); // TODO: ???
					}
				}
				if (seg1 instanceof SegmentCurve) {
					A = seg1.end();
				}
			}
			if (seg2 instanceof SegmentCurve) {
				if (
					this.geo.snap0(A[0] - C[0]) === 0 &&
					this.geo.snap0(B[0] - C[0]) === 0
				) {
					// seg2 is a curve, but the tangent line (C-B) at the start point is vertical, and
					// collinear with A... so... just sort based on the Y values I guess?
					return Math.sign(C[1] - A[1]);
				}
			}
		} else {
			if (seg2 instanceof SegmentCurve) {
				// find seg2's position at A[0] and see if it's above or below A[1]
				const y = seg2.mapXtoY(A[0], true);
				if (y !== false) {
					return Math.sign(y - A[1]);
				}
			}
			if (seg1 instanceof SegmentCurve) {
				// unfortunately, in order to sort against curved segments, we need to check the
				// intersection point... this means a lot more intersection tests, but I'm not sure how else
				// to sort correctly
				const i = segmentsIntersect(seg1, seg2, true);
				if (i && i.kind === "tValuePairs") {
					// find the intersection point on seg1
					for (const pair of i.tValuePairs) {
						const t = this.geo.snap01(pair[0]);
						if (t > 0 && t < 1) {
							B = seg1.point(t);
							break;
						}
					}
				}
			}
		}

		// fallthrough to this calculation which determines if A is on one side or another of C-B
		const [Ax, Ay] = A;
		const [Bx, By] = B;
		const [Cx, Cy] = C;
		return Math.sign((Bx - Ax) * (Cy - Ay) - (By - Ay) * (Cx - Ax));
	}

	private statusFindSurrounding(ev: EventBool) {
		return this.status.findTransition(ev, (here: EventBool) => {
			if (ev === here) {
				return 0;
			}
			const c = this.compareSegments(ev.seg.data, here.seg.data);
			return c === 0 ? -1 : c;
		});
	}

	private checkIntersection(ev1: EventBool, ev2: EventBool): EventBool | null {
		// returns the segment equal to ev1, or null if nothing equal
		const seg1 = ev1.seg;
		const seg2 = ev2.seg;

		const i = segmentsIntersect(seg1.data, seg2.data, false);

		if (i === null) {
			// no intersections
			return null;
		} else if (i.kind === "tRangePairs") {
			// segments are parallel or coincident
			const {
				tStart: [tA1, tB1],
				tEnd: [tA2, tB2],
			} = i;

			if (
				(tA1 === 1 && tA2 === 1 && tB1 === 0 && tB2 === 0) ||
				(tA1 === 0 && tA2 === 0 && tB1 === 1 && tB2 === 1)
			) {
				return null; // segments touch at endpoints... no intersection
			}

			if (tA1 === 0 && tA2 === 1 && tB1 === 0 && tB2 === 1) {
				return ev2; // segments are exactly equal
			}

			const a1 = seg1.data.start();
			const a2 = seg1.data.end();
			const b2 = seg2.data.end();

			if (tA1 === 0 && tB1 === 0) {
				if (tA2 === 1) {
					//  (a1)---(a2)
					//  (b1)----------(b2)
					this.divideEvent(ev2, tB2, a2);
				} else {
					//  (a1)----------(a2)
					//  (b1)---(b2)
					this.divideEvent(ev1, tA2, b2);
				}
				return ev2;
			} else if (tB1 > 0 && tB1 < 1) {
				if (tA2 === 1 && tB2 === 1) {
					//         (a1)---(a2)
					//  (b1)----------(b2)
					this.divideEvent(ev2, tB1, a1);
				} else {
					// make a2 equal to b2
					if (tA2 === 1) {
						//         (a1)---(a2)
						//  (b1)-----------------(b2)
						this.divideEvent(ev2, tB2, a2);
					} else {
						//         (a1)----------(a2)
						//  (b1)----------(b2)
						this.divideEvent(ev1, tA2, b2);
					}
					//         (a1)---(a2)
					//  (b1)----------(b2)
					this.divideEvent(ev2, tB1, a1);
				}
			}
			return null;
		} else if (i.kind === "tValuePairs") {
			if (i.tValuePairs.length <= 0) {
				return null;
			}
			// process a single intersection

			// skip intersections where endpoints meet
			let minPair = i.tValuePairs[0];
			for (
				let j = 1;
				j < i.tValuePairs.length &&
				((minPair[0] === 0 && minPair[1] === 0) ||
					(minPair[0] === 0 && minPair[1] === 1) ||
					(minPair[0] === 1 && minPair[1] === 0) ||
					(minPair[0] === 1 && minPair[1] === 1));
				j++
			) {
				minPair = i.tValuePairs[j];
			}
			const [tA, tB] = minPair;

			// even though *in theory* seg1.data.point(tA) === seg2.data.point(tB), that isn't exactly
			// correct in practice because intersections aren't exact... so we need to calculate a single
			// intersection point that everyone can share
			const p =
				tB === 0
					? seg2.data.start()
					: tB === 1
						? seg2.data.end()
						: tA === 0
							? seg1.data.start()
							: tA === 1
								? seg1.data.end()
								: seg1.data.point(tA);

			// is A divided between its endpoints? (exclusive)
			if (tA > 0 && tA < 1) {
				this.divideEvent(ev1, tA, p);
			}
			// is B divided between its endpoints? (exclusive)
			if (tB > 0 && tB < 1) {
				this.divideEvent(ev2, tB, p);
			}
			return null;
		}
		throw new Error("PolyBool: Unknown intersection type");
	}

	public calculate() {
		const segments: SegmentBool[] = [];
		while (!this.events.isEmpty()) {
			const ev = this.events.getHead();

			if (ev.isStart) {
				const surrounding = this.statusFindSurrounding(ev);
				const above = surrounding.before;
				const below = surrounding.after;
				const checkBothIntersections = () => {
					if (above) {
						const eve = this.checkIntersection(ev, above);
						if (eve) {
							return eve;
						}
					}
					if (below) {
						return this.checkIntersection(ev, below);
					}
					return null;
				};

				const eve = checkBothIntersections();
				if (eve) {
					// ev and eve are equal
					// we'll keep eve and throw away ev

					// merge ev.seg's fill information into eve.seg

					if (this.selfIntersection) {
						let toggle: boolean; // are we a toggling edge?
						if (ev.seg.myFill.below === null) {
							toggle = ev.seg.closed;
						} else {
							toggle = ev.seg.myFill.above !== ev.seg.myFill.below;
						}

						// merge two segments that belong to the same polygon
						// think of this as sandwiching two segments together, where
						// `eve.seg` is the bottom -- this will cause the above fill flag to
						// toggle
						if (toggle) {
							eve.seg.myFill.above = !eve.seg.myFill.above;
						}
					} else {
						// merge two segments that belong to different polygons
						// each segment has distinct knowledge, so no special logic is
						// needed
						// note that this can only happen once per segment in this phase,
						// because we are guaranteed that all self-intersections are gone
						eve.seg.otherFill = ev.seg.myFill;
					}

					this.events.remove(ev.other);
					this.events.remove(ev);
				}

				if (this.events.getHead() !== ev) {
					// something was inserted before us in the event queue, so loop back
					// around and process it before continuing
					continue;
				}

				//
				// calculate fill flags
				//
				if (this.selfIntersection) {
					let toggle: boolean; // are we a toggling edge?
					if (ev.seg.myFill.below === null) {
						// if we are new then we toggle if we're part of a closed path
						toggle = ev.seg.closed;
					} else {
						// we are a segment that has previous knowledge from a division
						// calculate toggle
						toggle = ev.seg.myFill.above !== ev.seg.myFill.below;
					}

					// next, calculate whether we are filled below us
					if (!below) {
						// if nothing is below us, then we're not filled
						ev.seg.myFill.below = false;
					} else {
						// otherwise, we know the answer -- it's the same if whatever is
						// below us is filled above it
						ev.seg.myFill.below = below.seg.myFill.above;
					}

					// since now we know if we're filled below us, we can calculate
					// whether we're filled above us by applying toggle to whatever is
					// below us
					ev.seg.myFill.above = toggle
						? !ev.seg.myFill.below
						: ev.seg.myFill.below;
				} else {
					// now we fill in any missing transition information, since we are
					// all-knowing at this point

					if (ev.seg.otherFill === null) {
						// if we don't have other information, then we need to figure out if
						// we're inside the other polygon
						let inside: boolean | null;
						if (!below) {
							// if nothing is below us, then we're not filled
							inside = false;
						} else {
							// otherwise, something is below us
							// so copy the below segment's other polygon's above
							if (ev.primary === below.primary) {
								if (below.seg.otherFill === null) {
									throw new Error(
										"PolyBool: Unexpected state of otherFill (null)",
									);
								}
								inside = below.seg.otherFill.above;
							} else {
								inside = below.seg.myFill.above;
							}
						}
						ev.seg.otherFill = {
							above: inside,
							below: inside,
						};
					}
				}
				// insert the status and remember it for later removal
				ev.other.status = surrounding.insert(ev);
			} else {
				// end
				const st = ev.status;

				if (st === null) {
					throw new Error(
						"PolyBool: Zero-length segment detected; your epsilon is " +
							"probably too small or too large",
					);
				}

				// removing the status will create two new adjacent edges, so we'll need
				// to check for those
				const i = this.status.getIndex(st);
				if (i > 0 && i < this.status.nodes.length - 1) {
					const before = this.status.nodes[i - 1];
					const after = this.status.nodes[i + 1];
					this.checkIntersection(before, after);
				}

				// remove the status
				this.status.remove(st);

				// if we've reached this point, we've calculated everything there is to
				// know, so save the segment for reporting
				if (!ev.primary) {
					// make sure `seg.myFill` actually points to the primary polygon
					// though
					if (!ev.seg.otherFill) {
						throw new Error("PolyBool: Unexpected state of otherFill (null)");
					}
					const s = ev.seg.myFill;
					ev.seg.myFill = ev.seg.otherFill;
					ev.seg.otherFill = s;
				}
				segments.push(ev.seg);
			}

			// remove the event and continue
			this.events.removeHead();
		}

		return segments;
	}
}

//
// filter a list of segments based on boolean operations
//

function select(segments: SegmentBool[], selection: number[]): SegmentBool[] {
	const result: SegmentBool[] = [];
	for (const seg of segments) {
		const index =
			(seg.myFill.above ? 8 : 0) +
			(seg.myFill.below ? 4 : 0) +
			(seg.otherFill?.above ? 2 : 0) +
			(seg.otherFill?.below ? 1 : 0);
		const flags = selection[index];
		const above = (flags & 1) !== 0; // bit 1 if filled above
		const below = (flags & 2) !== 0; // bit 2 if filled below
		if ((!seg.closed && flags !== 0) || (seg.closed && above !== below)) {
			// copy the segment to the results, while also calculating the fill status
			const fill = { above, below };
			if (seg instanceof SegmentBoolLine) {
				result.push(new SegmentBoolLine(seg.data, fill, seg.closed));
			} else if (seg instanceof SegmentBoolCurve) {
				result.push(new SegmentBoolCurve(seg.data, fill, seg.closed));
			} else {
				throw new Error(
					"PolyBool: Unknown SegmentBool type in SegmentSelector",
				);
			}
		}
	}
	return result;
}

class SegmentSelector {
	// prettier-ignore
	public static union(segments: SegmentBool[]) {
		// primary | secondary
		// above1 below1 above2 below2    Keep?               Value
		//    0      0      0      0   =>   yes if open         4
		//    0      0      0      1   =>   yes filled below    2
		//    0      0      1      0   =>   yes filled above    1
		//    0      0      1      1   =>   no                  0
		//    0      1      0      0   =>   yes filled below    2
		//    0      1      0      1   =>   yes filled below    2
		//    0      1      1      0   =>   no                  0
		//    0      1      1      1   =>   no                  0
		//    1      0      0      0   =>   yes filled above    1
		//    1      0      0      1   =>   no                  0
		//    1      0      1      0   =>   yes filled above    1
		//    1      0      1      1   =>   no                  0
		//    1      1      0      0   =>   no                  0
		//    1      1      0      1   =>   no                  0
		//    1      1      1      0   =>   no                  0
		//    1      1      1      1   =>   no                  0
		return select(segments, [4, 2, 1, 0, 2, 2, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0]);
	}

	// prettier-ignore
	public static intersect(segments: SegmentBool[]) {
		// primary & secondary
		// above1 below1 above2 below2    Keep?               Value
		//    0      0      0      0   =>   no                  0
		//    0      0      0      1   =>   no                  0
		//    0      0      1      0   =>   no                  0
		//    0      0      1      1   =>   yes if open         4
		//    0      1      0      0   =>   no                  0
		//    0      1      0      1   =>   yes filled below    2
		//    0      1      1      0   =>   no                  0
		//    0      1      1      1   =>   yes filled below    2
		//    1      0      0      0   =>   no                  0
		//    1      0      0      1   =>   no                  0
		//    1      0      1      0   =>   yes filled above    1
		//    1      0      1      1   =>   yes filled above    1
		//    1      1      0      0   =>   yes if open         4
		//    1      1      0      1   =>   yes filled below    2
		//    1      1      1      0   =>   yes filled above    1
		//    1      1      1      1   =>   no                  0
		return select(segments, [0, 0, 0, 4, 0, 2, 0, 2, 0, 0, 1, 1, 4, 2, 1, 0]);
	}

	// prettier-ignore
	public static difference(segments: SegmentBool[]) {
		// primary - secondary
		// above1 below1 above2 below2    Keep?               Value
		//    0      0      0      0   =>   yes if open         4
		//    0      0      0      1   =>   no                  0
		//    0      0      1      0   =>   no                  0
		//    0      0      1      1   =>   no                  0
		//    0      1      0      0   =>   yes filled below    2
		//    0      1      0      1   =>   no                  0
		//    0      1      1      0   =>   yes filled below    2
		//    0      1      1      1   =>   no                  0
		//    1      0      0      0   =>   yes filled above    1
		//    1      0      0      1   =>   yes filled above    1
		//    1      0      1      0   =>   no                  0
		//    1      0      1      1   =>   no                  0
		//    1      1      0      0   =>   no                  0
		//    1      1      0      1   =>   yes filled above    1
		//    1      1      1      0   =>   yes filled below    2
		//    1      1      1      1   =>   no                  0
		return select(segments, [4, 0, 0, 0, 2, 0, 2, 0, 1, 1, 0, 0, 0, 1, 2, 0]);
	}

	// prettier-ignore
	public static differenceRev(segments: SegmentBool[]) {
		// secondary - primary
		// above1 below1 above2 below2    Keep?               Value
		//    0      0      0      0   =>   yes if open         4
		//    0      0      0      1   =>   yes filled below    2
		//    0      0      1      0   =>   yes filled above    1
		//    0      0      1      1   =>   no                  0
		//    0      1      0      0   =>   no                  0
		//    0      1      0      1   =>   no                  0
		//    0      1      1      0   =>   yes filled above    1
		//    0      1      1      1   =>   yes filled above    1
		//    1      0      0      0   =>   no                  0
		//    1      0      0      1   =>   yes filled below    2
		//    1      0      1      0   =>   no                  0
		//    1      0      1      1   =>   yes filled below    2
		//    1      1      0      0   =>   no                  0
		//    1      1      0      1   =>   no                  0
		//    1      1      1      0   =>   no                  0
		//    1      1      1      1   =>   no                  0
		return select(segments, [4, 2, 1, 0, 0, 0, 1, 1, 0, 2, 0, 2, 0, 0, 0, 0]);
	}

	// prettier-ignore
	public static xor(segments: SegmentBool[]) {
		// primary ^ secondary
		// above1 below1 above2 below2    Keep?               Value
		//    0      0      0      0   =>   yes if open         4
		//    0      0      0      1   =>   yes filled below    2
		//    0      0      1      0   =>   yes filled above    1
		//    0      0      1      1   =>   no                  0
		//    0      1      0      0   =>   yes filled below    2
		//    0      1      0      1   =>   no                  0
		//    0      1      1      0   =>   no                  0
		//    0      1      1      1   =>   yes filled above    1
		//    1      0      0      0   =>   yes filled above    1
		//    1      0      0      1   =>   no                  0
		//    1      0      1      0   =>   no                  0
		//    1      0      1      1   =>   yes filled below    2
		//    1      1      0      0   =>   no                  0
		//    1      1      0      1   =>   yes filled above    1
		//    1      1      1      0   =>   yes filled below    2
		//    1      1      1      1   =>   no                  0
		return select(segments, [4, 2, 1, 0, 2, 0, 0, 1, 1, 0, 0, 2, 0, 1, 2, 0]);
	}
}

//
// converts a list of segments into a list of regions, while also removing
// unnecessary verticies
//

function joinLines(
	seg1: SegmentLine,
	seg2: SegmentLine,
	geo: Geometry,
): SegmentLine | false {
	if (geo.isCollinear(seg1.p0, seg1.p1, seg2.p1)) {
		return new SegmentLine(seg1.p0, seg2.p1, geo);
	}
	return false;
}

function joinCurves(
	seg1: SegmentCurve,
	seg2: SegmentCurve,
	geo: Geometry,
): SegmentCurve | false {
	if (geo.isCollinear(seg1.p2, seg1.p3, seg2.p1)) {
		const dx = seg2.p1[0] - seg1.p2[0];
		const dy = seg2.p1[1] - seg1.p2[1];
		const t =
			Math.abs(dx) > Math.abs(dy)
				? (seg1.p3[0] - seg1.p2[0]) / dx
				: (seg1.p3[1] - seg1.p2[1]) / dy;
		const ts = geo.snap01(t);
		if (ts !== 0 && ts !== 1) {
			const ns = new SegmentCurve(
				seg1.p0,
				[
					seg1.p0[0] + (seg1.p1[0] - seg1.p0[0]) / t,
					seg1.p0[1] + (seg1.p1[1] - seg1.p0[1]) / t,
				],
				[
					seg2.p2[0] - (t * (seg2.p3[0] - seg2.p2[0])) / (1 - t),
					seg2.p2[1] - (t * (seg2.p3[1] - seg2.p2[1])) / (1 - t),
				],
				seg2.p3,
				geo,
			);
			// double check that if we split at T, we get seg1/seg2 back
			const [left, right] = ns.split([t]);
			if (left.isEqual(seg1) && right.isEqual(seg2)) {
				return ns;
			}
		}
	}
	return false;
}

function joinSegments(
	seg1: Segment | undefined,
	seg2: Segment | undefined,
	geo: Geometry,
): Segment | false {
	if (seg1 === seg2) {
		return false;
	}
	if (seg1 instanceof SegmentLine && seg2 instanceof SegmentLine) {
		return joinLines(seg1, seg2, geo);
	}
	if (seg1 instanceof SegmentCurve && seg2 instanceof SegmentCurve) {
		return joinCurves(seg1, seg2, geo);
	}
	return false;
}

interface ISegsFill {
	segs: Segment[];
	fill: boolean;
}

function SegmentChainer(segments: SegmentBool[], geo: Geometry): Segment[][] {
	const closedChains: ISegsFill[] = [];
	const openChains: ISegsFill[] = [];
	const regions: Segment[][] = [];

	for (const segb of segments) {
		let seg = segb.data;
		const closed = segb.closed;
		const chains = closed ? closedChains : openChains;
		const pt1 = seg.start();
		const pt2 = seg.end();

		const reverseChain = (index: number) => {
			const newChain: Segment[] = [];
			for (const seg of chains[index].segs) {
				newChain.unshift(seg.reverse());
			}
			chains[index] = {
				segs: newChain,
				fill: !chains[index].fill,
			};
			return newChain;
		};

		if (seg instanceof SegmentLine && geo.isEqualVec2(pt1, pt2)) {
			console.warn(
				"PolyBool: Warning: Zero-length segment detected; your epsilon is " +
					"probably too small or too large",
			);
			continue;
		}

		// search for two chains that this segment matches
		const firstMatch = {
			index: 0,
			matchesHead: false,
			matchesPt1: false,
		};
		const secondMatch = {
			index: 0,
			matchesHead: false,
			matchesPt1: false,
		};
		let nextMatch: typeof firstMatch | null = firstMatch;
		function setMatch(
			index: number,
			matchesHead: boolean,
			matchesPt1: boolean,
		) {
			// return true if we've matched twice
			if (nextMatch) {
				nextMatch.index = index;
				nextMatch.matchesHead = matchesHead;
				nextMatch.matchesPt1 = matchesPt1;
			}
			if (nextMatch === firstMatch) {
				nextMatch = secondMatch;
				return false;
			}
			nextMatch = null;
			return true; // we've matched twice, we're done here
		}
		for (let i = 0; i < chains.length; i++) {
			const chain = chains[i].segs;
			const head = chain[0].start();
			const tail = chain[chain.length - 1].end();
			if (geo.isEqualVec2(head, pt1)) {
				if (setMatch(i, true, true)) {
					break;
				}
			} else if (geo.isEqualVec2(head, pt2)) {
				if (setMatch(i, true, false)) {
					break;
				}
			} else if (geo.isEqualVec2(tail, pt1)) {
				if (setMatch(i, false, true)) {
					break;
				}
			} else if (geo.isEqualVec2(tail, pt2)) {
				if (setMatch(i, false, false)) {
					break;
				}
			}
		}

		if (nextMatch === firstMatch) {
			// we didn't match anything, so create a new chain
			const fill = !!segb.myFill.above;
			chains.push({ segs: [seg], fill });
		} else if (nextMatch === secondMatch) {
			// we matched a single chain
			const index = firstMatch.index;

			// add the other point to the apporpriate end
			const { segs: chain, fill } = chains[index];
			if (firstMatch.matchesHead) {
				if (firstMatch.matchesPt1) {
					seg = seg.reverse();
					chain.unshift(seg);
				} else {
					chain.unshift(seg);
				}
			} else {
				if (firstMatch.matchesPt1) {
					chain.push(seg);
				} else {
					seg = seg.reverse();
					chain.push(seg);
				}
			}

			// simplify chain
			if (firstMatch.matchesHead) {
				const next = chain[1];
				const newSeg = joinSegments(seg, next, geo);
				if (newSeg) {
					chain.shift();
					chain[0] = newSeg;
				}
			} else {
				const next = chain[chain.length - 2];
				const newSeg = joinSegments(next, seg, geo);
				if (newSeg) {
					chain.pop();
					chain[chain.length - 1] = newSeg;
				}
			}

			// check for closed chain
			if (closed) {
				let finalChain = chain;
				let segS = finalChain[0];
				let segE = finalChain[finalChain.length - 1];
				if (
					finalChain.length > 0 &&
					geo.isEqualVec2(segS.start(), segE.end())
				) {
					// see if chain is clockwise
					let winding = 0;
					let last = finalChain[0].start();
					for (const seg of finalChain) {
						const here = seg.end();
						winding += here[1] * last[0] - here[0] * last[1];
						last = here;
					}
					// this assumes Cartesian coordinates (Y is positive going up)
					const isClockwise = winding < 0;
					if (isClockwise === fill) {
						finalChain = reverseChain(index);
						segS = finalChain[0];
						segE = finalChain[finalChain.length - 1];
					}

					const newStart = joinSegments(segE, segS, geo);
					if (newStart) {
						finalChain.pop();
						finalChain[0] = newStart;
					}

					// we have a closed chain!
					chains.splice(index, 1);
					regions.push(finalChain);
				}
			}
		} else {
			// otherwise, we matched two chains, so we need to combine those chains together
			const appendChain = (index1: number, index2: number) => {
				// index1 gets index2 appended to it, and index2 is removed
				const { segs: chain1, fill } = chains[index1];
				const { segs: chain2 } = chains[index2];

				// add seg to chain1's tail
				chain1.push(seg);

				// simplify chain1's tail
				const next = chain1[chain1.length - 2];
				const newEnd = joinSegments(next, seg, geo);
				if (newEnd) {
					chain1.pop();
					chain1[chain1.length - 1] = newEnd;
				}

				// simplify chain2's head
				const tail = chain1[chain1.length - 1];
				const head = chain2[0];
				const newJoin = joinSegments(tail, head, geo);
				if (newJoin) {
					chain2.shift();
					chain1[chain1.length - 1] = newJoin;
				}
				chains[index1].segs = chain1.concat(chain2);
				chains.splice(index2, 1);
			};

			const F = firstMatch.index;
			const S = secondMatch.index;

			// reverse the shorter chain, if needed
			const reverseF = chains[F].segs.length < chains[S].segs.length;
			if (firstMatch.matchesHead) {
				if (secondMatch.matchesHead) {
					if (reverseF) {
						if (!firstMatch.matchesPt1) {
							// <<<< F <<<< <-- >>>> S >>>>
							seg = seg.reverse();
						}
						// <<<< F <<<< --> >>>> S >>>>
						reverseChain(F);
						// >>>> F >>>> --> >>>> S >>>>
						appendChain(F, S);
					} else {
						if (firstMatch.matchesPt1) {
							// <<<< F <<<< --> >>>> S >>>>
							seg = seg.reverse();
						}
						// <<<< F <<<< <-- >>>> S >>>>
						reverseChain(S);
						// <<<< F <<<< <-- <<<< S <<<<   logically same as:
						// >>>> S >>>> --> >>>> F >>>>
						appendChain(S, F);
					}
				} else {
					if (firstMatch.matchesPt1) {
						// <<<< F <<<< --> >>>> S >>>>
						seg = seg.reverse();
					}
					// <<<< F <<<< <-- <<<< S <<<<   logically same as:
					// >>>> S >>>> --> >>>> F >>>>
					appendChain(S, F);
				}
			} else {
				if (secondMatch.matchesHead) {
					if (!firstMatch.matchesPt1) {
						// >>>> F >>>> <-- >>>> S >>>>
						seg = seg.reverse();
					}
					// >>>> F >>>> --> >>>> S >>>>
					appendChain(F, S);
				} else {
					if (reverseF) {
						if (firstMatch.matchesPt1) {
							// >>>> F >>>> --> <<<< S <<<<
							seg = seg.reverse();
						}
						// >>>> F >>>> <-- <<<< S <<<<
						reverseChain(F);
						// <<<< F <<<< <-- <<<< S <<<<   logically same as:
						// >>>> S >>>> --> >>>> F >>>>
						appendChain(S, F);
					} else {
						if (!firstMatch.matchesPt1) {
							// >>>> F >>>> <-- <<<< S <<<<
							seg = seg.reverse();
						}
						// >>>> F >>>> --> <<<< S <<<<
						reverseChain(S);
						// >>>> F >>>> --> >>>> S >>>>
						appendChain(F, S);
					}
				}
			}
		}
	}
	for (const { segs } of openChains) {
		regions.push(segs);
	}
	return regions;
}

export type BooleanOp =
	| "union"
	| "intersect"
	| "difference"
	| "differenceRev"
	| "xor";

/**
 * Perform a boolean operation on two sets of closed contours.
 * Each contour is an array of segments (SegmentLine or SegmentCurve).
 * Returns the resulting contours.
 */
export function booleanOp(
	contoursA: Segment[][],
	contoursB: Segment[][],
	op: BooleanOp,
	epsilon?: number,
): Segment[][] {
	const geo = new GeometryEpsilon(epsilon);

	// Step 1: Self-intersect each polygon to compute myFill flags
	const selfA = runSelfIntersect(contoursA, geo);
	const selfB = runSelfIntersect(contoursB, geo);

	// Step 2: Combine both self-intersected polygons
	const inter = new Intersecter(false, geo);
	for (const seg of selfA) {
		addSegmentBool(inter, seg, true);
	}
	for (const seg of selfB) {
		addSegmentBool(inter, seg, false);
	}
	const segments = inter.calculate();

	const selectors: Record<BooleanOp, (s: SegmentBool[]) => SegmentBool[]> = {
		union: (s) => SegmentSelector.union(s),
		intersect: (s) => SegmentSelector.intersect(s),
		difference: (s) => SegmentSelector.difference(s),
		differenceRev: (s) => SegmentSelector.differenceRev(s),
		xor: (s) => SegmentSelector.xor(s),
	};

	const selected = selectors[op](segments);
	return SegmentChainer(selected, geo);
}

function runSelfIntersect(
	contours: Segment[][],
	geo: GeometryEpsilon,
): SegmentBool[] {
	const inter = new Intersecter(true, geo);
	for (const contour of contours) {
		inter.beginPath();
		for (const seg of contour) {
			if (seg instanceof SegmentLine) {
				inter.addLine(seg.p0, seg.p1);
			} else {
				inter.addCurve(seg.p0, seg.p1, seg.p2, seg.p3);
			}
		}
		inter.closePath();
	}
	return inter.calculate();
}

function addSegmentBool(
	inter: Intersecter,
	seg: SegmentBool,
	primary: boolean,
): void {
	const data = seg.data;
	const ns =
		data instanceof SegmentLine
			? new SegmentBoolLine(data, seg.myFill, seg.closed)
			: new SegmentBoolCurve(data as SegmentCurve, seg.myFill, seg.closed);
	inter.addSegment(ns, primary);
}
