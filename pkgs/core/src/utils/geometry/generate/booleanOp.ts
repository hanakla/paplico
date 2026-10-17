import type { CubicBezierSegment } from "../../../schema";
import {
	type Geometry,
	GeometryEpsilon,
	type Vec2,
} from "../primitives/bezier";
import { resolveSegment } from "../primitives/segment";
import { groupRingsByContainment } from "../query/ringContainment";
import {
	type Segment,
	SegmentCurve,
	SegmentLine,
	segmentsIntersect,
} from "../query/segmentIntersection";

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
	/**
	 * How much the winding number rises from below this segment to above it:
	 * +1 when its contour ran left to right, -1 when it ran right to left.
	 */
	public winding: number;
	/** Winding number just above this segment, set by the self-intersection pass. */
	public windingAbove = 0;

	public constructor(
		data: T,
		fill: SegmentBoolFill | null = null,
		closed = false,
		winding = 0,
	) {
		this.id = -1;
		this.data = data;
		this.myFill = {
			above: fill?.above ?? null,
			below: fill?.below ?? null,
		};
		this.closed = closed;
		this.winding = winding;
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

	/**
	 * Whether an intersection at `t` and `p` cuts the segment between its
	 * endpoints. A curve barely moves near an end whose handle is zero, so a `t`
	 * short of 0 or 1 can still land on that end and would leave a zero-length
	 * piece.
	 */
	private dividesInside(seg: Segment, t: number, p: Vec2): boolean {
		return (
			t > 0 &&
			t < 1 &&
			!this.geo.isEqualVec2(p, seg.start()) &&
			!this.geo.isEqualVec2(p, seg.end())
		);
	}

	private divideEvent(ev: EventBool, t: number, p: Vec2) {
		const [left, right] = ev.seg.data.split([t]) as [Segment, Segment];

		// set the *exact* intersection point
		left.setEnd(p);
		right.setStart(p);

		const ns =
			right instanceof SegmentLine
				? new SegmentBoolLine(
						right,
						ev.seg.myFill,
						ev.seg.closed,
						ev.seg.winding,
					)
				: right instanceof SegmentCurve
					? new SegmentBoolCurve(
							right,
							ev.seg.myFill,
							ev.seg.closed,
							ev.seg.winding,
						)
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
			f < 0 ? 1 : -1,
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
					f < 0 ? 1 : -1,
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

			if (this.dividesInside(seg1.data, tA, p)) {
				this.divideEvent(ev1, tA, p);
			}
			if (this.dividesInside(seg2.data, tB, p)) {
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
						// merge two segments that belong to the same polygon
						// think of this as sandwiching two segments together, where
						// `eve.seg` is the bottom -- the winding above it now also
						// counts `ev.seg`
						eve.seg.winding += ev.seg.winding;
						eve.seg.windingAbove += ev.seg.winding;
						eve.seg.myFill.above = eve.seg.windingAbove !== 0;
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
					// Fill under the non-zero rule the renderer uses, so a region the
					// contour winds around twice stays filled: the winding below us is
					// the winding above whatever is below us (none when nothing is),
					// and crossing us adds our own winding.
					const windingBelow = below?.seg.windingAbove ?? 0;
					ev.seg.windingAbove = windingBelow + ev.seg.winding;
					ev.seg.myFill.below = windingBelow !== 0;
					ev.seg.myFill.above = ev.seg.windingAbove !== 0;
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
 * Returns the resulting contours with holes wound against their solids, so
 * the result reads correctly under the non-zero rule, including when it is
 * fed back into another booleanOp.
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
	return normalizeWinding(SegmentChainer(selected, geo));
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

/**
 * One sub-path as boolean-op segments: collinear control points become a
 * line, and an open sub-path is bridged with a line so it encloses a region.
 */
export function cubicSegmentsToContour(
	subPath: CubicBezierSegment[],
	geo: GeometryEpsilon,
): Segment[] {
	const contour: Segment[] = [];

	for (let i = 0; i < subPath.length; i++) {
		const seg = subPath[i];
		const prevEnd = i > 0 ? subPath[i - 1].end : undefined;
		const resolved = resolveSegment(seg, prevEnd);

		const p0: Vec2 = [resolved.start.x, resolved.start.y];
		const cp1: Vec2 = [resolved.cp1.x, resolved.cp1.y];
		const cp2: Vec2 = [resolved.cp2.x, resolved.cp2.y];
		const p3: Vec2 = [resolved.end.x, resolved.end.y];

		const isLine =
			Math.abs(
				(cp1[0] - p0[0]) * (p3[1] - p0[1]) - (cp1[1] - p0[1]) * (p3[0] - p0[0]),
			) < 0.01 &&
			Math.abs(
				(cp2[0] - p0[0]) * (p3[1] - p0[1]) - (cp2[1] - p0[1]) * (p3[0] - p0[0]),
			) < 0.01;

		if (isLine) {
			contour.push(new SegmentLine(p0, p3, geo));
		} else {
			contour.push(new SegmentCurve(p0, cp1, cp2, p3, geo));
		}
	}

	if (contour.length > 0) {
		const first = contour[0].start();
		const last = contour[contour.length - 1].end();
		if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 1e-6) {
			contour.push(
				new SegmentLine([last[0], last[1]], [first[0], first[1]], geo),
			);
		}
	}

	return contour;
}

/**
 * Re-wind a disjoint contour set so holes wind against their solids.
 *
 * The chained segments do not encode solid-vs-hole in their winding — two
 * rectangles come back with the counter reversed, the same shapes drawn with
 * curves come back both the same way — while everything downstream reads
 * exactly that: the non-zero fill, buildExtrudeMesh's dominant-winding rule,
 * and the non-zero self-intersection pass of the next booleanOp. The contours
 * are disjoint by this point, so containment is unambiguous and settles it.
 */
function normalizeWinding(contours: Segment[][]): Segment[][] {
	if (contours.length < 2) return contours;

	const holes = new Set<number>();
	for (const group of groupRingsByContainment(contours.map(contourRing))) {
		for (const index of group.slice(1)) holes.add(index);
	}
	if (holes.size === 0) return contours;

	const areas = contours.map(signedContourArea);
	// Solids keep the direction most of their own area already has, so a result
	// that was already consistent comes back untouched.
	const solidTotal = areas.reduce(
		(sum, area, i) => (holes.has(i) ? sum : sum + area),
		0,
	);
	const solidSign = solidTotal >= 0 ? 1 : -1;
	return contours.map((contour, i) => {
		const wanted = holes.has(i) ? -solidSign : solidSign;
		return Math.sign(areas[i]) === wanted ? contour : reverseContour(contour);
	});
}

/** Signed area of a contour's anchor polygon; the sign carries the winding. */
export function signedContourArea(contour: Segment[]): number {
	let sum = 0;
	for (const seg of contour) {
		const [x1, y1] = seg.start();
		const [x2, y2] = seg.end();
		sum += x1 * y2 - x2 * y1;
	}
	return sum / 2;
}

export function contourToCubicSegments(
	contour: Segment[],
): CubicBezierSegment[] {
	const result: CubicBezierSegment[] = [];

	// Filter out zero-length segments produced by boolean operations
	const filtered = contour.filter((seg) => {
		const s = seg.start();
		const e = seg.end();
		return Math.hypot(e[0] - s[0], e[1] - s[1]) > 1e-6;
	});

	for (let i = 0; i < filtered.length; i++) {
		const seg = filtered[i];
		const isFirst = i === 0;
		const isLast = i === filtered.length - 1;

		const startPt = seg.start();
		const endPt = seg.end();

		let cp1: { x: number; y: number; pressure?: number };
		let cp2: { x: number; y: number; pressure?: number };

		if (seg instanceof SegmentCurve) {
			// Relative control points
			cp1 = { x: seg.p1[0] - startPt[0], y: seg.p1[1] - startPt[1] };
			cp2 = { x: seg.p2[0] - endPt[0], y: seg.p2[1] - endPt[1] };
		} else {
			// Line: place control points at 1/3 and 2/3 along the segment
			// so that the cubic bezier derivative is non-zero (avoids degenerate
			// tangent at endpoints which breaks curveNormal in PathOffset).
			const dx = endPt[0] - startPt[0];
			const dy = endPt[1] - startPt[1];
			cp1 = { x: dx / 3, y: dy / 3 };
			cp2 = { x: -dx / 3, y: -dy / 3 };
		}

		const cubicSeg: CubicBezierSegment = {
			cp1,
			cp2,
			end: { x: endPt[0], y: endPt[1], pressure: 1 },
			startPressure: 1,
			endPressure: 1,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: isFirst,
			isClosed: isLast ? true : undefined,
		};

		if (isFirst) {
			cubicSeg.start = {
				x: startPt[0],
				y: startPt[1],
				pressure: 1,
			};
		}

		result.push(cubicSeg);
	}

	return result;
}

/**
 * A contour's polygon approximation. Curve segments contribute interior samples
 * as well as their anchor: chaining bare anchors chords every curve, and a chord
 * cuts inside a bulging outline far enough that a counter hugging that outline
 * reads as outside it.
 */
function contourRing(contour: Segment[]): [number, number][] {
	return contour.flatMap((seg) =>
		seg instanceof SegmentCurve
			? [seg.start(), seg.point(1 / 3), seg.point(2 / 3)]
			: [seg.start()],
	);
}

function reverseContour(contour: Segment[]): Segment[] {
	return [...contour].reverse().map((seg) => seg.reverse());
}
