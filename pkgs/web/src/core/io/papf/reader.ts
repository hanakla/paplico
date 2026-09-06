/**
 * PAPF (Paplico Packed Format) v1 - Lazy reader.
 *
 * Operates on a Blob (or File) and provides lazy random access to sections
 * via Blob.slice(). Only the header, footer, TOC, and META are read eagerly;
 * embedded files and timelapse data are loaded on demand.
 */

import { decode } from "cbor-x";
import { PaplicoError } from "../../errors";
import {
	type Document,
	type EmbeddedFile,
	normalizeAppearanceFields,
} from "../../schema";
import type { TimelapseData, TimelapseEntry } from "../../timelapse/types";
import { crc32, decompressDeflate } from "../binaryUtils";
import { applyMigrations } from "../migrations";
import {
	type Codec,
	Codec as CodecEnum,
	FILE_HEADER_BYTES,
	FOOTER_BYTES,
	MAGIC_FOOTER,
	MAGIC_HEADER,
	MAGIC_SECTION,
	type MetaPayload,
	type ParsedToc,
	type ParsedTocEntry,
	SECTION_HEADER_BYTES,
	SectionType,
	type TimelapseManifestPayload,
	TOC_ENTRY_BYTES,
	TOC_HEADER_BYTES,
	TOC_KEY_NONE,
} from "./types";

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

async function readSlice(
	source: Blob,
	offset: number | bigint,
	length: number,
): Promise<Uint8Array> {
	const start = Number(offset);
	if (start < 0 || length < 0 || start + length > source.size) {
		throw new PaplicoError(
			"PAPF_CORRUPTED",
			`PAPF: readSlice out of bounds (offset=${start}, length=${length}, sourceSize=${source.size})`,
		);
	}
	const blob = source.slice(start, start + length);
	const buf = await blob.arrayBuffer();
	return new Uint8Array(buf);
}

