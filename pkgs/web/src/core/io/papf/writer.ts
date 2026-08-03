/**
 * PAPF (Paplico Packed Format) v1 - Streaming writer.
 *
 * Produces a Blob from a Document by writing sections sequentially:
 *   FileHeader -> META -> FILE* -> TMLH? -> TMLB* -> TOC -> Footer
 */

import { encode } from "cbor-x";
import type { Document, EmbeddedFile } from "../../schema";
import type { TimelapseData } from "../../timelapse/types";
import { compressDeflate, crc32 } from "../binaryUtils";
import {
	Codec,
	FILE_HEADER_BYTES,
	type FileManifestEntry,
	FOOTER_BYTES,
	MAGIC_FOOTER,
	MAGIC_HEADER,
	MAGIC_SECTION,
	type MetaPayload,
	SECTION_HEADER_BYTES,
	SectionType,
	TOC_ENTRY_BYTES,
	TOC_HEADER_BYTES,
	TOC_KEY_NONE,
} from "./types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serialize a Document into PAPF binary format.
 *
 * The function writes sections sequentially into a ChunkSink and returns
 * a Blob suitable for download.
 *
 * Async because section payloads may be compressed via CompressionStream.
 */
export async function serializeDocument(doc: Document): Promise<Blob> {
	const sink = new ChunkSink();
	const tocEntries: TocEntryRecord[] = [];

	// 1. FileHeader
	sink.write(encodeFileHeader(Date.now()));

	// 2. META section
	const fileManifest = buildFileManifest(doc.files);
	const metaPayload = buildMetaPayload(doc, fileManifest);
	const metaCbor = encode(metaPayload);
	const {
		sectionOffset: metaOffset,
		storedBytes: metaStored,
		rawBytes: metaRaw,
	} = await writeSection(sink, SectionType.META, Codec.Deflate, metaCbor);

	tocEntries.push({
		sectionOffset: metaOffset,
		storedBytes: metaStored,
		rawBytes: metaRaw,
		key: null,
		aux0: 0,
		aux1: 0,
		sectionType: SectionType.META,
		codec: Codec.Deflate,
		flags: 0,
	});

	// 3. FILE sections (one per embedded file)
	for (const file of doc.files) {
		const codec = chooseCodecForFile(file.type);
		const { sectionOffset, storedBytes, rawBytes } = await writeSection(
			sink,
			SectionType.FILE,
			codec,
			file.bin,
		);

		tocEntries.push({
			sectionOffset,
			storedBytes,
			rawBytes,
			key: file.uid,
			aux0: 0,
			aux1: 0,
			sectionType: SectionType.FILE,
			codec,
			flags: 0,
		});
	}

	// 4. Timelapse sections (TMLH + TMLB blocks)
	if (doc.timelapse && doc.timelapse.entries.length > 0) {
		const timelapse = doc.timelapse;

		// TMLH - manifest
		const tmlhPayload = buildTimelapseManifest(timelapse);
		const {
			sectionOffset: tmlhOffset,
			storedBytes: tmlhStored,
			rawBytes: tmlhRaw,
		} = await writeSection(sink, SectionType.TMLH, Codec.Deflate, tmlhPayload);

		tocEntries.push({
			sectionOffset: tmlhOffset,
			storedBytes: tmlhStored,
			rawBytes: tmlhRaw,
			key: null,
			aux0: 0,
			aux1: 0,
			sectionType: SectionType.TMLH,
			codec: Codec.Deflate,
			flags: 0,
		});

		// TMLB - data blocks
		const totalEntries = timelapse.entries.length;
		const blockCount = Math.ceil(totalEntries / TIMELAPSE_BLOCK_SIZE);

		for (let blockIdx = 0; blockIdx < blockCount; blockIdx++) {
			const start = blockIdx * TIMELAPSE_BLOCK_SIZE;
			const end = Math.min(start + TIMELAPSE_BLOCK_SIZE, totalEntries);
			const blockPayload = buildTimelapseBlock(timelapse.entries, start, end);

			const { sectionOffset, storedBytes, rawBytes } = await writeSection(
				sink,
				SectionType.TMLB,
				Codec.Deflate,
				blockPayload,
			);

			tocEntries.push({
				sectionOffset,
				storedBytes,
				rawBytes,
				key: null,
				aux0: blockIdx,
				aux1: end - start,
				sectionType: SectionType.TMLB,
				codec: Codec.Deflate,
				flags: 0,
			});
		}
	}

	// 5. TOC section
	const tocSectionOffset = sink.position;
	const tocPayload = buildTocPayload(tocEntries);
	const tocCrc = crc32(tocPayload);

	// TOC itself is stored uncompressed for simplicity during reading
	sink.write(
		encodeSectionHeader(SectionType.TOC, Codec.None, tocPayload.byteLength),
	);
	sink.write(tocPayload);

	const tocSectionBytes = SECTION_HEADER_BYTES + tocPayload.byteLength;

	// 6. Footer
	const fileBytes = sink.position + FOOTER_BYTES;
	sink.write(
		encodeFooter(
			BigInt(tocSectionOffset),
			BigInt(tocSectionBytes),
			BigInt(fileBytes),
			tocCrc,
		),
	);

	return sink.toBlob();
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FORMAT_MAJOR = 1;
const FORMAT_MINOR = 0;
const META_SCHEMA_MAJOR = 1;
const META_SCHEMA_MINOR = 0;
/** Entries per timelapse block. Balances compression ratio vs random-access granularity. */
const TIMELAPSE_BLOCK_SIZE = 1_000;

// Pre-compressed MIME types (already use internal compression)
const PRECOMPRESSED_MIMES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"font/woff2",
]);

