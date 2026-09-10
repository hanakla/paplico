import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createArtboard, createDefaultDocument } from "../../document/factory";
import {
	type AnyArtObject,
	type Artboard,
	type Document,
	type EmbeddedFile,
	type Filter,
	generateUid,
	type ImageObject,
} from "../../schema";
import { loadTestFont } from "../../testUtils/fontSetup";
import { loadTestDocument } from "../../testUtils/loadTestDocument";
import { rectPath, solidFillAppearance } from "../../testUtils/svgFixtures";
import { expectSvgMatchesGpu } from "../../testUtils/svgGpuParity";
import { createTestRenderer } from "../../testUtils/visualRegression";
import { getFontManager } from "../../typography/fonts";

/**
 * SVG export fidelity tests. Each artboard is exported to SVG and rasterized
 * with resvg, then verified two ways:
 * 1. DIRECTLY against the renderer's PNG output of the same artboard — the
 *    export must reproduce what the app renders.
 * 2. Against a checked-in baseline of the resvg rasterization itself
 *    (svg-export-*.png) — pixel-tight regression tracking of the SVG output.
 */

/**
 * Artboard name → allowed diff, as % of the GPU render's CONTENT pixels
 * (non-background) — never of the whole canvas, which would let a sparse
 * artboard hide a fully broken element inside its whitespace. Sub-pixel edge
 * shifts and the GPU-vs-resvg AA-density gap are already excluded by the
 * two-stage judgement, so what these thresholds allow is real divergence.
 * Measured residuals: Text 2.49%, Complex Text Flows 1.41%, all others
 * ≤0.20% — thresholds sit at roughly 1.5–2× the measured value.
 */
const ARTBOARDS: ReadonlyArray<[artboardName: string, maxDiff: number]> = [
	["Main", 1],
	["Text", 4],
	["Filters", 1],
	["BlendModes", 1],
	["Transforms", 1],
	["Opacity", 1],
	["Groups", 1],
	["Masks", 1],
	["CompoundPaths", 1],
	["StrokeGradients", 1],
	["MultiFilters", 1],
	["SubFilters", 1],
	["ObjectBlend", 1],
	["Mesh Object", 1],
	["Complex Text Flows", 3],
	["Patterns", 1],
	["SVG Filters", 3],
];

let originalOffscreenCanvas: typeof globalThis.OffscreenCanvas | undefined;

beforeAll(() => {
	loadTestFont(getFontManager());
	// Raster chunks encode PNGs through OffscreenCanvas, which node/happy-dom
	// cannot rasterize — substitute a pngjs-backed stand-in for this suite.
	originalOffscreenCanvas = globalThis.OffscreenCanvas;
	globalThis.OffscreenCanvas =
		TestOffscreenCanvas as unknown as typeof globalThis.OffscreenCanvas;
});

afterAll(() => {
	globalThis.OffscreenCanvas =
		originalOffscreenCanvas as typeof globalThis.OffscreenCanvas;
});

describe("SVG Export vs GPU render - testDocument artboards", () => {
	for (const [artboardName, maxDiff] of ARTBOARDS) {
		it(`Artboard '${artboardName}' matches the PNG render`, async () => {
			const { renderer } = await createTestRenderer();
			const doc = await loadTestDocument();
			const artboard = doc.artboards.find((ab) => ab.name === artboardName);
			if (!artboard) throw new Error(`Artboard not found: ${artboardName}`);

			await expectSvgMatchesGpu(
				renderer,
				artboard,
				doc,
				artboardName.toLowerCase().replaceAll(" ", "-"),
				maxDiff,
			);
		});
	}
});

describe("SVG Export vs GPU render - 3D effects", () => {
	it("extrude3d and 3d-rotate elements match the PNG render", async () => {
		const { renderer } = await createTestRenderer();
		const { doc, artboard } = buildSolid3DDocument();

		// The extrusion must not be clipped to the flat bbox and the rotation
		// must keep its perspective — both blow far past this threshold when
		// broken (measured residual: 0.00%).
		await expectSvgMatchesGpu(renderer, artboard, doc, "solid3d", 1);
	});
});

