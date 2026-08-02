import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSoftProofLut, convertImageToCmyk } from "./ColorEngine";
import { inspectIccProfile } from "./IccProfileRegistry";

const ICC_ASSET_DIR = resolve(__dirname, "../../../public/assets/icc");
const srgbProfileBytes = readIccAsset("sRGB-v4.icc");
const displayP3ProfileBytes = readIccAsset("DisplayP3Compat-v4.icc");

describe("inspectIccProfile", () => {
	it("should report rgb for the bundled sRGB profile", () => {
		expect(inspectIccProfile(srgbProfileBytes)).toEqual({ colorSpace: "rgb" });
	});

	it("should report rgb for the bundled Display P3 profile", () => {
		expect(inspectIccProfile(displayP3ProfileBytes)).toEqual({
			colorSpace: "rgb",
		});
	});

	it("should report cmyk for a CMYK profile", () => {
		expect(inspectIccProfile(buildTestCmykProfileBytes())).toEqual({
			colorSpace: "cmyk",
		});
	});

	it("should return null for bytes without the acsp signature", () => {
		expect(inspectIccProfile(new Uint8Array(256))).toBeNull();
	});

	it("should return null for data shorter than an ICC header", () => {
		expect(inspectIccProfile(srgbProfileBytes.slice(0, 64))).toBeNull();
	});
});

describe("buildSoftProofLut", () => {
	it("should produce a size^3 RGBA LUT with opaque alpha", async () => {
		const lut = await buildSoftProofLut({
			displaySpace: "srgb",
			proofProfileBytes: buildTestCmykProfileBytes(),
			intent: "relative-colorimetric",
			displayProfileBytes: srgbProfileBytes,
		});

		expect(lut.size).toBe(33);
		expect(lut.data.length).toBe(33 ** 3 * 4);
		for (let i = 3; i < lut.data.length; i += 4) {
			if (lut.data[i] !== 255) {
				throw new Error(`alpha at byte ${i} is ${lut.data[i]}, expected 255`);
			}
		}
	});

	it("should keep the grey axis monotonic", async () => {
		const lut = await buildSoftProofLut({
			displaySpace: "srgb",
			proofProfileBytes: buildTestCmykProfileBytes(),
			intent: "relative-colorimetric",
			displayProfileBytes: srgbProfileBytes,
		});

		let previous = -1;
		for (let i = 0; i < lut.size; i++) {
			const idx = ((i * lut.size + i) * lut.size + i) * 4;
			const green = lut.data[idx + 1];
			expect(green).toBeGreaterThanOrEqual(previous);
			previous = green;
		}
	});

	it("should gamut-compress pure cyan", async () => {
		const lut = await buildSoftProofLut({
			displaySpace: "srgb",
			proofProfileBytes: buildTestCmykProfileBytes(),
			intent: "relative-colorimetric",
			displayProfileBytes: srgbProfileBytes,
		});

		// Grid entry for input rgb(0, 255, 255): r=0, g=max, b=max.
		const max = lut.size - 1;
		const idx = ((max * lut.size + max) * lut.size + 0) * 4;
		const proofed = [lut.data[idx], lut.data[idx + 1], lut.data[idx + 2]];

		const maxChannelDelta = Math.max(
			Math.abs(proofed[0] - 0),
			Math.abs(proofed[1] - 255),
			Math.abs(proofed[2] - 255),
		);
		expect(maxChannelDelta).toBeGreaterThanOrEqual(8);
	});

	it("should return the cached result for identical inputs", async () => {
		const opts = {
			displaySpace: "srgb",
			proofProfileBytes: buildTestCmykProfileBytes(),
			intent: "relative-colorimetric",
			displayProfileBytes: srgbProfileBytes,
		} as const;

		const first = await buildSoftProofLut(opts);
		const second = await buildSoftProofLut(opts);
		expect(second).toBe(first);
	});

	it("should reject a CMYK profile that has no PCS-to-device table", async () => {
		// A profile shipping only an A2B0 (CMYK -> Lab) table cannot convert
		// colors INTO CMYK, so soft proofing must reject it.
		await expect(
			buildSoftProofLut({
				displaySpace: "srgb",
				proofProfileBytes: buildA2BOnlyCmykProfileBytes(),
				intent: "relative-colorimetric",
				displayProfileBytes: srgbProfileBytes,
			}),
		).rejects.toThrow(/B2A/);
	});
});

