import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	createArtboard,
	createDefaultBrushSettings,
	createDefaultDocument,
	createDefaultLayer,
	createStrokeBrushSettings,
} from "../../document/factory";
import type { BrushSettings, Path, StrokeWidthPoint } from "../../schema";
import { loadTestFont } from "../../testUtils/fontSetup";
import { loadTestDocument } from "../../testUtils/loadTestDocument";
import { createMockToolContext } from "../../testUtils/mockToolContext";
import {
	ev,
	testCanvasHeight,
	testCanvasWidth,
} from "../../testUtils/pointerEvent";
import {
	captureTexturePixels,
	createTestRenderer,
	expectVisualMatch,
	renderArtboardForTest,
	renderWithViewport,
} from "../../testUtils/visualRegression";
import { PenTool } from "../../tools/PenTool";
import { getFontManager } from "../../typography/fonts";

beforeAll(() => {
	loadTestFont(getFontManager());
});

const MAX_DIFF_PERCENTAGE = 0.1;

describe("WebGPU Visual Regression - testDocument.ts全機能", () => {
	it("Artboard 'Main' - Shapes + Strokes + Gradients", async () => {
		const { renderer } = await createTestRenderer();

		const doc = await loadTestDocument();
		const artboard = doc.artboards.find((ab) => ab.name === "Main")!;

		const texture = await renderArtboardForTest(renderer, artboard, doc, 1, {
			r: 1,
			g: 1,
			b: 1,
			a: 1,
		});

		if (!texture) throw new Error("Failed to render artboard");

		await expectVisualMatch(
			renderer,
			texture,
			texture.width,
			texture.height,
			"testdoc-main-artboard",
			{
				threshold: 0.1,
				maxDiffPercentage: MAX_DIFF_PERCENTAGE,
			},
		);

		texture.destroy();
	});

	it("Artboard 'Text' - Horizontal/Vertical text", async () => {
		const { renderer } = await createTestRenderer();

		const doc = await loadTestDocument();
		const artboard = doc.artboards.find((ab) => ab.name === "Text")!;

		const texture = await renderArtboardForTest(renderer, artboard, doc, 1, {
			r: 1,
			g: 1,
			b: 1,
			a: 1,
		});

		if (!texture) throw new Error("Failed to render artboard");

		await expectVisualMatch(
			renderer,
			texture,
			texture.width,
			texture.height,
			"testdoc-text-artboard",
			{
				threshold: 0.1,
				maxDiffPercentage: MAX_DIFF_PERCENTAGE,
			},
		);

		texture.destroy();
	});

	it("Artboard 'Filters' - Blur/FrostGlass/DropShadow/Zigzag", async () => {
		const { renderer } = await createTestRenderer();

		const doc = await loadTestDocument();
		const artboard = doc.artboards.find((ab) => ab.name === "Filters")!;

		const texture = await renderArtboardForTest(renderer, artboard, doc, 1, {
			r: 1,
			g: 1,
			b: 1,
			a: 1,
		});

		if (!texture) throw new Error("Failed to render artboard");

		await expectVisualMatch(
			renderer,
			texture,
			texture.width,
			texture.height,
			"testdoc-filters-artboard",
			{
				threshold: 0.1,
				maxDiffPercentage: MAX_DIFF_PERCENTAGE,
			},
		);

		texture.destroy();
	});

	it("Artboard 'Filters' @2x - fixed-resolution filter rasterization", async () => {
		const { renderer } = await createTestRenderer();

		const doc = await loadTestDocument();
		const artboard = doc.artboards.find((ab) => ab.name === "Filters")!;

		// Render at 2x. Filters rasterize at the document resolution (R=300/72) and
		// are blitted up to 2x, so this baseline pins the decoupling of filter
		// rasterization from the viewport/export scale.
		const texture = await renderArtboardForTest(renderer, artboard, doc, 2, {
			r: 1,
			g: 1,
			b: 1,
			a: 1,
		});

		if (!texture) throw new Error("Failed to render artboard");

		await expectVisualMatch(
			renderer,
			texture,
			texture.width,
			texture.height,
			"testdoc-filters-zoom2",
			{
				threshold: 0.1,
				maxDiffPercentage: MAX_DIFF_PERCENTAGE,
			},
		);

		texture.destroy();
	});

	it("Artboard 'BlendModes' - All 12 blend modes", async () => {
		const { renderer } = await createTestRenderer();

		const doc = await loadTestDocument();
		const artboard = doc.artboards.find((ab) => ab.name === "BlendModes")!;

		const texture = await renderArtboardForTest(renderer, artboard, doc, 1, {
			r: 1,
			g: 1,
			b: 1,
			a: 1,
		});

		if (!texture) throw new Error("Failed to render artboard");

		await expectVisualMatch(
			renderer,
			texture,
			texture.width,
			texture.height,
			"testdoc-blendmodes-artboard",
			{
				threshold: 0.1,
				maxDiffPercentage: MAX_DIFF_PERCENTAGE,
			},
		);

		texture.destroy();
	});

	it("Artboard 'Transforms' - Rotation + Scale + Combined", async () => {
		const { renderer } = await createTestRenderer();

		const doc = await loadTestDocument();
		const artboard = doc.artboards.find((ab) => ab.name === "Transforms")!;

		const texture = await renderArtboardForTest(renderer, artboard, doc, 1, {
			r: 1,
			g: 1,
			b: 1,
			a: 1,
		});

		if (!texture) throw new Error("Failed to render artboard");

		await expectVisualMatch(
			renderer,
			texture,
			texture.width,
			texture.height,
			"testdoc-transforms-artboard",
			{
				threshold: 0.1,
				maxDiffPercentage: MAX_DIFF_PERCENTAGE,
			},
		);

		texture.destroy();
	});

	it("Artboard 'Opacity' - Element + Layer opacity", async () => {
		const { renderer } = await createTestRenderer();

		const doc = await loadTestDocument();
		const artboard = doc.artboards.find((ab) => ab.name === "Opacity")!;

		const texture = await renderArtboardForTest(renderer, artboard, doc, 1, {
			r: 1,
			g: 1,
			b: 1,
			a: 1,
		});

		if (!texture) throw new Error("Failed to render artboard");

		await expectVisualMatch(
			renderer,
			texture,
			texture.width,
			texture.height,
			"testdoc-opacity-artboard",
			{
				threshold: 0.1,
				maxDiffPercentage: MAX_DIFF_PERCENTAGE,
			},
		);

		texture.destroy();
	});

	it("Artboard 'Groups' - Group children + Clipping mask", async () => {
		const { renderer } = await createTestRenderer();

		const doc = await loadTestDocument();
		const artboard = doc.artboards.find((ab) => ab.name === "Groups")!;

		const texture = await renderArtboardForTest(renderer, artboard, doc, 1, {
			r: 1,
			g: 1,
			b: 1,
			a: 1,
		});

		if (!texture) throw new Error("Failed to render artboard");

		await expectVisualMatch(
			renderer,
			texture,
			texture.width,
			texture.height,
			"testdoc-groups-artboard",
			{
				threshold: 0.1,
				maxDiffPercentage: MAX_DIFF_PERCENTAGE,
			},
		);

		texture.destroy();
	});

	it("Artboard 'Masks' - Object masks driven by luminance", async () => {
		const { renderer } = await createTestRenderer();

		const doc = await loadTestDocument();
		const artboard = doc.artboards.find((ab) => ab.name === "Masks")!;

		const texture = await renderArtboardForTest(renderer, artboard, doc, 1, {
			r: 1,
			g: 1,
			b: 1,
			a: 1,
		});

		if (!texture) throw new Error("Failed to render artboard");

		await expectVisualMatch(
			renderer,
			texture,
			texture.width,
			texture.height,
			"testdoc-masks-artboard",
			{
				threshold: 0.1,
				maxDiffPercentage: MAX_DIFF_PERCENTAGE,
			},
		);

		texture.destroy();
	});

	it("Artboard 'CompoundPaths' - Boolean operations", async () => {
		const { renderer } = await createTestRenderer();

		const doc = await loadTestDocument();
		const artboard = doc.artboards.find((ab) => ab.name === "CompoundPaths")!;

		const texture = await renderArtboardForTest(renderer, artboard, doc, 1, {
			r: 1,
			g: 1,
			b: 1,
			a: 1,
		});

		if (!texture) throw new Error("Failed to render artboard");

		await expectVisualMatch(
			renderer,
			texture,
			texture.width,
			texture.height,
			"testdoc-compoundpaths-artboard",
			{
				threshold: 0.1,
				maxDiffPercentage: MAX_DIFF_PERCENTAGE,
			},
		);

		texture.destroy();
	});

	it("Artboard 'StrokeGradients' - Within/Along/Across", async () => {
		const { renderer } = await createTestRenderer();

		const doc = await loadTestDocument();
		const artboard = doc.artboards.find((ab) => ab.name === "StrokeGradients")!;

		const texture = await renderArtboardForTest(renderer, artboard, doc, 1, {
			r: 1,
			g: 1,
			b: 1,
			a: 1,
		});

		if (!texture) throw new Error("Failed to render artboard");

		await expectVisualMatch(
			renderer,
			texture,
			texture.width,
			texture.height,
			"testdoc-strokegradients-artboard",
			{
				threshold: 0.1,
				maxDiffPercentage: 1.5,
			},
		);

		texture.destroy();
	});

	it("Artboard 'MultiFilters' - Stacked filter combos", async () => {
		const { renderer } = await createTestRenderer();

		const doc = await loadTestDocument();
		const artboard = doc.artboards.find((ab) => ab.name === "MultiFilters")!;

		const texture = await renderArtboardForTest(renderer, artboard, doc, 1, {
			r: 1,
			g: 1,
			b: 1,
			a: 1,
		});

		if (!texture) throw new Error("Failed to render artboard");

		await expectVisualMatch(
			renderer,
			texture,
			texture.width,
			texture.height,
			"testdoc-multifilters-artboard",
			{
				threshold: 0.1,
				maxDiffPercentage: MAX_DIFF_PERCENTAGE,
			},
		);

		texture.destroy();
	});

	it("Artboard 'SubFilters' - Per-appearance sub-filters", async () => {
		const { renderer } = await createTestRenderer();

		const doc = await loadTestDocument();
		const artboard = doc.artboards.find((ab) => ab.name === "SubFilters")!;

		const texture = await renderArtboardForTest(renderer, artboard, doc, 1, {
			r: 1,
			g: 1,
			b: 1,
			a: 1,
		});

		if (!texture) throw new Error("Failed to render artboard");

		await expectVisualMatch(
			renderer,
			texture,
			texture.width,
			texture.height,
			"testdoc-subfilters-artboard",
			{
				threshold: 0.1,
				maxDiffPercentage: MAX_DIFF_PERCENTAGE,
			},
		);

		texture.destroy();
	});

	it("Artboard 'ObjectBlend' - Blend intermediates between keys", async () => {
		const { renderer } = await createTestRenderer();

		const doc = await loadTestDocument();
		const artboard = doc.artboards.find((ab) => ab.name === "ObjectBlend")!;

		const texture = await renderArtboardForTest(renderer, artboard, doc, 1, {
			r: 1,
			g: 1,
			b: 1,
			a: 1,
		});

		if (!texture) throw new Error("Failed to render artboard");

		await expectVisualMatch(
			renderer,
			texture,
			texture.width,
			texture.height,
			"testdoc-objectblend-artboard",
			{
				threshold: 0.1,
				maxDiffPercentage: MAX_DIFF_PERCENTAGE,
			},
		);

		texture.destroy();
	});

	it("Artboard 'Mesh Object' - Children warped by a Coons cage", async () => {
		const { renderer } = await createTestRenderer();

		const doc = await loadTestDocument();
		const artboard = doc.artboards.find((ab) => ab.name === "Mesh Object")!;

		const texture = await renderArtboardForTest(renderer, artboard, doc, 1, {
			r: 1,
			g: 1,
			b: 1,
			a: 1,
		});

		if (!texture) throw new Error("Failed to render artboard");

		await expectVisualMatch(
			renderer,
			texture,
			texture.width,
			texture.height,
			"testdoc-meshobject-artboard",
			{
				threshold: 0.1,
				maxDiffPercentage: MAX_DIFF_PERCENTAGE,
			},
		);

		texture.destroy();
	});

	it("Artboard 'Complex Text Flows' - Flow chains through region/on-path text", async () => {
		const { renderer } = await createTestRenderer();

		const doc = await loadTestDocument();
		const artboard = doc.artboards.find(
			(ab) => ab.name === "Complex Text Flows",
		)!;

		const texture = await renderArtboardForTest(renderer, artboard, doc, 1, {
			r: 1,
			g: 1,
			b: 1,
			a: 1,
		});

		if (!texture) throw new Error("Failed to render artboard");

		await expectVisualMatch(
			renderer,
			texture,
			texture.width,
			texture.height,
			"testdoc-complextextflows-artboard",
			{
				threshold: 0.1,
				maxDiffPercentage: MAX_DIFF_PERCENTAGE,
			},
		);

		texture.destroy();
	});
});

