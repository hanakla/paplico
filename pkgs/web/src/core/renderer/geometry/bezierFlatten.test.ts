import { describe, expect, it } from "vitest";
import { flattenCubicBezier } from "./bezierFlatten";

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
