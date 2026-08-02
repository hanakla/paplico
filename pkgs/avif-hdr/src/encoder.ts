// Top-level AVIF HDR encoder orchestrator.
// Coordinates all three encoding layers: AV1 low-level → OBU framing → ISOBMFF container.

import {
	createModeInfo,
	encodeCoeffs,
	type ModeInfo,
} from "./coding/coefficients";
import { EntropyWriter } from "./coding/range-coder";
import { encodeBlockModes, encodePartition } from "./coding/symbols";
import { packAvif } from "./container/isobmff";
import { computeTileLayout, generateFrameHeader } from "./obu/frame";
import { packObus } from "./obu/obu-writer";
import { generateSequenceHeader } from "./obu/sequence-header";
import { dcPredict } from "./prediction/intra";
import {
	applyResidual,
	computeResidual,
	dequantize,
	quantize,
} from "./transform/quantize";
import type { AvifEncodeOptions, BitDepth, PlanarYuvData } from "./types";
import {
	convertToBt2020,
	hlgOetf,
	pqOetf,
	quantizeChannel,
	rgbToBt2020Ycbcr,
	srgbOetf,
} from "./utils/color";

export function encodeAvifHdr(
	pixels: PlanarYuvData | Float32Array,
	options: AvifEncodeOptions,
): Uint8Array {
	const opts = resolveOptions(options);

	if (opts.qp < 0 || opts.qp > 63 || !Number.isFinite(opts.qp)) {
		throw new Error(`qp must be 0-63, got ${opts.qp}`);
	}
	if (
		opts.width < 1 ||
		opts.height < 1 ||
		opts.width > 65536 ||
		opts.height > 65536
	) {
		throw new Error(`width/height must be 1-65536`);
	}

	let yuvData: PlanarYuvData;
	if (pixels instanceof Float32Array) {
		yuvData = convertRgbaToYuv(pixels, opts);
	} else {
		if (pixels.width !== opts.width || pixels.height !== opts.height) {
			throw new Error(
				`PlanarYuvData dimensions (${pixels.width}x${pixels.height}) must match options (${opts.width}x${opts.height})`,
			);
		}
		yuvData = pixels;
	}

	const rawQindex = Math.round(opts.qp * 4);
	const baseQindex = Math.min(255, Math.max(0, rawQindex));

	if (baseQindex === 0 && opts.chromaSubsampling === "4:2:0") {
		throw new Error("Lossless (qp=0) requires 4:4:4 chroma subsampling");
	}

	// Encode color planes
	const encoder = new Av1Encoder(opts, yuvData, baseQindex);
	const tileData = encoder.encode();
	const sequenceHeader = generateSequenceHeader(opts);
	const frameHeader = generateFrameHeader(
		encoder.yWidth,
		encoder.yHeight,
		baseQindex,
	);
	const obuStream = packObus(sequenceHeader, frameHeader, tileData);

	// Encode alpha plane if present
	let alphaObuStream: Uint8Array | undefined;
	if (yuvData.alpha) {
		const alphaEncoder = new Av1AlphaEncoder(opts, yuvData.alpha, baseQindex);
		const alphaTileData = alphaEncoder.encode();
		const alphaSeqHeader = generateSequenceHeader(opts, true);
		const alphaFrameHeader = generateFrameHeader(
			alphaEncoder.yWidth,
			alphaEncoder.yHeight,
			baseQindex,
			true,
		);
		alphaObuStream = packObus(alphaSeqHeader, alphaFrameHeader, alphaTileData);
	}

	return packAvif(obuStream, opts, alphaObuStream);
}

interface ResolvedOptions extends Required<AvifEncodeOptions> {}

function resolveOptions(options: AvifEncodeOptions): ResolvedOptions {
	return {
		width: options.width,
		height: options.height,
		bitDepth: options.bitDepth ?? 10,
		chromaSubsampling: options.chromaSubsampling ?? "4:2:0",
		colorPrimaries: options.colorPrimaries ?? "bt2020",
		transferCharacteristics: options.transferCharacteristics ?? "pq",
		matrixCoefficients: options.matrixCoefficients ?? "bt2020",
		fullRange: options.fullRange ?? true,
		qp: options.qp ?? 32,
		inputColorSpace: options.inputColorSpace ?? "srgb-linear",
		maxNits: options.maxNits ?? 203,
	};
}

