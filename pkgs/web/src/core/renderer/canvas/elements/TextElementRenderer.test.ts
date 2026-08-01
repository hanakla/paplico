import { describe, expect, it, vi } from "vitest";
import { createIdentityTransform } from "../../../document/factory";
import type {
	BoundingBox,
	FillAppearance,
	FillParams,
	Filter,
	Path,
	StrokeAppearance,
	TextElement,
} from "../../../schema";
import { closedRectSegments } from "../../../testUtils/segmentFactory";
import {
	applyRotate3DToSegments,
	applyRotate3DWithContext,
	createRotate3DProjectionContext,
	type Rotate3DParams,
} from "../../filters/Rotate3DFilterProcessor";
import {
	buildGlyphPaintFilters,
	TextElementRenderer,
} from "./TextElementRenderer";

describe("TextElementRenderer", () => {
	describe("renderText", () => {
		it("should apply 3d-rotate with the text bounds while preserving per-path paint filters", () => {
			const renderPath = vi.fn();
			const rotateParams: Rotate3DParams = {
				rotateX: 0,
				rotateY: 45,
				rotateZ: 0,
				perspective: 60,
			};
			const renderer = new TextElementRenderer({
				textState: {
					renderer: {
						computeTextCacheKey: vi.fn(() => "text-cache"),
						getFlowHead: vi.fn((el) => el),
					},
					pathCache: new Map([
						[
							"text-cache",
							{
								paths: [
									createGlyphPath("left", makeFill("left")),
									createGlyphPath("right", makeFill("right")),
								],
								localBounds: {
									minX: -50,
									minY: -10,
									maxX: 50,
									maxY: 10,
									width: 100,
									height: 20,
								} satisfies BoundingBox,
							},
						],
					]),
					stalePathCache: new Map(),
					pendingPathCacheKeys: new Set(),
				},
				renderState: {
					boundsCache: new Map(),
					localBoundsCache: new Map(),
				},
				renderPath,
			} as unknown as ConstructorParameters<typeof TextElementRenderer>[0]);
			const element = createTextElement(rotateParams);

			renderer.renderText({} as GPURenderPassEncoder, element, 0.75, "main");

			expect(renderPath).toHaveBeenCalledTimes(2);

			const leftPath = renderPath.mock.calls[0]?.[1] as Path;
			const rightPath = renderPath.mock.calls[1]?.[1] as Path;
			const worldBounds = {
				minX: -50,
				minY: -10,
				maxX: 50,
				maxY: 10,
			};
			const leftSource = createGlyphPath("left", makeFill("left")).segments;
			const rightSource = createGlyphPath("right", makeFill("right")).segments;
			const sharedContext = createRotate3DProjectionContext(
				rotateParams,
				[...leftSource, ...rightSource],
				worldBounds,
			);

			expect(leftPath.filters?.map((filter) => filter.processor)).toEqual([
				"fill",
			]);
			expect(rightPath.filters?.map((filter) => filter.processor)).toEqual([
				"fill",
			]);
			expect(leftPath.filters?.[0]).toEqual(makeFill("left"));
			expect(rightPath.filters?.[0]).toEqual(makeFill("right"));
			expect(leftPath.opacity).toBe(0.75);
			expect(rightPath.opacity).toBe(0.75);
			expect(leftPath.segments).toEqual(
				sharedContext
					? applyRotate3DWithContext(leftSource, sharedContext)
					: applyRotate3DToSegments(leftSource, rotateParams, worldBounds),
			);
			expect(rightPath.segments).toEqual(
				sharedContext
					? applyRotate3DWithContext(rightSource, sharedContext)
					: applyRotate3DToSegments(rightSource, rotateParams, worldBounds),
			);
		});
	});

	describe("requestTextPathCache", () => {
		it("should populate the path cache and trigger a re-render once the async load resolves", async () => {
			const onRequestRender = vi.fn();
			const pathCache = new Map();
			const pendingPathCacheKeys = new Set<string>();
			const textElementToPaths = vi.fn(async () => ({
				paths: [createGlyphPath("g", makeFill("g"))],
				bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10, width: 10, height: 10 },
			}));
			const renderer = new TextElementRenderer({
				textState: {
					renderer: { textElementToPaths },
					pathCache,
					stalePathCache: new Map(),
					pendingPathCacheKeys,
					onRequestRender,
				},
				renderState: { boundsCache: new Map(), localBoundsCache: new Map() },
				renderPath: vi.fn(),
			} as unknown as ConstructorParameters<typeof TextElementRenderer>[0]);
			const element = {
				type: "text",
				id: "text-1",
				x: 5,
				y: 7,
			} as unknown as TextElement;

			renderer.requestTextPathCache("text-cache", element);
			// Cache miss is marked pending immediately (synchronously).
			expect(pendingPathCacheKeys.has("text-cache")).toBe(true);
			await textElementToPaths.mock.results[0]!.value;
			// Flush the .then()/.finally() microtasks queued after the awaited value.
			await Promise.resolve();
			await Promise.resolve();

			expect(pathCache.has("text-cache")).toBe(true);
			expect(onRequestRender).toHaveBeenCalledTimes(1);
			expect(pendingPathCacheKeys.has("text-cache")).toBe(false);
		});

		it("should not start a second load while one is already pending for the same key", () => {
			const textElementToPaths = vi.fn(
				() => new Promise<never>(() => {}), // never resolves
			);
			const renderer = new TextElementRenderer({
				textState: {
					renderer: { textElementToPaths },
					pathCache: new Map(),
					stalePathCache: new Map(),
					pendingPathCacheKeys: new Set(),
				},
				renderState: { boundsCache: new Map(), localBoundsCache: new Map() },
				renderPath: vi.fn(),
			} as unknown as ConstructorParameters<typeof TextElementRenderer>[0]);
			const element = {
				type: "text",
				id: "text-1",
				x: 0,
				y: 0,
			} as unknown as TextElement;

			renderer.requestTextPathCache("text-cache", element);
			renderer.requestTextPathCache("text-cache", element);

			expect(textElementToPaths).toHaveBeenCalledTimes(1);
		});
	});
});

