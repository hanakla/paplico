import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";
import {
	createDefaultDocument,
	createDefaultTransform,
} from "../document/factory";
import type { Document } from "../schema";
import { createTestRenderer } from "../testUtils/visualRegression";
import { CanvasTarget } from "./CanvasTarget";
import type { RenderOrchestrator } from "./RenderOrchestrator";

/**
 * An embedded image's bytes never change under its file uid, so every canvas
 * target draws it from one decoded texture.
 */
describe("embedded image textures shared by canvas targets", () => {
	it("should decode an image once for two targets drawing it", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const other = new CanvasTarget(canvas.canvas, {
			id: "other",
			pixelRatio: 1,
		});
		await renderer.initCanvasTarget(other, { isolated: true });
		const doc = createImageDocument();
		const created = countImageTextures(renderer);

		await renderOn(renderer, doc);
		await renderOn(renderer, doc, other.id);

		expect(created()).toBe(1);
	});

	it("should keep the image when another target that drew it is disposed", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const other = new CanvasTarget(canvas.canvas, {
			id: "other",
			pixelRatio: 1,
		});
		await renderer.initCanvasTarget(other, { isolated: true });
		const doc = createImageDocument();
		await renderOn(renderer, doc);
		await renderOn(renderer, doc, other.id);
		renderer.disposeCanvasTarget(other);

		const created = countImageTextures(renderer);
		const image = await renderOn(renderer, doc);

		expect(created()).toBe(0);
		expect(centerPixel(image)).toMatchObject({ r: 255, g: 0, b: 0 });
	});

	it("should release an image only a disposed target drew", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const other = new CanvasTarget(canvas.canvas, {
			id: "other",
			pixelRatio: 1,
		});
		await renderer.initCanvasTarget(other, { isolated: true });
		const doc = createImageDocument();
		await renderOn(renderer, doc, other.id);
		renderer.disposeCanvasTarget(other);

		const created = countImageTextures(renderer);
		await renderOn(renderer, doc);

		expect(created()).toBe(1);
	});

	it("should draw each revision's own bytes under one file uid", async () => {
		const { renderer, canvas } = await createTestRenderer();
		const preview = new CanvasTarget(canvas.canvas, {
			id: "preview",
			pixelRatio: 1,
		});
		await renderer.initCanvasTarget(preview, { isolated: true });
		await renderOn(renderer, createImageDocument([255, 0, 0]));

		const image = await renderOn(
			renderer,
			createImageDocument([0, 0, 255]),
			preview.id,
		);

		expect(centerPixel(image)).toMatchObject({ r: 0, g: 0, b: 255 });
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

/** Starts counting the image textures the renderer decodes. */
function countImageTextures(renderer: RenderOrchestrator): () => number {
	const device = renderer.getDevice();
	if (!device) throw new Error("Expected an initialized device");
	const spy = vi.spyOn(device, "createTexture");
	return () =>
		spy.mock.calls.filter(([descriptor]) =>
			descriptor.label?.startsWith("Image Texture:"),
		).length;
}

/** A 100×100 artboard covered by a stretched 4×4 PNG of one color. */
function createImageDocument(
	[r, g, b]: [number, number, number] = [255, 0, 0],
): Document {
	const png = new PNG({ width: 4, height: 4 });
	for (let i = 0; i < png.data.length; i += 4) {
		png.data.set([r, g, b, 255], i);
	}
	const doc = createDefaultDocument("doc-image");
	doc.files = [
		{
			uid: "picture-file",
			name: "picture.png",
			type: "image/png",
			hash: `${r},${g},${b}`,
			bin: new Uint8Array(PNG.sync.write(png)),
		},
	];
	doc.objects.picture = {
		type: "image",
		id: "picture",
		fileUid: "picture-file",
		x: 0,
		y: 0,
		width: 100,
		height: 100,
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		filters: [],
	};
	doc.layers[0].elementIds = ["picture"];
	doc.artboards = [
		{ id: "artboard", name: "Artboard", x: 0, y: 0, width: 100, height: 100 },
	];
	return doc;
}

function centerPixel(imageData: ImageData | null) {
	if (!imageData) throw new Error("Expected a rendered image");
	const { width, height, data } = imageData;
	const i = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
	return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}
