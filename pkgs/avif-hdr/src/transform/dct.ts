// AV1 cosine lookup tables indexed by [cos_bit - 10][angle]
// cos_bit 10..13 → indices 0..3, each with 64 entries
const AV1_COSPI_ARR: readonly (readonly number[])[] = [
	// cos_bit = 10
	[
		1024, 1024, 1023, 1021, 1019, 1016, 1013, 1009, 1004, 999, 993, 987, 980,
		972, 964, 955, 946, 936, 926, 915, 903, 891, 878, 865, 851, 837, 822, 807,
		792, 775, 759, 742, 724, 706, 688, 669, 650, 630, 610, 590, 569, 548, 526,
		505, 483, 460, 438, 415, 392, 369, 345, 321, 297, 273, 249, 224, 200, 175,
		150, 125, 100, 75, 50, 25,
	],
	// cos_bit = 11
	[
		2048, 2047, 2046, 2042, 2038, 2033, 2026, 2018, 2009, 1998, 1987, 1974,
		1960, 1945, 1928, 1911, 1892, 1872, 1851, 1829, 1806, 1782, 1757, 1730,
		1703, 1674, 1645, 1615, 1583, 1551, 1517, 1483, 1448, 1412, 1375, 1338,
		1299, 1260, 1220, 1179, 1138, 1096, 1053, 1009, 965, 921, 876, 830, 784,
		737, 690, 642, 595, 546, 498, 449, 400, 350, 301, 251, 201, 151, 100, 50,
	],
	// cos_bit = 12
	[
		4096, 4095, 4091, 4085, 4076, 4065, 4052, 4036, 4017, 3996, 3973, 3948,
		3920, 3889, 3857, 3822, 3784, 3745, 3703, 3659, 3612, 3564, 3513, 3461,
		3406, 3349, 3290, 3229, 3166, 3102, 3035, 2967, 2896, 2824, 2751, 2675,
		2598, 2520, 2440, 2359, 2276, 2191, 2106, 2019, 1931, 1842, 1751, 1660,
		1567, 1474, 1380, 1285, 1189, 1092, 995, 897, 799, 700, 601, 501, 401, 301,
		201, 101,
	],
	// cos_bit = 13
	[
		8192, 8190, 8182, 8170, 8153, 8130, 8103, 8071, 8035, 7993, 7946, 7895,
		7839, 7779, 7713, 7643, 7568, 7489, 7405, 7317, 7225, 7128, 7027, 6921,
		6811, 6698, 6580, 6458, 6333, 6203, 6070, 5933, 5793, 5649, 5501, 5351,
		5197, 5040, 4880, 4717, 4551, 4383, 4212, 4038, 3862, 3683, 3503, 3320,
		3135, 2948, 2760, 2570, 2378, 2185, 1990, 1795, 1598, 1401, 1202, 1003, 803,
		603, 402, 201,
	],
];

// Forward transform shifts: [input_shift, between_col_row_shift, output_shift]
const FWD_SHIFT: readonly (readonly number[])[] = [
	[2, 0, 0], // 4x4
	[2, -1, 0], // 8x8
];

// Inverse transform shifts
const INV_SHIFT: readonly (readonly number[])[] = [
	[0, -4], // 4x4
	[-1, -4], // 8x8
];

// Forward range multiplier * 2
const FWD_RANGE_MULT2: readonly (readonly number[])[] = [
	[0, 2, 3, 3, 0, 0], // 4x4
	[0, 2, 4, 5, 5, 5], // 8x8
];

// Number of stages per transform size
const TXFM_STAGES: readonly number[] = [4, 6];

// Inverse start range
const INV_START_RANGE: readonly number[] = [5, 6];

function cospiArr(cosBit: number): readonly number[] {
	return AV1_COSPI_ARR[cosBit - 10];
}

function halfBtf(
	w0: number,
	in0: number,
	w1: number,
	in1: number,
	cosBit: number,
): number {
	const tmp = Math.imul(w0, in0) + Math.imul(w1, in1);
	const offset = 1 << (cosBit - 1);
	return (tmp + offset) >> cosBit;
}

function round2(x: number, n: number): number {
	if (n === 0) return x;
	return (x + (1 << (n - 1))) >> n;
}

function clampValue(value: number, rangeBits: number): number {
	const min = -(1 << (rangeBits - 1));
	const max = (1 << (rangeBits - 1)) - 1;
	return Math.max(min, Math.min(max, value));
}

