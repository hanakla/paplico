import { describe, expect, it } from "vitest";
import { normalizeBrushSettingsV2 } from "../../brush/migrate";
import { createBuiltinBrushPresets } from "../../brush/presets";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../document/factory";
import type {
	BrushSettingsV2,
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
 * be a step. Measured as the number of screen columns that hold neither
 * field's colour, across the row the stroke ran along.
 */
describe("Blur brush", () => {
	it("should widen a hard seam it is dragged along", async () => {
		const untouched = await seamTransitionWidth(null);
		const blurred = await seamTransitionWidth(blurPreset());

		expect(untouched).toBeLessThan(4);
		expect(blurred).toBeGreaterThan(untouched + 8);
	});

	// Diffusion is what would make this a blur: the colour a dab picked up has
	// to run outward, not just repaint the dab's own disc. It does not today —
	// a stroke that mixes is taken by the inline composite route, which never
	// runs the wet layer, so the two never combine. Recorded as a known
	// failure.
	it.fails("should spread further once the wet layer carries the pickup", async () => {
		const dryPickup = await seamTransitionWidth(diffusingBrush(false));
		const wetPickup = await seamTransitionWidth(diffusingBrush(true));

		expect(wetPickup).toBeGreaterThan(dryPickup + 8);
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

/** Pickup with, or without, the wet layer spreading it. */
function diffusingBrush(wet: boolean): BrushSettingsV2 {
	return normalizeBrushSettingsV2({
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "wash",
		properties: {
			size: { base: 40 },
			spacing: { base: 0.03 },
			flow: { base: 1 },
			hardness: { base: 0.4 },
			colorRate: { base: 0 },
			alphaRate: { base: 0 },
			smudgeLength: { base: 0 },
			...(wet
				? {
						wetness: { base: 1.2 },
						bleedSoftness: { base: 0.8 },
						absorption: { base: 0.1 },
					}
				: {}),
		},
		tip: { kind: "procedural", hardness: 0.4, angleMode: "fixed" },
		mixing: {
			enabled: true,
			mode: "dulling",
			sampleRadius: 2,
			sampleTrail: 0,
			blendStyle: 1,
		},
		...(wet
			? {
					wet: {
						enabled: true,
						bleedRadius: 1.5,
						pigmentLoad: 0.85,
						grainScale: 1,
					},
				}
			: {}),
		randomSeed: 11,
	});
}

function blurPreset(): BrushSettingsV2 {
	const preset = createBuiltinBrushPresets().find(
		(p) => p.uid === "builtin-brush-blur",
	);
	if (!preset) throw new Error("missing builtin blur preset");
	return normalizeBrushSettingsV2(preset.settings);
}

/**
 * Columns around the seam whose colour is neither field: the width of the
 * transition. A hard seam gives a handful of columns (antialiasing only).
 */
async function seamTransitionWidth(
	brushSettings: BrushSettingsV2 | null,
	options: { ownLayer?: boolean } = {},
): Promise<number> {
	const { renderer, canvas } = await createTestRenderer();
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");

	const doc = seamDoc(brushSettings, options.ownLayer ?? false);
	// Warm caches on identical frames before reading (render cache rule).
	await renderWithViewport(renderer, canvas, doc, VIEWPORT);
	await renderWithViewport(renderer, canvas, doc, VIEWPORT);
	const texture = await renderWithViewport(renderer, canvas, doc, VIEWPORT);
	const pixels = await captureTexturePixels(
		device,
		texture,
		texture.width,
		texture.height,
	);

	// A column counts as transitional when both fields' colours are present
	// in it: a hard seam has none, a blurred one has a run of them.
	let width = 0;
	for (let dx = -SCAN_HALF_WIDTH; dx <= SCAN_HALF_WIDTH; dx++) {
		const offset = (STROKE_ROW * texture.width + SEAM_X + dx) * 4;
		const [r, , b] = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
		if (r > 30 && b > 30) width++;
	}
	texture.destroy();
	return width;
}

/** Red field | blue field, with an optional stroke along the seam. */
function seamDoc(
	brushSettings: BrushSettingsV2 | null,
	strokeOnOwnLayer: boolean,
): Document {
	const left = filledRect("seam-left", -200, -120, 0, 120, {
		r: 0.8,
		g: 0,
		b: 0,
	});
	const right = filledRect("seam-right", 0, -120, 200, 120, {
		r: 0,
		g: 0,
		b: 0.8,
	});

	const stroke: Path = {
		id: "seam-stroke",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: [
			{
				start: { x: -150, y: 0 },
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: 150, y: 0 },
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
	layer.elementIds.push(left.id, right.id);
	doc.objects[left.id] = left;
	doc.objects[right.id] = right;
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
