import * as fs from "node:fs";
import * as path from "node:path";
import * as fontkit from "fontkit";
import type { LoadedFont } from "../typography/fonts/FontLoader";
import type { FontManager } from "../typography/fonts/FontManager";

export const NOTO_SANS_JP_PATH = path.resolve(
	__dirname,
	"assets/NotoSansJP-VariableFont_wght.ttf",
);

export const NOTO_SANS_JP_POST_SCRIPT_NAME = "NotoSansJP-VariableFont_wght";
const NOTO_SANS_JP_FAMILY = "Noto Sans JP";

/**
 * Load NotoSansJP from the bundled test asset and register it into FontManager.
 * The fixture answers both the local source keyed by
 * NOTO_SANS_JP_POST_SCRIPT_NAME and the Google source "Noto Sans JP" that the
 * test document references, so text renders offline.
 */
export function loadTestFont(fontManager: FontManager): LoadedFont {
	return loadFontFixture(fontManager, NOTO_SANS_JP_PATH, {
		family: NOTO_SANS_JP_FAMILY,
		postScriptName: NOTO_SANS_JP_POST_SCRIPT_NAME,
	});
}

/** Load the multi-axis fixture without network access. */
export function loadRobotoFlexFont(fontManager: FontManager): LoadedFont {
	return loadFontFixture(
		fontManager,
		path.resolve(__dirname, "assets/RobotoFlex.ttf"),
	);
}

function loadFontFixture(
	fontManager: FontManager,
	filePath: string,
	names: { family?: string; postScriptName?: string } = {},
): LoadedFont {
	const buffer = fs.readFileSync(filePath);
	const fontResult = fontkit.create(buffer);
	const fontkitFont =
		"fonts" in fontResult
			? (fontResult as { fonts: fontkit.Font[] }).fonts[0]
			: (fontResult as fontkit.Font);

	const loadedFont: LoadedFont = {
		metadata: {
			family: names.family ?? fontkitFont.familyName,
			fullName: names.family ?? fontkitFont.fullName,
			postScriptName: names.postScriptName ?? fontkitFont.postscriptName,
			style: "Regular",
			weight: 400,
			source: "local",
		},
		fontkit: fontkitFont,
		cssFontFamily: `"${names.family ?? fontkitFont.familyName}"`,
		data: Uint8Array.from(buffer).buffer,
	};

	fontManager.registerLoadedFont(loadedFont);
	return loadedFont;
}
