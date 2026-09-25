// Text system exports

export { buildDocumentTextResolver } from "./documentTextResolver";
export {
	FONT_SCRIPT_ORDER,
	type FontMetadata,
	type FontScript,
	getFontManager,
} from "./fonts";
export type {
	LayoutedChar,
	LayoutedLine,
	LayoutResult,
} from "./TextLayoutEngine";
export { TextLayoutEngine } from "./TextLayoutEngine";
export {
	type TextDocumentResolver,
	TextRenderer,
} from "./TextRenderer";
