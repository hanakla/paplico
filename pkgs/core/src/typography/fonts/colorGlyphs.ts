/**
 * Reads the colored layers of color-font glyphs (OpenType `SVG ` and COLR v0
 * tables). fontkit exposes neither table in a usable form: it ignores `SVG `,
 * and its COLR glyphs have no outline and drop the layers drawn in the text
 * color, so both are read from the font's tables here.
 */

import type { Font, PathCommand } from "@cantoo/fontkit";
import { localAppearances } from "../../document/appearancePresets";
import type {
	Color,
	CubicBezierSegment,
	FillAppearance,
	FillColor,
	Group,
	Path,
} from "../../schema";
import { parseSvgToArtObjects } from "../../utils/svgImport";

/** One colored layer of a color glyph. */
export interface GlyphColorLayer {
	/** Number of consecutive segments of the glyph path this layer covers. */
	segmentCount: number;
	/** Paint of the layer, or null to paint it with the text's own fill. */
	fill: FillColor | null;
}

/** A layer as read from the font, before the glyph path concatenates it. */
export interface ColorGlyphLayerSource<TOutline> {
	outline: TOutline;
	fill: FillColor | null;
}

/** COLR palette index that stands for the text's own color. */
const FOREGROUND_PALETTE_INDEX = 0xff_ff;

/**
 * The layers of a COLR v0 glyph, bottom first, or null when the glyph has no
 * COLR record (COLR v1 glyphs included). `outline` is the layer glyph's path
 * in font units.
 */
export function readColrLayers(
	font: Font,
	glyphId: number,
): ColorGlyphLayerSource<{ commands: PathCommand[] } | null>[] | null {
	const tables = font as unknown as InternalFont;
	const colr = tables.COLR;
	const cpal = tables.CPAL;
	const record = colr?.baseGlyphRecord?.find((r) => r.gid === glyphId);
	if (!colr || !cpal || !record) return null;

	const paletteStart = cpal.colorRecordIndices[0] ?? 0;
	return colr.layerRecords
		.slice(record.firstLayerIndex, record.firstLayerIndex + record.numLayers)
		.map((layer) => {
			const color =
				layer.paletteIndex === FOREGROUND_PALETTE_INDEX
					? null
					: cpal.colorRecords[paletteStart + layer.paletteIndex];
			return {
				outline: tables._getBaseGlyph(layer.gid)?.path ?? null,
				fill: color
					? {
							type: "solid",
							color: {
								type: "rgb",
								r: color.red / 255,
								g: color.green / 255,
								b: color.blue / 255,
								a: color.alpha / 255,
							},
						}
					: null,
			};
		});
}

/** The outline fontkit draws for a glyph of a COLR font, which it leaves empty. */
export function readColrBaseOutline(
	font: Font,
	glyphId: number,
): { commands: PathCommand[] } | null {
	const tables = font as unknown as InternalFont;
	if (!tables.COLR) return null;
	return tables._getBaseGlyph(glyphId)?.path ?? null;
}

/**
 * Reader of a font's `SVG ` table, or null when the font has none. The reader
 * resolves a glyph's layers bottom first with em-normalized, y-up segments,
 * or null when the table has no document for the glyph or the document
 * paints something a layer cannot hold.
 */
export function createSvgGlyphReader(
	font: Font,
):
	| ((
			glyphId: number,
	  ) => Promise<ColorGlyphLayerSource<CubicBezierSegment[]>[] | null>)
	| null {
	const records = readSvgDocumentRecords(font);
	if (!records) return null;

	const documents = new Map<number, Promise<string>>();
	return async (glyphId) => {
		const record = records.entries.find(
			(r) => r.startGlyphId <= glyphId && glyphId <= r.endGlyphId,
		);
		if (!record) return null;

		let document = documents.get(record.offset);
		if (!document) {
			document = decodeSvgDocument(
				records.table.subarray(record.offset, record.offset + record.length),
			);
			documents.set(record.offset, document);
		}
		return svgGlyphLayers(await document, glyphId, font.unitsPerEm);
	};
}

/** fontkit internals this module reads; they are not in its public types. */
interface InternalFont {
	COLR?: {
		baseGlyphRecord?: {
			gid: number;
			firstLayerIndex: number;
			numLayers: number;
		}[];
		layerRecords: { gid: number; paletteIndex: number }[];
	};
	CPAL?: {
		colorRecords: { red: number; green: number; blue: number; alpha: number }[];
		colorRecordIndices: number[];
	};
	directory: { tables: Record<string, { length: number } | undefined> };
	_decompress?(): void;
	_getTableStream(
		tag: string,
	): { readBuffer(length: number): Uint8Array } | null;
	_getBaseGlyph(glyphId: number): { path: { commands: PathCommand[] } } | null;
}

interface SvgDocumentRecord {
	startGlyphId: number;
	endGlyphId: number;
	/** Byte offset of the document within the table. */
	offset: number;
	length: number;
}

