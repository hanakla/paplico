import { describe, expect, it } from "vitest";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultTransform,
	createStrokeBrushSettings,
} from "../../document/factory";
import type { Document, Path } from "../../schema";
import {
	captureTexturePixels,
	createTestRenderer,
	renderArtboardForTest,
} from "../../testUtils/visualRegression";

/**
 * Growing a path one segment at a time is how the timelapse draws a stroke on,
 * and it is the shape of any live stroke being extended. Each render has to
 * show the path as it is now, not as it was on an earlier frame.
 */
describe("Stroke rendered while its segment list grows", () => {
	const POINTS = Array.from({ length: 12 }, (_, i) => ({
		x: -330 + i * 60,
		y: i % 2 === 0 ? -120 : 120,
	}));

	it("should show more of the stroke as segments are appended", async () => {
		const { renderer } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("Test renderer has no GPU device");

		const ink: number[] = [];
		for (let count = 2; count <= POINTS.length; count++) {
			ink.push(
				await inkOf(
					renderer,
					device,
					documentWith(polylinePath("growing", POINTS.slice(0, count))),
				),
			);
		}

		expect(ink[0]).toBeGreaterThan(0);
		expect(ink.at(-1), `ink per render: ${ink.join(", ")}`).toBeGreaterThan(
			ink[0],
		);
	});

	/**
	 * Known defect, pinned rather than fixed: editing a Document in place and
	 * re-rendering it draws the first version again. Callers work around it by
	 * handing over a fresh object per frame — timelapse playback froze on its
	 * opening frame until it did.
	 *
	 * This turns red once the renderer stops depending on object identity, which
	 * is the signal to delete it and drop the workarounds.
	 */
	it.fails("redraws the first version of a Document edited in place", async () => {
		const { renderer } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("Test renderer has no GPU device");

		const document = documentWith(polylinePath("in-place", POINTS));
		const ink: number[] = [];
		for (let count = 2; count <= POINTS.length; count++) {
			document.objects["in-place"] = polylinePath(
				"in-place",
				POINTS.slice(0, count),
			);
			ink.push(await inkOf(renderer, device, document));
		}

		expect(ink[0]).toBeGreaterThan(0);
		expect(ink.at(-1), `ink per render: ${ink.join(", ")}`).toBeGreaterThan(
			ink[0],
		);
	});

	it("should show less of the stroke when segments are taken away", async () => {
		const { renderer } = await createTestRenderer();
		const device = renderer.getDevice();
		if (!device) throw new Error("Test renderer has no GPU device");

		const full = await inkOf(
			renderer,
			device,
			documentWith(polylinePath("shrinking", POINTS)),
		);
		const trimmed = await inkOf(
			renderer,
			device,
			documentWith(polylinePath("shrinking", POINTS.slice(0, 3))),
		);

		expect(full).toBeGreaterThan(0);
		expect(trimmed).toBeLessThan(full);
	});
});

async function inkOf(
	renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"],
	device: GPUDevice,
	document: Document,
): Promise<number> {
	const texture = await renderArtboardForTest(
		renderer,
		document.artboards[0],
		document,
	);
	const pixels = await captureTexturePixels(
		device,
		texture,
		texture.width,
		texture.height,
	);
	texture.destroy();

	let count = 0;
	for (let i = 0; i < pixels.length; i += 4) {
		if (pixels[i] < 128) count++;
	}
	return count;
}

/** A one-layer document holding a single element, framed by one artboard. */
function documentWith(element: Path): Document {
	const document = createDefaultDocument("stroke-growth");
	document.objects[element.id] = element;
	document.layers[0].elementIds.push(element.id);
	document.artboards.push(createArtboard("ab", "Main", 0, 0, 800, 600));
	return document;
}

/** Black 24-wide polyline through the given points, one segment per leg. */
function polylinePath(id: string, points: { x: number; y: number }[]): Path {
	return {
		id,
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: points.slice(0, -1).map((start, i) => ({
			start: i === 0 ? start : undefined,
			end: points[i + 1],
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			startPressure: 1,
			endPressure: 1,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: i === 0,
		})),
		filters: [
			{
				uid: `${id}-appearance`,
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
						brushSettings: createStrokeBrushSettings(24),
					},
				},
			},
		],
	};
}
