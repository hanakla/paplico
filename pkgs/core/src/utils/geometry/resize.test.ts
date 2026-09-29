import { describe, expect, it } from "vitest";
import { readStoredBrushSize } from "../../brush/access";
import type {
	BoundingBox,
	CubicBezierSegment,
	FillAppearance,
	FillColor,
	FreeGradient,
	MeshGradient,
	Path,
	RadialGradient,
	StrokeAppearance,
	TextContent,
	TextLayout,
	TextStyle,
} from "../../schema";
import { computeInverseCompositionTransform } from "./geometry";
import {
	type Affine2D,
	applyAffineToPoint,
	IDENTITY_AFFINE,
} from "./repeatInterpolation";
import {
	boundsRelativeMap,
	createResizeAffine,
	mapGradientFilters,
	mapSegments,
	mapWithin,
	mirrorStrokeWidths,
	resizeAxisScale,
	resizeRemainder,
	scaleStrokeFilters,
	scaleTextContent,
	scaleTextLayout,
	scaleTextStyle,
} from "./resize";
import { getWorldSegments, toWorldPath } from "./segmentOps";

// --- Helpers ---

function makeBounds(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): BoundingBox {
	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	};
}

function makeTextStyle(overrides: Partial<TextStyle> = {}): TextStyle {
	return {
		fontFamily: "Arial",
		fontSource: { loaderId: "google", fontId: "Arial" },
		fontSize: 24,
		fontWeight: 400,
		fontStyle: "normal",
		fill: { type: "solid", color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 } },
		underline: false,
		strikethrough: false,
		letterSpacing: 0,
		baselineShift: 0,
		...overrides,
	};
}

function makeTextContent(
	runs: Array<{ text: string; style?: Partial<TextStyle> }>,
): TextContent {
	return {
		paragraphs: [
			{
				runs: runs.map((r) => ({
					text: r.text,
					style: makeTextStyle(r.style),
				})),
				alignment: "left" as const,
				lineHeight: 1.2,
				indent: 0,
				spacing: { before: 0, after: 0 },
			},
		],
	};
}

function makeFillAppearance(fill: FillColor): FillAppearance {
	return {
		uid: "app-fill",
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: { fill } },
	};
}

function makeStrokeAppearance(size: number): StrokeAppearance {
	return {
		uid: "app-stroke",
		processor: "stroke",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				strokeColor: {
					type: "solid",
					color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
				},
				brushSettings: {
					version: 2,
					engine: "geometric",
					strokeOpacity: 1,
					paintMode: "buildup",
					properties: { size: { base: size } },
					randomSeed: 0,
				},
			},
		},
	};
}

// --- Tests ---

describe("createResizeAffine", () => {
	it("should translate a flat axis instead of dividing by its zero extent", () => {
		const original = makeBounds(0, 50, 100, 50);
		const newBounds = makeBounds(0, 20, 100, 130);
		const map = createResizeAffine(original, newBounds);

		expect(map.d).toBe(1);
		expect(applyAffineToPoint(map, { x: 50, y: 50 })).toEqual({ x: 50, y: 20 });
	});

	it("should map the original min edge onto the new max edge when mirrored", () => {
		const original = makeBounds(0, 0, 100, 100);
		const newBounds = makeBounds(200, 0, 300, 100);
		const map = createResizeAffine(original, newBounds, { x: true, y: false });

		expect(map.a).toBe(-1);
		expect(map.d).toBe(1);
		expect(applyAffineToPoint(map, { x: 0, y: 0 })).toEqual({ x: 300, y: 0 });
		expect(applyAffineToPoint(map, { x: 100, y: 0 }).x).toBe(200);
	});
});

