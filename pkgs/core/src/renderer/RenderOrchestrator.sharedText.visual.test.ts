import { describe, expect, it, vi } from "vitest";
import { createDefaultDocument } from "../document/factory";
import type { Document, TextElement } from "../schema";
import { NOTO_SANS_JP_POST_SCRIPT_NAME } from "../testUtils/fontSetup";
import { createTestTextElement } from "../testUtils/typographyFixtures";
import { createTestRenderer } from "../testUtils/visualRegression";
import { CanvasTarget } from "./CanvasTarget";
import type { RenderOrchestrator } from "./RenderOrchestrator";

/**
 * Glyph outlines depend only on the text, so every canvas target drawing one
 * document reads the outlines another target already built.
 */
describe("text outlines shared by canvas targets", () => {
	it("should lay out a text once for two targets drawing it", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const other = new CanvasTarget(canvas.canvas, {
			id: "other",
			pixelRatio: 1,
		});
		await renderer.initCanvasTarget(other);
		const doc = createTextDocument("Hello");
		const layouts = countTextLayouts(renderer);

		await renderOn(renderer, doc);
		await renderOn(renderer, doc, other.id);

		expect(layouts()).toBe(1);
	});

	it("should lay out the text again after it is invalidated", async () => {
		const { renderer } = await createTestRenderer();
		const doc = createTextDocument("Hello");
		await renderOn(renderer, doc);

		renderer.invalidateTextCache("greeting");
		const layouts = countTextLayouts(renderer);
		await renderOn(renderer, doc);

		expect(layouts()).toBe(1);
	});

	it("should lay out a stored revision on its isolated target by itself", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const preview = new CanvasTarget(canvas.canvas, {
			id: "preview",
			pixelRatio: 1,
		});
		await renderer.initCanvasTarget(preview, { isolated: true });
		await renderOn(renderer, createTextDocument("Hello"));

		const layouts = countTextLayouts(renderer);
		await renderOn(renderer, createTextDocument("Hello"), preview.id);

		expect(layouts()).toBe(1);
	});

	it("should draw an export from the outlines it loaded while the editor drew", async () => {
		const { renderer } = await createTestRenderer();
		const exported = createTextDocument("Hello");
		const layouts = countTextLayouts(renderer);

		const image = renderOn(renderer, exported);
		// The editor draws its own document while the export loads its text.
		renderer.render(
			{
				viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
				document: createDefaultDocument("doc-editor"),
				strategy: "full",
			},
			{},
		);
		await image;

		expect(layouts()).toBe(1);
	});
});

function renderOn(
	renderer: RenderOrchestrator,
	doc: Document,
	targetId?: string,
) {
	return renderer.renderArtboardToImageData(
		doc.artboards[0],
		doc,
		1,
		{ r: 1, g: 1, b: 1, a: 1 },
		{ targetId },
	);
}

/** Starts counting the glyph layouts the renderer builds. */
function countTextLayouts(renderer: RenderOrchestrator): () => number {
	const textRenderer = renderer.getTextRenderer();
	if (!textRenderer) throw new Error("Expected a text renderer");
	const spy = vi.spyOn(textRenderer, "textElementToPaths");
	return () => spy.mock.calls.length;
}

function createTextDocument(text: string): Document {
	const doc = createDefaultDocument("doc-text");
	const element: TextElement = createTestTextElement(text, { id: "greeting" });
	const fontSource = {
		loaderId: "local",
		fontId: NOTO_SANS_JP_POST_SCRIPT_NAME,
	} as const;
	element.defaultStyle = { ...element.defaultStyle, fontSource, fontSize: 24 };
	for (const paragraph of element.content.paragraphs) {
		for (const run of paragraph.runs) {
			run.style = { ...run.style, fontSource, fontSize: 24 };
		}
	}
	doc.objects[element.id] = element;
	doc.layers[0].elementIds = [element.id];
	doc.artboards = [
		{ id: "artboard", name: "Artboard", x: 0, y: 0, width: 200, height: 100 },
	];
	return doc;
}
