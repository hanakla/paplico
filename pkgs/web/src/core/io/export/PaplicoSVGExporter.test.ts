import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderOrchestrator } from "../../renderer/RenderOrchestrator";
import type {
	AnyArtObject,
	Document,
	FillAppearance,
	Filter,
	Group,
	Layer,
	Path,
	PathSegment,
	TextElement,
	TextStyle,
} from "../../schema";
import { PaplicoSVGExporter } from "./PaplicoSVGExporter";
import { renderRasterChunk } from "./svg/rasterChunk";

vi.mock("./svg/rasterChunk", () => ({
	renderRasterChunk: vi.fn(),
}));

// --- Fixtures ---

const seg = (partial: Partial<PathSegment>): PathSegment => ({
	cp1: { x: 0, y: 0 },
	cp2: { x: 0, y: 0 },
	end: { x: 0, y: 0 },
	startTiltX: 0,
	startTiltY: 0,
	endTiltX: 0,
	endTiltY: 0,
	startDeltaTime: 0,
	endDeltaTime: 0,
	isMoved: false,
	...partial,
});

const squareSegments = (): PathSegment[] => [
	seg({ start: { x: -10, y: 10 }, end: { x: 10, y: 10 }, isMoved: true }),
	seg({ end: { x: 10, y: -10 } }),
	seg({ end: { x: -10, y: -10 }, isClosed: true }),
];

const solidFill = (r: number, g: number, b: number): FillAppearance => ({
	uid: `fill-${r}-${g}-${b}`,
	processor: "fill",
	opacity: 1,
	blendMode: "normal",
	paramData: {
		version: "1",
		params: { fill: { type: "solid", color: { type: "rgb", r, g, b, a: 1 } } },
	},
});

const path = (id: string, partial: Partial<Path> = {}): Path => ({
	type: "path",
	id,
	opacity: 1,
	blendMode: "normal",
	transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
	segments: squareSegments(),
	...partial,
});

const makeDocument = (
	objects: AnyArtObject[],
	layers: Partial<Layer>[],
	rasterizationDpi?: number,
): Document =>
	({
		id: "doc1",
		objects: Object.fromEntries(objects.map((o) => [o.id, o])),
		layers: layers.map((layer, i) => ({
			id: `layer-${i}`,
			name: `Layer ${i}`,
			visible: true,
			locked: false,
			opacity: 1,
			elementIds: [],
			...layer,
		})),
		viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
		files: [],
		artboards: [
			{
				id: "artboard1",
				name: "Test Artboard",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
			},
		],
		brushPresets: [],
		rasterizationDpi,
	}) as unknown as Document;

const makeMockRenderer = (): RenderOrchestrator => {
	const getFilterHandler = (processor: string) => {
		if (processor === "blur") return { postProcess: () => {} };
		if (processor.startsWith("svg:")) {
			return {
				postProcess: () => {},
				// An offset reaches as far as it moves; other primitives get a
				// flat margin so region sizes stay easy to assert.
				getExpansionMargin: (filter: Filter) => {
					if (filter.processor !== "svg:offset") return 4;
					const { dx, dy } = filter.paramData.params as {
						dx: number;
						dy: number;
					};
					return Math.max(Math.abs(dx), Math.abs(dy));
				},
			};
		}
		return undefined;
	};
	return {
		getTextRenderer: () => null,
		getFilterHandler,
		calculateFilterExpansion: (filters: Filter[]) =>
			Math.max(
				0,
				...filters.map(
					(filter) =>
						getFilterHandler(filter.processor)?.getExpansionMargin?.(filter) ??
						0,
				),
			),
		ensureTextDocumentResolver: () => () => {},
	} as unknown as RenderOrchestrator;
};

