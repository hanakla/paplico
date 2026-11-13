import { readFileSync } from "node:fs";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import * as fontkit from "@cantoo/fontkit";
import { describe, expect, it } from "vitest";
import type { CubicBezierSegment, FillColor } from "../../schema";
import { calculateSegmentListBounds } from "../../utils/geometry/measure/pathBounds";
import { type FontFile, FontLoader, type FontMetadata } from "./FontLoader";
import { FontManager, type ShapedGlyph } from "./FontManager";

const BASE_FONT = readFileSync(
	path.resolve(__dirname, "../../testUtils/assets/RobotoFlex.ttf"),
);
const BASE = fontkit.create(BASE_FONT) as fontkit.Font;
const UNITS_PER_EM = BASE.unitsPerEm;
const gidOf = (char: string) =>
	BASE.glyphForCodePoint(char.codePointAt(0) ?? 0)?.id ?? 0;

const RED: FillColor = {
	type: "solid",
	color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
};
const BLUE: FillColor = {
	type: "solid",
	color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
};

describe("color glyphs", () => {
	describe("SVG table", () => {
		it("should paint each element of the glyph's document in its own fill", async () => {
			const glyph = await shapeOne(
				{
					"SVG ": svgTable([
						[
							[gidOf("A")],
							glyphSvg(
								gidOf("A"),
								`<rect x="0" y="-800" width="500" height="800" fill="#f00"/>
								<rect x="100" y="-400" width="100" height="100" fill="#00f"/>`,
							),
						],
					]),
				},
				"A",
			);

			expect(glyph.colorLayers?.map((layer) => layer.fill)).toEqual([
				RED,
				BLUE,
			]);
			expect(layerBounds(glyph, 0)).toMatchObject({
				minX: 0,
				maxX: (500 / UNITS_PER_EM) * 100,
				minY: 0,
				maxY: (800 / UNITS_PER_EM) * 100,
			});
		});

		it("should read a gzip-compressed document", async () => {
			const glyph = await shapeOne(
				{
					"SVG ": svgTable([
						[
							[gidOf("A")],
							gzipSync(
								glyphSvg(
									gidOf("A"),
									`<rect width="10" height="10" fill="#f00"/>`,
								),
							),
						],
					]),
				},
				"A",
			);

			expect(glyph.colorLayers?.map((layer) => layer.fill)).toEqual([RED]);
		});

		it("should draw only the glyph's own element from a document shared by several glyphs", async () => {
			const [a, b] = [gidOf("A"), gidOf("B")];
			const shared = new TextEncoder().encode(
				`<svg xmlns="http://www.w3.org/2000/svg">
					<g id="glyph${a}"><rect width="10" height="10" fill="#f00"/></g>
					<g id="glyph${b}"><rect width="10" height="10" fill="#00f"/></g>
				</svg>`,
			);
			const glyph = await shapeOne(
				{ "SVG ": svgTable([[[a, b], shared]]) },
				"B",
			);

			expect(glyph.colorLayers?.map((layer) => layer.fill)).toEqual([BLUE]);
		});

		it("should keep the plain outline for a document that paints a stroke", async () => {
			const glyph = await shapeOne(
				{
					"SVG ": svgTable([
						[
							[gidOf("A")],
							glyphSvg(
								gidOf("A"),
								`<rect width="10" height="10" fill="#f00" stroke="#00f"/>`,
							),
						],
					]),
				},
				"A",
			);

			expect(glyph.colorLayers).toBeUndefined();
			expect(glyph.path.length).toBeGreaterThan(0);
		});
	});

	describe("COLR table", () => {
		it("should paint the layers in palette colors and leave the text color layer unpainted", async () => {
			const glyph = await shapeOne(
				{
					COLR: colrTable(gidOf("A"), [
						[gidOf("B"), 0],
						[gidOf("C"), 0xff_ff],
					]),
					CPAL: cpalTable([255, 0, 0, 255]),
				},
				"A",
			);

			expect(glyph.colorLayers?.map((layer) => layer.fill)).toEqual([
				RED,
				null,
			]);
			expect(glyph.colorLayers?.every((l) => l.segmentCount > 0)).toBe(true);
		});

		it("should keep the outline of a glyph that has no color layers", async () => {
			const glyph = await shapeOne(
				{
					COLR: colrTable(gidOf("A"), [[gidOf("B"), 0]]),
					CPAL: cpalTable([255, 0, 0, 255]),
				},
				"D",
			);

			expect(glyph.colorLayers).toBeUndefined();
			expect(glyph.path.length).toBeGreaterThan(0);
		});
	});
});

/** Shape one character with the base font plus the given tables. */
async function shapeOne(
	tables: Record<string, Uint8Array>,
	char: string,
): Promise<ShapedGlyph> {
	const fontManager = new FontManager({
		loaders: [new BytesFontLoader(withTables(BASE_FONT, tables))],
	});
	const font = await fontManager.loadFont({ loaderId: "bytes", fontId: "f" });
	if (!font) throw new Error("font failed to load");
	const [glyph] = await fontManager.shapeText(font, char, 100);
	return glyph;
}

