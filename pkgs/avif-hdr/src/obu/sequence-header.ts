import type { AvifEncodeOptions, BitDepth } from "../types";
import {
	COLOR_PRIMARIES_CODE,
	MATRIX_COEFFICIENTS_CODE,
	TRANSFER_CHARACTERISTICS_CODE,
} from "../types";
import { BitWriter } from "../utils/bitwriter";

export function generateSequenceHeader(
	options: AvifEncodeOptions,
	monochrome = false,
): Uint8Array {
	const w = new BitWriter();
	const bitDepth = options.bitDepth ?? 10;
	// Monochrome always uses 4:2:0 subsampling (implicit, Profile 0)
	const chromaSubsampling = monochrome
		? "4:2:0"
		: (options.chromaSubsampling ?? "4:2:0");
	const colorPrimaries =
		COLOR_PRIMARIES_CODE[options.colorPrimaries ?? "bt2020"];
	const transferCharacteristics =
		TRANSFER_CHARACTERISTICS_CODE[options.transferCharacteristics ?? "pq"];
	const matrixCoefficients =
		MATRIX_COEFFICIENTS_CODE[options.matrixCoefficients ?? "bt2020"];
	const fullRange = options.fullRange ?? true;

	const profile = getProfile(bitDepth, chromaSubsampling);
	w.writeBits(profile, 3);

	w.writeBit(1); // still_picture
	w.writeBit(1); // reduced_still_picture_header

	w.writeBits(31, 5); // seq_level_idx = 31 (unconstrained)

	// Frame dimensions
	w.writeBits(15, 4); // width_bits_minus_1 = 15 (16 bits)
	w.writeBits(15, 4); // height_bits_minus_1 = 15 (16 bits)
	w.writeBits(options.width - 1, 16);
	w.writeBits(options.height - 1, 16);

	// Feature flags for reduced_still_picture_header (AV1 spec Section 5.5.2)
	// frame_id_numbers_present_flag inferred as 0 (not written)
	// Inter-frame flags (interintra, masked, warped, dual_filter, order_hint,
	// screen_content_tools, integer_mv) skipped under reduced_still_picture_header
	w.writeBit(0); // use_128x128_superblock
	w.writeBit(0); // enable_filter_intra
	w.writeBit(0); // enable_intra_edge_filter
	w.writeBit(0); // enable_superres
	w.writeBit(0); // enable_cdef
	w.writeBit(0); // enable_restoration

	// Color configuration
	if (bitDepth > 8) {
		w.writeBit(1); // high_bitdepth
		if (profile === 2 && bitDepth === 12) {
			w.writeBit(1); // twelve_bit
		} else if (profile === 2) {
			w.writeBit(0); // twelve_bit
		}
	} else {
		w.writeBit(0); // high_bitdepth
	}

	// mono_chrome is only coded when seq_profile != 1 (AV1 spec)
	if (profile !== 1) {
		w.writeBit(monochrome ? 1 : 0);
	}

	w.writeBit(1); // color_description_present_flag
	w.writeBits(colorPrimaries, 8);
	w.writeBits(transferCharacteristics, 8);
	w.writeBits(matrixCoefficients, 8);

	if (monochrome) {
		w.writeBit(fullRange ? 1 : 0);
	} else {
		w.writeBit(fullRange ? 1 : 0);

		let subsamplingX = 0;
		let subsamplingY = 0;

		if (profile === 0) {
			// Profile 0: subsampling_x=1, subsampling_y=1 inferred (4:2:0), not written
			subsamplingX = 1;
			subsamplingY = 1;
		} else if (profile === 1) {
			// Profile 1 (4:4:4): subsampling_x=0, subsampling_y=0 inferred, not written
		} else if (profile === 2) {
			if (bitDepth === 12) {
				if (chromaSubsampling === "4:2:0") {
					w.writeBit(1); // subsampling_x
					w.writeBit(1); // subsampling_y
					subsamplingX = 1;
					subsamplingY = 1;
				} else if (chromaSubsampling === "4:4:4") {
					w.writeBit(0); // subsampling_x
					// subsampling_y=0 inferred when subsampling_x=0
				}
			}
		}

		if (subsamplingX === 1 && subsamplingY === 1) {
			w.writeBits(0, 2); // chroma_sample_position = unknown
		}

		w.writeBit(0); // separate_uv_delta_q
	}

	w.writeBit(0); // film_grain_params_present

	w.writeBit(1); // trailing_one_bit
	w.byteAlign();

	return w.finalize();
}

function getProfile(bitDepth: BitDepth, chromaSubsampling: string): number {
	if (bitDepth === 12) return 2;
	if (chromaSubsampling === "4:4:4") return 1;
	return 0;
}