function magicEquals(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Binary structure parsers
// ---------------------------------------------------------------------------

function parseFileHeader(data: Uint8Array): {
	formatMajor: number;
	formatMinor: number;
	createdAtMs: bigint;
} {
	if (data.length < FILE_HEADER_BYTES) {
		throw new PaplicoError(
			"PAPF_INVALID_FILE",
			"PAPF: file too small to contain a valid header",
		);
	}

	const magic = data.subarray(0, 4);
	if (!magicEquals(magic, MAGIC_HEADER)) {
		throw new PaplicoError(
			"PAPF_INVALID_FILE",
			"PAPF: invalid file header magic",
		);
	}

	const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const formatMajor = dv.getUint16(4, true);
	const formatMinor = dv.getUint16(6, true);
	const headerBytes = dv.getUint32(8, true);

	if (headerBytes !== FILE_HEADER_BYTES) {
		throw new PaplicoError(
			"PAPF_INVALID_FILE",
			`PAPF: unexpected headerBytes ${headerBytes}, expected ${FILE_HEADER_BYTES}`,
		);
	}

	const createdAtMs = dv.getBigUint64(16, true);

	return { formatMajor, formatMinor, createdAtMs };
}

function parseFooter(data: Uint8Array): {
	formatMajor: number;
	formatMinor: number;
	tocSectionOffset: bigint;
	tocSectionBytes: bigint;
	fileBytes: bigint;
	tocPayloadCrc32: number;
} {
	if (data.length < FOOTER_BYTES) {
		throw new PaplicoError(
			"PAPF_INVALID_FILE",
			"PAPF: file too small to contain a valid footer",
		);
	}

	const magic = data.subarray(0, 4);
	if (!magicEquals(magic, MAGIC_FOOTER)) {
		throw new PaplicoError("PAPF_INVALID_FILE", "PAPF: invalid footer magic");
	}

	const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const formatMajor = dv.getUint16(4, true);
	const formatMinor = dv.getUint16(6, true);
	const footerBytes = dv.getUint16(8, true);

	if (footerBytes !== FOOTER_BYTES) {
		throw new PaplicoError(
			"PAPF_INVALID_FILE",
			`PAPF: unexpected footerBytes ${footerBytes}, expected ${FOOTER_BYTES}`,
		);
	}

	const tocSectionOffset = dv.getBigUint64(12, true);
	const tocSectionBytes = dv.getBigUint64(20, true);
	const fileBytes = dv.getBigUint64(28, true);
	const tocPayloadCrc32 = dv.getUint32(36, true);

	return {
		formatMajor,
		formatMinor,
		tocSectionOffset,
		tocSectionBytes,
		fileBytes,
		tocPayloadCrc32,
	};
}

// ---------------------------------------------------------------------------
// TOC parser
// ---------------------------------------------------------------------------

function parseToc(sectionData: Uint8Array): ParsedToc {
	// sectionData starts at the PSEC header of the TOC section.
	// Validate section header magic.
	const secMagic = sectionData.subarray(0, 4);
	if (!magicEquals(secMagic, MAGIC_SECTION)) {
		throw new PaplicoError(
			"PAPF_CORRUPTED",
			"PAPF: invalid TOC section header magic",
		);
	}

	const secDv = new DataView(
		sectionData.buffer,
		sectionData.byteOffset,
		sectionData.byteLength,
	);
	const secType = secDv.getUint16(4, true);
	if (secType !== SectionType.TOC) {
		throw new PaplicoError(
			"PAPF_CORRUPTED",
			`PAPF: expected TOC section type 0x00FF, got 0x${secType.toString(16).padStart(4, "0")}`,
		);
	}

	// TOC payload starts after the 16B section header.
	const payload = sectionData.subarray(SECTION_HEADER_BYTES);
	const dv = new DataView(
		payload.buffer,
		payload.byteOffset,
		payload.byteLength,
	);

	// TocHeader (16 bytes)
	if (payload.length < TOC_HEADER_BYTES) {
		throw new PaplicoError(
			"PAPF_CORRUPTED",
			"PAPF: TOC payload too small for TocHeader",
		);
	}

	const tocMajor = dv.getUint16(0, true);
	if (tocMajor !== 1) {
		throw new PaplicoError(
			"PAPF_UNSUPPORTED_VERSION",
			`PAPF: unsupported TOC major version ${tocMajor}`,
		);
	}

	const entryCount = dv.getUint32(4, true);
	const stringTableBytes = dv.getUint32(8, true);

	const MAX_TOC_ENTRIES = 100_000;
	const MAX_STRING_TABLE_BYTES = 10 * 1024 * 1024; // 10 MB

	if (entryCount > MAX_TOC_ENTRIES) {
		throw new PaplicoError(
			"PAPF_CORRUPTED",
			`PAPF: TOC entryCount ${entryCount} exceeds maximum ${MAX_TOC_ENTRIES}`,
		);
	}
	if (stringTableBytes > MAX_STRING_TABLE_BYTES) {
		throw new PaplicoError(
			"PAPF_CORRUPTED",
			`PAPF: TOC stringTableBytes ${stringTableBytes} exceeds maximum ${MAX_STRING_TABLE_BYTES}`,
		);
	}

	const entriesStart = TOC_HEADER_BYTES;
	const entriesEnd = entriesStart + entryCount * TOC_ENTRY_BYTES;
	const stringTableStart = entriesEnd;

	if (payload.length < stringTableStart + stringTableBytes) {
		throw new PaplicoError(
			"PAPF_CORRUPTED",
			"PAPF: TOC payload too small for declared entries + string table",
		);
	}

	// Decode string table
	const stringTableBuf = payload.subarray(
		stringTableStart,
		stringTableStart + stringTableBytes,
	);
	const stringTable = decodeStringTable(stringTableBuf);

	// Parse entries
	const entries: ParsedTocEntry[] = [];
	const byKey = new Map<string, ParsedTocEntry>();
	const fileByUid = new Map<string, ParsedTocEntry>();
	const timelapseBlocks: ParsedTocEntry[] = [];
	let metaEntry: ParsedTocEntry | null = null;

	for (let i = 0; i < entryCount; i++) {
		const off = entriesStart + i * TOC_ENTRY_BYTES;

		const sectionOffset = dv.getBigUint64(off, true);
		const storedBytes = dv.getUint32(off + 8, true);
		const rawBytes = dv.getUint32(off + 12, true);
		const keyOffset = dv.getUint32(off + 16, true);
		const aux0 = dv.getUint32(off + 20, true);
		const aux1 = dv.getUint32(off + 24, true);
		const sType = dv.getUint16(off + 28, true) as SectionType;
		const codec = payload[off + 30] as Codec;
		const flags = payload[off + 31];

		const key =
			keyOffset !== TOC_KEY_NONE ? (stringTable.get(keyOffset) ?? null) : null;

		const entry: ParsedTocEntry = {
			sectionType: sType,
			codec,
			sectionOffset,
			payloadOffset: sectionOffset + BigInt(SECTION_HEADER_BYTES),
			storedBytes,
			rawBytes: rawBytes === 0 ? null : rawBytes,
			key,
			aux0,
			aux1,
			flags,
		};

		entries.push(entry);

		if (key != null) {
			byKey.set(key, entry);
		}

		if (sType === SectionType.FILE && key != null) {
			fileByUid.set(key, entry);
		} else if (sType === SectionType.TMLB) {
			timelapseBlocks.push(entry);
		} else if (sType === SectionType.META) {
			if (metaEntry != null) {
				throw new PaplicoError(
					"PAPF_CORRUPTED",
					"PAPF: multiple META sections found",
				);
			}
			metaEntry = entry;
		}
	}

	if (metaEntry == null) {
		throw new PaplicoError(
			"PAPF_CORRUPTED",
			"PAPF: no META section found in TOC",
		);
	}

	// Sort timelapse blocks by aux0 (block index)
	timelapseBlocks.sort((a, b) => a.aux0 - b.aux0);

	return { entries, byKey, fileByUid, timelapseBlocks, metaEntry };
}

/**
 * Decode a NUL-terminated string table into a map from byte offset to string.
 */
function decodeStringTable(buf: Uint8Array): Map<number, string> {
	const result = new Map<number, string>();
	const decoder = new TextDecoder("utf-8");
	let start = 0;

	for (let i = 0; i < buf.length; i++) {
		if (buf[i] === 0) {
			const str = decoder.decode(buf.subarray(start, i));
			result.set(start, str);
			start = i + 1;
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Decompression
// ---------------------------------------------------------------------------

async function decompressPayload(
	data: Uint8Array,
	codec: Codec,
): Promise<Uint8Array> {
	if (codec === CodecEnum.None) {
		return data;
	}

	if (codec === CodecEnum.Deflate) {
		return decompressDeflate(data);
	}

	throw new PaplicoError("PAPF_CORRUPTED", `PAPF: unknown codec ${codec}`);
}

// ---------------------------------------------------------------------------
// PapfFile class
// ---------------------------------------------------------------------------

export class PapfFile {
	private readonly source: Blob;
	private readonly _meta: MetaPayload;
	private readonly _toc: ParsedToc;
	private readonly _formatMajor: number;
	private readonly _formatMinor: number;

	public constructor(
		source: Blob,
		meta: MetaPayload,
		toc: ParsedToc,
		formatMajor: number,
		formatMinor: number,
	) {
		this.source = source;
		this._meta = meta;
		this._toc = toc;
		this._formatMajor = formatMajor;
		this._formatMinor = formatMinor;
	}

	public get meta(): MetaPayload {
		return this._meta;
	}

	public get toc(): ParsedToc {
		return this._toc;
	}

	/**
	 * Lazy-load a single embedded file by UID.
	 * Reads and decompresses only the requested FILE section payload.
	 */
	public async getEmbeddedFile(uid: string): Promise<EmbeddedFile> {
		const tocEntry = this._toc.fileByUid.get(uid);
		if (!tocEntry) {
			const inManifest = this._meta.fileManifest.some((f) => f.uid === uid);
			const detail = inManifest
				? "uid exists in META fileManifest but has no corresponding FILE section in TOC (possible corruption)"
				: "uid not found in either TOC or META fileManifest";
			throw new PaplicoError(
				"PAPF_MISSING_FILE_ENTRY",
				`PAPF: no FILE section for uid "${uid}": ${detail}`,
			);
		}

		const manifest = this._meta.fileManifest.find((f) => f.uid === uid);
		if (!manifest) {
			throw new PaplicoError(
				"PAPF_MISSING_FILE_ENTRY",
				`PAPF: no file manifest entry found for uid "${uid}"`,
			);
		}

		const MAX_SECTION_BYTES = 1024 * 1024 * 1024; // 1 GB
		if (tocEntry.storedBytes > MAX_SECTION_BYTES) {
			throw new PaplicoError(
				"PAPF_CORRUPTED",
				`PAPF: FILE section for uid "${uid}" declares ${tocEntry.storedBytes} bytes, exceeding the ${MAX_SECTION_BYTES} byte limit`,
			);
		}

		const compressed = await readSlice(
			this.source,
			tocEntry.payloadOffset,
			tocEntry.storedBytes,
		);
		const bin = await decompressPayload(compressed, tocEntry.codec);

		if (tocEntry.rawBytes != null && bin.byteLength !== tocEntry.rawBytes) {
			throw new PaplicoError(
				"PAPF_CORRUPTED",
				`PAPF: decompressed size mismatch for uid "${uid}" (expected ${tocEntry.rawBytes}, got ${bin.byteLength})`,
			);
		}

		return {
			uid: manifest.uid,
			name: manifest.name,
			type: manifest.type,
			hash: manifest.hash,
			bin,
		};
	}

	/**
	 * Lazy-load all timelapse blocks and reassemble into TimelapseData.
	 * Returns null if no timelapse data exists in this file.
	 */
	public async getTimelapseData(): Promise<TimelapseData | null> {
		// Find the TMLH entry
		const tmlhEntry = this._toc.entries.find(
			(e) => e.sectionType === SectionType.TMLH,
		);
		if (!tmlhEntry) return null;

		// Read and decode the timelapse manifest
		const tmlhCompressed = await readSlice(
			this.source,
			tmlhEntry.payloadOffset,
			tmlhEntry.storedBytes,
		);
		const tmlhData = await decompressPayload(tmlhCompressed, tmlhEntry.codec);
		const manifest = decode(tmlhData) as TimelapseManifestPayload;

		// Read all TMLB blocks (already sorted by aux0)
		const allEntries: TimelapseEntry[] = [];

		for (const block of this._toc.timelapseBlocks) {
			const compressed = await readSlice(
				this.source,
				block.payloadOffset,
				block.storedBytes,
			);
			const decompressed = await decompressPayload(compressed, block.codec);
			const entries = decode(decompressed) as Array<{
				t: number;
				u: Uint8Array;
			}>;

			for (const entry of entries) {
				allEntries.push({ t: entry.t, u: entry.u });
			}
		}

		// A truncated or absent rect list would mis-align with the entries, so
		// it is dropped entirely and rebuilt on first playback.
		const dirtyRects = manifest.dirtyRects;
		const index =
			dirtyRects && dirtyRects.length === allEntries.length
				? { rects: dirtyRects }
				: undefined;

		return {
			version: 2,
			entries: allEntries,
			index,
			baselines: manifest.baselines,
		};
	}

	/**
	 * Load the complete Document for backward compatibility / simple usage.
	 *
	 * All embedded files are loaded eagerly via Promise.all(), which may cause
	 * memory spikes for documents with many or large files. For memory-sensitive
	 * use cases, prefer getEmbeddedFile() to load files on demand.
	 */
	public async toDocument(): Promise<Document> {
		const { document: docMeta } = this._meta;

		// Load all embedded files
		const files: EmbeddedFile[] = await Promise.all(
			this._meta.fileManifest.map((entry) => this.getEmbeddedFile(entry.uid)),
		);

		// Load timelapse
		const timelapse = await this.getTimelapseData();

		const doc: Document = {
			id: docMeta.id,
			objects: docMeta.objects,
			layers: docMeta.layers,
			viewport: docMeta.viewport,
			files,
			artboards: docMeta.artboards,
			brushPresets: docMeta.brushPresets,
			appearancePresets: docMeta.appearancePresets ?? [],
			...(timelapse ? { timelapse } : {}),
			hdr: docMeta.hdr,
			colorProfile: docMeta.colorProfile,
			rasterizationDpi: docMeta.rasterizationDpi,
			defs: docMeta.defs ?? {},
			references3d: docMeta.references3d ?? {},
		};

		applyMigrations(doc);

		// Normalize appearance fields (opacity, blendMode) that may be
		// missing from documents saved before these fields were required.
		for (const element of Object.values(doc.objects)) {
			if (element.filters) normalizeAppearanceFields(element.filters);
		}
		for (const preset of doc.appearancePresets ?? []) {
			normalizeAppearanceFields(preset.filters);
		}

		return doc;
	}
}

// ---------------------------------------------------------------------------
// openPapf - Main entry point
// ---------------------------------------------------------------------------

/**
 * Open a PAPF file for lazy access.
 *
 * Reads the header, footer, TOC, and META sections eagerly.
 * Embedded files and timelapse data are loaded on demand via the returned PapfFile handle.
 */
export async function openPapf(source: Blob): Promise<PapfFile> {
	const sourceSize = source.size;

	if (sourceSize < FILE_HEADER_BYTES + FOOTER_BYTES) {
		throw new PaplicoError(
			"PAPF_INVALID_FILE",
			"PAPF: file too small to be a valid PAPF file",
		);
	}

	// 1. Read and parse file header (first 32 bytes)
	const headerData = await readSlice(source, 0, FILE_HEADER_BYTES);
	const header = parseFileHeader(headerData);

	// 2. Read and parse footer (last 40 bytes)
	const footerData = await readSlice(
		source,
		sourceSize - FOOTER_BYTES,
		FOOTER_BYTES,
	);
	const footer = parseFooter(footerData);

	// 3. Validate version match between header and footer
	if (
		header.formatMajor !== footer.formatMajor ||
		header.formatMinor !== footer.formatMinor
	) {
		throw new PaplicoError(
			"PAPF_CORRUPTED",
			`PAPF: version mismatch between header (${header.formatMajor}.${header.formatMinor}) and footer (${footer.formatMajor}.${footer.formatMinor})`,
		);
	}

	// Version-based migration dispatch (uncomment when adding v2)
	// if (header.formatMajor >= 2) {
	//   throw new PaplicoError("PAPF_UNSUPPORTED_VERSION", `PAPF: unsupported format version ${header.formatMajor}.${header.formatMinor}`);
	// }

	// 4. Validate fileBytes matches actual source size
	if (footer.fileBytes !== BigInt(sourceSize)) {
		throw new PaplicoError(
			"PAPF_CORRUPTED",
			`PAPF: footer declares fileBytes=${footer.fileBytes} but actual size is ${sourceSize}`,
		);
	}

	// 5. Read and parse TOC section
	const tocSectionData = await readSlice(
		source,
		footer.tocSectionOffset,
		Number(footer.tocSectionBytes),
	);
	const toc = parseToc(tocSectionData);

	// 6. Verify CRC-32 of TOC payload (payload = section data minus the 16B header)
	const tocPayload = tocSectionData.subarray(SECTION_HEADER_BYTES);
	const computedCrc = crc32(tocPayload);
	if (computedCrc !== footer.tocPayloadCrc32) {
		throw new PaplicoError(
			"PAPF_CORRUPTED",
			`PAPF: TOC CRC-32 mismatch (expected 0x${footer.tocPayloadCrc32.toString(16).padStart(8, "0")}, got 0x${computedCrc.toString(16).padStart(8, "0")})`,
		);
	}

	// 7. Read and decode META section
	const metaCompressed = await readSlice(
		source,
		toc.metaEntry.payloadOffset,
		toc.metaEntry.storedBytes,
	);
	const metaRaw = await decompressPayload(metaCompressed, toc.metaEntry.codec);
	const meta = decode(metaRaw) as MetaPayload;

	// 8. Return PapfFile handle
	return new PapfFile(
		source,
		meta,
		toc,
		header.formatMajor,
		header.formatMinor,
	);
}