describe("SVG Export vs GPU render - native SVG filter primitives", () => {
	it("exact primitives match the PNG render", async () => {
		const { renderer } = await createTestRenderer();
		const { doc, artboard } = buildSvgFilterExactDocument();
		await expectSvgMatchesGpu(renderer, artboard, doc, "svg-filters-exact", 1);
	});

	it("blur and noise primitives match the PNG render", async () => {
		const { renderer } = await createTestRenderer();
		const { doc, artboard } = buildSvgFilterNoiseDocument();
		// resvg approximates its Gaussian (IIR / box) and displaces with a
		// nearest fetch, so these get more slack than the exact primitives.
		await expectSvgMatchesGpu(renderer, artboard, doc, "svg-filters-noise", 3);
	});
});

// --- Synthetic SVG filter fixtures ---

/** Integer-aligned squares carrying the primitives resvg reproduces exactly. */
function buildSvgFilterExactDocument(): { doc: Document; artboard: Artboard } {
	const doc = createDefaultDocument("doc-svg-filters-exact");
	const artboard = createArtboard(
		"ab-svg-exact",
		"SvgFiltersExact",
		0,
		0,
		480,
		360,
	);
	doc.artboards = [artboard];

	const cell = (index: number): { x: number; y: number } => ({
		x: -180 + (index % 4) * 120,
		y: 90 - Math.floor(index / 4) * 120,
	});
	const elements: AnyArtObject[] = [
		rectPath("el-offset", cell(0), 60, 60, [
			solidFillAppearance(0.9, 0.3, 0.2),
			svgFilter("svg:offset", { in: "previous", dx: 12, dy: -8 }),
		]),
		rectPath("el-flood", cell(1), 60, 60, [
			solidFillAppearance(0.2, 0.4, 0.9),
			svgFilter("svg:flood", {
				color: { type: "rgb", r: 0.1, g: 0.7, b: 0.3, a: 1 },
				opacity: 0.6,
			}),
		]),
		rectPath("el-color-matrix", cell(2), 60, 60, [
			solidFillAppearance(0.9, 0.5, 0.1),
			svgFilter("svg:color-matrix", {
				in: "previous",
				type: "hueRotate",
				values: [200],
			}),
		]),
		rectPath("el-transfer", cell(3), 60, 60, [
			solidFillAppearance(0.3, 0.6, 0.8),
			svgFilter("svg:component-transfer", {
				in: "previous",
				r: { type: "gamma", amplitude: 1, exponent: 2, offset: 0 },
				g: { type: "discrete", tableValues: [0.2, 0.9] },
				b: { type: "linear", slope: 0.5, intercept: 0.4 },
				a: { type: "identity" },
			}),
		]),
		rectPath("el-morphology", cell(4), 60, 60, [
			solidFillAppearance(0.5, 0.2, 0.7),
			svgFilter("svg:morphology", {
				in: "previous",
				operator: "dilate",
				radiusX: 6,
				radiusY: 3,
			}),
		]),
		rectPath("el-convolve", cell(5), 60, 60, [
			solidFillAppearance(0.2, 0.7, 0.5),
			svgFilter("svg:convolve-matrix", {
				in: "previous",
				order: 3,
				kernelMatrix: [0, -1, 0, -1, 5, -1, 0, -1, 0],
				divisor: null,
				bias: 0,
				edgeMode: "duplicate",
				preserveAlpha: true,
			}),
		]),
		rectPath("el-masked-flood", cell(6), 60, 60, [
			solidFillAppearance(0.9, 0.2, 0.5),
			svgFilter("svg:flood", {
				color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
				opacity: 1,
			}),
		]),
		rectPath(
			"el-mask-shape",
			{ x: cell(6).x + 15, y: cell(6).y - 15 },
			60,
			60,
			[solidFillAppearance(1, 1, 1)],
		),
		rectPath("el-composite", cell(7), 60, 60, [
			solidFillAppearance(0.9, 0.6, 0.2),
			svgFilter("svg:flood", {
				color: { type: "rgb", r: 0.1, g: 0.2, b: 0.8, a: 1 },
				opacity: 1,
			}),
			svgFilter("svg:composite", {
				in: "previous",
				in2: "SourceAlpha",
				operator: "in",
				k1: 0,
				k2: 0,
				k3: 0,
				k4: 0,
			}),
		]),
		rectPath("el-blend", cell(8), 60, 60, [
			solidFillAppearance(0.9, 0.6, 0.2),
			svgFilter("svg:flood", {
				color: { type: "rgb", r: 0.2, g: 0.5, b: 0.9, a: 1 },
				opacity: 1,
			}),
			svgFilter("svg:blend", {
				in: "previous",
				in2: "SourceGraphic",
				mode: "multiply",
			}),
		]),
		rectPath("el-chain", cell(9), 60, 60, [
			solidFillAppearance(0.3, 0.3, 0.9),
			svgFilter("svg:offset", { in: "SourceAlpha", dx: 10, dy: -10 }),
			svgFilter("svg:color-matrix", {
				in: "previous",
				type: "matrix",
				values: [
					0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 1, 0,
				],
			}),
			svgFilter("svg:composite", {
				in: "SourceGraphic",
				in2: "previous",
				operator: "over",
				k1: 0,
				k2: 0,
				k3: 0,
				k4: 0,
			}),
		]),
	];
	const masked = elements[6];
	masked.opacity = 0.5;
	masked.mask = { elementIds: ["el-mask-shape"] };

	for (const el of elements) doc.objects[el.id] = el;
	doc.layers[0].elementIds = elements
		.map((el) => el.id)
		.filter((id) => id !== "el-mask-shape");
	return { doc, artboard };
}

