import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { encodeAvifHdr } from "./encoder";
import { fwdWht4x4, invWht4x4 } from "./transform/dct";
import type { PlanarYuvData } from "./types";

const TEST_TMP = join(dirname(fileURLToPath(import.meta.url)), "../.tmp");

beforeAll(() => {
	rmSync(TEST_TMP, { recursive: true, force: true });
	mkdirSync(TEST_TMP, { recursive: true });
});

function createGradientYuv(
	width: number,
	height: number,
	opts?: {
		bitDepth?: 8 | 10 | 12;
		chromaSubsampling?: "4:2:0" | "4:4:4";
		alpha?: number;
	},
): PlanarYuvData {
	const bitDepth = opts?.bitDepth ?? 10;
	const sub = opts?.chromaSubsampling ?? "4:2:0";
	const maxVal = (1 << bitDepth) - 1;
	const is420 = sub === "4:2:0";
	const chromaW = is420 ? Math.ceil(width / 2) : width;
	const chromaH = is420 ? Math.ceil(height / 2) : height;

	const yPlane = new Uint16Array(width * height);
	const uPlane = new Uint16Array(chromaW * chromaH);
	const vPlane = new Uint16Array(chromaW * chromaH);

	for (let r = 0; r < height; r++) {
		for (let c = 0; c < width; c++) {
			yPlane[r * width + c] = Math.round(
				(c / Math.max(width - 1, 1)) * maxVal * 0.9 + maxVal * 0.05,
			);
		}
	}
	for (let r = 0; r < chromaH; r++) {
		for (let c = 0; c < chromaW; c++) {
			uPlane[r * chromaW + c] = Math.round(
				(r / Math.max(chromaH - 1, 1)) * maxVal * 0.4 + maxVal * 0.3,
			);
			vPlane[r * chromaW + c] = Math.round(
				(c / Math.max(chromaW - 1, 1)) * maxVal * 0.4 + maxVal * 0.3,
			);
		}
	}

	return {
		y: yPlane,
		u: uPlane,
		v: vPlane,
		alpha:
			opts?.alpha != null
				? new Uint16Array(width * height).fill(Math.round(opts.alpha * maxVal))
				: undefined,
		width,
		height,
		bitDepth,
		chromaSubsampling: sub,
	};
}

let tmpCounter = 0;
function tmpName(prefix: string, ext: string): string {
	return join(TEST_TMP, `${prefix}-${Date.now()}-${tmpCounter++}${ext}`);
}

