// Text system exports

export { buildDocumentTextResolver } from "./documentTextResolver";
export {
	type FontFile,
	FontLoader,
	type FontMetadata,
	type LoadedFont,
} from "./fonts/FontLoader";
export { GoogleFontsLoader } from "./fonts/GoogleFontsLoader";
export {
	type FontData,
	type LocalFontBackend,
	LocalFontsLoader,
} from "./fonts/LocalFontsLoader";
export { FONT_SCRIPT_ORDER, type FontScript } from "./fonts/os2Scripts";
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