/** Blur / noise primitives, kept at sigmas resvg still resolves analytically. */
function buildSvgFilterNoiseDocument(): { doc: Document; artboard: Artboard } {
	const doc = createDefaultDocument("doc-svg-filters-noise");
	const artboard = createArtboard(
		"ab-svg-noise",
		"SvgFiltersNoise",
		0,
		0,
		480,
		200,
	);
	doc.artboards = [artboard];

	const turbulence = {
		type: "fractalNoise",
		baseFrequencyX: 0.02,
		baseFrequencyY: 0.02,
		numOctaves: 2,
		seed: 3,
		stitchTiles: false,
	};
	const elements: AnyArtObject[] = [
		rectPath("el-blur", { x: -180, y: 0 }, 70, 70, [
			solidFillAppearance(0.9, 0.3, 0.2),
			svgFilter("svg:gaussian-blur", {
				in: "previous",
				stdDeviationX: 1.5,
				stdDeviationY: 1.5,
			}),
		]),
		rectPath("el-shadow", { x: -60, y: 0 }, 70, 70, [
			solidFillAppearance(0.2, 0.5, 0.9),
			svgFilter("svg:drop-shadow", {
				in: "previous",
				dx: 6,
				dy: -6,
				stdDeviation: 2,
				color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
				opacity: 0.6,
			}),
		]),
		rectPath("el-turbulence", { x: 60, y: 0 }, 70, 70, [
			solidFillAppearance(0.5, 0.5, 0.5),
			svgFilter("svg:turbulence", turbulence),
		]),
		rectPath("el-displacement", { x: 180, y: 0 }, 70, 70, [
			solidFillAppearance(0.3, 0.7, 0.3),
			svgFilter("svg:turbulence", turbulence),
			// An opaque map: resvg reads the map premultiplied, against the spec.
			svgFilter("svg:color-matrix", {
				in: "previous",
				type: "matrix",
				values: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1],
			}),
			svgFilter("svg:displacement-map", {
				in: "SourceGraphic",
				in2: "previous",
				scale: 12,
				xChannelSelector: "R",
				yChannelSelector: "G",
			}),
		]),
	];
	for (const el of elements) doc.objects[el.id] = el;
	doc.layers[0].elementIds = elements.map((el) => el.id);
	return { doc, artboard };
}

