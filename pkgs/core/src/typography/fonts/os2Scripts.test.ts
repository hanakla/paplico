import {
	detectFontScripts,
	type FontRangeReader,
	googleSubsetsToScripts,
	parseOs2Scripts,
} from "./os2Scripts";

describe("detectFontScripts", () => {
	it("should detect Japanese from a TrueType font's OS/2 code page bits", async () => {
		const file = buildSfnt({ codePage1: bit(17) | bit(0), unicode1: bit(0) });
		const reader = createReader(file);

		const scripts = await detectFontScripts(reader.read);

		expect(scripts).toEqual(["japanese", "latin"]);
		expect(reader.maxBytesRead()).toBeLessThan(file.byteLength);
	});

	it("should use the first face of a TrueType collection", async () => {
		const face = buildSfnt({ codePage1: bit(19), unicode1: bit(0) });
		const file = buildTtc([face]);

		const scripts = await detectFontScripts(createReader(file).read);

		expect(scripts).toEqual(["korean", "latin"]);
	});

	it("should read the directory separately when it sits beyond the header window", async () => {
		const face = buildSfnt({ codePage1: bit(18), unicode1: 0 });
		const file = buildTtc([face], 8192);

		const scripts = await detectFontScripts(createReader(file).read);

		expect(scripts).toEqual(["chinese-simplified"]);
	});

	it("should return no scripts for WOFF containers", async () => {
		const file = new Uint8Array(64);
		new DataView(file.buffer).setUint32(0, 0x774f4646); // 'wOFF'

		const scripts = await detectFontScripts(createReader(file.buffer).read);

		expect(scripts).toEqual([]);
	});

	it("should return no scripts for a font without an OS/2 table", async () => {
		const file = buildSfnt({ codePage1: 0, unicode1: 0 }, { omitOs2: true });

		const scripts = await detectFontScripts(createReader(file).read);

		expect(scripts).toEqual([]);
	});
});

describe("parseOs2Scripts", () => {
	it("should detect alphabetic scripts from Unicode range bits", () => {
		const os2 = buildOs2({
			version: 1,
			unicode1:
				bit(0) | bit(7) | bit(9) | bit(11) | bit(13) | bit(15) | bit(24),
		});

		expect(parseOs2Scripts(os2)).toEqual([
			"cyrillic",
			"greek",
			"arabic",
			"hebrew",
			"thai",
			"devanagari",
			"latin",
		]);
	});

	it("should fall back to kana and hangul Unicode bits for version 0 tables", () => {
		const os2 = buildOs2({
			version: 0,
			unicode2: bit(49 - 32) | bit(56 - 32),
			codePage1: bit(18),
		});

		expect(parseOs2Scripts(os2)).toEqual(["japanese", "korean"]);
	});

	it("should ignore kana Unicode bits when a CJK code page is declared", () => {
		const os2 = buildOs2({
			version: 1,
			unicode2: bit(49 - 32) | bit(50 - 32),
			codePage1: bit(18),
		});

		expect(parseOs2Scripts(os2)).toEqual(["chinese-simplified"]);
	});

	it("should return no scripts for a truncated table", () => {
		expect(parseOs2Scripts(new ArrayBuffer(40))).toEqual([]);
	});
});

describe("googleSubsetsToScripts", () => {
	it("should fold extended and regional subsets into their base script", () => {
		expect(
			googleSubsetsToScripts([
				"latin",
				"latin-ext",
				"vietnamese",
				"chinese-hongkong",
				"cyrillic-ext",
				"unknown",
			]),
		).toEqual(["latin", "chinese-traditional", "cyrillic"]);
	});
});

function bit(n: number): number {
	return (1 << n) >>> 0;
}

function createReader(file: ArrayBuffer): {
	read: FontRangeReader;
	maxBytesRead: () => number;
} {
	let max = 0;
	return {
		read: async (offset, length) => {
			max = Math.max(max, length);
			return file.slice(offset, offset + length);
		},
		maxBytesRead: () => max,
	};
}

function buildOs2({
	version = 1,
	unicode1 = 0,
	unicode2 = 0,
	codePage1 = 0,
}: {
	version?: number;
	unicode1?: number;
	unicode2?: number;
	codePage1?: number;
}): ArrayBuffer {
	const buffer = new ArrayBuffer(96);
	const view = new DataView(buffer);
	view.setUint16(0, version);
	view.setUint32(42, unicode1);
	view.setUint32(46, unicode2);
	view.setUint32(78, codePage1);
	return buffer;
}

/** Build a minimal TrueType file: header, a few table records, padding, then OS/2. */
function buildSfnt(
	os2Fields: Parameters<typeof buildOs2>[0],
	{ omitOs2 = false }: { omitOs2?: boolean } = {},
): ArrayBuffer {
	const tables = omitOs2 ? ["cmap", "head"] : ["cmap", "OS/2", "head"];
	const directorySize = 12 + tables.length * 16;
	const os2Offset = 6000;
	const os2 = buildOs2(os2Fields);
	const buffer = new ArrayBuffer(os2Offset + os2.byteLength + 1024);
	const view = new DataView(buffer);
	view.setUint32(0, 0x00010000);
	view.setUint16(4, tables.length);
	tables.forEach((tag, i) => {
		const record = 12 + i * 16;
		view.setUint32(record, tagToUint32(tag));
		view.setUint32(record + 8, tag === "OS/2" ? os2Offset : directorySize);
		view.setUint32(record + 12, tag === "OS/2" ? os2.byteLength : 0);
	});
	new Uint8Array(buffer).set(new Uint8Array(os2), os2Offset);
	return buffer;
}

/** Wrap faces in a TrueType collection, placing the first directory at `firstOffset`. */
function buildTtc(faces: ArrayBuffer[], firstOffset = 64): ArrayBuffer {
	const total =
		firstOffset + faces.reduce((sum, face) => sum + face.byteLength, 0);
	const buffer = new ArrayBuffer(total);
	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);
	view.setUint32(0, 0x74746366);
	view.setUint32(8, faces.length);
	let offset = firstOffset;
	faces.forEach((face, i) => {
		view.setUint32(12 + i * 4, offset);
		// Table offsets inside a face are file-absolute in real TTCs; shift them.
		const shifted = shiftTableOffsets(face, offset);
		bytes.set(new Uint8Array(shifted), offset);
		offset += face.byteLength;
	});
	return buffer;
}

function shiftTableOffsets(face: ArrayBuffer, delta: number): ArrayBuffer {
	const copy = face.slice(0);
	const view = new DataView(copy);
	const numTables = view.getUint16(4);
	for (let i = 0; i < numTables; i++) {
		const record = 12 + i * 16;
		view.setUint32(record + 8, view.getUint32(record + 8) + delta);
	}
	return copy;
}

function tagToUint32(tag: string): number {
	return (
		((tag.charCodeAt(0) << 24) |
			(tag.charCodeAt(1) << 16) |
			(tag.charCodeAt(2) << 8) |
			tag.charCodeAt(3)) >>>
		0
	);
}
