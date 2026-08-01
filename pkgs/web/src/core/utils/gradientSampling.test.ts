import { describe, expect, it } from "vitest";
import type { ColorStop } from "../schema";
import { remapGradientT, sampleGradientColorAt } from "./gradientSampling";

describe("remapGradientT", () => {
	it("returns fRaw unchanged (linear, no bias) when midpoint is 0.5", () => {
		expect(remapGradientT(0, 0.5)).toBeCloseTo(0);
		expect(remapGradientT(0.25, 0.5)).toBeCloseTo(0.25);
		expect(remapGradientT(0.5, 0.5)).toBeCloseTo(0.5);
		expect(remapGradientT(0.75, 0.5)).toBeCloseTo(0.75);
		expect(remapGradientT(1, 0.5)).toBeCloseTo(1);
	});

	it("maps fRaw === midpoint to exactly 0.5 for any midpoint", () => {
		for (const midpoint of [0.1, 0.3, 0.5, 0.7, 0.9]) {
			expect(remapGradientT(midpoint, midpoint)).toBeCloseTo(0.5);
		}
	});

	it("stays finite and clamped at extreme midpoints", () => {
		expect(Number.isFinite(remapGradientT(0.5, 0))).toBe(true);
		expect(Number.isFinite(remapGradientT(0.5, 1))).toBe(true);
		expect(remapGradientT(0, 0)).toBeGreaterThanOrEqual(0);
		expect(remapGradientT(1, 1)).toBeLessThanOrEqual(1);
	});

	it("biases the transition earlier when midpoint is below 0.5", () => {
		// With midpoint=0.2, the raw 0.2 position should already read as 0.5.
		expect(remapGradientT(0.2, 0.2)).toBeCloseTo(0.5);
		// And a raw position past the midpoint reads higher than the
		// unbiased (midpoint=0.5) case.
		expect(remapGradientT(0.5, 0.2)).toBeGreaterThan(0.5);
	});

	it("biases the transition later when midpoint is above 0.5", () => {
		expect(remapGradientT(0.8, 0.8)).toBeCloseTo(0.5);
		expect(remapGradientT(0.5, 0.8)).toBeLessThan(0.5);
	});
});

describe("sampleGradientColorAt", () => {
	const stops: ColorStop[] = [
		{
			offset: 0,
			color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
			midpoint: 0.5,
		},
		{
			offset: 1,
			color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
			midpoint: 0.5,
		},
	];

	it("returns the first stop's color at t=0", () => {
		const c = sampleGradientColorAt(stops, 0);
		expect(c).toEqual(stops[0].color);
	});

	it("returns the last stop's color at t=1", () => {
		const c = sampleGradientColorAt(stops, 1);
		expect(c).toEqual(stops[1].color);
	});

	it("shifts the visual midpoint when a stop's midpoint is biased", () => {
		const biased: ColorStop[] = [{ ...stops[0], midpoint: 0.2 }, stops[1]];
		const c = sampleGradientColorAt(biased, 0.2);
		if (c.type !== "rgb") throw new Error("expected rgb");
		// At t=0.2 with midpoint=0.2, the blend should be ~50/50 (g/b muted mid tone),
		// noticeably further from pure red than the unbiased sample at t=0.2.
		const unbiased = sampleGradientColorAt(stops, 0.2);
		if (unbiased.type !== "rgb") throw new Error("expected rgb");
		expect(c.r).toBeLessThan(unbiased.r);
	});
});
