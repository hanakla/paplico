import { describe, expect, it } from "vitest";
import { readStoredBrushSize } from "../../brush/access";
import { createStrokeBrushSettings } from "../../document/factory";
import type {
	CubicBezierSegment,
	FillAppearance,
	Filter,
	StrokeAppearance,
} from "../../schema";
import { closedRectSegments, lineSeg } from "../../testUtils/segmentFactory";
import { applyAffineToPoint } from "../../utils/geometry/repeatInterpolation";
import {
	computeSubPathSignedArea,
	resolveSegment,
} from "../../utils/geometry/segmentOps";
import { splitIntoSubPaths } from "../canvas/CanvasLayer.helpers";
import {
	TransformFilterHandler,
	type TransformParams,
} from "./TransformFilterProcessor";

describe("TransformFilterHandler", () => {
	describe("deformation", () => {
		it("returns the same segments when every parameter is neutral", () => {
			const rect = makeRect(0, 0, 100, 100);
			expect(applyTransform(rect, {})).toBe(rect);
		});

		it("moves every anchor by the move offset, vertical positive downward", () => {
			const anchors = extractAnchors(
				applyTransform(makeRect(0, 0, 100, 100), { moveX: 30, moveY: 20 }),
			);
			expect(anchors.map((a) => a.x)).toEqual([30, 130, 130, 30, 30]);
			expect(anchors.map((a) => a.y)).toEqual([-20, -20, 80, 80, -20]);
		});

		it("scales around the bounds center by default", () => {
			const anchors = extractAnchors(
				applyTransform(makeRect(0, 0, 100, 100), { scaleX: 0.5, scaleY: 2 }),
			);
			expect(anchors[0]).toMatchObject({ x: 25, y: -50 });
			expect(anchors[2]).toMatchObject({ x: 75, y: 150 });
		});

		it("scales around the chosen origin corner", () => {
			const anchors = extractAnchors(
				applyTransform(makeRect(0, 0, 100, 100), {
					scaleX: 2,
					scaleY: 2,
					origin: "bottom-left",
				}),
			);
			expect(anchors[0]).toMatchObject({ x: 0, y: 0 });
			expect(anchors[2]).toMatchObject({ x: 200, y: 200 });
		});

		it("rotates counter-clockwise around the origin", () => {
			const anchors = extractAnchors(
				applyTransform(makeRect(0, 0, 100, 100), {
					angle: 90,
					origin: "bottom-left",
				}),
			);
			expect(anchors[1].x).toBeCloseTo(0);
			expect(anchors[1].y).toBeCloseTo(100);
		});

		it("mirrors across the origin axis when reflecting", () => {
			const anchors = extractAnchors(
				applyTransform(makeRect(0, 0, 100, 100), {
					reflectX: true,
					origin: "left",
				}),
			);
			expect(Math.min(...anchors.map((a) => a.x))).toBeCloseTo(-100);
		});

		it("rotates control handles together with the anchors", () => {
			const circle = makeCircle(0, 0, 50);
			const result = applyTransform(circle, { angle: 90 });
			const original = resolveSegment(circle[0], undefined);
			const rotated = resolveSegment(result[0], undefined);
			expect(rotated.cp1.x).toBeCloseTo(-original.cp1.y);
			expect(rotated.cp1.y).toBeCloseTo(original.cp1.x);
		});

		it("keeps a reflected copy winding the same way as the original", () => {
			const rect = makeRect(0, 0, 100, 100);
			const result = applyTransform(rect, { reflectX: true, copies: 1 });
			const [original, mirrored] = splitIntoSubPaths(result);

			expect(Math.sign(computeSubPathSignedArea(mirrored))).toBe(
				Math.sign(computeSubPathSignedArea(original)),
			);
			expect(mirrored.map((s) => s.end.x).sort()).toEqual(
				original.map((s) => s.end.x).sort(),
			);
		});

		it("keeps the original and appends cumulative copies", () => {
			const result = applyTransform(makeRect(0, 0, 100, 100), {
				moveX: 10,
				copies: 2,
			});
			const subPaths = splitIntoSubPaths(result);
			expect(subPaths).toHaveLength(3);
			expect(extractAnchors(subPaths[0])[0].x).toBe(0);
			expect(extractAnchors(subPaths[1])[0].x).toBe(10);
			expect(extractAnchors(subPaths[2])[0].x).toBe(20);
		});

		it("uses one origin for every subpath of the input", () => {
			const twoRects = [...makeRect(0, 0, 10, 10), ...makeRect(90, 0, 100, 10)];
			const result = applyTransform(twoRects, { scaleX: 2, scaleY: 1 });
			const subPaths = splitIntoSubPaths(result);
			expect(extractAnchors(subPaths[0])[0].x).toBe(-50);
			expect(extractAnchors(subPaths[1])[1].x).toBe(150);
		});

		it("produces the same random result for the same seed", () => {
			const params: Partial<TransformParams> = {
				moveX: 100,
				angle: 45,
				copies: 3,
				random: true,
				seed: 7,
			};
			const a = applyTransform(makeRect(0, 0, 100, 100), params);
			const b = applyTransform(makeRect(0, 0, 100, 100), params);
			expect(a).toEqual(b);
		});

		it("produces a different random result for a different seed", () => {
			const a = applyTransform(makeRect(0, 0, 100, 100), {
				moveX: 100,
				random: true,
				seed: 1,
			});
			const b = applyTransform(makeRect(0, 0, 100, 100), {
				moveX: 100,
				random: true,
				seed: 2,
			});
			expect(extractAnchors(a)[0].x).not.toBe(extractAnchors(b)[0].x);
		});

		it("keeps random draws within the specified range", () => {
			const anchors = extractAnchors(
				applyTransform(makeRect(0, 0, 100, 100), {
					moveX: 100,
					random: true,
					seed: 3,
				}),
			);
			expect(anchors[0].x).toBeGreaterThanOrEqual(0);
			expect(anchors[0].x).toBeLessThan(100);
		});
	});

	describe("preProcessAppearance", () => {
		it("keeps one geometry when neither patterns nor strokes follow", () => {
			const handler = new TransformFilterHandler();
			const rect = makeRect(0, 0, 100, 100);
			const filter = makeFilter({ moveX: 10, copies: 1 });

			const geometries = handler.preProcessAppearance(
				{ appearance: solidFill(), segments: rect },
				filter,
			);

			expect(geometries).toHaveLength(1);
			expect(geometries[0].segments).toEqual(deform(handler, rect, filter));
			expect(geometries[0].patternTransform).toBeUndefined();
		});

		it("gives each copy the pattern transform that maps it back onto the original", () => {
			const handler = new TransformFilterHandler();
			const rect = makeRect(0, 0, 100, 100);
			const filter = makeFilter({
				scaleX: 0.5,
				scaleY: 0.5,
				moveX: 10,
				angle: 90,
				copies: 2,
				transformPatterns: true,
			});

			const geometries = handler.preProcessAppearance(
				{ appearance: patternFill(), segments: rect },
				filter,
			);

			expect(geometries).toHaveLength(3);
			expect(geometries.flatMap((g) => g.segments)).toEqual(
				deform(handler, rect, filter),
			);
			for (const geometry of geometries) {
				const corner = extractAnchors(geometry.segments)[1];
				const mapped = applyAffineToPoint(geometry.patternTransform!, corner);
				expect(mapped.x).toBeCloseTo(100);
				expect(mapped.y).toBeCloseTo(0);
			}
		});

		it("scales from the brush default when the settings omit a size", () => {
			const handler = new TransformFilterHandler();
			const stroke = geometricStroke(4);
			const settings = stroke.paramData.params.brushSettings!;
			const sizeless = {
				...stroke,
				paramData: {
					...stroke.paramData,
					params: {
						...stroke.paramData.params,
						brushSettings: { ...settings, properties: { flow: { base: 1 } } },
					},
				},
			} as StrokeAppearance;

			const [, copy] = handler.preProcessAppearance(
				{ appearance: sizeless, segments: makeRect(0, 0, 100, 100) },
				makeFilter({ scaleX: 0.5, scaleY: 0.5, copies: 1, scaleStrokes: true }),
			);

			expect(
				(copy.appearance as StrokeAppearance).paramData.params.brushSettings
					?.properties.size?.base,
			).toBe(
				readStoredBrushSize(sizeless.paramData.params.brushSettings)! * 0.5,
			);
		});

		it("scales each copy's stroke width by the copy's uniform scale", () => {
			const handler = new TransformFilterHandler();
			const geometries = handler.preProcessAppearance(
				{ appearance: geometricStroke(4), segments: makeRect(0, 0, 100, 100) },
				makeFilter({ scaleX: 0.5, scaleY: 0.5, copies: 2, scaleStrokes: true }),
			);

			expect(
				geometries.map(
					(g) =>
						(g.appearance as StrokeAppearance).paramData.params.brushSettings
							?.properties.size?.base,
				),
			).toEqual([4, 2, 1]);
			expect(geometries.every((g) => g.patternTransform === undefined)).toBe(
				true,
			);
		});
	});

	describe("placement sharing", () => {
		it("recomputes when the parameters change", () => {
			const handler = new TransformFilterHandler();
			const rect = makeRect(0, 0, 100, 100);

			const before = deform(
				handler,
				rect,
				makeFilter({ moveX: 10, copies: 1 }),
			);
			const after = deform(handler, rect, makeFilter({ moveX: 20, copies: 1 }));

			expect(extractAnchors(splitCopies(before, 2)[1])[0].x).toBe(10);
			expect(extractAnchors(splitCopies(after, 2)[1])[0].x).toBe(20);
		});
	});

	describe("getExpansionMargin", () => {
		it("grows with every cumulative copy", () => {
			const handler = new TransformFilterHandler();
			const margin = handler.getExpansionMargin(
				makeFilter({ moveX: 10, copies: 3 }),
				{ width: 100, height: 100 },
			);
			expect(margin).toBe(30);
		});
	});

	describe("onScaleFilter", () => {
		it("scales only the move distances", () => {
			const handler = new TransformFilterHandler();
			const scaled = handler.onScaleFilter(
				makeFilter({ moveX: 10, moveY: 20, scaleX: 2, angle: 30 }),
				[2, 3],
			) as ReturnType<typeof makeFilter>;
			expect(scaled.paramData.params).toMatchObject({
				moveX: 20,
				moveY: 60,
				scaleX: 2,
				angle: 30,
			});
		});
	});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFilter(params: Partial<TransformParams>) {
	return {
		uid: "transform-test",
		processor: "transform",
		enabled: true,
		paramData: {
			version: "1",
			params: {
				scaleX: 1,
				scaleY: 1,
				moveX: 0,
				moveY: 0,
				angle: 0,
				reflectX: false,
				reflectY: false,
				copies: 0,
				origin: "center",
				random: false,
				seed: 42,
				transformPatterns: false,
				scaleStrokes: false,
				...params,
			} satisfies TransformParams,
		},
	} as unknown as Filter;
}

function solidFill(): FillAppearance {
	return {
		uid: "fill",
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: { type: "solid", color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 } },
			},
		},
	} as FillAppearance;
}

