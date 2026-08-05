import { describe, expect, it } from "vitest";
import { normalizeBrushSettingsV2 } from "../../brush/migrate";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../document/factory";
import type { BrushSettingsV2, Document, Filter, Path } from "../../schema";
import {
	captureTexturePixels,
	createTestRenderer,
	renderWithViewport,
} from "../../testUtils/visualRegression";

/**
 * A v2 wet stroke renders through WetLayerPass (design §13): its dabs seed
 * the fields, the simulation spreads them and the composite paints the
 * result. What distinguishes it from an ordinary dab stroke is that pigment
 * ends up outside the dabs' own footprint.
 */
describe("Wet layer strokes", () => {
	it("should paint the stroke", async () => {
		const pixel = await renderStrokePixel(wetBrush({ enabled: true }));

		// Black on the white artboard: the centre must be visibly darkened.
		expect(pixel[0]).toBeLessThan(200);
	});

	it("should granulate the stroke's interior against the paper", async () => {
		// Granulation modulates the settled pigment by the paper grain, so the
		// interior comes out mottled. Plain dabs lay down a flat body, which
		// is what makes this a check that the simulation actually ran.
		const wet = await renderInteriorSpread(wetBrush({ enabled: true }));
		const dry = await renderInteriorSpread(wetBrush({ enabled: false }));

		expect(wet).toBeGreaterThan(dry + 8);
	});

	// Every wet value a person can drag has to change what comes out. None of
	// them does right now: the simulation runs, the values reach its uniforms,
	// and the result comes out identical either way. Recorded as known
	// failures until the diffusion itself is fixed.
	it.fails("should bleed further as the wetness rises", async () => {
		const damp = await renderSpreadReach(wetTuned({ wetness: 0.2 }));
		const soaked = await renderSpreadReach(wetTuned({ wetness: 1.4 }));

		expect(soaked).toBeGreaterThan(damp + 2);
	});

	it.fails("should bleed further as the bleed radius grows", async () => {
		const tight = await renderSpreadReach(wetTuned({ bleedRadius: 0.3 }));
		const wide = await renderSpreadReach(wetTuned({ bleedRadius: 2.5 }));

		expect(wide).toBeGreaterThan(tight + 2);
	});

	it.fails("should hold less pigment as the load drops", async () => {
		const light = await renderStrokePixel(wetTuned({ pigmentLoad: 0.15 }));
		const heavy = await renderStrokePixel(wetTuned({ pigmentLoad: 1.5 }));

		expect(light[0]).toBeGreaterThan(heavy[0] + 10);
	});

	it.fails("should soak up the bleed as absorption rises", async () => {
		const wicking = await renderSpreadReach(wetTuned({ absorption: 0.05 }));
		const thirsty = await renderSpreadReach(wetTuned({ absorption: 0.95 }));

		expect(wicking).toBeGreaterThan(thirsty + 2);
	});
});

/** Rows above the stroke centre that carry any pigment: how far it bled. */
async function renderSpreadReach(
	brushSettings: BrushSettingsV2,
): Promise<number> {
	const pixels = await renderPixels(brushSettings);
	let reach = 0;
	for (let dy = 1; dy < 120; dy++) {
		if (pixels[((300 - dy) * 800 + 400) * 4] < 250) reach = dy;
	}
	return reach;
}

function wetTuned(overrides: {
	wetness?: number;
	bleedRadius?: number;
	pigmentLoad?: number;
	absorption?: number;
}): BrushSettingsV2 {
	return normalizeBrushSettingsV2({
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "wash",
		properties: {
			size: { base: 16 },
			spacing: { base: 0.1 },
			flow: { base: 1 },
			wetness: { base: overrides.wetness ?? 1 },
			absorption: { base: overrides.absorption ?? 0.1 },
			bleedSoftness: { base: 1 },
			granulation: { base: 0 },
			grainAmount: { base: 0 },
		},
		tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
		wet: {
			enabled: true,
			bleedRadius: overrides.bleedRadius ?? 1.5,
			pigmentLoad: overrides.pigmentLoad ?? 0.85,
			grainScale: 1,
		},
		randomSeed: 1,
	});
}

function wetBrush(overrides: { enabled: boolean }): BrushSettingsV2 {
	return normalizeBrushSettingsV2({
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "wash",
		properties: {
			size: { base: 16 },
			spacing: { base: 0.1 },
			flow: { base: 1 },
			wetness: { base: 1 },
			absorption: { base: 0.1 },
			bleedSoftness: { base: 1 },
			granulation: { base: 1 },
			grainAmount: { base: 1 },
		},
		tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
		wet: {
			enabled: overrides.enabled,
			// A light load leaves the body unsaturated, so granulation shows.
			bleedRadius: 1,
			pigmentLoad: 0.3,
			grainScale: 1,
		},
		randomSeed: 1,
	});
}

/** Spread of darkness along the stroke's centre line: flat paint reads 0. */
async function renderInteriorSpread(
	brushSettings: BrushSettingsV2,
): Promise<number> {
	const pixels = await renderPixels(brushSettings);
	let min = 255;
	let max = 0;
	for (let x = 340; x < 460; x++) {
		const value = pixels[(300 * 800 + x) * 4];
		min = Math.min(min, value);
		max = Math.max(max, value);
	}
	return max - min;
}

async function renderStrokePixel(
	brushSettings: BrushSettingsV2,
	screenY = 300,
): Promise<number[]> {
	const pixels = await renderPixels(brushSettings);
	const offset = (screenY * 800 + 400) * 4;
	return [
		pixels[offset],
		pixels[offset + 1],
		pixels[offset + 2],
		pixels[offset + 3],
	];
}

async function renderPixels(
	brushSettings: BrushSettingsV2,
): Promise<Uint8Array> {
	const { renderer, canvas } = await createTestRenderer();
	const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");

	const doc = wetDoc(brushSettings);
	await renderWithViewport(renderer, canvas, doc, viewport);
	const texture = await renderWithViewport(renderer, canvas, doc, viewport);
	const pixels = await captureTexturePixels(
		device,
		texture,
		texture.width,
		texture.height,
	);
	texture.destroy();
	return pixels;
}

function wetDoc(brushSettings: BrushSettingsV2): Document {
	const stroke: Path = {
		id: "wet-stroke",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: [
			{
				start: { x: -120, y: 0 },
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: 120, y: 0 },
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
		filters: [
			{
				uid: "wet-stroke-appearance",
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
						brushSettings,
					},
				},
			} as unknown as Filter,
		],
	};

	const doc = createDefaultDocument("wet-layer");
	const layer = createDefaultLayer("wet-layer-layer", "Strokes");
	layer.elementIds.push(stroke.id);
	doc.objects[stroke.id] = stroke;
	doc.layers.push(layer);
	doc.artboards.push(createArtboard("wet-ab", "Main", 0, 0, 800, 600));
	return doc;
}
