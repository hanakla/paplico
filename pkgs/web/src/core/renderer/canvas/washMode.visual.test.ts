import { describe, expect, it } from "vitest";
import { normalizeBrushSettingsV2 } from "../../brush/migrate";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../document/factory";
import type { Document, Path } from "../../schema";
import {
	captureTexturePixels,
	createTestRenderer,
	renderWithViewport,
} from "../../testUtils/visualRegression";

/**
 * Wash semantics (design §6-3): dabs accumulate flow into an isolated stroke
 * buffer and strokeOpacity applies exactly once at composite time, so a
 * self-crossing stroke can never get darker than strokeOpacity.
 *
 * Black strokes on white; a wash stroke at strokeOpacity 0.5 reads ≈127 both
 * on and off the crossing. Buildup (the control) darkens where it crosses.
 */
describe("Wash paint mode", () => {
	it("should not exceed strokeOpacity where the stroke crosses itself", async () => {
		const { atCrossing, offCrossing } = await renderCrossPixels(
			washBrush({ paintMode: "wash", strokeOpacity: 0.5, flow: 1 }),
		);

		// Both samples sit at the single-once composite value 255 × 0.5.
		for (const channel of offCrossing.slice(0, 3)) {
			expect(channel).toBeGreaterThan(110);
			expect(channel).toBeLessThan(146);
		}
		for (let i = 0; i < 3; i++) {
			expect(Math.abs(atCrossing[i] - offCrossing[i])).toBeLessThanOrEqual(8);
		}
	});

	it("should keep buildup darkening at the crossing (control)", async () => {
		const { atCrossing, offCrossing } = await renderCrossPixels(
			washBrush({ paintMode: "buildup", strokeOpacity: 1, flow: 0.35 }),
		);

		// The crossing accumulates twice: measurably darker than the arms.
		expect(atCrossing[0]).toBeLessThan(offCrossing[0] - 15);
	});
});

function washBrush(overrides: {
	paintMode: "wash" | "buildup";
	strokeOpacity: number;
	flow: number;
}) {
	return normalizeBrushSettingsV2({
		version: 2,
		engine: "dab",
		strokeOpacity: overrides.strokeOpacity,
		paintMode: overrides.paintMode,
		properties: {
			size: { base: 24 },
			spacing: { base: 0.1 },
			flow: { base: overrides.flow },
		},
		tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
		randomSeed: 1,
	});
}

/**
 * Render a self-crossing stroke (horizontal + vertical subpaths of ONE path)
 * and read the pixel at the crossing (world 0,0 → screen 400,300) and on the
 * horizontal arm (world 100,0 → screen 500,300).
 */
async function renderCrossPixels(
	brushSettings: ReturnType<typeof washBrush>,
	strokeRgb?: { r: number; g: number; b: number },
): Promise<{ atCrossing: number[]; offCrossing: number[] }> {
	const { renderer, canvas } = await createTestRenderer();
	const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");

	const doc = crossDoc(brushSettings, strokeRgb);
	// Warm caches on identical frames before asserting (render cache rule).
	await renderWithViewport(renderer, canvas, doc, viewport);
	await renderWithViewport(renderer, canvas, doc, viewport);
	const texture = await renderWithViewport(renderer, canvas, doc, viewport);
	const pixels = await captureTexturePixels(
		device,
		texture,
		texture.width,
		texture.height,
	);
	const read = (sx: number, sy: number): number[] => {
		const offset = (sy * texture.width + sx) * 4;
		return [
			pixels[offset],
			pixels[offset + 1],
			pixels[offset + 2],
			pixels[offset + 3],
		];
	};
	const atCrossing = read(400, 300);
	const offCrossing = read(500, 300);
	texture.destroy();
	return { atCrossing, offCrossing };
}

function crossDoc(
	brushSettings: ReturnType<typeof washBrush>,
	strokeRgb: { r: number; g: number; b: number } = { r: 0, g: 0, b: 0 },
): Document {
	const path: Path = {
		id: "wash-cross-stroke",
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
				endDeltaTime: 150,
				isMoved: true,
			},
			{
				start: { x: 0, y: -150 },
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: 0, y: 150 },
				startPressure: 1,
				endPressure: 1,
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 150,
				endDeltaTime: 300,
				isMoved: true,
			},
		],
		filters: [
			{
				uid: "wash-cross-appearance",
				processor: "stroke",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						strokeColor: {
							type: "solid",
							color: { type: "rgb", ...strokeRgb, a: 1 },
						},
						brushSettings,
					},
				},
			} as unknown as Path["filters"] extends (infer F)[] | undefined
				? F
				: never,
		],
	};

	const doc = createDefaultDocument("wash-mode");
	const layer = createDefaultLayer("wash-mode-layer", "Strokes");
	layer.elementIds.push(path.id);
	doc.objects[path.id] = path;
	doc.layers.push(layer);
	doc.artboards.push(createArtboard("wash-mode-ab", "Main", 0, 0, 800, 600));
	return doc;
}

