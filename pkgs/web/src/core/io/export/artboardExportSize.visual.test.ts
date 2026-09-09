import { describe, expect, it } from "vitest";
import { BASE_DPI } from "@/configs";
import { createArtboard, createDefaultDocument } from "../../document/factory";
import { unitToWorld } from "../../document/units";
import { createTestRenderer } from "../../testUtils/visualRegression";

/**
 * Print sizes are authored in physical units and exported at a print DPI.
 * The exported pixel size must match what a print shop expects for that
 * paper size, e.g. A4 at 300 dpi is 2480 × 3508 px.
 */
describe("artboard export size", () => {
	it("should export an A4 artboard at 300 dpi as 2480 × 3508 px", async () => {
		const { renderer } = await createTestRenderer();
		const doc = createDefaultDocument("doc");
		const artboard = createArtboard(
			"a4",
			"A4",
			0,
			0,
			unitToWorld(210, "mm"),
			unitToWorld(297, "mm"),
		);
		doc.artboards = [artboard];
		doc.units = "mm";

		const image = await renderer.renderArtboardToImageData(
			artboard,
			doc,
			300 / BASE_DPI,
		);

		expect(image).not.toBeNull();
		expect({ width: image!.width, height: image!.height }).toEqual({
			width: 2480,
			height: 3508,
		});
	});
});