describe("convertImageToCmyk", () => {
	it("should map white to near-zero ink (paper white)", async () => {
		const cmyk = await convertImageToCmyk(
			new Uint8ClampedArray([255, 255, 255, 255]),
			{
				srcSpace: "srgb",
				profileBytes: buildTestCmykProfileBytes(),
				intent: "relative-colorimetric",
				srcProfileBytes: srgbProfileBytes,
			},
		);

		expect(cmyk.length).toBe(4);
		for (const channel of cmyk) {
			expect(channel).toBeLessThanOrEqual(10);
		}
	});

	it("should map black to heavy black ink", async () => {
		const cmyk = await convertImageToCmyk(
			new Uint8ClampedArray([0, 0, 0, 255]),
			{
				srcSpace: "srgb",
				profileBytes: buildTestCmykProfileBytes(),
				intent: "relative-colorimetric",
				srcProfileBytes: srgbProfileBytes,
			},
		);

		const [c, m, y, k] = cmyk;
		expect(k).toBeGreaterThanOrEqual(200);
		expect(c).toBeLessThanOrEqual(30);
		expect(m).toBeLessThanOrEqual(30);
		expect(y).toBeLessThanOrEqual(30);
	});

	it("should return pixelCount * 4 bytes as Uint8Array", async () => {
		const pixels = new Uint8ClampedArray([
			255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
		]);
		const cmyk = await convertImageToCmyk(pixels, {
			srcSpace: "srgb",
			profileBytes: buildTestCmykProfileBytes(),
			intent: "perceptual",
			srcProfileBytes: srgbProfileBytes,
		});

		expect(cmyk).toBeInstanceOf(Uint8Array);
		expect(cmyk.length).toBe(3 * 4);
	});

	it("should convert from a Display P3 source", async () => {
		const cmyk = await convertImageToCmyk(
			new Uint8ClampedArray([255, 255, 255, 255]),
			{
				srcSpace: "display-p3",
				profileBytes: buildTestCmykProfileBytes(),
				intent: "relative-colorimetric",
				srcProfileBytes: displayP3ProfileBytes,
			},
		);

		expect(cmyk.length).toBe(4);
		for (const channel of cmyk) {
			expect(channel).toBeLessThanOrEqual(10);
		}
	});
});

// ============================================================================
// Test fixture: synthetic ICC v2 CMYK output profile
// ============================================================================
// No CMYK profile is bundled, so the roundtrip tests use this synthetic ICC v2
// profile of a "toy press" with both A2B0 and B2A0 mft2 tables. Per CMY
// channel, with full black replacement (K = 1 - max coverage):
//
//   linearChannel = INK_FLOOR + INK_RANGE * (1 - ink) * (1 - K)
//
// Paper white (0.9 linear) sits below display white and ink black (0.05
// linear) above display black, so out-of-gamut colors visibly compress.

const INK_FLOOR = 0.05;
const INK_RANGE = 0.85;
const A2B_GRID_POINTS = 9;
const B2A_GRID_POINTS = 17;

let testCmykProfileBytes: Uint8Array | null = null;

function buildTestCmykProfileBytes(): Uint8Array {
	if (testCmykProfileBytes) return testCmykProfileBytes;

	// Perceptual and colorimetric intents share the same table data (ICC
	// permits tag sharing); jscolorengine's black point compensation always
	// reads the relative (A2B1/B2A1) slots, so both must be present.
	const a2bData = buildMft2Tag(4, 3, A2B_GRID_POINTS, buildCmykToLabClut());
	const b2aData = buildMft2Tag(3, 4, B2A_GRID_POINTS, buildLabToCmykClut());
	testCmykProfileBytes = assembleIccProfile([
		{ signature: "desc", data: buildDescTag("Paplico Test CMYK (toy press)") },
		{ signature: "wtpt", data: buildXyzTag(0.9642, 1.0, 0.8249) },
		{ signature: "cprt", data: buildTextTag("CC0") },
		{ signature: "A2B0", data: a2bData },
		{ signature: "A2B1", data: a2bData },
		{ signature: "B2A0", data: b2aData },
		{ signature: "B2A1", data: b2aData },
	]);
	return testCmykProfileBytes;
}

/**
 * A CMYK profile shipping only A2B0/A2B1 (CMYK -> Lab) tables. Like profiles
 * that can be inverted for proofing but not used as a destination, it has no
 * PCS-to-device (B2A) table, so soft proofing must reject it.
 */
function buildA2BOnlyCmykProfileBytes(): Uint8Array {
	const a2bData = buildMft2Tag(4, 3, A2B_GRID_POINTS, buildCmykToLabClut());
	return assembleIccProfile([
		{ signature: "desc", data: buildDescTag("Paplico Test CMYK (A2B only)") },
		{ signature: "wtpt", data: buildXyzTag(0.9642, 1.0, 0.8249) },
		{ signature: "cprt", data: buildTextTag("CC0") },
		{ signature: "A2B0", data: a2bData },
		{ signature: "A2B1", data: a2bData },
	]);
}

