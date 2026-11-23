import { describe, expect, it } from "vitest";
import { createStrokeBrushSettings } from "../../../document/factory";
import type {
	CubicBezierSegment,
	Filter,
	StrokeAppearance,
} from "../../../schema";
import { closedRectSegments } from "../../../testUtils/segmentFactory";
import { calculateSegmentListBounds } from "../../../utils/geometry/measure/pathBounds";
import { ScribbleFilterHandler, type ScribbleParams } from "./ScribbleFilter";

describe("ScribbleFilterHandler", () => {
	it("should hatch the whole area of a shape and no further than half a line width", () => {
		const result = scribbleOf(closedRectSegments(0, 0, 100, 50), {
			strokeWidth: 2,
		});

		const bounds = calculateSegmentListBounds(result);
		expect(bounds?.minX).toBeCloseTo(-1, 0);
		expect(bounds?.maxX).toBeCloseTo(101, 0);
		expect(bounds?.minY).toBeGreaterThan(-1.01);
		expect(bounds?.maxY).toBeLessThan(51.01);
	});

	it("should leave a hole in the shape unhatched", () => {
		const shape = [
			...closedRectSegments(0, 0, 100, 100),
			...withMove(closedRectSegments(30, 30, 70, 70)),
		];

		const result = scribbleOf(shape, { strokeWidth: 1, spacing: 4 });

		const inHole = anchorsOf(result).filter(
			(p) => p.x > 32 && p.x < 68 && p.y > 32 && p.y < 68,
		);
		expect(result.length).toBeGreaterThan(0);
		expect(inHole).toEqual([]);
	});

	it("should draw the same hatching for the same seed and another for another seed", () => {
		const shape = closedRectSegments(0, 0, 100, 50);
		const params = { overlapVariation: 3, spacingVariation: 2 };

		const first = scribbleOf(shape, { ...params, seed: 1 });
		const again = scribbleOf(shape, { ...params, seed: 1 });
		const other = scribbleOf(shape, { ...params, seed: 2 });

		expect(again).toEqual(first);
		expect(other).not.toEqual(first);
	});

	it("should run the hatching along its angle", () => {
		const shape = closedRectSegments(0, 0, 100, 100);

		const horizontal = calculateSegmentListBounds(
			scribbleOf(shape, { overlap: 10, strokeWidth: 1 }),
		);
		const vertical = calculateSegmentListBounds(
			scribbleOf(shape, { angle: 90, overlap: 10, strokeWidth: 1 }),
		);

		// The overlap reaches past the edges the lines run toward.
		expect(horizontal?.minX).toBeCloseTo(-10.5, 0);
		expect(horizontal?.minY).toBeGreaterThan(-1);
		expect(vertical?.minY).toBeCloseTo(-10.5, 0);
		expect(vertical?.minX).toBeGreaterThan(-1);
	});

	it("should hatch only the band a stroke covers and paint it with the stroke's color", () => {
		const [result] = new ScribbleFilterHandler().preProcessAppearance(
			{
				appearance: whiteStroke(4),
				path: { segments: closedRectSegments(0, 0, 100, 100) },
			},
			scribbleFilter({ strokeWidth: 1, spacing: 1 }),
		);

		const inside = anchorsOf(result.path.segments).filter(
			(p) => p.x > 10 && p.x < 90 && p.y > 10 && p.y < 90,
		);
		const bounds = calculateSegmentListBounds(result.path.segments);
		expect(result.appearance?.processor).toBe("fill");
		expect(result.appearance?.paramData.params).toMatchObject({
			fill: { type: "solid", color: { r: 1, g: 1, b: 1 } },
		});
		expect(inside).toEqual([]);
		expect(bounds?.minX).toBeCloseTo(-2.5, 0);
		expect(bounds?.maxX).toBeCloseTo(102.5, 0);
	});
});

// ===== Test helpers =====

function scribbleOf(
	segments: CubicBezierSegment[],
	params: Partial<ScribbleParams>,
): CubicBezierSegment[] {
	const [result] = new ScribbleFilterHandler().preProcessAppearance(
		{ path: { segments } },
		scribbleFilter(params),
	);
	return result.path.segments;
}

function scribbleFilter(params: Partial<ScribbleParams>): Filter {
	return {
		uid: "scribble",
		processor: "scribble",
		enabled: true,
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				angle: 0,
				overlap: 0,
				overlapVariation: 0,
				strokeWidth: 3,
				curviness: 0,
				curvinessVariation: 0,
				spacing: 5,
				spacingVariation: 0,
				...params,
			} satisfies ScribbleParams,
		},
	} as Filter;
}

function whiteStroke(width: number): StrokeAppearance {
	return {
		uid: "stroke",
		processor: "stroke",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				strokeColor: {
					type: "solid",
					color: { type: "rgb", r: 1, g: 1, b: 1, a: 1 },
				},
				brushSettings: createStrokeBrushSettings(width),
			},
		},
	} as StrokeAppearance;
}

function withMove(segments: CubicBezierSegment[]): CubicBezierSegment[] {
	return segments.map((s, i) => (i === 0 ? { ...s, isMoved: true } : s));
}

function anchorsOf(segments: CubicBezierSegment[]): { x: number; y: number }[] {
	return segments.flatMap((s) => (s.start ? [s.start, s.end] : [s.end]));
}
