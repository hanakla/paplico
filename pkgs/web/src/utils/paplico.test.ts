import { describe, expect, it } from "vitest";
import { resolveDefaultFontForLanguage } from "./paplico";

describe("resolveDefaultFontForLanguage", () => {
	it("should return the Japanese Noto family for Japanese", () => {
		expect(resolveDefaultFontForLanguage("ja")).toEqual({
			fontFamily: "Noto Sans JP",
			fontSource: { type: "google", family: "Noto Sans JP", variants: ["400"] },
		});
	});

	it("should match on the primary subtag of a region-qualified tag", () => {
		expect(resolveDefaultFontForLanguage("ja-JP").fontFamily).toBe(
			"Noto Sans JP",
		);
	});

	it("should fall back to the plain Noto family for another language", () => {
		expect(resolveDefaultFontForLanguage("en")).toEqual({
			fontFamily: "Noto Sans",
			fontSource: { type: "google", family: "Noto Sans", variants: ["400"] },
		});
	});

	it("should return a fresh object so callers can mutate the result", () => {
		const first = resolveDefaultFontForLanguage("ja");
		first.fontFamily = "changed";
		expect(resolveDefaultFontForLanguage("ja").fontFamily).toBe("Noto Sans JP");
	});
});
