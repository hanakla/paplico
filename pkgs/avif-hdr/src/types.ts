export type ColorPrimaries = "bt709" | "bt2020" | "display-p3";
export type TransferCharacteristics = "srgb" | "pq" | "hlg" | "linear";
export type MatrixCoefficients = "bt709" | "bt2020";
export type ChromaSubsampling = "4:2:0" | "4:4:4";
export type BitDepth = 8 | 10 | 12;
export type InputColorSpace =
	| "srgb-linear"
	| "display-p3-linear"
	| "bt2020-linear"
	| "srgb"
	| "display-p3";

export interface AvifEncodeOptions {
	width: number;
	height: number;
	bitDepth?: BitDepth;
	chromaSubsampling?: ChromaSubsampling;
	colorPrimaries?: ColorPrimaries;
	transferCharacteristics?: TransferCharacteristics;
	matrixCoefficients?: MatrixCoefficients;
	fullRange?: boolean;
	qp?: number;
	/** Color space of Float32Array RGBA input. Default: "srgb-linear" */
	inputColorSpace?: InputColorSpace;
	/** Peak luminance for PQ encoding (cd/m²). Default: 203 (SDR reference white) */
	maxNits?: number;
}

export interface PlanarYuvData {
	y: Uint16Array;
	u: Uint16Array;
	v: Uint16Array;
	alpha?: Uint16Array;
	width: number;
	height: number;
	bitDepth: BitDepth;
	chromaSubsampling: ChromaSubsampling;
}

// ITU-T H.273 numeric codes
export const COLOR_PRIMARIES_CODE: Record<ColorPrimaries, number> = {
	bt709: 1,
	bt2020: 9,
	"display-p3": 12,
};

export const TRANSFER_CHARACTERISTICS_CODE: Record<
	TransferCharacteristics,
	number
> = {
	srgb: 13,
	pq: 16,
	hlg: 18,
	linear: 8,
};

export const MATRIX_COEFFICIENTS_CODE: Record<MatrixCoefficients, number> = {
	bt709: 1,
	bt2020: 9,
};