function layerBounds(glyph: ShapedGlyph, index: number) {
	const layers = glyph.colorLayers ?? [];
	const start = layers
		.slice(0, index)
		.reduce((sum, layer) => sum + layer.segmentCount, 0);
	const segments: CubicBezierSegment[] = glyph.path.slice(
		start,
		start + layers[index].segmentCount,
	);
	return calculateSegmentListBounds(segments);
}

class BytesFontLoader extends FontLoader {
	public readonly id = "bytes";
	public readonly label = "Bytes";
	private readonly metadata = {
		family: "Color Test",
		fullName: "Color Test",
		postScriptName: "ColorTest",
		style: "Regular",
		weight: 400,
	};

	public constructor(private readonly bytes: Uint8Array) {
		super();
	}

	public async queryFonts(): Promise<FontMetadata[]> {
		return [{ ...this.metadata, loaderId: this.id, fontId: "f" }];
	}

	protected async fetchFont(): Promise<FontFile> {
		return { data: this.bytes.slice().buffer, metadata: this.metadata };
	}
}

function glyphSvg(glyphId: number, body: string): Uint8Array {
	return new TextEncoder().encode(
		`<svg xmlns="http://www.w3.org/2000/svg" id="glyph${glyphId}">${body}</svg>`,
	);
}

/** An `SVG ` table holding each document for the glyphs listed with it. */
function svgTable(entries: [number[], Uint8Array][]): Uint8Array {
	const documents = entries.map(([, doc]) => doc);
	const listLength = 2 + documents.length * 12;
	const table = new Uint8Array(
		10 + listLength + documents.reduce((n, d) => n + d.length, 0),
	);
	const view = new DataView(table.buffer);
	view.setUint32(2, 10);
	view.setUint16(10, documents.length);
	let offset = listLength;
	documents.forEach((doc, i) => {
		const [glyphIds] = entries[i];
		const at = 12 + i * 12;
		view.setUint16(at, Math.min(...glyphIds));
		view.setUint16(at + 2, Math.max(...glyphIds));
		view.setUint32(at + 4, offset);
		view.setUint32(at + 8, doc.length);
		table.set(doc, 10 + offset);
		offset += doc.length;
	});
	return table;
}

/** A COLR v0 table giving one base glyph the [glyph, palette index] layers. */
function colrTable(baseGlyph: number, layers: [number, number][]): Uint8Array {
	const table = new Uint8Array(14 + 6 + layers.length * 4);
	const view = new DataView(table.buffer);
	view.setUint16(2, 1);
	view.setUint32(4, 14);
	view.setUint32(8, 20);
	view.setUint16(12, layers.length);
	view.setUint16(14, baseGlyph);
	view.setUint16(18, layers.length);
	layers.forEach(([glyph, paletteIndex], i) => {
		view.setUint16(20 + i * 4, glyph);
		view.setUint16(22 + i * 4, paletteIndex);
	});
	return table;
}

/** A CPAL v0 table with one palette of the given [r, g, b, a] colors. */
function cpalTable(...colors: number[][]): Uint8Array {
	const table = new Uint8Array(14 + colors.length * 4);
	const view = new DataView(table.buffer);
	view.setUint16(2, colors.length);
	view.setUint16(4, 1);
	view.setUint16(6, colors.length);
	view.setUint32(8, 14);
	colors.forEach(([r, g, b, a], i) => {
		table.set([b, g, r, a], 14 + i * 4);
	});
	return table;
}

/** Rebuild an sfnt font file with extra tables added to its directory. */
function withTables(
	font: Uint8Array,
	extra: Record<string, Uint8Array>,
): Uint8Array {
	const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
	const tables = new Map<string, Uint8Array>();
	for (let i = 0; i < view.getUint16(4); i++) {
		const at = 12 + i * 16;
		const tag = new TextDecoder().decode(font.subarray(at, at + 4));
		const offset = view.getUint32(at + 8);
		tables.set(tag, font.subarray(offset, offset + view.getUint32(at + 12)));
	}
	for (const [tag, data] of Object.entries(extra)) tables.set(tag, data);

	const tags = [...tables.keys()].sort();
	const headerLength = 12 + tags.length * 16;
	const padded = (n: number) => (n + 3) & ~3;
	const out = new Uint8Array(
		headerLength +
			tags.reduce((n, tag) => n + padded(tables.get(tag)?.length ?? 0), 0),
	);
	const outView = new DataView(out.buffer);
	out.set(font.subarray(0, 4));
	outView.setUint16(4, tags.length);
	let offset = headerLength;
	tags.forEach((tag, i) => {
		const data = tables.get(tag) ?? new Uint8Array();
		const at = 12 + i * 16;
		out.set(new TextEncoder().encode(tag), at);
		outView.setUint32(at + 8, offset);
		outView.setUint32(at + 12, data.length);
		out.set(data, offset);
		offset += padded(data.length);
	});
	return out;
}