// ---------------------------------------------------------------------------
// ChunkSink - collects Uint8Array chunks and tracks byte offset
// ---------------------------------------------------------------------------

class ChunkSink {
	private chunks: Uint8Array[] = [];
	public position = 0;

	public write(data: Uint8Array): void {
		this.chunks.push(data);
		this.position += data.byteLength;
	}

	public toBlob(): Blob {
		const merged = new Uint8Array(this.position);
		let offset = 0;
		for (const chunk of this.chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return new Blob([merged], { type: "application/x-paplico" });
	}
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

function chooseCodecForFile(mimeType: string): Codec {
	return PRECOMPRESSED_MIMES.has(mimeType) ? Codec.None : Codec.Deflate;
}

// ---------------------------------------------------------------------------
// Binary encoding helpers
// ---------------------------------------------------------------------------

function encodeFileHeader(createdAtMs: number): Uint8Array {
	const buf = new ArrayBuffer(FILE_HEADER_BYTES);
	const view = new DataView(buf);
	const bytes = new Uint8Array(buf);

	// magic "PAPF"
	bytes.set(MAGIC_HEADER, 0);
	// formatMajor
	view.setUint16(4, FORMAT_MAJOR, true);
	// formatMinor
	view.setUint16(6, FORMAT_MINOR, true);
	// headerBytes
	view.setUint32(8, FILE_HEADER_BYTES, true);
	// fileFlags
	view.setUint32(12, 0, true);
	// createdAtUnixMs
	view.setBigUint64(16, BigInt(createdAtMs), true);
	// reserved
	view.setBigUint64(24, BigInt(0), true);

	return bytes;
}

function encodeSectionHeader(
	type: SectionType,
	codec: Codec,
	storedBytes: number,
): Uint8Array {
	const buf = new ArrayBuffer(SECTION_HEADER_BYTES);
	const view = new DataView(buf);
	const bytes = new Uint8Array(buf);

	// magic "PSEC"
	bytes.set(MAGIC_SECTION, 0);
	// sectionType
	view.setUint16(4, type, true);
	// codec
	view.setUint16(6, codec, true);
	// payloadStoredBytes (u64)
	view.setBigUint64(8, BigInt(storedBytes), true);

	return bytes;
}

function encodeFooter(
	tocOffset: bigint,
	tocBytes: bigint,
	fileBytes: bigint,
	tocCrc32: number,
): Uint8Array {
	const buf = new ArrayBuffer(FOOTER_BYTES);
	const view = new DataView(buf);
	const bytes = new Uint8Array(buf);

	// magic "PEND"
	bytes.set(MAGIC_FOOTER, 0);
	// fileFormatMajor
	view.setUint16(4, FORMAT_MAJOR, true);
	// fileFormatMinor
	view.setUint16(6, FORMAT_MINOR, true);
	// footerBytes
	view.setUint16(8, FOOTER_BYTES, true);
	// footerFlags
	view.setUint16(10, 0, true);
	// tocSectionOffset
	view.setBigUint64(12, tocOffset, true);
	// tocSectionBytes
	view.setBigUint64(20, tocBytes, true);
	// fileBytes (total file size including footer)
	view.setBigUint64(28, fileBytes, true);
	// tocPayloadCrc32
	view.setUint32(36, tocCrc32, true);

	return bytes;
}

// ---------------------------------------------------------------------------
// TOC builder
// ---------------------------------------------------------------------------

type TocEntryRecord = {
	sectionOffset: number;
	storedBytes: number;
	rawBytes: number;
	key: string | null;
	aux0: number;
	aux1: number;
	sectionType: SectionType;
	codec: Codec;
	flags: number;
};

function buildTocPayload(entries: TocEntryRecord[]): Uint8Array {
	// Build string table: collect all non-null keys and encode as NUL-terminated UTF-8
	const encoder = new TextEncoder();
	const keyOffsets = new Map<string, number>();
	const stringParts: Uint8Array[] = [];
	let stringTableSize = 0;

	for (const entry of entries) {
		if (entry.key != null && !keyOffsets.has(entry.key)) {
			keyOffsets.set(entry.key, stringTableSize);
			const encoded = encoder.encode(entry.key);
			stringParts.push(encoded);
			// +1 for NUL terminator
			stringTableSize += encoded.byteLength + 1;
		}
	}

	// Assemble string table bytes
	const stringTable = new Uint8Array(stringTableSize);
	let stOffset = 0;
	for (const part of stringParts) {
		stringTable.set(part, stOffset);
		stOffset += part.byteLength;
		stringTable[stOffset] = 0; // NUL terminator
		stOffset += 1;
	}

	// Total payload size
	const payloadSize =
		TOC_HEADER_BYTES + entries.length * TOC_ENTRY_BYTES + stringTableSize;

	const buf = new ArrayBuffer(payloadSize);
	const view = new DataView(buf);
	const bytes = new Uint8Array(buf);

	// TocHeader (16 bytes)
	view.setUint16(0, 1, true); // tocMajor
	view.setUint16(2, 0, true); // tocMinor
	view.setUint32(4, entries.length, true); // entryCount
	view.setUint32(8, stringTableSize, true); // stringTableBytes
	view.setUint32(12, 0, true); // tocFlags

	// TocEntry[] (32 bytes each)
	let entryOffset = TOC_HEADER_BYTES;
	for (const entry of entries) {
		// sectionOffset (u64)
		view.setBigUint64(entryOffset, BigInt(entry.sectionOffset), true);
		// storedBytes (u32)
		view.setUint32(entryOffset + 8, entry.storedBytes, true);
		// rawBytes (u32)
		view.setUint32(entryOffset + 12, entry.rawBytes, true);
		// keyOffset (u32)
		const kOff =
			entry.key != null
				? (keyOffsets.get(entry.key) ?? TOC_KEY_NONE)
				: TOC_KEY_NONE;
		view.setUint32(entryOffset + 16, kOff, true);
		// aux0 (u32)
		view.setUint32(entryOffset + 20, entry.aux0, true);
		// aux1 (u32)
		view.setUint32(entryOffset + 24, entry.aux1, true);
		// sectionType (u16)
		view.setUint16(entryOffset + 28, entry.sectionType, true);
		// codec (u8)
		view.setUint8(entryOffset + 30, entry.codec);
		// entryFlags (u8)
		view.setUint8(entryOffset + 31, entry.flags);

		entryOffset += TOC_ENTRY_BYTES;
	}

	// String table
	bytes.set(stringTable, entryOffset);

	return bytes;
}

// ---------------------------------------------------------------------------
// META payload builder
// ---------------------------------------------------------------------------

function buildMetaPayload(
	doc: Document,
	fileManifest: FileManifestEntry[],
): MetaPayload {
	// Exclude transient layers (e.g. pattern-edit working layers) from persisted
	// output. They are session-local state owned by a single peer and must not
	// be baked into the saved document.
	const persistedLayers = doc.layers.filter(
		(l) => l.transientKind === undefined,
	);
	const meta: MetaPayload = {
		metaSchemaMajor: META_SCHEMA_MAJOR,
		metaSchemaMinor: META_SCHEMA_MINOR,
		document: {
			id: doc.id,
			objects: doc.objects,
			layers: persistedLayers,
			viewport: doc.viewport,
			artboards: doc.artboards,
			brushPresets: doc.brushPresets,
			hdr: doc.hdr,
			colorProfile: doc.colorProfile,
			rasterizationDpi: doc.rasterizationDpi,
			defs: doc.defs,
			references3d: doc.references3d,
		},
		fileManifest,
	};

	if (doc.timelapse) {
		const blockCount = Math.ceil(
			doc.timelapse.entries.length / TIMELAPSE_BLOCK_SIZE,
		);
		meta.timelapse = {
			schemaVersion: doc.timelapse.version,
			totalUpdates: doc.timelapse.entries.length,
			blockCount,
		};
	}

	return meta;
}

function buildFileManifest(files: EmbeddedFile[]): FileManifestEntry[] {
	return files.map((f) => ({
		uid: f.uid,
		name: f.name,
		type: f.type,
		hash: f.hash,
		byteLength: f.bin.byteLength,
	}));
}

// ---------------------------------------------------------------------------
// Section write helpers
// ---------------------------------------------------------------------------

async function writeSection(
	sink: ChunkSink,
	type: SectionType,
	codec: Codec,
	rawData: Uint8Array,
): Promise<{ sectionOffset: number; storedBytes: number; rawBytes: number }> {
	const sectionOffset = sink.position;
	const rawBytes = rawData.byteLength;

	const stored =
		codec === Codec.Deflate ? await compressDeflate(rawData) : rawData;
	const storedBytes = stored.byteLength;

	sink.write(encodeSectionHeader(type, codec, storedBytes));
	sink.write(stored);

	return { sectionOffset, storedBytes, rawBytes };
}

// ---------------------------------------------------------------------------
// Timelapse section helpers
// ---------------------------------------------------------------------------

function buildTimelapseManifest(timelapse: TimelapseData): Uint8Array {
	const blockCount = Math.ceil(timelapse.entries.length / TIMELAPSE_BLOCK_SIZE);
	return encode({
		schemaVersion: timelapse.version,
		totalUpdates: timelapse.entries.length,
		blockCount,
	});
}

function buildTimelapseBlock(
	entries: TimelapseData["entries"],
	start: number,
	end: number,
): Uint8Array {
	const block = entries.slice(start, end).map((e) => ({
		t: e.t,
		u: e.u,
	}));
	return encode(block);
}
