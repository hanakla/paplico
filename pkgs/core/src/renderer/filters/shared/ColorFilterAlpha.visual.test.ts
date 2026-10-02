import { describe, expect, it } from "vitest";
import type { FillAppearance, Filter, RawRGBA } from "../../../schema";
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
import type { HKColorReplacementFilter } from "../HKColorReplacementFilter/HKColorReplacementFilter";
import type { HKGradientMapFilter } from "../HKGradientMapFilter/HKGradientMapFilter";
import type { HKPosterizationFilter } from "../HKPosterizationFilter/HKPosterizationFilter";
import type { HKSelectiveCorrectionFilter } from "../HKSelectiveCorrectionFilter/HKSelectiveCorrectionFilter";

/**
 * Color filters receive premultiplied pixels. Each case fills a triangle
 * with a half-transparent color over black and picks a filter setting whose
 * result differs when the filter reads the darkened premultiplied color
 * instead of the color the user picked. The filter runs on the triangle's
 * bounding box, so the box's top-right half is transparent pixels.
 */
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
/** World (-50, -50): inside the triangle */
const INSIDE = { x: 350, y: 350 };
/** World (80, 80): inside the bounding box, outside the triangle */
const OUTSIDE = { x: 480, y: 220 };

describe("Color filters on semi-transparent pixels", () => {
	it("should leave the transparent area around the element transparent under color correction", async () => {
		const pixels = await renderTriangle(
			{ r: 0.2, g: 0.2, b: 0.2, a: 0.5 },
			brighten(),
		);

		expect(colorAt(pixels, OUTSIDE)).toEqual(BLACK);
	});

	it("should brighten a half-transparent element to half-covering white under color correction", async () => {
		const pixels = await renderTriangle(
			{ r: 0.2, g: 0.2, b: 0.2, a: 0.5 },
			brighten(),
		);

		const { r, g, b } = colorAt(pixels, INSIDE);
		for (const channel of [r, g, b]) {
			expect(channel).toBeGreaterThan(0.4);
			expect(channel).toBeLessThan(0.8);
		}
	});

	it("should posterize a half-transparent light gray up to white", async () => {
		const pixels = await renderTriangle(
			{ r: 0.8, g: 0.8, b: 0.8, a: 0.5 },
			posterize(),
		);

		const { r, g, b } = colorAt(pixels, INSIDE);
		for (const channel of [r, g, b]) {
			expect(channel).toBeGreaterThan(0.4);
		}
	});

	it("should map a half-transparent white to the light end of a gradient", async () => {
		const pixels = await renderTriangle(
			{ r: 1, g: 1, b: 1, a: 0.5 },
			duotoneMap(),
		);

		// The duotone's light end is yellow (1, 0.8, 0.2); its middle is gray
		const { r, b } = colorAt(pixels, INSIDE);
		expect(b).toBeLessThan(r * 0.5);
	});

	it("should replace a half-transparent source color", async () => {
		const pixels = await renderTriangle(
			{ r: 1, g: 0, b: 0, a: 0.5 },
			redToBlue(),
		);

		const { r, b } = colorAt(pixels, INSIDE);
		expect(b).toBeGreaterThan(r);
	});
});

async function renderTriangle(
	color: RawRGBA,
	filter: Filter,
): Promise<Uint8Array> {
	const triangle = mockPath("triangle-1");
	triangle.segments = [
		lineSeg({ x: 100, y: -100 }, { start: { x: -100, y: -100 } }),
		lineSeg({ x: -100, y: 100 }),
		lineSeg({ x: -100, y: -100 }, { isClosed: true }),
	];
	triangle.filters = [fill(color), filter];
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
	{ x, y }: { x: number; y: number },
): RawRGBA {
	const offset = (y * 800 + x) * 4;
	return {
		r: pixels[offset] / 255,
		g: pixels[offset + 1] / 255,
		b: pixels[offset + 2] / 255,
		a: pixels[offset + 3] / 255,
	};
}

function fill(color: RawRGBA): FillAppearance {
	return {
		uid: "fill-1",
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: { type: "solid", color: { type: "rgb", ...color } },
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

/** Two levels: every channel snaps to 0 or 1 around 0.5. */
function posterize(): HKPosterizationFilter {
	return {
		uid: "posterization-1",
		processor: "hk:posterization",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: { levels: 2, strength: 1 },
		},
	};
}

function duotoneMap(): HKGradientMapFilter {
	return {
		uid: "gradient-map-1",
		processor: "hk:gradient-map",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: { preset: "duotone", colorStops: "", strength: 1 },
		},
	};
}

/** Matches only colors close to pure red. */
function redToBlue(): HKColorReplacementFilter {
	return {
		uid: "color-replacement-1",
		processor: "hk:color-replacement",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				sourceColor: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
				replacementColor: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
				tolerance: 0.1,
				preserveLuminance: false,
				mix: 1,
				featherEdges: 0,
				previewMask: false,
			},
		},
	};
}
