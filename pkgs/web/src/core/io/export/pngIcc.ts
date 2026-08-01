/**
 * PNG iCCP chunk embedding.
 * Inserts an ICC profile into a PNG byte stream as an iCCP chunk,
 * removing conflicting color-information chunks (PNG spec forbids
 * iCCP and sRGB coexistence).
 */

import { compressDeflate, crc32 } from "../binaryUtils";

interface PngChunk {
	type: string;
	bytes: Uint8Array;
}

const PNG_SIGNATURE = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Color-information chunk types replaced by iCCP. */
const REMOVED_CHUNK_TYPES = new Set(["iCCP", "sRGB", "gAMA", "cHRM"]);

/**
 * Embed an ICC profile into a PNG as an iCCP chunk placed right after IHDR.
 * Existing iCCP / sRGB / gAMA / cHRM chunks are removed.
 *
 * @param png Complete PNG byte stream
 * @param profile Raw ICC profile bytes
 * @param profileName Latin-1 printable profile name (1-79 bytes)
 */
export async function embedIccProfileInPng(
	png: Uint8Array,
	profile: Uint8Array,
	profileName: string,
): Promise<Uint8Array<ArrayBuffer>> {
	validatePngSignature(png);

	const chunks = parsePngChunks(png);
	if (chunks[0]?.type !== "IHDR") {
		throw new Error("PNG: first chunk is not IHDR");
	}

	const nameBytes = encodeProfileName(profileName);
	const compressedProfile = await compressDeflate(profile);

	// iCCP payload: name + null separator + compression method (0 = deflate) + zlib data
	const payload = new Uint8Array(
		nameBytes.length + 2 + compressedProfile.length,
	);
	payload.set(nameBytes, 0);
	payload[nameBytes.length] = 0x00;
	payload[nameBytes.length + 1] = 0x00;
	payload.set(compressedProfile, nameBytes.length + 2);

	const iccpChunk = buildPngChunk("iCCP", payload);
	const keptChunks = chunks.filter(
		(chunk) => !REMOVED_CHUNK_TYPES.has(chunk.type),
	);

	const parts: Uint8Array[] = [
		PNG_SIGNATURE,
		keptChunks[0].bytes,
		iccpChunk,
		...keptChunks.slice(1).map((chunk) => chunk.bytes),
	];
	return concatBytes(parts);
}

function validatePngSignature(png: Uint8Array): void {
	if (png.length < PNG_SIGNATURE.length) {
		throw new Error("PNG: data is too short to contain a signature");
	}
	for (let i = 0; i < PNG_SIGNATURE.length; i++) {
		if (png[i] !== PNG_SIGNATURE[i]) {
			throw new Error("PNG: invalid signature");
		}
	}
}

function parsePngChunks(png: Uint8Array): PngChunk[] {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	const chunks: PngChunk[] = [];
	let offset = PNG_SIGNATURE.length;

	while (offset < png.length) {
		if (offset + 12 > png.length) {
			throw new Error("PNG: truncated chunk header");
		}
		const dataLength = view.getUint32(offset);
		const totalLength = 12 + dataLength;
		if (offset + totalLength > png.length) {
			throw new Error("PNG: truncated chunk data");
		}
		const type = String.fromCharCode(
			png[offset + 4],
			png[offset + 5],
			png[offset + 6],
			png[offset + 7],
		);
		chunks.push({ type, bytes: png.subarray(offset, offset + totalLength) });
		offset += totalLength;
	}

	return chunks;
}

/**
 * Coerce an arbitrary string into a valid iCCP profile name.
 * Removes non-printable / non-Latin-1 characters, trims surrounding spaces,
 * truncates to 79 bytes (1 byte per Latin-1 char), and falls back to
 * "ICC Profile" when nothing usable remains. The result always satisfies
 * `encodeProfileName`.
 */
export function sanitizeIccProfileName(name: string): string {
	let sanitized = "";
	for (const char of name) {
		const code = char.codePointAt(0)!;
		const printable =
			(code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff);
		if (printable) sanitized += char;
	}

	sanitized = sanitized.trim();
	if (sanitized.length > 79) sanitized = sanitized.slice(0, 79).trim();

	return sanitized.length > 0 ? sanitized : "ICC Profile";
}

/**
 * Encode an iCCP profile name as Latin-1.
 * PNG spec: 1-79 bytes of printable Latin-1 (32-126, 161-255),
 * without leading or trailing spaces.
 */
function encodeProfileName(profileName: string): Uint8Array {
	if (profileName.length < 1 || profileName.length > 79) {
		throw new Error("PNG: iCCP profile name must be 1-79 bytes");
	}
	if (profileName.startsWith(" ") || profileName.endsWith(" ")) {
		throw new Error(
			"PNG: iCCP profile name must not have leading or trailing spaces",
		);
	}
	const bytes = new Uint8Array(profileName.length);
	for (let i = 0; i < profileName.length; i++) {
		const code = profileName.charCodeAt(i);
		const printable =
			(code >= 32 && code <= 126) || (code >= 161 && code <= 255);
		if (!printable) {
			throw new Error("PNG: iCCP profile name must be printable Latin-1");
		}
		bytes[i] = code;
	}
	return bytes;
}

/** Build a PNG chunk: length(4 BE) + type(4) + data + CRC-32 over type+data. */
function buildPngChunk(type: string, data: Uint8Array): Uint8Array {
	const chunk = new Uint8Array(12 + data.length);
	const view = new DataView(chunk.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) {
		chunk[4 + i] = type.charCodeAt(i);
	}
	chunk.set(data, 8);
	view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
	return chunk;
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
