import { describe, expect, it } from "vitest";
import type {
	AnyArtObject,
	BrushSettingsV2,
	Document,
	FillAppearance,
	Filter,
	Group,
	Path,
	Reference3DElement,
	StrokeAppearance,
	TextElement,
	TextStyle,
} from "../../../schema";
import {
	type ClassifyOptions,
	classifyElement,
	planLayerItems,
} from "./classify";

// --- Test fixtures ---

let uidCounter = 0;

const basePath = (partial: Partial<Path> = {}): Path => ({
	type: "path",
	id: `path-${uidCounter++}`,
	opacity: 1,
	blendMode: "normal",
	transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
	segments: [],
	...partial,
});

const appearance = (processor: string, params: object = {}): Filter => ({
	uid: `app-${uidCounter++}`,
	processor,
	opacity: 1,
	blendMode: "normal",
	paramData: { version: "1", params },
});

const solidFill = (): FillAppearance =>
	appearance("fill", {
		fill: { type: "solid", color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 } },
	}) as FillAppearance;

const geometricBrush = (
	partial: Partial<BrushSettingsV2> = {},
): BrushSettingsV2 => ({
	version: 2,
	engine: "geometric",
	strokeOpacity: 1,
	paintMode: "buildup",
	properties: { size: { base: 4 } },
	randomSeed: 0,
	...partial,
});

const solidStroke = (brushSettings?: BrushSettingsV2): StrokeAppearance =>
	appearance("stroke", {
		strokeColor: {
			type: "solid",
			color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
		},
		brushSettings,
	}) as StrokeAppearance;

const textStyle = (partial: Partial<TextStyle> = {}): TextStyle => ({
	fontFamily: "Test",
	fontSource: { type: "google", family: "Test", variants: [] },
	fontSize: 16,
	fontWeight: 400,
	fontStyle: "normal",
	fill: { type: "solid", color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 } },
	underline: false,
	strikethrough: false,
	letterSpacing: 0,
	baselineShift: 0,
	...partial,
});

const textElement = (partial: Partial<TextElement> = {}): TextElement => ({
	type: "text",
	id: `text-${uidCounter++}`,
	opacity: 1,
	blendMode: "normal",
	transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
	x: 0,
	y: 0,
	content: { paragraphs: [] },
	defaultStyle: textStyle(),
	layout: {
		writingMode: "horizontal-tb",
		boxWidth: "auto",
		boxHeight: "auto",
		overflow: "visible",
		wordWrap: true,
	},
	...partial,
});

const makeOptions = (elements: AnyArtObject[]): ClassifyOptions => {
	const document = {
		objects: Object.fromEntries(elements.map((el) => [el.id, el])),
	} as unknown as Document;
	return {
		document,
		filterKind: (filter) => {
			if (["zigzag", "path-offset", "pucker-bloat"].includes(filter.processor))
				return "geometry";
			if (
				["blur", "drop-shadow", "hk:posterization"].includes(filter.processor)
			)
				return "raster";
			return null;
		},
		filterReplacesElementRender: (filter) => filter.processor === "extrude3d",
		filterNeedsBackdrop: () => false,
	};
};

// --- Tests ---

