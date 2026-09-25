/**
 * Shared binary helpers for io modules: CRC-32 checksum and
 * deflate compression/decompression via the Compression Streams API.
 */

// ---------------------------------------------------------------------------
// CRC-32 (ISO 3309 / ITU-T V.42 polynomial 0xEDB88320)
// ---------------------------------------------------------------------------

const CRC32_TABLE = /* @__PURE__ */ (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let j = 0; j < 8; j++) {
			c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
		}
		table[i] = c;
	}
	return table;
})();

export function crc32(data: Uint8Array): number {
	let crc = 0xffff_ffff;
	for (let i = 0; i < data.length; i++) {
		crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffff_ffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Deflate compression / decompression
// ---------------------------------------------------------------------------

export async function compressDeflate(data: Uint8Array): Promise<Uint8Array> {
	try {
		const cs = new CompressionStream("deflate");
		const writer = cs.writable.getWriter();
		const reader = cs.readable.getReader();

		const writePromise = writer
			.write(data as Uint8Array<ArrayBuffer>)
			.then(() => writer.close());

		const chunks: Uint8Array[] = [];
		let totalLength = 0;

		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			totalLength += value.byteLength;
		}

		await writePromise;

		const result = new Uint8Array(totalLength);
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return result;
	} catch (error) {
		throw new Error(
			`PAPF: deflate compression failed for ${data.byteLength} byte payload`,
			{ cause: error },
		);
	}
}

export async function decompressDeflate(data: Uint8Array): Promise<Uint8Array> {
	const ds = new DecompressionStream("deflate");
	const writer = ds.writable.getWriter();
	const reader = ds.readable.getReader();

	const writePromise = writer
		.write(data as Uint8Array<ArrayBuffer>)
		.then(() => writer.close());

	const chunks: Uint8Array[] = [];
	let totalLength = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		totalLength += value.byteLength;
	}

	await writePromise;

	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}
