import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createTestFontManager,
	loadTestFont,
	NOTO_SANS_JP_PATH,
} from "../../testUtils/fontSetup";
import {
	type FontFile,
	FontLoader,
	type FontMetadata,
	type LoadedFont,
} from "./FontLoader";
import { FontManager } from "./FontManager";

describe("FontManager font loaders", () => {
	it("should load a source through the loader registered under its loaderId", async () => {
		const fontManager = new FontManager({ loaders: [new BundledFontLoader()] });

		const loaded = await fontManager.loadFont({
			loaderId: "bundled",
			fontId: "noto",
		});

		expect(loaded?.metadata).toMatchObject({
			family: "Bundled Noto",
			loaderId: "bundled",
			fontId: "noto",
		});
		expect(loaded?.fontkit.hasGlyphForCodePoint(0x3042)).toBe(true);
		expect(
			fontManager.getLoadedFont({ loaderId: "bundled", fontId: "noto" }),
		).toBe(loaded);
	});

	it("should reject a source whose loader is not registered", async () => {
		const fontManager = new FontManager({ loaders: [] });

		await expect(
			fontManager.loadFont({ loaderId: "missing", fontId: "any" }),
		).rejects.toThrow('No font loader registered for "missing"');
	});
});

describe("FontManager.shapeText() - per-glyph Noto Sans JP fallback", () => {
	let fontManager: FontManager;
	let notoFont: LoadedFont;
	let getFallbackFontSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		fontManager = createTestFontManager();
		notoFont = await loadTestFont(fontManager);
		getFallbackFontSpy = vi
			.spyOn(fontManager, "getFallbackFont")
			.mockResolvedValue(notoFont);
	});

	it("returns fallback font path for char with no glyph in primary font", async () => {
		const primaryFont = createPrimaryFont();
		const shaped = await fontManager.shapeText(primaryFont, "あ", 16);

		expect(shaped).toHaveLength(1);
		expect(shaped[0].path.length).toBeGreaterThan(0);
	});

	it("does not call getFallbackFont for half-width space", async () => {
		const primaryFont = createPrimaryFont();
		await fontManager.shapeText(primaryFont, " ", 16);

		expect(getFallbackFontSpy).not.toHaveBeenCalled();
	});

	it("does not call getFallbackFont for full-width space", async () => {
		const primaryFont = createPrimaryFont();
		await fontManager.shapeText(primaryFont, "\u3000", 16);

		expect(getFallbackFontSpy).not.toHaveBeenCalled();
	});

	it("uses fallback font advance width", async () => {
		const primaryFont = createPrimaryFont();
		const shaped = await fontManager.shapeText(primaryFont, "あ", 16);

		expect(shaped[0].advanceWidth).toBeGreaterThan(0);
	});

	it("returns paths for all chars in mixed text", async () => {
		const primaryFont = createPrimaryFont();
		const shaped = await fontManager.shapeText(primaryFont, "あA", 16);

		expect(shaped).toHaveLength(2);
		for (const glyph of shaped) {
			expect(glyph.path.length).toBeGreaterThan(0);
		}
	});
});

function createNoGlyphFontkit() {
	return {
		unitsPerEm: 1000,
		ascent: 800,
		descent: -200,
		availableFeatures: [],
		layout: (text: string) => {
			const chars = [...text];
			return {
				glyphs: chars.map((c) => ({
					id: 0,
					codePoints: [c.codePointAt(0) ?? 0],
				})),
				positions: chars.map(() => ({
					xAdvance: 0,
					yAdvance: 0,
					xOffset: 0,
					yOffset: 0,
				})),
			};
		},
		glyphForCodePoint: () => ({
			id: 0,
			path: null,
		}),
	};
}

function createPrimaryFont(): LoadedFont {
	return {
		metadata: {
			family: "No Glyph Font",
			fullName: "No Glyph Font",
			postScriptName: "NoGlyphFont",
			style: "Regular",
			weight: 400,
			loaderId: "local",
			fontId: "NoGlyphFont",
		},
		fontkit: createNoGlyphFontkit() as unknown as LoadedFont["fontkit"],
		data: new ArrayBuffer(0),
	};
}

describe("FontManager.shapeText() - content index mapping", () => {
	let fontManager: FontManager;
	let notoFont: LoadedFont;

	beforeEach(async () => {
		fontManager = createTestFontManager();
		notoFont = await loadTestFont(fontManager);
	});

	it("maps ligature glyphs back to original character indices", async () => {
		// Noto merges "ffi" into one glyph: 6 chars → 4 glyphs
		const shaped = await fontManager.shapeText(notoFont, "office", 16);
		const total = shaped.reduce((sum, g) => sum + g.charLength, 0);
		expect(total).toBe("office".length);
		// 'c' must keep its content index (4), not a glyph-sequential one (2)
		const c = shaped.find((g) => g.char === "c");
		expect(c?.charIndex).toBe(4);
	});

	it("keeps content indices across stripped control characters", async () => {
		const shaped = await fontManager.shapeText(notoFont, "a\tb", 16);
		expect(shaped).toHaveLength(2);
		expect(shaped[0].charIndex).toBe(0);
		// 'b' sits at content index 2 (the tab occupies index 1)
		expect(shaped[1].charIndex).toBe(2);
	});

	it("keeps 1:1 indices for Japanese text", async () => {
		const shaped = await fontManager.shapeText(notoFont, "あいう", 16);
		expect(shaped.map((g) => g.charIndex)).toEqual([0, 1, 2]);
		expect(shaped.map((g) => g.charLength)).toEqual([1, 1, 1]);
	});
});

/** A custom loader that only lists its font and returns the file bytes. */
class BundledFontLoader extends FontLoader {
	public readonly id = "bundled";
	public readonly label = "Bundled";
	private readonly metadata = {
		family: "Bundled Noto",
		fullName: "Bundled Noto Regular",
		postScriptName: "BundledNoto-Regular",
		style: "Regular",
		weight: 400,
	};

	public async queryFonts(): Promise<FontMetadata[]> {
		return [{ ...this.metadata, loaderId: this.id, fontId: "noto" }];
	}

	protected async fetchFont(fontId: string): Promise<FontFile | null> {
		if (fontId !== "noto") return null;
		return {
			data: Uint8Array.from(readFileSync(NOTO_SANS_JP_PATH)).buffer,
			metadata: this.metadata,
		};
	}
}
