import { lerp } from "../../math";
import type { Geometry, Vec2 } from "../primitives/bezier";

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

	/**
	 * The point the curve heads toward from its start. A control point lying on
	 * the start gives no direction, so the next distinct point stands in for it.
	 */
	public start2() {
		return (
			[this.p1, this.p2].find((p) => !this.geo.isEqualVec2(p, this.p0)) ??
			this.p3
		);
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
				// A linear coordinate has no interior extremum; dividing by zero
				// here would put NaN into the bounding box.
				if (this.geo.snap0(b) !== 0) result.add(-c / b);
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

/**
 * Two curves leaving a shared endpoint stay within the subdivision search's
 * resolution of each other for a while, which reports false hits there; each
 * hit splits the curves into new pieces sharing an endpoint, so the false hits
 * would repeat without end. Pieces this close in t to a shared endpoint are
 * left out of the search, so a crossing inside them counts as that endpoint.
 */
const SHARED_ENDPOINT_T_RADIUS = 1e-4;

function segmentCurveIntersectSegmentCurve(
	segA: SegmentCurve,
	segB: SegmentCurve,
	allowOutOfRange: boolean,
): SegmentTValuePairs | SegmentTRangePairs | null {
	const geo = segA.geo;
	const result = new SegmentTValuePairsBuilder(allowOutOfRange, geo);

	const sharedEndpoints: Vec2[] = [];
	for (const [tA, pA] of [
		[0, segA.p0],
		[1, segA.p3],
	] as const) {
		for (const [tB, pB] of [
			[0, segB.p0],
			[1, segB.p3],
		] as const) {
			if (!geo.isEqualVec2(pA, pB)) continue;
			result.add(tA, tB);
			sharedEndpoints.push([tA, tB]);
		}
	}

	// Curves lying on each other overlap in every subdivision below, so the
	// search further down would never stop; they are reported as a range.
	if (sharedEndpoints.length > 0) {
		const overlap = curveOverlap(segA, segB);
		if (overlap) return overlap;
	}

	const nearSharedEndpoint = (
		t1L: number,
		t1R: number,
		t2L: number,
		t2R: number,
	) =>
		sharedEndpoints.some(
			([tA, tB]) =>
				Math.max(Math.abs(t1L - tA), Math.abs(t1R - tA)) <=
					SHARED_ENDPOINT_T_RADIUS &&
				Math.max(Math.abs(t2L - tB), Math.abs(t2R - tB)) <=
					SHARED_ENDPOINT_T_RADIUS,
		);

	const checkCurves = (
		c1: SegmentCurve,
		t1L: number,
		t1R: number,
		c2: SegmentCurve,
		t2L: number,
		t2R: number,
	) => {
		if (nearSharedEndpoint(t1L, t1R, t2L, t2R)) return;

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

/** The range where one curve is a piece of the other, or null when neither is. */
function curveOverlap(
	segA: SegmentCurve,
	segB: SegmentCurve,
): SegmentTRangePairs | null {
	const bOnA = subCurveRange(segA, segB);
	if (bOnA) {
		return { kind: "tRangePairs", tStart: [bOnA[0], 0], tEnd: [bOnA[1], 1] };
	}
	const aOnB = subCurveRange(segB, segA);
	if (aOnB) {
		return { kind: "tRangePairs", tStart: [0, aOnB[0]], tEnd: [1, aOnB[1]] };
	}
	return null;
}

/** The t range of `whole` that traces exactly `piece`, or null when none does. */
function subCurveRange(whole: SegmentCurve, piece: SegmentCurve): Vec2 | null {
	const geo = whole.geo;
	if (!whole.pointOn(piece.p0) || !whole.pointOn(piece.p3)) return null;
	const t0 = whole.mapXtoT(piece.p0[0]);
	const t1 = whole.mapXtoT(piece.p3[0]);
	if (t0 === false || t1 === false) return null;
	const range: Vec2 = [geo.snap01(t0), geo.snap01(t1)];
	if (range[0] >= range[1]) return null;
	const [, middle] = whole.split(range);
	return middle.isEqual(piece) ? range : null;
}

// return value:
//   null               => no intersection
//   SegmentTValuePairs => the segments intersect along a series of points, whose position is
//                         represented by T values pairs [segA_tValue, segB_tValue]
//                         note: a T value pair is returned even if it's just a shared vertex!
//   SegmentTRangePairs => the segments are coincident (on top of each other), and intersect along a
//                         segment, ranged by T values
export function segmentsIntersect(
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
