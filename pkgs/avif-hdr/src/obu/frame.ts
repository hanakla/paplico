import { BitWriter } from "../utils/bitwriter";

const MAX_TILE_WIDTH = 4096;
const SB_SIZE = 64;
const MAX_TILE_WIDTH_SB = MAX_TILE_WIDTH / SB_SIZE; // 64

function ceilLog2(n: number): number {
	if (n <= 1) return 0;
	let bits = 0;
	let v = n - 1;
	while (v > 0) {
		v >>>= 1;
		bits++;
	}
	return bits;
}

export function computeTileLayout(width: number, height: number) {
	const sbCols = Math.ceil(width / SB_SIZE);
	const sbRows = Math.ceil(height / SB_SIZE);

	// Minimum tile columns so each tile is <= MAX_TILE_WIDTH_SB
	const minTileColsLog2 = ceilLog2(Math.ceil(sbCols / MAX_TILE_WIDTH_SB));
	const tileColsLog2 = minTileColsLog2;
	const tileRowsLog2 = 0; // Always 1 tile row

	const tileCols = 1 << tileColsLog2;
	const tileRows = 1;

	// Compute tile column boundaries (uniform spacing)
	const tileWidthSb = Math.ceil(sbCols / tileCols);
	const colStarts: number[] = [];
	for (let i = 0; i < tileCols; i++) {
		colStarts.push(Math.min(i * tileWidthSb, sbCols));
	}
	colStarts.push(sbCols);

	return {
		sbCols,
		sbRows,
		tileCols,
		tileRows,
		tileColsLog2,
		tileRowsLog2,
		tileWidthSb,
		colStarts,
	};
}

// Generate AV1 frame header.
export function generateFrameHeader(
	width: number,
	height: number,
	baseQindex: number,
	monochrome = false,
): Uint8Array {
	const w = new BitWriter();
	const { sbCols, sbRows, tileColsLog2 } = computeTileLayout(width, height);

	w.writeBit(1); // disable_frame_end_update_cdf
	w.writeBit(0); // AllowScreenContentTools = 0
	w.writeBit(0); // render_and_frame_size_different = 0

	// tile_info: uniform spacing
	w.writeBit(1); // uniform_tile_spacing_flag

	// Signal tile columns: increment from minTileColsLog2
	if (sbCols > 1) {
		const minTileColsLog2 = ceilLog2(Math.ceil(sbCols / MAX_TILE_WIDTH_SB));
		const maxTileColsLog2 = ceilLog2(sbCols);
		for (let i = 0; i < tileColsLog2 - minTileColsLog2; i++) {
			w.writeBit(1); // increment
		}
		if (tileColsLog2 < maxTileColsLog2) {
			w.writeBit(0); // stop
		}
	}

	// Signal tile rows: always 1 row
	if (sbRows > 1) {
		w.writeBit(0); // no increment (1 tile row)
	}

	// context_update_tile_id + tile_size_bytes (only when multiple tiles)
	if (tileColsLog2 > 0) {
		w.writeBits(0, tileColsLog2); // context_update_tile_id = 0
		w.writeBits(3, 2); // tile_size_bytes_minus_1 = 3 (4 bytes)
	}

	// quantization_params
	w.writeBits(baseQindex, 8);
	w.writeBit(0); // DeltaQYDc delta_coded = 0

	if (!monochrome) {
		w.writeBit(0); // DeltaQUDc delta_coded = 0
		w.writeBit(0); // DeltaQUAc delta_coded = 0
	}

	w.writeBit(0); // using_qmatrix = 0
	w.writeBit(0); // segmentation_enabled = 0
	if (baseQindex > 0) {
		w.writeBit(0); // delta_q_present = 0
	}

	const lossless = baseQindex === 0;

	// loop_filter_params: when lossless, all values inferred (no bits written)
	if (!lossless) {
		w.writeBits(0, 6); // loop_filter_level[0] = 0
		w.writeBits(0, 6); // loop_filter_level[1] = 0
		w.writeBits(0, 3); // loop_filter_sharpness = 0
		w.writeBit(0); // loop_filter_delta_enabled = 0
	}

	// tx_mode: when lossless, TxMode=ONLY_4X4 inferred (no bits written)
	if (!lossless) {
		w.writeBit(0); // tx_mode_select = 0 (TX_MODE_LARGEST)
	}
	w.writeBit(1); // reduced_tx_set = 1

	// No trailing_one_bit here: in OBU_FRAME, tile data follows frame header
	// bits contiguously (no byte alignment between them).
	return w.finalize();
}
