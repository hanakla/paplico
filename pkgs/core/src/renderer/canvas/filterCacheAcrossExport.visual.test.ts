import { describe, expect, it, vi } from "vitest";
import { createArtboard } from "../../document/factory";
import type { Document, FillAppearance, Path } from "../../schema";
import {
	mockDocument,
	mockLayer,
	mockPath,
} from "../../testUtils/mockElements";
import { closedRectSegments } from "../../testUtils/segmentFactory";
import { createTestRenderer } from "../../testUtils/visualRegression";
import type { BlurFilter } from "../filters/BlurFilter/BlurFilter";
import type { RenderOrchestrator } from "../RenderOrchestrator";

/**
 * The editor keeps filtered bakes across its frames. An export drawn through
 * the editor's target between two of them must leave those bakes alone.
 */
describe("filtered bakes across an export", () => {
	it("should keep the editor's filtered bakes after an export", async () => {
		const { renderer } = await createTestRenderer();
		const document = blurredDocument();
		const bakes = countFilteredBakes(renderer);
		renderEditorFrame(renderer, document);
		const bakedByFirstFrame = bakes();

		await renderer.renderArtboardToImageData(document.artboards[0], document);
		const bakedBeforeSecondFrame = bakes();
		renderEditorFrame(renderer, document);

		expect(bakedByFirstFrame).toBeGreaterThan(0);
		expect(bakes()).toBe(bakedBeforeSecondFrame);
	});
});

/** A frame as the editor draws it: tracked, with nothing changed. */
function renderEditorFrame(renderer: RenderOrchestrator, document: Document) {
	renderer.render(
		{
			viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
			document,
			strategy: "full",
			changedElements: { upserted: new Set(), deleted: new Set() },
			defRevision: 0,
		},
		{},
	);
}

/** Starts counting the bakes stored in the filtered element cache. */
function countFilteredBakes(renderer: RenderOrchestrator): () => number {
	const device = renderer.getDevice();
	if (!device) throw new Error("Expected an initialized device");
	const spy = vi.spyOn(device, "createTexture");
	return () =>
		spy.mock.calls.filter(
			([descriptor]) => descriptor.label === "Filtered Element Cache Texture",
		).length;
}

/** A blurred 200×100 rect inside an artboard of the same size. */
function blurredDocument(): Document {
	const path: Path = mockPath("blurred");
	path.segments = closedRectSegments(-100, -50, 100, 50);
	const fill: FillAppearance = {
		uid: "blurred-fill",
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: { type: "solid", color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 } },
			},
		},
	};
	const blur: BlurFilter = {
		uid: "blur",
		processor: "blur",
		opacity: 1,
		blendMode: "normal",
		enabled: true,
		paramData: { version: "1", params: { radius: 8 } },
	};
	path.filters = [fill, blur];
	const document = mockDocument([path], [mockLayer("layer-1", [path.id])]);
	document.artboards = [createArtboard("artboard", "Artboard", 0, 0, 200, 100)];
	return document;
}
