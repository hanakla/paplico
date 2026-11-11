import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
	NOTO_SANS_JP_PATH,
	NOTO_SANS_JP_POST_SCRIPT_NAME,
} from "../../testUtils/fontSetup";
import {
	type FontData,
	type LocalFontBackend,
	LocalFontsLoader,
} from "./LocalFontsLoader";

const FULL_NAME = "Noto Sans JP Thin";

describe("LocalFontsLoader", () => {
	it("should load a font by its PostScript name", async () => {
		const loader = new LocalFontsLoader(createBackend());

		const font = await loader.loadFont(NOTO_SANS_JP_POST_SCRIPT_NAME);

		expect(font?.metadata.fullName).toBe(FULL_NAME);
	});

	it("should load a font by its full name", async () => {
		const loader = new LocalFontsLoader(createBackend());

		const font = await loader.loadFont(FULL_NAME);

		expect(font?.metadata.postScriptName).toBe(NOTO_SANS_JP_POST_SCRIPT_NAME);
	});

	it("should reject a name no installed font has", async () => {
		const loader = new LocalFontsLoader(createBackend());

		await expect(loader.loadFont("Missing-Regular")).rejects.toThrow(
			/Font not found/,
		);
	});
});

/** A device with one installed font. */
function createBackend(): LocalFontBackend {
	const bytes = Uint8Array.from(fs.readFileSync(NOTO_SANS_JP_PATH));
	const installed: FontData[] = [
		{
			family: "Noto Sans JP",
			fullName: FULL_NAME,
			postScriptName: NOTO_SANS_JP_POST_SCRIPT_NAME,
			style: "Thin",
			blob: async () => new Blob([bytes]),
			readRange: async (offset, length) =>
				bytes.slice(offset, offset + length).buffer,
		},
	];
	return {
		isSupported: () => true,
		queryFonts: async () => installed,
		queryFontsByPostScriptNames: async (names) =>
			installed.filter((font) => names.includes(font.postScriptName)),
	};
}
