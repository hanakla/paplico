/**
 * PAPF (Paplico Packed Format) v1 - Binary format type definitions.
 *
 * All multi-byte integers are little-endian.
 * See the format specification for full binary layout details.
 */

import type { LengthUnit } from "../../document/units";
import type {
	AnyArtObject,
	AppearancePreset,
	Artboard,
	BrushPreset,
	ColorProfileSettings,
	DefEntry,
	HdrSettings,
	Layer,
	Reference3DDef,
	Viewport,
} from "../../schema";
import type { TimelapseDirtyRect } from "../../timelapse/types";

// ---------------------------------------------------------------------------
// Magic bytes (ASCII encoded)
// ---------------------------------------------------------------------------

/** File header magic: "PAPF" */
export const MAGIC_HEADER = new Uint8Array([0x50, 0x41, 0x50, 0x46]);

/** Section header magic: "PSEC" */
export const MAGIC_SECTION = new Uint8Array([0x50, 0x53, 0x45, 0x43]);

/** Footer magic: "PEND" */
export const MAGIC_FOOTER = new Uint8Array([0x50, 0x45, 0x4e, 0x44]);

// ---------------------------------------------------------------------------
// Fixed structure sizes (bytes)
// ---------------------------------------------------------------------------

export const FILE_HEADER_BYTES = 32;
export const SECTION_HEADER_BYTES = 16;
export const FOOTER_BYTES = 40;
export const TOC_HEADER_BYTES = 16;
export const TOC_ENTRY_BYTES = 32;

// ---------------------------------------------------------------------------
// Section types
// ---------------------------------------------------------------------------

/** Section type identifiers stored as u16 in the section header. */
export const SectionType = {
	/** Document metadata (CBOR payload) */
	META: 0x0001,
	/** Embedded file (raw binary payload) */
	FILE: 0x0002,
	/** Timelapse manifest header */
	TMLH: 0x0003,
	/** Timelapse binary block */
	TMLB: 0x0004,
	/** Table of contents (must be the last section before footer) */
	TOC: 0x00ff,
} as const;

export type SectionType = (typeof SectionType)[keyof typeof SectionType];

// ---------------------------------------------------------------------------
// Compression codecs
// ---------------------------------------------------------------------------

/** Compression codec identifiers stored as u16 in the section header. */
export const Codec = {
	/** No compression */
	None: 0,
	/** Deflate (browser-native CompressionStream) */
	Deflate: 1,
} as const;

export type Codec = (typeof Codec)[keyof typeof Codec];

// ---------------------------------------------------------------------------
// TOC key sentinel
// ---------------------------------------------------------------------------

/** Sentinel value for TocEntry.keyOffset when no string key is present. */
export const TOC_KEY_NONE = 0xffff_ffff;

// ---------------------------------------------------------------------------
// Parsed TOC types (reader output)
// ---------------------------------------------------------------------------

export type ParsedTocEntry = {
	sectionType: SectionType;
	codec: Codec;
	/** Absolute byte offset of the PSEC section header within the file. */
	sectionOffset: bigint;
	/** Absolute byte offset of the payload (sectionOffset + 16n). */
	payloadOffset: bigint;
	/** Compressed (stored) payload size in bytes. */
	storedBytes: number;
	/** Uncompressed payload size in bytes, or null if unknown. */
	rawBytes: number | null;
	/** String key from the TOC string table, or null if absent. For FILE entries this is the file UID. */
	key: string | null;
	/** Auxiliary field 0. For TMLB entries this is startUpdateIndex. */
	aux0: number;
	/** Auxiliary field 1. For TMLB entries this is updateCount. */
	aux1: number;
	/** Per-entry flags (u8). */
	flags: number;
};

export type ParsedToc = {
	entries: ParsedTocEntry[];
	/** Lookup by string key (only entries that have a non-null key). */
	byKey: Map<string, ParsedTocEntry>;
	/** FILE entries indexed by file UID. */
	fileByUid: Map<string, ParsedTocEntry>;
	/** TMLB entries sorted ascending by aux0 (block index). */
	timelapseBlocks: ParsedTocEntry[];
	/** The single META entry. */
	metaEntry: ParsedTocEntry;
};

// ---------------------------------------------------------------------------
// File manifest (stored inside MetaPayload)
// ---------------------------------------------------------------------------

export type FileManifestEntry = {
	/** Unique identifier. Matches the TOC FILE entry key. */
	uid: string;
	/** Original file name. */
	name: string;
	/** MIME type (e.g. "image/png"). */
	type: string;
	/** SHA-256 hex digest for integrity verification. */
	hash: string;
	/** Uncompressed file size in bytes. */
	byteLength: number;
};

// ---------------------------------------------------------------------------
// META payload (CBOR-encoded section body)
// ---------------------------------------------------------------------------

/**
 * The CBOR-encoded body of the META section.
 *
 * `document` intentionally omits `files` (binary blobs stored as FILE sections)
 * and `timelapse` (stored as TMLH/TMLB sections).
 */
export type MetaPayload = {
	metaSchemaMajor: number;
	metaSchemaMinor: number;
	document: {
		id: string;
		objects: Record<string, AnyArtObject>;
		layers: Layer[];
		viewport: Viewport;
		artboards: Artboard[];
		brushPresets: BrushPreset[];
		/** Optional for backward compatibility — readers default to `[]`. */
		appearancePresets?: AppearancePreset[];
		hdr?: HdrSettings;
		colorProfile?: ColorProfileSettings;
		rasterizationDpi?: number;
		units?: LengthUnit;
		/**
		 * Off-canvas ArtObject definitions (patterns / vector brushes). Optional
		 * for backward compatibility — readers should default to `{}` when
		 * absent (same lenient pattern used for colorProfile).
		 */
		defs?: Record<string, DefEntry>;
		/**
		 * Shared 3D scene definitions. Optional — readers should default to
		 * `{}` when absent (same lenient pattern used for defs).
		 */
		references3d?: Record<string, Reference3DDef>;
	};
	fileManifest: FileManifestEntry[];
	timelapse?: {
		schemaVersion: number;
		totalUpdates: number;
		blockCount: number;
	};
};

/**
 * The CBOR-encoded body of the TMLH section.
 *
 * The per-entry dirty rects live here rather than alongside the updates in
 * TMLB, so filtering playback down to one artboard never has to decompress an
 * update payload.
 */
export type TimelapseManifestPayload = {
	schemaVersion: number;
	totalUpdates: number;
	blockCount: number;
	/**
	 * World rect `[minX, minY, maxX, maxY]` per entry, or null where the
	 * affected area is unknown. Absent in recordings written before the index
	 * existed.
	 */
	dirtyRects?: (TimelapseDirtyRect | null)[];
	/**
	 * Entry positions where the recorded state starts over, written whenever a
	 * document switch split the recording. Absent means one unbroken stream.
	 */
	baselines?: number[];
};

// ---------------------------------------------------------------------------
// Reader result type
// ---------------------------------------------------------------------------
