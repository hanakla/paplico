import { describe, expect, it } from "vitest";
import { createBuiltinBrushPresets } from "../../brush/presets";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../document/factory";
import type {
	BrushSettings,
	Document,
	Filter,
	Path,
	Viewport,
} from "../../schema";
import { closedRectSegments } from "../../testUtils/segmentFactory";
import {
	captureTexturePixels,
	createTestRenderer,
	renderWithViewport,
} from "../../testUtils/visualRegression";

/**
 * What a blur brush has to do: dragged along the seam between two colour
 * fields, it must leave a band of intermediate colour where the seam used to
 * be a step, and at full flow that band must be the blurred backdrop itself,
 * not a tint laid over it. Measured across the row the stroke ran along.
 */
describe("Blur brush", () => {
	it("should widen a hard seam it is dragged along", async () => {
		const untouched = await seamTransitionWidth(null);
		const blurred = await seamTransitionWidth(blurPreset());

		expect(untouched).toBeLessThan(4);
		expect(blurred).toBeGreaterThan(untouched + 8);
	});

	it("should replace the seam with its blur at full flow", async () => {
		// A Gaussian blur of a red|blue step is symmetric about the seam: the
		// column on the seam holds equal parts of both fields, and neither
		// field's colour survives unmixed there.
		const pixels = await seamRow(fullFlowBlur(0.5));
		const seam = colorAt(pixels, SEAM_X);
		const leftOfSeam = colorAt(pixels, SEAM_X - 2);
		const rightOfSeam = colorAt(pixels, SEAM_X + 2);

		expect(Math.abs(seam.r - seam.b)).toBeLessThan(12);
		expect(seam.r).toBeGreaterThan(50);
		expect(seam.b).toBeGreaterThan(50);
		expect(leftOfSeam.r).toBeGreaterThan(seam.r);
		expect(rightOfSeam.b).toBeGreaterThan(seam.b);
	});

	it("should blur wider as the radius rises", async () => {
		const narrow = await seamTransitionWidth(fullFlowBlur(0.25));
		const wide = await seamTransitionWidth(fullFlowBlur(1));

		expect(wide).toBeGreaterThan(narrow + 8);
	});

	it("should leave the seam sharp where the flow is zero", async () => {
		const settings = fullFlowBlur(0.5);
		settings.properties.flow = { base: 0 };

		expect(await seamTransitionWidth(settings)).toBeLessThan(4);
	});

	it("should not let the sharp backdrop through where the blur is translucent", async () => {
		// A field beside empty canvas: the blur of that edge is half-covered
		// on the seam. Layered over the sharp field instead of replacing it,
		// the seam column would come out nearly opaque.
		const pixels = await seamRow(fullFlowBlur(0.5), { rightField: null });

		expect(colorAt(pixels, SEAM_X).a).toBeLessThan(160);
		expect(colorAt(pixels, SEAM_X).a).toBeGreaterThan(90);
	});

	it("should roughen the stroke as the dabs scatter", async () => {
		const roughness = async (scatter: number): Promise<number> => {
			const settings = fullFlowBlur(0.5);
			settings.properties.scatterOffset = { base: scatter };
			const pixels = await seamRow(settings);
			let sum = 0;
			for (let dx = -40; dx < 40; dx++) {
				const a = colorAt(pixels, SEAM_X + dx);
				const b = colorAt(pixels, SEAM_X + dx + 1);
				sum += Math.abs(a.r - b.r);
			}
			return sum;
		};

		expect(await roughness(3)).toBeGreaterThan((await roughness(0)) + 20);
	});

	it("should reach the artwork on the layer below it", async () => {
		// What someone actually does: the drawing sits on one layer and the
		// blur stroke goes on a fresh one above it.
		const untouched = await seamTransitionWidth(null, { ownLayer: true });
		const blurred = await seamTransitionWidth(blurPreset(), {
			ownLayer: true,
		});

		expect(untouched).toBeLessThan(4);
		expect(blurred).toBeGreaterThan(untouched + 8);
	});
});

const VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
/** Screen row the stroke runs along; the seam sits at screen x 400. */
const STROKE_ROW = 300;
const SEAM_X = 400;
const SCAN_HALF_WIDTH = 60;

/** A blur stroke whose coverage is 1 everywhere it lands. */
function fullFlowBlur(radius: number): BrushSettings {
	return {
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "wash",
		properties: {
			size: { base: 40 },
			spacing: { base: 0.05 },
			flow: { base: 1 },
			hardness: { base: 1 },
		},
		tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
		backdropBlur: { enabled: true, radius },
		randomSeed: 11,
	};
}

function blurPreset(): BrushSettings {
	const preset = createBuiltinBrushPresets().find(
		(p) => p.uid === "builtin-brush-blur",
	);
	if (!preset) throw new Error("missing builtin blur preset");
	return preset.settings;
}

