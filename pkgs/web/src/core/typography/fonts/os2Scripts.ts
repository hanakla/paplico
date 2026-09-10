/**
 * Writing-system detection from font headers.
 *
 * Reads only the sfnt table directory and the `OS/2` table through a
 * byte-range reader, so a whole font file never has to be loaded just to
 * know which scripts it covers. Script names follow the Google Fonts
 * `subsets` vocabulary so the Google catalog needs no mapping.
 */

export type FontScript =
	| "japanese"
	| "korean"
	| "chinese-simplified"
	| "chinese-traditional"
	| "cyrillic"
	| "greek"
	| "arabic"
	| "hebrew"
	| "thai"
	| "devanagari"
	| "latin";

/** Display / grouping priority for scripts. */
export const FONT_SCRIPT_ORDER: readonly FontScript[] = [
	"japanese",
	"korean",
	"chinese-simplified",
	"chinese-traditional",
	"cyrillic",
	"greek",
	"arabic",
	"hebrew",
	"thai",
	"devanagari",
	"latin",
];

export type FontRangeReader = (
	offset: number,
	length: number,
) => Promise<ArrayBuffer>;

/**
 * Detect the scripts a font covers by reading its `OS/2` table.
 * Returns an empty array for fonts without a readable `OS/2` table
 * (WOFF/WOFF2 containers, truncated or unknown formats).
 */
export async function detectFontScripts(
	readRange: FontRangeReader,
): Promise<FontScript[]> {
	const head = await readRange(0, HEADER_READ_SIZE);
	const location = await locateOs2Table(head, readRange);
	if (!location) return [];
	const os2 = await readRange(location.offset, location.length);
	return parseOs2Scripts(os2);
}

/**
 * Map Google Fonts API `subsets` entries onto FontScript values.
 * Extended and regional subsets fold into their base script.
 */
export function googleSubsetsToScripts(subsets: string[]): FontScript[] {
	const scripts = new Set<FontScript>();
	for (const subset of subsets) {
		const script = GOOGLE_SUBSET_TO_SCRIPT[subset];
		if (script) scripts.add(script);
	}
	return [...scripts];
}

/**
 * Locate the `OS/2` table from the first bytes of a font file.
 * For TrueType collections the first face's directory is used, which may
 * require one extra read when it sits beyond the initial header window.
 */
async function locateOs2Table(
	head: ArrayBuffer,
	readRange: FontRangeReader,
): Promise<{ offset: number; length: number } | null> {
	if (head.byteLength < SFNT_HEADER_SIZE) return null;
	const view = new DataView(head);
	const tag = view.getUint32(0);

	let directoryOffset = 0;
	if (tag === TAG_TTCF) {
		if (head.byteLength < 16) return null;
		directoryOffset = view.getUint32(12);
	} else if (!SFNT_TAGS.has(tag)) {
		return null;
	}

	const directory = await readDirectory(head, directoryOffset, readRange);
	if (!directory) return null;

	const dir = new DataView(directory);
	const numTables = dir.getUint16(4);
	for (let i = 0; i < numTables; i++) {
		const record = SFNT_HEADER_SIZE + i * TABLE_RECORD_SIZE;
		if (dir.getUint32(record) !== TAG_OS2) continue;
		return {
			offset: dir.getUint32(record + 8),
			length: dir.getUint32(record + 12),
		};
	}
	return null;
}

/**
 * Read the `OS/2` range bits and map them onto FontScript values.
 * Code page bits distinguish the CJK languages; Unicode range bits cover
 * the alphabetic scripts and act as a fallback for kana and hangul.
 */
export function parseOs2Scripts(os2: ArrayBuffer): FontScript[] {
	if (os2.byteLength < OS2_UNICODE_RANGE_END) return [];
	const view = new DataView(os2);
	const version = view.getUint16(0);
	const unicode1 = view.getUint32(42);
	const unicode2 = view.getUint32(46);
	const hasCodePages = version >= 1 && os2.byteLength >= OS2_CODEPAGE_RANGE_END;
	const codePage1 = hasCodePages ? view.getUint32(78) : 0;

	const scripts: FontScript[] = [];
	const has = (bits: number, bit: number) => (bits & (1 << bit)) !== 0;
	const cp = (bit: number) => has(codePage1, bit);

	// Code page bits name the CJK language a font is made for. Unicode range
	// bits for kana and hangul are only trusted when no CJK code page is
	// declared, since most Chinese fonts also cover kana.
	const declaresCjkCodePage = [17, 18, 19, 20, 21].some(cp);
	const kana = has(unicode2, 49 - 32) || has(unicode2, 50 - 32);
	const hangul = has(unicode2, 56 - 32);
	if (cp(17) || (!declaresCjkCodePage && kana)) scripts.push("japanese");
	if (cp(19) || cp(21) || (!declaresCjkCodePage && hangul)) {
		scripts.push("korean");
	}
	if (cp(18)) scripts.push("chinese-simplified");
	if (cp(20)) scripts.push("chinese-traditional");
	if (has(unicode1, 9)) scripts.push("cyrillic");
	if (has(unicode1, 7)) scripts.push("greek");
	if (has(unicode1, 13)) scripts.push("arabic");
	if (has(unicode1, 11)) scripts.push("hebrew");
	if (has(unicode1, 24)) scripts.push("thai");
	if (has(unicode1, 15)) scripts.push("devanagari");
	if (has(unicode1, 0)) scripts.push("latin");
	return scripts;
}

const HEADER_READ_SIZE = 4096;
const SFNT_HEADER_SIZE = 12;
const TABLE_RECORD_SIZE = 16;
const OS2_UNICODE_RANGE_END = 58;
const OS2_CODEPAGE_RANGE_END = 86;

const TAG_TTCF = 0x74746366; // 'ttcf'
const TAG_OS2 = 0x4f532f32; // 'OS/2'
const SFNT_TAGS = new Set([
	0x00010000, // TrueType
	0x4f54544f, // 'OTTO' (CFF)
	0x74727565, // 'true' (Apple TrueType)
]);

const GOOGLE_SUBSET_TO_SCRIPT: Record<string, FontScript | undefined> = {
	japanese: "japanese",
	korean: "korean",
	"chinese-simplified": "chinese-simplified",
	"chinese-traditional": "chinese-traditional",
	"chinese-hongkong": "chinese-traditional",
	cyrillic: "cyrillic",
	"cyrillic-ext": "cyrillic",
	greek: "greek",
	"greek-ext": "greek",
	arabic: "arabic",
	hebrew: "hebrew",
	thai: "thai",
	devanagari: "devanagari",
	latin: "latin",
	"latin-ext": "latin",
	vietnamese: "latin",
};

async function readDirectory(
	head: ArrayBuffer,
	directoryOffset: number,
	readRange: FontRangeReader,
): Promise<ArrayBuffer | null> {
	const headerEnd = directoryOffset + SFNT_HEADER_SIZE;
	const header =
		headerEnd <= head.byteLength
			? head.slice(directoryOffset, headerEnd)
			: await readRange(directoryOffset, SFNT_HEADER_SIZE);
	if (header.byteLength < SFNT_HEADER_SIZE) return null;

	const numTables = new DataView(header).getUint16(4);
	const size = SFNT_HEADER_SIZE + numTables * TABLE_RECORD_SIZE;
	const end = directoryOffset + size;
	if (end <= head.byteLength) return head.slice(directoryOffset, end);

	const directory = await readRange(directoryOffset, size);
	return directory.byteLength >= size ? directory : null;
}
