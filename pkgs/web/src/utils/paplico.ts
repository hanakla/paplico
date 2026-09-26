/**
 * App-side defaults handed to the Paplico engine at startup.
 */

import type { TextStyle } from "@paplico/core/schema";

type DefaultFont = Pick<TextStyle, "fontFamily" | "fontSource">;

/**
 * Default text font per UI language. Every entry names a Google Fonts family
 * so a document keeps the same glyphs on any machine that opens it, and the
 * Noto family covers every language the app speaks.
 */
const FALLBACK_FONT: DefaultFont = {
	fontFamily: "Noto Sans",
	fontSource: { loaderId: "google", fontId: "Noto Sans" },
};

const FONT_BY_LANGUAGE: Record<string, DefaultFont> = {
	ja: {
		fontFamily: "Noto Sans JP",
		fontSource: { loaderId: "google", fontId: "Noto Sans JP" },
	},
};

/**
 * Resolves the default text font for a BCP 47 language tag such as `ja` or
 * `ja-JP`.
 */
export function resolveDefaultFontForLanguage(language: string): DefaultFont {
	const primary = language.toLowerCase().split("-")[0];
	return structuredClone(FONT_BY_LANGUAGE[primary] ?? FALLBACK_FONT);
}
