import { compressDeflate } from "../binaryUtils";

interface TiffEncodeOptions {
	/** Pixel color model: "rgb" (3 samples/pixel) or "cmyk" (4 samples/pixel). */
	colorModel: "rgb" | "cmyk";
	/**
	 * Raw ICC profile bytes embedded via tag 34675 (ICC Profile).
	 * Omitted = no embedded profile.
	 */
	iccProfile?: Uint8Array;
	/** Resolution in dots per inch (default: 72). */
	dpi?: number;
	/** Strip compression: "none" (Compression=1) or "deflate" (Compression=8, Adobe Deflate). Default: "none". */
	compression?: "none" | "deflate";
}

/** One IFD entry. valueBytes is the little-endian serialized value payload. */
interface IfdEntry {
	tag: number;
	type: number;
	count: number;
	valueBytes: Uint8Array;
}

// TIFF field types
const TIFF_SHORT = 3;
const TIFF_LONG = 4;
const TIFF_RATIONAL = 5;
const TIFF_UNDEFINED = 7;

const HEADER_SIZE = 8;
const IFD_ENTRY_SIZE = 12;
/** Target uncompressed strip size used to derive RowsPerStrip (~1MB). */
const TARGET_STRIP_BYTES = 1_048_576;

/**
 * Encode 8-bit interleaved pixels as a baseline little-endian TIFF with a
 * single IFD. "rgb" writes 3 samples/pixel (Photometric=RGB); "cmyk" writes
 * 4 samples/pixel (Photometric=Separated, InkSet=CMYK). An ICC profile is
 * embedded only when provided.
 */