function roundShiftArray(arr: Int32Array, bits: number): void {
	if (bits === 0) return;

	if (bits < 0) {
		const shift = -bits;
		for (let i = 0; i < arr.length; i++) {
			arr[i] = arr[i] << shift;
		}
	} else {
		for (let i = 0; i < arr.length; i++) {
			arr[i] = round2(arr[i], bits);
		}
	}
}

function clampArray(arr: Int32Array, bits: number): void {
	for (let i = 0; i < arr.length; i++) {
		arr[i] = clampValue(arr[i], bits);
	}
}

function fwdDct4(
	arr: Int32Array,
	cosBit: number,
	_stageRange: Int32Array,
): void {
	const cospi = cospiArr(cosBit);

	const s1_0 = arr[0] + arr[3];
	const s1_1 = arr[1] + arr[2];
	const s1_2 = -arr[2] + arr[1];
	const s1_3 = -arr[3] + arr[0];

	const s2_0 = halfBtf(cospi[32], s1_0, cospi[32], s1_1, cosBit);
	const s2_1 = halfBtf(-cospi[32], s1_1, cospi[32], s1_0, cosBit);
	const s2_2 = halfBtf(cospi[48], s1_2, cospi[16], s1_3, cosBit);
	const s2_3 = halfBtf(cospi[48], s1_3, -cospi[16], s1_2, cosBit);

	arr[0] = s2_0;
	arr[1] = s2_2;
	arr[2] = s2_1;
	arr[3] = s2_3;
}

function fwdDct8(
	arr: Int32Array,
	cosBit: number,
	_stageRange: Int32Array,
): void {
	const cospi = cospiArr(cosBit);

	// Stage 1
	const s1_0 = arr[0] + arr[7];
	const s1_1 = arr[1] + arr[6];
	const s1_2 = arr[2] + arr[5];
	const s1_3 = arr[3] + arr[4];
	const s1_4 = -arr[4] + arr[3];
	const s1_5 = -arr[5] + arr[2];
	const s1_6 = -arr[6] + arr[1];
	const s1_7 = -arr[7] + arr[0];

	// Stage 2
	const s2_0 = s1_0 + s1_3;
	const s2_1 = s1_1 + s1_2;
	const s2_2 = -s1_2 + s1_1;
	const s2_3 = -s1_3 + s1_0;
	const s2_4 = s1_4;
	const s2_5 = halfBtf(-cospi[32], s1_5, cospi[32], s1_6, cosBit);
	const s2_6 = halfBtf(cospi[32], s1_6, cospi[32], s1_5, cosBit);
	const s2_7 = s1_7;

	// Stage 3
	const s3_0 = halfBtf(cospi[32], s2_0, cospi[32], s2_1, cosBit);
	const s3_1 = halfBtf(-cospi[32], s2_1, cospi[32], s2_0, cosBit);
	const s3_2 = halfBtf(cospi[48], s2_2, cospi[16], s2_3, cosBit);
	const s3_3 = halfBtf(cospi[48], s2_3, -cospi[16], s2_2, cosBit);
	const s3_4 = s2_4 + s2_5;
	const s3_5 = -s2_5 + s2_4;
	const s3_6 = -s2_6 + s2_7;
	const s3_7 = s2_7 + s2_6;

	// Stage 4
	const s4_0 = s3_0;
	const s4_1 = s3_1;
	const s4_2 = s3_2;
	const s4_3 = s3_3;
	const s4_4 = halfBtf(cospi[56], s3_4, cospi[8], s3_7, cosBit);
	const s4_5 = halfBtf(cospi[24], s3_5, cospi[40], s3_6, cosBit);
	const s4_6 = halfBtf(cospi[24], s3_6, -cospi[40], s3_5, cosBit);
	const s4_7 = halfBtf(cospi[56], s3_7, -cospi[8], s3_4, cosBit);

	// Stage 5 (output reordering)
	arr[0] = s4_0;
	arr[1] = s4_4;
	arr[2] = s4_2;
	arr[3] = s4_6;
	arr[4] = s4_1;
	arr[5] = s4_5;
	arr[6] = s4_3;
	arr[7] = s4_7;
}

