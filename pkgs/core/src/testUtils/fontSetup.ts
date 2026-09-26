import * as fs from "node:fs";
import * as path from "node:path";
import * as fontkit from "@cantoo/fontkit";
import type { FontSource } from "../schema";
import {
	type FontFile,
	FontLoader,
	type FontMetadata,
	type LoadedFont,
} from "../typography/fonts/FontLoader";
import { FontManager } from "../typography/fonts/FontManager";

export const NOTO_SANS_JP_PATH = path.resolve(
	__dirname,
	"assets/NotoSansJP-VariableFont_wght.ttf",
);

export const NOTO_SANS_JP_POST_SCRIPT_NAME = "NotoSansJP-VariableFont_wght";
const NOTO_SANS_JP_FAMILY = "Noto Sans JP";

/**
 * Create a FontManager whose "google" and "local" loaders answer only fixture
 * fonts, so tests never reach the network. The fallback font is answered from
 * the bundled test assets by the fetch mock in vitestSetup.
 */
export function createTestFontManager(): FontManager {
	return new FontManager({
		loaders: [new FixtureFontLoader("google"), new FixtureFontLoader("local")],
		fallbackFontUrl: "/assets/fonts/NotoSansJP-VariableFont_wght.ttf",
	});
}

/**
 * Load NotoSansJP from the bundled test asset into a manager from
 * createTestFontManager. The fixture answers both the local source keyed by
 * NOTO_SANS_JP_POST_SCRIPT_NAME and the Google source "Noto Sans JP" that
 * the test document references, so text renders offline. Returns the font
 * the local source resolves to.
 */
export function loadTestFont(fontManager: FontManager): Promise<LoadedFont> {
	return loadFontFixture(fontManager, NOTO_SANS_JP_PATH, {
		family: NOTO_SANS_JP_FAMILY,
		postScriptName: NOTO_SANS_JP_POST_SCRIPT_NAME,
	});
}

/** Load the multi-axis fixture without network access. */
export function loadRobotoFlexFont(
	fontManager: FontManager,
): Promise<LoadedFont> {
	return loadFontFixture(
		fontManager,
		path.resolve(__dirname, "assets/RobotoFlex.ttf"),
	);
}

/** In-memory loader serving the fixture files registered into it. */
class FixtureFontLoader extends FontLoader {
	public readonly label: string;
	private files = new Map<string, FontFile>();

	public constructor(public readonly id: string) {
		super();
		this.label = id;
	}

	public add(fontId: string, file: FontFile): void {
		this.files.set(fontId, file);
	}

	public async queryFonts(): Promise<FontMetadata[]> {
		return [...this.files].map(([fontId, file]) => ({
			...file.metadata,
			loaderId: this.id,
			fontId,
		}));
	}

	protected async fetchFont(fontId: string): Promise<FontFile | null> {
		return this.files.get(fontId) ?? null;
	}
}

async function loadFontFixture(
	fontManager: FontManager,
	filePath: string,
	names: { family?: string; postScriptName?: string } = {},
): Promise<LoadedFont> {
	const buffer = fs.readFileSync(filePath);
	const fontResult = fontkit.create(buffer);
	const fontkitFont = "fonts" in fontResult ? fontResult.fonts[0] : fontResult;
	const family = names.family ?? fontkitFont.familyName ?? "";
	const postScriptName =
		names.postScriptName ?? fontkitFont.postscriptName ?? "";
	const file: FontFile = {
		data: Uint8Array.from(buffer).buffer,
		metadata: {
			family,
			fullName: names.family ?? fontkitFont.fullName ?? "",
			postScriptName,
			style: "Regular",
			weight: 400,
		},
	};

	const google = { loaderId: "google", fontId: family };
	const local = { loaderId: "local", fontId: postScriptName };
	registerFixture(fontManager, google, file);
	registerFixture(fontManager, local, file);
	await fontManager.loadFont(google);
	const loaded = await fontManager.loadFont(local);
	if (!loaded) throw new Error(`Failed to load fixture ${filePath}`);
	return loaded;
}

function registerFixture(
	fontManager: FontManager,
	source: FontSource,
	file: FontFile,
): void {
	const loader = fontManager.loaders.get(source.loaderId);
	if (!(loader instanceof FixtureFontLoader)) {
		throw new Error("Pass a FontManager made by createTestFontManager");
	}
	loader.add(source.fontId, file);
}
