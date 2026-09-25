import { describe, expect, it } from "vitest";
import { createDefaultTextStyle } from "../../tools/TextTool";
import {
	fontVariationKey,
	resolveFontVariations,
	updateFontVariation,
} from "./fontVariations";

describe("variable coordinates", () => {
	it("uses the stored weight and font defaults without mutating the style", () => {
		const style = createDefaultTextStyle();
		expect(resolveFontVariations(style, axes())).toEqual({
			ital: 0,
			wdth: 100,
			wght: 400,
		});
		expect(style.fontVariationSettings).toBeUndefined();
	});

	it("ignores unsupported and non-finite settings and clamps supported coordinates", () => {
		const style = {
			...createDefaultTextStyle(),
			fontWeight: 2_000,
			fontVariationSettings: { wdth: Number.NaN, ital: 5, wght: 1, XXXX: 10 },
		};
		expect(resolveFontVariations(style, axes())).toEqual({
			ital: 1,
			wdth: 100,
			wght: 1_000,
		});
	});

	it("changes weight without overwriting run-specific axes", () => {
		const style = {
			...createDefaultTextStyle(),
			fontVariationSettings: { wdth: 80, ital: 0.5 },
		};
		const next = updateFontVariation(style, axes(), "wght", 650);
		expect(next.fontWeight).toBe(650);
		expect(next.fontVariationSettings).toEqual({ wdth: 80, ital: 0.5 });
		expect(style.fontWeight).toBe(400);
	});

	it("ignores a non-finite ital coordinate and uses the font style", () => {
		expect(
			resolveFontVariations(
				{
					...createDefaultTextStyle(),
					fontStyle: "italic",
					fontVariationSettings: { ital: Number.NaN },
				},
				axes(),
			).ital,
		).toBe(1);
	});

	it("resets only the chosen axis including the italic style fallback", () => {
		const style = {
			...createDefaultTextStyle(),
			fontStyle: "italic" as const,
			fontVariationSettings: { wdth: 80, ital: 1 },
		};
		const next = updateFontVariation(style, axes(), "ital", null);
		expect(next.fontVariationSettings).toEqual({ wdth: 80 });
		expect(next.fontStyle).toBe("normal");
		expect(updateFontVariation(next, axes(), "wght", null).fontWeight).toBe(
			300,
		);
	});

	it("does not write invalid input or unknown axes", () => {
		const style = createDefaultTextStyle();
		expect(updateFontVariation(style, axes(), "wdth", Infinity)).toBe(style);
		expect(updateFontVariation(style, axes(), "XXXX", 10)).toBe(style);
	});

	it("uses the same key regardless of coordinate insertion order", () => {
		expect(fontVariationKey({ wdth: 80, wght: 400 })).toBe(
			fontVariationKey({ wght: 400, wdth: 80 }),
		);
	});
});

function axes() {
	return {
		wght: { name: "Weight", min: 1, default: 300, max: 1_000 },
		wdth: { name: "Width", min: 50, default: 100, max: 200 },
		ital: { name: "Italic", min: 0, default: 0, max: 1 },
	};
}