function invDct4(
	arr: Int32Array,
	cosBit: number,
	stageRange: Int32Array,
): void {
	const cospi = cospiArr(cosBit);

	// Stage 1 (undo output reordering)
	const s1_0 = arr[0];
	const s1_1 = arr[2];
	const s1_2 = arr[1];
	const s1_3 = arr[3];

	// Stage 2
	const s2_0 = halfBtf(cospi[32], s1_0, cospi[32], s1_1, cosBit);
	const s2_1 = halfBtf(cospi[32], s1_0, -cospi[32], s1_1, cosBit);
	const s2_2 = halfBtf(cospi[48], s1_2, -cospi[16], s1_3, cosBit);
	const s2_3 = halfBtf(cospi[16], s1_2, cospi[48], s1_3, cosBit);

	// Stage 3 (with clamping)
	arr[0] = clampValue(s2_0 + s2_3, stageRange[3]);
	arr[1] = clampValue(s2_1 + s2_2, stageRange[3]);
	arr[2] = clampValue(s2_1 - s2_2, stageRange[3]);
	arr[3] = clampValue(s2_0 - s2_3, stageRange[3]);
}

function invDct8(
	arr: Int32Array,
	cosBit: number,
	stageRange: Int32Array,
): void {
	const cospi = cospiArr(cosBit);

	// Stage 1 (undo output reordering)
	const s1_0 = arr[0];
	const s1_1 = arr[4];
	const s1_2 = arr[2];
	const s1_3 = arr[6];
	const s1_4 = arr[1];
	const s1_5 = arr[5];
	const s1_6 = arr[3];
	const s1_7 = arr[7];

	// Stage 2
	const s2_0 = s1_0;
	const s2_1 = s1_1;
	const s2_2 = s1_2;
	const s2_3 = s1_3;
	const s2_4 = halfBtf(cospi[56], s1_4, -cospi[8], s1_7, cosBit);
	const s2_5 = halfBtf(cospi[24], s1_5, -cospi[40], s1_6, cosBit);
	const s2_6 = halfBtf(cospi[40], s1_5, cospi[24], s1_6, cosBit);
	const s2_7 = halfBtf(cospi[8], s1_4, cospi[56], s1_7, cosBit);

	// Stage 3
	const s3_0 = halfBtf(cospi[32], s2_0, cospi[32], s2_1, cosBit);
	const s3_1 = halfBtf(cospi[32], s2_0, -cospi[32], s2_1, cosBit);
	const s3_2 = halfBtf(cospi[48], s2_2, -cospi[16], s2_3, cosBit);
	const s3_3 = halfBtf(cospi[16], s2_2, cospi[48], s2_3, cosBit);
	const s3_4 = clampValue(s2_4 + s2_5, stageRange[3]);
	const s3_5 = clampValue(s2_4 - s2_5, stageRange[3]);
	const s3_6 = clampValue(-s2_6 + s2_7, stageRange[3]);
	const s3_7 = clampValue(s2_6 + s2_7, stageRange[3]);

	// Stage 4
	const s4_0 = clampValue(s3_0 + s3_3, stageRange[4]);
	const s4_1 = clampValue(s3_1 + s3_2, stageRange[4]);
	const s4_2 = clampValue(s3_1 - s3_2, stageRange[4]);
	const s4_3 = clampValue(s3_0 - s3_3, stageRange[4]);
	const s4_4 = s3_4;
	const s4_5 = halfBtf(-cospi[32], s3_5, cospi[32], s3_6, cosBit);
	const s4_6 = halfBtf(cospi[32], s3_5, cospi[32], s3_6, cosBit);
	const s4_7 = s3_7;

	// Stage 5 (with clamping)
	arr[0] = clampValue(s4_0 + s4_7, stageRange[5]);
	arr[1] = clampValue(s4_1 + s4_6, stageRange[5]);
	arr[2] = clampValue(s4_2 + s4_5, stageRange[5]);
	arr[3] = clampValue(s4_3 + s4_4, stageRange[5]);
	arr[4] = clampValue(s4_3 - s4_4, stageRange[5]);
	arr[5] = clampValue(s4_2 - s4_5, stageRange[5]);
	arr[6] = clampValue(s4_1 - s4_6, stageRange[5]);
	arr[7] = clampValue(s4_0 - s4_7, stageRange[5]);
}

