/**
 * Browser implementation of LocalFontBackend using the Local Font Access API.
 */

import type {
	FontData,
	LocalFontBackend,
} from "../typography/fonts/LocalFontsLoader";

export class DomLocalFontBackend implements LocalFontBackend {
	public isSupported(): boolean {
		return typeof window !== "undefined" && "queryLocalFonts" in window;
	}

	public async queryFonts(): Promise<FontData[]> {
		// @ts-expect-error - Local Font Access API is not yet in TypeScript's lib.dom
		return window.queryLocalFonts();
	}

	public async queryFontsByPostScriptNames(
		names: string[],
	): Promise<FontData[]> {
		// @ts-expect-error - Local Font Access API is not yet in TypeScript's lib.dom
		return window.queryLocalFonts({ postScriptNames: names });
	}
}
