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
import type { FrameRequest } from "../types";

/** More frames than the editor needs to finish its bakes. */
const MAX_EDITOR_FRAMES = 8;

/**
 * The editor keeps filtered bakes across its frames. An export drawn through
 * the editor's target between two of them must leave those bakes alone.
 */
describe("filtered bakes across an export", () => {
	it("should keep the editor's filtered bakes after an export", async () => {
		const { renderer } = await createTestRenderer();
		const document = blurredDocument();
		const bakes = countFilteredBakes(renderer);
		renderEditorFrames(renderer, document);
		const bakedBeforeExport = bakes();

		await renderer.renderArtboardToImageData(document.artboards[0], document);
		const bakedAfterExport = bakes();
		renderEditorFrames(renderer, document);

		expect(bakedBeforeExport).toBeGreaterThan(0);
		expect(bakes()).toBe(bakedAfterExport);
	});
});

/**
 * Frames as the editor draws them with nothing changed: a full frame, then a
 * follow-up frame each time the renderer asks for one. The full frame leaves
 * the bake it wants kept to that follow-up.
 */
function renderEditorFrames(renderer: RenderOrchestrator, document: Document) {
	let followUpRequested = false;
	renderer.setOnRequestRender(() => {
		followUpRequested = true;
	});
	let strategy: FrameRequest["strategy"] = "full";
	for (let frame = 0; frame < MAX_EDITOR_FRAMES; frame++) {
		followUpRequested = false;
		renderer.render(
			{
				viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
				document,
				strategy,
				changedElements: { upserted: new Set(), deleted: new Set() },
				defRevision: 0,
			},
			{},
		);
		if (!followUpRequested) return;
		strategy = "overlayOnly";
	}
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
