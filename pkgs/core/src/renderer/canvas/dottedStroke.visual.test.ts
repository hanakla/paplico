import { describe, expect, it } from "vitest";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
	createStrokeBrushSettings,
} from "../../document/factory";
import type { Document, LineCap, Path } from "../../schema";
import { lineSeg } from "../../testUtils/segmentFactory";
import {
	captureTexturePixels,
	createTestRenderer,
	renderWithViewport,
} from "../../testUtils/visualRegression";

/**
 * A black stroke from world x -150 to 150 on white, 24 units wide, dashed
 * with a zero-length dash every 60 units: a dot is centered on x = -30 and
 * the gap between two dots is centered on x = 0.
 */
describe("Stroke with zero-length dashes", () => {
	it("should draw a dot at each dash with a round cap", async () => {
		const { dot, gap } = await renderDotted("round");

		expect(dot).toEqual([0, 0, 0]);
		expect(gap).toEqual([255, 255, 255]);
	});

	it("should draw a square at each dash with a square cap", async () => {
		const { dot, gap } = await renderDotted("square");

		expect(dot).toEqual([0, 0, 0]);
		expect(gap).toEqual([255, 255, 255]);
	});

	it("should draw nothing with a butt cap", async () => {
		const { dot, gap } = await renderDotted("butt");

		expect(dot).toEqual([255, 255, 255]);
		expect(gap).toEqual([255, 255, 255]);
	});
});

/** RGB at the center of a dot and at the center of the gap beside it. */
async function renderDotted(
	lineCap: LineCap,
): Promise<{ dot: number[]; gap: number[] }> {
	const { renderer, canvas } = await createTestRenderer();
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");

	const texture = await renderWithViewport(
		renderer,
		canvas,
		dottedDoc(lineCap),
		{ x: 0, y: 0, zoom: 1, rotation: 0 },
	);
	const pixels = await captureTexturePixels(
		device,
		texture,
		texture.width,
		texture.height,
	);
	// World (0,0) lands at screen (400,300).
	const rgbAt = (screenX: number): number[] => {
		const offset = (300 * texture.width + screenX) * 4;
		return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
	};
	const result = { dot: rgbAt(370), gap: rgbAt(400) };
	texture.destroy();
	return result;
}

function dottedDoc(lineCap: LineCap): Document {
	const path: Path = {
		id: "dotted-stroke",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: [lineSeg({ x: 150, y: 0 }, { start: { x: -150, y: 0 } })],
		filters: [
			{
				uid: "dotted-stroke-appearance",
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
						brushSettings: createStrokeBrushSettings(24, {
							lineCap,
							lineJoin: "round",
							miterLimit: 4,
							dashArray: [0, 60],
						}),
					},
				},
			},
		],
	};

	const doc = createDefaultDocument("dotted-stroke");
	const layer = createDefaultLayer("dotted-stroke-layer", "Strokes");
	layer.elementIds.push(path.id);
	doc.objects[path.id] = path;
	doc.layers.push(layer);
	doc.artboards.push(
		createArtboard("dotted-stroke-ab", "Main", 0, 0, 800, 600),
	);
	return doc;
}
