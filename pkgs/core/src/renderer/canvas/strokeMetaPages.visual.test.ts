import { describe, expect, it } from "vitest";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../document/factory";
import type {
	BrushSettings,
	Document,
	Path,
	RawRGBA,
	StrokeAppearance,
} from "../../schema";
import { BUILTIN_BRUSH_IDS } from "../../schema";
import {
	captureTexturePixels,
	createTestRenderer,
	renderWithViewport,
} from "../../testUtils/visualRegression";

/**
 * Brush draws of one frame share stroke meta pages, and each draw reads its
 * PathMeta and colour stops through an offset into a page. A wrong offset is
 * not a validation error: the stroke takes another stroke's colour. So every
 * test lays out a grid of short strokes whose colours cycle through a palette
 * and reads each stroke's own centre.
 */
describe("Stroke meta pages", () => {
	it("should draw each dab stroke in its own colour when the strokes fill more than one page", async () => {
		expect(await miscolouredStrokes(DAB_BRUSH, 30, 20)).toEqual([]);
	});

	it("should draw each ribbon in its own colour when one batch is larger than a page", async () => {
		expect(await miscolouredStrokes(RIBBON_BRUSH, 30, 30)).toEqual([]);
	});
});

const COLUMN_STEP = 24;
const ROW_STEP = 18;
const STROKE_LENGTH = 12;

/** Seven colours, so strokes one page apart never share one: a page holds a
 *  power-of-two number of draws. */
const PALETTE: RawRGBA[] = [
	{ r: 1, g: 0, b: 0, a: 1 },
	{ r: 0, g: 1, b: 0, a: 1 },
	{ r: 0, g: 0, b: 1, a: 1 },
	{ r: 0, g: 1, b: 1, a: 1 },
	{ r: 1, g: 0, b: 1, a: 1 },
	{ r: 1, g: 1, b: 0, a: 1 },
	{ r: 0, g: 0, b: 0, a: 1 },
];

const DAB_BRUSH: BrushSettings = {
	version: 2,
	engine: "dab",
	strokeOpacity: 1,
	paintMode: "buildup",
	properties: {
		size: { base: 8 },
		spacing: { base: 0.1 },
		flow: { base: 1 },
	},
	tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
	randomSeed: 1,
};

const RIBBON_BRUSH: BrushSettings = {
	version: 2,
	engine: "ribbon",
	strokeOpacity: 1,
	paintMode: "buildup",
	properties: { size: { base: 8 }, flow: { base: 1 } },
	ribbon: {
		source: { kind: "file", fileUid: BUILTIN_BRUSH_IDS.hardCircle },
		uvMode: "stretch",
		tileScale: 1,
		tileSpacing: 0,
	},
	randomSeed: 1,
};

/**
 * Render a `columns` × `rows` grid of strokes on a white 800×600 canvas and
 * return the indices of the strokes whose centre is not their own colour.
 * World 0,0 is screen 400,300 and y points up.
 */
async function miscolouredStrokes(
	brushSettings: BrushSettings,
	columns: number,
	rows: number,
): Promise<number[]> {
	const strokes = Array.from({ length: columns * rows }, (_, index) => {
		const centerX = ((index % columns) - (columns - 1) / 2) * COLUMN_STEP;
		const centerY = ((rows - 1) / 2 - Math.floor(index / columns)) * ROW_STEP;
		return { index, centerX, centerY, color: PALETTE[index % PALETTE.length] };
	});

	const { renderer, canvas } = await createTestRenderer();
	const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");
	try {
		const doc = documentOf(
			strokes.map(({ index, centerX, centerY, color }) =>
				strokePath(`stroke-${index}`, centerX, centerY, color, brushSettings),
			),
		);
		// The second frame draws committed strokes from their caches, which is
		// the state a redraw of an open document is in.
		await renderWithViewport(renderer, canvas, doc, viewport);
		const texture = await renderWithViewport(renderer, canvas, doc, viewport);
		const pixels = await captureTexturePixels(
			device,
			texture,
			texture.width,
			texture.height,
		);
		texture.destroy();
		return strokes
			.filter(({ centerX, centerY, color }) => {
				const offset =
					(Math.round(300 - centerY) * texture.width +
						Math.round(400 + centerX)) *
					4;
				return (["r", "g", "b"] as const).some(
					(channel, i) =>
						Math.abs(pixels[offset + i] - color[channel] * 255) > 8,
				);
			})
			.map(({ index }) => index);
	} finally {
		renderer.destroy();
	}
}

function documentOf(paths: Path[]): Document {
	const doc = createDefaultDocument("stroke-meta-pages");
	const layer = createDefaultLayer("stroke-meta-pages-layer", "Strokes");
	for (const path of paths) {
		doc.objects[path.id] = path;
		layer.elementIds.push(path.id);
	}
	doc.layers.push(layer);
	doc.artboards.push(
		createArtboard("stroke-meta-pages-ab", "Main", 0, 0, 800, 600),
	);
	return doc;
}

/** A short horizontal stroke centred on the given world point. */
function strokePath(
	id: string,
	centerX: number,
	centerY: number,
	color: RawRGBA,
	brushSettings: BrushSettings,
): Path {
	const stroke: StrokeAppearance = {
		uid: `${id}-stroke`,
		processor: "stroke",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				strokeColor: { type: "solid", color: { type: "rgb", ...color } },
				brushSettings,
			},
		},
	};
	return {
		id,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: [
			{
				start: { x: centerX - STROKE_LENGTH / 2, y: centerY },
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: centerX + STROKE_LENGTH / 2, y: centerY },
				startPressure: 1,
				endPressure: 1,
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 150,
				isMoved: true,
			},
		],
		filters: [stroke],
	};
}