export function fwdTxfm2d(
	data: Int32Array,
	h: number,
	w: number,
	bitDepth = 8,
): void {
	let txszIdx: number;
	let fwdFn: (arr: Int32Array, cosBit: number, sr: Int32Array) => void;

	if (h === 8 && w === 8) {
		txszIdx = 1;
		fwdFn = fwdDct8;
	} else if (h === 4 && w === 4) {
		txszIdx = 0;
		fwdFn = fwdDct4;
	} else {
		throw new Error(`Unsupported transform size ${w}x${h}`);
	}

	const cosBitCol = 13;
	const cosBitRow = 13;
	const bd = bitDepth;
	const stages = TXFM_STAGES[txszIdx];
	const shift = FWD_SHIFT[txszIdx];
	const stageRanges = FWD_RANGE_MULT2[txszIdx];

	const stageRangeCol = new Int32Array(stages);
	const stageRangeRow = new Int32Array(stages);
	for (let i = 0; i < stages; i++) {
		stageRangeCol[i] = round2(stageRanges[i], 1) + shift[0] + bd + 1;
	}
	for (let i = 0; i < stages; i++) {
		stageRangeRow[i] =
			round2(stageRanges[stages - 1] + stageRanges[i], 1) +
			shift[0] +
			shift[1] +
			bd +
			1;
	}

	// Process columns (via transpose → row operation → transpose back)
	const transposed = new Int32Array(h * w);
	for (let r = 0; r < h; r++) {
		for (let c = 0; c < w; c++) {
			transposed[c * h + r] = data[r * w + c];
		}
	}

	const colBuf = new Int32Array(h);
	for (let j = 0; j < w; j++) {
		for (let i = 0; i < h; i++) {
			colBuf[i] = transposed[j * h + i];
		}
		roundShiftArray(colBuf, -shift[0]);
		fwdFn(colBuf, cosBitCol, stageRangeCol);
		roundShiftArray(colBuf, -shift[1]);
		for (let i = 0; i < h; i++) {
			transposed[j * h + i] = colBuf[i];
		}
	}

	// Transpose back
	for (let r = 0; r < h; r++) {
		for (let c = 0; c < w; c++) {
			data[r * w + c] = transposed[c * h + r];
		}
	}

	// Process rows
	const rowBuf = new Int32Array(w);
	for (let i = 0; i < h; i++) {
		for (let j = 0; j < w; j++) {
			rowBuf[j] = data[i * w + j];
		}
		fwdFn(rowBuf, cosBitRow, stageRangeRow);
		roundShiftArray(rowBuf, -shift[2]);
		for (let j = 0; j < w; j++) {
			data[i * w + j] = rowBuf[j];
		}
	}
}

export function invTxfm2d(
	data: Int32Array,
	h: number,
	w: number,
	bitDepth = 8,
): void {
	let txszIdx: number;
	let invFn: (arr: Int32Array, cosBit: number, sr: Int32Array) => void;

	if (h === 8 && w === 8) {
		txszIdx = 1;
		invFn = invDct8;
	} else if (h === 4 && w === 4) {
		txszIdx = 0;
		invFn = invDct4;
	} else {
		throw new Error(`Unsupported transform size ${w}x${h}`);
	}

	const cosBitCol = 12;
	const cosBitRow = 12;
	const bd = bitDepth;
	const shift = INV_SHIFT[txszIdx];

	const stages = TXFM_STAGES[txszIdx];
	const stageRangeRow = new Int32Array(stages);
	const stageRangeCol = new Int32Array(stages);
	for (let i = 0; i < stages; i++) {
		stageRangeRow[i] = INV_START_RANGE[txszIdx] + bd + 1;
	}
	for (let i = 0; i < stages; i++) {
		stageRangeCol[i] = INV_START_RANGE[txszIdx] + shift[0] + bd + 1;
	}

	// Process rows
	const rowBuf = new Int32Array(w);
	for (let i = 0; i < h; i++) {
		for (let j = 0; j < w; j++) {
			rowBuf[j] = data[i * w + j];
		}
		clampArray(rowBuf, bd + 8);
		invFn(rowBuf, cosBitCol, stageRangeRow);
		roundShiftArray(rowBuf, -shift[0]);
		for (let j = 0; j < w; j++) {
			data[i * w + j] = rowBuf[j];
		}
	}

	// Process columns (via transpose → row operation → transpose back)
	const transposed = new Int32Array(h * w);
	for (let r = 0; r < h; r++) {
		for (let c = 0; c < w; c++) {
			transposed[c * h + r] = data[r * w + c];
		}
	}

	const colBuf = new Int32Array(h);
	for (let j = 0; j < w; j++) {
		for (let i = 0; i < h; i++) {
			colBuf[i] = transposed[j * h + i];
		}
		clampArray(colBuf, Math.max(bd + 6, 16));
		invFn(colBuf, cosBitRow, stageRangeCol);
		roundShiftArray(colBuf, -shift[1]);
		for (let i = 0; i < h; i++) {
			transposed[j * h + i] = colBuf[i];
		}
	}

	// Transpose back
	for (let r = 0; r < h; r++) {
		for (let c = 0; c < w; c++) {
			data[r * w + c] = transposed[c * h + r];
		}
	}
}

