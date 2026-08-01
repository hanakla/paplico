import { describe, expect, it } from "vitest";
import { BitWriter } from "./bitwriter";

describe("BitWriter", () => {
	it("should write individual bits MSB-first", () => {
		const w = new BitWriter();
		w.writeBit(1);
		w.writeBit(0);
		w.writeBit(1);
		w.writeBit(0);
		w.writeBit(1);
		w.writeBit(0);
		w.writeBit(1);
		w.writeBit(0);
		const result = w.finalize();
		expect(result).toEqual(new Uint8Array([0b10101010]));
	});

	it("should write multi-bit values", () => {
		const w = new BitWriter();
		w.writeBits(0b110, 3);
		w.writeBits(0b01010, 5);
		const result = w.finalize();
		expect(result).toEqual(new Uint8Array([0b11001010]));
	});

	it("should handle partial bytes on finalize", () => {
		const w = new BitWriter();
		w.writeBit(1);
		w.writeBit(1);
		const result = w.finalize();
		// 11000000 (remaining bits padded with 0)
		expect(result).toEqual(new Uint8Array([0b11000000]));
	});

	it("should write booleans", () => {
		const w = new BitWriter();
		w.writeBool(true);
		w.writeBool(false);
		w.writeBool(true);
		w.writeBool(true);
		w.writeBool(false);
		w.writeBool(false);
		w.writeBool(false);
		w.writeBool(true);
		const result = w.finalize();
		expect(result).toEqual(new Uint8Array([0b10110001]));
	});

	it("should byte-align correctly", () => {
		const w = new BitWriter();
		w.writeBit(1);
		w.writeBit(0);
		w.writeBit(1);
		w.byteAlign();
		w.writeBits(0xff, 8);
		const result = w.finalize();
		expect(result).toEqual(new Uint8Array([0b10100000, 0xff]));
	});

	it("should handle exact byte boundary without double-pushing", () => {
		const w = new BitWriter();
		w.writeBits(0xab, 8);
		w.byteAlign(); // already aligned, should not push extra byte
		w.writeBits(0xcd, 8);
		const result = w.finalize();
		expect(result).toEqual(new Uint8Array([0xab, 0xcd]));
	});

	it("should write 16-bit values across byte boundaries", () => {
		const w = new BitWriter();
		w.writeBits(0xbeef, 16);
		const result = w.finalize();
		expect(result).toEqual(new Uint8Array([0xbe, 0xef]));
	});
});