function convertRgbaToYuv(
	rgba: Float32Array,
	opts: ResolvedOptions,
): PlanarYuvData {
	const { width, height, bitDepth, chromaSubsampling } = opts;
	const pixelCount = width * height;

	if (rgba.length < pixelCount * 4) {
		throw new Error(
			`Float32 RGBA buffer too short: need ${pixelCount * 4}, got ${rgba.length}`,
		);
	}
	if (!Number.isFinite(opts.maxNits) || opts.maxNits <= 0) {
		throw new Error(`maxNits must be a positive finite number`);
	}

	// Build OETF: for PQ, scale linear [0,1] → [0, maxNits] cd/m² first
	const maxNits = opts.maxNits;
	const oetf =
		opts.transferCharacteristics === "pq"
			? (v: number) => pqOetf(v * maxNits)
			: opts.transferCharacteristics === "hlg"
				? hlgOetf
				: opts.transferCharacteristics === "linear"
					? (v: number) => v
					: srgbOetf;

	const yPlane = new Uint16Array(pixelCount);
	const is420 = chromaSubsampling === "4:2:0";
	const chromaW = is420 ? Math.ceil(width / 2) : width;
	const chromaH = is420 ? Math.ceil(height / 2) : height;
	const uPlane = new Uint16Array(chromaW * chromaH);
	const vPlane = new Uint16Array(chromaW * chromaH);

	if (is420) {
		// 4:2:0: accumulate chroma at subsampled resolution, no full-res intermediates
		const cbAcc = new Float64Array(chromaW * chromaH);
		const crAcc = new Float64Array(chromaW * chromaH);
		const countAcc = new Uint8Array(chromaW * chromaH);

		for (let row = 0; row < height; row++) {
			for (let col = 0; col < width; col++) {
				const i = row * width + col;
				const [bt2020R, bt2020G, bt2020B] = convertToBt2020(
					rgba[i * 4],
					rgba[i * 4 + 1],
					rgba[i * 4 + 2],
					opts.inputColorSpace,
				);
				const r = oetf(Math.max(0, bt2020R));
				const g = oetf(Math.max(0, bt2020G));
				const b = oetf(Math.max(0, bt2020B));
				const [y, cb, cr] = rgbToBt2020Ycbcr(r, g, b);
				yPlane[i] = quantizeChannel(y, bitDepth, opts.fullRange);

				const ci = (row >> 1) * chromaW + (col >> 1);
				cbAcc[ci] += cb;
				crAcc[ci] += cr;
				countAcc[ci]++;
			}
		}

		for (let ci = 0; ci < chromaW * chromaH; ci++) {
			uPlane[ci] = quantizeChannel(
				cbAcc[ci] / countAcc[ci],
				bitDepth,
				opts.fullRange,
				true,
			);
			vPlane[ci] = quantizeChannel(
				crAcc[ci] / countAcc[ci],
				bitDepth,
				opts.fullRange,
				true,
			);
		}
	} else {
		// 4:4:4: direct per-pixel chroma
		for (let i = 0; i < pixelCount; i++) {
			const [bt2020R, bt2020G, bt2020B] = convertToBt2020(
				rgba[i * 4],
				rgba[i * 4 + 1],
				rgba[i * 4 + 2],
				opts.inputColorSpace,
			);
			const r = oetf(Math.max(0, bt2020R));
			const g = oetf(Math.max(0, bt2020G));
			const b = oetf(Math.max(0, bt2020B));
			const [y, cb, cr] = rgbToBt2020Ycbcr(r, g, b);
			yPlane[i] = quantizeChannel(y, bitDepth, opts.fullRange);
			uPlane[i] = quantizeChannel(cb, bitDepth, opts.fullRange, true);
			vPlane[i] = quantizeChannel(cr, bitDepth, opts.fullRange, true);
		}
	}

	// Extract alpha channel
	let alphaPlane: Uint16Array | undefined;
	const maxVal = (1 << bitDepth) - 1;
	let hasNonOpaqueAlpha = false;
	for (let i = 0; i < pixelCount; i++) {
		const a = rgba[i * 4 + 3];
		if (a < 1.0) {
			hasNonOpaqueAlpha = true;
			break;
		}
	}
	if (hasNonOpaqueAlpha) {
		alphaPlane = new Uint16Array(pixelCount);
		for (let i = 0; i < pixelCount; i++) {
			alphaPlane[i] = Math.round(
				Math.max(0, Math.min(1, rgba[i * 4 + 3])) * maxVal,
			);
		}
	}

	return {
		y: yPlane,
		u: uPlane,
		v: vPlane,
		alpha: alphaPlane,
		width,
		height,
		bitDepth,
		chromaSubsampling,
	};
}

