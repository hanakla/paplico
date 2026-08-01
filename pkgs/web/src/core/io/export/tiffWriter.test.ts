import { describe, expect, it } from "vitest";
import { decompressDeflate } from "../binaryUtils";
import { encodeTiff } from "./tiffWriter";

const TAG_IMAGE_WIDTH = 256;
const TAG_IMAGE_LENGTH = 257;
const TAG_BITS_PER_SAMPLE = 258;
const TAG_COMPRESSION = 259;
const TAG_PHOTOMETRIC = 262;
const TAG_STRIP_OFFSETS = 273;
const TAG_SAMPLES_PER_PIXEL = 277;
const TAG_ROWS_PER_STRIP = 278;
const TAG_STRIP_BYTE_COUNTS = 279;
const TAG_X_RESOLUTION = 282;
const TAG_Y_RESOLUTION = 283;
const TAG_PLANAR_CONFIGURATION = 284;
const TAG_RESOLUTION_UNIT = 296;
const TAG_INK_SET = 332;
const TAG_NUMBER_OF_INKS = 334;
const TAG_ICC_PROFILE = 34675;

describe("encodeTiff", () => {
	const makeCmyk = (width: number, height: number): Uint8Array =>
		Uint8Array.from({ length: width * height * 4 }, (_, i) => (i * 7) % 251);
	const makeRgb = (width: number, height: number): Uint8Array =>
		Uint8Array.from({ length: width * height * 3 }, (_, i) => (i * 7) % 251);

	// Odd-length profile to exercise even-offset padding after the ICC value
	const profile = Uint8Array.from({ length: 13 }, (_, i) => i + 1);

	it("should write a little-endian header with magic 42", async () => {
		const tiff = await encodeTiff(makeCmyk(4, 3), 4, 3, {
			colorModel: "cmyk",
			iccProfile: profile,
		});

		expect(tiff[0]).toBe(0x49);
		expect(tiff[1]).toBe(0x49);
		expect(new DataView(tiff.buffer).getUint16(2, true)).toBe(42);
	});

	it("should write correct dimension, sample, and resolution tag values", async () => {
		const tiff = await encodeTiff(makeCmyk(4, 3), 4, 3, {
			colorModel: "cmyk",
			iccProfile: profile,
			dpi: 300,
		});
		const tags = parseTiff(tiff);

		expect(tags.get(TAG_IMAGE_WIDTH)?.values).toEqual([4]);
		expect(tags.get(TAG_IMAGE_LENGTH)?.values).toEqual([3]);
		expect(tags.get(TAG_BITS_PER_SAMPLE)?.values).toEqual([8, 8, 8, 8]);
		expect(tags.get(TAG_ROWS_PER_STRIP)?.values).toEqual([3]);
		// RATIONAL values are stored as [numerator, denominator]
		expect(tags.get(TAG_X_RESOLUTION)?.values).toEqual([300, 1]);
		expect(tags.get(TAG_Y_RESOLUTION)?.values).toEqual([300, 1]);
		expect(tags.get(TAG_RESOLUTION_UNIT)?.values).toEqual([2]);
	});

	it("should default resolution to 72 dpi", async () => {
		const tiff = await encodeTiff(makeCmyk(4, 3), 4, 3, {
			colorModel: "cmyk",
			iccProfile: profile,
		});
		const tags = parseTiff(tiff);

		expect(tags.get(TAG_X_RESOLUTION)?.values).toEqual([72, 1]);
		expect(tags.get(TAG_Y_RESOLUTION)?.values).toEqual([72, 1]);
	});

	it("should mark the image as CMYK (Separated, InkSet=1, 4 samples)", async () => {
		const tiff = await encodeTiff(makeCmyk(4, 3), 4, 3, {
			colorModel: "cmyk",
			iccProfile: profile,
		});
		const tags = parseTiff(tiff);

		expect(tags.get(TAG_PHOTOMETRIC)?.values).toEqual([5]);
		expect(tags.get(TAG_INK_SET)?.values).toEqual([1]);
		expect(tags.get(TAG_NUMBER_OF_INKS)?.values).toEqual([4]);
		expect(tags.get(TAG_SAMPLES_PER_PIXEL)?.values).toEqual([4]);
		expect(tags.get(TAG_PLANAR_CONFIGURATION)?.values).toEqual([1]);
	});

	it("should mark the image as RGB (Photometric=2, no InkSet, 3 samples)", async () => {
		const tiff = await encodeTiff(makeRgb(4, 3), 4, 3, { colorModel: "rgb" });
		const tags = parseTiff(tiff);

		expect(tags.get(TAG_PHOTOMETRIC)?.values).toEqual([2]);
		expect(tags.get(TAG_BITS_PER_SAMPLE)?.values).toEqual([8, 8, 8]);
		expect(tags.get(TAG_SAMPLES_PER_PIXEL)?.values).toEqual([3]);
		expect(tags.get(TAG_PLANAR_CONFIGURATION)?.values).toEqual([1]);
		expect(tags.has(TAG_INK_SET)).toBe(false);
		expect(tags.has(TAG_NUMBER_OF_INKS)).toBe(false);
	});

	it("should embed the ICC profile bytes verbatim", async () => {
		const tiff = await encodeTiff(makeCmyk(4, 3), 4, 3, {
			colorModel: "cmyk",
			iccProfile: profile,
		});
		const tags = parseTiff(tiff);
		const icc = tags.get(TAG_ICC_PROFILE);

		expect(icc?.count).toBe(profile.length);
		expect(icc?.bytes).toEqual(profile);
	});

	it("should omit the ICC Profile tag when no profile is given", async () => {
		const tiff = await encodeTiff(makeRgb(4, 3), 4, 3, { colorModel: "rgb" });
		const tags = parseTiff(tiff);

		expect(tags.has(TAG_ICC_PROFILE)).toBe(false);
	});

	it("should store uncompressed strips that concatenate back to the input", async () => {
		const cmyk = makeCmyk(4, 3);
		const tiff = await encodeTiff(cmyk, 4, 3, {
			colorModel: "cmyk",
			iccProfile: profile,
		});
		const tags = parseTiff(tiff);

		expect(tags.get(TAG_COMPRESSION)?.values).toEqual([1]);
		expect(concatStrips(tiff, tags)).toEqual(cmyk);
	});

	it("should deflate-compress strips that decompress back to the input", async () => {
		const cmyk = makeCmyk(4, 3);
		const tiff = await encodeTiff(cmyk, 4, 3, {
			colorModel: "cmyk",
			iccProfile: profile,
			compression: "deflate",
		});
		const tags = parseTiff(tiff);

		expect(tags.get(TAG_COMPRESSION)?.values).toEqual([8]);

		const offsets = tags.get(TAG_STRIP_OFFSETS)?.values ?? [];
		const counts = tags.get(TAG_STRIP_BYTE_COUNTS)?.values ?? [];
		const decompressed = await Promise.all(
			offsets.map((offset, i) =>
				decompressDeflate(tiff.subarray(offset, offset + counts[i])),
			),
		);
		expect(concatBytes(decompressed)).toEqual(cmyk);
	});

	it("should split large images into ~1MB strips with correct boundaries", async () => {
		// bytesPerRow = 1024 * 4 = 4096 -> rowsPerStrip = 256, so 300 rows = 2 strips
		const width = 1024;
		const height = 300;
		const cmyk = makeCmyk(width, height);
		const tiff = await encodeTiff(cmyk, width, height, {
			colorModel: "cmyk",
			iccProfile: profile,
		});
		const tags = parseTiff(tiff);

		const bytesPerRow = width * 4;
		expect(tags.get(TAG_ROWS_PER_STRIP)?.values).toEqual([256]);
		expect(tags.get(TAG_STRIP_BYTE_COUNTS)?.values).toEqual([
			256 * bytesPerRow,
			44 * bytesPerRow,
		]);

		const offsets = tags.get(TAG_STRIP_OFFSETS)?.values ?? [];
		expect(offsets).toHaveLength(2);
		for (const offset of offsets) {
			expect(offset % 2).toBe(0);
		}

		// Each strip must contain exactly its own row range
		const firstStrip = tiff.subarray(
			offsets[0],
			offsets[0] + 256 * bytesPerRow,
		);
		const secondStrip = tiff.subarray(
			offsets[1],
			offsets[1] + 44 * bytesPerRow,
		);
		expect(firstStrip).toEqual(cmyk.subarray(0, 256 * bytesPerRow));
		expect(secondStrip).toEqual(cmyk.subarray(256 * bytesPerRow));
	});

	it("should list IFD tags in ascending order", async () => {
		const tiff = await encodeTiff(makeCmyk(4, 3), 4, 3, {
			colorModel: "cmyk",
			iccProfile: profile,
		});
		const tagIds = [...parseTiff(tiff).keys()];

		expect(tagIds).toEqual([...tagIds].sort((a, b) => a - b));
	});

	it("should throw when the buffer size does not match the dimensions", async () => {
		await expect(
			encodeTiff(new Uint8Array(10), 4, 3, {
				colorModel: "cmyk",
				iccProfile: profile,
			}),
		).rejects.toThrow(/size mismatch/);
	});
});

