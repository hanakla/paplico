import { describe, expect, it } from "vitest";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../document/factory";
import {
	type FillAppearance,
	generateUid,
	type Path,
	type PathSegment,
} from "../../schema";
import {
	captureTexturePixels,
	createTestRenderer,
	renderArtboardForTest,
} from "../../testUtils/visualRegression";
import type { NoiseFilter, NoiseParams } from "./NoiseFilterProcessor";

// The noise pattern is decided on the 72 DPI grid. A higher DPI may only add
// finer grain inside each 72 DPI cell, so area-averaging it back must return
// the 72 DPI image.

const HIGH_DPI_FACTOR = 4;

describe("Noise - Rasterization DPI", () => {
	for (const colorMode of ["monochrome", "color"] as const) {
		it(`should keep the 72 DPI pattern when the ${colorMode} output at 288 DPI is averaged back`, async () => {
			const { pixels72, pixelsHigh, width, height } =
				await renderAt72AndHigh(colorMode);

			const downscaled = downscaleByBlock(pixelsHigh, width, height);
			let totalDiff = 0;
			for (let i = 0; i < pixels72.length; i++) {
				totalDiff += Math.abs(pixels72[i] - downscaled[i]);
			}

			expect(totalDiff / pixels72.length).toBeLessThan(2);
		});
	}

	it("should add finer grain inside each 72 DPI cell at 288 DPI", async () => {
		const { pixelsHigh, width, height } = await renderAt72AndHigh("monochrome");

		const highWidth = width * HIGH_DPI_FACTOR;
		let totalSpread = 0;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				let min = 255;
				let max = 0;
				for (let oy = 0; oy < HIGH_DPI_FACTOR; oy++) {
					for (let ox = 0; ox < HIGH_DPI_FACTOR; ox++) {
						const i =
							((y * HIGH_DPI_FACTOR + oy) * highWidth +
								x * HIGH_DPI_FACTOR +
								ox) *
							4;
						min = Math.min(min, pixelsHigh[i]);
						max = Math.max(max, pixelsHigh[i]);
					}
				}
				totalSpread += max - min;
			}
		}

		expect(totalSpread / (width * height)).toBeGreaterThan(20);
	});
});

async function renderAt72AndHigh(colorMode: NoiseParams["colorMode"]) {
	const { renderer } = await createTestRenderer();
	const doc = createNoiseDoc(colorMode);
	const artboard = doc.artboards[0];

	doc.rasterizationDpi = 72;
	const tex72 = await renderArtboardForTest(renderer, artboard, doc, 1);
	doc.rasterizationDpi = 72 * HIGH_DPI_FACTOR;
	const texHigh = await renderArtboardForTest(
		renderer,
		artboard,
		doc,
		HIGH_DPI_FACTOR,
	);

	const device = renderer.getDevice();
	if (!device) throw new Error("Test renderer has no GPU device");

	const pixels72 = await captureTexturePixels(
		device,
		tex72,
		tex72.width,
		tex72.height,
	);
	const pixelsHigh = await captureTexturePixels(
		device,
		texHigh,
		texHigh.width,
		texHigh.height,
	);
	expect(texHigh.width).toBe(tex72.width * HIGH_DPI_FACTOR);
	expect(texHigh.height).toBe(tex72.height * HIGH_DPI_FACTOR);

	const result = {
		pixels72,
		pixelsHigh,
		width: tex72.width,
		height: tex72.height,
	};
	tex72.destroy();
	texHigh.destroy();
	return result;
}

function createNoiseDoc(colorMode: NoiseParams["colorMode"]) {
	const doc = createDefaultDocument(`noise-dpi-${colorMode}`);
	const layer = createDefaultLayer("layer-bg", "Background");

	const noise: NoiseFilter = {
		uid: generateUid("filter"),
		processor: "noise",
		opacity: 1,
		blendMode: "normal",
		enabled: true,
		paramData: {
			version: "1",
			params: { mixRate: 1, seed: 42, colorMode },
		},
	};

	// Larger than the artboard so every compared pixel is fully covered.
	const rect = createFilledPath(
		rectSegments(0, 0, 400, 300),
		{ r: 0.3, g: 0.5, b: 0.8, a: 1 },
		[noise],
	);

	doc.objects[rect.id] = rect;
	layer.elementIds.push(rect.id);
	doc.layers = [layer];
	doc.artboards.push(createArtboard("ab-noise", "Noise", -80, 60, 160, 120));
	return doc;
}

/** Averages each HIGH_DPI_FACTOR² block down to one pixel. */
function downscaleByBlock(
	src: Uint8Array,
	dstW: number,
	dstH: number,
): Uint8Array {
	const srcW = dstW * HIGH_DPI_FACTOR;
	const dst = new Uint8Array(dstW * dstH * 4);
	for (let y = 0; y < dstH; y++) {
		for (let x = 0; x < dstW; x++) {
			for (let c = 0; c < 4; c++) {
				let sum = 0;
				for (let oy = 0; oy < HIGH_DPI_FACTOR; oy++) {
					for (let ox = 0; ox < HIGH_DPI_FACTOR; ox++) {
						sum +=
							src[
								((y * HIGH_DPI_FACTOR + oy) * srcW + x * HIGH_DPI_FACTOR + ox) *
									4 +
									c
							];
					}
				}
				dst[(y * dstW + x) * 4 + c] = Math.round(sum / HIGH_DPI_FACTOR ** 2);
			}
		}
	}
	return dst;
}

function createFilledPath(
	segments: PathSegment[],
	fill: { r: number; g: number; b: number; a: number },
	filters: Path["filters"],
): Path {
	const fillApp: FillAppearance = {
		uid: generateUid("fill"),
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: { type: "solid", color: { type: "rgb", ...fill } },
			},
		},
	};

	return {
		type: "path",
		id: generateUid("path"),
		opacity: 1,
		blendMode: "normal",
		segments,
		filters: [fillApp, ...(filters ?? [])],
		transform: createDefaultTransform(),
	};
}

function lineSegment(
	sx: number,
	sy: number,
	ex: number,
	ey: number,
	moved: boolean,
	closed?: boolean,
): PathSegment {
	return {
		start: moved ? { x: sx, y: sy } : undefined,
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: { x: ex, y: ey },
		startPressure: 1,
		endPressure: 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: moved,
		isClosed: closed,
	};
}

function rectSegments(
	x: number,
	y: number,
	w: number,
	h: number,
): PathSegment[] {
	return [
		lineSegment(x - w / 2, y + h / 2, x + w / 2, y + h / 2, true),
		lineSegment(x + w / 2, y + h / 2, x + w / 2, y - h / 2, false),
		lineSegment(x + w / 2, y - h / 2, x - w / 2, y - h / 2, false),
		lineSegment(x - w / 2, y - h / 2, x - w / 2, y + h / 2, false, true),
	];
}
