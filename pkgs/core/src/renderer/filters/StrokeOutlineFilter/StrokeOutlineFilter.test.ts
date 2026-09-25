import { describe, expect, it } from "vitest";
import { createStrokeBrushSettings } from "../../../document/factory";
import type {
	BrushSettings,
	FillAppearance,
	Filter,
	StrokeAppearance,
} from "../../../schema";
import { lineSeg } from "../../../testUtils/segmentFactory";
import { calculateSegmentListBounds } from "../../../utils/geometry/bounds";
import type { AppearanceGeometry } from "../../canvas/pipeline/FilterRenderer";
import { StrokeOutlineFilterHandler } from "./StrokeOutlineFilter";

describe("StrokeOutlineFilterHandler", () => {
	describe("preProcessAppearance", () => {
		it("should turn a geometric stroke into a fill of its band", () => {
			const handler = new StrokeOutlineFilterHandler();

			const [result] = handler.preProcessAppearance(
				{ appearance: stroke(), path: { segments: horizontalLine() } },
				filter(),
			);

			expect(result.appearance?.processor).toBe("fill");
			expect((result.appearance as FillAppearance).paramData.params.fill).toBe(
				RED,
			);
			expect(result.path.segments.at(-1)?.isClosed).toBe(true);
			expect(calculateSegmentListBounds(result.path.segments)).toMatchObject({
				minX: 0,
				maxX: 100,
				minY: -5,
				maxY: 5,
			});
		});

		it("should leave a fill and a non-geometric stroke untouched", () => {
			const handler = new StrokeOutlineFilterHandler();
			const fill: AppearanceGeometry = {
				appearance: {
					...stroke(),
					processor: "fill",
					paramData: { version: "1", params: { fill: RED } },
				} as FillAppearance,
				path: { segments: horizontalLine() },
			};
			const dab: AppearanceGeometry = {
				appearance: stroke({ engine: "dab" }),
				path: { segments: horizontalLine() },
			};
			const shapeOnly: AppearanceGeometry = {
				path: { segments: horizontalLine() },
			};

			expect(handler.preProcessAppearance(fill, filter())).toEqual([fill]);
			expect(handler.preProcessAppearance(dab, filter())).toEqual([dab]);
			expect(handler.preProcessAppearance(shapeOnly, filter())).toEqual([
				shapeOnly,
			]);
		});

		it("should follow the width profile and drop it from the outline", () => {
			const handler = new StrokeOutlineFilterHandler();
			const segments = horizontalLine();

			const [full] = handler.preProcessAppearance(
				{ appearance: stroke(), path: { segments } },
				filter(),
			);
			const [tapered] = handler.preProcessAppearance(
				{
					appearance: stroke(),
					path: {
						segments,
						strokeWidths: [
							{ t: 0, side1: 1, side2: 1 },
							{ t: 1, side1: 0, side2: 0 },
						],
					},
				},
				filter(),
			);

			expect(tapered.path.segments).not.toBe(full.path.segments);
			expect(tapered.path.strokeWidths).toBeUndefined();
			expect(calculateSegmentListBounds(tapered.path.segments)?.maxY).toBe(5);
			// The band narrows to a point at the far end.
			const endAnchors = tapered.path.segments
				.map((seg) => seg.end)
				.filter((end) => end.x > 95);
			expect(endAnchors.length).toBeGreaterThan(0);
			expect(
				Math.max(...endAnchors.map((end) => Math.abs(end.y))),
			).toBeLessThan(1);
		});

		it("should reuse the outline while the stroke and its band stay the same", () => {
			const handler = new StrokeOutlineFilterHandler();
			const segments = horizontalLine();
			const geometry = { appearance: stroke(), path: { segments } };

			const [first] = handler.preProcessAppearance(geometry, filter());
			const [again] = handler.preProcessAppearance(geometry, filter());
			const [wider] = handler.preProcessAppearance(
				{ appearance: stroke({ width: 20 }), path: { segments } },
				filter(),
			);

			expect(again.path.segments).toBe(first.path.segments);
			expect(wider.path.segments).not.toBe(first.path.segments);
			expect(calculateSegmentListBounds(wider.path.segments)?.maxY).toBe(10);
		});
	});
});

// --- Helpers ---

const RED = {
	type: "solid" as const,
	color: { type: "rgb" as const, r: 1, g: 0, b: 0, a: 1 },
};

function filter(): Filter {
	return {
		uid: "outline",
		processor: "stroke-outline",
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: {} },
	};
}

function stroke(
	overrides: Partial<BrushSettings> & { width?: number } = {},
): StrokeAppearance {
	const { width = 10, ...settings } = overrides;
	return {
		uid: "stroke",
		processor: "stroke",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				strokeColor: RED,
				brushSettings: {
					...createStrokeBrushSettings(width, {
						lineJoin: "miter",
						lineCap: "butt",
						miterLimit: 4,
					}),
					...settings,
				},
			},
		},
	} as StrokeAppearance;
}

/** An open line from (0, 0) to (100, 0). */
function horizontalLine() {
	return [lineSeg({ x: 100, y: 0 }, { start: { x: 0, y: 0 }, isMoved: true })];
}