describe("PaplicoSVGExporter", () => {
	beforeEach(() => {
		vi.mocked(renderRasterChunk).mockReset();
		vi.mocked(renderRasterChunk).mockResolvedValue({
			dataUrl: "data:image/png;base64,CHUNK",
			bounds: { minX: -5, minY: -5, maxX: 5, maxY: 5, width: 10, height: 10 },
		});
	});

	it("should serialize a pure solid-fill path as an SVG path in viewBox coordinates", async () => {
		const doc = makeDocument(
			[path("p1", { filters: [solidFill(1, 0, 0)] })],
			[{ elementIds: ["p1"] }],
		);
		const exporter = new PaplicoSVGExporter(makeMockRenderer(), () => doc);
		const result = await exporter.renderArtboardToSVG("artboard1");

		expect(result).not.toBeNull();
		const svg = result?.svg ?? "";
		expect(svg).toContain(`viewBox="0 0 100 100"`);
		// World square (-10..10, Y up) → SVG square (40..60, Y down)
		expect(svg).toContain(
			`<path d="M 40 40 L 60 40 L 60 60 L 40 60 Z" fill="#ff0000"/>`,
		);
	});

	it("should emit the default white background rect and omit it when transparent", async () => {
		const doc = makeDocument([], []);
		const exporter = new PaplicoSVGExporter(makeMockRenderer(), () => doc);

		const withBg = await exporter.renderArtboardToSVG("artboard1");
		expect(withBg?.svg).toContain(
			`<rect x="0" y="0" width="100" height="100" fill="#ffffff"/>`,
		);

		const transparent = await exporter.renderArtboardToSVG("artboard1", {
			backgroundColor: { r: 0, g: 0, b: 0, a: 0 },
		});
		expect(transparent?.svg).not.toContain("<rect");
	});

	it("should render raster runs as data-URL images at the document rasterization scale", async () => {
		const doc = makeDocument(
			[
				path("blurred", {
					filters: [{ ...solidFill(0, 0, 0), uid: "b" }, blurFilter()],
				}),
			],
			[{ elementIds: ["blurred"] }],
			144,
		);
		const exporter = new PaplicoSVGExporter(makeMockRenderer(), () => doc);
		const result = await exporter.renderArtboardToSVG("artboard1");

		// Chunk bounds world (-5..5) → SVG top-left (45, 45), 10×10 world units.
		expect(result?.svg).toContain(
			`<image x="45" y="45" width="10" height="10" preserveAspectRatio="none" href="data:image/png;base64,CHUNK"/>`,
		);
		const call = vi.mocked(renderRasterChunk).mock.calls[0];
		expect(call[2]).toEqual(["blurred"]);
		// scale = rasterizationDpi / 72 = 2
		expect(call[4]).toBe(2);
	});

	it("should skip invisible and transient layers", async () => {
		const doc = makeDocument(
			[
				path("p1", { filters: [solidFill(1, 0, 0)] }),
				path("p2", { filters: [solidFill(0, 1, 0)] }),
			],
			[
				{ elementIds: ["p1"], visible: false },
				{ elementIds: ["p2"], transientKind: "pattern-edit" },
			],
		);
		const exporter = new PaplicoSVGExporter(makeMockRenderer(), () => doc);
		const result = await exporter.renderArtboardToSVG("artboard1");
		expect(result?.svg).not.toContain("<path");
	});

	it("should carry layer opacity and blend mode onto the layer group", async () => {
		const doc = makeDocument(
			[path("p1", { filters: [solidFill(1, 0, 0)] })],
			[{ elementIds: ["p1"], opacity: 0.5, blendMode: "multiply" }],
		);
		const exporter = new PaplicoSVGExporter(makeMockRenderer(), () => doc);
		const result = await exporter.renderArtboardToSVG("artboard1");
		expect(result?.svg).toContain(
			`<g opacity="0.5" style="mix-blend-mode:multiply">`,
		);
	});

	it("should outline text through the text renderer with run styles", async () => {
		const textEl = {
			type: "text",
			id: "t1",
			opacity: 1,
			blendMode: "normal",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			x: 0,
			y: 0,
			content: {
				paragraphs: [
					{
						runs: [{ text: "A", style: runStyle() }],
						alignment: "left",
						lineHeight: 1,
						indent: 0,
						spacing: { before: 0, after: 0 },
					},
				],
			},
			defaultStyle: runStyle(),
			layout: {
				writingMode: "horizontal-tb",
				boxWidth: "auto",
				boxHeight: "auto",
				overflow: "visible",
				wordWrap: true,
			},
		} satisfies TextElement;

		const glyph: Path = path("glyph", {
			segments: [
				seg({ start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, isMoved: true }),
				seg({ end: { x: 5, y: 10 }, isClosed: true }),
			],
		});
		const renderer = {
			getTextRenderer: () => ({
				textElementToOutlinedPaths: vi.fn(async () => ({
					outlinedPaths: [{ path: glyph, runIndex: 0, paragraphIndex: 0 }],
					bounds: {
						minX: 0,
						minY: 0,
						maxX: 10,
						maxY: 10,
						width: 10,
						height: 10,
					},
				})),
				getFlowHead: (el: TextElement) => el,
			}),
			getFilterHandler: () => undefined,
			ensureTextDocumentResolver: () => () => {},
		} as unknown as RenderOrchestrator;

		const doc = makeDocument([textEl], [{ elementIds: ["t1"] }]);
		const exporter = new PaplicoSVGExporter(renderer, () => doc);
		const result = await exporter.renderArtboardToSVG("artboard1");

		// Glyph world (0,0)-(10,0)-(5,10) → SVG (50,50)-(60,50)-(55,40)
		expect(result?.svg).toContain(
			`<path d="M 50 50 L 60 50 L 55 40 Z" fill="#0000ff"/>`,
		);
	});

	it("should rotate gradients with the element (local-space evaluation)", async () => {
		const rotated = path("g1", {
			transform: { x: 0, y: 0, rotation: Math.PI / 2, scaleX: 1, scaleY: 1 },
			filters: [
				{
					uid: "grad-fill",
					processor: "fill",
					opacity: 1,
					blendMode: "normal",
					paramData: {
						version: "1",
						params: {
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
						},
					},
				} as FillAppearance,
			],
		});
		const doc = makeDocument([rotated], [{ elementIds: ["g1"] }]);
		const exporter = new PaplicoSVGExporter(makeMockRenderer(), () => doc);
		const result = await exporter.renderArtboardToSVG("artboard1");

		// A 90° rotation must land in the gradientTransform's off-diagonal
		// terms: matrix(a b c d ...) with a≈0 — the gradient turns with the
		// element instead of staying world-axis aligned.
		const match = result?.svg.match(/gradientTransform="matrix\(([^)]+)\)"/);
		expect(match).not.toBeNull();
		const [a, b] = (match?.[1] ?? "").split(" ").map(Number);
		expect(Math.abs(a)).toBeLessThan(1e-6);
		expect(Math.abs(b)).toBeGreaterThan(1);
	});

	it("should scale geometric stroke widths with a uniform transform", async () => {
		const stroked = path("s1", {
			transform: { x: 0, y: 0, rotation: 0, scaleX: 2, scaleY: 2 },
			filters: [
				{
					uid: "stroke-1",
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
								properties: { size: { base: 4 } },
								randomSeed: 0,
							},
						},
					},
				} as Filter,
			],
		});
		const doc = makeDocument([stroked], [{ elementIds: ["s1"] }]);
		const exporter = new PaplicoSVGExporter(makeMockRenderer(), () => doc);
		const result = await exporter.renderArtboardToSVG("artboard1");

		expect(result?.svg).toContain(`stroke-width="8"`);
	});

	it("should merge a fill and the stroke above it into a single <path>", async () => {
		const filled = path("fs1", {
			filters: [
				solidFill(1, 0, 0),
				{
					uid: "stroke-fs1",
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
								properties: { size: { base: 4 } },
								randomSeed: 0,
							},
						},
					},
				} as Filter,
			],
		});
		const doc = makeDocument([filled], [{ elementIds: ["fs1"] }]);
		const exporter = new PaplicoSVGExporter(makeMockRenderer(), () => doc);
		const result = await exporter.renderArtboardToSVG("artboard1");

		expect(result?.svg.match(/<path /g)).toHaveLength(1);
		expect(result?.svg).toMatch(/<path [^>]*fill="[^"]+"[^>]*stroke="[^"]+"/);
	});

	it("should merge a stroke below its fill via paint-order", async () => {
		const stroked = path("sf1", {
			filters: [
				{
					uid: "stroke-sf1",
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
								properties: { size: { base: 4 } },
								randomSeed: 0,
							},
						},
					},
				} as Filter,
				solidFill(1, 0, 0),
			],
		});
		const doc = makeDocument([stroked], [{ elementIds: ["sf1"] }]);
		const exporter = new PaplicoSVGExporter(makeMockRenderer(), () => doc);
		const result = await exporter.renderArtboardToSVG("artboard1");

		expect(result?.svg.match(/<path /g)).toHaveLength(1);
		expect(result?.svg).toContain(`paint-order="stroke"`);
	});

	it("should distribute element opacity into shape paints (non-isolated)", async () => {
		const el = path("op1", {
			opacity: 0.5,
			filters: [solidFill(1, 0, 0)],
		});
		const doc = makeDocument([el], [{ elementIds: ["op1"] }]);
		const exporter = new PaplicoSVGExporter(makeMockRenderer(), () => doc);
		const result = await exporter.renderArtboardToSVG("artboard1");

		expect(result?.svg).toContain(`fill-opacity="0.5"`);
		expect(result?.svg).not.toContain(`<g opacity="0.5"`);
	});

	it("should hide an element whose enabled mask has no visible content", async () => {
		const hiddenByMask = path("m1", {
			filters: [solidFill(1, 0, 0)],
			mask: { elementIds: [] },
		});
		const doc = makeDocument([hiddenByMask], [{ elementIds: ["m1"] }]);
		const exporter = new PaplicoSVGExporter(makeMockRenderer(), () => doc);
		const result = await exporter.renderArtboardToSVG("artboard1");

		// schema: "Empty = the owner is fully hidden"
		expect(result?.svg).not.toContain("#ff0000");
	});

	it("should emit an sRGB invert filter for inverted masks", async () => {
		const maskShape = path("mask-shape", { filters: [solidFill(1, 1, 1)] });
		const masked = path("m2", {
			filters: [solidFill(1, 0, 0)],
			mask: { elementIds: ["mask-shape"], inverted: true },
		});
		const doc = makeDocument([masked, maskShape], [{ elementIds: ["m2"] }]);
		const exporter = new PaplicoSVGExporter(makeMockRenderer(), () => doc);
		const result = await exporter.renderArtboardToSVG("artboard1");

		expect(result?.svg).toContain(`mask="url(#mask0)"`);
		expect(result?.svg).toContain(`color-interpolation-filters="sRGB"`);
		expect(result?.svg).toContain(`fill="#ffffff"`);
	});

	it("should omit vector elements that lie outside the artboard", async () => {
		const outside = path("outside", {
			filters: [solidFill(1, 0, 0)],
			transform: { x: 500, y: 500, rotation: 0, scaleX: 1, scaleY: 1 },
		});
		const partial = path("partial", {
			filters: [solidFill(0, 1, 0)],
			// World square (-10..10) shifted to straddle the right artboard edge.
			transform: { x: 55, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		});
		const doc = makeDocument(
			[outside, partial],
			[{ elementIds: ["outside", "partial"] }],
		);
		const exporter = new PaplicoSVGExporter(makeMockRenderer(), () => doc);
		const result = await exporter.renderArtboardToSVG("artboard1");

		expect(result?.svg).not.toContain("#ff0000");
		expect(result?.svg).toContain("#00ff00");
	});

	describe("native SVG filter primitives", () => {
		it("should emit one sRGB <filter> per element over its expanded bounds", async () => {
			const el = path("svg1", {
				filters: [solidFill(1, 0, 0), svgOffset("previous"), svgFlood()],
			});
			const doc = makeDocument([el], [{ elementIds: ["svg1"] }]);
			const exporter = new PaplicoSVGExporter(makeMockRenderer(), () => doc);
			const result = await exporter.renderArtboardToSVG("artboard1");
			const svg = result?.svg ?? "";

			// Square -10..10 expanded by the margin 4 → 28x28 region.
			expect(svg).toContain(
				`<filter id="filter0" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="0" y="0" width="28" height="28" color-interpolation-filters="sRGB">`,
			);
			expect(svg).toContain(
				`<feOffset in="SourceGraphic" dx="4" dy="4" result="s0"/>`,
			);
			expect(svg).toContain(
				`<feFlood flood-color="#0000ff" flood-opacity="1" result="s1"/>`,
			);
			expect(svg).not.toContain("<image");
			// Region top-left is world (-14, 14) → viewBox (36, 36) on the 100x100 artboard.
			expect(svg).toContain(
				`<g transform="translate(36 36)" filter="url(#filter0)">`,
			);
			expect(svg).toContain(`<g transform="translate(-36 -36)">`);
		});

		it("should keep a group's out-of-view children that its filter moves into view", async () => {
			// The child sits right of the artboard; the group's offset pulls it back in.
			const child = path("far", {
				filters: [solidFill(1, 0, 0)],
				transform: { x: 100, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			});
			const group = {
				type: "group",
				id: "g1",
				opacity: 1,
				blendMode: "normal",
				transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				childIds: ["far"],
				filters: [
					{
						...svgOffset("previous"),
						paramData: {
							version: "1",
							params: { in: "previous", dx: -100, dy: 0 },
						},
					},
				],
			} as unknown as Group;
			const doc = makeDocument([group, child], [{ elementIds: ["g1"] }]);
			const exporter = new PaplicoSVGExporter(makeMockRenderer(), () => doc);
			const result = await exporter.renderArtboardToSVG("artboard1");
			const svg = result?.svg ?? "";

			expect(svg).toContain(`<feOffset in="SourceGraphic" dx="-100" dy="0"`);
			expect(svg).toContain("#ff0000");
		});

		it("should apply the mask and element opacity after the filter", async () => {
			const maskShape = path("mask-shape", { filters: [solidFill(1, 1, 1)] });
			const el = path("svg2", {
				opacity: 0.5,
				filters: [solidFill(1, 0, 0), svgOffset("SourceAlpha")],
				mask: { elementIds: ["mask-shape"] },
			});
			const doc = makeDocument([el, maskShape], [{ elementIds: ["svg2"] }]);
			const exporter = new PaplicoSVGExporter(makeMockRenderer(), () => doc);
			const result = await exporter.renderArtboardToSVG("artboard1");
			const svg = result?.svg ?? "";

			expect(svg).toContain(
				`<g opacity="0.5" mask="url(#mask0)">\n\t\t\t<g transform="translate(36 36)" filter="url(#filter0)">`,
			);
			expect(svg).not.toContain(`fill-opacity="0.5"`);
			expect(svg).toContain(`<feOffset in="SourceAlpha"`);
		});

		it("should still rasterize when a non-native raster filter joins the chain", async () => {
			const el = path("svg3", {
				filters: [solidFill(1, 0, 0), svgOffset("previous"), blurFilter()],
			});
			const doc = makeDocument([el], [{ elementIds: ["svg3"] }]);
			const exporter = new PaplicoSVGExporter(makeMockRenderer(), () => doc);
			const result = await exporter.renderArtboardToSVG("artboard1");

			expect(result?.svg).toContain("<image");
			expect(result?.svg).not.toContain("<filter");
		});
	});

	it("should return null for an unknown artboard", async () => {
		const doc = makeDocument([], []);
		const exporter = new PaplicoSVGExporter(makeMockRenderer(), () => doc);
		expect(await exporter.renderArtboardToSVG("nope")).toBeNull();
	});
});

// --- Helpers ---

function svgOffset(input: string): Filter {
	return {
		uid: "svg-offset-1",
		processor: "svg:offset",
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: { in: input, dx: 4, dy: -4 } },
	};
}

function svgFlood(): Filter {
	return {
		uid: "svg-flood-1",
		processor: "svg:flood",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: { color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 }, opacity: 1 },
		},
	};
}

function blurFilter(): Filter {
	return {
		uid: "blur-1",
		processor: "blur",
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: {} },
	};
}

function runStyle(): TextStyle {
	return {
		fontFamily: "Test",
		fontSource: { type: "google", family: "Test", variants: [] },
		fontSize: 16,
		fontWeight: 400,
		fontStyle: "normal",
		fill: { type: "solid", color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 } },
		underline: false,
		strikethrough: false,
		letterSpacing: 0,
		baselineShift: 0,
	};
}
