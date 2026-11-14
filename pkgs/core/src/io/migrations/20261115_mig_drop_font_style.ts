import { isText, type TextStyle } from "../../schema";
import type { Migration } from "./index";

type LegacyTextStyle = TextStyle & { fontStyle?: string };

/**
 * Remove `fontStyle` from text styles. The face in `fontSource` decides
 * whether text is italic. An italic style used to set the `ital` axis of a
 * variable font that had no explicit `ital` coordinate, so that coordinate
 * moves into `fontVariationSettings` to keep the text looking the same.
 */
export const migDropFontStyle: Migration = {
	version: 20261115,
	migrate(doc): void {
		for (const element of Object.values(doc.objects)) {
			if (!element || !isText(element)) continue;

			const base: LegacyTextStyle = element.defaultStyle;
			for (const paragraph of element.content.paragraphs) {
				for (const run of paragraph.runs) {
					run.style = dropFontStyle(run.style, base);
				}
			}
			element.defaultStyle = dropFontStyle(base, base);
		}
	},
};

/** `base` supplies the values a run style leaves to the element's default. */
function dropFontStyle(
	style: LegacyTextStyle,
	base: LegacyTextStyle,
): TextStyle {
	const { fontStyle, ...rest } = style;
	const settings = style.fontVariationSettings ?? base.fontVariationSettings;
	if (
		(fontStyle ?? base.fontStyle) !== "italic" ||
		Number.isFinite(settings?.ital)
	) {
		return rest;
	}
	return { ...rest, fontVariationSettings: { ...settings, ital: 1 } };
}
