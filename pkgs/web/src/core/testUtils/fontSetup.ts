import * as fs from "node:fs";
import * as path from "node:path";
import * as fontkit from "fontkit";
import type { LoadedFont } from "../typography/fonts/FontLoader";
import type { FontManager } from "../typography/fonts/FontManager";

const NOTO_SANS_JP_PATH = path.resolve(
	__dirname,
	"assets/NotoSansJP-VariableFont_wght.ttf",
);

export const NOTO_SANS_JP_POST_SCRIPT_NAME = "NotoSansJP-VariableFont_wght";

/**
 * Load NotoSansJP from the bundled test asset and register it into FontManager.
 * After calling this, fonts with postScriptName matching NOTO_SANS_JP_POST_SCRIPT_NAME
 * are available via fontManager.getLoadedFont({ type: "local", postScriptName: ... }).
 */
export function loadTestFont(fontManager: FontManager): LoadedFont {
	const buffer = fs.readFileSync(NOTO_SANS_JP_PATH);
	const fontResult = fontkit.create(buffer);
	const fontkitFont =
		"fonts" in fontResult
			? (fontResult as { fonts: fontkit.Font[] }).fonts[0]
			: (fontResult as fontkit.Font);

	const loadedFont: LoadedFont = {
		metadata: {
			family: "Noto Sans JP",
			fullName: "Noto Sans JP",
			postScriptName: NOTO_SANS_JP_POST_SCRIPT_NAME,
			style: "Regular",
			weight: 400,
			source: "local",
		},
		fontkit: fontkitFont,
		cssFontFamily: `"${NOTO_SANS_JP_POST_SCRIPT_NAME}", "Noto Sans JP", sans-serif`,
		data: buffer.buffer as ArrayBuffer,
	};

	fontManager.registerLoadedFont(loadedFont);
	return loadedFont;
}