function readSvgDocumentRecords(
	font: Font,
): { table: Uint8Array; entries: SvgDocumentRecord[] } | null {
	const tables = font as unknown as InternalFont;
	const entry = tables.directory.tables["SVG "];
	if (!entry) return null;
	// A WOFF font inflates its tables into the stream only on demand
	tables._decompress?.();
	const table = tables._getTableStream("SVG ")?.readBuffer(entry.length);
	if (!table) return null;

	const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
	const listOffset = view.getUint32(2);
	const count = view.getUint16(listOffset);
	const entries: SvgDocumentRecord[] = [];
	for (let i = 0; i < count; i++) {
		const at = listOffset + 2 + i * 12;
		entries.push({
			startGlyphId: view.getUint16(at),
			endGlyphId: view.getUint16(at + 2),
			offset: listOffset + view.getUint32(at + 4),
			length: view.getUint32(at + 8),
		});
	}
	return { table, entries };
}

async function decodeSvgDocument(bytes: Uint8Array): Promise<string> {
	const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
	if (!gzipped) return new TextDecoder().decode(bytes);
	const inflated = new Blob([bytes.slice()])
		.stream()
		.pipeThrough(new DecompressionStream("gzip"));
	return new Response(inflated).text();
}

/**
 * Converts the glyph's element of an SVG document into layers. SVG glyphs are
 * drawn in font units with y pointing down from the baseline origin.
 */
async function svgGlyphLayers(
	source: string,
	glyphId: number,
	unitsPerEm: number,
): Promise<ColorGlyphLayerSource<CubicBezierSegment[]>[] | null> {
	const doc = new DOMParser().parseFromString(source, "image/svg+xml");
	const root = doc.documentElement;
	const target = doc.getElementById(`glyph${glyphId}`);
	if (!target || root.localName !== "svg") return null;

	// A document shared by several glyphs draws only this glyph's element
	for (const other of doc.querySelectorAll("[id^='glyph']")) {
		const isOtherGlyph =
			/^glyph\d+$/.test(other.id) &&
			!other.contains(target) &&
			!target.contains(other);
		if (isOtherGlyph) other.remove();
	}
	// The importer centres the drawing on the viewBox; a viewBox centred on
	// the origin keeps the glyph's own coordinates.
	root.setAttribute("viewBox", "-1 -1 2 2");

	const result = await parseSvgToArtObjects(
		new XMLSerializer().serializeToString(doc),
		0,
		0,
	);
	const layers: ColorGlyphLayerSource<CubicBezierSegment[]>[] = [];
	const scale = 1 / unitsPerEm;
	const collect = (id: string): boolean => {
		const object = result.objects.get(id);
		if (object?.type === "group") {
			return isPlainContainer(object) && object.childIds.every(collect);
		}
		if (object?.type !== "path") return false;
		const fill = plainFill(object);
		if (fill === undefined) return false;
		if (fill) {
			layers.push({
				outline: object.segments.map((seg) => scaleSegment(seg, scale)),
				fill,
			});
		}
		return true;
	};
	return result.topLevelIds.every(collect) && layers.length > 0 ? layers : null;
}

function isPlainContainer(group: Group): boolean {
	return (
		group.opacity === 1 &&
		group.blendMode === "normal" &&
		!group.clipPathId &&
		!group.mask &&
		(group.filters ?? []).length === 0
	);
}

/**
 * The fill of an imported path with its opacities folded in, null when it
 * paints nothing, or undefined when it paints something a layer cannot hold
 * (a stroke, a filter, a pattern, a blend mode).
 */
function plainFill(path: Path): FillColor | null | undefined {
	if (path.blendMode !== "normal" || path.mask) return undefined;
	const filters = localAppearances(path.filters);
	const fill = filters.find((f): f is FillAppearance => f.processor === "fill");
	if (filters.some((f) => f !== fill)) return undefined;
	if (!fill) return null;

	const paint = fill.paramData.params.fill;
	const alpha = path.opacity * fill.opacity;
	const fade = (color: Color): Color => ({ ...color, a: color.a * alpha });
	switch (paint.type) {
		case "solid":
			return { ...paint, color: fade(paint.color) };
		case "linear":
		case "radial":
			return {
				...paint,
				stops: paint.stops.map((stop) => ({
					...stop,
					color: fade(stop.color),
				})),
			};
		default:
			return undefined;
	}
}

function scaleSegment(
	seg: CubicBezierSegment,
	scale: number,
): CubicBezierSegment {
	return {
		...seg,
		start: seg.start
			? { x: seg.start.x * scale, y: seg.start.y * scale }
			: undefined,
		cp1: { x: seg.cp1.x * scale, y: seg.cp1.y * scale },
		cp2: { x: seg.cp2.x * scale, y: seg.cp2.y * scale },
		end: { x: seg.end.x * scale, y: seg.end.y * scale },
	};
}