abstract class Av1BaseEncoder {
	public readonly yWidth: number;
	public readonly yHeight: number;
	protected readonly bitDepth: BitDepth;
	protected readonly baseQindex: number;

	protected readonly modeInfoGrid: ModeInfo[];
	protected readonly codedBsizeGrid: Uint8Array;
	protected readonly miRows: number;
	protected readonly miCols: number;

	protected constructor(opts: ResolvedOptions, baseQindex: number) {
		this.bitDepth = opts.bitDepth ?? 10;
		this.baseQindex = baseQindex;

		// Pad to multiple of 8
		this.yWidth = Math.ceil(opts.width / 8) * 8;
		this.yHeight = Math.ceil(opts.height / 8) * 8;

		this.miRows = this.yHeight / 4;
		this.miCols = this.yWidth / 4;
		this.modeInfoGrid = Array.from(
			{ length: this.miRows * this.miCols },
			createModeInfo,
		);
		this.codedBsizeGrid = new Uint8Array(this.miRows * this.miCols);
	}

	protected abstract encodeBlock(
		bitstream: EntropyWriter,
		miRow: number,
		miCol: number,
		bsize: number,
		tileMiColStart: number,
		tileMiRowStart: number,
	): void;

	public encode(): Uint8Array {
		const tile = computeTileLayout(this.yWidth, this.yHeight);

		if (tile.tileCols === 1) {
			const bitstream = new EntropyWriter();
			for (let sbRow = 0; sbRow < tile.sbRows; sbRow++) {
				for (let sbCol = 0; sbCol < tile.sbCols; sbCol++) {
					this.encodeSuperblock(bitstream, sbRow * 16, sbCol * 16, 0, 0);
				}
			}
			return bitstream.finalize();
		}

		const tileDataParts: Uint8Array[] = [];
		for (let tileCol = 0; tileCol < tile.tileCols; tileCol++) {
			const bitstream = new EntropyWriter();
			const sbColStart = tile.colStarts[tileCol];
			const sbColEnd = tile.colStarts[tileCol + 1];
			const tileMiColStart = sbColStart * 16;
			for (let sbRow = 0; sbRow < tile.sbRows; sbRow++) {
				for (let sbCol = sbColStart; sbCol < sbColEnd; sbCol++) {
					this.encodeSuperblock(
						bitstream,
						sbRow * 16,
						sbCol * 16,
						tileMiColStart,
						0,
					);
				}
			}
			tileDataParts.push(bitstream.finalize());
		}

		// tile_start_and_end_present_flag = 0 (1 bit) + byte alignment (7 bits)
		const tileGroupHeader = new Uint8Array([0x00]);

		let totalSize = tileGroupHeader.length;
		for (const part of tileDataParts) totalSize += part.length;
		totalSize += (tileDataParts.length - 1) * 4;

		const result = new Uint8Array(totalSize);
		let offset = 0;
		result.set(tileGroupHeader, offset);
		offset += tileGroupHeader.length;

		for (let i = 0; i < tileDataParts.length; i++) {
			if (i < tileDataParts.length - 1) {
				const size = tileDataParts[i].length - 1;
				result[offset] = size & 0xff;
				result[offset + 1] = (size >> 8) & 0xff;
				result[offset + 2] = (size >> 16) & 0xff;
				result[offset + 3] = (size >> 24) & 0xff;
				offset += 4;
			}
			result.set(tileDataParts[i], offset);
			offset += tileDataParts[i].length;
		}

		return result;
	}

	private encodeSuperblock(
		bitstream: EntropyWriter,
		miRow: number,
		miCol: number,
		tileMiColStart: number,
		tileMiRowStart: number,
	): void {
		this.encodePartitionRecursive(
			bitstream,
			miRow,
			miCol,
			64,
			tileMiColStart,
			tileMiRowStart,
		);
	}

