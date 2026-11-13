import { invoke } from "@tauri-apps/api/core";

/** A font installed on the device, in the shape of the browser's `FontData`. */
export interface FontData {
	readonly family: string;
	readonly fullName: string;
	readonly postscriptName: string;
	readonly style: string;
	blob(): Promise<Blob>;
}

/**
 * Lists the fonts installed on the device like the browser's
 * `window.queryLocalFonts()`: sorted by PostScript name, one per name, and
 * only the given names when `postscriptNames` is set.
 */
export async function queryLocalFonts(options?: {
	postscriptNames?: string[];
}): Promise<FontData[]> {
	const records = await invoke<Omit<FontData, "blob">[]>(
		"plugin:paplico-query-local-fonts|query_local_fonts",
		{ postscriptNames: options?.postscriptNames },
	);
	return records.map((record) => ({
		...record,
		blob: async () =>
			new Blob([
				await invoke<ArrayBuffer>(
					"plugin:paplico-query-local-fonts|read_font",
					{
						postscriptName: record.postscriptName,
					},
				),
			]),
	}));
}

/**
 * Reads `length` bytes from `offset` in the file of a font the last
 * `queryLocalFonts` call returned, without moving the whole file. The browser
 * gets the same from `blob().slice()`, whose blob is backed by the file.
 */
export function readFontRange(
	font: FontData,
	offset: number,
	length: number,
): Promise<ArrayBuffer> {
	return invoke<ArrayBuffer>(
		"plugin:paplico-query-local-fonts|read_font_range",
		{
			postscriptName: font.postscriptName,
			offset,
			length,
		},
	);
}
