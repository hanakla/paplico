import { describe, expect, it } from "vitest";
import { encodeLeb128 } from "./leb128";

describe("encodeLeb128", () => {
	it("should encode 0", () => {
		expect(encodeLeb128(0)).toEqual(new Uint8Array([0]));
	});

	it("should encode values < 128 as single byte", () => {
		expect(encodeLeb128(1)).toEqual(new Uint8Array([1]));
		expect(encodeLeb128(127)).toEqual(new Uint8Array([127]));
	});

	it("should encode 128 as two bytes", () => {
		// 128 = 0b10000000 → LEB128: [0x00 | 0x80, 0x01] = [0x80, 0x01]
		expect(encodeLeb128(128)).toEqual(new Uint8Array([0x80, 0x01]));
	});

	it("should encode 300 as two bytes", () => {
		// 300 = 0b100101100 → LEB128: [0x2c | 0x80, 0x02] = [0xac, 0x02]
		expect(encodeLeb128(300)).toEqual(new Uint8Array([0xac, 0x02]));
	});

	it("should encode large values", () => {
		// 16384 = 0x4000 → LEB128: [0x80, 0x80, 0x01]
		expect(encodeLeb128(16384)).toEqual(new Uint8Array([0x80, 0x80, 0x01]));
	});
});
