import { describe, expect, it } from "vitest";
import type { CubicBezierSegment } from "../schema";
import { getStartAnchor } from "../utils/geometry/segmentOps";
import { bendSegmentAtT, cutPathSegments } from "./pathNodeEditHelpers";

describe("cutPathSegments", () => {
	describe("when the path is open", () => {
		it("should split into the two runs on either side of an interior anchor", () => {
			const result = cutPathSegments(openPath([0, 100, 200, 300]), 1, {
				kind: "anchor",
				pointType: "end",
			});

			expect(result).not.toBeNull();
			expect(result).toHaveLength(2);
			expect(anchorXs(result![0])).toEqual([0, 100, 200]);
			expect(anchorXs(result![1])).toEqual([200, 300]);
		});

		it("should start the trailing run with an explicit anchor at the cut", () => {
			const result = cutPathSegments(openPath([0, 100, 200, 300]), 1, {
				kind: "anchor",
				pointType: "end",
			});

			const tailHead = result![1][0];
			expect(tailHead.start).toEqual({ x: 200, y: 0 });
			expect(tailHead.isMoved).toBe(true);
		});

		it("should return null at the first anchor", () => {
			expect(
				cutPathSegments(openPath([0, 100, 200]), 0, {
					kind: "anchor",
					pointType: "start",
				}),
			).toBeNull();
		});

		it("should return null at the last anchor", () => {
			expect(
				cutPathSegments(openPath([0, 100, 200]), 1, {
					kind: "anchor",
					pointType: "end",
				}),
			).toBeNull();
		});

		it("should insert an anchor at the cut point when cutting inside a segment", () => {
			const result = cutPathSegments(openPath([0, 100, 200]), 0, {
				kind: "edge",
				t: 0.5,
			});

			expect(result).toHaveLength(2);
			expect(anchorXs(result![0])).toEqual([0, 50]);
			expect(anchorXs(result![1])).toEqual([50, 100, 200]);
		});

		it("should let the leading half of the first segment keep the original start", () => {
			const result = cutPathSegments(openPath([0, 100, 200]), 0, {
				kind: "edge",
				t: 0.5,
			});

			expect(result![0][0].start).toEqual({ x: 0, y: 0 });
		});
	});

	describe("when the path is closed", () => {
		it("should produce a single open run", () => {
			const result = cutPathSegments(closedPath([0, 100, 200]), 1, {
				kind: "anchor",
				pointType: "end",
			});

			expect(result).toHaveLength(1);
			expect(result![0].some((segment) => segment.isClosed)).toBe(false);
		});

		it("should start and end the run at the cut anchor", () => {
			const result = cutPathSegments(closedPath([0, 100, 200]), 1, {
				kind: "anchor",
				pointType: "end",
			});

			expect(anchorXs(result![0])).toEqual([200, 0, 100, 200]);
		});

		it("should mark only the first segment as a subpath start", () => {
			const result = cutPathSegments(closedPath([0, 100, 200]), 1, {
				kind: "anchor",
				pointType: "end",
			});

			expect(result![0].map((segment) => segment.isMoved)).toEqual([
				true,
				false,
				false,
			]);
		});

		it("should add the cut point as an anchor when cutting inside a segment", () => {
			const result = cutPathSegments(closedPath([0, 100, 200]), 0, {
				kind: "edge",
				t: 0.5,
			});

			expect(result).toHaveLength(1);
			expect(anchorXs(result![0])).toEqual([50, 100, 200, 0, 50]);
		});
	});
});

