import { classifyFilterHandler } from "../../renderer/canvas/pipeline/FilterRenderer";
import type { RenderOrchestrator } from "../../renderer/RenderOrchestrator";
import {
	type Document,
	getArtboardBounds,
	type RawRGBA,
	toRGBColor,
} from "../../schema";
import type { ClassifyOptions } from "./svg/classify";
import { colorToSvgPaint } from "./svg/paintServer";
import { createCoordMapper } from "./svg/pathData";
import { renderRasterChunk } from "./svg/rasterChunk";
import {
	type SerializeContext,
	serializePlanItems,
} from "./svg/serializeElement";
import { SvgDocumentBuilder } from "./svg/svgBuilder";

export interface SVGExportOptions {
	/** Background rect color. Defaults to opaque white, matching PNG export. */
	backgroundColor?: RawRGBA;
}

interface SVGExportResult {
	blob: Blob;
	svg: string;
	width: number;
	height: number;
}

/**
 * SVG exporter. SVG-representable elements are serialized as vector markup
 * (text is always outlined); elements that require rasterization are rendered
 * in z-consecutive chunks at the document's rasterization DPI and embedded as
 * PNG data URLs. Backdrop references across layers are a known limitation —
 * a backdrop-dependent element only composites against its own layer.
 */
export class PaplicoSVGExporter {
	public constructor(
		private renderer: RenderOrchestrator,
		private getDocument: () => Document,
	) {}

	/**
	 * Export an artboard to SVG and trigger download.
	 */
	public async asSVG(
		artboardId: string,
		options: SVGExportOptions & { filename?: string } = {},
	): Promise<boolean> {
		const { filename, ...exportOpts } = options;
		const result = await this.renderArtboardToSVG(artboardId, exportOpts);
		if (!result) return false;

		const artboard = this.getDocument().artboards.find(
			(a) => a.id === artboardId,
		);
		const defaultFilename = artboard
			? `${artboard.name.replace(/[^a-zA-Z0-9-_]/g, "_")}.svg`
			: "export.svg";

		const url = URL.createObjectURL(result.blob);
		const link = globalThis.document.createElement("a");
		link.href = url;
		link.download = filename ?? defaultFilename;
		link.click();
		URL.revokeObjectURL(url);

		return true;
	}

	/**
	 * Export an artboard to an SVG string/blob without downloading.
	 */
	public async renderArtboardToSVG(
		artboardId: string,
		options: SVGExportOptions = {},
	): Promise<SVGExportResult | null> {
		const doc = this.getDocument();
		const artboard = doc.artboards.find((a) => a.id === artboardId);
		if (!artboard) {
			console.error(`Artboard not found: ${artboardId}`);
			return null;
		}

		const builder = new SvgDocumentBuilder({
			width: artboard.width,
			height: artboard.height,
		});
		const ctx = this.createSerializeContext(doc, artboard, builder);

		const background = options.backgroundColor ?? { r: 1, g: 1, b: 1, a: 1 };
		if (background.a > 0) {
			const paint = colorToSvgPaint(toRGBColor(background));
			builder.appendChild({
				tag: "rect",
				attrs: {
					x: 0,
					y: 0,
					width: artboard.width,
					height: artboard.height,
					fill: paint.paint,
					...(paint.opacity < 1 ? { "fill-opacity": paint.opacity } : {}),
				},
			});
		}

		for (const layer of doc.layers) {
			if (!layer.visible || layer.transientKind) continue;
			const nodes = await serializePlanItems(layer.elementIds, ctx);
			if (nodes.length === 0) continue;

			const attrs: Record<string, string | number> = {};
			if (layer.opacity < 1) attrs.opacity = layer.opacity;
			if (layer.blendMode && layer.blendMode !== "normal") {
				attrs.style = `mix-blend-mode:${layer.blendMode}`;
			}
			builder.appendChild({ tag: "g", attrs, children: nodes });
		}

		const svg = builder.serialize();
		return {
			svg,
			blob: new Blob([svg], { type: "image/svg+xml" }),
			width: artboard.width,
			height: artboard.height,
		};
	}

	private createSerializeContext(
		doc: Document,
		artboard: Document["artboards"][number],
		builder: SvgDocumentBuilder,
	): SerializeContext {
		const textRenderer = this.renderer.getTextRenderer();
		const artboardBounds = getArtboardBounds(artboard);
		const rasterScale = (doc.rasterizationDpi ?? 72) / 72;

		const classify: ClassifyOptions = {
			document: doc,
			filterKind: (filter) =>
				classifyFilterHandler(this.renderer.getFilterHandler(filter.processor)),
			filterReplacesElementRender: (filter) =>
				this.renderer
					.getFilterHandler(filter.processor)
					?.replacesElementRender?.(filter) ?? false,
			filterNeedsBackdrop: (filter) =>
				this.renderer
					.getFilterHandler(filter.processor)
					?.getRenderConfigure?.(filter).needsBackdrop ?? false,
		};

		return {
			document: doc,
			elementsMap: new Map(Object.entries(doc.objects)),
			builder,
			mapper: createCoordMapper(artboard),
			viewBox: { width: artboard.width, height: artboard.height },
			classify,
			cullBounds: artboardBounds,
			filterResolver: {
				getHandler: (processor) => this.renderer.getFilterHandler(processor),
			},
			outlineText: (element) =>
				textRenderer
					? textRenderer.textElementToOutlinedPaths(element)
					: Promise.resolve({
							outlinedPaths: [],
							bounds: {
								minX: 0,
								minY: 0,
								maxX: 0,
								maxY: 0,
								width: 0,
								height: 0,
							},
						}),
			getTextPaintSource: (element) =>
				textRenderer?.getFlowHead(element) ?? element,
			renderRasterRun: (elementIds) =>
				renderRasterChunk(
					this.renderer,
					doc,
					elementIds,
					artboardBounds,
					rasterScale,
				),
			patternBaseIds: new Map(),
			state: { invertFilterId: null },
		};
	}
}
