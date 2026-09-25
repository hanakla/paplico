import { describe, expect, it } from "vitest";
import type { CubicBezierSegment } from "../../schema";
import {
	flattenBezierPathWithPressure,
	flattenCubicBezier,
} from "./bezierFlatten";

describe("flattenCubicBezier", () => {
	it("should subdivide finer for tolerances below a hundredth of a unit", () => {
		const quarterArc = (curveTolerance: number) =>
			flattenCubicBezier(
				{ x: 0, y: 0 },
				{ x: 0, y: 0.5523 },
				{ x: 0.4477, y: 1 },
				{ x: 1, y: 1 },
				{ curveTolerance },
			);

		const coarse = quarterArc(0.01).length;
		const fine = quarterArc(0.25 / 640).length;

		expect(fine).toBeGreaterThan(coarse);
	});
});

describe("flattenBezierPathWithPressure", () => {
	// A quarter arc whose chord leans well away from both end tangents.
	const arc: CubicBezierSegment = {
		start: { x: 0, y: 0 },
		cp1: { x: 0, y: 55 },
		cp2: { x: -45, y: 0 },
		end: { x: 100, y: 100 },
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: true,
	};

	function endChordDirections(curveTolerance: number) {
		const { points } = flattenBezierPathWithPressure([arc], { curveTolerance });
		const n = points.length / 2;
		const first = Math.atan2(points[3] - points[1], points[2] - points[0]);
		const last = Math.atan2(
			points[(n - 1) * 2 + 1] - points[(n - 2) * 2 + 1],
			points[(n - 1) * 2] - points[(n - 2) * 2],
		);
		return { first, last };
	}

	it("should start and end each curved segment along its tangents", () => {
		const { first, last } = endChordDirections(0.25);

		// cp1 is straight up from the start; the end is reached from cp2,
		// which sits straight left of it.
		expect(first).toBeCloseTo(Math.PI / 2, 9);
		expect(last).toBeCloseTo(0, 9);
	});

	it("should read the same corner angle at every tolerance", () => {
		const coarse = endChordDirections(1);
		const fine = endChordDirections(0.25 / 64);

		expect(coarse.first).toBeCloseTo(fine.first, 9);
		expect(coarse.last).toBeCloseTo(fine.last, 9);
	});

	it("should leave a straight segment as one chord", () => {
		const { points } = flattenBezierPathWithPressure([
			{ ...arc, cp1: { x: 0, y: 0 }, cp2: { x: 0, y: 0 } },
		]);

		expect(points).toEqual([0, 0, 100, 100]);
	});
});
