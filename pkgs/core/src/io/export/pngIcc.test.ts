import { describe, expect, it } from "vitest";
import { crc32, decompressDeflate } from "../binaryUtils";
import { embedIccProfileInPng, sanitizeIccProfileName } from "./pngIcc";

describe("embedIccProfileInPng", () => {
	const profile = Uint8Array.from({ length: 200 }, (_, i) => (i * 31) % 256);

	it("should throw when the PNG signature is invalid", async () => {
		const broken = buildMinimalPng();
		broken[0] = 0x00;

		await expect(
			embedIccProfileInPng(broken, profile, "test-profile"),
		).rejects.toThrow("signature");
	});

	it("should insert an iCCP chunk immediately after IHDR", async () => {
		const result = await embedIccProfileInPng(
			buildMinimalPng(),
			profile,
			"test-profile",
		);

		const types = parsePngChunks(result).map((chunk) => chunk.type);
		expect(types).toEqual(["IHDR", "iCCP", "IDAT", "IEND"]);
	});

	it("should remove existing sRGB, gAMA, cHRM and iCCP chunks", async () => {
		const result = await embedIccProfileInPng(
			buildPngWithColorChunks(),
			profile,
			"test-profile",
		);

		const types = parsePngChunks(result).map((chunk) => chunk.type);
		expect(types).toEqual(["IHDR", "iCCP", "IDAT", "IEND"]);
	});

	it("should write a valid CRC for every chunk", async () => {
		const result = await embedIccProfileInPng(
			buildPngWithColorChunks(),
			profile,
			"test-profile",
		);

		for (const chunk of parsePngChunks(result)) {
			expect(chunk.storedCrc).toBe(chunk.computedCrc);
		}
	});

	it("should embed the profile so it can be restored by zlib decompression", async () => {
		const result = await embedIccProfileInPng(
			buildMinimalPng(),
			profile,
			"test-profile",
		);

		const iccp = parsePngChunks(result).find((chunk) => chunk.type === "iCCP");
		expect(iccp).toBeDefined();
		if (!iccp) return;

		const separatorIndex = iccp.data.indexOf(0x00);
		const name = String.fromCharCode(...iccp.data.subarray(0, separatorIndex));
		expect(name).toBe("test-profile");
		// Compression method byte must be 0 (deflate)
		expect(iccp.data[separatorIndex + 1]).toBe(0x00);

		const restored = await decompressDeflate(
			iccp.data.subarray(separatorIndex + 2),
		);
		expect(restored).toEqual(profile);
	});

	it("should reject profile names outside 1-79 printable Latin-1 bytes", async () => {
		await expect(
			embedIccProfileInPng(buildMinimalPng(), profile, ""),
		).rejects.toThrow("1-79");
		await expect(
			embedIccProfileInPng(buildMinimalPng(), profile, "a".repeat(80)),
		).rejects.toThrow("1-79");
		await expect(
			embedIccProfileInPng(buildMinimalPng(), profile, "name\nwith\ncontrol"),
		).rejects.toThrow("printable");
	});
});

describe("sanitizeIccProfileName", () => {
	const profile = Uint8Array.from({ length: 8 }, (_, i) => i);

	it("should truncate names longer than 79 bytes", () => {
		const result = sanitizeIccProfileName("a".repeat(100));
		expect(result).toBe("a".repeat(79));
	});

	it("should strip non-Latin-1 characters such as Japanese", () => {
		const result = sanitizeIccProfileName("プロファイルProfile名");
		expect(result).toBe("Profile");
	});

	it("should fall back to 'ICC Profile' when nothing usable remains", () => {
		expect(sanitizeIccProfileName("日本語のみ")).toBe("ICC Profile");
		expect(sanitizeIccProfileName("   ")).toBe("ICC Profile");
	});

	it("should pass through a valid name unchanged", () => {
		expect(sanitizeIccProfileName("Display P3")).toBe("Display P3");
	});

	it("should produce a name that encodeProfileName accepts", async () => {
		const cases = [
			"a".repeat(100),
			"プロファイルProfile名",
			"日本語のみ",
			"  Display P3  ",
		];
		for (const name of cases) {
			await expect(
				embedIccProfileInPng(
					buildMinimalPng(),
					profile,
					sanitizeIccProfileName(name),
				),
			).resolves.toBeInstanceOf(Uint8Array);
		}
	});
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** IHDR data: 1x1, 8-bit, RGBA, deflate, adaptive filter, no interlace. */
const IHDR_DATA = [
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
];

function buildMinimalPng(): Uint8Array {
	return concatBytes([
		new Uint8Array(PNG_SIGNATURE),
		buildChunk("IHDR", new Uint8Array(IHDR_DATA)),
		buildChunk("IDAT", new Uint8Array([0x78, 0x9c, 0x01, 0x02, 0x03])),
		buildChunk("IEND", new Uint8Array(0)),
	]);
}

function buildPngWithColorChunks(): Uint8Array {
	return concatBytes([
		new Uint8Array(PNG_SIGNATURE),
		buildChunk("IHDR", new Uint8Array(IHDR_DATA)),
		buildChunk("gAMA", new Uint8Array([0x00, 0x00, 0xb1, 0x8f])),
		buildChunk("cHRM", new Uint8Array(32)),
		buildChunk("sRGB", new Uint8Array([0x00])),
		buildChunk("iCCP", new Uint8Array([0x6f, 0x6c, 0x64, 0x00, 0x00, 0x01])),
		buildChunk("IDAT", new Uint8Array([0x78, 0x9c, 0x01, 0x02, 0x03])),
		buildChunk("IEND", new Uint8Array(0)),
	]);
}

function buildChunk(type: string, data: Uint8Array): Uint8Array {
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

function parsePngChunks(png: Uint8Array): {
	type: string;
	data: Uint8Array;
	storedCrc: number;
	computedCrc: number;
}[] {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	const chunks: {
		type: string;
		data: Uint8Array;
		storedCrc: number;
		computedCrc: number;
	}[] = [];
	let offset = PNG_SIGNATURE.length;

	while (offset < png.length) {
		const length = view.getUint32(offset);
		const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
		const data = png.subarray(offset + 8, offset + 8 + length);
		chunks.push({
			type,
			data,
			storedCrc: view.getUint32(offset + 8 + length),
			computedCrc: crc32(png.subarray(offset + 4, offset + 8 + length)),
		});
		offset += 12 + length;
	}

	return chunks;
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
