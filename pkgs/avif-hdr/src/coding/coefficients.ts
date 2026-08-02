// Copyright (c) 2024-2025, The tinyavif contributors. All rights reserved.
// Ported from tinyavif av1_encoder.rs (BSD 2-Clause + AOM Patent License 1.0)
//
// Residual coefficient encoding for AV1.

import {
	all_zero_cdf,
	COEFF_BASE_CTX_OFFSET_8x8,
	coeff_base_cdf,
	coeff_base_eob_cdf,
	coeff_br_cdf,
	dc_sign_cdf,
	eob_class_16_cdf,
	eob_class_64_cdf,
	eob_extra_4x4_cdf,
	eob_extra_8x8_cdf,
	MAG_REF_OFFSET,
	SCAN_ORDER_4x4,
	SCAN_ORDER_8x8,
	SIG_REF_DIFF_OFFSET,
	tx_type_cdf,
} from "./cdf-tables";
import type { EntropyWriter } from "./range-coder";

function getQctx(baseQindex: number): number {
	if (baseQindex <= 20) return 0;
	if (baseQindex <= 60) return 1;
	if (baseQindex <= 120) return 2;
	return 3;
}

function ceilLog2(value: number): number {
	if (value <= 1) return 0;
	let n = 0;
	let v = value - 1;
	while (v > 0) {
		v >>>= 1;
		n++;
	}
	return n;
}

export interface ModeInfo {
	levelCtx: [number, number, number];
	dcSign: [number, number, number];
}

export function createModeInfo(): ModeInfo {
	return {
		levelCtx: [0, 0, 0],
		dcSign: [0, 0, 0],
	};
}

