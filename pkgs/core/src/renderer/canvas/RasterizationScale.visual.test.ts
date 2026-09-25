import { beforeEach, describe, expect, it } from "vitest";
import type { Document } from "../../schema";
import { loadTestDocument } from "../../testUtils/loadTestDocument";
import {
	createTestRenderer,
	renderArtboardForTest,
} from "../../testUtils/visualRegression";
import type { RenderOrchestrator } from "../RenderOrchestrator";

type SceneCapture = { dpiScale: number; width: number; height: number };

/**
 * Rasterization resolution (Document.rasterizationDpi) decouples filter
 * offscreen rasterization from the viewport zoom / export scale. These tests
 * pin that contract at the seam where it matters: the FilterSceneInfo handed to
 * a post-filter handler. The blur element lives in the "Filters" artboard of
 * the shared test document, so rendering that artboard at different scales is
 * enough to exercise the offscreen filter path without the element being culled.
 */
describe("Rasterization resolution invariance", () => {
	let renderer: RenderOrchestrator;
	let doc: Document;

	beforeEach(async () => {
		renderer = (await createTestRenderer()).renderer;
		doc = await loadTestDocument();
	});

	it("keeps blur sceneInfo constant across viewport scales at the test document's 300 DPI", async () => {
		const artboard = doc.artboards.find((ab) => ab.name === "Filters")!;

		const scales = [0.5, 1, 2] as const;
		const captures: Record<number, SceneCapture> = {};
		for (const scale of scales) {
			captures[scale] = await captureBlurScene(renderer, doc, artboard, scale);
		}

		// The shared test document is configured at 300 DPI → R = 300/72.
		for (const scale of scales) {
			expect(captures[scale].dpiScale).toBe(300 / 72);
		}

		// Texture dimensions are identical regardless of the viewport scale.
		expect(captures[0.5]).toEqual(captures[1]);
		expect(captures[2]).toEqual(captures[1]);
	});

	it("scales blur sceneInfo with rasterizationDpi, not with the viewport", async () => {
		const artboard = doc.artboards.find((ab) => ab.name === "Filters")!;

		doc.rasterizationDpi = 72;
		const at72 = await captureBlurScene(renderer, doc, artboard, 1);

		doc.rasterizationDpi = 144;
		const at144 = await captureBlurScene(renderer, doc, artboard, 1);

		// 144 DPI doubles the rasterization scale (R = 2) at the same viewport.
		expect(at72.dpiScale).toBe(1);
		expect(at144.dpiScale).toBe(2);
		// Offscreen texture grows with R (ceil rounding keeps it within 1px).
		expect(at144.width).toBeGreaterThanOrEqual(at72.width * 2 - 1);
		expect(at144.height).toBeGreaterThanOrEqual(at72.height * 2 - 1);
	});
});

/**
 * Renders the given artboard once while intercepting the blur handler's
 * postProcess, and returns the FilterSceneInfo of the first blur pass.
 */
async function captureBlurScene(
	renderer: RenderOrchestrator,
	doc: Document,
	artboard: Document["artboards"][number],
	scale: number,
): Promise<SceneCapture> {
	const handler = renderer.getFilterHandler("blur");
	if (!handler?.postProcess) throw new Error("blur handler not registered");

	const originalPostProcess = handler.postProcess;
	let captured: SceneCapture | null = null;
	handler.postProcess = function interceptedPostProcess(context, filter) {
		captured ??= {
			dpiScale: context.sceneInfo.dpiScale,
			width: context.sceneInfo.textureSize.width,
			height: context.sceneInfo.textureSize.height,
		};
		return originalPostProcess.call(this, context, filter);
	};

	try {
		const texture = await renderArtboardForTest(renderer, artboard, doc, scale);
		texture.destroy();
	} finally {
		handler.postProcess = originalPostProcess;
	}

	if (!captured) throw new Error("blur postProcess was not invoked");
	return captured;
}
