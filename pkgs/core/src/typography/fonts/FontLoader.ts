/**
 * Contract between FontManager and the font loaders the host app registers.
 */

import type { Font } from "@cantoo/fontkit";
import * as fontkit from "@cantoo/fontkit";
import { fontFaceWeight } from "./fontVariations";
import type { FontScript } from "./os2Scripts";

/**
 * Catalog-level metadata for a font, shared by every font loader. Localized
 * records are populated lazily once a font is parsed.
 */
export interface FontMetadata {
	/** Font family name. */
	family: string;
	/** Full font name (typically family + subfamily). */
	fullName: string;
	/** PostScript name; used to identify a specific local font face. */
	postScriptName: string;
	/** Subfamily / style descriptor, e.g. "Regular", "Bold", "Italic". */
	style: string;
	/** Numeric font weight in the 100–900 range. */
	weight: number;
	/** `FontLoader.id` of the loader that offers this font. */
	loaderId: string;
	/** Identifier the loader resolves; becomes `FontSource.fontId`. */
	fontId: string;
	/** Localized family name resolved from the font's `name` table, if any. */
	localizedFamily?: string;
	/** Localized full name resolved from the font's `name` table, if any. */
	localizedFullName?: string;
	/**
	 * Writing systems the font covers, when the catalog knows them. Otherwise
	 * the loader may resolve them later through `FontLoader.getScripts`.
	 */
	scripts?: FontScript[];
}

/**
 * Extract localized names for the given BCP-47 language tag from a fontkit
 * Font's `name` table. Returns an empty object when no records exist for
 * the requested language.
 */
export function extractLocalizedNames(
	font: Font,
	lang = "ja",
): {
	localizedFamily?: string;
	localizedFullName?: string;
} {
	const family = font.getName("fontFamily", lang);
	const fullName = font.getName("fullName", lang);
	return {
		...(family ? { localizedFamily: family } : {}),
		...(fullName ? { localizedFullName: fullName } : {}),
	};
}

/**
 * ロード済みフォント
 */
export interface LoadedFont {
	/** フォントメタデータ */
	metadata: FontMetadata;
	/** Fontkitフォントオブジェクト */
	fontkit: Font;
	/** フォントデータ（ArrayBuffer） */
	data: ArrayBuffer;
}

/** The file of one font, as a loader fetched it. */
export interface FontFile {
	/** Font file bytes (TTF, OTF, WOFF2 or a TrueType collection). */
	data: ArrayBuffer;
	/**
	 * Metadata of the font. In a collection, `postScriptName` selects the
	 * face to use.
	 */
	metadata: Omit<FontMetadata, "loaderId" | "fontId">;
	/**
	 * Family name the font is registered under for DOM rendering such as the
	 * font picker preview. Defaults to `metadata.family`.
	 */
	cssFamily?: string;
}

/**
 * Resolves fonts from one source (a web catalog, the OS, an app bundle, ...).
 * The host app passes its loaders to Paplico; text styles name a loader by
 * `id` through `FontSource.loaderId`.
 *
 * Subclasses only list fonts and fetch their files. Parsing, caching and DOM
 * registration happen here.
 */
export abstract class FontLoader {
	/** Stored in documents as `FontSource.loaderId`; must stay stable across releases. */
	public abstract readonly id: string;
	/** Name shown to users, e.g. as a font picker tab. */
	public abstract readonly label: string;
	private loadedFonts = new Map<string, LoadedFont>();
	private loadingPromises = new Map<string, Promise<LoadedFont | null>>();

	/** List the fonts this loader offers. */
	public abstract queryFonts(): Promise<FontMetadata[]>;

	/** Load a font, deduplicating concurrent and repeated loads. */
	public async loadFont(fontId: string): Promise<LoadedFont | null> {
		const cached = this.loadedFonts.get(fontId);
		if (cached) return cached;

		const loading = this.loadingPromises.get(fontId);
		if (loading) return loading;

		const loadPromise = this.doLoadFont(fontId);
		this.loadingPromises.set(fontId, loadPromise);
		try {
			return await loadPromise;
		} finally {
			this.loadingPromises.delete(fontId);
		}
	}

	/** Return a font that already finished loading. */
	public getLoadedFont(fontId: string): LoadedFont | undefined {
		return this.loadedFonts.get(fontId);
	}

	/**
	 * Writing systems of a queried font, or null while unknown. Implemented by
	 * loaders whose catalog cannot tell them up front.
	 */
	public getScripts?(fontId: string): FontScript[] | null;

	/**
	 * Detect the writing systems of every queried font in the background.
	 * `onProgress` is called as results arrive and once after the last one.
	 */
	public resolveScripts?(onProgress: () => void): Promise<void>;

	/** Fetch the file of one font, or null when the loader has no such font. */
	protected abstract fetchFont(fontId: string): Promise<FontFile | null>;

	private async doLoadFont(fontId: string): Promise<LoadedFont | null> {
		const file = await this.fetchFont(fontId);
		if (!file) return null;

		const parsed = fontkit.create(new Uint8Array(file.data));
		const font =
			"fonts" in parsed
				? parsed.fonts.find(
						(face) => face.postscriptName === file.metadata.postScriptName,
					)
				: parsed;
		if (!font) return null;

		const loadedFont: LoadedFont = {
			metadata: {
				...file.metadata,
				loaderId: this.id,
				fontId,
				...extractLocalizedNames(font),
			},
			fontkit: font,
			data: file.data,
		};
		await registerFontFace(file.cssFamily ?? file.metadata.family, loadedFont);
		this.loadedFonts.set(fontId, loadedFont);
		return loadedFont;
	}
}

/**
 * Make a loaded font usable by DOM text, e.g. the font picker preview.
 * Skipped where there is no DOM font API, such as tests on Node.
 */
async function registerFontFace(
	family: string,
	{ metadata, fontkit: font, data }: LoadedFont,
): Promise<void> {
	if (typeof FontFace === "undefined") return;
	try {
		const fontFace = new FontFace(family, data, {
			weight: fontFaceWeight(font, metadata.weight),
			style: parseFontStyle(metadata.style),
		});
		await fontFace.load();
		document.fonts.add(fontFace);
	} catch (error) {
		console.error(`Failed to register font face ${family}:`, error);
	}
}

function parseFontStyle(style: string): "normal" | "italic" | "oblique" {
	const normalized = style.toLowerCase();
	if (normalized.includes("italic")) return "italic";
	if (normalized.includes("oblique")) return "oblique";
	return "normal";
}