export async function encodeTiff(
	pixels: Uint8Array,
	width: number,
	height: number,
	options: TiffEncodeOptions,
): Promise<Uint8Array<ArrayBuffer>> {
	const { colorModel, iccProfile, dpi = 72, compression = "none" } = options;
	const samplesPerPixel = colorModel === "cmyk" ? 4 : 3;
	const bytesPerRow = width * samplesPerPixel;
	if (pixels.length !== bytesPerRow * height) {
		throw new Error(
			`${colorModel.toUpperCase()} buffer size mismatch: expected ${bytesPerRow * height} bytes, got ${pixels.length}`,
		);
	}

	const rowsPerStrip = Math.max(
		1,
		Math.min(height, Math.floor(TARGET_STRIP_BYTES / bytesPerRow)),
	);
	const stripCount = Math.ceil(height / rowsPerStrip);

	const strips: Uint8Array[] = [];
	for (let i = 0; i < stripCount; i++) {
		const start = i * rowsPerStrip * bytesPerRow;
		const end = Math.min(start + rowsPerStrip * bytesPerRow, pixels.length);
		const raw = pixels.subarray(start, end);
		strips.push(compression === "deflate" ? await compressDeflate(raw) : raw);
	}

	// IFD entries in ascending tag order (required by the TIFF spec).
	// StripOffsets (273) is a placeholder; it is patched once the layout is known.
	// PhotometricInterpretation: 2 (RGB) or 5 (Separated / ink-based).
	const entries: IfdEntry[] = [
		{ tag: 256, type: TIFF_LONG, count: 1, valueBytes: longBytes([width]) },
		{ tag: 257, type: TIFF_LONG, count: 1, valueBytes: longBytes([height]) },
		{
			tag: 258,
			type: TIFF_SHORT,
			count: samplesPerPixel,
			valueBytes: shortBytes(new Array(samplesPerPixel).fill(8)),
		},
		{
			tag: 259,
			type: TIFF_SHORT,
			count: 1,
			valueBytes: shortBytes([compression === "deflate" ? 8 : 1]),
		},
		{
			tag: 262,
			type: TIFF_SHORT,
			count: 1,
			valueBytes: shortBytes([colorModel === "cmyk" ? 5 : 2]),
		},
		{
			tag: 273,
			type: TIFF_LONG,
			count: stripCount,
			valueBytes: longBytes(new Array(stripCount).fill(0)),
		},
		{
			tag: 277,
			type: TIFF_SHORT,
			count: 1,
			valueBytes: shortBytes([samplesPerPixel]),
		},
		{
			tag: 278,
			type: TIFF_LONG,
			count: 1,
			valueBytes: longBytes([rowsPerStrip]),
		},
		{
			tag: 279,
			type: TIFF_LONG,
			count: stripCount,
			valueBytes: longBytes(strips.map((strip) => strip.length)),
		},
		{ tag: 282, type: TIFF_RATIONAL, count: 1, valueBytes: rationalBytes(dpi) },
		{ tag: 283, type: TIFF_RATIONAL, count: 1, valueBytes: rationalBytes(dpi) },
		// PlanarConfiguration = 1 (chunky). Spec default, but some CMYK readers
		// misinterpret multi-sample data when it is left implicit.
		{ tag: 284, type: TIFF_SHORT, count: 1, valueBytes: shortBytes([1]) },
		// ResolutionUnit = 2 (inch)
		{ tag: 296, type: TIFF_SHORT, count: 1, valueBytes: shortBytes([2]) },
		// InkSet = 1 (CMYK) + NumberOfInks = 4, only meaningful for Separated images
		...(colorModel === "cmyk"
			? [
					{
						tag: 332,
						type: TIFF_SHORT,
						count: 1,
						valueBytes: shortBytes([1]),
					},
					{
						tag: 334,
						type: TIFF_SHORT,
						count: 1,
						valueBytes: shortBytes([4]),
					},
				]
			: []),
		...(iccProfile
			? [
					{
						tag: 34675,
						type: TIFF_UNDEFINED,
						count: iccProfile.length,
						valueBytes: iccProfile,
					},
				]
			: []),
	];

	// Layout: header | IFD | external values | strip data.
	// Values longer than 4 bytes are stored externally; all external data
	// starts on an even (word-aligned) offset.
	const ifdOffset = HEADER_SIZE;
	const ifdSize = 2 + entries.length * IFD_ENTRY_SIZE + 4;
	let cursor = ifdOffset + ifdSize;

	const externalOffsets = new Map<IfdEntry, number>();
	for (const entry of entries) {
		if (entry.valueBytes.length <= 4) continue;
		cursor = alignEven(cursor);
		externalOffsets.set(entry, cursor);
		cursor += entry.valueBytes.length;
	}

	const stripOffsets: number[] = [];
	for (const strip of strips) {
		cursor = alignEven(cursor);
		stripOffsets.push(cursor);
		cursor += strip.length;
	}

	// Patch StripOffsets with the final strip positions (same byte length as
	// the placeholder, so the layout computed above stays valid).
	const stripOffsetsEntry = entries.find((entry) => entry.tag === 273);
	if (!stripOffsetsEntry) throw new Error("StripOffsets entry missing");
	stripOffsetsEntry.valueBytes = longBytes(stripOffsets);

	const out = new Uint8Array(cursor);
	const view = new DataView(out.buffer);

	// Header: "II" + magic 42 + offset to first IFD
	out[0] = 0x49;
	out[1] = 0x49;
	view.setUint16(2, 42, true);
	view.setUint32(4, ifdOffset, true);

	view.setUint16(ifdOffset, entries.length, true);
	entries.forEach((entry, i) => {
		const at = ifdOffset + 2 + i * IFD_ENTRY_SIZE;
		view.setUint16(at, entry.tag, true);
		view.setUint16(at + 2, entry.type, true);
		view.setUint32(at + 4, entry.count, true);
		const externalOffset = externalOffsets.get(entry);
		if (externalOffset === undefined) {
			// Inline value, left-justified within the 4-byte value field
			out.set(entry.valueBytes, at + 8);
		} else {
			view.setUint32(at + 8, externalOffset, true);
			out.set(entry.valueBytes, externalOffset);
		}
	});
	// Next IFD offset = 0 (single IFD)
	view.setUint32(ifdOffset + 2 + entries.length * IFD_ENTRY_SIZE, 0, true);

	strips.forEach((strip, i) => {
		out.set(strip, stripOffsets[i]);
	});

	return out;
}

function alignEven(offset: number): number {
	return offset + (offset & 1);
}

function shortBytes(values: number[]): Uint8Array {
	const bytes = new Uint8Array(values.length * 2);
	const view = new DataView(bytes.buffer);
	values.forEach((value, i) => {
		view.setUint16(i * 2, value, true);
	});
	return bytes;
}

function longBytes(values: number[]): Uint8Array {
	const bytes = new Uint8Array(values.length * 4);
	const view = new DataView(bytes.buffer);
	values.forEach((value, i) => {
		view.setUint32(i * 4, value, true);
	});
	return bytes;
}

function rationalBytes(value: number): Uint8Array {
	return Number.isInteger(value)
		? longBytes([value, 1])
		: longBytes([Math.round(value * 10_000), 10_000]);
}
