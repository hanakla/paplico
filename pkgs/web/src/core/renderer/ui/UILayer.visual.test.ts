import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	testCanvasHeight,
	testCanvasWidth,
	testViewport,
} from "../../testUtils/pointerEvent";
import {
	captureTexturePixels,
	createTestRenderer,
	expectVisualMatch,
} from "../../testUtils/visualRegression";
import type { RenderOrchestrator } from "../RenderOrchestrator";
import { UI_OVERLAY_FIXTURES } from "./UILayer.visual.fixtures";

const MAX_DIFF_PERCENTAGE = 0.1;

let renderer: RenderOrchestrator;

beforeAll(async () => {
	({ renderer } = await createTestRenderer({ lifetime: "suite" }));
});

afterAll(() => {
	renderer.destroy();
});

describe("UILayer Visual Regression - UI overlay only", () => {
	it("should keep the gradient ColorStop center fully opaque", async () => {
		const fixture = UI_OVERLAY_FIXTURES.find(
			(candidate) => candidate.name === "gradient-edit",
		);
		if (!fixture) throw new Error("gradient-edit fixture not found");

		const texture = renderer.renderUIOverlayToTexture(
			testViewport,
			fixture.state,
			fixture.artboards ?? null,
			testCanvasWidth,
			testCanvasHeight,
		);
		if (!texture) throw new Error("renderUIOverlayToTexture returned null");
		const device = renderer.getDevice();
		if (!device) throw new Error("renderer device is not available");

		const pixels = await captureTexturePixels(
			device,
			texture,
			testCanvasWidth,
			testCanvasHeight,
		);
		texture.destroy();

		for (const y of [319, 320]) {
			for (const x of [339, 340]) {
				const offset = (y * testCanvasWidth + x) * 4;
				expect([...pixels.subarray(offset, offset + 4)]).toEqual([
					128, 51, 204, 255,
				]);
			}
		}
	});

	for (const zoom of [1, 2]) {
		describe(`at zoom ${zoom}`, () => {
			for (const fixture of UI_OVERLAY_FIXTURES) {
				it(`should render ${fixture.name} overlay unchanged`, async () => {
					const texture = renderer.renderUIOverlayToTexture(
						{ ...testViewport, zoom },
						fixture.state,
						fixture.artboards ?? null,
						testCanvasWidth,
						testCanvasHeight,
					);
					if (!texture) {
						throw new Error("renderUIOverlayToTexture returned null");
					}

					await expectVisualMatch(
						renderer,
						texture,
						testCanvasWidth,
						testCanvasHeight,
						`ui-overlay-${fixture.name}-zoom${zoom}`,
						{ threshold: 0.1, maxDiffPercentage: MAX_DIFF_PERCENTAGE },
					);

					texture.destroy();
				});
			}
		});
	}
});