describe("buildGlyphPaintFilters", () => {
	const red: FillParams["fill"] = {
		type: "solid",
		color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
	};
	const blue: FillParams["fill"] = {
		type: "solid",
		color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
	};

	const fillApp = (fill: FillParams["fill"], enabled?: boolean): Filter => ({
		uid: "app-fill",
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		...(enabled === undefined ? {} : { enabled }),
		paramData: { version: "1", params: { fill } },
	});

	const paintKinds = (filters: Filter[]) => filters.map((f) => f.processor);
	const fillValueAt = (filters: Filter[], i: number) =>
		(filters[i] as FillAppearance).paramData.params.fill;

	it("should paint the intrinsic fill below the stack for legacy text without a content entry", () => {
		const result = buildGlyphPaintFilters({
			elementFilters: [fillApp(blue)],
			glyphFilters: undefined,
			defaultFill: red,
			defaultStroke: null,
			defaultBrushWidth: 1,
		});

		expect(paintKinds(result)).toEqual(["fill", "fill"]);
		expect(fillValueAt(result, 0)).toEqual(red);
		expect(fillValueAt(result, 1)).toEqual(blue);
	});

	it("should paint the intrinsic fill at the content entry's stack position", () => {
		const result = buildGlyphPaintFilters({
			elementFilters: [fillApp(blue), contentAppearance(true)],
			glyphFilters: undefined,
			defaultFill: red,
			defaultStroke: null,
			defaultBrushWidth: 1,
		});

		// [fill, content] -> the intrinsic color overpaints the fill appearance
		expect(paintKinds(result)).toEqual(["fill", "fill"]);
		expect(fillValueAt(result, 0)).toEqual(blue);
		expect(fillValueAt(result, 1)).toEqual(red);
	});

	it("should skip the intrinsic fill when the content appearance is disabled", () => {
		const result = buildGlyphPaintFilters({
			elementFilters: [contentAppearance(false), fillApp(blue)],
			glyphFilters: undefined,
			defaultFill: red,
			defaultStroke: null,
			defaultBrushWidth: 1,
		});

		expect(paintKinds(result)).toEqual(["fill"]);
		expect(fillValueAt(result, 0)).toEqual(blue);
	});

	it("should prefer the per-run fill over the default style as the intrinsic color", () => {
		const result = buildGlyphPaintFilters({
			elementFilters: [contentAppearance()],
			glyphFilters: [fillApp(blue)],
			defaultFill: red,
			defaultStroke: null,
			defaultBrushWidth: 1,
		});

		expect(paintKinds(result)).toEqual(["fill"]);
		expect(fillValueAt(result, 0)).toEqual(blue);
	});

	it("should apply the default-style stroke only while no stroke appearance exists", () => {
		const strokeApp: Filter = {
			uid: "app-stroke",
			processor: "stroke",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					strokeColor: {
						type: "solid",
						color: { type: "rgb", r: 0, g: 1, b: 0, a: 1 },
					},
				},
			},
		};

		const withApp = buildGlyphPaintFilters({
			elementFilters: [contentAppearance(), strokeApp],
			glyphFilters: undefined,
			defaultFill: red,
			defaultStroke: blue,
			defaultBrushWidth: 1,
		});
		expect(paintKinds(withApp)).toEqual(["fill", "stroke"]);

		const withoutApp = buildGlyphPaintFilters({
			elementFilters: [contentAppearance()],
			glyphFilters: undefined,
			defaultFill: red,
			defaultStroke: blue,
			defaultBrushWidth: 1,
		});
		expect(paintKinds(withoutApp)).toEqual(["fill", "stroke"]);
		expect(
			(withoutApp[1] as StrokeAppearance).paramData.params.strokeColor,
		).toEqual(blue);
	});
});