describe("WebGPU Visual Regression - Viewport Rotation Brush Stroke", () => {
	it("brush stroke renders at correct position with rotated viewport", async () => {
		const { renderer, canvas } = await createTestRenderer();

		// Simulate a horizontal drag on screen with a 45-degree rotated viewport.
		// Screen (400,300) → (500,300) should map to world diagonal up-right.
		const rotatedViewport = { x: 0, y: 0, zoom: 1, rotation: Math.PI / 4 };
		let capturedPath: Path | null = null;

		const context = createMockToolContext({
			strokeComplete: vi.fn((path: Path) => {
				capturedPath = path;
			}),
			getActiveStrokeAppearance: () => ({
				uid: "test-stroke",
				processor: "stroke" as const,
				opacity: 1,
				blendMode: "normal" as const,
				paramData: {
					version: "1",
					params: {
						strokeColor: {
							type: "solid" as const,
							color: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 },
						},
						brushSettings: createStrokeBrushSettings(6),
					},
				},
			}),
		});

		const pen = new PenTool(context, { strokeWidth: 6 });

		pen.onPointerDown(
			ev(400, 300),
			rotatedViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		pen.onPointerMove(
			ev(450, 300),
			rotatedViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		pen.onPointerMove(
			ev(500, 300),
			rotatedViewport,
			testCanvasWidth,
			testCanvasHeight,
		);
		pen.onPointerUp(
			ev(500, 300),
			rotatedViewport,
			testCanvasWidth,
			testCanvasHeight,
		);

		expect(capturedPath).not.toBeNull();

		// Build a minimal document containing only the captured stroke
		const doc = createDefaultDocument("brush-vrt");
		const layer = createDefaultLayer("layer-strokes", "Strokes");
		layer.elementIds.push(capturedPath!.id);
		doc.objects[capturedPath!.id] = capturedPath!;
		doc.layers.push(layer);
		doc.artboards.push(
			createArtboard(
				"ab-brush",
				"BrushTest",
				0,
				0,
				testCanvasWidth,
				testCanvasHeight,
			),
		);

		// Render with the same rotated viewport
		const texture = await renderWithViewport(
			renderer,
			canvas,
			doc,
			rotatedViewport,
		);

		await expectVisualMatch(
			renderer,
			texture,
			texture.width,
			texture.height,
			"brush-stroke-rotated-viewport",
			{ threshold: 0.1, maxDiffPercentage: 1.0 },
		);

		texture.destroy();
	});
});

describe("WebGPU signed brush width rendering", () => {
	it.each([
		["stamp", signedWidthScatterSettings()],
		["rotated calligraphy stamp", signedWidthCalligraphySettings()],
		["ribbon", signedWidthPatternSettings()],
	] as const)("should remove the opposite-side interior and hide exhausted %s strokes", async (brushKind, brushSettings) => {
		const remaining = await renderSignedWidthBrush(
			brushSettings,
			[
				{ t: 0, side1: -0.5, side2: 1 },
				{ t: 1, side1: -0.5, side2: 1 },
			],
			`${brushKind}-remaining`,
		);
		const centerAlpha = maxAlphaInRegion(remaining, 40, 120, 58, 62);
		const upperAlpha = maxAlphaInRegion(remaining, 40, 120, 44, 57);
		const lowerAlpha = maxAlphaInRegion(remaining, 40, 120, 63, 76);
		expect(centerAlpha).toBeLessThan(4);
		expect(Math.max(upperAlpha, lowerAlpha)).toBeGreaterThan(32);
		expect(Math.min(upperAlpha, lowerAlpha)).toBeLessThan(4);

		const exhausted = await renderSignedWidthBrush(
			brushSettings,
			[
				{ t: 0, side1: -1, side2: 1 },
				{ t: 1, side1: -1.25, side2: 1 },
			],
			`${brushKind}-exhausted`,
		);
		expect(maxAlpha(exhausted.pixels)).toBe(0);
	});

	it("should keep stamp clipping normalized under a non-uniform element scale", async () => {
		const scaled = await renderSignedWidthBrush(
			signedWidthScatterSettings(),
			[
				{ t: 0, side1: -0.5, side2: 1 },
				{ t: 1, side1: -0.5, side2: 1 },
			],
			"stamp-non-uniform-scale",
			{ scaleX: 1, scaleY: 2 },
		);

		expect(maxAlphaInRegion(scaled, 40, 120, 58, 62)).toBeLessThan(4);
		const upperFarAlpha = maxAlphaInRegion(scaled, 40, 120, 42, 49);
		const lowerFarAlpha = maxAlphaInRegion(scaled, 40, 120, 71, 78);
		expect(Math.max(upperFarAlpha, lowerFarAlpha)).toBeGreaterThan(24);
		expect(Math.min(upperFarAlpha, lowerFarAlpha)).toBeLessThan(4);
	});
});

describe("WebGPU Visual Regression - renderArtboardForTest idempotency", () => {
	it("Filters artboard: two consecutive renderArtboardForTest calls produce identical results", async () => {
		// Regression test: batched fill buffer requires flushFillBatch()
		// before each queue.submit(). On the 1st call batchGPUBuf is null so fills use the
		// per-element fallback path, but on the 2nd call the batch path kicks in. If
		// flushFillBatch() is missing before the filter encoder submit, fills are silently lost.
		const { renderer } = await createTestRenderer();
		const doc = await loadTestDocument();
		const artboard = doc.artboards.find((ab) => ab.name === "Filters")!;
		const device = renderer.getDevice()!;
		const bg = { r: 1, g: 1, b: 1, a: 1 };

		const tex1 = await renderArtboardForTest(renderer, artboard, doc, 1, bg);
		if (!tex1) throw new Error("1st renderArtboardForTest returned null");
		const pixels1 = await captureTexturePixels(
			device,
			tex1,
			tex1.width,
			tex1.height,
		);
		const w = tex1.width;
		const h = tex1.height;
		tex1.destroy();

		const tex2 = await renderArtboardForTest(renderer, artboard, doc, 1, bg);
		if (!tex2) throw new Error("2nd renderArtboardForTest returned null");
		const pixels2 = await captureTexturePixels(
			device,
			tex2,
			tex2.width,
			tex2.height,
		);
		tex2.destroy();

		const diffData = new Uint8Array(w * h * 4);
		const diffPixels = pixelmatch(pixels1, pixels2, diffData, w, h, {
			threshold: 0,
		});

		const diffPercentage = (diffPixels / (w * h)) * 100;
		expect(diffPercentage).toBeLessThan(0.1);
	});
});

describe("WebGPU Visual Regression - renderArtboardToImageData vs renderArtboardForTest", () => {
	it("Filters artboard: renderArtboardToImageData matches renderArtboardForTest", async () => {
		const { renderer } = await createTestRenderer();
		const doc = await loadTestDocument();
		const artboard = doc.artboards.find((ab) => ab.name === "Filters")!;
		const device = renderer.getDevice()!;
		const bg = { r: 1, g: 1, b: 1, a: 1 };

		// Call renderArtboardToImageData FIRST to test independently
		const imageData = await renderer.renderArtboardToImageData(
			artboard,
			doc,
			1,
			bg,
		);
		if (!imageData) throw new Error("renderArtboardToImageData returned null");
		console.log(
			`renderArtboardToImageData: ${imageData.width}x${imageData.height}`,
		);

		// Then renderArtboardForTest
		const texture = await renderArtboardForTest(renderer, artboard, doc, 1, bg);
		if (!texture) throw new Error("renderArtboardForTest returned null");
		console.log(
			`renderArtboardForTest texture: ${texture.width}x${texture.height}`,
		);
		const exportPixels = await captureTexturePixels(
			device,
			texture,
			texture.width,
			texture.height,
		);
		texture.destroy();

		// Apply the same alpha un-premultiplication that renderArtboardToImageData does
		for (let i = 0; i < exportPixels.length; i += 4) {
			const a = exportPixels[i + 3];
			if (a > 0 && a < 255) {
				const inv = 255 / a;
				exportPixels[i] = Math.min(255, Math.round(exportPixels[i] * inv));
				exportPixels[i + 1] = Math.min(
					255,
					Math.round(exportPixels[i + 1] * inv),
				);
				exportPixels[i + 2] = Math.min(
					255,
					Math.round(exportPixels[i + 2] * inv),
				);
			}
		}

		const w = imageData.width;
		const h = imageData.height;
		expect(w * h * 4).toBe(exportPixels.length);

		const diffPng = new PNG({ width: w, height: h });
		const diffPixels = pixelmatch(
			exportPixels,
			new Uint8Array(imageData.data.buffer),
			diffPng.data,
			w,
			h,
			{ threshold: 0.1 },
		);

		const diffPercentage = (diffPixels / (w * h)) * 100;

		// Log diff details for debugging
		if (diffPixels > 0) {
			let maxChannelDiff = 0;
			let diffAt = {
				x: 0,
				y: 0,
				exportR: 0,
				exportG: 0,
				exportB: 0,
				exportA: 0,
				imgR: 0,
				imgG: 0,
				imgB: 0,
				imgA: 0,
			};
			for (let i = 0; i < exportPixels.length; i += 4) {
				const dr = Math.abs(exportPixels[i] - imageData.data[i]);
				const dg = Math.abs(exportPixels[i + 1] - imageData.data[i + 1]);
				const db = Math.abs(exportPixels[i + 2] - imageData.data[i + 2]);
				const da = Math.abs(exportPixels[i + 3] - imageData.data[i + 3]);
				const m = Math.max(dr, dg, db, da);
				if (m > maxChannelDiff) {
					maxChannelDiff = m;
					const px = (i / 4) % w;
					const py = Math.floor(i / 4 / w);
					diffAt = {
						x: px,
						y: py,
						exportR: exportPixels[i],
						exportG: exportPixels[i + 1],
						exportB: exportPixels[i + 2],
						exportA: exportPixels[i + 3],
						imgR: imageData.data[i],
						imgG: imageData.data[i + 1],
						imgB: imageData.data[i + 2],
						imgA: imageData.data[i + 3],
					};
				}
			}
			console.log(
				`Diff: ${diffPixels}/${w * h} pixels (${diffPercentage.toFixed(4)}%), maxChannelDiff=${maxChannelDiff}`,
			);
			console.log(
				`Worst pixel at (${diffAt.x},${diffAt.y}): export=[${diffAt.exportR},${diffAt.exportG},${diffAt.exportB},${diffAt.exportA}] imageData=[${diffAt.imgR},${diffAt.imgG},${diffAt.imgB},${diffAt.imgA}]`,
			);
		}

		expect(diffPercentage).toBeLessThan(0.1);
	});
});

describe("WebGPU Visual Regression - Mutation Detection", () => {
	it("re-renders correctly after transform mutation", async () => {
		const { renderer } = await createTestRenderer();

		const doc = await loadTestDocument();
		const artboard = doc.artboards.find((ab) => ab.name === "Main")!;

		// Step 1: Render original state
		const textureBefore = await renderArtboardForTest(
			renderer,
			artboard,
			doc,
			1,
			{ r: 1, g: 1, b: 1, a: 1 },
		);
		if (!textureBefore) throw new Error("Failed to render before mutation");

		await expectVisualMatch(
			renderer,
			textureBefore,
			textureBefore.width,
			textureBefore.height,
			"mutation-before",
			{ threshold: 0.1, maxDiffPercentage: MAX_DIFF_PERCENTAGE },
		);
		textureBefore.destroy();

		// Step 2: Mutate document objects
		const shapesLayer = doc.layers.find((l) => l.name === "Shapes")!;
		const firstElId = shapesLayer.elementIds[0];
		const secondElId = shapesLayer.elementIds[1];
		const firstEl = doc.objects[firstElId];
		const secondEl = doc.objects[secondElId];

		firstEl.transform = { ...firstEl.transform, x: firstEl.transform.x + 300 };
		secondEl.transform = {
			...secondEl.transform,
			rotation: Math.PI / 4,
		};

		// Step 3: Re-render with same renderer (tests cache invalidation)
		const textureAfter = await renderArtboardForTest(
			renderer,
			artboard,
			doc,
			1,
			{ r: 1, g: 1, b: 1, a: 1 },
		);
		if (!textureAfter) throw new Error("Failed to render after mutation");

		await expectVisualMatch(
			renderer,
			textureAfter,
			textureAfter.width,
			textureAfter.height,
			"mutation-after",
			{ threshold: 0.1, maxDiffPercentage: MAX_DIFF_PERCENTAGE },
		);
		textureAfter.destroy();
	});
});

async function renderSignedWidthBrush(
	brushSettings: BrushSettings,
	strokeWidths: StrokeWidthPoint[],
	id: string,
	transform?: Partial<Path["transform"]>,
): Promise<{ pixels: Uint8Array; width: number; height: number }> {
	const { renderer } = await createTestRenderer();
	const path = createSignedWidthPath(
		brushSettings,
		strokeWidths,
		id,
		transform,
	);
	const doc = createDefaultDocument(`signed-width-${id}`);
	const layer = createDefaultLayer(`layer-${id}`, "Signed width");
	layer.elementIds.push(path.id);
	doc.objects[path.id] = path;
	doc.layers.push(layer);
	const artboard = createArtboard(
		`artboard-${id}`,
		"Signed width",
		0,
		0,
		160,
		120,
	);
	doc.artboards.push(artboard);

	const texture = await renderArtboardForTest(renderer, artboard, doc, 1, {
		r: 0,
		g: 0,
		b: 0,
		a: 0,
	});
	if (!texture) throw new Error("Failed to render signed-width brush");

	const width = texture.width;
	const height = texture.height;
	const pixels = await captureTexturePixels(
		renderer.getDevice()!,
		texture,
		width,
		height,
	);
	texture.destroy();
	return { pixels, width, height };
}

function createSignedWidthPath(
	brushSettings: BrushSettings,
	strokeWidths: StrokeWidthPoint[],
	id: string,
	transform?: Partial<Path["transform"]>,
): Path {
	let capturedPath: Path | null = null;
	const context = createMockToolContext({
		strokeComplete: vi.fn((path: Path) => {
			capturedPath = path;
		}),
		getActiveStrokeAppearance: () => ({
			uid: `stroke-${id}`,
			processor: "stroke" as const,
			opacity: 1,
			blendMode: "normal" as const,
			paramData: {
				version: "1",
				params: {
					strokeColor: {
						type: "solid" as const,
						color: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 },
					},
					brushSettings,
				},
			},
		}),
	});
	const pen = new PenTool(context, { strokeWidth: brushSettings.size });
	const viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

	pen.onPointerDown(ev(340, 300), viewport, testCanvasWidth, testCanvasHeight);
	pen.onPointerMove(ev(400, 300), viewport, testCanvasWidth, testCanvasHeight);
	pen.onPointerMove(ev(460, 300), viewport, testCanvasWidth, testCanvasHeight);
	pen.onPointerUp(ev(460, 300), viewport, testCanvasWidth, testCanvasHeight);

	const path = requireCapturedPath(capturedPath);
	return {
		...path,
		id,
		strokeWidths,
		transform: { ...path.transform, ...transform },
	};
}

