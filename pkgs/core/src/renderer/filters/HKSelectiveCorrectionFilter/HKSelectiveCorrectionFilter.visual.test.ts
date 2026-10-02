import { describe, expect, it } from "vitest";
import type { FillAppearance } from "../../../schema";
import {
	mockDocument,
	mockLayer,
	mockPath,
} from "../../../testUtils/mockElements";
import { lineSeg } from "../../../testUtils/segmentFactory";
import {
	captureTexturePixels,
	createTestRenderer,
	renderWithViewport,
} from "../../../testUtils/visualRegression";
import type { HKSelectiveCorrectionFilter } from "./HKSelectiveCorrectionFilter";

/**
 * A half-transparent dark gray triangle brightened to white, over black.
 * The filter runs on the triangle's bounding box, so the box's top-right
 * half is transparent pixels the filter must leave alone.
 */
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

describe("HKSelectiveCorrectionFilter", () => {
	it("should leave the transparent area around the element transparent", async () => {
		const pixels = await renderBrightenedTriangle();

		// World (80, 80): inside the bounding box, outside the triangle
		expect(colorAt(pixels, 480, 220)).toEqual(BLACK);
	});

	it("should brighten a half-transparent element to half-covering white", async () => {
		const pixels = await renderBrightenedTriangle();

		// World (-50, -50): inside the triangle
		const { r, g, b } = colorAt(pixels, 350, 350);
		for (const channel of [r, g, b]) {
			expect(channel).toBeGreaterThan(0.4);
			expect(channel).toBeLessThan(0.8);
		}
	});
});

async function renderBrightenedTriangle(): Promise<Uint8Array> {
	const triangle = mockPath("triangle-1");
	triangle.segments = [
		lineSeg({ x: 100, y: -100 }, { start: { x: -100, y: -100 } }),
		lineSeg({ x: -100, y: 100 }),
		lineSeg({ x: -100, y: -100 }, { isClosed: true }),
	];
	triangle.filters = [fill(), brighten()];
	const document = mockDocument(
		[triangle],
		[mockLayer("layer-1", [triangle.id])],
	);

	const { renderer, canvas } = await createTestRenderer();
	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");
	const texture = await renderWithViewport(
		renderer,
		canvas,
		document,
		{ x: 0, y: 0, zoom: 1, rotation: 0 },
		BLACK,
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

function colorAt(
	pixels: Uint8Array,
	x: number,
	y: number,
): { r: number; g: number; b: number; a: number } {
	const offset = (y * 800 + x) * 4;
	return {
		r: pixels[offset] / 255,
		g: pixels[offset + 1] / 255,
		b: pixels[offset + 2] / 255,
		a: pixels[offset + 3] / 255,
	};
}

function fill(): FillAppearance {
	return {
		uid: "fill-1",
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: {
					type: "solid",
					color: { type: "rgb", r: 0.2, g: 0.2, b: 0.2, a: 0.5 },
				},
			},
		},
	};
}

/** Lifts every pixel's HSV value to 1, turning gray into white. */
function brighten(): HKSelectiveCorrectionFilter {
	return {
		uid: "correction-1",
		processor: "hk:selective-correction",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				blendMode: "normal",
				mix: 1,
				featherEdges: 0,
				previewMask: false,
				useCondition: false,
				targetHue: 0,
				hueRange: 180,
				saturationMin: 0,
				saturationMax: 1,
				brightnessMin: 0,
				brightnessMax: 1,
				hueShift: 0,
				saturationScale: 1,
				vibrance: 0,
				brightnessScale: 2,
				contrast: 1,
			},
		},
	};
}
