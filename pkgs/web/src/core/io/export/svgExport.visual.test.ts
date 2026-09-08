import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createArtboard, createDefaultDocument } from "../../document/factory";
import type { RenderOrchestrator } from "../../renderer/RenderOrchestrator";
import {
	type AnyArtObject,
	type Artboard,
	type Document,
	type EmbeddedFile,
	type FillAppearance,
	type Filter,
	generateUid,
	type ImageObject,
	type Path,
	type PathSegment,
} from "../../schema";
import { loadTestFont } from "../../testUtils/fontSetup";
import { loadTestDocument } from "../../testUtils/loadTestDocument";
import {
	createTestRenderer,
	expectPngBufferMatch,
} from "../../testUtils/visualRegression";
import { getFontManager } from "../../typography/fonts";
import { PaplicoSVGExporter } from "./PaplicoSVGExporter";

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

// --- GPU comparison ---

async function expectSvgMatchesGpu(
	renderer: RenderOrchestrator,
	artboard: Artboard,
	doc: Document,
	name: string,
	maxDiffPercentage: number,
): Promise<void> {
	const white = { r: 1, g: 1, b: 1, a: 1 };
	const testName = `svg-vs-gpu-${name}`;

	const gpu = await renderer.renderArtboardToImageData(artboard, doc, 1, white);
	if (!gpu) throw new Error("GPU render failed");

	const exporter = new PaplicoSVGExporter(renderer, () => doc);
	const result = await exporter.renderArtboardToSVG(artboard.id, {
		backgroundColor: white,
	});
	if (!result) throw new Error("SVG export failed");

	const svgPngBuffer = Buffer.from(
		new Resvg(result.svg, {
			fitTo: { mode: "width", value: gpu.width },
		})
			.render()
			.asPng(),
	);
	const svgPng = PNG.sync.read(svgPngBuffer);

	// Baseline VRT of the resvg rasterization itself: pixel-tight regression
	// tracking of the SVG output, independent of the looser GPU tolerance.
	expectPngBufferMatch(svgPngBuffer, `svg-export-${name}`);

	// Fractional artboard sizes may round one pixel apart between the two
	// rasterizers; anything larger is a real geometry bug.
	if (
		Math.abs(svgPng.width - gpu.width) > 1 ||
		Math.abs(svgPng.height - gpu.height) > 1
	) {
		throw new Error(
			`SVG/GPU size mismatch: svg ${svgPng.width}x${svgPng.height} vs gpu ${gpu.width}x${gpu.height}`,
		);
	}

	const width = Math.min(svgPng.width, gpu.width);
	const height = Math.min(svgPng.height, gpu.height);
	const svgPixels = cropRgba(svgPng.data, svgPng.width, width, height);
	const gpuPixels = cropRgba(gpu.data, gpu.width, width, height);

	const diff = new PNG({ width, height });
	pixelmatch(svgPixels, gpuPixels, diff.data, width, height, {
		threshold: 0.15,
	});
	// Two-stage judgement: a raw pixelmatch diff that has a matching color
	// within 1px in BOTH directions is a sub-pixel edge shift (outlined text
	// AA vs the GPU's text rendering) — content that is simply MISSING on one
	// side has no nearby match and stays a real difference.
	let realDiffPixels = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			// pixelmatch writes red (255,0,0) into flagged pixels.
			if (!(diff.data[i] === 255 && diff.data[i + 1] === 0)) continue;
			if (
				!hasNearbyMatch(gpuPixels, svgPixels, x, y, width, height) ||
				!hasNearbyMatch(svgPixels, gpuPixels, x, y, width, height)
			) {
				realDiffPixels++;
			} else {
				// Downgrade shifted-edge pixels in the saved diff for eyeballing.
				diff.data[i] = 255;
				diff.data[i + 1] = 220;
				diff.data[i + 2] = 0;
			}
		}
	}
	// Measure against the CONTENT the GPU actually painted, not the canvas
	// area: on a mostly-empty artboard a whole-canvas percentage hides a
	// completely broken element inside the whitespace.
	let contentPixels = 0;
	for (let i = 0; i < gpuPixels.length; i += 4) {
		if (
			!(gpuPixels[i] > 245 && gpuPixels[i + 1] > 245 && gpuPixels[i + 2] > 245)
		) {
			contentPixels++;
		}
	}
	const diffPercentage = (realDiffPixels / Math.max(contentPixels, 1)) * 100;

	const diffDir = join(__dirname, "../../../__visual_diffs__");
	if (diffPercentage <= maxDiffPercentage) {
		for (const suffix of [".svg.png", ".gpu.png", ".diff.png", ".svg"]) {
			const stale = join(diffDir, `${testName}${suffix}`);
			if (existsSync(stale)) unlinkSync(stale);
		}
		return;
	}
	mkdirSync(diffDir, { recursive: true });
	const svgOut = new PNG({ width, height });
	svgOut.data = Buffer.from(svgPixels);
	const gpuOut = new PNG({ width, height });
	gpuOut.data = Buffer.from(gpuPixels);
	writeFileSync(join(diffDir, `${testName}.svg.png`), PNG.sync.write(svgOut));
	writeFileSync(join(diffDir, `${testName}.gpu.png`), PNG.sync.write(gpuOut));
	writeFileSync(join(diffDir, `${testName}.diff.png`), PNG.sync.write(diff));
	writeFileSync(join(diffDir, `${testName}.svg`), result.svg);
	throw new Error(
		`SVG export diverges from the GPU render: ${realDiffPixels} of ${contentPixels} content pixels differ ` +
			`(${diffPercentage.toFixed(2)}% > ${maxDiffPercentage}%, edge shifts excluded)\n` +
			`SVG rendering / diff saved under: ${diffDir}/${testName}.*`,
	);
}