function patternFill(): FillAppearance {
	return {
		...solidFill(),
		paramData: {
			version: "1",
			params: {
				fill: {
					type: "pattern",
					defId: "def-1",
					scaleX: 1,
					scaleY: 1,
					rotation: 0,
					offsetX: 0,
					offsetY: 0,
				},
			},
		},
	} as FillAppearance;
}

function geometricStroke(width: number): StrokeAppearance {
	return {
		uid: "stroke",
		processor: "stroke",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				brushSettings: createStrokeBrushSettings(width),
				strokeColor: {
					type: "solid",
					color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
				},
			},
		},
	} as StrokeAppearance;
}

/** The whole deformed shape, as an appearance-less caller sees it. */
function deform(
	handler: TransformFilterHandler,
	segments: CubicBezierSegment[],
	filter: Filter,
): CubicBezierSegment[] {
	const geometries = handler.preProcessAppearance({ segments }, filter);
	return geometries.length === 1
		? geometries[0].segments
		: geometries.flatMap((geometry) => geometry.segments);
}

/** Split a concatenated output back into its `count` equally long copies. */
function splitCopies(
	segments: CubicBezierSegment[],
	count: number,
): CubicBezierSegment[][] {
	const size = segments.length / count;
	return Array.from({ length: count }, (_, i) =>
		segments.slice(i * size, (i + 1) * size),
	);
}