/** CMYK -> Lab CLUT (A2B0). First input channel (C) varies slowest. */
function buildCmykToLabClut(): Uint16Array {
	const n = A2B_GRID_POINTS;
	const clut = new Uint16Array(n ** 4 * 3);
	let pos = 0;
	for (let ci = 0; ci < n; ci++) {
		for (let mi = 0; mi < n; mi++) {
			for (let yi = 0; yi < n; yi++) {
				for (let ki = 0; ki < n; ki++) {
					const k = ki / (n - 1);
					const rgb = [ci, mi, yi].map(
						(ink) => INK_FLOOR + INK_RANGE * (1 - ink / (n - 1)) * (1 - k),
					);
					const [labL, labA, labB] = linearRgbToLabD50(rgb[0], rgb[1], rgb[2]);
					clut[pos++] = encodeLabL16(labL);
					clut[pos++] = encodeLabAb16(labA);
					clut[pos++] = encodeLabAb16(labB);
				}
			}
		}
	}
	return clut;
}

/** Lab -> CMYK CLUT (B2A0). First input channel (L) varies slowest. */
function buildLabToCmykClut(): Uint16Array {
	const n = B2A_GRID_POINTS;
	const clut = new Uint16Array(n ** 3 * 4);
	let pos = 0;
	for (let li = 0; li < n; li++) {
		for (let ai = 0; ai < n; ai++) {
			for (let bi = 0; bi < n; bi++) {
				const labL = decodeLabL16((li / (n - 1)) * 65535);
				const labA = decodeLabAb16((ai / (n - 1)) * 65535);
				const labB = decodeLabAb16((bi / (n - 1)) * 65535);
				const rgb = labD50ToLinearRgb(labL, labA, labB);
				const coverage = rgb.map((v) =>
					Math.min(1, Math.max(0, (v - INK_FLOOR) / INK_RANGE)),
				);
				const maxCoverage = Math.max(...coverage);
				const k = 1 - maxCoverage;
				const cmy =
					maxCoverage <= 0
						? [0, 0, 0]
						: coverage.map((t) => 1 - t / maxCoverage);
				clut[pos++] = encodeDevice16(cmy[0]);
				clut[pos++] = encodeDevice16(cmy[1]);
				clut[pos++] = encodeDevice16(cmy[2]);
				clut[pos++] = encodeDevice16(k);
			}
		}
	}
	return clut;
}

// --- ICC v2 binary writers --------------------------------------------------

function assembleIccProfile(
	tags: { signature: string; data: Uint8Array }[],
): Uint8Array {
	const HEADER_SIZE = 128;
	const tableSize = 4 + tags.length * 12;
	let offset = align4(HEADER_SIZE + tableSize);
	// Tags passing the same Uint8Array share one data block (ICC tag sharing).
	const dataOffsets = new Map<Uint8Array, number>();
	const placed = tags.map((tag) => {
		let dataOffset = dataOffsets.get(tag.data);
		if (dataOffset === undefined) {
			dataOffset = offset;
			dataOffsets.set(tag.data, dataOffset);
			offset = align4(offset + tag.data.length);
		}
		return { ...tag, offset: dataOffset };
	});

	const bytes = new Uint8Array(offset);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, bytes.length);
	view.setUint32(8, 0x02100000); // ICC version 2.1
	writeSignature(bytes, 12, "prtr");
	writeSignature(bytes, 16, "CMYK");
	writeSignature(bytes, 20, "Lab ");
	writeSignature(bytes, 36, "acsp");
	// PCS illuminant: D50
	view.setInt32(68, toS15Fixed16(0.9642));
	view.setInt32(72, toS15Fixed16(1.0));
	view.setInt32(76, toS15Fixed16(0.8249));

	view.setUint32(HEADER_SIZE, tags.length);
	placed.forEach((entry, i) => {
		const tableOffset = HEADER_SIZE + 4 + i * 12;
		writeSignature(bytes, tableOffset, entry.signature);
		view.setUint32(tableOffset + 4, entry.offset);
		view.setUint32(tableOffset + 8, entry.data.length);
		bytes.set(entry.data, entry.offset);
	});
	return bytes;
}

/** lut16Type with identity matrix and identity 2-entry input/output curves. */
function buildMft2Tag(
	inputChannels: number,
	outputChannels: number,
	gridPoints: number,
	clut: Uint16Array,
): Uint8Array {
	const TABLE_ENTRIES = 2;
	const bytes = new Uint8Array(
		52 + (inputChannels + outputChannels) * TABLE_ENTRIES * 2 + clut.length * 2,
	);
	const view = new DataView(bytes.buffer);
	writeSignature(bytes, 0, "mft2");
	bytes[8] = inputChannels;
	bytes[9] = outputChannels;
	bytes[10] = gridPoints;
	view.setInt32(12, toS15Fixed16(1));
	view.setInt32(28, toS15Fixed16(1));
	view.setInt32(44, toS15Fixed16(1));
	view.setUint16(48, TABLE_ENTRIES);
	view.setUint16(50, TABLE_ENTRIES);

	let offset = 52;
	for (let ch = 0; ch < inputChannels; ch++) {
		view.setUint16(offset + 2, 0xffff);
		offset += 4;
	}
	for (const value of clut) {
		view.setUint16(offset, value);
		offset += 2;
	}
	for (let ch = 0; ch < outputChannels; ch++) {
		view.setUint16(offset + 2, 0xffff);
		offset += 4;
	}
	return bytes;
}