describe("Wash wet edge", () => {
	it("should darken the stroke rim relative to its interior", async () => {
		const brush = normalizeBrushSettingsV2({
			version: 2,
			engine: "dab",
			strokeOpacity: 0.6,
			paintMode: "wash",
			properties: {
				size: { base: 40 },
				spacing: { base: 0.1 },
				flow: { base: 1 },
			},
			tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
			wetEdge: { width: 6, intensity: 0.6, darkening: 0.6, blur: 0 },
			randomSeed: 1,
		});
		// Red stroke: darkening scales the straight color, which is invisible
		// on black; alpha sits saturated inside the buffer either way.
		const red = { r: 1, g: 0, b: 0 };
		const { offCrossing: armInterior } = await renderCrossPixels(brush, red);
		// Interior: red at strokeOpacity 0.6 over white keeps R near 255.
		expect(armInterior[0]).toBeGreaterThan(230);

		// The rim band darkens the red channel along the arm's edge profile.
		const darkestR = await renderRimProfileDarkest(brush, red);
		expect(darkestR).toBeLessThan(armInterior[0] - 40);
	});
});

describe("Wash inside containers (strokeOpacity applies once)", () => {
	it("should keep the crossing flat inside a group", async () => {
		const brush = washBrush({ paintMode: "wash", strokeOpacity: 0.5, flow: 1 });
		const { renderer, canvas } = await createTestRenderer();
		const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
		const device = renderer.getDevice();
		if (!device) throw new Error("Test renderer has no GPU device");

		const doc = crossDoc(brush);
		// Wrap the stroke in a group: the wash isolation must survive the
		// group offscreen path with strokeOpacity still applied exactly once.
		const path = doc.objects["wash-cross-stroke"];
		const group = {
			type: "group",
			id: "wash-group",
			opacity: 1,
			blendMode: "normal",
			transform: createDefaultTransform(),
			childIds: [path.id],
			visible: true,
		} as unknown as Document["objects"][string];
		doc.objects[group.id] = group;
		doc.layers[doc.layers.length - 1].elementIds = [group.id];

		await renderWithViewport(renderer, canvas, doc, viewport);
		await renderWithViewport(renderer, canvas, doc, viewport);
		const texture = await renderWithViewport(renderer, canvas, doc, viewport);
		const pixels = await captureTexturePixels(
			device,
			texture,
			texture.width,
			texture.height,
		);
		const read = (sx: number, sy: number) =>
			pixels[(sy * texture.width + sx) * 4];
		const atCrossing = read(400, 300);
		const offCrossing = read(500, 300);
		texture.destroy();

		expect(offCrossing).toBeGreaterThan(110);
		expect(offCrossing).toBeLessThan(146);
		expect(Math.abs(atCrossing - offCrossing)).toBeLessThanOrEqual(8);
	});
});

describe("Wash wet edge under zoom (fixed-R)", () => {
	it("should keep the rim visible at zoom 2", async () => {
		const brush = normalizeBrushSettingsV2({
			version: 2,
			engine: "dab",
			strokeOpacity: 0.6,
			paintMode: "wash",
			properties: {
				size: { base: 40 },
				spacing: { base: 0.1 },
				flow: { base: 1 },
			},
			tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
			wetEdge: { width: 6, intensity: 0.6, darkening: 0.6, blur: 0 },
			randomSeed: 1,
		});
		const red = { r: 1, g: 0, b: 0 };
		const { renderer, canvas } = await createTestRenderer();
		const viewport = { x: 0, y: 0, zoom: 2, rotation: 0 };
		const device = renderer.getDevice();
		if (!device) throw new Error("Test renderer has no GPU device");
		const doc = crossDoc(brush, red);
		await renderWithViewport(renderer, canvas, doc, viewport);
		await renderWithViewport(renderer, canvas, doc, viewport);
		const texture = await renderWithViewport(renderer, canvas, doc, viewport);
		const pixels = await captureTexturePixels(
			device,
			texture,
			texture.width,
			texture.height,
		);
		// world (100, 0) -> screen (600, 300); the top rim of the arm spans
		// world y 14..20 -> screen y 272..260 at zoom 2.
		const interiorR = pixels[(300 * texture.width + 600) * 4];
		let darkest = 255;
		for (let sy = 252; sy <= 296; sy++) {
			darkest = Math.min(darkest, pixels[(sy * texture.width + 600) * 4]);
		}
		texture.destroy();

		expect(interiorR).toBeGreaterThan(230);
		expect(darkest).toBeLessThan(interiorR - 40);
	});
});

/**
 * Darkest red channel along the vertical profile x=500, y 276..298 — the top
 * rim band of the horizontal arm (half width 20, rim width 6).
 */
async function renderRimProfileDarkest(
	brushSettings: ReturnType<typeof washBrush>,
	strokeRgb?: { r: number; g: number; b: number },
): Promise<number> {
	const { renderer, canvas } = await createTestRenderer();
	const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");
	const doc = crossDoc(brushSettings, strokeRgb);
	await renderWithViewport(renderer, canvas, doc, viewport);
	await renderWithViewport(renderer, canvas, doc, viewport);
	const texture = await renderWithViewport(renderer, canvas, doc, viewport);
	const pixels = await captureTexturePixels(
		device,
		texture,
		texture.width,
		texture.height,
	);
	let darkest = 255;
	for (let sy = 276; sy <= 298; sy++) {
		darkest = Math.min(darkest, pixels[(sy * texture.width + 500) * 4]);
	}
	texture.destroy();
	return darkest;
}
