import { describe, expect, it } from "vitest";
import type { LinearGradient } from "../../../schema";
import { hashGradientDraw } from "./GradientCache";

describe("hashGradientDraw", () => {
	function makeLinearGradient(midpoint: number): LinearGradient {
		return {
			type: "linear",
			x1: 0,
			y1: 0,
			x2: 1,
			y2: 0,
			stops: [
				{
					offset: 0,
					color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
					midpoint,
				},
				{
					offset: 1,
					color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
					midpoint: 0.5,
				},
			],
		};
	}

	it("changes fingerprint when a stop's midpoint changes (offset and color unchanged)", () => {
		const h1 = hashGradientDraw(makeLinearGradient(0.5), [0, 0], [1, 1], 0);
		const h2 = hashGradientDraw(makeLinearGradient(0.3), [0, 0], [1, 1], 0);

		expect(h1).not.toBe(h2);
	});

	it("returns the same fingerprint for identical gradients", () => {
		const h1 = hashGradientDraw(makeLinearGradient(0.5), [0, 0], [1, 1], 0);
		const h2 = hashGradientDraw(makeLinearGradient(0.5), [0, 0], [1, 1], 0);

		expect(h1).toBe(h2);
	});
});