/**
 * True when `expected`'s pixel at (x, y) has a color within pixelmatch-like
 * tolerance somewhere in `actual`'s 3×3 neighborhood — i.e. the flagged pixel
 * is explained by a ≤1px edge shift rather than by missing content.
 */
function hasNearbyMatch(
	expected: Uint8Array,
	actual: Uint8Array,
	x: number,
	y: number,
	width: number,
	height: number,
): boolean {
	const e = (y * width + x) * 4;
	for (let dy = -1; dy <= 1; dy++) {
		for (let dx = -1; dx <= 1; dx++) {
			const nx = x + dx;
			const ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
			const a = (ny * width + nx) * 4;
			// 96 also absorbs the AA-density gap between the GPU's text
			// compositing and resvg's path AA (same coverage renders ~60 apart),
			// while missing content against the background stays >96 apart.
			if (
				Math.abs(expected[e] - actual[a]) < 96 &&
				Math.abs(expected[e + 1] - actual[a + 1]) < 96 &&
				Math.abs(expected[e + 2] - actual[a + 2]) < 96
			) {
				return true;
			}
		}
	}
	return false;
}

function cropRgba(
	data: Uint8Array | Uint8ClampedArray | Buffer,
	sourceWidth: number,
	width: number,
	height: number,
): Uint8Array {
	const out = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const src = y * sourceWidth * 4;
		out.set(data.subarray(src, src + width * 4), y * width * 4);
	}
	return out;
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

function rectPath(
	id: string,
	center: { x: number; y: number },
	width: number,
	height: number,
	filters: Filter[],
): Path {
	const seg = (partial: Partial<PathSegment>): PathSegment => ({
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: { x: 0, y: 0 },
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: false,
		...partial,
	});
	const halfW = width / 2;
	const halfH = height / 2;
	return {
		type: "path",
		id,
		opacity: 1,
		blendMode: "normal",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		segments: [
			seg({
				start: { x: center.x - halfW, y: center.y + halfH },
				end: { x: center.x + halfW, y: center.y + halfH },
				isMoved: true,
			}),
			seg({ end: { x: center.x + halfW, y: center.y - halfH } }),
			seg({
				end: { x: center.x - halfW, y: center.y - halfH },
				isClosed: true,
			}),
		],
		filters,
	};
}

function solidFillAppearance(r: number, g: number, b: number): FillAppearance {
	return {
		uid: generateUid("app"),
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: { type: "solid", color: { type: "rgb", r, g, b, a: 1 } },
			},
		},
	};
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