function contentAppearance(enabled?: boolean): Filter {
	return {
		uid: "app-content",
		processor: "content",
		opacity: 1,
		blendMode: "normal",
		...(enabled === undefined ? {} : { enabled }),
		paramData: { version: "1", params: {} },
	};
}

describe("axis appearance underlay", () => {
	const zeroRotate: Rotate3DParams = {
		rotateX: 0,
		rotateY: 0,
		rotateZ: 0,
		perspective: 0,
	};
	const axisSegments = [
		{
			start: { x: 0, y: 0 },
			cp1: { x: 20 / 3, y: 0 },
			cp2: { x: -20 / 3, y: 0 },
			end: { x: 100, y: 0 },
			startPressure: 1,
			endPressure: 1,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: true,
		},
	];

	const setup = (axisFilters: FillAppearance[]) => {
		const renderPath = vi.fn();
		const axisPath: Path = {
			type: "path",
			id: "axis-1",
			// Legacy guide-ified value: the underlay normalizes it to 1
			opacity: 0,
			blendMode: "normal",
			transform: createIdentityTransform(),
			filters: axisFilters,
			segments: [],
		};
		const renderer = new TextElementRenderer({
			textState: {
				renderer: {
					computeTextCacheKey: vi.fn(() => "text-cache"),
					getFlowHead: vi.fn((el: TextElement) => el),
					getAxisPathObject: vi.fn(() => axisPath),
					getAxisLocalSegments: vi.fn(() => axisSegments),
				},
				pathCache: new Map([
					[
						"text-cache",
						{
							paths: [createGlyphPath("left", makeFill("left"))],
							localBounds: {
								minX: -50,
								minY: -10,
								maxX: 50,
								maxY: 10,
								width: 100,
								height: 20,
							} satisfies BoundingBox,
						},
					],
				]),
				stalePathCache: new Map(),
				pendingPathCacheKeys: new Set(),
			},
			renderState: {
				boundsCache: new Map(),
				localBoundsCache: new Map(),
				paintedAxisPathIds: new Set<string>(),
			},
			renderPath,
		} as unknown as ConstructorParameters<typeof TextElementRenderer>[0]);
		const element = {
			...createTextElement(zeroRotate),
			filters: [],
			axisBinding: {
				mode: "onPath",
				pathObjectId: "axis-1",
				startOffset: 0,
				alignment: "left",
				offsetDistance: 0,
				orientation: "rotate",
			},
		} as TextElement;
		return { renderer, renderPath, element };
	};

	it("should paint the axis path's appearances under the glyphs", () => {
		const axisFill = makeFill("left");
		const { renderer, renderPath, element } = setup([axisFill]);

		renderer.renderText({} as GPURenderPassEncoder, element, 1, "main");

		expect(renderPath).toHaveBeenCalledTimes(2);
		const underlay = renderPath.mock.calls[0]?.[1] as Path;
		expect(underlay.id).toBe("axis-1");
		expect(underlay.filters).toEqual([axisFill]);
		expect(underlay.opacity).toBe(1);
		// Glyphs paint after the underlay so the text stays on top
		const glyph = renderPath.mock.calls[1]?.[1] as Path;
		expect(glyph.id).toBe("left");
	});

	it("should stay hidden without enabled appearance filters", () => {
		const { renderer, renderPath, element } = setup([]);

		renderer.renderText({} as GPURenderPassEncoder, element, 1, "main");

		expect(renderPath).toHaveBeenCalledTimes(1);
		expect((renderPath.mock.calls[0]?.[1] as Path).id).toBe("left");
	});
});

