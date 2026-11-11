import { describe, expect, it } from "vitest";
import type {
	FillAppearance,
	FillParams,
	Filter,
	StrokeAppearance,
	TextStyle,
} from "../schema";
import { resolveOutlinedTextPaint } from "./textPaint";

describe("resolveOutlinedTextPaint", () => {
	it("should put the fill every glyph shares on the group so a gradient spans the text", () => {
		const { groupFilters, glyphFilters } = resolveOutlinedTextPaint({
			elementFilters: [contentAppearance()],
			defaultStyle: textStyle({ fill: red }),
			runFills: [undefined, undefined],
		});

		expect(groupFilters.map((f) => f.processor)).toEqual(["content", "fill"]);
		expect(fillOf(groupFilters[1])).toEqual(red);
		expect(glyphFilters).toEqual([[], []]);
	});

	it("should keep the fills on the glyphs when runs are filled differently", () => {
		const { groupFilters, glyphFilters } = resolveOutlinedTextPaint({
			elementFilters: [contentAppearance()],
			defaultStyle: textStyle({ fill: red }),
			runFills: [blue, undefined],
		});

		expect(groupFilters.map((f) => f.processor)).toEqual(["content"]);
		expect(glyphFilters.map((filters) => fillOf(filters[0]))).toEqual([
			blue,
			red,
		]);
	});

	it("should carry the text's fill and stroke appearances onto the group in stack order", () => {
		const { groupFilters, glyphFilters } = resolveOutlinedTextPaint({
			elementFilters: [fillAppearance(blue), contentAppearance(), stroke()],
			defaultStyle: textStyle({ fill: red }),
			runFills: [undefined],
		});

		expect(groupFilters.map((f) => f.processor)).toEqual([
			"fill",
			"content",
			"fill",
			"stroke",
		]);
		expect(fillOf(groupFilters[0])).toEqual(blue);
		expect(fillOf(groupFilters[2])).toEqual(red);
		expect(glyphFilters).toEqual([[]]);
	});

	it("should stroke the group with the default style's stroke", () => {
		const { groupFilters } = resolveOutlinedTextPaint({
			elementFilters: [contentAppearance()],
			defaultStyle: textStyle({ fill: red, stroke: blue, strokeWidth: 4 }),
			runFills: [undefined],
		});

		const strokeEntry = groupFilters.at(-1) as StrokeAppearance;
		expect(strokeEntry.processor).toBe("stroke");
		expect(strokeEntry.paramData.params.strokeColor).toEqual(blue);
	});

	it("should give every stored entry its own uid", () => {
		const { groupFilters } = resolveOutlinedTextPaint({
			elementFilters: [fillAppearance(blue), contentAppearance(), stroke()],
			defaultStyle: textStyle({ fill: red }),
			runFills: [undefined],
		});

		const uids = groupFilters.map((f) => f.uid);
		expect(uids.every(Boolean)).toBe(true);
		expect(new Set(uids).size).toBe(uids.length);
		expect(uids).not.toContain("app-fill");
	});
});

const red = {
	type: "solid",
	color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
} as const satisfies FillParams["fill"];
const blue = {
	type: "solid",
	color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 },
} as const satisfies FillParams["fill"];

function fillOf(filter: Filter | undefined): FillParams["fill"] | undefined {
	return (filter as FillAppearance | undefined)?.paramData.params.fill;
}

function textStyle(overrides: Partial<TextStyle>): TextStyle {
	return {
		fontFamily: "Test",
		fontSource: { loaderId: "google", fontId: "Test" },
		fontSize: 16,
		fontWeight: 400,
		fontStyle: "normal",
		fill: null,
		underline: false,
		strikethrough: false,
		letterSpacing: 0,
		baselineShift: 0,
		...overrides,
	};
}

function contentAppearance(): Filter {
	return {
		uid: "app-content",
		processor: "content",
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: {} },
	};
}

function fillAppearance(fill: FillParams["fill"]): Filter {
	return {
		uid: "app-fill",
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: { fill } },
	};
}

function stroke(): Filter {
	return {
		uid: "app-stroke",
		processor: "stroke",
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: { strokeColor: blue } },
	};
}
