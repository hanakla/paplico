/**
 * JPEG APP2 ICC profile embedding.
 * Inserts an ICC profile into a JPEG byte stream as one or more APP2
 * "ICC_PROFILE" segments per the ICC.1 specification.
 */

interface JpegSegment {
	marker: number;
	start: number;
	end: number;
}

/** "ICC_PROFILE\0" identifier at the start of every ICC APP2 segment. */
const ICC_IDENTIFIER = new Uint8Array([
	0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00,
]);

/** Max profile bytes per APP2 segment: 65535 - length(2) - identifier(12) - chunk numbers(2). */
const MAX_PROFILE_BYTES_PER_SEGMENT = 65_519;

const MARKER_APP0 = 0xe0;
const MARKER_APP1 = 0xe1;
const MARKER_APP2 = 0xe2;
const MARKER_SOS = 0xda;
const MARKER_EOI = 0xd9;

/**
 * Embed an ICC profile into a JPEG as APP2 ICC_PROFILE segments.
 * Existing ICC_PROFILE segments are removed. The new segments are placed
 * right after SOI, or after the leading run of APP0/APP1 segments if present.
 */
export function embedIccProfileInJpeg(
	jpeg: Uint8Array,
	profile: Uint8Array,
): Uint8Array<ArrayBuffer> {
	if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
		throw new Error("JPEG: missing SOI marker");
	}

	const { segments, tailStart } = parseJpegSegments(jpeg);
	const keptSegments = segments.filter(
		(segment) => !isIccProfileSegment(jpeg, segment),
	);

	// Insert after the leading run of APP0/APP1 segments
	let insertIndex = 0;
	while (
		insertIndex < keptSegments.length &&
		(keptSegments[insertIndex].marker === MARKER_APP0 ||
			keptSegments[insertIndex].marker === MARKER_APP1)
	) {
		insertIndex++;
	}

	const iccSegments = buildIccSegments(profile);

	const parts: Uint8Array[] = [jpeg.subarray(0, 2)];
	for (let i = 0; i < keptSegments.length; i++) {
		if (i === insertIndex) parts.push(...iccSegments);
		const segment = keptSegments[i];
		parts.push(jpeg.subarray(segment.start, segment.end));
	}
	if (insertIndex === keptSegments.length) parts.push(...iccSegments);
	parts.push(jpeg.subarray(tailStart));

	return concatBytes(parts);
}

/**
 * Scan marker segments after SOI until SOS/EOI (entropy-coded data and
 * everything after is returned untouched via tailStart).
 */
function parseJpegSegments(jpeg: Uint8Array): {
	segments: JpegSegment[];
	tailStart: number;
} {
	const segments: JpegSegment[] = [];
	let offset = 2;
	let tailStart = jpeg.length;

	while (offset + 1 < jpeg.length) {
		if (jpeg[offset] !== 0xff) {
			throw new Error("JPEG: expected marker byte 0xFF");
		}
		const marker = jpeg[offset + 1];
		if (marker === MARKER_SOS || marker === MARKER_EOI) {
			tailStart = offset;
			break;
		}
		// Standalone markers without a length field
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			segments.push({ marker, start: offset, end: offset + 2 });
			offset += 2;
			continue;
		}
		if (offset + 4 > jpeg.length) {
			throw new Error("JPEG: truncated segment length");
		}
		const length = (jpeg[offset + 2] << 8) | jpeg[offset + 3];
		const end = offset + 2 + length;
		if (length < 2 || end > jpeg.length) {
			throw new Error("JPEG: truncated segment data");
		}
		segments.push({ marker, start: offset, end });
		offset = end;
	}

	return { segments, tailStart };
}

function isIccProfileSegment(jpeg: Uint8Array, segment: JpegSegment): boolean {
	if (segment.marker !== MARKER_APP2) return false;
	const dataStart = segment.start + 4;
	if (dataStart + ICC_IDENTIFIER.length > segment.end) return false;
	for (let i = 0; i < ICC_IDENTIFIER.length; i++) {
		if (jpeg[dataStart + i] !== ICC_IDENTIFIER[i]) return false;
	}
	return true;
}

/** Split the profile into APP2 segments with 1-based chunk numbering. */
function buildIccSegments(profile: Uint8Array): Uint8Array[] {
	const chunkCount = Math.max(
		1,
		Math.ceil(profile.length / MAX_PROFILE_BYTES_PER_SEGMENT),
	);
	if (chunkCount > 255) {
		throw new Error("JPEG: ICC profile is too large to embed (max 255 chunks)");
	}

	const segments: Uint8Array[] = [];
	for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
		const chunkData = profile.subarray(
			chunkIndex * MAX_PROFILE_BYTES_PER_SEGMENT,
			(chunkIndex + 1) * MAX_PROFILE_BYTES_PER_SEGMENT,
		);
		// length(2) + identifier(12) + chunk number(1) + chunk count(1) + data
		const segmentLength = 2 + ICC_IDENTIFIER.length + 2 + chunkData.length;
		const segment = new Uint8Array(2 + segmentLength);
		segment[0] = 0xff;
		segment[1] = MARKER_APP2;
		segment[2] = (segmentLength >> 8) & 0xff;
		segment[3] = segmentLength & 0xff;
		segment.set(ICC_IDENTIFIER, 4);
		segment[4 + ICC_IDENTIFIER.length] = chunkIndex + 1;
		segment[5 + ICC_IDENTIFIER.length] = chunkCount;
		segment.set(chunkData, 6 + ICC_IDENTIFIER.length);
		segments.push(segment);
	}
	return segments;
}

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}
