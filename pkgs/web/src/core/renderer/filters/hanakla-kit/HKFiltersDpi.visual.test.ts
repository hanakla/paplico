import pixelmatch from "pixelmatch";
import { beforeAll, describe, expect, it } from "vitest";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../../document/factory";
import {
	type FillAppearance,
	generateUid,
	type Path,
	type PathSegment,
} from "../../../schema";
import { loadTestFont } from "../../../testUtils/fontSetup";
import {
	captureTexturePixels,
	createTestRenderer,
	expectVisualMatch,
	renderArtboardForTest,
	renderWithViewport,
} from "../../../testUtils/visualRegression";
import { getFontManager } from "../../../typography/fonts";
import type { HKHuskyFilter } from "./HKHuskyHandler";
import type { HKOutlineFilter } from "./HKOutlineHandler";
import type { HKVhsInterlaceFilter } from "./HKVhsInterlaceHandler";

beforeAll(() => {
	loadTestFont(getFontManager());
});

// Both filters size every spatial parameter in world px and scale it by the
// rasterization scale (R = dpi/72), so the rendered FORM must stay identical
// across DPI — only crispness (silhouette tracking, AA rims, noise sampling
// density) may change. These baselines lock that in at a fixed viewport.

describe("HK Outline - Rasterization DPI", () => {
	for (const dpi of [72, 150, 300] as const) {
		it(`renders outline at ${dpi} DPI`, async () => {
			const { renderer, canvas } = await createTestRenderer();
			const doc = createOutlineDoc();
			doc.rasterizationDpi = dpi;
			const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

			const texture = await renderWithViewport(renderer, canvas, doc, viewport);

			await expectVisualMatch(
				renderer,
				texture,
				texture.width,
				texture.height,
				`hk-outline-dpi${dpi}`,
				{ threshold: 0.1, maxDiffPercentage: 0.5, allowEmpty: true },
			);

			texture.destroy();
		});
	}
});

describe("HK Husky - Rasterization DPI", () => {
	for (const dpi of [72, 150, 300] as const) {
		it(`renders husky at ${dpi} DPI`, async () => {
			const { renderer, canvas } = await createTestRenderer();
			const doc = createHuskyDoc();
			doc.rasterizationDpi = dpi;
			const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

			const texture = await renderWithViewport(renderer, canvas, doc, viewport);

			await expectVisualMatch(
				renderer,
				texture,
				texture.width,
				texture.height,
				`hk-husky-dpi${dpi}`,
				{ threshold: 0.1, maxDiffPercentage: 0.5, allowEmpty: true },
			);

			texture.destroy();
		});
	}
});

describe("HK VHS Interlace - Rasterization DPI invariance", () => {
	// Every spatial term in the VHS shader is anchored to 72dpi world px
	// (scanline index, noise cells, offsets scaled by R = dpi/72), so a
	// 300 DPI export downscaled to the 72 DPI size must look nearly the
	// same as the 72 DPI export. The two renders are compared directly —
	// no stored baseline.
	it("should look close to the 72 DPI output when the 300 DPI output is downscaled to its size", async () => {
		const { renderer } = await createTestRenderer();
		const doc = createVhsDoc();
		const artboard = doc.artboards[0];

		doc.rasterizationDpi = 72;
		const tex72 = await renderArtboardForTest(renderer, artboard, doc, 1);
		doc.rasterizationDpi = 300;
		const tex300 = await renderArtboardForTest(
			renderer,
			artboard,
			doc,
			300 / 72,
		);

		const device = renderer.getDevice();
		if (!device) throw new Error("Test renderer has no GPU device");

		const pixels72 = await captureTexturePixels(
			device,
			tex72,
			tex72.width,
			tex72.height,
		);
		const pixels300 = await captureTexturePixels(
			device,
			tex300,
			tex300.width,
			tex300.height,
		);
		const downscaled = downscaleByArea(
			pixels300,
			tex300.width,
			tex300.height,
			tex72.width,
			tex72.height,
		);

		// Sub-pixel edge phase legitimately differs between the 72 DPI
		// rasterizer's AA and the area-averaged 300 DPI edges. A one-pixel
		// blur on both sides removes that phase noise before comparing,
		// while a real DPI-invariance break moves whole regions and
		// survives the blur.
		const diffPixels = pixelmatch(
			boxBlur3(pixels72, tex72.width, tex72.height),
			boxBlur3(downscaled, tex72.width, tex72.height),
			undefined,
			tex72.width,
			tex72.height,
			{ threshold: 0.3 },
		);
		const diffPercentage = (diffPixels / (tex72.width * tex72.height)) * 100;

		expect(diffPercentage).toBeLessThan(0.01);

		tex72.destroy();
		tex300.destroy();
	});
});

