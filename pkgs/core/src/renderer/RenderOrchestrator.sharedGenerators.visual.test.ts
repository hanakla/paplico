import { describe, expect, it, vi } from "vitest";
import { createDefaultDocument } from "../document/factory";
import type { Document, FreeGradient } from "../schema";
import { rectPath, solidFillAppearance } from "../testUtils/svgFixtures";
import { createTestRenderer } from "../testUtils/visualRegression";
import { CanvasTarget } from "./CanvasTarget";
import type { RenderOrchestrator } from "./RenderOrchestrator";

/**
 * Free gradients are drawn into textures by a generator every canvas target
 * shares. One canvas's frames or disposal must not throw away the textures
 * another canvas is still drawing.
 */
describe("free gradient textures shared by canvas targets", () => {
	it("should keep the editor's texture when another target is disposed", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const gradientDoc = createDocument(true);
		await renderEditorFrame(renderer, gradientDoc);

		const other = new CanvasTarget(canvas.canvas, {
			id: "other",
			pixelRatio: 1,
		});
		await renderer.initCanvasTarget(other, { isolated: true });
		await renderOn(renderer, createDocument(false), other.id);
		renderer.disposeCanvasTarget(other);

		const created = countFreeGradientTextures(renderer);
		await renderEditorFrame(renderer, gradientDoc);

		expect(created()).toBe(0);
	});

	it("should age the texture once per round while two targets render in turn", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const other = new CanvasTarget(canvas.canvas, {
			id: "other",
			pixelRatio: 1,
		});
		await renderer.initCanvasTarget(other, { isolated: true });
		const gradientDoc = createDocument(true);
		const plainDoc = createDocument(false);
		await renderEditorFrame(renderer, gradientDoc);

		// Fewer rounds than the generator's idle limit, but more renders.
		for (let round = 0; round < 6; round++) {
			await renderOn(renderer, plainDoc, other.id);
			await renderEditorFrame(renderer, plainDoc);
		}
		const created = countFreeGradientTextures(renderer);
		await renderEditorFrame(renderer, gradientDoc);

		expect(created()).toBe(0);
	});

	it("should not age the texture while exports read through the editor's target", async () => {
		const { renderer } = await createTestRenderer();
		const gradientDoc = createDocument(true);
		const plainDoc = createDocument(false);
		await renderEditorFrame(renderer, gradientDoc);

		// More one-off reads than the generator's idle limit.
		for (let read = 0; read < 12; read++) {
			await renderOn(renderer, plainDoc);
		}
		const created = countFreeGradientTextures(renderer);
		await renderEditorFrame(renderer, gradientDoc);

		expect(created()).toBe(0);
	});
});

/** A frame as the editor draws it, through the target's own render path. */
async function renderEditorFrame(renderer: RenderOrchestrator, doc: Document) {
	renderer.render(
		{
			viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
			document: doc,
			strategy: "full",
		},
		{},
	);
	await renderer.getDevice()?.queue.onSubmittedWorkDone();
}

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

/** Starts counting the textures the free gradient generator creates. */
function countFreeGradientTextures(renderer: RenderOrchestrator): () => number {
	const device = renderer.getDevice();
	if (!device) throw new Error("Expected an initialized device");
	const spy = vi.spyOn(device, "createTexture");
	return () =>
		spy.mock.calls.filter(([descriptor]) => descriptor.label === "FreeGradient")
			.length;
}

/** A 100×100 square, filled with a free gradient or with a solid color. */
function createDocument(withGradient: boolean): Document {
	const doc = createDefaultDocument("doc-free-gradient");
	const fill = solidFillAppearance(0.5, 0.5, 0.5);
	if (withGradient) fill.paramData.params.fill = FREE_GRADIENT;
	const square = rectPath("square", { x: 0, y: 0 }, 100, 100, [fill]);
	doc.objects[square.id] = square;
	doc.layers[0].elementIds = [square.id];
	doc.artboards = [
		{ id: "artboard", name: "Artboard", x: 0, y: 0, width: 100, height: 100 },
	];
	return doc;
}

const FREE_GRADIENT: FreeGradient = {
	type: "free",
	stops: [
		{ id: "a", x: 0, y: 0, color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 } },
		{ id: "b", x: 1, y: 0, color: { type: "rgb", r: 0, g: 1, b: 0, a: 1 } },
		{ id: "c", x: 0.5, y: 1, color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 } },
	],
};
