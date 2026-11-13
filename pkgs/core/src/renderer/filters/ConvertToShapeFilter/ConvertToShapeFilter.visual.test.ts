import { expect, it } from "vitest";
import { createDefaultDocument } from "../../../document/factory";
import { createDefaultContentAppearance, type Filter } from "../../../schema";
import { NOTO_SANS_JP_POST_SCRIPT_NAME } from "../../../testUtils/fontSetup";
import { createTestTextElement } from "../../../testUtils/typographyFixtures";
import { createTestRenderer } from "../../../testUtils/visualRegression";

it("draws a background around all characters from a fill's shape filter", async () => {
	const { renderer } = await createTestRenderer();
	const doc = createDefaultDocument("shape-text");
	const text = createTestTextElement("Hello world", { id: "text" });
	const fontSource = {
		loaderId: "local",
		fontId: NOTO_SANS_JP_POST_SCRIPT_NAME,
	};
	const black = {
		type: "solid" as const,
		color: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 },
	};
	text.defaultStyle = {
		...text.defaultStyle,
		fontSource,
		fontSize: 24,
		fill: black,
	};
	for (const paragraph of text.content.paragraphs)
		for (const run of paragraph.runs)
			run.style = { ...run.style, fontSource, fontSize: 24, fill: black };
	const shape: Filter = {
		uid: "shape",
		processor: "convert-to-shape",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				shape: "rectangle",
				sizeMode: "relative",
				width: 20,
				height: 20,
				cornerRadius: 4,
			},
		},
	};
	const fill: Filter = {
		uid: "fill",
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: { type: "solid", color: { type: "rgb", r: 1, g: 0, b: 1, a: 1 } },
			},
		},
		subFilters: [shape],
	};
	text.filters = [fill, createDefaultContentAppearance()];
	doc.objects[text.id] = text;
	doc.layers[0].elementIds = [text.id];
	doc.artboards = [
		{ id: "board", name: "Board", x: 0, y: 0, width: 240, height: 100 },
	];
	const withShape = await renderer.renderArtboardToImageData(
		doc.artboards[0],
		doc,
		1,
		{ r: 1, g: 1, b: 1, a: 1 },
	);
	doc.objects = {
		...doc.objects,
		[text.id]: {
			...text,
			filters: [{ ...fill, subFilters: [] }, createDefaultContentAppearance()],
		},
	};
	const withoutShape = await renderer.renderArtboardToImageData(
		doc.artboards[0],
		doc,
		1,
		{ r: 1, g: 1, b: 1, a: 1 },
	);
	const magentaPixels = (data: Uint8ClampedArray) => {
		let count = 0;
		for (let i = 0; i < data.length; i += 4)
			if (data[i] > 200 && data[i + 1] < 30 && data[i + 2] > 200) count++;
		return count;
	};
	expect(withShape).not.toBeNull();
	expect(withoutShape).not.toBeNull();
	if (!withShape || !withoutShape) throw new Error("Rendering failed");
	expect(magentaPixels(withShape.data)).toBeGreaterThan(
		magentaPixels(withoutShape.data) + 100,
	);
});