function createOutlineDoc() {
	const doc = createDefaultDocument("hk-outline-vrt");
	const layer = createDefaultLayer("layer-bg", "Background");

	const outline = (): HKOutlineFilter => ({
		uid: generateUid("filter"),
		processor: "hk:outline",
		opacity: 1,
		blendMode: "normal",
		enabled: true,
		paramData: {
			version: "1",
			params: {
				thickness: 12,
				color: { type: "rgb", r: 0.9, g: 0.15, b: 0.3, a: 1 },
				opacity: 1,
			},
		},
	});

	// A star (concave corners) and a rectangle (straight edges + corners)
	// exercise uniform outline width on both convex and concave geometry.
	const star = createFilledPath(
		starSegments(-95, 0, 70, 30, 7),
		{ r: 0.2, g: 0.4, b: 0.95, a: 1 },
		[outline()],
	);
	const rect = createFilledPath(
		rectSegments(95, 0, 130, 90),
		{ r: 0.15, g: 0.75, b: 0.4, a: 1 },
		[outline()],
	);

	for (const el of [star, rect]) {
		doc.objects[el.id] = el;
		layer.elementIds.push(el.id);
	}
	doc.layers = [layer];
	doc.artboards.push(createArtboard("ab-outline", "Outline", 0, 0, 400, 220));
	return doc;
}

function createHuskyDoc() {
	const doc = createDefaultDocument("hk-husky-vrt");
	const layer = createDefaultLayer("layer-bg", "Background");

	const husky = (): HKHuskyFilter => ({
		uid: generateUid("filter"),
		processor: "hk:husky",
		opacity: 1,
		blendMode: "normal",
		enabled: true,
		paramData: {
			version: "1",
			params: {
				angle: 30,
				horizontalEnabled: true,
				verticalEnabled: true,
				blurIntensity: 12,
				bleedIntensity: 0.5,
				breathiness: 0.6,
				melt: 0.6,
				maxOffset: 20,
				randomSeed: 42,
			},
		},
	});

	const star = createFilledPath(
		starSegments(-95, 0, 70, 30, 7),
		{ r: 0.9, g: 0.25, b: 0.25, a: 1 },
		[husky()],
	);
	const rect = createFilledPath(
		rectSegments(95, 0, 130, 90),
		{ r: 0.35, g: 0.3, b: 0.9, a: 1 },
		[husky()],
	);

	for (const el of [star, rect]) {
		doc.objects[el.id] = el;
		layer.elementIds.push(el.id);
	}
	doc.layers = [layer];
	doc.artboards.push(createArtboard("ab-husky", "Husky", 0, 0, 400, 220));
	return doc;
}

function createVhsDoc() {
	const doc = createDefaultDocument("hk-vhs-dpi-vrt");
	const layer = createDefaultLayer("layer-bg", "Background");

	const vhs = (): HKVhsInterlaceFilter => ({
		uid: generateUid("filter"),
		processor: "hk:vhs-interlace",
		opacity: 1,
		blendMode: "normal",
		enabled: true,
		paramData: {
			version: "1",
			params: {
				intensity: 1,
				generation: 2,
				chromaBleed: 0.5,
				colorShift: 0.01,
				lumaSoftness: 0.3,
				ringing: 0.3,
				lineJitter: 0.3,
				verticalJitter: 0.02,
				trackingError: 0.3,
				headSwitching: 0.35,
				headSwitchingHeight: 10,
				noise: 0.3,
				noiseDistortion: 0.2,
				chromaNoise: 0.3,
				dropouts: 0.4,
				dropoutLength: 0.4,
				brightnessJitter: 0.05,
				scanlines: 0.4,
				interlaceGap: 2,
				combing: 0.3,
				tilt: 0,
				blackLift: 0.2,
				desaturation: 0.15,
				randomSeed: 42,
				enableVHSColor: false,
				vhsColor: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
				applyToTransparent: false,
			},
		},
	});

	const star = createFilledPath(
		starSegments(-95, 0, 70, 30, 7),
		{ r: 0.9, g: 0.25, b: 0.25, a: 1 },
		[vhs()],
	);
	const rect = createFilledPath(
		rectSegments(95, 0, 130, 90),
		{ r: 0.35, g: 0.3, b: 0.9, a: 1 },
		[vhs()],
	);

	for (const el of [star, rect]) {
		doc.objects[el.id] = el;
		layer.elementIds.push(el.id);
	}
	doc.layers = [layer];
	doc.artboards.push(createArtboard("ab-vhs", "VHS", 0, 0, 400, 220));
	return doc;
}

