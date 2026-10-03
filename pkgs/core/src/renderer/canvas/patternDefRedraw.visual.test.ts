import { describe, expect, it } from "vitest";
import { createDefaultDocument } from "../../document/factory";
import type { Document, FillAppearance } from "../../schema";
import { rectPath, solidFillAppearance } from "../../testUtils/svgFixtures";
import { createTestRenderer } from "../../testUtils/visualRegression";
import { CanvasTarget } from "../CanvasTarget";

/**
 * Exports and isolated targets render without def revisions, so they cannot
 * tell an edited def from the tile they rasterized before. Each such render
 * must draw the def as the document it was handed defines it.
 */
describe("pattern fill rendered without def revisions", () => {
	it("should draw the edited tile when an export follows a def edit", async () => {
		const { renderer } = await createTestRenderer();

		const before = await renderer.renderElementsToImageData(
			["filled"],
			createPatternDocument([1, 0, 0]),
			REGION,
		);
		const after = await renderer.renderElementsToImageData(
			["filled"],
			createPatternDocument([0, 0, 1]),
			REGION,
		);

		expect(centerPixel(before)).toMatchObject({ r: 255, g: 0, b: 0 });
		expect(centerPixel(after)).toMatchObject({ r: 0, g: 0, b: 255 });
	});

	it("should draw the edited tile on an isolated target", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const isolated = new CanvasTarget(canvas.canvas, {
			id: "isolated-canvas",
			pixelRatio: 1,
		});
		await renderer.initCanvasTarget(isolated, { isolated: true });

		const render = (rgb: [number, number, number]) => {
			const doc = createPatternDocument(rgb);
			return renderer.renderArtboardToImageData(
				doc.artboards[0],
				doc,
				1,
				{ r: 1, g: 1, b: 1, a: 1 },
				{ targetId: isolated.id },
			);
		};
		const before = await render([1, 0, 0]);
		const after = await render([0, 0, 1]);

		expect(centerPixel(before)).toMatchObject({ r: 255, g: 0, b: 0 });
		expect(centerPixel(after)).toMatchObject({ r: 0, g: 0, b: 255 });
	});
});

const REGION = { centerX: 0, centerY: 0, width: 100, height: 100 };

/** A 100×100 square filled with a 20×20 pattern tile of one solid color. */
function createPatternDocument(rgb: [number, number, number]): Document {
	const doc = createDefaultDocument("doc-pattern-def");
	const tile = rectPath("tile", { x: 0, y: 0 }, 20, 20, [
		solidFillAppearance(...rgb),
	]);
	const filled = rectPath("filled", { x: 0, y: 0 }, 100, 100, [
		patternFillAppearance("def-tile"),
	]);
	doc.objects[tile.id] = tile;
	doc.objects[filled.id] = filled;
	doc.layers[0].elementIds = [filled.id];
	doc.defs = {
		"def-tile": {
			id: "def-tile",
			kind: "pattern",
			rootElementIds: [tile.id],
			tile: { width: 20, height: 20 },
		},
	};
	doc.artboards = [
		{ id: "artboard", name: "Artboard", x: 0, y: 0, width: 100, height: 100 },
	];
	return doc;
}

function patternFillAppearance(defId: string): FillAppearance {
	const appearance = solidFillAppearance(0, 0, 0);
	appearance.paramData.params.fill = {
		type: "pattern",
		defId,
		scaleX: 1,
		scaleY: 1,
		rotation: 0,
		offsetX: 0,
		offsetY: 0,
	};
	return appearance;
}

function centerPixel(imageData: ImageData | null) {
	if (!imageData) throw new Error("Expected a rendered image");
	const { width, height, data } = imageData;
	const i = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
	return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}
