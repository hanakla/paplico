import { describe, expect, it } from "vitest";
import { generateRectangleSegments } from "../../../utils/geometry/generate/shapeSegments";
import { calculateSegmentListBounds } from "../../../utils/geometry/measure/pathBounds";
import {
	type ConvertToShapeFilter,
	ConvertToShapeFilterHandler,
	type ConvertToShapeParams,
} from "./ConvertToShapeFilter";

describe("ConvertToShapeFilterHandler", () => {
	const handler = new ConvertToShapeFilterHandler();
	const original = generateRectangleSegments(
		{ x: 10, y: 20 },
		{ x: 50, y: 80 },
	);

	it("extends the source bounds by the requested relative dimensions", () => {
		const result = handler.preProcess(
			original,
			filter({ width: 20, height: 10 }),
		);
		expect(calculateSegmentListBounds(result)).toMatchObject({
			minX: 0,
			maxX: 60,
			minY: 15,
			maxY: 85,
		});
	});

	it("centers an absolute ellipse on the source", () => {
		const result = handler.preProcess(
			original,
			filter({ shape: "ellipse", sizeMode: "absolute", width: 20, height: 30 }),
		);
		expect(calculateSegmentListBounds(result)).toMatchObject({
			minX: 20,
			maxX: 40,
			minY: 35,
			maxY: 65,
		});
		expect(result).toHaveLength(4);
		expect(
			result.some((segment) => segment.cp1.x !== 0 || segment.cp1.y !== 0),
		).toBe(true);
	});

	it("rounds each rectangle corner", () => {
		const result = handler.preProcess(original, filter({ cornerRadius: 8 }));
		expect(result.length).toBeGreaterThan(4);
		expect(calculateSegmentListBounds(result)).toMatchObject({
			minX: 10,
			maxX: 50,
			minY: 20,
			maxY: 80,
		});
	});
});

function filter(params: Partial<ConvertToShapeParams>): ConvertToShapeFilter {
	return {
		uid: "shape",
		processor: "convert-to-shape",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				shape: "rectangle",
				sizeMode: "relative",
				width: 0,
				height: 0,
				cornerRadius: 0,
				...params,
			},
		},
	};
}
