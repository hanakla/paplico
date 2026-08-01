import type { AvifEncodeOptions, BitDepth } from "../types";
import {
	COLOR_PRIMARIES_CODE,
	MATRIX_COEFFICIENTS_CODE,
	TRANSFER_CHARACTERISTICS_CODE,
} from "../types";

export class ISOBMFFWriter {
	private data: number[] = [];

	public writeU8(value: number): void {
		this.data.push(value & 0xff);
	}

	public writeU16(value: number): void {
		this.data.push((value >> 8) & 0xff);
		this.data.push(value & 0xff);
	}

	public writeU32(value: number): void {
		this.data.push((value >> 24) & 0xff);
		this.data.push((value >> 16) & 0xff);
		this.data.push((value >> 8) & 0xff);
		this.data.push(value & 0xff);
	}

	public writeBytes(bytes: Uint8Array | number[]): void {
		for (const b of bytes) {
			this.data.push(b);
		}
	}

	public writeString(str: string): void {
		for (let i = 0; i < str.length; i++) {
			this.data.push(str.charCodeAt(i));
		}
	}

	public getPosition(): number {
		return this.data.length;
	}

	public markU32(): number {
		const pos = this.data.length;
		this.writeU32(0);
		return pos;
	}

	public patchU32(pos: number, value: number): void {
		this.data[pos] = (value >> 24) & 0xff;
		this.data[pos + 1] = (value >> 16) & 0xff;
		this.data[pos + 2] = (value >> 8) & 0xff;
		this.data[pos + 3] = value & 0xff;
	}

	public openBox(type4cc: string): number {
		const sizePos = this.data.length;
		this.writeU32(0);
		this.writeString(type4cc);
		return sizePos;
	}

	public openFullBox(type4cc: string, version: number, flags: number): number {
		const sizePos = this.data.length;
		this.writeU32(0);
		this.writeString(type4cc);
		this.writeU32((version << 24) | (flags & 0xffffff));
		return sizePos;
	}

	public closeBox(sizePos: number): void {
		const totalSize = this.data.length - sizePos;
		this.patchU32(sizePos, totalSize);
	}

	public finalize(): Uint8Array {
		return new Uint8Array(this.data);
	}
}

function getAv1Profile(bitDepth: BitDepth, chromaSubsampling: string): number {
	if (bitDepth === 12) return 2; // Professional
	if (chromaSubsampling === "4:4:4") return 1; // High
	return 0; // Main (8/10-bit 4:2:0)
}

function getAv1CBytes(
	bitDepth: BitDepth,
	chromaSubsampling: string,
	monochrome: boolean,
): [number, number, number, number] {
	const profile = getAv1Profile(bitDepth, chromaSubsampling);
	const level = 31;

	const byte0 = 0x81;
	const byte1 = (profile << 5) | level;

	const highBitDepth = bitDepth > 8 ? 1 : 0;
	const twelveBit = bitDepth === 12 ? 1 : 0;
	const mono = monochrome ? 1 : 0;
	const subsamplingX = chromaSubsampling === "4:2:0" ? 1 : 0;
	const subsamplingY = chromaSubsampling === "4:2:0" ? 1 : 0;
	const byte2 =
		(highBitDepth << 6) |
		(twelveBit << 5) |
		(mono << 4) |
		(subsamplingX << 3) |
		(subsamplingY << 2);
	const byte3 = 0x00;

	return [byte0, byte1, byte2, byte3];
}

