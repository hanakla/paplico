import { describe, expect, it } from "vitest";
import type { Document, RawRGBA, Viewport } from "../../schema";
import { loadTestDocument } from "../../testUtils/loadTestDocument";
import { createTestRenderer } from "../../testUtils/visualRegression";
import type { RenderOrchestrator } from "../RenderOrchestrator";
import type { ChangedElements } from "../types";

const BACKGROUND: RawRGBA = { r: 0.1, g: 0.1, b: 0.1, a: 1 };
const UNCHANGED: ChangedElements = { upserted: new Set(), deleted: new Set() };

describe("saved-viewport render (DEBUG)", () => {
	it("renders with the document's own viewport at DPR2-like size", async () => {
		const doc = await loadTestDocument();
		console.log("saved viewport:", JSON.stringify(doc.viewport));
		const { renderer } = await createTestRenderer();
		const viewport: Viewport = { ...doc.viewport };
		for (let frame = 0; frame < 4; frame++) {
			const start = performance.now();
			await renderFrame(renderer, doc, viewport);
			const memory = process.memoryUsage();
			console.log(
				`frame${frame}: time=${(performance.now() - start).toFixed(0)}ms rss=${(memory.rss / 1024 / 1024).toFixed(0)}MB`,
			);
		}
		expect(true).toBe(true);
	}, 120_000);
});

async function renderFrame(
	renderer: RenderOrchestrator,
	doc: Document,
	viewport: Viewport,
): Promise<void> {
	const texture = await renderer.renderViewportToTexture(
		viewport,
		doc,
		3200,
		2000,
		BACKGROUND,
		UNCHANGED,
		undefined,
		false,
	);
	if (!texture) throw new Error("render returned no texture");
	texture.destroy();
}