describe("mapWithin", () => {
	it("should express a world map in the space a placement maps from", () => {
		// A quarter turn places local x along world y; a world stretch along y
		// is a stretch along local x.
		const placement = { a: 0, b: 1, c: -1, d: 0, e: 10, f: 20 };
		const stretchY = { a: 1, b: 0, c: 0, d: 3, e: 0, f: 0 };
		const local = mapWithin(stretchY, placement);
		const p = { x: 5, y: 7 };
		const viaWorld = applyAffineToPoint(
			stretchY,
			applyAffineToPoint(placement, p),
		);
		const viaLocal = applyAffineToPoint(
			placement,
			applyAffineToPoint(local, p),
		);
		expect(viaLocal.x).toBeCloseTo(viaWorld.x);
		expect(viaLocal.y).toBeCloseTo(viaWorld.y);
		expect(local.a).toBeCloseTo(3);
		expect(local.d).toBeCloseTo(1);
	});
});

describe("resizeAxisScale / resizeRemainder", () => {
	it("should split a map into its axis scale and what is left", () => {
		const map = { a: 0, b: 2, c: -0.5, d: 0, e: 4, f: -1 };
		const scale = resizeAxisScale(map);
		expect(scale).toEqual({ x: 2, y: 0.5 });
		const remainder = resizeRemainder(map, scale);
		// The remainder composed onto the axis scale gives the map back.
		const p = { x: 3, y: 9 };
		const rebuilt = applyAffineToPoint(remainder, { x: p.x * 2, y: p.y * 0.5 });
		const direct = applyAffineToPoint(map, p);
		expect(rebuilt.x).toBeCloseTo(direct.x);
		expect(rebuilt.y).toBeCloseTo(direct.y);
	});

	it("should count a collapsed axis as unscaled", () => {
		expect(resizeAxisScale({ a: 0, b: 0, c: 0, d: 2, e: 0, f: 0 })).toEqual({
			x: 1,
			y: 2,
		});
	});
});

/** Bounds-relative maps: a mirror across the middle of an axis, and a quarter turn. */
const MIRROR_X: Affine2D = { a: -1, b: 0, c: 0, d: 1, e: 1, f: 0 };
const MIRROR_Y: Affine2D = { a: 1, b: 0, c: 0, d: -1, e: 0, f: 1 };
const MIRROR_BOTH: Affine2D = { a: -1, b: 0, c: 0, d: -1, e: 1, f: 1 };
const QUARTER_TURN: Affine2D = { a: 0, b: 1, c: -1, d: 0, e: 1, f: 0 };

describe("boundsRelativeMap", () => {
	it("should express a local mirror as a mirror across the middle of the bounds", () => {
		const bounds = makeBounds(-50, 0, 50, 20);
		const map = boundsRelativeMap(
			{ a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 },
			bounds,
			bounds,
		);
		const p = applyAffineToPoint(map, { x: 0.2, y: 0.7 });
		expect(p.x).toBeCloseTo(0.8);
		expect(p.y).toBeCloseTo(0.7);
	});

	it("should keep the coordinates of a flat side", () => {
		const flat = makeBounds(0, 10, 100, 10);
		const map = boundsRelativeMap(
			{ a: 2, b: 0, c: 0, d: 1, e: 0, f: 0 },
			flat,
			makeBounds(0, 10, 200, 10),
		);
		const p = applyAffineToPoint(map, { x: 0.3, y: 0.4 });
		expect(p.x).toBeCloseTo(0.3);
		expect(p.y).toBeCloseTo(0.4);
	});
});

