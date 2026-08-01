import { describe, expect, it } from "vitest";
import { resolveTaper, taperFactor } from "./taper";

describe("resolveTaper", () => {
	it("should return the requested lengths when they fit the whole length", () => {
		expect(resolveTaper(20, 30, 100, 0, 1)).toEqual({
			taperIn: 20,
			taperOut: 30,
		});
	});

	it("should return null when both tapers are 0 or undefined", () => {
		expect(resolveTaper(0, 0, 100, 0, 1)).toBeNull();
		expect(resolveTaper(undefined, undefined, 100, 0, 1)).toBeNull();
	});

	it("should return null when the whole length is not positive", () => {
		expect(resolveTaper(20, 20, 0, 0, 1)).toBeNull();
	});

	it("should scale both sides proportionally to meet in the middle when they overlap", () => {
		expect(resolveTaper(60, 60, 100, 0, 1)).toEqual({
			taperIn: 50,
			taperOut: 50,
		});
	});

	it("should suppress the entry taper when the fragment starts mid-stroke", () => {
		expect(resolveTaper(60, 60, 100, 0.5, 1)).toEqual({
			taperIn: 0,
			taperOut: 60,
		});
	});

	it("should suppress the exit taper when the fragment ends mid-stroke", () => {
		expect(resolveTaper(60, 60, 100, 0, 0.5)).toEqual({
			taperIn: 60,
			taperOut: 0,
		});
	});

	it("should return null when both sides are suppressed by the fragment range", () => {
		expect(resolveTaper(60, 60, 100, 0.25, 0.75)).toBeNull();
	});
});

describe("taperFactor", () => {
	const taper = { taperIn: 10, taperOut: 10 };
	const fragLength = 100;

	it("should be 0 at the stroke start and end", () => {
		expect(taperFactor(taper, 0, fragLength)).toBe(0);
		expect(taperFactor(taper, fragLength, fragLength)).toBe(0);
	});

	it("should be 1 where both tapers are fully ramped", () => {
		expect(taperFactor(taper, 10, fragLength)).toBe(1);
		expect(taperFactor(taper, 50, fragLength)).toBe(1);
		expect(taperFactor(taper, 90, fragLength)).toBe(1);
	});

	it("should be 0.5 at the taper midpoint (smoothstep easing)", () => {
		expect(taperFactor(taper, 5, fragLength)).toBeCloseTo(0.5, 10);
		expect(taperFactor(taper, 95, fragLength)).toBeCloseTo(0.5, 10);
	});

	it("should keep a side at factor 1 when its taper length is 0", () => {
		expect(taperFactor({ taperIn: 0, taperOut: 10 }, 0, fragLength)).toBe(1);
		expect(
			taperFactor({ taperIn: 10, taperOut: 0 }, fragLength, fragLength),
		).toBe(1);
	});
});
