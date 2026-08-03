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
): Promise<{ atCrossing: number[]; offCrossing: number[] }> {
	const { renderer, canvas } = await createTestRenderer();
	const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");

	const doc = crossDoc(brushSettings);
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

function crossDoc(brushSettings: ReturnType<typeof washBrush>): Document {
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
							color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
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