function signedWidthScatterSettings(): BrushSettings {
	return {
		...createDefaultBrushSettings(),
		size: 20,
		sizeByPressure: 0,
		opacity: 1,
		opacityByPressure: 0,
		spacing: 0.1,
		flow: 1,
	};
}

function signedWidthCalligraphySettings(): BrushSettings {
	return {
		type: "calligraphy",
		size: 20,
		sizeByPressure: 0,
		opacity: 1,
		opacityByPressure: 0,
		flow: 1,
		randomSeed: 0,
		nibAngle: 45,
		roundness: 0.4,
		angleMode: "fixed",
		sizeBySpeed: 0,
		pooling: 0,
		poolingSizeRatio: 0,
	};
}

function signedWidthPatternSettings(): BrushSettings {
	return {
		type: "pattern",
		source: { kind: "file", fileUid: "builtin-brush-soft-circle" },
		size: 20,
		sizeByPressure: 0,
		opacity: 1,
		opacityByPressure: 0,
		randomSeed: 0,
		flow: 1,
		tileScale: 1,
		tileSpacing: 0,
		fitMode: "none",
	};
}

function requireCapturedPath(path: Path | null): Path {
	if (!path) throw new Error("PenTool did not complete a path");
	return path;
}

function maxAlphaInRegion(
	image: { pixels: Uint8Array; width: number; height: number },
	minX: number,
	maxX: number,
	minY: number,
	maxY: number,
): number {
	let max = 0;
	for (let y = minY; y <= Math.min(maxY, image.height - 1); y++) {
		for (let x = minX; x <= Math.min(maxX, image.width - 1); x++) {
			max = Math.max(max, image.pixels[(y * image.width + x) * 4 + 3]);
		}
	}
	return max;
}

function maxAlpha(pixels: Uint8Array): number {
	let max = 0;
	for (let i = 3; i < pixels.length; i += 4) {
		max = Math.max(max, pixels[i]);
	}
	return max;
}
