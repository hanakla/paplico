/**
 * Browser implementation of LocalFontBackend using the Local Font Access API.
 */

import type {
	FontData,
	LocalFontBackend,
} from "../typography/fonts/LocalFontsLoader";

/** Font record returned by `window.queryLocalFonts()`. */
type LocalFontAccessData = Omit<FontData, "readRange">;

export class DomLocalFontBackend implements LocalFontBackend {
	public isSupported(): boolean {
		return typeof window !== "undefined" && "queryLocalFonts" in window;
	}

	public async queryFonts(): Promise<FontData[]> {
		// @ts-expect-error - Local Font Access API is not yet in TypeScript's lib.dom
		const fonts: LocalFontAccessData[] = await window.queryLocalFonts();
		return fonts.map(withRangeReader);
	}

	public async queryFontsByPostScriptNames(
		names: string[],
	): Promise<FontData[]> {
		// @ts-expect-error - Local Font Access API is not yet in TypeScript's lib.dom
		const fonts: LocalFontAccessData[] = await window.queryLocalFonts({
			postScriptNames: names,
		});
		return fonts.map(withRangeReader);
	}
}

function withRangeReader(font: LocalFontAccessData): FontData {
	return {
		family: font.family,
		fullName: font.fullName,
		postScriptName: font.postScriptName,
		style: font.style,
		blob: () => font.blob(),
		// The Local Font Access blob is file-backed, so slicing it avoids
		// reading the whole font into memory.
		readRange: async (offset, length) =>
			(await font.blob()).slice(offset, offset + length).arrayBuffer(),
	};
}