	private encodePartitionRecursive(
		bitstream: EntropyWriter,
		miRow: number,
		miCol: number,
		bsize: number,
		tileMiColStart: number,
		tileMiRowStart: number,
	): void {
		const lossless = this.baseQindex === 0;
		encodePartition(
			bitstream,
			miRow,
			miCol,
			bsize,
			this.miRows,
			this.miCols,
			lossless,
			this.codedBsizeGrid,
			tileMiColStart,
			tileMiRowStart,
		);

		const minBsize = lossless ? 4 : 8;
		if (bsize === minBsize) {
			this.encodeBlock(
				bitstream,
				miRow,
				miCol,
				bsize,
				tileMiColStart,
				tileMiRowStart,
			);
			return;
		}

		const half = bsize / 8;
		const subRows = miRow + half < this.miRows ? 2 : 1;
		const subCols = miCol + half < this.miCols ? 2 : 1;
		const offset = half;

		for (let i = 0; i < subRows; i++) {
			for (let j = 0; j < subCols; j++) {
				this.encodePartitionRecursive(
					bitstream,
					miRow + i * offset,
					miCol + j * offset,
					bsize / 2,
					tileMiColStart,
					tileMiRowStart,
				);
			}
		}
	}
}

class Av1Encoder extends Av1BaseEncoder {
	private readonly uvWidth: number;
	private readonly uvHeight: number;

	// Planar pixel buffers (Int32Array for prediction arithmetic)
	private readonly sourcePlanes: [Int32Array, Int32Array, Int32Array];
	private readonly reconPlanes: [Int32Array, Int32Array, Int32Array];
	private readonly planeWidths: [number, number, number];
	private readonly planeHeights: [number, number, number];

	public constructor(
		opts: ResolvedOptions,
		yuv: PlanarYuvData,
		baseQindex: number,
	) {
		super(opts, baseQindex);

		const is420 = (opts.chromaSubsampling ?? "4:2:0") === "4:2:0";
		this.uvWidth = is420 ? this.yWidth / 2 : this.yWidth;
		this.uvHeight = is420 ? this.yHeight / 2 : this.yHeight;

		this.planeWidths = [this.yWidth, this.uvWidth, this.uvWidth];
		this.planeHeights = [this.yHeight, this.uvHeight, this.uvHeight];

		const srcChromaW = is420 ? Math.ceil(opts.width / 2) : opts.width;
		const srcChromaH = is420 ? Math.ceil(opts.height / 2) : opts.height;

		this.sourcePlanes = [
			padPlane(yuv.y, opts.width, opts.height, this.yWidth, this.yHeight),
			padPlane(yuv.u, srcChromaW, srcChromaH, this.uvWidth, this.uvHeight),
			padPlane(yuv.v, srcChromaW, srcChromaH, this.uvWidth, this.uvHeight),
		];

		this.reconPlanes = [
			new Int32Array(this.yWidth * this.yHeight),
			new Int32Array(this.uvWidth * this.uvHeight),
			new Int32Array(this.uvWidth * this.uvHeight),
		];
	}

	protected encodeBlock(
		bitstream: EntropyWriter,
		miRow: number,
		miCol: number,
		bsize: number,
		tileMiColStart = 0,
		tileMiRowStart = 0,
	): void {
		const thisMi = createModeInfo();

		encodeBlockModes(bitstream);

		const chromaSub = this.uvWidth < this.yWidth ? 1 : 0;

		for (let plane = 0; plane < 3; plane++) {
			const sub = plane > 0 ? chromaSub : 0;
			const y0 = (miRow * 4) >> sub;
			const x0 = (miCol * 4) >> sub;
			const h = bsize >> sub;
			const w = bsize >> sub;
			const stride = this.planeWidths[plane];
			const tileX0 = (tileMiColStart * 4) >> sub;
			const tileY0 = (tileMiRowStart * 4) >> sub;

			dcPredict(
				this.reconPlanes[plane],
				stride,
				y0,
				x0,
				h,
				w,
				this.bitDepth,
				tileX0,
				tileY0,
			);

			const lossless = this.baseQindex === 0;

			const residual = computeResidual(
				this.sourcePlanes[plane],
				this.reconPlanes[plane],
				stride,
				y0,
				x0,
				h,
				w,
				lossless,
				this.bitDepth,
			);

			if (!lossless) {
				quantize(residual, w, h, this.baseQindex, this.bitDepth);
			}

			encodeCoeffs(
				bitstream,
				plane,
				miRow,
				miCol,
				bsize,
				thisMi,
				residual,
				w,
				h,
				this.baseQindex,
				this.modeInfoGrid,
				this.miCols,
				chromaSub,
				tileMiColStart,
				tileMiRowStart,
			);

			if (!lossless) {
				dequantize(residual, w, h, this.baseQindex, this.bitDepth);
			}
			applyResidual(
				this.reconPlanes[plane],
				residual,
				stride,
				y0,
				x0,
				h,
				w,
				this.bitDepth,
				lossless,
			);
		}

		// Store mode info and coded block size for all 4x4 units in this block
		const miSize = bsize / 4;
		for (let i = 0; i < miSize; i++) {
			for (let j = 0; j < miSize; j++) {
				const idx = (miRow + i) * this.miCols + (miCol + j);
				this.modeInfoGrid[idx] = { ...thisMi };
				this.codedBsizeGrid[idx] = miSize;
			}
		}
	}
}

