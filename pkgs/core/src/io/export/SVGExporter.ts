import {
	mapLocalAppearances,
	resolveElementsMapAppearance,
} from "../../document/appearancePresets";
import { classifyFilterHandler } from "../../renderer/canvas/pipeline/FilterRenderer";
import {
	type Document,
	type Filter,
	generateUid,
	getArtboardBounds,
	type RawRGBA,
	toRGBColor,
} from "../../schema";
import { type ClassifyOptions, collectTextAxisPathIds } from "./svg/classify";
import { colorToSvgPaint } from "./svg/paintServer";
import { createCoordMapper } from "./svg/pathData";
import { renderRasterChunk } from "./svg/rasterChunk";
import {
	type SerializeContext,
	serializePlanItems,
} from "./svg/serializeElement";
import { SvgDocumentBuilder } from "./svg/svgBuilder";
import { isSvgNativeFilter } from "./svg/svgFilterPrimitives";
import type {
	ExportContext,
	ExportRenderer,
	ExportResult,
	IExporter,
} from "./types";

interface SVGExportOptions {
	/** Background rect color. Defaults to opaque white, matching PNG export. */
	backgroundColor?: RawRGBA;
	/**
	 * Export as if every filter other than fills, strokes, `svg:*` filters and
	 * geometry filters were turned off, so as little as possible ends up
	 * rasterized. The document itself is left untouched.
	 */
	disableIncompatibleFilters?: boolean;
}

interface SVGExportResult extends ExportResult {
	svg: string;
}

/**
 * SVG exporter. SVG-representable elements are serialized as vector markup
 * (text is always outlined); elements that require rasterization are rendered
 * in z-consecutive chunks at the document's rasterization DPI and embedded as
 * PNG data URLs. Backdrop references across layers are a known limitation —
 * a backdrop-dependent element only composites against its own layer.
 */
export class SVGExporter implements IExporter {
	public constructor(private options: SVGExportOptions = {}) {}

	public async export(
		ctx: ExportContext,
		artboardId: string,
	): Promise<SVGExportResult | null> {
		const doc = this.options.disableIncompatibleFilters
			? withoutIncompatibleFilters(ctx.document, ctx.renderer)
			: ctx.document;
		const artboard = doc.artboards.find((a) => a.id === artboardId);
		if (!artboard) {
			console.error(`Artboard not found: ${artboardId}`);
			return null;
		}

		// Text outlining resolves flow chains and path/shape bindings through
		// the TextRenderer's document resolver — without it, flow members and
		// axis-bound texts outline their leftover content literally.
		const restoreTextDocumentResolver =
			ctx.renderer.ensureTextDocumentResolver(doc);
		try {
			return await this.renderInner(ctx.renderer, doc, artboard);
		} finally {
			restoreTextDocumentResolver();
			// The filtered copy renders its raster chunks under its own cache
			// scope; nothing will draw that document again.
			if (doc !== ctx.document) ctx.renderer.dropDocumentCaches(doc.id);
		}
	}

	private async renderInner(
		renderer: ExportRenderer,
		doc: Document,
		artboard: Document["artboards"][number],
	): Promise<SVGExportResult | null> {
		const builder = new SvgDocumentBuilder({
			width: artboard.width,
			height: artboard.height,
		});
		const ctx = this.createSerializeContext(renderer, doc, artboard, builder);

		const background = this.options.backgroundColor ?? {
			r: 1,
			g: 1,
			b: 1,
			a: 1,
		};
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
		renderer: ExportRenderer,
		doc: Document,
		artboard: Document["artboards"][number],
		builder: SvgDocumentBuilder,
	): SerializeContext {
		const textRenderer = renderer.getTextRenderer();
		const artboardBounds = getArtboardBounds(artboard);
		const rasterScale = (doc.rasterizationDpi ?? 72) / 72;

		const classify: ClassifyOptions = {
			document: doc,
			textAxisPathIds: collectTextAxisPathIds(doc),
			filterKind: (filter) =>
				classifyFilterHandler(renderer.getFilterHandler(filter.processor)),
			filterReplacesElementRender: (filter) =>
				renderer
					.getFilterHandler(filter.processor)
					?.replacesElementRender?.(filter) ?? false,
			filterNeedsBackdrop: (filter) =>
				renderer
					.getFilterHandler(filter.processor)
					?.getRenderConfigure?.(filter).needsBackdrop ?? false,
		};

		// Expand appearance preset refs once so serialization only sees concrete filters.
		const elementsMap = new Map(Object.entries(doc.objects));
		resolveElementsMapAppearance(elementsMap, doc);

		return {
			document: doc,
			elementsMap,
			builder,
			mapper: createCoordMapper(artboard),
			viewBox: { width: artboard.width, height: artboard.height },
			classify,
			cullBounds: artboardBounds,
			filterResolver: {
				getHandler: (processor) => renderer.getFilterHandler(processor),
				calculateExpansion: (filters, bounds) =>
					renderer.calculateFilterExpansion(filters, bounds),
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
					renderer,
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

/**
 * A copy of the document whose filters SVG cannot express are disabled,
 * sub-filters and preset appearances included. It gets its own id so its
 * renders never share cache entries with the live document's elements.
 */
function withoutIncompatibleFilters(
	doc: Document,
	renderer: ExportRenderer,
): Document {
	const disable = (filter: Filter): Filter => {
		const compatible =
			isSvgNativeFilter(filter.processor) ||
			classifyFilterHandler(renderer.getFilterHandler(filter.processor)) !==
				"raster";
		return {
			...filter,
			...(compatible ? {} : { enabled: false }),
			...(filter.subFilters
				? { subFilters: filter.subFilters.map(disable) }
				: {}),
		};
	};
	// Preset appearances are expanded first so their filters are judged too.
	const elements = new Map(Object.entries(doc.objects));
	resolveElementsMapAppearance(elements, doc);
	return {
		...doc,
		id: generateUid("svg-export"),
		objects: Object.fromEntries(
			elements.entries().map(([id, element]) => [
				id,
				element.filters
					? {
							...element,
							filters: mapLocalAppearances(element.filters, (filters) =>
								filters.map(disable),
							),
						}
					: element,
			]),
		),
	};
}