function svgFilter(processor: string, params: object): Filter {
	return {
		uid: generateUid("filter"),
		processor,
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params },
	};
}

// --- Synthetic 3D fixtures ---

function buildSolid3DDocument(): { doc: Document; artboard: Artboard } {
	const doc = createDefaultDocument("doc-solid3d");
	const artboard = createArtboard("ab-3d", "Solid3D", 0, 0, 400, 300);
	doc.artboards = [artboard];

	const extruded = rectPath("el-extrude", { x: -120, y: 20 }, 80, 60, [
		solidFillAppearance(0.9, 0.45, 0.1),
		{
			uid: generateUid("app"),
			processor: "extrude3d",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					depth: 50,
					rotationDeg: [-25, 35, 0],
					perspective: 30,
					material: {
						shading: "flat",
						lightDir: [-0.5, 0.7, 1],
					},
				},
			},
		},
	]);

	const rotated = rectPath("el-rotate", { x: 80, y: 20 }, 100, 70, [
		solidFillAppearance(0.1, 0.4, 0.85),
		{
			uid: generateUid("app"),
			processor: "3d-rotate",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: { rotateX: 45, rotateY: 30, rotateZ: 0, perspective: 60 },
			},
		},
	]);

	const { file, image } = checkerImage("el-image", { x: -20, y: -90 });
	image.filters = [
		{
			uid: generateUid("app"),
			processor: "3d-rotate",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: { rotateX: 40, rotateY: -25, rotateZ: 0, perspective: 60 },
			},
		},
	];

	doc.files.push(file);
	for (const el of [extruded, rotated, image] as AnyArtObject[]) {
		doc.objects[el.id] = el;
	}
	doc.layers[0].elementIds = [extruded.id, rotated.id, image.id];

	return { doc, artboard };
}

function checkerImage(
	id: string,
	center: { x: number; y: number },
): { file: EmbeddedFile; image: ImageObject } {
	const size = 16;
	const png = new PNG({ width: size, height: size });
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const i = (y * size + x) * 4;
			const on = (x >> 2) % 2 === (y >> 2) % 2;
			png.data[i] = on ? 220 : 40;
			png.data[i + 1] = on ? 60 : 160;
			png.data[i + 2] = on ? 60 : 220;
			png.data[i + 3] = 255;
		}
	}
	const bin = new Uint8Array(PNG.sync.write(png));
	const file: EmbeddedFile = {
		uid: `${id}-file`,
		name: "checker.png",
		type: "image/png",
		hash: `${id}-hash`,
		bin,
	};
	const image: ImageObject = {
		type: "image",
		id,
		opacity: 1,
		blendMode: "normal",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		fileUid: file.uid,
		x: center.x,
		y: center.y,
		width: 80,
		height: 80,
	};
	return { file, image };
}

// --- Test helpers ---

/** Minimal OffscreenCanvas covering exactly what rasterChunk uses. */
class TestOffscreenCanvas {
	private imageData: ImageData | null = null;

	public constructor(
		public width: number,
		public height: number,
	) {}

	public getContext(contextType: string) {
		if (contextType !== "2d") return null;
		return {
			putImageData: (imageData: ImageData) => {
				this.imageData = imageData;
			},
		};
	}

	public async convertToBlob({ type }: { type: string }): Promise<Blob> {
		if (!this.imageData) throw new Error("No image data written");
		const png = new PNG({ width: this.width, height: this.height });
		png.data = Buffer.from(this.imageData.data);
		return new Blob([new Uint8Array(PNG.sync.write(png))], { type });
	}
}
