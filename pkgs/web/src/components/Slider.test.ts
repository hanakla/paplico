import { describe, expect, it } from "vitest";
import {
	computeInfiniteSliderRestPosition,
	computeInfiniteSliderValue,
} from "./Slider";

describe("computeInfiniteSliderRestPosition", () => {
	it("should lean to the track's left end when value is at a finite min", () => {
		expect(computeInfiniteSliderRestPosition(0, 0, Infinity, 0.5)).toBe(-0.5);
	});

	it("should lean to the track's right end when value is at a finite max", () => {
		expect(computeInfiniteSliderRestPosition(10, -Infinity, 10, 0.5)).toBe(0.5);
	});

	it("should center when value has at least `range` of room on both sides", () => {
		expect(computeInfiniteSliderRestPosition(5, 0, 10, 0.5)).toBe(0);
	});

	it("should always center for unbounded min/max (e.g. camera distance)", () => {
		expect(computeInfiniteSliderRestPosition(7.8, -Infinity, Infinity, 2)).toBe(
			0,
		);
	});

	it("should lean proportionally as value approaches a finite bound", () => {
		// 0.2 short of range=0.5 room from min=0 → leans 0.2 short of the end.
		expect(computeInfiniteSliderRestPosition(0.3, 0, Infinity, 0.5)).toBe(-0.2);
	});
});

describe("computeInfiniteSliderValue", () => {
	it("should not move the value while the pointer is still at the drag-start rest position", () => {
		// Regression: min=0/value=0 pins the thumb at -range (see restPosition
		// tests above). Reading raw track position without subtracting that
		// pinned start clamps everything before track-0 to `min`, ignoring the
		// first half of the drag.
		const value = computeInfiniteSliderValue(0, -0.5, -0.5, 0, Infinity);
		expect(value).toBe(0);
	});

	it("should track the pointer through the first half of the drag instead of ignoring it", () => {
		// Same leaned-in thumb (min=0/value=0/range=0.5): dragging a quarter of
		// the way across the track must already register a quarter unit of
		// movement, not still read as 0.
		const value = computeInfiniteSliderValue(0, -0.5, -0.25, 0, Infinity);
		expect(value).toBe(0.25);
	});

	it("should reach the drag-start value plus the full range once the pointer crosses track-0", () => {
		const value = computeInfiniteSliderValue(0, -0.5, 0, 0, Infinity);
		expect(value).toBe(0.5);
	});

	it("should behave as a plain delta-from-zero when the thumb rests at track-center (unbounded min/max)", () => {
		const value = computeInfiniteSliderValue(7.8, 0, 0.3, -Infinity, Infinity);
		expect(value).toBeCloseTo(8.1, 6);
	});

	it("should clamp to min when the drag would move the value below it", () => {
		const value = computeInfiniteSliderValue(0, -0.5, -0.5, 0, Infinity);
		expect(value).toBe(0);
		const overshoot = computeInfiniteSliderValue(0, -0.5, -1, 0, Infinity);
		expect(overshoot).toBe(0);
	});

	it("should clamp to max when the drag would move the value above it", () => {
		const value = computeInfiniteSliderValue(9.8, 0.5, 2, -Infinity, 10);
		expect(value).toBe(10);
	});
});