// ---------------------------------------------------------------------------
// Minimal TIFF parser (test helper)
// ---------------------------------------------------------------------------

interface ParsedTag {
	type: number;
	count: number;
	/** Decoded numeric values. RATIONAL is flattened to [num, den, ...]. */
	values: number[];
	/** Raw value bytes (inline or external). */
	bytes: Uint8Array;
}

const TYPE_BYTE_SIZE: Record<number, number> = {
	1: 1, // BYTE
	3: 2, // SHORT
	4: 4, // LONG
	5: 8, // RATIONAL
	7: 1, // UNDEFINED
};

function parseTiff(tiff: Uint8Array): Map<number, ParsedTag> {
	const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
	if (tiff[0] !== 0x49 || tiff[1] !== 0x49) {
		throw new Error("Not a little-endian TIFF");
	}
	if (view.getUint16(2, true) !== 42) {
		throw new Error("Bad TIFF magic");
	}

	const ifdOffset = view.getUint32(4, true);
	const entryCount = view.getUint16(ifdOffset, true);
	const tags = new Map<number, ParsedTag>();

	for (let i = 0; i < entryCount; i++) {
		const at = ifdOffset + 2 + i * 12;
		const tag = view.getUint16(at, true);
		const type = view.getUint16(at + 2, true);
		const count = view.getUint32(at + 4, true);
		const byteLength = TYPE_BYTE_SIZE[type] * count;
		const valueOffset = byteLength <= 4 ? at + 8 : view.getUint32(at + 8, true);
		const bytes = tiff.slice(valueOffset, valueOffset + byteLength);

		tags.set(tag, { type, count, values: decodeValues(bytes, type), bytes });
	}

	return tags;
}

function decodeValues(bytes: Uint8Array, type: number): number[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	switch (type) {
		case 3:
			return Array.from({ length: bytes.length / 2 }, (_, i) =>
				view.getUint16(i * 2, true),
			);
		case 4:
		case 5:
			return Array.from({ length: bytes.length / 4 }, (_, i) =>
				view.getUint32(i * 4, true),
			);
		default:
			return [...bytes];
	}
}

function concatStrips(
	tiff: Uint8Array,
	tags: Map<number, ParsedTag>,
): Uint8Array {
	const offsets = tags.get(TAG_STRIP_OFFSETS)?.values ?? [];
	const counts = tags.get(TAG_STRIP_BYTE_COUNTS)?.values ?? [];
	return concatBytes(
		offsets.map((offset, i) => tiff.subarray(offset, offset + counts[i])),
	);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const out = new Uint8Array(total);
	let cursor = 0;
	for (const chunk of chunks) {
		out.set(chunk, cursor);
		cursor += chunk.length;
	}
	return out;
}
