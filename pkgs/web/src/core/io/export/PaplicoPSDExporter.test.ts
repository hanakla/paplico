import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentityTransform } from "../../document/factory";
import type { RenderOrchestrator } from "../../renderer/RenderOrchestrator";
import type { AnyArtObject, Artboard, Document, Layer } from "../../schema";
import { PaplicoPSDExporter } from "./PaplicoPSDExporter";

describe("PaplicoPSDExporter", () => {
	let mockRenderer: RenderOrchestrator;
	let mockGetDocument: () => Document;
	let exporter: PaplicoPSDExporter;

	const createMockDocument = (): Document => ({
		id: "doc1",
		objects: {
			path1: {
				id: "path1",
				type: "path",
				width: 1,
				segments: [],
				opacity: 1,
				blendMode: "normal",
				visible: true,
				locked: false,
				transform: createIdentityTransform(),
			},
		} as Record<string, AnyArtObject>,
		viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
		layers: [
			{
				id: "layer1",
				name: "Layer 1",
				elementIds: ["path1"],
				opacity: 0.5,
				blendMode: "multiply",
				visible: true,
				locked: false,
			},
			{
				id: "layer2",
				name: "Layer 2 (Hidden)",
				elementIds: [],
				opacity: 1,
				blendMode: "normal",
				visible: false,
				locked: false,
			},
		] as Layer[],
		files: [],
		artboards: [
			{
				id: "artboard1",
				name: "Test Artboard",
				x: 0,
				y: 0,
				width: 800,
				height: 600,
			},
		] as Artboard[],
		brushPresets: [],
		units: "px",
	});

	beforeEach(() => {
		const mockDocument = createMockDocument();
		mockGetDocument = vi.fn(() => mockDocument);

		mockRenderer = {
			renderElementsToImageData: vi.fn(async () => {
				// Return mock ImageData
				return {
					width: 800,
					height: 600,
					data: new Uint8ClampedArray(800 * 600 * 4),
				} as ImageData;
			}),
		} as unknown as RenderOrchestrator;

		exporter = new PaplicoPSDExporter(mockRenderer, mockGetDocument);
	});

	describe("mapBlendMode", () => {
		it("should map all 12 Paplico blend modes to PSD equivalents", () => {
			const blendModes = [
				{ paplico: "normal", psd: "normal" },
				{ paplico: "multiply", psd: "multiply" },
				{ paplico: "screen", psd: "screen" },
				{ paplico: "overlay", psd: "overlay" },
				{ paplico: "darken", psd: "darken" },
				{ paplico: "lighten", psd: "lighten" },
				{ paplico: "color-dodge", psd: "color dodge" },
				{ paplico: "color-burn", psd: "color burn" },
				{ paplico: "hard-light", psd: "hard light" },
				{ paplico: "soft-light", psd: "soft light" },
				{ paplico: "difference", psd: "difference" },
				{ paplico: "exclusion", psd: "exclusion" },
			] as const;

			for (const { paplico, psd } of blendModes) {
				const result = (exporter as any).mapBlendMode(paplico);
				expect(result).toBe(psd);
			}
		});
	});

	describe("imageDataToCanvas", () => {
		// Skip: happy-dom doesn't fully support Canvas 2D context
		it.skip("should convert ImageData to HTMLCanvasElement", () => {
			const imageData = {
				width: 100,
				height: 100,
				data: new Uint8ClampedArray(100 * 100 * 4),
			} as ImageData;
			const canvas = (exporter as any).imageDataToCanvas(imageData);

			expect(canvas).toBeInstanceOf(HTMLCanvasElement);
			expect(canvas.width).toBe(100);
			expect(canvas.height).toBe(100);
		});
	});

	describe("renderLayerToImageData", () => {
		it("should return null for invisible layers", async () => {
			const invisibleLayer: Layer = {
				id: "layer3",
				name: "Invisible",
				elementIds: ["path1"],
				opacity: 1,
				blendMode: "normal",
				visible: false,
				locked: false,
			};

			const result = await (exporter as any).renderLayerToImageData(
				invisibleLayer,
				mockGetDocument(),
				mockGetDocument().artboards[0],
				1,
			);

			expect(result).toBeNull();
		});

		it("should return null for empty layers", async () => {
			const emptyLayer: Layer = {
				id: "layer4",
				name: "Empty",
				elementIds: [],
				opacity: 1,
				blendMode: "normal",
				visible: true,
				locked: false,
			};

			const result = await (exporter as any).renderLayerToImageData(
				emptyLayer,
				mockGetDocument(),
				mockGetDocument().artboards[0],
				1,
			);

			expect(result).toBeNull();
		});

		it("should call renderer.renderElementsToImageData for visible layers", async () => {
			const layer = mockGetDocument().layers[0];
			const artboard = mockGetDocument().artboards[0];

			await (exporter as any).renderLayerToImageData(
				layer,
				mockGetDocument(),
				artboard,
				1,
			);

			expect(mockRenderer.renderElementsToImageData).toHaveBeenCalledWith(
				layer.elementIds,
				expect.any(Object),
				{
					centerX: artboard.x,
					centerY: artboard.y,
					width: 800,
					height: 600,
				},
				1,
				{ r: 0, g: 0, b: 0, a: 0 },
			);
		});
	});

	describe("asPSD", () => {
		it("should return false for non-existent artboard", async () => {
			const result = await exporter.asPSD("nonexistent");
			expect(result).toBe(false);
		});
	});
});
