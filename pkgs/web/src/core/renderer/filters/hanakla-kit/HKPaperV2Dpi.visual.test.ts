import pixelmatch from "pixelmatch";
import { describe, expect, it } from "vitest";
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
import {
	captureTexturePixels,
	createTestRenderer,
	expectVisualMatch,
	renderArtboardForTest,
	renderWithViewport,
} from "../../../testUtils/visualRegression";
import type { HKPaperV2Filter } from "./HKPaperV2Handler";

// The paper generator plans fibers and anchors every noise/line term in
// world px, so the rendered sheet must keep its FORM across rasterization
// DPI — only crispness may change. Locked per representative type:
// woodfree (wire mark + specks), kouzo (branching washi fibers + laid
// lines), tengujou (translucent compositing).

describe("HK Paper V2 - Rasterization DPI", () => {
	for (const paperType of ["woodfree", "kouzo", "tengujou"] as const) {
		for (const dpi of [72, 150, 300] as const) {
			it(`renders ${paperType} at ${dpi} DPI`, async () => {
				const { renderer, canvas } = await createTestRenderer();
				const doc = createPaperDoc(paperType);
				doc.rasterizationDpi = dpi;
				const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

				const texture = await renderWithViewport(
					renderer,
					canvas,
					doc,
					viewport,
				);

				await expectVisualMatch(
					renderer,
					texture,
					texture.width,
					texture.height,
					`hk-paper-${paperType}-dpi${dpi}`,
					{ threshold: 0.1, maxDiffPercentage: 0.5, allowEmpty: true },
				);

				texture.destroy();
			});
		}
	}

	it("should look close to the 72 DPI output when the 300 DPI output is downscaled to its size", async () => {
		const { renderer } = await createTestRenderer();
		const doc = createPaperDoc("kouzo");
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

		const diffPixels = pixelmatch(
			boxBlur3(pixels72, tex72.width, tex72.height),
			boxBlur3(downscaled, tex72.width, tex72.height),
			undefined,
			tex72.width,
			tex72.height,
			{ threshold: 0.3 },
		);
		const diffPercentage = (diffPixels / (tex72.width * tex72.height)) * 100;

		// Fiber AA and per-world-px noise crispness legitimately differ across
		// DPI; a form-level break (grid/fiber layout shifting) blows far past
		// this bound.
		expect(diffPercentage).toBeLessThan(1.5);

		tex72.destroy();
		tex300.destroy();
	});
});

function createPaperDoc(
	paperType: HKPaperV2Filter["paramData"]["params"]["paperType"],
) {
	const doc = createDefaultDocument(`hk-paper-vrt-${paperType}`);
	const layer = createDefaultLayer("layer-bg", "Background");

	const paper = (): HKPaperV2Filter => ({
		uid: generateUid("filter"),
		processor: "hk:paper-v2",
		opacity: 1,
		blendMode: "normal",
		enabled: true,
		paramData: {
			version: "1",
			params: {
				paperType,
				beatingDegree: 0.5,
				fiberAmount: 1,
				fiberDarkness: 0.3,
				seed: 42,
				invert: false,
				lightingEnabled: true,
				lightIntensity: 0.5,
				lightAngle: 135,
				depthEffect: 0.4,
				surfaceRoughness: 0.5,
				maxFiberLength: 100,
				formationStrength: 1,
				laidLineStrength: 1,
				sheerness: 1,
			},
		},
	});

	const rect = createFilledPath(
		rectSegments(0, 0, 320, 160),
		{ r: 0.3, g: 0.5, b: 0.8, a: 1 },
		[paper()],
	);

	doc.objects[rect.id] = rect;
	layer.elementIds.push(rect.id);
	doc.layers = [layer];
	doc.artboards.push(createArtboard("ab-paper", "Paper", 0, 0, 400, 220));
	return doc;
}

/** Exact area-average downscale (same as HKFiltersDpi.visual.test.ts). */
function downscaleByArea(
	src: Uint8Array,
	srcW: number,
	srcH: number,
	dstW: number,
	dstH: number,
): Uint8Array {
	const dst = new Uint8Array(dstW * dstH * 4);
	const scaleX = srcW / dstW;
	const scaleY = srcH / dstH;
	for (let dy = 0; dy < dstH; dy++) {
		const sy0 = dy * scaleY;
		const sy1 = (dy + 1) * scaleY;
		for (let dx = 0; dx < dstW; dx++) {
			const sx0 = dx * scaleX;
			const sx1 = (dx + 1) * scaleX;
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let total = 0;
			for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
				const cy = Math.min(sy1, sy + 1) - Math.max(sy0, sy);
				for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
					const cx = Math.min(sx1, sx + 1) - Math.max(sx0, sx);
					const w = cx * cy;
					const i = (sy * srcW + sx) * 4;
					r += src[i] * w;
					g += src[i + 1] * w;
					b += src[i + 2] * w;
					a += src[i + 3] * w;
					total += w;
				}
			}
			const o = (dy * dstW + dx) * 4;
			dst[o] = Math.round(r / total);
			dst[o + 1] = Math.round(g / total);
			dst[o + 2] = Math.round(b / total);
			dst[o + 3] = Math.round(a / total);
		}
	}
	return dst;
}

function boxBlur3(src: Uint8Array, width: number, height: number): Uint8Array {
	const dst = new Uint8Array(src.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let n = 0;
			for (let oy = -1; oy <= 1; oy++) {
				const sy = y + oy;
				if (sy < 0 || sy >= height) continue;
				for (let ox = -1; ox <= 1; ox++) {
					const sx = x + ox;
					if (sx < 0 || sx >= width) continue;
					const i = (sy * width + sx) * 4;
					r += src[i];
					g += src[i + 1];
					b += src[i + 2];
					a += src[i + 3];
					n++;
				}
			}
			const o = (y * width + x) * 4;
			dst[o] = Math.round(r / n);
			dst[o + 1] = Math.round(g / n);
			dst[o + 2] = Math.round(b / n);
			dst[o + 3] = Math.round(a / n);
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