function applyTransform(
	segments: CubicBezierSegment[],
	params: Partial<TransformParams>,
): CubicBezierSegment[] {
	return deform(new TransformFilterHandler(), segments, makeFilter(params));
}

/** Closed rectangle: bottom-left → bottom-right → top-right → top-left. */
function makeRect(
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): CubicBezierSegment[] {
	const [first, ...rest] = closedRectSegments(x0, y0, x1, y1);
	return [{ ...first, isMoved: true }, ...rest];
}

/** Four-arc circle with relative handles. */
function makeCircle(cx: number, cy: number, r: number): CubicBezierSegment[] {
	const k = 0.5523 * r;
	return [
		lineSeg(
			{ x: cx, y: cy + r },
			{
				start: { x: cx + r, y: cy },
				cp1: { x: 0, y: k },
				cp2: { x: k, y: 0 },
				isMoved: true,
			},
		),
		lineSeg(
			{ x: cx - r, y: cy },
			{ cp1: { x: -k, y: 0 }, cp2: { x: 0, y: k } },
		),
		lineSeg(
			{ x: cx, y: cy - r },
			{ cp1: { x: 0, y: -k }, cp2: { x: -k, y: 0 } },
		),
		lineSeg(
			{ x: cx + r, y: cy },
			{ cp1: { x: k, y: 0 }, cp2: { x: 0, y: -k }, isClosed: true },
		),
	];
}

function extractAnchors(segments: CubicBezierSegment[]) {
	return [
		...(segments[0].start ? [segments[0].start] : []),
		...segments.map((s) => s.end),
	];
}
