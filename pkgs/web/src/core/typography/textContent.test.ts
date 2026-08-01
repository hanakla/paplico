import { describe, expect, it } from "vitest";
import { createTestTextElement } from "../testUtils/typographyFixtures";
import { splitTextContentAt } from "./textContent";

const contentOf = (text: string) => createTestTextElement(text).content;

const textsOf = (content: ReturnType<typeof contentOf>) =>
	content.paragraphs.map((p) => p.runs.map((r) => r.text).join(""));

describe("splitTextContentAt", () => {
	it("should split inside a run keeping styles and reindexing overrides", () => {
		const content = contentOf("abcdef");
		content.paragraphs[0].runs[0].charOverrides = [
			{ charIndex: 1, rotation: 10 },
			{ charIndex: 4, rotation: 20 },
		];

		const { before, after } = splitTextContentAt(content, 2);

		expect(textsOf(before)).toEqual(["ab"]);
		expect(textsOf(after)).toEqual(["cdef"]);
		expect(before.paragraphs[0].runs[0].charOverrides).toEqual([
			{ charIndex: 1, rotation: 10 },
		]);
		expect(after.paragraphs[0].runs[0].charOverrides).toEqual([
			{ charIndex: 2, rotation: 20 },
		]);
		expect(after.paragraphs[0].runs[0].style.fontSize).toBe(
			content.paragraphs[0].runs[0].style.fontSize,
		);
	});

	it("should consume the boundary newline when splitting at a paragraph edge", () => {
		// Indices: a0 b1 \n2 c3 d4 — split at 2 keeps whole paragraphs
		const { before, after } = splitTextContentAt(contentOf("ab\ncd"), 2);

		expect(textsOf(before)).toEqual(["ab"]);
		expect(textsOf(after)).toEqual(["cd"]);
	});

	it("should split across multiple paragraphs", () => {
		// Indices: a0 b1 \n2 c3 d4 \n5 e6 f7 — split at 4
		const { before, after } = splitTextContentAt(contentOf("ab\ncd\nef"), 4);

		expect(textsOf(before)).toEqual(["ab", "c"]);
		expect(textsOf(after)).toEqual(["d", "ef"]);
	});

	it("should keep both sides structurally valid at the extremes", () => {
		const zero = splitTextContentAt(contentOf("ab"), 0);
		expect(textsOf(zero.before)).toEqual([""]);
		expect(textsOf(zero.after)).toEqual(["ab"]);

		const end = splitTextContentAt(contentOf("ab"), 2);
		expect(textsOf(end.before)).toEqual(["ab"]);
		expect(textsOf(end.after)).toEqual([""]);
		expect(end.after.paragraphs[0].runs[0].style).toBeDefined();
	});
});
