import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadTestFont } from "../../testUtils/fontSetup";
import type { LoadedFont } from "./FontLoader";
import { FontManager } from "./FontManager";

describe("FontManager.shapeText() - per-glyph Noto Sans JP fallback", () => {
	let fontManager: FontManager;
	let notoFont: LoadedFont;
	let getFallbackFontSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fontManager = new FontManager();
		notoFont = loadTestFont(fontManager);
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
			source: "local",
		},
		fontkit: createNoGlyphFontkit() as unknown as LoadedFont["fontkit"],
		cssFontFamily: "No Glyph Font",
		data: new ArrayBuffer(0),
	};
}

describe("FontManager.shapeText() - content index mapping", () => {
	let fontManager: FontManager;
	let notoFont: LoadedFont;

	beforeEach(() => {
		fontManager = new FontManager();
		notoFont = loadTestFont(fontManager);
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
