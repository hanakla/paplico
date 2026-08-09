import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderOrchestrator } from "../../renderer/RenderOrchestrator";
import type {
	AnyArtObject,
	Document,
	FillAppearance,
	Filter,
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

const makeMockRenderer = (): RenderOrchestrator =>
	({
		getTextRenderer: () => null,
		getFilterHandler: (processor: string) =>
			processor === "blur" ? { postProcess: () => {} } : undefined,
	}) as unknown as RenderOrchestrator;

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
		} as unknown as RenderOrchestrator;

		const doc = makeDocument([textEl], [{ elementIds: ["t1"] }]);
		const exporter = new PaplicoSVGExporter(renderer, () => doc);
		const result = await exporter.renderArtboardToSVG("artboard1");

		// Glyph world (0,0)-(10,0)-(5,10) → SVG (50,50)-(60,50)-(55,40)
		expect(result?.svg).toContain(
			`<path d="M 50 50 L 60 50 L 55 40 Z" fill="#0000ff"/>`,
		);
	});

	it("should return null for an unknown artboard", async () => {
		const doc = makeDocument([], []);
		const exporter = new PaplicoSVGExporter(makeMockRenderer(), () => doc);
		expect(await exporter.renderArtboardToSVG("nope")).toBeNull();
	});
});

// --- Helpers ---

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