// Monochrome encoder for alpha channel (Y plane only, no chroma)
class Av1AlphaEncoder extends Av1BaseEncoder {
	private readonly sourcePlane: Int32Array;
	private readonly reconPlane: Int32Array;

	public constructor(
		opts: ResolvedOptions,
		alpha: Uint16Array,
		baseQindex: number,
	) {
		super(opts, baseQindex);

		this.sourcePlane = padPlane(
			alpha,
			opts.width,
			opts.height,
			this.yWidth,
			this.yHeight,
		);
		this.reconPlane = new Int32Array(this.yWidth * this.yHeight);
	}

	protected encodeBlock(
		bitstream: EntropyWriter,
		miRow: number,
		miCol: number,
		bsize: number,
		tileMiColStart = 0,
		tileMiRowStart = 0,
	): void {
		const thisMi = createModeInfo();

		encodeBlockModes(bitstream, true);

		// Monochrome: Y plane only (plane=0)
		const y0 = miRow * 4;
		const x0 = miCol * 4;
		const stride = this.yWidth;
		const tileX0 = tileMiColStart * 4;
		const tileY0 = tileMiRowStart * 4;

		dcPredict(
			this.reconPlane,
			stride,
			y0,
			x0,
			bsize,
			bsize,
			this.bitDepth,
			tileX0,
			tileY0,
		);

		const lossless = this.baseQindex === 0;

		const residual = computeResidual(
			this.sourcePlane,
			this.reconPlane,
			stride,
			y0,
			x0,
			bsize,
			bsize,
			lossless,
			this.bitDepth,
		);

		if (!lossless) {
			quantize(residual, bsize, bsize, this.baseQindex, this.bitDepth);
		}

		encodeCoeffs(
			bitstream,
			0,
			miRow,
			miCol,
			bsize,
			thisMi,
			residual,
			bsize,
			bsize,
			this.baseQindex,
			this.modeInfoGrid,
			this.miCols,
			0,
			tileMiColStart,
			tileMiRowStart,
		);

		if (!lossless) {
			dequantize(residual, bsize, bsize, this.baseQindex, this.bitDepth);
		}
		applyResidual(
			this.reconPlane,
			residual,
			stride,
			y0,
			x0,
			bsize,
			bsize,
			this.bitDepth,
			lossless,
		);

		const miSize = bsize / 4;
		for (let i = 0; i < miSize; i++) {
			for (let j = 0; j < miSize; j++) {
				const idx = (miRow + i) * this.miCols + (miCol + j);
				this.modeInfoGrid[idx] = { ...thisMi };
				this.codedBsizeGrid[idx] = miSize;
			}
		}
	}
}

function padPlane(
	source: Uint16Array,
	srcWidth: number,
	srcHeight: number,
	dstWidth: number,
	dstHeight: number,
): Int32Array {
	const dst = new Int32Array(dstWidth * dstHeight);

	for (let y = 0; y < dstHeight; y++) {
		const srcY = Math.min(y, srcHeight - 1);
		for (let x = 0; x < dstWidth; x++) {
			const srcX = Math.min(x, srcWidth - 1);
			dst[y * dstWidth + x] = source[srcY * srcWidth + srcX];
		}
	}

	return dst;
}
