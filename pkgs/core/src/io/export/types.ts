import type { BuiltinIccProfileId } from "../../color/types";
import type { RenderOrchestrator } from "../../renderer/RenderOrchestrator";
import type { Document } from "../../schema";

/**
 * An output format for artboard export. Format-specific settings belong to
 * the implementation's constructor; `Paplico.exportArtboard` supplies the
 * context at export time.
 */
export interface IExporter {
	export(ctx: ExportContext, artboardId: string): Promise<ExportResult | null>;
}

/** What an exporter receives from `Paplico.exportArtboard`. */
export interface ExportContext {
	readonly document: Document;
	readonly renderer: ExportRenderer;
	/** Target the artboard rasters are drawn through. Set for a document that
	 *  is not the live one, so its element ids stay out of the editor's cache
	 *  scope; omitted, the editor's active target draws them. */
	readonly targetId?: string;
	getBuiltinProfileBytes(id: BuiltinIccProfileId): Promise<Uint8Array>;
}

/** The rendering entry points exporters are allowed to use. */
export type ExportRenderer = Pick<
	RenderOrchestrator,
	| "renderArtboardToImageData"
	| "renderArtboardToFloat32"
	| "renderElementsToImageData"
	| "computeElementsExportBounds"
	| "ensureTextDocumentResolver"
	| "getTextRenderer"
	| "getFilterHandler"
	| "calculateFilterExpansion"
	| "dropDocumentCaches"
>;

export interface ExportResult {
	blob: Blob;
	width: number;
	height: number;
}