describe("bound text bounds sync", () => {
	it("should union the axis region into the synced bounds", () => {
		const zeroRotate: Rotate3DParams = {
			rotateX: 0,
			rotateY: 0,
			rotateZ: 0,
			perspective: 0,
		};
		const onTextBoundsComputed = vi.fn();
		const renderer = new TextElementRenderer({
			textState: {
				renderer: {
					computeTextCacheKey: vi.fn(() => "text-cache"),
					getFlowHead: vi.fn((el: TextElement) => el),
					getAxisPathObject: vi.fn(() => null),
					// Region rect (0,-30)-(40,0) in the text's layout-local space
					getAxisLocalSegments: vi.fn(() => closedRectSegments(0, -30, 40, 0)),
				},
				pathCache: new Map([
					[
						"text-cache",
						{
							paths: [],
							// Glyph ink covers only the region's top-left corner
							localBounds: {
								minX: 0,
								minY: -10,
								maxX: 20,
								maxY: 0,
								width: 20,
								height: 10,
							} satisfies BoundingBox,
						},
					],
				]),
				stalePathCache: new Map(),
				pendingPathCacheKeys: new Set(),
				onTextBoundsComputed,
			},
			renderState: {
				boundsCache: new Map(),
				localBoundsCache: new Map(),
				paintedAxisPathIds: new Set<string>(),
			},
			renderPath: vi.fn(),
		} as unknown as ConstructorParameters<typeof TextElementRenderer>[0]);
		const element = {
			...createTextElement(zeroRotate),
			filters: [],
			axisBinding: { mode: "inShape", pathObjectId: "region-1" },
		} as TextElement;

		renderer.renderText({} as GPURenderPassEncoder, element, 1, "main");

		expect(onTextBoundsComputed).toHaveBeenCalledTimes(1);
		const synced = onTextBoundsComputed.mock.calls[0][1] as BoundingBox;
		expect(synced).toMatchObject({ minX: 0, minY: -30, maxX: 40, maxY: 0 });
	});
});

function createTextElement(rotateParams: Rotate3DParams): TextElement {
	return {
		type: "text",
		id: "text-1",
		x: 0,
		y: 0,
		content: {
			paragraphs: [
				{
					runs: [],
					alignment: "left",
					lineHeight: 1.2,
					indent: 0,
					spacing: { before: 0, after: 0 },
				},
			],
		},
		defaultStyle: {
			fontFamily: "Test",
			fontSource: { type: "google", family: "Inter", variants: ["400"] },
			fontSize: 10,
			fontWeight: 400,
			fontStyle: "normal",
			fill: null,
			stroke: null,
			strokeWidth: 1,
			underline: false,
			strikethrough: false,
			letterSpacing: 0,
			lineHeight: 1.2,
			baselineShift: 0,
		},
		layout: {
			writingMode: "horizontal-tb",
			boxWidth: "auto",
			boxHeight: "auto",
			overflow: "visible",
			wordWrap: false,
		},
		opacity: 0.75,
		blendMode: "normal",
		transform: createIdentityTransform(),
		filters: [
			{
				uid: "rotate-3d",
				processor: "3d-rotate",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: rotateParams,
				},
			},
		],
	};
}

function createGlyphPath(id: string, fill: FillAppearance): Path {
	const offset = id === "left" ? -30 : 30;
	return {
		type: "path",
		id,
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		filters: [fill],
		segments: [
			{
				start: { x: offset - 10, y: -10 },
				cp1: { x: 20 / 3, y: 0 },
				cp2: { x: -20 / 3, y: 0 },
				end: { x: offset + 10, y: -10 },
				startPressure: 1,
				endPressure: 1,
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: true,
			},
		],
	};
}

function makeFill(id: string): FillAppearance {
	return {
		uid: `fill-${id}`,
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: {
					type: "solid",
					color:
						id === "left"
							? { type: "rgb", r: 1, g: 0, b: 0, a: 1 }
							: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
				},
			},
		},
	};
}
