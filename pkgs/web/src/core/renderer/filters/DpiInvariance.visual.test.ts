import { describe, expect, it } from "vitest";
import {
	createDefaultDocument,
	createDefaultLayer,
	createDefaultTransform,
} from "../../document/factory";
import type {
	Document,
	FillAppearance,
	Filter,
	Path,
	PathSegment,
	RawRGBA,
} from "../../schema";
import {
	captureTexturePixels,
	createTestRenderer,
	renderWithViewport,
} from "../../testUtils/visualRegression";

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
/** The two rasterization scales a document realistically swings between. */
const LOW_DPI = 72;
const HIGH_DPI = 300;
const TRANSPARENT: RawRGBA = { r: 0, g: 0, b: 0, a: 0 };

/**
 * A filter's spatial parameters are authored in world px, and the renderer
 * rasterizes filter passes at R = rasterizationDpi / 72. Multiplying by R is
 * necessary but not sufficient: a TEXEL-space ceiling or a fixed tap count
 * applied AFTER that multiplication makes the same document come out
 * differently at a different DPI, and nothing in the suite noticed.
 *
 * So assert the property itself — render the same document at 72 and at 300
 * DPI and require the images to agree.
 */
describe("filter output is invariant to rasterization DPI", () => {
	it.each([
		[
			"drop-shadow (wide radius)",
			appearance("drop-shadow", {
				offsetX: 18,
				offsetY: -18,
				blurRadius: 26,
				spreadRadius: 0,
				shadowOpacity: 1,
				shadowColor: { type: "rgb", r: 0.9, g: 0.1, b: 0.1, a: 1 },
			}),
		],
		[
			"drop-shadow (wide radius + spread)",
			appearance("drop-shadow", {
				offsetX: 12,
				offsetY: -12,
				blurRadius: 22,
				spreadRadius: 8,
				shadowOpacity: 1,
				shadowColor: { type: "rgb", r: 0.9, g: 0.1, b: 0.1, a: 1 },
			}),
		],
		[
			"hk:husky (long smear)",
			appearance("hk:husky", {
				angle: 20,
				horizontalEnabled: true,
				verticalEnabled: false,
				blurIntensity: 18,
				bleedIntensity: 0,
				breathiness: 0,
				melt: 0.4,
				maxOffset: 48,
				randomSeed: 0.42,
			}),
		],
		["blur (wide radius)", appearance("blur", { radius: 30, opacity: 1 })],
		[
			"hk:bloom",
			appearance("hk:bloom", {
				radius: 24,
				threshold: 0.2,
				intensity: 1,
				blurStrength: 1,
			}),
		],
		[
			"svg:gaussian-blur",
			appearance("svg:gaussian-blur", {
				in: "previous",
				stdDeviationX: 12,
				stdDeviationY: 12,
			}),
		],
		[
			"svg:morphology (dilate)",
			appearance("svg:morphology", {
				in: "previous",
				operator: "dilate",
				radiusX: 10,
				radiusY: 10,
			}),
		],
		[
			"svg:drop-shadow",
			appearance("svg:drop-shadow", {
				in: "previous",
				dx: 16,
				dy: -16,
				stdDeviation: 10,
				color: { type: "rgb", r: 0.1, g: 0.1, b: 0.9, a: 1 },
				opacity: 1,
			}),
		],
		[
			"svg:convolve-matrix",
			appearance("svg:convolve-matrix", {
				in: "previous",
				order: 5,
				kernelMatrix: Array.from({ length: 25 }, () => 1),
				divisor: null,
				bias: 0,
				edgeMode: "duplicate",
				preserveAlpha: false,
			}),
		],
		[
			"svg:turbulence",
			appearance("svg:turbulence", {
				type: "fractalNoise",
				baseFrequencyX: 0.03,
				baseFrequencyY: 0.03,
				numOctaves: 3,
				seed: 5,
				stitchTiles: false,
			}),
		],
	] as const)("should render %s the same at 72 and 300 DPI", async (_name, filter) => {
		const low = await renderAtDpi(filter, LOW_DPI);
		const high = await renderAtDpi(filter, HIGH_DPI);

		expectImagesAgree(low, high);
	});
});

// Helpers

/** Mean absolute per-channel difference, on 0-255. */
function expectImagesAgree(a: Uint8Array, b: Uint8Array): void {
	expect(a.length).toBe(b.length);
	let total = 0;
	let covered = 0;
	for (let i = 0; i < a.length; i += 4) {
		if (a[i + 3] < 4 && b[i + 3] < 4) continue;
		covered++;
		for (let c = 0; c < 4; c++) total += Math.abs(a[i + c] - b[i + c]);
	}
	// A filter that actually drew something, so a pair of blank frames cannot
	// pass by agreeing on nothing.
	expect(covered).toBeGreaterThan(1000);
	// Resampling at two different rasterization scales never matches bit for
	// bit; the failures this guards against are structural (a clamped radius,
	// a smear breaking into ghost copies) and land far above this.
	expect(total / (covered * 4)).toBeLessThan(6);
}

async function renderAtDpi(
	filter: Filter,
	rasterizationDpi: number,
): Promise<Uint8Array> {
	const { renderer, canvas } = await createTestRenderer();
	const document = createDocument(filter, rasterizationDpi);
	const texture = await renderWithViewport(
		renderer,
		canvas,
		document,
		{ x: 0, y: 0, zoom: 1, rotation: 0 },
		TRANSPARENT,
	);
	const device = renderer.getDevice();
	if (!device) throw new Error("GPU device is unavailable");
	const pixels = await captureTexturePixels(
		device,
		texture,
		CANVAS_WIDTH,
		CANVAS_HEIGHT,
	);
	texture.destroy();
	return pixels;
}

function createDocument(filter: Filter, rasterizationDpi: number): Document {
	const document = createDefaultDocument("dpi-invariance");
	document.rasterizationDpi = rasterizationDpi;
	const layer = createDefaultLayer("layer-1", "Layer");
	const path: Path = {
		id: "path-1",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		segments: squareSegments(140),
		filters: [
			{
				uid: "fill-1",
				processor: "fill",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						fill: {
							type: "solid",
							color: { type: "rgb", r: 0.9, g: 0.85, b: 0.2, a: 1 },
						},
					},
				},
			} satisfies FillAppearance,
			filter,
		],
	};
	document.objects[path.id] = path;
	layer.elementIds.push(path.id);
	document.layers = [layer];
	return document;
}

function appearance(
	processor: string,
	params: Record<string, unknown>,
): Filter {
	return {
		uid: `${processor}-1`,
		processor,
		enabled: true,
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params },
	} as unknown as Filter;
}

function squareSegments(size: number): PathSegment[] {
	const half = size / 2;
	const points = [
		{ x: -half, y: half },
		{ x: half, y: half },
		{ x: half, y: -half },
		{ x: -half, y: -half },
	];
	return points.map((point, index) => ({
		start: index === 0 ? point : undefined,
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: points[(index + 1) % points.length],
		startPressure: 1,
		endPressure: 1,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: index === 0,
		isClosed: index === points.length - 1,
	}));
}
