import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
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
import { loadTestFont, NOTO_SANS_JP_PATH } from "../../testUtils/fontSetup";
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
 * Artboard name → allowed diff (% of pixels). Text pays for outline AA;
 * Filters is raster-fallback heavy (chunk edge AA + stochastic pixel-level
 * filters like pixel-sort).
 */
const ARTBOARDS: ReadonlyArray<[artboardName: string, maxDiff: number]> = [
	["Main", 0.5],
	["Text", 1.5],
	["Filters", 1.5],
	["BlendModes", 0.5],
	["Transforms", 0.5],
	["Opacity", 0.5],
	["Groups", 0.5],
	["Masks", 0.5],
	["CompoundPaths", 0.5],
	["StrokeGradients", 0.5],
	["MultiFilters", 0.5],
	["SubFilters", 1.0],
	["ObjectBlend", 1.0],
	["Mesh Object", 1.0],
	["Complex Text Flows", 1.5],
	["Patterns", 0.5],
];

let originalOffscreenCanvas: typeof globalThis.OffscreenCanvas | undefined;
let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
	loadTestFont(getFontManager());
	// Raster chunks encode PNGs through OffscreenCanvas, which node/happy-dom
	// cannot rasterize — substitute a pngjs-backed stand-in for this suite.
	originalOffscreenCanvas = globalThis.OffscreenCanvas;
	globalThis.OffscreenCanvas =
		TestOffscreenCanvas as unknown as typeof globalThis.OffscreenCanvas;
	// FontManager's fallback font fetches an app-served asset; answer it from
	// the bundled test asset so outlining text never touches the network.
	originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input).includes("/assets/fonts/NotoSansJP")) {
			return new Response(new Uint8Array(readFileSync(NOTO_SANS_JP_PATH)));
		}
		return originalFetch(input, init);
	}) as typeof globalThis.fetch;
});

afterAll(() => {
	globalThis.OffscreenCanvas =
		originalOffscreenCanvas as typeof globalThis.OffscreenCanvas;
	globalThis.fetch = originalFetch;
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

		// 3D shading needs looser tolerance than flat shapes, but the extrusion
		// must not be clipped to the flat bbox and the rotation must keep its
		// perspective — both blow far past this threshold when broken.
		await expectSvgMatchesGpu(renderer, artboard, doc, "solid3d", 2);
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
	const diffPixels = pixelmatch(
		svgPixels,
		gpuPixels,
		diff.data,
		width,
		height,
		{ threshold: 0.15 },
	);
	const diffPercentage = (diffPixels / (width * height)) * 100;

	const diffDir = join(__dirname, "../../../__visual_diffs__");
	if (diffPercentage <= maxDiffPercentage) {
		for (const suffix of [".svg.png", ".diff.png", ".svg"]) {
			const stale = join(diffDir, `${testName}${suffix}`);
			if (existsSync(stale)) unlinkSync(stale);
		}
		return;
	}
	mkdirSync(diffDir, { recursive: true });
	const svgOut = new PNG({ width, height });
	svgOut.data = Buffer.from(svgPixels);
	writeFileSync(join(diffDir, `${testName}.svg.png`), PNG.sync.write(svgOut));
	writeFileSync(join(diffDir, `${testName}.diff.png`), PNG.sync.write(diff));
	writeFileSync(join(diffDir, `${testName}.svg`), result.svg);
	throw new Error(
		`SVG export diverges from the GPU render: ${diffPixels}/${width * height} pixels differ ` +
			`(${diffPercentage.toFixed(2)}% > ${maxDiffPercentage}%)\n` +
			`SVG rendering / diff saved under: ${diffDir}/${testName}.*`,
	);
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