export function packAvif(
	av1Data: Uint8Array,
	options: AvifEncodeOptions,
	alphaAv1Data?: Uint8Array,
): Uint8Array {
	const w = new ISOBMFFWriter();
	const hasAlpha = alphaAv1Data != null && alphaAv1Data.length > 0;

	const bitDepth = options.bitDepth ?? 10;
	const chromaSubsampling = options.chromaSubsampling ?? "4:2:0";
	const colorPrimaries =
		COLOR_PRIMARIES_CODE[options.colorPrimaries ?? "bt2020"];
	const transferCharacteristics =
		TRANSFER_CHARACTERISTICS_CODE[options.transferCharacteristics ?? "pq"];
	const matrixCoefficients =
		MATRIX_COEFFICIENTS_CODE[options.matrixCoefficients ?? "bt2020"];
	const fullRange = options.fullRange ?? true;

	// ftyp box
	const ftypPos = w.openBox("ftyp");
	w.writeString("avif");
	w.writeU32(0);
	w.writeString("avifmif1miafMA1B");
	w.closeBox(ftypPos);

	// meta box
	const metaPos = w.openFullBox("meta", 0, 0);

	// hdlr box
	const hdlrPos = w.openFullBox("hdlr", 0, 0);
	w.writeU32(0);
	w.writeString("pict");
	w.writeU32(0);
	w.writeU32(0);
	w.writeU32(0);
	w.writeString("paplico-avif-hdr\0");
	w.closeBox(hdlrPos);

	// pitm box
	const pitmPos = w.openFullBox("pitm", 0, 0);
	w.writeU16(1);
	w.closeBox(pitmPos);

	// iloc box
	const itemCount = hasAlpha ? 2 : 1;
	const ilocPos = w.openFullBox("iloc", 0, 0);
	w.writeU8(0x44);
	w.writeU8(0x00);
	w.writeU16(itemCount);
	// Item 1 (color)
	w.writeU16(1);
	w.writeU16(0);
	w.writeU16(1);
	const colorPosMarker = w.markU32();
	w.writeU32(av1Data.length);
	// Item 2 (alpha)
	let alphaPosMarker = 0;
	if (hasAlpha) {
		w.writeU16(2);
		w.writeU16(0);
		w.writeU16(1);
		alphaPosMarker = w.markU32();
		w.writeU32(alphaAv1Data.length);
	}
	w.closeBox(ilocPos);

	// iinf box
	const iinfPos = w.openFullBox("iinf", 0, 0);
	w.writeU16(itemCount);
	const infeColorPos = w.openFullBox("infe", 2, 0);
	w.writeU16(1);
	w.writeU16(0);
	w.writeString("av01");
	w.writeString("Color\0");
	w.closeBox(infeColorPos);
	if (hasAlpha) {
		const infeAlphaPos = w.openFullBox("infe", 2, 0);
		w.writeU16(2);
		w.writeU16(0);
		w.writeString("av01");
		w.writeString("Alpha\0");
		w.closeBox(infeAlphaPos);
	}
	w.closeBox(iinfPos);

	// iref box (alpha auxiliary reference)
	if (hasAlpha) {
		const irefPos = w.openFullBox("iref", 0, 0);
		// auxl: from_item_id=2 (alpha) references to_item_id=1 (color)
		const auxlPos = w.openBox("auxl");
		w.writeU16(2); // from_item_ID
		w.writeU16(1); // reference_count
		w.writeU16(1); // to_item_ID
		w.closeBox(auxlPos);
		w.closeBox(irefPos);
	}

	// iprp box
	const iprpPos = w.openBox("iprp");

	// ipco box
	const ipcoPos = w.openBox("ipco");

	// Property 1: ispe (shared between color and alpha)
	const ispePos = w.openFullBox("ispe", 0, 0);
	w.writeU32(options.width);
	w.writeU32(options.height);
	w.closeBox(ispePos);

	// Property 2: pixi for color (3 channels)
	const pixiColorPos = w.openFullBox("pixi", 0, 0);
	w.writeU8(3);
	w.writeU8(bitDepth);
	w.writeU8(bitDepth);
	w.writeU8(bitDepth);
	w.closeBox(pixiColorPos);

	// Property 3: av1C for color
	const av1CColorPos = w.openBox("av1C");
	const [b0, b1, b2, b3] = getAv1CBytes(bitDepth, chromaSubsampling, false);
	w.writeU8(b0);
	w.writeU8(b1);
	w.writeU8(b2);
	w.writeU8(b3);
	w.closeBox(av1CColorPos);

	// Property 4: colr
	const colrPos = w.openBox("colr");
	w.writeString("nclx");
	w.writeU16(colorPrimaries);
	w.writeU16(transferCharacteristics);
	w.writeU16(matrixCoefficients);
	w.writeU8(fullRange ? 0x80 : 0x00);
	w.closeBox(colrPos);

	if (hasAlpha) {
		// Property 5: pixi for alpha (1 channel)
		const pixiAlphaPos = w.openFullBox("pixi", 0, 0);
		w.writeU8(1);
		w.writeU8(bitDepth);
		w.closeBox(pixiAlphaPos);

		// Property 6: av1C for alpha (monochrome)
		const av1CAlphaPos = w.openBox("av1C");
		const [a0, a1, a2, a3] = getAv1CBytes(bitDepth, "4:2:0", true);
		w.writeU8(a0);
		w.writeU8(a1);
		w.writeU8(a2);
		w.writeU8(a3);
		w.closeBox(av1CAlphaPos);

		// Property 7: auxC (auxiliary type)
		const auxCPos = w.openFullBox("auxC", 0, 0);
		w.writeString("urn:mpeg:mpegB:cicp:systems:auxiliary:alpha\0");
		w.closeBox(auxCPos);
	}

	w.closeBox(ipcoPos);

	// ipma box
	const ipmaPos = w.openFullBox("ipma", 0, 0);
	w.writeU32(itemCount);
	// Item 1 (color): properties 1(ispe essential), 2(pixi), 3(av1C essential), 4(colr)
	w.writeU16(1);
	w.writeU8(4);
	w.writeU8(0x81); // ispe essential
	w.writeU8(2);
	w.writeU8(0x83); // av1C essential
	w.writeU8(4);
	if (hasAlpha) {
		// Item 2 (alpha): properties 1(ispe essential), 5(pixi), 6(av1C essential), 7(auxC essential)
		w.writeU16(2);
		w.writeU8(4);
		w.writeU8(0x81); // ispe essential
		w.writeU8(5);
		w.writeU8(0x86); // av1C essential
		w.writeU8(0x87); // auxC essential
	}
	w.closeBox(ipmaPos);

	w.closeBox(iprpPos);
	w.closeBox(metaPos);

	// mdat box
	const mdatPos = w.openBox("mdat");
	const colorPos = w.getPosition();
	w.writeBytes(av1Data);
	let alphaPos = 0;
	if (hasAlpha) {
		alphaPos = w.getPosition();
		w.writeBytes(alphaAv1Data);
	}
	w.closeBox(mdatPos);

	// Patch iloc offsets
	w.patchU32(colorPosMarker, colorPos);
	if (hasAlpha) {
		w.patchU32(alphaPosMarker, alphaPos);
	}

	return w.finalize();
}
