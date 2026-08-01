import { describe, expect, it } from "vitest";
import { canBreakBetween } from "./lineBreak";

describe("canBreakBetween", () => {
	it("should allow break after whitespace between Latin words", () => {
		expect(canBreakBetween(" ", "w")).toBe(true);
	});

	it("should not allow break inside a Latin word", () => {
		expect(canBreakBetween("w", "o")).toBe(false);
	});

	it("should not allow break before whitespace", () => {
		expect(canBreakBetween("d", " ")).toBe(false);
	});

	it("should allow break between CJK characters", () => {
		expect(canBreakBetween("あ", "い")).toBe(true);
		expect(canBreakBetween("漢", "字")).toBe(true);
	});

	it("should allow break between Latin and CJK boundary", () => {
		expect(canBreakBetween("a", "あ")).toBe(true);
		expect(canBreakBetween("あ", "a")).toBe(true);
	});

	it("should not allow break before line-start prohibited characters", () => {
		expect(canBreakBetween("す", "。")).toBe(false);
		expect(canBreakBetween("す", "、")).toBe(false);
		expect(canBreakBetween("い", "ー")).toBe(false);
		expect(canBreakBetween("や", "っ")).toBe(false);
		expect(canBreakBetween("た", "」")).toBe(false);
	});

	it("should not allow break after line-end prohibited characters", () => {
		expect(canBreakBetween("「", "こ")).toBe(false);
		expect(canBreakBetween("（", "か")).toBe(false);
		expect(canBreakBetween("【", "重")).toBe(false);
	});

	it("should not allow break with empty inputs", () => {
		expect(canBreakBetween("", "a")).toBe(false);
		expect(canBreakBetween("a", "")).toBe(false);
	});
});