interface SeamOptions {
	ownLayer?: boolean;
	/** The field right of the seam; null leaves empty canvas there. */
	rightField?: { r: number; g: number; b: number } | null;
}

/**
 * Columns around the seam whose colour is neither field: the width of the
 * transition. A hard seam gives a handful of columns (antialiasing only).
 */
async function seamTransitionWidth(
	brushSettings: BrushSettings | null,
	options: SeamOptions = {},
): Promise<number> {
	const pixels = await seamRow(brushSettings, options);
	// A column counts as transitional when both fields' colours are present
	// in it: a hard seam has none, a blurred one has a run of them.
	let width = 0;
	for (let dx = -SCAN_HALF_WIDTH; dx <= SCAN_HALF_WIDTH; dx++) {
		const { r, b } = colorAt(pixels, SEAM_X + dx);
		if (r > 30 && b > 30) width++;
	}
	return width;
}

/** The rendered row the stroke ran along, as straight rgba bytes. */
async function seamRow(
	brushSettings: BrushSettings | null,
	options: SeamOptions = {},
): Promise<Uint8Array> {
	const { renderer, canvas } = await createTestRenderer();
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");

	const doc = seamDoc(brushSettings, options);
	// Transparent ground: the fields sit on empty canvas, so alpha reads
	// what the stroke did to the picture and not the page behind it.
	const ground = { r: 0, g: 0, b: 0, a: 0 };
	// Warm caches on identical frames before reading (render cache rule).
	await renderWithViewport(renderer, canvas, doc, VIEWPORT, ground);
	await renderWithViewport(renderer, canvas, doc, VIEWPORT, ground);
	const texture = await renderWithViewport(
		renderer,
		canvas,
		doc,
		VIEWPORT,
		ground,
	);
	const pixels = await captureTexturePixels(
		device,
		texture,
		texture.width,
		texture.height,
	);
	const rowStart = STROKE_ROW * texture.width * 4;
	const row = pixels.slice(rowStart, rowStart + texture.width * 4);
	texture.destroy();
	return row;
}

function colorAt(
	row: Uint8Array,
	x: number,
): { r: number; g: number; b: number; a: number } {
	const offset = x * 4;
	return {
		r: row[offset],
		g: row[offset + 1],
		b: row[offset + 2],
		a: row[offset + 3],
	};
}

/** Red field | blue field, with an optional stroke along the seam. */
function seamDoc(
	brushSettings: BrushSettings | null,
	options: SeamOptions,
	strokeWorldWidth = 300,
): Document {
	const strokeOnOwnLayer = options.ownLayer ?? false;
	const left = filledRect("seam-left", -200, -120, 0, 120, {
		r: 0.8,
		g: 0,
		b: 0,
	});
	const rightField =
		options.rightField === undefined
			? { r: 0, g: 0, b: 0.8 }
			: options.rightField;
	const right = rightField
		? filledRect("seam-right", 0, -120, 200, 120, rightField)
		: null;

	const stroke: Path = {
		id: "seam-stroke",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: [
			{
				start: { x: -strokeWorldWidth / 2, y: 0 },
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: strokeWorldWidth / 2, y: 0 },
				startPressure: 1,
				endPressure: 1,
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 300,
				isMoved: true,
			},
		],
		filters: [
			{
				uid: "seam-stroke-appearance",
				processor: "stroke",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						strokeColor: {
							type: "solid",
							color: { type: "rgb", r: 1, g: 1, b: 1, a: 1 },
						},
						brushSettings,
					},
				},
			} as unknown as Filter,
		],
	};

	const doc = createDefaultDocument("blur-seam");
	const layer = createDefaultLayer("blur-seam-layer", "Fields");
	layer.elementIds.push(left.id);
	doc.objects[left.id] = left;
	if (right) {
		layer.elementIds.push(right.id);
		doc.objects[right.id] = right;
	}
	doc.layers.push(layer);
	if (brushSettings) {
		doc.objects[stroke.id] = stroke;
		if (strokeOnOwnLayer) {
			const above = createDefaultLayer("blur-stroke-layer", "Blur");
			above.elementIds.push(stroke.id);
			doc.layers.push(above);
		} else {
			layer.elementIds.push(stroke.id);
		}
	}
	doc.artboards.push(createArtboard("blur-seam-ab", "Main", 0, 0, 800, 600));
	return doc;
}

function filledRect(
	id: string,
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
	color: { r: number; g: number; b: number },
): Path {
	return {
		id,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: closedRectSegments(minX, minY, maxX, maxY),
		filters: [
			{
				uid: `${id}-fill`,
				processor: "fill",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						fill: {
							type: "solid",
							color: { type: "rgb", ...color, a: 1 },
						},
					},
				},
			} as unknown as Filter,
		],
	};
}
