import { describe, expect, it } from "vitest";
import { PREVIEW_ELEMENT_SENTINEL_ID } from "../../document/constants";
import { createDefaultDocument } from "../../document/factory";
import type { Path, StrokeAppearance } from "../../schema";
import recording from "../../testUtils/fixtures/slowContactStroke.json";
import { createMockToolContext } from "../../testUtils/mockToolContext";
import {
	ev,
	testCanvasHeight,
	testCanvasWidth,
	testViewport,
} from "../../testUtils/pointerEvent";
import { replayRecordedStroke } from "../../testUtils/strokeReplay";
import {
	captureTexturePixels,
	createTestRenderer,
	renderWithViewport,
} from "../../testUtils/visualRegression";
import { PenTool } from "../../tools/PenTool";

describe("Pen preview and committed ink", () => {
	it.each([
		"pressure and speed",
		"stroke progress",
		"recorded slow contact",
	])("should keep the rendered ink unchanged on pen-up with %s", async (dynamics) => {
		const { renderer, canvas } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("Missing GPU device");
		const appearance =
			dynamics === "recorded slow contact"
				? (recording.appearance as StrokeAppearance)
				: pressureAppearance();
		if (dynamics === "stroke progress") {
			const settings = appearance.paramData.params.brushSettings;
			if (!settings) throw new Error("Missing brush settings");
			settings.properties.size = { base: 40 };
			settings.properties.flow = {
				base: 0.8,
				curves: [
					{
						input: "strokeT",
						points: [
							[0, -0.5],
							[1, 0],
						],
					},
				],
			};
		}
		const context = createMockToolContext({
			getActiveStrokeAppearance: () => appearance,
		});
		const pen = new PenTool(context, {
			stabilization: 0.5,
			perspectiveSnap: false,
		});
		try {
			const synthetic = [...Array(161).keys()].map((i) => ({
				x: 150 + i * 3,
				y: 300 + Math.sin(i * 0.08) * 60,
				pressure: i < 12 ? 0.9 - i * 0.04 : 0.4 + 0.25 * Math.sin(i * 0.13),
				deltaTime: i <= 80 ? i * 4 : 320 + (i - 80) * 16,
			}));
			await replayRecordedStroke(
				pen,
				dynamics === "recorded slow contact"
					? recording
					: {
							points: synthetic.map((p) => ({
								...p,
								x: p.x - 200,
								y: 500 - p.y,
							})),
						},
				async (i) => {
					if (i > 0 && i % 40 === 0) await draw(latestPreview(context));
				},
			);
			const preview = latestPreview(context);
			const before = await draw(preview);
			pen.onPointerUp(
				ev(630, 300, { pressure: 0, timeStamp: 1601 }),
				testViewport,
				testCanvasWidth,
				testCanvasHeight,
			);
			const committed = context.strokeComplete.mock.calls[0][0];
			const after = await draw(committed);
			expect(before.some((value, i) => i % 4 !== 3 && value < 200)).toBe(true);
			// The committed path drops the preview's input knots, which moves
			// dab placement by a fraction of a pixel; the ink must stay put.
			let changed = 0;
			for (let i = 0; i < before.length; i++) {
				if (Math.abs(before[i] - after[i]) > 16) changed++;
			}
			expect(changed / before.length).toBeLessThan(0.002);
		} finally {
			pen.dispose();
			renderer.destroy();
		}

		async function draw(path: Path): Promise<Uint8Array> {
			if (!device) throw new Error("Missing GPU device");
			const doc = createDefaultDocument("pen-preview");
			doc.objects = { [path.id]: path };
			doc.layers[0].elementIds = [path.id];
			const texture = await renderWithViewport(
				renderer,
				canvas,
				doc,
				testViewport,
			);
			const pixels = await captureTexturePixels(
				device,
				texture,
				texture.width,
				texture.height,
			);
			texture.destroy();
			return pixels;
		}
	});
});

function latestPreview(
	context: ReturnType<typeof createMockToolContext>,
): Path {
	const path = context.previewUpdate.mock.calls.at(-1)?.[0];
	if (!path) throw new Error("Missing preview");
	return { ...path, id: PREVIEW_ELEMENT_SENTINEL_ID };
}

function pressureAppearance(): StrokeAppearance {
	return {
		uid: "pen-preview-stroke",
		processor: "stroke",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				strokeColor: {
					type: "solid",
					color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
				},
				brushSettings: {
					version: 2,
					engine: "dab",
					paintMode: "buildup",
					strokeOpacity: 0.8,
					randomSeed: 0,
					properties: {
						size: {
							base: 40,
							curves: [
								{
									input: "pressure",
									points: [
										[0, -0.3],
										[1, 0],
									],
								},
								{
									input: "speedFine",
									points: [
										[0, 0],
										[1, -0.5],
									],
								},
							],
						},
						ratio: { base: 0.75 },
						flow: { base: 0.6 },
						spacing: { base: 0.05 },
					},
					tip: { kind: "procedural", hardness: 0.7, angleMode: "tangent" },
				},
			},
		},
	};
}
