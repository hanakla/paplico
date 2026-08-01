import { describe, expect, it } from "vitest";
import { toHalfWidth } from "../string";

describe("toHalfWidth", () => {
	it("should convert full-width alphanumerics to half-width", () => {
		expect(toHalfWidth("ｂｌｕｒ１２３")).toBe("blur123");
	});

	it("should convert full-width punctuation and ideographic space", () => {
		expect(toHalfWidth("（ぼかし）　ガウス！")).toBe("(ぼかし) ガウス!");
	});

	it("should leave half-width input and kana untouched", () => {
		expect(toHalfWidth("blur ぼかし カナ")).toBe("blur ぼかし カナ");
	});
});
