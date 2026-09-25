import { describe, expect, it } from "vitest";
import {
	buildPayload,
	decodePayloadFromHTML,
	encodePayloadToHTML,
	PAPLICO_ELEMENTS_MIME,
	parsePayload,
} from "./Clipboard";

describe("Clipboard HTML encode/decode", () => {
	describe("buildPayload / parsePayload", () => {
		it("should round-trip MIME and data through payload", () => {
			const mime = PAPLICO_ELEMENTS_MIME;
			const data = new Uint8Array([1, 2, 3, 4, 5]);

			const payload = buildPayload(mime, data);
			const result = parsePayload(payload);

			expect(result).not.toBeNull();
			expect(result!.mime).toBe(mime);
			expect(Array.from(result!.data)).toEqual([1, 2, 3, 4, 5]);
		});

		it("should round-trip with arbitrary web custom MIME", () => {
			const mime = "web application/x-custom-format";
			const data = new Uint8Array(256);
			for (let i = 0; i < 256; i++) data[i] = i;

			const payload = buildPayload(mime, data);
			const result = parsePayload(payload);

			expect(result).not.toBeNull();
			expect(result!.mime).toBe(mime);
			expect(Array.from(result!.data)).toEqual(Array.from(data));
		});

		it("should round-trip empty data", () => {
			const mime = PAPLICO_ELEMENTS_MIME;
			const data = new Uint8Array(0);

			const result = parsePayload(buildPayload(mime, data));

			expect(result).not.toBeNull();
			expect(result!.mime).toBe(mime);
			expect(result!.data.length).toBe(0);
		});

		it("should return null for non-PAPL payload", () => {
			const garbage = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);
			expect(parsePayload(garbage)).toBeNull();
		});

		it("should return null for truncated header", () => {
			// Only MAGIC, no mime length
			const truncated = new Uint8Array([0x50, 0x41, 0x50, 0x4c]);
			expect(parsePayload(truncated)).toBeNull();
		});

		it("should return null for MIME without 'web ' prefix", () => {
			const mime = "application/json";
			const mimeBytes = new TextEncoder().encode(mime);
			const payload = new Uint8Array(4 + 2 + mimeBytes.length + 4);
			payload.set([0x50, 0x41, 0x50, 0x4c], 0);
			new DataView(payload.buffer).setUint16(4, mimeBytes.length, false);
			payload.set(mimeBytes, 6);
			new DataView(payload.buffer).setUint32(6 + mimeBytes.length, 0, false);

			expect(parsePayload(payload)).toBeNull();
		});

		it("should return null when declared data length exceeds buffer", () => {
			const mime = PAPLICO_ELEMENTS_MIME;
			const mimeBytes = new TextEncoder().encode(mime);
			const payload = new Uint8Array(4 + 2 + mimeBytes.length + 4);
			payload.set([0x50, 0x41, 0x50, 0x4c], 0);
			new DataView(payload.buffer).setUint16(4, mimeBytes.length, false);
			payload.set(mimeBytes, 6);
			// Declare 999 bytes of data but provide 0
			new DataView(payload.buffer).setUint32(6 + mimeBytes.length, 999, false);

			expect(parsePayload(payload)).toBeNull();
		});
	});

	describe("encodePayloadToHTML / decodePayloadFromHTML", () => {
		it("should round-trip payload through HTML encoding", () => {
			const mime = PAPLICO_ELEMENTS_MIME;
			const data = new Uint8Array([10, 20, 30, 40, 50]);
			const payload = buildPayload(mime, data);

			const html = encodePayloadToHTML(payload);
			const result = decodePayloadFromHTML(html);

			expect(result).not.toBeNull();
			expect(result!.mime).toBe(mime);
			expect(Array.from(result!.data)).toEqual([10, 20, 30, 40, 50]);
		});

		it("should produce an HTML span with data-papl attribute", () => {
			const payload = buildPayload(PAPLICO_ELEMENTS_MIME, new Uint8Array(10));
			const html = encodePayloadToHTML(payload);

			expect(html).toMatch(/^<span data-papl="[^"]+"><\/span>$/);
		});

		it("should handle large data without corruption", () => {
			const data = new Uint8Array(10_000);
			for (let i = 0; i < data.length; i++) data[i] = i % 256;

			const payload = buildPayload(PAPLICO_ELEMENTS_MIME, data);
			const html = encodePayloadToHTML(payload);
			const result = decodePayloadFromHTML(html);

			expect(result).not.toBeNull();
			expect(Array.from(result!.data)).toEqual(Array.from(data));
		});

		it("should return null for HTML without PAPL marker", () => {
			expect(decodePayloadFromHTML("<p>hello</p>")).toBeNull();
		});

		it("should return null for invalid base64 in PAPL marker", () => {
			expect(decodePayloadFromHTML("<!--PAPL:!!!invalid!!!-->")).toBeNull();
		});

		it("should decode PAPL marker embedded in other HTML", () => {
			const mime = PAPLICO_ELEMENTS_MIME;
			const data = new Uint8Array([1, 2, 3]);
			const payload = buildPayload(mime, data);
			const encoded = encodePayloadToHTML(payload);

			const html = `<p>some content</p>${encoded}<p>more content</p>`;
			const result = decodePayloadFromHTML(html);

			expect(result).not.toBeNull();
			expect(result!.mime).toBe(mime);
			expect(Array.from(result!.data)).toEqual([1, 2, 3]);
		});
	});
});
