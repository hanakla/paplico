import { afterEach, describe, expect, it, vi } from "vitest";
import { DomLocalFontBackend } from "./localfonts.web";

describe("DomLocalFontBackend", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("should return each font with its PostScript name", async () => {
		stubQueryLocalFonts();

		const fonts = await new DomLocalFontBackend().queryFonts();

		expect(fonts.map((font) => font.postScriptName)).toEqual([
			"ZenMaruGothic-Bold",
			"HiraginoSans-W1",
		]);
	});

	it("should return only the fonts with the given PostScript names", async () => {
		stubQueryLocalFonts();

		const fonts = await new DomLocalFontBackend().queryFontsByPostScriptNames([
			"HiraginoSans-W1",
		]);

		expect(fonts.map((font) => font.fullName)).toEqual(["Hiragino Sans W1"]);
	});
});

/** Installs a `queryLocalFonts` that names its fields and options as browsers do. */
function stubQueryLocalFonts(): void {
	const installed = [
		{
			family: "Zen Maru Gothic",
			fullName: "Zen Maru Gothic Bold",
			postscriptName: "ZenMaruGothic-Bold",
			style: "Bold",
			blob: async () => new Blob(),
		},
		{
			family: "Hiragino Sans",
			fullName: "Hiragino Sans W1",
			postscriptName: "HiraginoSans-W1",
			style: "W1",
			blob: async () => new Blob(),
		},
	];
	vi.stubGlobal(
		"queryLocalFonts",
		async (options?: { postscriptNames?: string[] }) =>
			installed.filter(
				(font) =>
					!options?.postscriptNames ||
					options.postscriptNames.includes(font.postscriptName),
			),
	);
}