describe("classifyElement", () => {
	it("should skip invisible, transparent, and guide elements", () => {
		const opts = makeOptions([]);
		expect(classifyElement(basePath({ visible: false }), opts)).toBe("skip");
		expect(classifyElement(basePath({ opacity: 0 }), opts)).toBe("skip");
		expect(classifyElement(basePath({ isGuide: true }), opts)).toBe("skip");
	});

	it("should classify a plain solid-fill path as pure", () => {
		const el = basePath({ filters: [solidFill()] });
		expect(classifyElement(el, makeOptions([el]))).toBe("pure");
	});

	it("should classify geometric solid strokes as pure and dab strokes as raster", () => {
		const opts = makeOptions([]);
		expect(
			classifyElement(
				basePath({ filters: [solidStroke(geometricBrush())] }),
				opts,
			),
		).toBe("pure");
		expect(classifyElement(basePath({ filters: [solidStroke()] }), opts)).toBe(
			"pure",
		);
		expect(
			classifyElement(
				basePath({
					filters: [solidStroke(geometricBrush({ engine: "dab" }))],
				}),
				opts,
			),
		).toBe("raster");
	});

	it("should rasterize variable-width geometric strokes", () => {
		const opts = makeOptions([]);
		expect(
			classifyElement(
				basePath({
					filters: [solidStroke(geometricBrush({ taperEnd: 0.5 }))],
				}),
				opts,
			),
		).toBe("raster");
		expect(
			classifyElement(
				basePath({
					filters: [
						solidStroke(
							geometricBrush({
								properties: {
									size: {
										base: 4,
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
							}),
						),
					],
				}),
				opts,
			),
		).toBe("raster");
	});

	it("should rasterize raster filters, backdrop filters, and render-replacing filters", () => {
		const opts = makeOptions([]);
		expect(
			classifyElement(basePath({ filters: [appearance("blur")] }), opts),
		).toBe("raster");
		expect(
			classifyElement(
				basePath({ filters: [{ ...solidFill(), applyToBackdrop: true }] }),
				opts,
			),
		).toBe("raster");
		expect(
			classifyElement(basePath({ filters: [appearance("extrude3d")] }), opts),
		).toBe("raster");
	});

	it("should ignore disabled filters", () => {
		const el = basePath({
			filters: [{ ...appearance("blur"), enabled: false }, solidFill()],
		});
		expect(classifyElement(el, makeOptions([el]))).toBe("pure");
	});

	it("should mark geometry filters, corner radii, text and compound paths as bake", () => {
		const opts = makeOptions([]);
		expect(
			classifyElement(
				basePath({ filters: [appearance("zigzag"), solidFill()] }),
				opts,
			),
		).toBe("bake");
		expect(
			classifyElement(
				basePath({
					segments: [
						{
							cp1: { x: 0, y: 0 },
							cp2: { x: 0, y: 0 },
							end: { x: 0, y: 0 },
							startTiltX: 0,
							startTiltY: 0,
							endTiltX: 0,
							endTiltY: 0,
							startDeltaTime: 0,
							endDeltaTime: 0,
							isMoved: true,
							cornerRadius: 4,
						},
					],
				}),
				opts,
			),
		).toBe("bake");
		expect(classifyElement(textElement(), opts)).toBe("bake");
		expect(
			classifyElement(
				{ ...basePath(), type: "compound-path", sources: [] } as AnyArtObject,
				opts,
			),
		).toBe("bake");
	});

	it("should rasterize free/mesh gradient fills and non-solid strokes", () => {
		const opts = makeOptions([]);
		expect(
			classifyElement(
				basePath({
					filters: [
						appearance("fill", {
							fill: {
								type: "free",
								stops: [
									{
										id: "s1",
										x: 0.5,
										y: 0.5,
										color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
									},
								],
							},
						}),
					],
				}),
				opts,
			),
		).toBe("raster");
		expect(
			classifyElement(
				basePath({
					filters: [
						appearance("stroke", {
							strokeColor: {
								type: "stroke-gradient",
								gradient: {
									type: "linear",
									x1: 0,
									y1: 0,
									x2: 1,
									y2: 0,
									stops: [],
								},
								mode: "within",
							},
						}),
					],
				}),
				opts,
			),
		).toBe("raster");
	});

	it("should keep pattern fills pure", () => {
		const el = basePath({
			filters: [
				appearance("fill", {
					fill: {
						type: "pattern",
						defId: "def-1",
						scaleX: 1,
						scaleY: 1,
						rotation: 0,
						offsetX: 0,
						offsetY: 0,
					},
				}),
			],
		});
		expect(classifyElement(el, makeOptions([el]))).toBe("pure");
	});

	it("should rasterize alpha-lock, erase masks, and variable stroke widths", () => {
		const opts = makeOptions([]);
		expect(
			classifyElement(basePath({ compositionMode: "alpha-lock" }), opts),
		).toBe("raster");
		expect(classifyElement(basePath({ eraseMasks: [{} as never] }), opts)).toBe(
			"raster",
		);
		expect(
			classifyElement(
				basePath({ strokeWidths: [{ t: 0, side1: 1, side2: 1 }] }),
				opts,
			),
		).toBe("raster");
	});

	it("should skip reference3d unless includeInExport is set", () => {
		const opts = makeOptions([]);
		const ref: Reference3DElement = {
			type: "reference3d",
			id: `ref-${uidCounter++}`,
			opacity: 1,
			blendMode: "normal",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			sceneId: "scene",
			camera: {} as Reference3DElement["camera"],
			x: 0,
			y: 0,
			width: 10,
			height: 10,
			displayMode: "flat",
		};
		expect(classifyElement(ref, opts)).toBe("skip");
		expect(classifyElement({ ...ref, includeInExport: true }, opts)).toBe(
			"raster",
		);
	});

	it("should rasterize groups with group appearances or non-path clip sources", () => {
		const image: AnyArtObject = {
			type: "image",
			id: `image-${uidCounter++}`,
			opacity: 1,
			blendMode: "normal",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			fileUid: "f",
			x: 0,
			y: 0,
			width: 10,
			height: 10,
		};
		const clipPath = basePath();
		const group = (partial: Partial<Group>): Group => ({
			type: "group",
			id: `group-${uidCounter++}`,
			opacity: 1,
			blendMode: "normal",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			childIds: [],
			...partial,
		});

		const plainGroup = group({});
		expect(classifyElement(plainGroup, makeOptions([plainGroup]))).toBe("pure");

		const appearanceGroup = group({ filters: [solidFill()] });
		expect(
			classifyElement(appearanceGroup, makeOptions([appearanceGroup])),
		).toBe("raster");

		const pathClipGroup = group({ clipPathId: clipPath.id });
		expect(
			classifyElement(pathClipGroup, makeOptions([pathClipGroup, clipPath])),
		).toBe("pure");

		const imageClipGroup = group({ clipPathId: image.id });
		expect(
			classifyElement(imageClipGroup, makeOptions([imageClipGroup, image])),
		).toBe("raster");
	});

	it("should ignore invisible appearances instead of rasterizing", () => {
		// A transparent dab stroke beside a clean gradient fill must not drag
		// the element into rasterization.
		const invisibleDabStroke = appearance("stroke", {
			strokeColor: {
				type: "solid",
				color: { type: "rgb", r: 0, g: 0, b: 0, a: 0 },
			},
			brushSettings: geometricBrush({ engine: "dab" }),
		});
		const gradientFill = appearance("fill", {
			fill: {
				type: "linear",
				x1: 0,
				y1: 0,
				x2: 1,
				y2: 0,
				stops: [
					{
						offset: 0,
						color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
						midpoint: 0.5,
					},
					{
						offset: 1,
						color: { type: "rgb", r: 1, g: 1, b: 1, a: 1 },
						midpoint: 0.5,
					},
				],
			},
		});
		const el = basePath({ filters: [gradientFill, invisibleDabStroke] });
		expect(classifyElement(el, makeOptions([el]))).toBe("pure");

		// A zero-width dab stroke is equally invisible.
		const zeroWidthDab = appearance("stroke", {
			strokeColor: {
				type: "solid",
				color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
			},
			brushSettings: geometricBrush({
				engine: "dab",
				properties: { size: { base: 0 } },
			}),
		});
		const el2 = basePath({ filters: [gradientFill, zeroWidthDab] });
		expect(classifyElement(el2, makeOptions([el2]))).toBe("pure");

		// A fully transparent free-gradient fill must not force raster either.
		const invisibleFreeFill = appearance("fill", {
			fill: { type: "free", stops: [] },
		});
		const el3 = basePath({ filters: [invisibleFreeFill, solidFill()] });
		expect(classifyElement(el3, makeOptions([el3]))).toBe("pure");
	});

	it("should rasterize text whose runs use non-vectorizable paint", () => {
		const opts = makeOptions([]);
		const gradientStrokeText = textElement({
			defaultStyle: textStyle({
				stroke: {
					type: "stroke-gradient",
					gradient: { type: "linear", x1: 0, y1: 0, x2: 1, y2: 0, stops: [] },
					mode: "within",
				},
			}),
		});
		expect(classifyElement(gradientStrokeText, opts)).toBe("raster");
	});

	it("should rasterize appearances with non-normal blend modes", () => {
		const el = basePath({
			filters: [{ ...solidFill(), blendMode: "multiply" }],
		});
		expect(classifyElement(el, makeOptions([el]))).toBe("raster");
	});

	it("should rasterize owners whose mask content needs rasterization", () => {
		const maskContent = basePath({ filters: [appearance("blur")] });
		const owner = basePath({
			filters: [solidFill()],
			mask: { elementIds: [maskContent.id] },
		});
		expect(classifyElement(owner, makeOptions([owner, maskContent]))).toBe(
			"raster",
		);

		const vectorMask = basePath({ filters: [solidFill()] });
		const vectorOwner = basePath({
			filters: [solidFill()],
			mask: { elementIds: [vectorMask.id] },
		});
		expect(
			classifyElement(vectorOwner, makeOptions([vectorOwner, vectorMask])),
		).toBe("pure");
	});

	it("should rasterize pattern fills whose def tile contains raster content", () => {
		const tileRaster = basePath({ filters: [appearance("blur")] });
		const el = basePath({
			filters: [
				appearance("fill", {
					fill: {
						type: "pattern",
						defId: "def-1",
						scaleX: 1,
						scaleY: 1,
						rotation: 0,
						offsetX: 0,
						offsetY: 0,
					},
				}),
			],
		});
		const opts = makeOptions([el, tileRaster]);
		(opts.document as { defs?: Document["defs"] }).defs = {
			"def-1": {
				id: "def-1",
				kind: "pattern",
				rootElementIds: [tileRaster.id],
				tile: { width: 10, height: 10 },
			},
		};
		expect(classifyElement(el, opts)).toBe("raster");
	});
});

describe("planLayerItems", () => {
	it("should merge consecutive normal-blend raster elements into one run", () => {
		const vector = basePath({ filters: [solidFill()] });
		const rasterA = basePath({ filters: [appearance("blur")] });
		const rasterB = basePath({ filters: [appearance("blur")] });
		const opts = makeOptions([vector, rasterA, rasterB]);

		const items = planLayerItems([rasterA.id, rasterB.id, vector.id], opts);
		expect(items).toEqual([
			{ kind: "raster", elementIds: [rasterA.id, rasterB.id] },
			{ kind: "vector", elementId: vector.id, class: "pure" },
		]);
	});

	it("should isolate non-normal-blend raster elements as singleton runs", () => {
		const rasterA = basePath({ filters: [appearance("blur")] });
		const multiply = basePath({
			filters: [appearance("blur")],
			blendMode: "multiply",
		});
		const rasterB = basePath({ filters: [appearance("blur")] });
		const opts = makeOptions([rasterA, multiply, rasterB]);

		const items = planLayerItems([rasterA.id, multiply.id, rasterB.id], opts);
		expect(items).toEqual([
			{ kind: "raster", elementIds: [rasterA.id] },
			{ kind: "raster", elementIds: [multiply.id], blendMode: "multiply" },
			{ kind: "raster", elementIds: [rasterB.id] },
		]);
	});

	it("should swallow overlapping items below a backdrop-dependent element", () => {
		const vector = basePath({ filters: [solidFill()] });
		const raster = basePath({ filters: [appearance("blur")] });
		const locked = basePath({ compositionMode: "alpha-lock" });
		const above = basePath({ filters: [solidFill()] });
		const opts = makeOptions([vector, raster, locked, above]);

		const items = planLayerItems(
			[vector.id, raster.id, locked.id, above.id],
			opts,
		);
		expect(items).toEqual([
			{ kind: "raster", elementIds: [vector.id, raster.id, locked.id] },
			{ kind: "vector", elementId: above.id, class: "pure" },
		]);
	});

	it("should keep non-overlapping items out of a backdrop swallow", () => {
		// A blended vector far away from the alpha-locked element must stay
		// vector — only backdrop-feeding overlaps get merged into the chunk.
		const farBlend = basePath({
			filters: [solidFill()],
			blendMode: "multiply",
			transform: { x: 500, y: 500, rotation: 0, scaleX: 1, scaleY: 1 },
		});
		const underLock = basePath({ filters: [solidFill()] });
		const locked = basePath({ compositionMode: "alpha-lock" });
		const opts = makeOptions([farBlend, underLock, locked]);

		const items = planLayerItems([farBlend.id, underLock.id, locked.id], opts);
		expect(items).toEqual([
			{ kind: "vector", elementId: farBlend.id, class: "pure" },
			{ kind: "raster", elementIds: [underLock.id, locked.id] },
		]);
	});

	it("should skip missing and skipped elements", () => {
		const hidden = basePath({ visible: false });
		const vector = basePath({ filters: [solidFill()] });
		const opts = makeOptions([hidden, vector]);
		expect(planLayerItems(["missing-id", hidden.id, vector.id], opts)).toEqual([
			{ kind: "vector", elementId: vector.id, class: "pure" },
		]);
	});

	it("should not absorb elements above into a blended backdrop run", () => {
		const locked = basePath({
			compositionMode: "alpha-lock",
			blendMode: "multiply",
		});
		const rasterAbove = basePath({ filters: [appearance("blur")] });
		const opts = makeOptions([locked, rasterAbove]);
		expect(planLayerItems([locked.id, rasterAbove.id], opts)).toEqual([
			{ kind: "raster", elementIds: [locked.id], blendMode: "multiply" },
			{ kind: "raster", elementIds: [rasterAbove.id] },
		]);
	});
});