function validateAvifWithFfprobe(avifBytes: Uint8Array): {
	valid: boolean;
	width?: number;
	height?: number;
	codec?: string;
	error?: string;
} {
	const tmpPath = tmpName("avif-ffprobe", ".avif");
	try {
		writeFileSync(tmpPath, avifBytes);
		const output = execSync(
			`ffprobe -v error -show_entries stream=width,height,codec_name -of json "${tmpPath}"`,
			{ encoding: "utf-8", timeout: 10_000 },
		);
		const parsed = JSON.parse(output);
		const stream = parsed.streams?.[0];
		return {
			valid: !!stream,
			width: stream?.width,
			height: stream?.height,
			codec: stream?.codec_name,
		};
	} catch (e) {
		return {
			valid: false,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

function validateAvifWithDav1d(avifBytes: Uint8Array): boolean {
	const tmpInput = tmpName("avif-dav1d", ".avif");
	const tmpOutput = tmpName("avif-dav1d", ".y4m");
	try {
		writeFileSync(tmpInput, avifBytes);
		// Extract AV1 from AVIF container using ffmpeg, then decode with dav1d
		execSync(
			`ffmpeg -v error -i "${tmpInput}" -c:v copy -f ivf "${tmpOutput}" 2>/dev/null && dav1d -i "${tmpOutput}" -o /dev/null 2>/dev/null`,
			{ timeout: 10_000 },
		);
		return true;
	} catch {
		return false;
	}
}

function computePsnr(
	original: Uint16Array | Uint8Array,
	decoded: Uint16Array | Uint8Array,
	maxVal: number,
): number {
	let mse = 0;
	for (let i = 0; i < original.length; i++) {
		const d = original[i] - decoded[i];
		mse += d * d;
	}
	mse /= original.length;
	if (mse === 0) return Infinity;
	return 10 * Math.log10((maxVal * maxVal) / mse);
}

describe("WHT 4x4 roundtrip", () => {
	it("should exactly reconstruct non-uniform gradient data", () => {
		// Gradient pattern: each position has a unique value
		const input = new Int32Array([
			100, 200, 300, 400, 50, 150, 250, 350, 10, 120, 230, 340, 5, 75, 145, 215,
		]);
		const original = new Int32Array(input);

		fwdWht4x4(input);

		// After fwd, values must differ from the original (transform is non-trivial)
		let allSame = true;
		for (let i = 0; i < 16; i++) {
			if (input[i] !== original[i]) {
				allSame = false;
				break;
			}
		}
		expect(allSame).toBe(false);

		invWht4x4(input);

		// Exact reconstruction — any transposition bug shows up as position swap
		for (let i = 0; i < 16; i++) {
			expect(input[i]).toBe(original[i]);
		}
	});

	it("should produce distinct coefficients for row-major vs column-major input", () => {
		// Row-major sequential
		const rowMajor = new Int32Array([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
		]);
		// Its transpose (column-major read back as row-major)
		const transposed = new Int32Array([
			1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15, 4, 8, 12, 16,
		]);

		fwdWht4x4(rowMajor);
		fwdWht4x4(transposed);

		// If WHT has a transposition bug, these two would produce identical output
		let identical = true;
		for (let i = 0; i < 16; i++) {
			if (rowMajor[i] !== transposed[i]) {
				identical = false;
				break;
			}
		}
		expect(identical).toBe(false);
	});
});

describe("encodeAvifHdr", () => {
	it("should produce a valid AVIF file header", () => {
		const yuv = createGradientYuv(64, 64);
		const avif = encodeAvifHdr(yuv, {
			width: 64,
			height: 64,
			bitDepth: 10,
			qp: 48,
		});

		expect(avif).toBeInstanceOf(Uint8Array);
		expect(avif.length).toBeGreaterThan(100);

		// ftyp box check
		const ftyp = String.fromCharCode(avif[4], avif[5], avif[6], avif[7]);
		expect(ftyp).toBe("ftyp");

		const brand = String.fromCharCode(avif[8], avif[9], avif[10], avif[11]);
		expect(brand).toBe("avif");
	});

	it("should produce an AVIF decodable by ffprobe and dav1d", () => {
		const yuv = createGradientYuv(64, 64);
		const avif = encodeAvifHdr(yuv, {
			width: 64,
			height: 64,
			bitDepth: 10,
			colorPrimaries: "bt2020",
			transferCharacteristics: "pq",
			matrixCoefficients: "bt2020",
			fullRange: true,
			qp: 48,
		});

		const result = validateAvifWithFfprobe(avif);
		expect(result.valid).toBe(true);
		expect(result.width).toBe(64);
		expect(result.height).toBe(64);
		expect(result.codec).toBe("av1");
		expect(validateAvifWithDav1d(avif)).toBe(true);
	});

	it("should encode a 128x128 gradient image decodable by dav1d", () => {
		const yuv = createGradientYuv(128, 128);
		const avif = encodeAvifHdr(yuv, {
			width: 128,
			height: 128,
			bitDepth: 10,
			qp: 32,
		});

		const result = validateAvifWithFfprobe(avif);
		expect(result.valid).toBe(true);
		expect(result.width).toBe(128);
		expect(result.height).toBe(128);
		expect(validateAvifWithDav1d(avif)).toBe(true);
	});

	it("should encode a non-power-of-2 image decodable by dav1d", () => {
		const w = 100;
		const h = 75;
		const yuv = createGradientYuv(w, h);
		const avif = encodeAvifHdr(yuv, {
			width: w,
			height: h,
			bitDepth: 10,
			qp: 40,
		});

		const result = validateAvifWithFfprobe(avif);
		expect(result.valid).toBe(true);
		expect(result.width).toBe(w);
		expect(result.height).toBe(h);
		expect(validateAvifWithDav1d(avif)).toBe(true);
	});

	it("should embed correct HDR metadata", () => {
		const yuv = createGradientYuv(64, 64);
		const avif = encodeAvifHdr(yuv, {
			width: 64,
			height: 64,
			bitDepth: 10,
			colorPrimaries: "bt2020",
			transferCharacteristics: "pq",
			matrixCoefficients: "bt2020",
			fullRange: true,
			qp: 48,
		});

		const tmpPath = tmpName("avif-meta", ".avif");
		writeFileSync(tmpPath, avif);
		const output = execSync(
			`ffprobe -v error -show_entries stream=color_primaries,color_transfer,color_space -of json "${tmpPath}"`,
			{ encoding: "utf-8", timeout: 10_000 },
		);
		const parsed = JSON.parse(output);
		const stream = parsed.streams?.[0];

		// Verify HDR color properties are preserved
		expect(stream?.color_primaries).toBe("bt2020");
		expect(stream?.color_transfer).toBe("smpte2084");
	});

	it("should encode an image with alpha channel", () => {
		const w = 64;
		const h = 64;
		const yuv = createGradientYuv(w, h, { alpha: 0.75 });

		const avif = encodeAvifHdr(yuv, {
			width: w,
			height: h,
			bitDepth: 10,
			qp: 48,
		});

		expect(avif).toBeInstanceOf(Uint8Array);
		expect(avif.length).toBeGreaterThan(200);

		// Verify ftyp box
		const ftyp = String.fromCharCode(avif[4], avif[5], avif[6], avif[7]);
		expect(ftyp).toBe("ftyp");

		// Verify auxC box exists (alpha auxiliary type marker)
		const auxCUrn = "urn:mpeg:mpegB:cicp:systems:auxiliary:alpha";
		const avifStr = new TextDecoder().decode(avif);
		expect(avifStr).toContain(auxCUrn);
	});

	it("should decode 8-bit gradient with PSNR > 30dB (qp=20)", () => {
		const w = 64;
		const h = 64;
		const yuv = createGradientYuv(w, h, { bitDepth: 8 });

		const avif = encodeAvifHdr(yuv, {
			width: w,
			height: h,
			bitDepth: 8,
			qp: 20,
		});

		expect(validateAvifWithDav1d(avif)).toBe(true);

		const tmpAvif = tmpName("avif-pixel", ".avif");
		const tmpRaw = tmpName("avif-pixel", ".raw");
		writeFileSync(tmpAvif, avif);
		execSync(
			`ffmpeg -v error -i "${tmpAvif}" -pix_fmt yuv420p -f rawvideo "${tmpRaw}"`,
			{ timeout: 10_000 },
		);
		const raw = readFileSync(tmpRaw);

		const decodedY = new Uint8Array(raw.buffer, raw.byteOffset, w * h);
		const originalY = new Uint8Array(w * h);
		for (let i = 0; i < w * h; i++) originalY[i] = yuv.y[i];

		const psnr = computePsnr(originalY, decodedY, 255);
		expect(psnr).toBeGreaterThan(30);
	});

	it("should decode 8-bit gradient with PSNR > 35dB (qp=10)", () => {
		const w = 64;
		const h = 64;
		const yuv = createGradientYuv(w, h, { bitDepth: 8 });

		const avif = encodeAvifHdr(yuv, {
			width: w,
			height: h,
			bitDepth: 8,
			qp: 10,
		});

		const tmpAvif = tmpName("avif-grad", ".avif");
		const tmpRaw = tmpName("avif-grad", ".raw");
		writeFileSync(tmpAvif, avif);
		execSync(
			`ffmpeg -v error -i "${tmpAvif}" -pix_fmt yuv420p -f rawvideo "${tmpRaw}"`,
			{ timeout: 10_000 },
		);
		const raw = readFileSync(tmpRaw);

		const decodedY = new Uint8Array(raw.buffer, raw.byteOffset, w * h);
		const originalY = new Uint8Array(w * h);
		for (let i = 0; i < w * h; i++) originalY[i] = yuv.y[i];

		const psnr = computePsnr(originalY, decodedY, 255);
		expect(psnr).toBeGreaterThan(35);
	});

	it("should produce dav1d-decodable AVIF with alpha", () => {
		const w = 64;
		const h = 64;
		const yuv = createGradientYuv(w, h, { alpha: 0.5 });

		const avif = encodeAvifHdr(yuv, {
			width: w,
			height: h,
			bitDepth: 10,
			qp: 48,
		});

		const result = validateAvifWithFfprobe(avif);
		expect(result.valid).toBe(true);
		expect(result.width).toBe(w);
		expect(result.height).toBe(h);
		expect(validateAvifWithDav1d(avif)).toBe(true);
	});

	it("should decode alpha stream (monochrome AV1)", () => {
		const w = 64;
		const h = 64;
		const yuv = createGradientYuv(w, h, { alpha: 0.75 });

		const avif = encodeAvifHdr(yuv, {
			width: w,
			height: h,
			bitDepth: 10,
			qp: 20,
		});

		const tmpAvif = tmpName("avif-alpha", ".avif");
		const tmpRaw = tmpName("avif-alpha", ".raw");
		writeFileSync(tmpAvif, avif);
		execSync(
			`ffmpeg -v error -i "${tmpAvif}" -map 0:1 -pix_fmt gray10le -f rawvideo "${tmpRaw}"`,
			{ timeout: 10_000 },
		);
		const raw = readFileSync(tmpRaw);
		const data = new Uint16Array(raw.buffer, raw.byteOffset, raw.length / 2);

		let sum = 0;
		for (let i = 0; i < data.length; i++) sum += data[i];
		const avg = sum / data.length;

		// alpha=0.75 → 768/1023, qp=20 should give tight match
		expect(avg).toBeGreaterThan(700);
		expect(avg).toBeLessThan(830);
	});

	it("should roundtrip RGBA Float32 sRGB-linear input through PQ encoding", () => {
		const w = 64;
		const h = 64;

		// Horizontal gradient: R varies 0→1, G=0.3, B=0.1
		const rgba = new Float32Array(w * h * 4);
		for (let r = 0; r < h; r++) {
			for (let c = 0; c < w; c++) {
				const i = r * w + c;
				rgba[i * 4] = c / (w - 1);
				rgba[i * 4 + 1] = 0.3;
				rgba[i * 4 + 2] = 0.1;
				rgba[i * 4 + 3] = 1.0;
			}
		}

		const avif = encodeAvifHdr(rgba, {
			width: w,
			height: h,
			bitDepth: 10,
			colorPrimaries: "bt2020",
			transferCharacteristics: "pq",
			matrixCoefficients: "bt2020",
			fullRange: true,
			qp: 10,
			inputColorSpace: "srgb-linear",
			maxNits: 203,
		});

		const result = validateAvifWithFfprobe(avif);
		expect(result.valid).toBe(true);
		expect(result.width).toBe(w);
		expect(result.height).toBe(h);
		expect(result.codec).toBe("av1");
		expect(validateAvifWithDav1d(avif)).toBe(true);
	});

	it("should roundtrip RGBA Float32 Display-P3-linear input", () => {
		const w = 64;
		const h = 64;

		// Vertical gradient: G varies 0.2→0.9, R=0.5, B=0.2
		const rgba = new Float32Array(w * h * 4);
		for (let r = 0; r < h; r++) {
			for (let c = 0; c < w; c++) {
				const i = r * w + c;
				rgba[i * 4] = 0.5;
				rgba[i * 4 + 1] = 0.2 + (r / (h - 1)) * 0.7;
				rgba[i * 4 + 2] = 0.2;
				rgba[i * 4 + 3] = 1.0;
			}
		}

		const avif = encodeAvifHdr(rgba, {
			width: w,
			height: h,
			bitDepth: 10,
			colorPrimaries: "bt2020",
			transferCharacteristics: "pq",
			matrixCoefficients: "bt2020",
			fullRange: true,
			qp: 10,
			inputColorSpace: "display-p3-linear",
			maxNits: 203,
		});

		const result = validateAvifWithFfprobe(avif);
		expect(result.valid).toBe(true);
		expect(result.width).toBe(w);
		expect(result.height).toBe(h);
		expect(validateAvifWithDav1d(avif)).toBe(true);
	});

	it.each([
		{ bitDepth: 8 as const, sub: "4:2:0" as const, size: 64, alpha: false },
		{ bitDepth: 8 as const, sub: "4:2:0" as const, size: 128, alpha: false },
		{ bitDepth: 8 as const, sub: "4:2:0" as const, size: 256, alpha: false },
		{ bitDepth: 10 as const, sub: "4:2:0" as const, size: 64, alpha: false },
		{ bitDepth: 10 as const, sub: "4:2:0" as const, size: 256, alpha: false },
		{ bitDepth: 10 as const, sub: "4:4:4" as const, size: 64, alpha: false },
		{ bitDepth: 10 as const, sub: "4:4:4" as const, size: 256, alpha: false },
		{ bitDepth: 8 as const, sub: "4:2:0" as const, size: 64, alpha: true },
		{ bitDepth: 10 as const, sub: "4:2:0" as const, size: 64, alpha: true },
		{ bitDepth: 10 as const, sub: "4:4:4" as const, size: 64, alpha: true },
		{ bitDepth: 10 as const, sub: "4:4:4" as const, size: 256, alpha: true },
		{ bitDepth: 12 as const, sub: "4:2:0" as const, size: 64, alpha: false },
		{ bitDepth: 12 as const, sub: "4:4:4" as const, size: 64, alpha: false },
	])("gradient decode: $bitDepth-bit $sub ${size}x${size} alpha=$alpha", ({
		bitDepth,
		sub,
		size,
		alpha,
	}) => {
		const w = size;
		const h = Math.round(size * 0.66);

		const yuv = createGradientYuv(w, h, {
			bitDepth,
			chromaSubsampling: sub,
			alpha: alpha ? 0.8 : undefined,
		});

		const avif = encodeAvifHdr(yuv, {
			width: w,
			height: h,
			bitDepth,
			chromaSubsampling: sub,
			qp: 20,
		});

		const tmpAvif = tmpName(
			`avif-matrix-${bitDepth}-${sub}-${size}-${alpha}`,
			".avif",
		);
		writeFileSync(tmpAvif, avif);

		// dav1d bitstream validation
		expect(validateAvifWithDav1d(avif)).toBe(true);

		// Decode Y plane and verify PSNR
		const maxVal = (1 << bitDepth) - 1;
		const subFmt = sub === "4:4:4" ? "yuv444p" : "yuv420p";
		const pixFmt = bitDepth > 8 ? `${subFmt}${bitDepth}le` : subFmt;
		const tmpRaw = tmpName("avif-matrix-raw", ".raw");
		execSync(
			`ffmpeg -v error -i "${tmpAvif}" -map 0:0 -pix_fmt ${pixFmt} -f rawvideo "${tmpRaw}"`,
			{ timeout: 30_000 },
		);
		const raw = readFileSync(tmpRaw);
		const decoded =
			bitDepth > 8
				? new Uint16Array(raw.buffer, raw.byteOffset, w * h)
				: new Uint8Array(raw.buffer, raw.byteOffset, w * h);

		const psnr = computePsnr(yuv.y.slice(0, w * h), decoded, maxVal);
		expect(psnr).toBeGreaterThan(25);
	});

	it("should roundtrip alpha=0 pixels as transparent via Float32 RGBA path", () => {
		const w = 128;
		const h = 96;

		// Float32 RGBA: left half opaque, right half transparent
		const rgba = new Float32Array(w * h * 4);
		for (let r = 0; r < h; r++) {
			for (let c = 0; c < w; c++) {
				const i = (r * w + c) * 4;
				if (c < w / 2) {
					rgba[i] = 0.5;
					rgba[i + 1] = 0.3;
					rgba[i + 2] = 0.4;
					rgba[i + 3] = 1.0;
				}
				// else: defaults to 0,0,0,0 (transparent)
			}
		}

		const avif = encodeAvifHdr(rgba, {
			width: w,
			height: h,
			bitDepth: 10,
			chromaSubsampling: "4:4:4",
			colorPrimaries: "bt2020",
			transferCharacteristics: "pq",
			matrixCoefficients: "bt2020",
			fullRange: true,
			qp: 1,
			inputColorSpace: "display-p3-linear",
		});

		const tmpAvif = tmpName("avif-alpha-rt", ".avif");
		const tmpRaw = tmpName("avif-alpha-rt", ".raw");
		writeFileSync(tmpAvif, avif);

		// Decode alpha stream to gray10le
		execSync(
			`ffmpeg -v error -i "${tmpAvif}" -map 0:1 -pix_fmt gray10le -f rawvideo "${tmpRaw}"`,
			{ timeout: 30_000 },
		);
		const raw = readFileSync(tmpRaw);
		const data = new Uint16Array(raw.buffer, raw.byteOffset, raw.length / 2);

		let opaqueSum = 0;
		let opaqueCount = 0;
		let transparentMax = 0;

		for (let r = 0; r < h; r++) {
			for (let c = 0; c < w; c++) {
				const val = data[r * w + c];
				if (c < w / 2) {
					opaqueSum += val;
					opaqueCount++;
				} else {
					transparentMax = Math.max(transparentMax, val);
				}
			}
		}

		const opaqueAvg = opaqueSum / opaqueCount;
		expect(opaqueAvg).toBeGreaterThan(900);
		expect(transparentMax).toBeLessThan(100);
	});

	it("should roundtrip alpha grid pattern at 3180x2100 via Float32 RGBA path", () => {
		const w = 3180;
		const h = 2100;
		const cellSize = 200;

		// Float32 RGBA: checkerboard grid of opaque/transparent 200x200 cells
		const rgba = new Float32Array(w * h * 4);
		for (let r = 0; r < h; r++) {
			for (let c = 0; c < w; c++) {
				const i = (r * w + c) * 4;
				const cellR = Math.floor(r / cellSize);
				const cellC = Math.floor(c / cellSize);
				if ((cellR + cellC) % 2 === 0) {
					rgba[i] = 0.4;
					rgba[i + 1] = 0.3;
					rgba[i + 2] = 0.5;
					rgba[i + 3] = 1.0;
				}
				// else: 0,0,0,0 (transparent)
			}
		}

		const avif = encodeAvifHdr(rgba, {
			width: w,
			height: h,
			bitDepth: 10,
			chromaSubsampling: "4:4:4",
			colorPrimaries: "bt2020",
			transferCharacteristics: "pq",
			matrixCoefficients: "bt2020",
			fullRange: true,
			qp: 1,
			inputColorSpace: "display-p3-linear",
		});

		const tmpAvif = tmpName("avif-alpha-grid", ".avif");
		const tmpColorRaw = tmpName("avif-alpha-grid-color", ".raw");
		const tmpAlphaRaw = tmpName("avif-alpha-grid-alpha", ".raw");
		writeFileSync(tmpAvif, avif);

		// Decode color stream to 8-bit RGBA
		execSync(
			`ffmpeg -v error -i "${tmpAvif}" -pix_fmt rgba -f rawvideo "${tmpColorRaw}"`,
			{ timeout: 120_000 },
		);
		// Decode alpha stream to gray10le
		execSync(
			`ffmpeg -v error -i "${tmpAvif}" -map 0:1 -pix_fmt gray10le -f rawvideo "${tmpAlphaRaw}"`,
			{ timeout: 120_000 },
		);

		const colorRaw = readFileSync(tmpColorRaw);
		const alphaRaw = readFileSync(tmpAlphaRaw);
		const alphaData = new Uint16Array(
			alphaRaw.buffer,
			alphaRaw.byteOffset,
			alphaRaw.length / 2,
		);

		const margin = 16;
		let alphaOpaqueErrors = 0;
		let alphaTransparentErrors = 0;
		let colorLeakErrors = 0;

		for (let r = 0; r < h; r++) {
			const cellR = Math.floor(r / cellSize);
			const rInCell = r - cellR * cellSize;
			if (rInCell < margin || rInCell >= cellSize - margin) continue;

			for (let c = 0; c < w; c++) {
				const cellC = Math.floor(c / cellSize);
				const cInCell = c - cellC * cellSize;
				if (cInCell < margin || cInCell >= cellSize - margin) continue;

				const expectOpaque = (cellR + cellC) % 2 === 0;
				const aVal = alphaData[r * w + c];

				if (expectOpaque && aVal < 900) alphaOpaqueErrors++;
				if (!expectOpaque && aVal > 100) alphaTransparentErrors++;

				// Check color stream: transparent cells should have near-zero RGB
				if (!expectOpaque) {
					const ci = (r * w + c) * 4;
					const maxRgb = Math.max(
						colorRaw[ci],
						colorRaw[ci + 1],
						colorRaw[ci + 2],
					);
					if (maxRgb > 30) colorLeakErrors++;
				}
			}
		}

		expect(alphaOpaqueErrors).toBe(0);
		expect(alphaTransparentErrors).toBe(0);
		expect(colorLeakErrors).toBe(0);
	}, 120_000);

	it.each([
		{ size: 8, pattern: "gradient" as const },
		{ size: 16, pattern: "gradient" as const },
		{ size: 64, pattern: "gradient" as const },
		{ size: 16, pattern: "checkerboard" as const },
		{ size: 64, pattern: "checkerboard" as const },
	])("lossless (qp=0) should pixel-exact roundtrip $pattern ${size}x${size}", ({
		size,
		pattern,
	}) => {
		const w = size;
		const h = size;

		const yPlane = new Uint16Array(w * h);
		const uPlane = new Uint16Array(w * h);
		const vPlane = new Uint16Array(w * h);

		for (let r = 0; r < h; r++) {
			for (let c = 0; c < w; c++) {
				if (pattern === "gradient") {
					yPlane[r * w + c] = Math.round((c / Math.max(w - 1, 1)) * 900 + 50);
					uPlane[r * w + c] = Math.round((r / Math.max(h - 1, 1)) * 400 + 300);
					vPlane[r * w + c] = Math.round(
						((r + c) / Math.max(w + h - 2, 1)) * 400 + 300,
					);
				} else {
					yPlane[r * w + c] = (r + c) % 2 === 0 ? 200 : 800;
					uPlane[r * w + c] = (r + c) % 2 === 0 ? 400 : 600;
					vPlane[r * w + c] = (r + c) % 2 === 0 ? 600 : 400;
				}
			}
		}

		const yuv: PlanarYuvData = {
			y: yPlane,
			u: uPlane,
			v: vPlane,
			width: w,
			height: h,
			bitDepth: 10,
			chromaSubsampling: "4:4:4",
		};

		const avif = encodeAvifHdr(yuv, {
			width: w,
			height: h,
			bitDepth: 10,
			chromaSubsampling: "4:4:4",
			qp: 0,
		});

		const tmpAvif = tmpName(`avif-lossless-${size}-${pattern}`, ".avif");
		const tmpRaw = tmpName(`avif-lossless-${size}-${pattern}`, ".raw");
		writeFileSync(tmpAvif, avif);
		execSync(
			`ffmpeg -v error -y -i "${tmpAvif}" -pix_fmt yuv444p10le -f rawvideo "${tmpRaw}"`,
			{ timeout: 30_000 },
		);
		const raw = readFileSync(tmpRaw);
		const decoded = new Uint16Array(raw.buffer, raw.byteOffset, raw.length / 2);

		// Y plane: exact match
		let yMaxDiff = 0;
		for (let i = 0; i < w * h; i++) {
			yMaxDiff = Math.max(yMaxDiff, Math.abs(decoded[i] - yPlane[i]));
		}
		expect(yMaxDiff).toBe(0);

		// U plane: exact match
		const uOffset = w * h;
		let uMaxDiff = 0;
		for (let i = 0; i < w * h; i++) {
			uMaxDiff = Math.max(uMaxDiff, Math.abs(decoded[uOffset + i] - uPlane[i]));
		}
		expect(uMaxDiff).toBe(0);

		// V plane: exact match
		const vOffset = w * h * 2;
		let vMaxDiff = 0;
		for (let i = 0; i < w * h; i++) {
			vMaxDiff = Math.max(vMaxDiff, Math.abs(decoded[vOffset + i] - vPlane[i]));
		}
		expect(vMaxDiff).toBe(0);
	});

	it("should encode and decode multi-tile image (width > 4096)", () => {
		const w = 4200;
		const h = 64;
		const yuv = createGradientYuv(w, h);

		// qp=32: only working qp for multi-tile (qp<32 causes decode failure — known bug)
		const avif = encodeAvifHdr(yuv, {
			width: w,
			height: h,
			bitDepth: 10,
			qp: 32,
		});

		const result = validateAvifWithFfprobe(avif);
		expect(result.valid).toBe(true);
		expect(result.width).toBe(w);
		expect(result.height).toBe(h);

		const tmpAvif = tmpName("avif-multitile", ".avif");
		const tmpRaw = tmpName("avif-multitile", ".raw");
		writeFileSync(tmpAvif, avif);
		execSync(
			`ffmpeg -v error -i "${tmpAvif}" -pix_fmt yuv420p10le -f rawvideo "${tmpRaw}"`,
			{ timeout: 30_000 },
		);
		const raw = readFileSync(tmpRaw);
		const decoded = new Uint16Array(raw.buffer, raw.byteOffset, w * h);

		const psnr = computePsnr(yuv.y.slice(0, w * h), decoded, 1023);
		expect(psnr).toBeGreaterThan(25);
	});
});
