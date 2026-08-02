import { describe, expect, it } from "vitest";
import type { Document, RawRGBA, Viewport } from "../../schema";
import { loadTestDocument } from "../../testUtils/loadTestDocument";
import { createTestRenderer } from "../../testUtils/visualRegression";
import type { RenderOrchestrator } from "../RenderOrchestrator";
import type { ChangedElements } from "../types";

const BACKGROUND: RawRGBA = { r: 0.1, g: 0.1, b: 0.1, a: 1 };
const UNCHANGED: ChangedElements = { upserted: new Set(), deleted: new Set() };
const WIDTH = 1600;
const HEIGHT = 1200;
/** renderViewportToTexture allocates its own output + intermediate per call;
 * the interactive path renders into the swapchain instead. */
const HARNESS_BYTES = WIDTH * HEIGHT * 4 * 2;
/** Steady-state headroom for content-driven per-frame textures (e.g. a
 * frame-local backdrop filter regenerating a small procedural texture). */
const STEADY_STATE_BUDGET_BYTES = 32 * 1024 * 1024;

/**
 * Guards against per-frame GPU allocation churn: with an unchanged document
 * and viewport, a settled frame must not re-create canvas-scale textures.
 * Regression context: frame-local backdrop captures and filter chain
 * intermediates used to be raw createTexture calls re-allocated every frame
 * (50–300 MB/frame at DPR-2 canvas sizes), exhausting GPU memory on device.
 */
describe("steady-state texture allocation", () => {
	it("allocates almost nothing on settled frames of the test document", async () => {
		const doc = await loadTestDocument();
		const { renderer } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("no GPU device");

		let frameBytes = 0;
		const originalCreate = device.createTexture.bind(device);
		device.createTexture = ((descriptor: GPUTextureDescriptor) => {
			const size = descriptor.size as { width?: number; height?: number };
			const bytesPerTexel = String(descriptor.format).includes("32float")
				? 16
				: String(descriptor.format).includes("16float")
					? 8
					: 4;
			frameBytes += (size.width ?? 1) * (size.height ?? 1) * bytesPerTexel;
			return originalCreate(descriptor);
		}) as typeof device.createTexture;

		const viewport: Viewport = { x: 0, y: 0, zoom: 0.5, rotation: 0 };
		let settledBytes = 0;
		for (let frame = 0; frame < 5; frame++) {
			frameBytes = 0;
			await renderFrame(renderer, doc, viewport);
			settledBytes = frameBytes;
		}

		expect(settledBytes - HARNESS_BYTES).toBeLessThan(
			STEADY_STATE_BUDGET_BYTES,
		);
	}, 240_000);
});

async function renderFrame(
	renderer: RenderOrchestrator,
	doc: Document,
	viewport: Viewport,
): Promise<void> {
	const texture = await renderer.renderViewportToTexture(
		viewport,
		doc,
		WIDTH,
		HEIGHT,
		BACKGROUND,
		UNCHANGED,
		undefined,
		false,
	);
	if (!texture) throw new Error("render returned no texture");
	texture.destroy();
}
