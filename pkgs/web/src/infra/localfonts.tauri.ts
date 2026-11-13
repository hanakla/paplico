/**
 * Tauri implementation of LocalFontBackend on the app's own
 * `queryLocalFonts` plugin, which asks the OS for its fonts the way the
 * browser does.
 */

import type { FontData, LocalFontBackend } from "@paplico/core/typography";
import {
	type FontData as PluginFontData,
	queryLocalFonts,
	readFontRange,
} from "@paplico/tauri-plugin-query-local-fonts";

export class TauriLocalFontBackend implements LocalFontBackend {
	public isSupported(): boolean {
		return true;
	}

	public async queryFonts(): Promise<FontData[]> {
		return (await queryLocalFonts()).map(toFontData);
	}

	public async queryFontsByPostScriptNames(
		names: string[],
	): Promise<FontData[]> {
		return (await queryLocalFonts({ postscriptNames: names })).map(toFontData);
	}
}

function toFontData(font: PluginFontData): FontData {
	return {
		family: font.family,
		fullName: font.fullName,
		postScriptName: font.postscriptName,
		style: font.style,
		blob: () => font.blob(),
		readRange: (offset, length) => readFontRange(font, offset, length),
	};
}
