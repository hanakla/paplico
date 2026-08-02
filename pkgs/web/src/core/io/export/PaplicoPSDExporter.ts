import {
	type BlendMode as PSDBlendMode,
	type Layer as PSDLayer,
	type Psd,
	writePsd,
} from "ag-psd";
import type { RenderOrchestrator } from "../../renderer/RenderOrchestrator";
import {
	type Artboard,
	type BlendMode,
	type Document,
	getArtboardBounds,
	type Layer,
	type RawRGBA,
} from "../../schema";
import { injectIccProfileIntoPsd } from "./psdIcc";

interface PSDExportOptions {
	/** Scale factor (1 = 100%, 2 = 200% / @2x) - Phase 1: fixed at 1 */
	scale?: number;
	/** Background color (default: white) */
	backgroundColor?: RawRGBA;
	/** ICC profile to embed into the exported PSD (image resource 1039) */
	iccProfile?: { data: Uint8Array };
}

interface ExportResult {
	blob: Blob;
	width: number;
	height: number;
}

/**
 * PSD (Photoshop Document) exporter for Paplico.
 * Exports artboards to PSD format preserving layer structure.
 *
 * Phase 1 Limitations:
 * - Text layers are rasterized (not editable)
 * - Groups are flattened
 * - Filters (Blur, DropShadow, etc.) are baked into pixels
 * - FreeGradient is rasterized
 * - Scale is fixed at 1x
 */
export class PaplicoPSDExporter {
	public constructor(
		private renderer: RenderOrchestrator,
		private getDocument: () => Document,
	) {}

	/**
	 * Export an artboard to PSD and trigger download.
	 */
	public async asPSD(
		artboardId: string,
		options: PSDExportOptions & { filename?: string } = {},
	): Promise<boolean> {
		const { filename, ...exportOpts } = options;
		const result = await this.renderArtboardToPSD(artboardId, exportOpts);
		if (!result) return false;

		const artboard = this.getDocument().artboards.find(
			(a) => a.id === artboardId,
		);
		const defaultFilename = artboard
			? `${artboard.name.replace(/[^a-zA-Z0-9-_]/g, "_")}.psd`
			: "export.psd";

		const url = URL.createObjectURL(result.blob);
		const link = globalThis.document.createElement("a");
		link.href = url;
		link.download = filename ?? defaultFilename;
		link.click();
		URL.revokeObjectURL(url);

		console.log(
			`📥 Downloaded: ${link.download} (${result.width}x${result.height})`,
		);

		return true;
	}

	/**
	 * Export an artboard to PSD blob without downloading.
	 */
	private async renderArtboardToPSD(
		artboardId: string,
		options: PSDExportOptions = {},
	): Promise<ExportResult | null> {
		const { scale = 1, backgroundColor = { r: 1, g: 1, b: 1, a: 1 } } = options;
		const doc = this.getDocument();

		const artboard = doc.artboards.find((a) => a.id === artboardId);
		if (!artboard) {
			console.error(`Artboard not found: ${artboardId}`);
			return null;
		}

		const bounds = getArtboardBounds(artboard);
		const width = Math.round(bounds.width * scale);
		const height = Math.round(bounds.height * scale);

		// Render each visible layer to PSD layer
		const psdLayers: PSDLayer[] = [];

		for (const layer of doc.layers) {
			if (!layer.visible || layer.elementIds.length === 0) {
				continue;
			}

			const imageData = await this.renderLayerToImageData(
				layer,
				doc,
				artboard,
				scale,
			);

			if (!imageData) continue;

			const canvas = this.imageDataToCanvas(imageData);

			psdLayers.push({
				name: layer.name,
				opacity: Math.round(layer.opacity * 255),
				blendMode: this.mapBlendMode(layer.blendMode ?? "normal"),
				hidden: !layer.visible,
				canvas,
			});
		}

		if (psdLayers.length === 0) {
			console.error("No visible layers to export");
			return null;
		}

		// Build PSD document
		const psdDocument: Psd = {
			width,
			height,
			children: psdLayers,
		};

		const arrayBuffer = writePsd(psdDocument, { compress: true });
		let psdBytes = new Uint8Array(arrayBuffer);
		if (options.iccProfile) {
			psdBytes = injectIccProfileIntoPsd(psdBytes, options.iccProfile.data);
		}
		const blob = new Blob([psdBytes], {
			type: "image/vnd.adobe.photoshop",
		});

		return { blob, width, height };
	}

	/**
	 * Render a single layer's elements to ImageData using RenderOrchestrator.
	 */
	private async renderLayerToImageData(
		layer: Layer,
		document: Document,
		artboard: Artboard,
		scale: number,
	): Promise<ImageData | null> {
		if (!layer.visible || layer.elementIds.length === 0) {
			return null;
		}

		const bounds = getArtboardBounds(artboard);

		return await this.renderer.renderElementsToImageData(
			layer.elementIds,
			document,
			{
				centerX: artboard.x,
				centerY: artboard.y,
				width: bounds.width,
				height: bounds.height,
			},
			scale,
			{ r: 0, g: 0, b: 0, a: 0 }, // Transparent background for layers
		);
	}

	/**
	 * Map Paplico BlendMode to PSD blend mode string.
	 * All 12 Paplico blend modes have direct PSD equivalents.
	 */
	private mapBlendMode(paplicoMode: BlendMode): PSDBlendMode {
		const mapping: Record<BlendMode, PSDBlendMode> = {
			normal: "normal",
			multiply: "multiply",
			screen: "screen",
			overlay: "overlay",
			darken: "darken",
			lighten: "lighten",
			"color-dodge": "color dodge",
			"color-burn": "color burn",
			"hard-light": "hard light",
			"soft-light": "soft light",
			difference: "difference",
			exclusion: "exclusion",
		};
		return mapping[paplicoMode];
	}

	/**
	 * Convert ImageData to HTMLCanvasElement (ag-psd requirement).
	 */
	private imageDataToCanvas(imageData: ImageData): HTMLCanvasElement {
		const canvas = globalThis.document.createElement("canvas");
		canvas.width = imageData.width;
		canvas.height = imageData.height;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			throw new Error("Failed to get 2D context for PSD export");
		}
		ctx.putImageData(imageData, 0, 0);
		return canvas;
	}
}