// Walsh-Hadamard Transform for AV1 lossless mode (4x4 only)
// Scaling: dav1d inverse applies >>2 at input + >>1 inside kernel.
// Forward produces unscaled coefficients (no UNIT_QUANT_FACTOR).

// Forward WHT matching dav1d's inv_txfm_add_wht_wht_4x4_c expectations
// Input: 4x4 block in row-major order (data[row*4+col])
// Pass 1 reads columns (stride=4), pass 2 reads rows
export function fwdWht4x4(data: Int32Array): void {
	const output = new Int32Array(16);

	// Pass 1: process each column (stride=4 reads)
	for (let i = 0; i < 4; i++) {
		let a1 = data[0 * 4 + i];
		let b1 = data[1 * 4 + i];
		let c1 = data[2 * 4 + i];
		let d1 = data[3 * 4 + i];

		a1 += b1;
		d1 -= c1;
		const e1 = (a1 - d1) >> 1;
		b1 = e1 - b1;
		c1 = e1 - c1;
		a1 -= c1;
		d1 += b1;

		output[i * 4 + 0] = a1;
		output[i * 4 + 1] = c1;
		output[i * 4 + 2] = d1;
		output[i * 4 + 3] = b1;
	}

	// Pass 2: read columns of intermediate, WHT, write rows of output (transpose)
	for (let i = 0; i < 4; i++) {
		let a1 = output[0 * 4 + i];
		let b1 = output[1 * 4 + i];
		let c1 = output[2 * 4 + i];
		let d1 = output[3 * 4 + i];

		a1 += b1;
		d1 -= c1;
		const e1 = (a1 - d1) >> 1;
		b1 = e1 - b1;
		c1 = e1 - c1;
		a1 -= c1;
		d1 += b1;

		data[i * 4 + 0] = a1;
		data[i * 4 + 1] = c1;
		data[i * 4 + 2] = d1;
		data[i * 4 + 3] = b1;
	}
}

// Exact port of libaom av1_highbd_iwht4x4_16_add_c (av1_inv_txfm2d.c)
// Input: 4x4 WHT coefficients in row-major order
// Pass 1: row transform (ip+=4 reads rows), Pass 2: column transform (ip++ reads columns)
export function invWht4x4(data: Int32Array): void {
	const output = new Int32Array(16);

	// Pass 1: process each row (no input shift — dav1d applies >>2 at 2D level)
	for (let i = 0; i < 4; i++) {
		let a1 = data[i * 4 + 0];
		let c1 = data[i * 4 + 1];
		let d1 = data[i * 4 + 2];
		let b1 = data[i * 4 + 3];

		a1 += c1;
		d1 -= b1;
		const e1 = (a1 - d1) >> 1;
		b1 = e1 - b1;
		c1 = e1 - c1;
		a1 -= b1;
		d1 += c1;

		output[i * 4 + 0] = a1;
		output[i * 4 + 1] = b1;
		output[i * 4 + 2] = c1;
		output[i * 4 + 3] = d1;
	}

	// Pass 2: process each column (ip[0*4..3*4] with ip++)
	for (let i = 0; i < 4; i++) {
		let a1 = output[0 * 4 + i];
		let c1 = output[1 * 4 + i];
		let d1 = output[2 * 4 + i];
		let b1 = output[3 * 4 + i];

		a1 += c1;
		d1 -= b1;
		const e1 = (a1 - d1) >> 1;
		b1 = e1 - b1;
		c1 = e1 - c1;
		a1 -= b1;
		d1 += c1;

		data[0 * 4 + i] = a1;
		data[1 * 4 + i] = b1;
		data[2 * 4 + i] = c1;
		data[3 * 4 + i] = d1;
	}
}