describe("mapGradientFilters", () => {
	it("should turn a linear gradient with the shape", () => {
		const [filter] = mapGradientFilters(
			[
				makeFillAppearance({
					type: "linear",
					x1: 0,
					y1: 0.25,
					x2: 1,
					y2: 0.25,
					stops: [],
				}),
			],
			QUARTER_TURN,
		);

		expect((filter as FillAppearance).paramData.params.fill).toMatchObject({
			x1: 0.75,
			y1: 0,
			x2: 0.75,
			y2: 1,
		});
	});

	it("should hand the filters back untouched for an identity map", () => {
		const filters = [
			makeFillAppearance({
				type: "linear",
				x1: 0,
				y1: 0,
				x2: 1,
				y2: 1,
				stops: [],
			}),
		];
		expect(
			mapGradientFilters(filters, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
		).toBe(filters);
	});

	it("should move a linear gradient's endpoints to the other side", () => {
		const [filter] = mapGradientFilters(
			[
				makeFillAppearance({
					type: "linear",
					x1: 0,
					y1: 0.25,
					x2: 1,
					y2: 0.25,
					stops: [],
				}),
			],
			MIRROR_X,
		);

		expect((filter as FillAppearance).paramData.params.fill).toMatchObject({
			x1: 1,
			y1: 0.25,
			x2: 0,
			y2: 0.25,
		});
	});

	it("should turn a radial gradient's rotation the other way", () => {
		const radial: RadialGradient = {
			type: "radial",
			cx: 0.25,
			cy: 0.5,
			radiusX: 0.4,
			radiusY: 0.2,
			rotation: 0.3,
			stops: [],
		};
		const [mirroredX] = mapGradientFilters(
			[makeFillAppearance(radial)],
			MIRROR_X,
		);
		const [mirroredBoth] = mapGradientFilters(
			[makeFillAppearance(radial)],
			MIRROR_BOTH,
		);

		const fillX = (mirroredX as FillAppearance).paramData.params
			.fill as RadialGradient;
		expect(fillX.cx).toBeCloseTo(0.75);
		expect(fillX.cy).toBeCloseTo(0.5);
		expect(fillX.radiusX).toBeCloseTo(0.4);
		expect(fillX.radiusY).toBeCloseTo(0.2);
		expect(fillX.rotation).toBeCloseTo(-0.3);
		// A mirror on both axes is a half turn, which leaves the ellipse as it was.
		const fillBoth = (mirroredBoth as FillAppearance).paramData.params
			.fill as RadialGradient;
		expect(fillBoth.cx).toBeCloseTo(0.75);
		expect(fillBoth.cy).toBeCloseTo(0.5);
		expect(fillBoth.radiusX).toBeCloseTo(0.4);
		expect(fillBoth.rotation).toBeCloseTo(0.3);
	});

	it("should keep the radii's roles when a turn swaps the ellipse's axes", () => {
		const [turned] = mapGradientFilters(
			[
				makeFillAppearance({
					type: "radial",
					cx: 0.5,
					cy: 0.5,
					radiusX: 0.2,
					radiusY: 0.4,
					rotation: 0,
					stops: [],
				}),
			],
			QUARTER_TURN,
		);

		const fill = (turned as FillAppearance).paramData.params
			.fill as RadialGradient;
		expect(fill.radiusX).toBeCloseTo(0.2);
		expect(fill.radiusY).toBeCloseTo(0.4);
		expect(Math.abs(fill.rotation)).toBeCloseTo(Math.PI / 2);
	});

	it("should move a free gradient's stops and their edge control points", () => {
		const [filter] = mapGradientFilters(
			[
				makeFillAppearance({
					type: "free",
					stops: [
						{
							id: "a",
							x: 0.2,
							y: 0.5,
							color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
							edgeCPs: { b: { x: 0.4, y: 0.5 } },
						},
					],
				}),
			],
			MIRROR_X,
		);

		const fill = (filter as FillAppearance).paramData.params
			.fill as FreeGradient;
		expect(fill.stops[0]).toMatchObject({ x: 0.8, y: 0.5 });
		expect(fill.stops[0].edgeCPs?.b).toEqual({ x: 0.6, y: 0.5 });
	});

	it("should move a mesh gradient's vertices and their handles", () => {
		const [filter] = mapGradientFilters(
			[
				makeFillAppearance({
					type: "mesh",
					vertices: [
						{
							x: 0.25,
							y: 0.75,
							color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
							colorMode: "explicit",
							handles: { 1: { x: 0.5, y: 0.75 } },
						},
					],
					faces: [],
				}),
			],
			MIRROR_Y,
		);

		const fill = (filter as FillAppearance).paramData.params
			.fill as MeshGradient;
		expect(fill.vertices[0]).toMatchObject({ x: 0.25, y: 0.25 });
		expect(fill.vertices[0].handles[1]).toEqual({ x: 0.5, y: 0.25 });
	});

	it("should leave a solid fill alone", () => {
		const filters = [
			makeFillAppearance({
				type: "solid",
				color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
			}),
		];
		expect(mapGradientFilters(filters, MIRROR_BOTH)).toEqual(filters);
	});

	it("should return the stack untouched when nothing is mirrored", () => {
		const filters = [
			makeFillAppearance({
				type: "linear",
				x1: 0,
				y1: 0,
				x2: 1,
				y2: 0,
				stops: [],
			}),
		];
		expect(mapGradientFilters(filters, IDENTITY_AFFINE)).toBe(filters);
	});
});

describe("mirrorStrokeWidths", () => {
	const widths = [
		{ t: 0, side1: 2, side2: 0.5 },
		{ t: 1, side1: 1, side2: 0 },
	];

	it("should swap the sides when mirrored on one axis", () => {
		expect(mirrorStrokeWidths(widths, { x: true, y: false })).toEqual([
			{ t: 0, side1: 0.5, side2: 2 },
			{ t: 1, side1: 0, side2: 1 },
		]);
		expect(mirrorStrokeWidths(widths, { x: false, y: true })).toEqual([
			{ t: 0, side1: 0.5, side2: 2 },
			{ t: 1, side1: 0, side2: 1 },
		]);
	});

	it("should keep the sides when mirrored on both axes", () => {
		expect(mirrorStrokeWidths(widths, { x: true, y: true })).toEqual(widths);
	});
});

describe("scaleStrokeFilters", () => {
	it("should scale brushSettings.size of stroke filters", () => {
		const result = scaleStrokeFilters([makeStrokeAppearance(10)], 2);
		const stroke = result?.[0] as StrokeAppearance;
		expect(readStoredBrushSize(stroke.paramData.params.brushSettings)).toBe(20);
	});

	it("should pass non-stroke filters through unchanged", () => {
		const fill = {
			uid: "app-fill",
			processor: "fill",
			opacity: 1,
			blendMode: "normal" as const,
			paramData: { version: "1", params: {} },
		};
		const result = scaleStrokeFilters([fill], 2);
		expect(result?.[0]).toBe(fill);
	});

	it("should return undefined for undefined filters", () => {
		expect(scaleStrokeFilters(undefined, 2)).toBeUndefined();
	});

	it("should skip stroke filters without brushSettings", () => {
		const app = makeStrokeAppearance(10);
		app.paramData.params.brushSettings = undefined;
		const result = scaleStrokeFilters([app], 2);
		expect(result?.[0]).toBe(app);
	});

	it("should not mutate the original filter", () => {
		const app = makeStrokeAppearance(10);
		scaleStrokeFilters([app], 2);
		expect(readStoredBrushSize(app.paramData.params.brushSettings)).toBe(10);
	});
});

describe("scaleTextStyle", () => {
	it("should scale fontSize by the uniform factor", () => {
		const style = makeTextStyle({ fontSize: 24 });
		const result = scaleTextStyle(style, 2);
		expect(result.fontSize).toBe(48);
	});

	it("should scale strokeWidth when present", () => {
		const style = makeTextStyle({ fontSize: 16, strokeWidth: 2 });
		const result = scaleTextStyle(style, 1.5);
		expect(result.fontSize).toBe(24);
		expect(result.strokeWidth).toBe(3);
	});

	it("should leave strokeWidth undefined when absent", () => {
		const style = makeTextStyle({ fontSize: 16, strokeWidth: undefined });
		const result = scaleTextStyle(style, 2);
		expect(result.strokeWidth).toBeUndefined();
	});

	it("should not mutate the original style", () => {
		const style = makeTextStyle({ fontSize: 20 });
		scaleTextStyle(style, 3);
		expect(style.fontSize).toBe(20);
	});

	it("should preserve non-scaled properties", () => {
		const style = makeTextStyle({
			fontFamily: "Noto Sans JP",
			fontWeight: 700,
			fontStyle: "italic",
			letterSpacing: 0.05,
			underline: true,
		});
		const result = scaleTextStyle(style, 2);
		expect(result.fontFamily).toBe("Noto Sans JP");
		expect(result.fontWeight).toBe(700);
		expect(result.fontStyle).toBe("italic");
		expect(result.letterSpacing).toBe(0.05);
		expect(result.underline).toBe(true);
	});

	it("should handle scale factor < 1 (shrink)", () => {
		const style = makeTextStyle({ fontSize: 48 });
		const result = scaleTextStyle(style, 0.5);
		expect(result.fontSize).toBe(24);
	});
});

describe("scaleTextContent", () => {
	it("should scale fontSize of all runs in all paragraphs", () => {
		const content = makeTextContent([
			{ text: "Hello", style: { fontSize: 24 } },
			{ text: " World", style: { fontSize: 36 } },
		]);
		const result = scaleTextContent(content, 2);

		expect(result.paragraphs[0].runs[0].style.fontSize).toBe(48);
		expect(result.paragraphs[0].runs[1].style.fontSize).toBe(72);
	});

	it("should scale strokeWidth in runs that have it", () => {
		const content = makeTextContent([
			{ text: "A", style: { fontSize: 20, strokeWidth: 1 } },
			{ text: "B", style: { fontSize: 20, strokeWidth: undefined } },
		]);
		const result = scaleTextContent(content, 3);

		expect(result.paragraphs[0].runs[0].style.strokeWidth).toBe(3);
		expect(result.paragraphs[0].runs[1].style.strokeWidth).toBeUndefined();
	});

	it("should not mutate the original content", () => {
		const content = makeTextContent([
			{ text: "Test", style: { fontSize: 16 } },
		]);
		scaleTextContent(content, 5);
		expect(content.paragraphs[0].runs[0].style.fontSize).toBe(16);
	});

	it("should preserve run text", () => {
		const content = makeTextContent([
			{ text: "あいう", style: { fontSize: 12 } },
		]);
		const result = scaleTextContent(content, 2);
		expect(result.paragraphs[0].runs[0].text).toBe("あいう");
	});

	it("should handle multiple paragraphs", () => {
		const content: TextContent = {
			paragraphs: [
				{
					runs: [{ text: "P1", style: makeTextStyle({ fontSize: 10 }) }],
					alignment: "left",
					lineHeight: 1.2,
					indent: 0,
					spacing: { before: 0, after: 0 },
				},
				{
					runs: [{ text: "P2", style: makeTextStyle({ fontSize: 20 }) }],
					alignment: "center",
					lineHeight: 1.5,
					indent: 10,
					spacing: { before: 4, after: 8 },
				},
			],
		};
		const result = scaleTextContent(content, 2);
		expect(result.paragraphs[0].runs[0].style.fontSize).toBe(20);
		expect(result.paragraphs[1].runs[0].style.fontSize).toBe(40);
		// paragraph-level properties are preserved
		expect(result.paragraphs[1].alignment).toBe("center");
		expect(result.paragraphs[1].indent).toBe(10);
	});
});

describe("scaleTextLayout", () => {
	it("should scale numeric boxWidth/boxHeight", () => {
		const layout: TextLayout = {
			writingMode: "horizontal-tb",
			boxWidth: 200,
			boxHeight: 100,
			overflow: "visible",
			wordWrap: true,
		};
		const result = scaleTextLayout(
			layout,
			{ x: 2, y: 3 },
			{ width: 400, height: 300 },
		);
		expect(result.boxWidth).toBe(400); // 200 * 2.0
		expect(result.boxHeight).toBe(300); // 100 * 3.0
	});

	it("should pin an 'auto' side at the scaled measured size", () => {
		const layout: TextLayout = {
			writingMode: "horizontal-tb",
			boxWidth: "auto",
			boxHeight: "auto",
			overflow: "visible",
			wordWrap: true,
		};

		const result = scaleTextLayout(
			layout,
			{ x: 1.5, y: 2 },
			{ width: 300, height: 200 },
		);
		expect(result.boxWidth).toBe(300);
		expect(result.boxHeight).toBe(200);
	});

	it("should preserve non-layout properties", () => {
		const layout: TextLayout = {
			writingMode: "vertical-rl",
			boxWidth: 100,
			boxHeight: 200,
			overflow: "hidden",
			wordWrap: false,
		};
		const result = scaleTextLayout(
			layout,
			{ x: 2, y: 2 },
			{ width: 200, height: 400 },
		);
		expect(result.writingMode).toBe("vertical-rl");
		expect(result.overflow).toBe("hidden");
		expect(result.wordWrap).toBe(false);
	});

	it("should not mutate the original layout", () => {
		const layout: TextLayout = {
			writingMode: "horizontal-tb",
			boxWidth: 100,
			boxHeight: 50,
			overflow: "visible",
			wordWrap: true,
		};
		scaleTextLayout(layout, { x: 3, y: 3 }, { width: 300, height: 150 });
		expect(layout.boxWidth).toBe(100);
		expect(layout.boxHeight).toBe(50);
	});
});

describe("text resize integration", () => {
	it("uniform scale: 2x enlargement should double fontSize", () => {
		const original = makeBounds(0, 0, 100, 100);
		const scaled = makeBounds(0, 0, 200, 200);
		const map = createResizeAffine(original, scaled);
		const uniformScale = Math.sqrt(map.a * map.d);

		expect(uniformScale).toBe(2);

		const style = makeTextStyle({ fontSize: 16 });
		const result = scaleTextStyle(style, uniformScale);
		expect(result.fontSize).toBe(32);
	});

	it("non-uniform scale: geometric mean of scaleX and scaleY", () => {
		const original = makeBounds(0, 0, 100, 100);
		const scaled = makeBounds(0, 0, 400, 100); // 4x horizontal, 1x vertical
		const map = createResizeAffine(original, scaled);
		const uniformScale = Math.sqrt(map.a * map.d);

		expect(uniformScale).toBe(2); // sqrt(4 * 1) = 2

		const style = makeTextStyle({ fontSize: 12 });
		const result = scaleTextStyle(style, uniformScale);
		expect(result.fontSize).toBe(24);
	});

	it("shrink to half: fontSize should halve", () => {
		const original = makeBounds(0, 0, 200, 200);
		const scaled = makeBounds(0, 0, 100, 100);
		const map = createResizeAffine(original, scaled);
		const uniformScale = Math.sqrt(map.a * map.d);

		expect(uniformScale).toBe(0.5);

		const style = makeTextStyle({ fontSize: 48 });
		const result = scaleTextStyle(style, uniformScale);
		expect(result.fontSize).toBe(24);
	});

	it("full text element resize: position, layout, style, and content all scale correctly", () => {
		const original = makeBounds(50, 50, 250, 150);
		const newBounds = makeBounds(50, 50, 450, 250);
		const map = createResizeAffine(original, newBounds);
		const uniformScale = Math.sqrt(map.a * map.d);

		// Position mapping: element at center of original bounds
		const center = applyAffineToPoint(map, { x: 150, y: 100 });
		expect(center.x).toBe(250); // 50 + (150-50)*2 = 250
		expect(center.y).toBe(150); // 50 + (100-50)*2 = 150

		// Layout
		const layout: TextLayout = {
			writingMode: "horizontal-tb",
			boxWidth: 200,
			boxHeight: 100,
			overflow: "visible",
			wordWrap: true,
		};
		const scaledLayout = scaleTextLayout(
			layout,
			{ x: map.a, y: map.d },
			{ width: newBounds.width, height: newBounds.height },
		);
		expect(scaledLayout.boxWidth).toBe(400); // 200 * 2
		expect(scaledLayout.boxHeight).toBe(200); // 100 * 2

		// Style: uniformScale = sqrt(2*2) = 2
		expect(uniformScale).toBe(2);
		const style = makeTextStyle({ fontSize: 16, strokeWidth: 1 });
		const scaledStyle = scaleTextStyle(style, uniformScale);
		expect(scaledStyle.fontSize).toBe(32);
		expect(scaledStyle.strokeWidth).toBe(2);

		// Content
		const content = makeTextContent([
			{ text: "Hello", style: { fontSize: 24 } },
		]);
		const scaledContent = scaleTextContent(content, uniformScale);
		expect(scaledContent.paragraphs[0].runs[0].style.fontSize).toBe(48);
	});
});

describe("resize commit under a transformed ancestor", () => {
	// Mirrors Paplico.applyElementResize's path branch: bake to world through
	// the ancestor transform, scale in world space, then store the ancestor's
	// inverse as the path transform so the renderer's re-applied ancestor
	// transform cancels out.
	it("should land the scaled path exactly where the world-space map put it", () => {
		const ancestorT = {
			x: 40,
			y: -25,
			rotation: Math.PI / 6,
			scaleX: 1.5,
			scaleY: 0.8,
			skewX: 0,
			skewY: 0,
		};
		const path = makePath();

		const worldPath = toWorldPath(path, ancestorT);
		const originalBounds = makeBounds(-100, -100, 100, 100);
		const newBounds = makeBounds(-100, -100, 300, 300);
		const map = createResizeAffine(originalBounds, newBounds);

		const committed: Path = {
			...path,
			segments: mapSegments(worldPath.segments, map),
			transform: computeInverseCompositionTransform(ancestorT),
		};

		const rendered = getWorldSegments(committed, ancestorT);
		const expected = committed.segments;

		for (let i = 0; i < expected.length; i++) {
			const expectedStart = expected[i].start;
			if (expectedStart) {
				expect(rendered[i].start?.x).toBeCloseTo(expectedStart.x, 6);
				expect(rendered[i].start?.y).toBeCloseTo(expectedStart.y, 6);
			}
			expect(rendered[i].end.x).toBeCloseTo(expected[i].end.x, 6);
			expect(rendered[i].end.y).toBeCloseTo(expected[i].end.y, 6);
		}
	});
});

function makePath(): Path {
	const segments: CubicBezierSegment[] = [
		{
			start: { x: 10, y: 20 },
			cp1: { x: 35, y: -8 },
			cp2: { x: -24, y: 14 },
			end: { x: 80, y: 50 },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: true,
		},
		{
			cp1: { x: 12, y: -5 },
			cp2: { x: -16, y: 9 },
			end: { x: 120, y: 85 },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: false,
		},
	];

	return {
		type: "path",
		id: "path-1",
		opacity: 1,
		blendMode: "normal",
		transform: {
			x: 15,
			y: -10,
			rotation: 0.2,
			scaleX: 1,
			scaleY: 1,
			skewX: 0,
			skewY: 0,
		},
		segments,
	};
}

describe("scaleStrokeFilters with stored v2 brush settings", () => {
	it("should scale the v2 size property base without corrupting the value", () => {
		const app = makeStrokeAppearance(10);
		app.paramData.params.brushSettings = {
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "buildup",
			properties: {
				size: {
					base: 10,
					curves: [
						{
							input: "pressure",
							points: [
								[0, -0.5],
								[1, 0],
							],
						},
					],
				},
			},
			randomSeed: 0,
		} as unknown as StrokeAppearance["paramData"]["params"]["brushSettings"];

		const result = scaleStrokeFilters([app], 2);
		const scaled = (result?.[0] as StrokeAppearance).paramData.params
			.brushSettings as unknown as {
			properties: { size?: { base: number; curves?: unknown[] } };
		};
		expect(scaled.properties.size?.base).toBe(20);
		expect(scaled.properties.size?.curves?.length).toBe(1);
	});
});