/** Anchor x coordinates of a run, from its start anchor through every end. */
describe("bendSegmentAtT", () => {
	it("should turn the next segment's cp1 with the bent cp2 and keep its length", () => {
		const segments = openPath([0, 100, 200]);
		segments[0].cp2 = { x: -30, y: 0 };
		segments[1].cp1 = { x: 30, y: 0 };

		const result = bendSegmentAtT(segments, 0, 0.5, 0, 20);

		const bent = result[0].cp2;
		const far = result[1].cp1;
		expect(bent.y).toBeCloseTo(26.667, 2);
		// Opposite direction to the bent handle, still 30 away from the anchor
		expect(Math.hypot(far.x, far.y)).toBeCloseTo(30);
		expect(far.x * bent.y - far.y * bent.x).toBeCloseTo(0);
		expect(far.x * bent.x + far.y * bent.y).toBeLessThan(0);
	});

	it("should leave the previous segment's cp2 in place across the closing join when the bent cp1 only grows", () => {
		const segments = closedPath([0, 100, 200]);
		segments[0].cp1 = { x: 0, y: 30 };
		segments[2].cp2 = { x: 0, y: -30 };

		const result = bendSegmentAtT(segments, 0, 0.5, 0, 20);

		expect(result[0].cp1.y).toBeCloseTo(56.667, 2);
		expect(result[2].cp2.x).toBeCloseTo(0);
		expect(result[2].cp2.y).toBeCloseTo(-30);
	});

	it("should turn the previous segment's cp2 across the closing join", () => {
		const segments = closedPath([0, 100, 200]);
		segments[0].cp1 = { x: 30, y: 0 };
		segments[2].cp2 = { x: -30, y: 0 };

		const result = bendSegmentAtT(segments, 0, 0.5, 0, 20);

		const bent = result[0].cp1;
		const far = result[2].cp2;
		expect(Math.hypot(far.x, far.y)).toBeCloseTo(30);
		expect(far.x * bent.y - far.y * bent.x).toBeCloseTo(0);
		expect(far.x * bent.x + far.y * bent.y).toBeLessThan(0);
	});

	it("should turn the first segment's cp1 when the closing segment is bent", () => {
		const segments = closedPath([0, 100, 200]);
		segments[2].cp2 = { x: 30, y: 0 };
		segments[0].cp1 = { x: -30, y: 0 };

		const result = bendSegmentAtT(segments, 2, 0.5, 0, 20);

		const bent = result[2].cp2;
		const far = result[0].cp1;
		expect(bent.y).toBeCloseTo(26.667, 2);
		expect(Math.hypot(far.x, far.y)).toBeCloseTo(30);
		expect(far.x * bent.y - far.y * bent.x).toBeCloseTo(0);
		expect(far.x * bent.x + far.y * bent.y).toBeLessThan(0);
	});

	it("should turn both handles of the other segment in a two-segment closed path", () => {
		const segments = closedPath([0, 100]);
		segments[0].cp1 = { x: 0, y: 30 };
		segments[0].cp2 = { x: 0, y: 30 };
		segments[1].cp1 = { x: 0, y: -30 };
		segments[1].cp2 = { x: 0, y: -30 };

		const result = bendSegmentAtT(segments, 0, 0.5, 20, 0);

		// Both bent handles lean toward +x, so both far handles lean toward -x
		expect(result[1].cp1.x).toBeLessThan(0);
		expect(result[1].cp2.x).toBeLessThan(0);
		expect(Math.hypot(result[1].cp1.x, result[1].cp1.y)).toBeCloseTo(30);
		expect(Math.hypot(result[1].cp2.x, result[1].cp2.y)).toBeCloseTo(30);
	});

	it("should leave the far handle alone when the bent handle had no direction", () => {
		const segments = openPath([0, 100, 200]);
		segments[1].cp1 = { x: 30, y: 0 };

		const result = bendSegmentAtT(segments, 0, 0.5, 0, 20);

		expect(result[1].cp1).toEqual({ x: 30, y: 0 });
	});
});

function anchorXs(segments: CubicBezierSegment[]): number[] {
	return [
		getStartAnchor(segments[0]).x,
		...segments.map((segment) => segment.end.x),
	];
}

/** Straight polyline through (x, 0) for each x, left open. */
function openPath(xs: number[]): CubicBezierSegment[] {
	return xs.slice(1).map((x, index) => ({
		start: index === 0 ? { x: xs[0], y: 0 } : undefined,
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: { x, y: 0 },
		isMoved: index === 0,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
	}));
}

/** Same polyline, closed back to the first anchor. */
function closedPath(xs: number[]): CubicBezierSegment[] {
	const segments = openPath([...xs, xs[0]]);
	segments[segments.length - 1].isClosed = true;
	return segments;
}
