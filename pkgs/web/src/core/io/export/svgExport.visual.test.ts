import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, it } from "vitest";
import { loadTestFont } from "../../testUtils/fontSetup";
import { loadTestDocument } from "../../testUtils/loadTestDocument";
import {
	createTestRenderer,
	expectPngBufferMatch,
} from "../../testUtils/visualRegression";
import { getFontManager } from "../../typography/fonts";
import { PaplicoSVGExporter } from "./PaplicoSVGExporter";

const MAX_DIFF_PERCENTAGE = 0.1;

/** Artboard name → baseline name. Add an entry when the test document grows. */
const ARTBOARDS: ReadonlyArray<[artboardName: string, baseline: string]> = [
	["Main", "svg-export-main"],
	["Text", "svg-export-text"],
	["Filters", "svg-export-filters"],
	["BlendModes", "svg-export-blend-modes"],
	["Transforms", "svg-export-transforms"],
	["Opacity", "svg-export-opacity"],
	["Groups", "svg-export-groups"],
	["Masks", "svg-export-masks"],
	["CompoundPaths", "svg-export-compound-paths"],
	["StrokeGradients", "svg-export-stroke-gradients"],
	["MultiFilters", "svg-export-multi-filters"],
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
			const bytes = readFileSync(
				resolve(
					__dirname,
					"../../testUtils/assets/NotoSansJP-VariableFont_wght.ttf",
				),
			);
			return new Response(new Uint8Array(bytes));
		}
		return originalFetch(input, init);
	}) as typeof globalThis.fetch;
});

afterAll(() => {
	globalThis.OffscreenCanvas =
		originalOffscreenCanvas as typeof globalThis.OffscreenCanvas;
	globalThis.fetch = originalFetch;
});

describe("SVG Export Visual Regression - testDocument artboards", () => {
	for (const [artboardName, baseline] of ARTBOARDS) {
		it(`Artboard '${artboardName}' exports to a stable SVG rendering`, async () => {
			const { renderer } = await createTestRenderer();
			const doc = await loadTestDocument();
			const artboard = doc.artboards.find((ab) => ab.name === artboardName);
			if (!artboard) throw new Error(`Artboard not found: ${artboardName}`);

			const exporter = new PaplicoSVGExporter(renderer, () => doc);
			const result = await exporter.renderArtboardToSVG(artboard.id, {
				backgroundColor: { r: 1, g: 1, b: 1, a: 1 },
			});
			if (!result) throw new Error(`SVG export failed: ${artboardName}`);

			const rendered = new Resvg(result.svg, {
				fitTo: { mode: "width", value: Math.round(artboard.width) },
			}).render();

			expectPngBufferMatch(Buffer.from(rendered.asPng()), baseline, {
				threshold: 0.1,
				maxDiffPercentage: MAX_DIFF_PERCENTAGE,
			});
		});
	}
});

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
