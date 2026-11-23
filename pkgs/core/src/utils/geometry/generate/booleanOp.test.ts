import { describe, expect, it } from "vitest";
import { GeometryEpsilon, type Vec2 } from "../primitives/bezier";
import { SegmentLine } from "../query/segmentIntersection";
import { booleanOp } from "./booleanOp";

describe("booleanOp", () => {
	it("should union lines so short and close that they pass for overlapping while parting at an angle", () => {
		// Two lines of a scribble's outline leave the same point at nearly the
		// same angle, and a third crosses both a hair away from it.
		const contour = lines([
			[
				[-4.746, 57.003],
				[-5.127, 56.336],
			],
			[
				[-5.13, 56.338],
				[-0.198, 53.459],
			],
			[
				[-4.936, 56.669],
				[-5.127, 56.336],
			],
		]);

		expect(() => booleanOp([contour], [], "union")).not.toThrow();
	});

	it("should union a line that crosses another a hair before its own end", () => {
		// The crossing lies just inside the end by distance, but a nearly
		// vertical line sorts it past the end.
		const a = lines([
			[
				[204.986, -7.332],
				[210.409, -6.988],
			],
		]);
		const b = lines([
			[
				[210.411, -7.033],
				[210.123, -0.87],
			],
			[
				[207.698, -7.16],
				[210.409, -6.988],
			],
		]);

		expect(() => booleanOp([a], [b], "union")).not.toThrow();
	});
});

function lines(ends: [Vec2, Vec2][]): SegmentLine[] {
	const geo = new GeometryEpsilon();
	return ends.map(([p0, p1]) => new SegmentLine(p0, p1, geo));
}
