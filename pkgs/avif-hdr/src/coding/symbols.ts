// Copyright (c) 2024-2025, The tinyavif contributors. All rights reserved.
// Ported from tinyavif av1_encoder.rs (BSD 2-Clause + AOM Patent License 1.0)
//
// Symbol encoding for AV1 partition, skip, and prediction mode signals.

import {
	partition_8x8_cdf,
	partition_16x16_cdf,
	partition_32x32_cdf,
	partition_64x64_cdf,
	skip_cdf,
	uv_mode_cdf,
	y_mode_cdf,
} from "./cdf-tables";
import type { EntropyWriter } from "./range-coder";

const PARTITION_NONE = 0;
const PARTITION_HORZ = 1;
const PARTITION_VERT = 2;
const PARTITION_SPLIT = 3;
const PARTITION_HORZ_A = 4;
const PARTITION_HORZ_B = 5;
const PARTITION_VERT_A = 6;
const PARTITION_VERT_B = 7;
const PARTITION_HORZ_4 = 8;
const PARTITION_VERT_4 = 9;

function getProb(symbolIdx: number, cdf: readonly number[]): number {
	const numSymbols = cdf.length + 1;
	const lo = symbolIdx === 0 ? 0 : cdf[symbolIdx - 1];
	const hi = symbolIdx === numSymbols - 1 ? 32768 : cdf[symbolIdx];
	return hi - lo;
}

export function encodePartition(
	bitstream: EntropyWriter,
	miRow: number,
	miCol: number,
	bsize: number,
	miRows: number,
	miCols: number,
	lossless: boolean,
	codedBsizeGrid: Uint8Array,
	tileMiColStart = 0,
	tileMiRowStart = 0,
): void {
	if (bsize === 4) {
		return;
	}

	// AV1 partition context: above/left neighbor block size < current block size
	// Tile-aware: only reference neighbors within the same tile
	const bw4 = bsize >> 2; // block width in MI units
	const aboveCtx =
		miRow > tileMiRowStart && codedBsizeGrid[(miRow - 1) * miCols + miCol] < bw4
			? 1
			: 0;
	const leftCtx =
		miCol > tileMiColStart && codedBsizeGrid[miRow * miCols + miCol - 1] < bw4
			? 1
			: 0;
	const ctx = 2 * leftCtx + aboveCtx;

	if (bsize === 8) {
		const cdf = partition_8x8_cdf[ctx];
		if (lossless) {
			bitstream.writeSymbol(PARTITION_SPLIT, cdf);
		} else {
			bitstream.writeSymbol(PARTITION_NONE, cdf);
		}
		return;
	}

	const subRows = miRow + bsize / 8 < miRows ? 2 : 1;
	const subCols = miCol + bsize / 8 < miCols ? 2 : 1;

	let cdf: readonly number[];
	switch (bsize) {
		case 16:
			cdf = partition_16x16_cdf[ctx];
			break;
		case 32:
			cdf = partition_32x32_cdf[ctx];
			break;
		case 64:
			cdf = partition_64x64_cdf[ctx];
			break;
		default:
			throw new Error(`Unexpected partition size: ${bsize}`);
	}

	if (subRows > 1 && subCols > 1) {
		bitstream.writeSymbol(PARTITION_SPLIT, cdf);
	} else if (subCols > 1) {
		// Bottom edge: choose between HORZ and SPLIT
		const pSplit =
			getProb(PARTITION_VERT, cdf) +
			getProb(PARTITION_SPLIT, cdf) +
			getProb(PARTITION_HORZ_A, cdf) +
			getProb(PARTITION_VERT_A, cdf) +
			getProb(PARTITION_VERT_B, cdf) +
			getProb(PARTITION_VERT_4, cdf);
		bitstream.writeBit(1, 32768 - pSplit);
	} else if (subRows > 1) {
		// Right edge: choose between VERT and SPLIT
		const pSplit =
			getProb(PARTITION_HORZ, cdf) +
			getProb(PARTITION_SPLIT, cdf) +
			getProb(PARTITION_HORZ_A, cdf) +
			getProb(PARTITION_HORZ_B, cdf) +
			getProb(PARTITION_VERT_A, cdf) +
			getProb(PARTITION_HORZ_4, cdf);
		bitstream.writeBit(1, 32768 - pSplit);
	}
	// else: bottom-right corner, SPLIT is forced, no signal needed
}

export function encodeBlockModes(
	bitstream: EntropyWriter,
	monochrome = false,
): void {
	// skip = false (always encode residuals)
	bitstream.writeSymbol(0, skip_cdf);

	// y_mode = DC_PRED (context = 0,0 since all neighbors are DC_PRED)
	bitstream.writeSymbol(0, y_mode_cdf);

	// uv_mode is only signaled when chroma planes exist
	if (!monochrome) {
		// uv_mode = DC_PRED (context = DC_PRED + CFL allowed)
		bitstream.writeSymbol(0, uv_mode_cdf);
	}
}