function buildDescTag(text: string): Uint8Array {
	// textDescriptionType: ascii block + empty unicode/scriptcode blocks.
	const ascii = `${text}\0`;
	const bytes = new Uint8Array(12 + ascii.length + 78);
	writeSignature(bytes, 0, "desc");
	new DataView(bytes.buffer).setUint32(8, ascii.length);
	for (let i = 0; i < ascii.length; i++) bytes[12 + i] = ascii.charCodeAt(i);
	return bytes;
}

function buildTextTag(text: string): Uint8Array {
	const ascii = `${text}\0`;
	const bytes = new Uint8Array(8 + ascii.length);
	writeSignature(bytes, 0, "text");
	for (let i = 0; i < ascii.length; i++) bytes[8 + i] = ascii.charCodeAt(i);
	return bytes;
}

function buildXyzTag(x: number, y: number, z: number): Uint8Array {
	const bytes = new Uint8Array(20);
	const view = new DataView(bytes.buffer);
	writeSignature(bytes, 0, "XYZ ");
	view.setInt32(8, toS15Fixed16(x));
	view.setInt32(12, toS15Fixed16(y));
	view.setInt32(16, toS15Fixed16(z));
	return bytes;
}

function writeSignature(bytes: Uint8Array, offset: number, sig: string): void {
	for (let i = 0; i < 4; i++) bytes[offset + i] = sig.charCodeAt(i);
}

function toS15Fixed16(value: number): number {
	return Math.round(value * 65536);
}

function align4(value: number): number {
	return Math.ceil(value / 4) * 4;
}

// --- Color math (D50) -------------------------------------------------------

const D50_WHITE = { x: 0.96422, y: 1.0, z: 0.82521 };

function linearRgbToLabD50(
	r: number,
	g: number,
	b: number,
): [number, number, number] {
	// Linear sRGB -> XYZ D50 (Bradford-adapted)
	const x = 0.4360747 * r + 0.3850649 * g + 0.1430804 * b;
	const y = 0.2225045 * r + 0.7168786 * g + 0.0606169 * b;
	const z = 0.0139322 * r + 0.0971045 * g + 0.7141733 * b;
	const fx = labForward(x / D50_WHITE.x);
	const fy = labForward(y / D50_WHITE.y);
	const fz = labForward(z / D50_WHITE.z);
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labD50ToLinearRgb(
	labL: number,
	labA: number,
	labB: number,
): [number, number, number] {
	const fy = (labL + 16) / 116;
	const fx = fy + labA / 500;
	const fz = fy - labB / 200;
	const x = labInverse(fx) * D50_WHITE.x;
	const y = labInverse(fy) * D50_WHITE.y;
	const z = labInverse(fz) * D50_WHITE.z;
	// XYZ D50 -> linear sRGB (Bradford-adapted)
	return [
		3.1338561 * x - 1.6168667 * y - 0.4906146 * z,
		-0.9787684 * x + 1.9161415 * y + 0.033454 * z,
		0.0719453 * x - 0.2289914 * y + 1.4052427 * z,
	];
}

function labForward(t: number): number {
	const DELTA = 6 / 29;
	return t > DELTA ** 3 ? Math.cbrt(t) : t / (3 * DELTA ** 2) + 4 / 29;
}

function labInverse(t: number): number {
	const DELTA = 6 / 29;
	return t > DELTA ? t ** 3 : 3 * DELTA ** 2 * (t - 4 / 29);
}

// --- ICC v2 16-bit PCS Lab / device encodings -------------------------------

function encodeLabL16(labL: number): number {
	return clampU16(Math.round(labL * 652.8));
}

function encodeLabAb16(ab: number): number {
	return clampU16(Math.round((ab + 128) * 256));
}

function decodeLabL16(value: number): number {
	return value / 652.8;
}

function decodeLabAb16(value: number): number {
	return value / 256 - 128;
}

function encodeDevice16(value: number): number {
	return clampU16(Math.round(value * 65535));
}

function clampU16(value: number): number {
	return Math.min(65535, Math.max(0, value));
}

function readIccAsset(fileName: string): Uint8Array {
	return new Uint8Array(readFileSync(resolve(ICC_ASSET_DIR, fileName)));
}
