import { describe, expect, it } from "vitest";
import { ISOBMFFWriter, packAvif } from "./isobmff";

describe("ISOBMFFWriter", () => {
	it("should write big-endian u32", () => {
		const w = new ISOBMFFWriter();
		w.writeU32(0x01020304);
		const result = w.finalize();
		expect(result).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
	});

	it("should write big-endian u16", () => {
		const w = new ISOBMFFWriter();
		w.writeU16(0xabcd);
		const result = w.finalize();
		expect(result).toEqual(new Uint8Array([0xab, 0xcd]));
	});

	it("should open and close a box with correct size", () => {
		const w = new ISOBMFFWriter();
		const pos = w.openBox("test");
		w.writeU32(0xdeadbeef);
		w.closeBox(pos);
		const result = w.finalize();

		// Box: 4 (size) + 4 (type) + 4 (payload) = 12 bytes total
		expect(result.length).toBe(12);
		// Size field should be 12 in big-endian
		expect(result[0]).toBe(0);
		expect(result[1]).toBe(0);
		expect(result[2]).toBe(0);
		expect(result[3]).toBe(12);
		// Type should be "test"
		expect(
			String.fromCharCode(result[4], result[5], result[6], result[7]),
		).toBe("test");
	});

	it("should handle nested boxes", () => {
		const w = new ISOBMFFWriter();
		const outer = w.openBox("outr");
		const inner = w.openBox("innr");
		w.writeU8(0x42);
		w.closeBox(inner);
		w.closeBox(outer);
		const result = w.finalize();

		// Inner: 4+4+1 = 9, Outer: 4+4+9 = 17
		expect(result.length).toBe(17);
		// Outer size
		expect(
			(result[0] << 24) | (result[1] << 16) | (result[2] << 8) | result[3],
		).toBe(17);
		// Inner size (at offset 8)
		expect(
			(result[8] << 24) | (result[9] << 16) | (result[10] << 8) | result[11],
		).toBe(9);
	});

	it("should patch u32 at marker position", () => {
		const w = new ISOBMFFWriter();
		const marker = w.markU32();
		w.writeU32(0x11111111);
		w.patchU32(marker, 0xaabbccdd);
		const result = w.finalize();

		expect(result[0]).toBe(0xaa);
		expect(result[1]).toBe(0xbb);
		expect(result[2]).toBe(0xcc);
		expect(result[3]).toBe(0xdd);
	});
});

describe("packAvif", () => {
	it("should produce a valid AVIF container starting with ftyp", () => {
		const dummyAv1Data = new Uint8Array([0x01, 0x02, 0x03]);
		const result = packAvif(dummyAv1Data, {
			width: 64,
			height: 64,
			bitDepth: 10,
			colorPrimaries: "bt2020",
			transferCharacteristics: "pq",
			matrixCoefficients: "bt2020",
			fullRange: true,
		});

		// Verify ftyp box: first 4 bytes = size, next 4 = "ftyp"
		const ftypType = String.fromCharCode(
			result[4],
			result[5],
			result[6],
			result[7],
		);
		expect(ftypType).toBe("ftyp");

		// Major brand should be "avif"
		const brand = String.fromCharCode(
			result[8],
			result[9],
			result[10],
			result[11],
		);
		expect(brand).toBe("avif");

		// Container should contain mdat with our AV1 data
		const mdatStr = "mdat";
		let mdatFound = false;
		for (let i = 4; i < result.length - 3; i++) {
			if (
				String.fromCharCode(
					result[i],
					result[i + 1],
					result[i + 2],
					result[i + 3],
				) === mdatStr
			) {
				mdatFound = true;
				break;
			}
		}
		expect(mdatFound).toBe(true);
	});

	it("should embed HDR color metadata in colr box", () => {
		const dummyAv1Data = new Uint8Array([0x00]);
		const result = packAvif(dummyAv1Data, {
			width: 32,
			height: 32,
			bitDepth: 10,
			colorPrimaries: "bt2020",
			transferCharacteristics: "pq",
			matrixCoefficients: "bt2020",
			fullRange: true,
		});

		// Find "nclx" in the output to verify colr box
		let nclxOffset = -1;
		for (let i = 0; i < result.length - 3; i++) {
			if (
				result[i] === 0x6e && // 'n'
				result[i + 1] === 0x63 && // 'c'
				result[i + 2] === 0x6c && // 'l'
				result[i + 3] === 0x78 // 'x'
			) {
				nclxOffset = i;
				break;
			}
		}
		expect(nclxOffset).toBeGreaterThan(0);

		// After "nclx": color_primaries(2) = 9 (BT.2020)
		const cp = (result[nclxOffset + 4] << 8) | result[nclxOffset + 5];
		expect(cp).toBe(9);

		// transfer_characteristics(2) = 16 (PQ)
		const tc = (result[nclxOffset + 6] << 8) | result[nclxOffset + 7];
		expect(tc).toBe(16);

		// matrix_coefficients(2) = 9 (BT.2020)
		const mc = (result[nclxOffset + 8] << 8) | result[nclxOffset + 9];
		expect(mc).toBe(9);

		// full_range = 0x80
		expect(result[nclxOffset + 10]).toBe(0x80);
	});
});