/** Exact area-average downscale: every source pixel contributes to the
 *  dest pixels it overlaps with fractional weights, so non-integer
 *  ratios (300/72) produce no binning phase error at cell boundaries. */
function downscaleByArea(
	src: Uint8Array,
	srcWidth: number,
	srcHeight: number,
	destWidth: number,
	destHeight: number,
): Uint8Array {
	const ratioX = srcWidth / destWidth;
	const ratioY = srcHeight / destHeight;
	const out = new Uint8Array(destWidth * destHeight * 4);

	for (let dy = 0; dy < destHeight; dy++) {
		const y0 = dy * ratioY;
		const y1 = Math.min(y0 + ratioY, srcHeight);
		for (let dx = 0; dx < destWidth; dx++) {
			const x0 = dx * ratioX;
			const x1 = Math.min(x0 + ratioX, srcWidth);
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let weightSum = 0;

			for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
				const weightY = Math.min(sy + 1, y1) - Math.max(sy, y0);
				for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
					const weight = (Math.min(sx + 1, x1) - Math.max(sx, x0)) * weightY;
					const s = (sy * srcWidth + sx) * 4;
					r += src[s] * weight;
					g += src[s + 1] * weight;
					b += src[s + 2] * weight;
					a += src[s + 3] * weight;
					weightSum += weight;
				}
			}

			const o = (dy * destWidth + dx) * 4;
			out[o] = Math.round(r / weightSum);
			out[o + 1] = Math.round(g / weightSum);
			out[o + 2] = Math.round(b / weightSum);
			out[o + 3] = Math.round(a / weightSum);
		}
	}
	return out;
}

/** 3×3 edge-clamped box blur used to suppress sub-pixel phase noise
 *  before the cross-DPI comparison. */
function boxBlur3(src: Uint8Array, width: number, height: number): Uint8Array {
	const out = new Uint8Array(src.length);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let count = 0;

			for (let dy = -1; dy <= 1; dy++) {
				const sy = y + dy;
				if (sy < 0 || sy >= height) continue;
				for (let dx = -1; dx <= 1; dx++) {
					const sx = x + dx;
					if (sx < 0 || sx >= width) continue;
					const s = (sy * width + sx) * 4;
					r += src[s];
					g += src[s + 1];
					b += src[s + 2];
					a += src[s + 3];
					count++;
				}
			}

			const o = (y * width + x) * 4;
			out[o] = Math.round(r / count);
			out[o + 1] = Math.round(g / count);
			out[o + 2] = Math.round(b / count);
			out[o + 3] = Math.round(a / count);
		}
	}
	return out;
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

function starSegments(
	cx: number,
	cy: number,
	outer: number,
	inner: number,
	points: number,
): PathSegment[] {
	const vertices: { x: number; y: number }[] = [];
	for (let i = 0; i < points * 2; i++) {
		const radius = i % 2 === 0 ? outer : inner;
		const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
		vertices.push({
			x: cx + Math.cos(angle) * radius,
			y: cy + Math.sin(angle) * radius,
		});
	}
	return vertices.map((v, i) => {
		const next = vertices[(i + 1) % vertices.length];
		return lineSegment(
			v.x,
			v.y,
			next.x,
			next.y,
			i === 0,
			i === vertices.length - 1 ? true : undefined,
		);
	});
}
