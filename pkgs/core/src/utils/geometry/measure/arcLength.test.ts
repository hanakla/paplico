import {
	describe,
	expect,
	it,
} from "../../../../../../node_modules/vitest/dist/index";
import { threeSegmentPath } from "../../../testUtils/segmentFactory";
import {
	arcLengthRatioAt,
	arcLengthRatios,
	buildArcLengthTable,
	samplePathAtArcLength,
} from "./arcLength";

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

describe("samplePathAtArcLength", () => {
	it("samples continuously just after a segment boundary", () => {
		const segments = threeSegmentPath().segments;
		const table = buildArcLengthTable(segments);
		const boundary = table[20].cumulativeLength;
		const next = table[21].cumulativeLength;
		const total = table.at(-1)?.cumulativeLength ?? 0;
		const start = samplePathAtArcLength(segments, table, boundary, total);
		const point = samplePathAtArcLength(
			segments,
			table,
			boundary + (next - boundary) * 0.25,
			total,
		);
		const end = samplePathAtArcLength(segments, table, next, total);
		if (!start || !point || !end) throw new Error("Expected path samples");

		expect(point.x).toBeCloseTo(start.x + (end.x - start.x) * 0.25);
		expect(point.y).toBeCloseTo(start.y + (end.y - start.y) * 0.25);
	});
});
