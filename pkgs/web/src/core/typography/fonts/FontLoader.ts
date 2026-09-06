/**
 * FontLoader - 共通インターフェース
 * Google FontsとLocal Fontsで統一されたAPIを提供
 */

import type { Font } from "fontkit";
import type { FontScript } from "./os2Scripts";

/**
 * Catalog-level metadata for a font, shared between Google Fonts and the
 * Local Font Access API. Only the fields produced by both backends are
 * required; localized records are populated lazily once a font is parsed.
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
	/** Origin of the font record. */
	source: "google" | "local" | "embedded";
	/** Available variants for the family (Google Fonts catalog only). */
	variants?: string[];
	/** Localized family name resolved from the font's `name` table, if any. */
	localizedFamily?: string;
	/** Localized full name resolved from the font's `name` table, if any. */
	localizedFullName?: string;
	/**
	 * Writing systems the font covers. Known at query time for Google Fonts;
	 * resolved lazily from the `OS/2` table for local fonts.
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
	// fontkit v2: getName(key, lang) returns null when the language record is absent.
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
	/** CSS用URL（Google Fonts用） */
	cssUrl?: string;
	/** CSS用font-family名（DOMプレビュー用） */
	cssFontFamily: string;
	/** フォントデータ（ArrayBuffer） */
	data: ArrayBuffer;
}

/**
 * フォントローダーインターフェース
 * Google FontsとLocal Fontsで共通
 */
export interface FontLoader {
	/**
	 * 利用可能なフォント一覧を取得
	 */
	queryFonts(): Promise<FontMetadata[]>;

	/**
	 * フォントをロード
	 * @param identifier - フォント識別子（familyまたはpostScriptName）
	 * @param weight - オプショナルなウェイト指定
	 */
	loadFont(identifier: string, weight?: number): Promise<LoadedFont | null>;

	/**
	 * フォントがロード済みかチェック
	 */
	isLoaded(identifier: string): boolean;

	/**
	 * ロード済みフォントを取得
	 */
	getLoadedFont(identifier: string): LoadedFont | undefined;

	/**
	 * フォントを検索
	 */
	searchFonts(query: string): Promise<FontMetadata[]>;
}

/**
 * フォントキャッシュキーを生成
 */
export function getFontCacheKey(family: string, weight = 400): string {
	return `${family}:${weight}`;
}

/**
 * CSSウェイト値を数値に変換
 */
export function parseWeightString(weight: string): number {
	const weightMap: Record<string, number> = {
		thin: 100,
		hairline: 100,
		extralight: 200,
		ultralight: 200,
		light: 300,
		regular: 400,
		normal: 400,
		medium: 500,
		semibold: 600,
		demibold: 600,
		bold: 700,
		extrabold: 800,
		ultrabold: 800,
		black: 900,
		heavy: 900,
	};

	const normalized = weight.toLowerCase().replace(/[^a-z0-9]/g, "");

	// 数値の場合
	const numWeight = Number.parseInt(normalized, 10);
	if (!Number.isNaN(numWeight)) {
		return numWeight;
	}

	// 文字列の場合
	return weightMap[normalized] ?? 400;
}

/**
 * フォントスタイルをパース
 */
export function parseFontStyle(style: string): "normal" | "italic" | "oblique" {
	const normalized = style.toLowerCase();
	if (normalized.includes("italic")) return "italic";
	if (normalized.includes("oblique")) return "oblique";
	return "normal";
}