export function encodeCoeffs(
	bitstream: EntropyWriter,
	plane: number,
	miRow: number,
	miCol: number,
	bsize: number,
	thisMi: ModeInfo,
	coeffs: Int32Array,
	coeffW: number,
	_coeffH: number,
	baseQindex: number,
	modeInfoGrid: ModeInfo[],
	modeInfoCols: number,
	chromaSub = 1,
	tileMiColStart = 0,
	tileMiRowStart = 0,
): void {
	const txsize = plane > 0 ? bsize >> chromaSub : bsize;
	const txsCtx = txsize === 8 ? 1 : 0;
	const numCoeffs = txsize * txsize;

	const scan = txsCtx === 1 ? SCAN_ORDER_8x8 : SCAN_ORDER_4x4;

	const qctx = getQctx(baseQindex);
	const ptype = plane === 0 ? 0 : 1;

	// Find end-of-block position
	let eob = 0;
	let culLevel = 0;
	for (let c = 0; c < numCoeffs; c++) {
		const [row, col] = scan[c];
		const coeff = coeffs[row * coeffW + col];
		culLevel += Math.abs(coeff);
		if (coeff !== 0) {
			eob = c + 1;
		}
	}
	thisMi.levelCtx[plane] = Math.min(culLevel, 63);

	const allZero = eob === 0;

	// all_zero context
	let allZeroCtx: number;
	if (plane === 0) {
		allZeroCtx = 0;
	} else {
		let above = false;
		let left = false;
		if (miRow > tileMiRowStart) {
			const aboveBlock = modeInfoGrid[(miRow - 1) * modeInfoCols + miCol];
			above ||= aboveBlock.levelCtx[plane] !== 0;
			above ||= aboveBlock.dcSign[plane] !== 0;
		}
		if (miCol > tileMiColStart) {
			const leftBlock = modeInfoGrid[miRow * modeInfoCols + miCol - 1];
			left ||= leftBlock.levelCtx[plane] !== 0;
			left ||= leftBlock.dcSign[plane] !== 0;
		}
		allZeroCtx = 7 + (above ? 1 : 0) + (left ? 1 : 0);
	}

	bitstream.writeSymbol(
		allZero ? 1 : 0,
		all_zero_cdf[qctx][txsCtx][allZeroCtx],
	);
	if (allZero) return;

	// Transform type (luma only): DCT_DCT = index 1 in reduced set
	// When lossless, TxType=DCT_DCT is inferred — no bits written
	if (plane === 0 && baseQindex > 0) {
		bitstream.writeSymbol(1, tx_type_cdf);
	}

	// EOB class encoding — select CDF by transform size, not plane
	const eobClass = ceilLog2(eob);
	const eobClassCdf =
		txsCtx === 1
			? eob_class_64_cdf[qctx][ptype]
			: eob_class_16_cdf[qctx][ptype];
	bitstream.writeSymbol(eobClass, eobClassCdf);

	if (eobClass > 1) {
		const eobClassLow = (1 << (eobClass - 1)) + 1;
		const eobShift = eobClass - 2;

		const firstExtraBitCdf =
			txsCtx === 1
				? eob_extra_8x8_cdf[qctx][ptype][eobClass - 2]
				: eob_extra_4x4_cdf[qctx][ptype][eobClass - 2];
		const extraBit = ((eob - eobClassLow) >> eobShift) & 1;
		bitstream.writeSymbol(extraBit, firstExtraBitCdf);

		const remainder = eob - eobClassLow - (extraBit << eobShift);
		const remainderBits = eobClass - 2;
		if (remainderBits > 0) {
			bitstream.writeLiteral(remainder, remainderBits);
		}
	}

	// Base range encoding (high-to-low order)
	for (let c = eob - 1; c >= 0; c--) {
		const [row, col] = scan[c];
		const coeff = coeffs[row * coeffW + col];
		const absValue = Math.abs(coeff);

		if (c === eob - 1) {
			// Last nonzero coefficient
			let baseEobCtx: number;
			if (c === 0) baseEobCtx = 0;
			else if (c <= numCoeffs / 8) baseEobCtx = 1;
			else if (c <= numCoeffs / 4) baseEobCtx = 2;
			else baseEobCtx = 3;

			const codedValue = Math.min(absValue - 1, 2);
			bitstream.writeSymbol(
				codedValue,
				coeff_base_eob_cdf[qctx][txsCtx][ptype][baseEobCtx],
			);
		} else {
			// Context from nearby coefficients
			let baseCtx: number;
			if (c === 0) {
				baseCtx = 0;
			} else {
				let mag = 0;
				for (const [rowOff, colOff] of SIG_REF_DIFF_OFFSET) {
					const refRow = row + rowOff;
					const refCol = col + colOff;
					if (
						refRow >= 0 &&
						refRow < txsize &&
						refCol >= 0 &&
						refCol < txsize
					) {
						mag += Math.min(Math.abs(coeffs[refRow * coeffW + refCol]), 3);
					}
				}
				const magPart = Math.min(Math.floor((mag + 1) / 2), 4);
				const locPart =
					COEFF_BASE_CTX_OFFSET_8x8[Math.min(row, 4)][Math.min(col, 4)];
				baseCtx = magPart + locPart;
			}

			const codedValue = Math.min(absValue, 3);
			bitstream.writeSymbol(
				codedValue,
				coeff_base_cdf[qctx][txsCtx][ptype][baseCtx],
			);
		}

		// coeff_br symbols for values > 2
		if (absValue > 2) {
			let mag = 0;
			for (const [rowOff, colOff] of MAG_REF_OFFSET) {
				const refRow = row + rowOff;
				const refCol = col + colOff;
				if (refRow >= 0 && refRow < txsize && refCol >= 0 && refCol < txsize) {
					mag += Math.min(Math.abs(coeffs[refRow * coeffW + refCol]), 15);
				}
			}
			const magPart = Math.min(Math.floor((mag + 1) / 2), 6);
			let locPart: number;
			if (c === 0) locPart = 0;
			else if (row < 2 && col < 2) locPart = 7;
			else locPart = 14;
			const brCtx = magPart + locPart;

			let level = 3;
			for (let k = 0; k < 4; k++) {
				const coeffBr = Math.min(absValue - level, 3);
				bitstream.writeSymbol(
					coeffBr,
					coeff_br_cdf[qctx][txsCtx][ptype][brCtx],
				);
				level += coeffBr;
				if (coeffBr < 3) break;
			}
		}
	}

	// DC sign encoding
	const dcCoeff = coeffs[0];
	if (dcCoeff !== 0) {
		let netNeighbourSign = 0;
		if (miRow > tileMiRowStart) {
			netNeighbourSign +=
				modeInfoGrid[(miRow - 1) * modeInfoCols + miCol].dcSign[plane];
		}
		if (miCol > tileMiColStart) {
			netNeighbourSign +=
				modeInfoGrid[miRow * modeInfoCols + miCol - 1].dcSign[plane];
		}

		let dcSignCtx: number;
		if (netNeighbourSign === 0) dcSignCtx = 0;
		else if (netNeighbourSign < 0) dcSignCtx = 1;
		else dcSignCtx = 2;

		const sign = dcCoeff < 0 ? 1 : 0;
		bitstream.writeSymbol(sign, dc_sign_cdf[qctx][ptype][dcSignCtx]);
	}
	if (Math.abs(dcCoeff) >= 15) {
		bitstream.writeGolomb(Math.abs(dcCoeff) - 15);
	}

	// Store DC sign for subsequent blocks
	thisMi.dcSign[plane] = dcCoeff < 0 ? -1 : dcCoeff > 0 ? 1 : 0;

	// Sign + golomb for remaining coefficients (low-to-high order)
	for (let c = 1; c < eob; c++) {
		const [row, col] = scan[c];
		const coeff = coeffs[row * coeffW + col];
		if (coeff !== 0) {
			bitstream.writeLiteral(coeff < 0 ? 1 : 0, 1);
		}
		if (Math.abs(coeff) >= 15) {
			bitstream.writeGolomb(Math.abs(coeff) - 15);
		}
	}
}
