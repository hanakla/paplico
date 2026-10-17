import {
	describe,
	expect,
	it,
} from "../../../../../../node_modules/vitest/dist/index";
import { threeSegmentPath } from "../../../testUtils/segmentFactory";
import { arcLengthRatioAt, arcLengthRatios } from "./arcLength";

describe("arcLengthRatioAt", () => {
	it("should return where a segment starts as a ratio of the arc length", () => {
		expect(arcLengthRatioAt(threeSegmentPath().segments, 1)).toBeCloseTo(1 / 3);
	});

	it("should include the part of the segment up to t", () => {
		expect(arcLengthRatioAt(threeSegmentPath().segments, 1, 0.5)).toBeCloseTo(
			0.5,
		);
	});

	it("should return 1 past the last segment", () => {
		expect(arcLengthRatioAt(threeSegmentPath().segments, 3)).toBe(1);
	});
});

describe("arcLengthRatios", () => {
	it("should list where every segment starts and end with 1", () => {
		const ratios = arcLengthRatios(threeSegmentPath().segments);

		expect(ratios).toHaveLength(4);
		expect(ratios[0]).toBe(0);
		expect(ratios[1]).toBeCloseTo(1 / 3);
		expect(ratios[2]).toBeCloseTo(2 / 3);
		expect(ratios[3]).toBeCloseTo(1);
	});
});
