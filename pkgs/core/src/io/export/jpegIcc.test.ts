import { describe, expect, it } from "vitest";
import { embedIccProfileInJpeg } from "./jpegIcc";

const MARKER_APP0 = 0xe0;
const MARKER_APP2 = 0xe2;
const MARKER_DQT = 0xdb;
const ICC_IDENTIFIER = "ICC_PROFILE\0";
const MAX_PROFILE_BYTES_PER_SEGMENT = 65_519;

describe("embedIccProfileInJpeg", () => {
	const profile = Uint8Array.from({ length: 300 }, (_, i) => (i * 17) % 256);

	it("should throw when the SOI marker is missing", () => {
		expect(() =>
			embedIccProfileInJpeg(new Uint8Array([0x00, 0x01, 0x02]), profile),
		).toThrow("SOI");
	});

	it("should insert the APP2 segment after the APP0 segment", () => {
		const result = embedIccProfileInJpeg(buildMinimalJpeg(), profile);

		const markers = parseJpegSegments(result).map((s) => s.marker);
		expect(markers).toEqual([MARKER_APP0, MARKER_APP2, MARKER_DQT]);
		// Stream must still terminate with EOI
		expect([...result.subarray(-2)]).toEqual([0xff, 0xd9]);
	});

	it("should insert right after SOI when no APP0/APP1 segments precede", () => {
		const jpeg = concatBytes([
			new Uint8Array([0xff, 0xd8]),
			buildSegment(MARKER_DQT, new Uint8Array([0x00, 0x01, 0x02, 0x03])),
			new Uint8Array([0xff, 0xd9]),
		]);

		const result = embedIccProfileInJpeg(jpeg, profile);

		const markers = parseJpegSegments(result).map((s) => s.marker);
		expect(markers).toEqual([MARKER_APP2, MARKER_DQT]);
	});

	it("should split a large profile into sequentially numbered chunks", () => {
		const bigProfile = Uint8Array.from(
			{ length: 600_000 },
			(_, i) => (i * 13) % 256,
		);

		const result = embedIccProfileInJpeg(buildMinimalJpeg(), bigProfile);
		const iccSegments = parseJpegSegments(result).filter(isIccSegment);

		const expectedChunkCount = Math.ceil(
			bigProfile.length / MAX_PROFILE_BYTES_PER_SEGMENT,
		);
		expect(iccSegments.length).toBe(expectedChunkCount);

		iccSegments.forEach((segment, index) => {
			expect(segment.payload[12]).toBe(index + 1);
			expect(segment.payload[13]).toBe(expectedChunkCount);
			const dataLength = segment.payload.length - 14;
			if (index < expectedChunkCount - 1) {
				expect(dataLength).toBe(MAX_PROFILE_BYTES_PER_SEGMENT);
			}
		});
	});

	it("should remove existing ICC_PROFILE segments", () => {
		const otherProfile = Uint8Array.from({ length: 64 }, (_, i) => 255 - i);
		const withIcc = embedIccProfileInJpeg(buildMinimalJpeg(), profile);

		const replaced = embedIccProfileInJpeg(withIcc, otherProfile);

		const iccSegments = parseJpegSegments(replaced).filter(isIccSegment);
		expect(iccSegments.length).toBe(1);
		expect(extractProfile(replaced)).toEqual(otherProfile);
	});

	it("should preserve the embedded profile byte-for-byte across chunks", () => {
		const bigProfile = Uint8Array.from(
			{ length: 600_000 },
			(_, i) => (i * 13) % 256,
		);

		const result = embedIccProfileInJpeg(buildMinimalJpeg(), bigProfile);

		expect(extractProfile(result)).toEqual(bigProfile);
	});
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** SOI + APP0(JFIF) + DQT-like dummy + EOI. */
function buildMinimalJpeg(): Uint8Array {
	const jfifData = new Uint8Array([
		0x4a,
		0x46,
		0x49,
		0x46,
		0x00, // "JFIF\0"
		0x01,
		0x01, // version 1.1
		0x00, // density units
		0x00,
		0x01,
		0x00,
		0x01, // density 1x1
		0x00,
		0x00, // no thumbnail
	]);
	return concatBytes([
		new Uint8Array([0xff, 0xd8]),
		buildSegment(MARKER_APP0, jfifData),
		buildSegment(MARKER_DQT, new Uint8Array([0x00, 0x01, 0x02, 0x03])),
		new Uint8Array([0xff, 0xd9]),
	]);
}

function buildSegment(marker: number, data: Uint8Array): Uint8Array {
	const length = 2 + data.length;
	const segment = new Uint8Array(4 + data.length);
	segment[0] = 0xff;
	segment[1] = marker;
	segment[2] = (length >> 8) & 0xff;
	segment[3] = length & 0xff;
	segment.set(data, 4);
	return segment;
}

/** Walk marker segments after SOI until SOS/EOI. Payload excludes the length field. */
function parseJpegSegments(jpeg: Uint8Array): {
	marker: number;
	payload: Uint8Array;
}[] {
	const segments: { marker: number; payload: Uint8Array }[] = [];
	let offset = 2;

	while (offset + 1 < jpeg.length) {
		expect(jpeg[offset]).toBe(0xff);
		const marker = jpeg[offset + 1];
		if (marker === 0xda || marker === 0xd9) break;
		const length = (jpeg[offset + 2] << 8) | jpeg[offset + 3];
		segments.push({
			marker,
			payload: jpeg.subarray(offset + 4, offset + 2 + length),
		});
		offset += 2 + length;
	}

	return segments;
}

function isIccSegment(segment: {
	marker: number;
	payload: Uint8Array;
}): boolean {
	return (
		segment.marker === MARKER_APP2 &&
		String.fromCharCode(...segment.payload.subarray(0, 12)) === ICC_IDENTIFIER
	);
}

/** Reassemble the profile from all ICC APP2 segments in order. */
function extractProfile(jpeg: Uint8Array): Uint8Array {
	const parts = parseJpegSegments(jpeg)
		.filter(isIccSegment)
		.map((segment) => segment.payload.subarray(14));
	return concatBytes(parts);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
	const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}
