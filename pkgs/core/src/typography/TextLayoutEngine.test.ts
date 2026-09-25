import { describe, expect, it } from "vitest";
import { closedRectSegments, lineSeg } from "../testUtils/segmentFactory";
import {
	createMockFontManager,
	createTestTextElement as createTextElement,
} from "../testUtils/typographyFixtures";
import { TextLayoutEngine } from "./TextLayoutEngine";

function lineText(line: { chars: Array<{ char: string }> }): string {
	return line.chars.map((c) => c.char).join("");
}

describe("TextLayoutEngine bounds", () => {
	it("does not over-expand non-empty horizontal line by line-height box", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const layout = await engine.layout(createTextElement("A"));

		expect(layout.bounds.minY).toBe(-2);
		expect(layout.bounds.maxY).toBe(8);
		expect(layout.bounds.height).toBe(10);
	});

	it("keeps empty line height in bounds", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const layout = await engine.layout(createTextElement(""));

		expect(layout.bounds.minX).toBe(0);
		expect(layout.bounds.maxX).toBe(0);
		expect(layout.bounds.minY).toBe(-30);
		expect(layout.bounds.maxY).toBe(0);
		expect(layout.bounds.height).toBe(30);
	});
});

describe("TextLayoutEngine wrapping", () => {
	it("should wrap Latin text after whitespace within boxWidth", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const result = await engine.layout(
			createTextElement("aaa bbb ccc", {
				layout: { boxWidth: 40, wordWrap: true, overflow: "hidden" },
			}),
		);

		expect(result.lines.map(lineText)).toEqual(["aaa ", "bbb ", "ccc"]);
		expect(result.lines.map((l) => l.softWrapped)).toEqual([false, true, true]);
		expect(result.hasOverflow).toBe(false);
		expect(result.chars.map((c) => c.charIndex)).toEqual([
			0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
		]);
		// Lines stack downward from the box top (baseline = 0.8 * lineHeight(30))
		expect(result.lines.map((l) => l.y)).toEqual([-24, -54, -84]);
	});

	it("should not start a line with a kinsoku-prohibited character", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const result = await engine.layout(
			createTextElement("ああ、いい", {
				layout: { boxWidth: 20, wordWrap: true, overflow: "hidden" },
			}),
		);

		expect(result.lines.map(lineText)).toEqual(["あ", "あ、", "いい"]);
		for (const line of result.lines) {
			expect(line.chars[0]?.char).not.toBe("、");
		}
	});

	it("should report overflow when lines exceed boxHeight", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const result = await engine.layout(
			createTextElement("a\nb\nc", {
				layout: { boxHeight: 70, overflow: "hidden" },
			}),
		);

		expect(result.lines.map(lineText)).toEqual(["a", "b"]);
		expect(result.hasOverflow).toBe(true);
		expect(result.overflowStartIndex).toBe(4);
	});

	it("should replace the tail with an ellipsis glyph when overflow is ellipsis", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const result = await engine.layout(
			createTextElement("aaaaaa", {
				layout: {
					boxWidth: 40,
					boxHeight: 30,
					wordWrap: true,
					overflow: "ellipsis",
				},
			}),
		);

		expect(result.hasOverflow).toBe(true);
		expect(result.lines).toHaveLength(1);
		const lastChar = result.lines[0].chars.at(-1);
		expect(lastChar?.char).toBe("…");
		expect(lastChar?.synthetic).toBe(true);
		expect(lineText(result.lines[0])).toBe("aaa…");
	});

	it("should keep visible overflow unclipped but still report it", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const result = await engine.layout(
			createTextElement("aaaaaa", {
				layout: { boxWidth: 40, wordWrap: true, overflow: "visible" },
			}),
		);

		expect(result.lines).toHaveLength(1);
		expect(result.chars).toHaveLength(6);
		expect(result.hasOverflow).toBe(true);
	});
});

describe("TextLayoutEngine on-path overflow", () => {
	// Uniformly parameterized straight path: control points at 1/3 and 2/3 so
	// the segment-local t approximation in getPointOnPath maps linearly to length
	const straightPath = [
		lineSeg(
			{ x: 100, y: 0 },
			{
				start: { x: 0, y: 0 },
				cp1: { x: 100 / 3, y: 0 },
				cp2: { x: -100 / 3, y: 0 },
			},
		),
	];

	it("should truncate characters beyond the path length and report overflow", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const result = await engine.layout(
			createTextElement("aaaaaaaaaaaa", {
				axisBinding: {
					mode: "onPath",
					pathObjectId: "p",
					startOffset: 0,
					alignment: "left",
					offsetDistance: 0,
					orientation: "rotate",
				},
			}),
			{ kind: "onPath", segments: straightPath },
		);

		expect(result.chars).toHaveLength(10);
		expect(result.hasOverflow).toBe(true);
		expect(result.overflowStartIndex).toBe(10);
		expect(result.chars[0].x).toBeCloseTo(5);
		expect(result.chars[0].y).toBeCloseTo(0);
	});

	it("should center the text around the startOffset anchor", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const result = await engine.layout(
			createTextElement("aaaa", {
				axisBinding: {
					mode: "onPath",
					pathObjectId: "p",
					startOffset: 0.5,
					alignment: "center",
					offsetDistance: 0,
					orientation: "rotate",
				},
			}),
			{ kind: "onPath", segments: straightPath },
		);

		expect(result.hasOverflow).toBe(false);
		expect(result.chars[0].x).toBeCloseTo(35);
		expect(result.chars.at(-1)?.x).toBeCloseTo(65);
	});
});

describe("TextLayoutEngine inShape", () => {
	it("should wrap lines to the shape width and fit within its height", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const result = await engine.layout(
			createTextElement("aaaaaaaaaaaaaaa", {
				axisBinding: { mode: "inShape", pathObjectId: "p" },
			}),
			{ kind: "inShape", segments: closedRectSegments(0, 0, 100, -100) },
		);

		expect(result.lines.map(lineText)).toEqual(["aaaaaaaaaa", "aaaaa"]);
		expect(result.lines.map((l) => l.y)).toEqual([-24, -54]);
		expect(result.hasOverflow).toBe(false);
	});

	it("should report overflow when the shape height is exceeded", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const result = await engine.layout(
			createTextElement("aaaaaaaaaaaa", {
				axisBinding: { mode: "inShape", pathObjectId: "p" },
			}),
			{ kind: "inShape", segments: closedRectSegments(0, 0, 100, -50) },
		);

		expect(result.lines.map(lineText)).toEqual(["aaaaaaaaaa"]);
		expect(result.hasOverflow).toBe(true);
		expect(result.overflowStartIndex).toBe(10);
	});
});

describe("TextLayoutEngine.layoutFlow", () => {
	const regionLayout = {
		boxWidth: 40,
		boxHeight: 30,
		wordWrap: true,
		overflow: "hidden",
	} as const;

	it("should distribute head content across chained regions", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const head = createTextElement("aaaaaaaaaaaa", {
			id: "r1",
			layout: regionLayout,
		});
		const r2 = createTextElement("", { id: "r2", layout: regionLayout });
		const r3 = createTextElement("", { id: "r3", layout: regionLayout });
		const r4 = createTextElement("", { id: "r4", layout: regionLayout });

		const results = await engine.layoutFlow(head, [
			{ element: head },
			{ element: r2 },
			{ element: r3 },
			{ element: r4 },
		]);

		expect(results.size).toBe(4);
		const g1 = results.get("r1")!;
		const g2 = results.get("r2")!;
		const g3 = results.get("r3")!;
		const g4 = results.get("r4")!;

		expect(g1.chars.map((c) => c.charIndex)).toEqual([0, 1, 2, 3]);
		expect(g1.hasOverflow).toBe(true);
		expect(g2.chars.map((c) => c.charIndex)).toEqual([4, 5, 6, 7]);
		expect(g2.lines[0].softWrapped).toBe(true);
		expect(g3.chars.map((c) => c.charIndex)).toEqual([8, 9, 10, 11]);
		expect(g3.hasOverflow).toBe(false);

		// Empty trailing region still exposes its box bounds for hit testing
		expect(g4.chars).toHaveLength(0);
		expect(g4.hasOverflow).toBe(false);
		expect(g4.bounds.width).toBe(40);
		expect(g4.bounds.height).toBe(30);
	});
});

describe("TextLayoutEngine inShape packing", () => {
	it("should pack lines against the glyph ink band, skipping too-narrow apex bands", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		// Apex-up triangle: width equals |y| (0 at the tip, 100 at the base)
		const triangle = [
			lineSeg({ x: 100, y: -100 }, { start: { x: 50, y: 0 } }),
			lineSeg({ x: 0, y: -100 }),
			lineSeg({ x: 50, y: 0 }, { isClosed: true }),
		];
		const result = await engine.layout(
			createTextElement("aaaaaaaaaaaaaaaaaaaa", {
				axisBinding: { mode: "inShape", pathObjectId: "p" },
			}),
			{ kind: "inShape", segments: triangle },
		);

		// Ink-band evaluation (baseline ±fontSize instead of the full
		// lineHeight band): 1 / 4 / 7 chars instead of the former 1 / 3 / 6
		expect(result.lines.map((l) => l.chars.length)).toEqual([1, 4, 7]);
		// Rows are centered segments of the triangle, not forced at x=50
		expect(result.lines[1].x).toBeGreaterThan(20);
		expect(result.lines[1].x + result.lines[1].width).toBeLessThan(80);
	});
});

describe("TextLayoutEngine vertical regions", () => {
	it("should lay out a vertical fixed-box region as right-to-left columns", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const result = await engine.layout(
			createTextElement("aaaaaa", {
				layout: {
					writingMode: "vertical-rl",
					boxWidth: 40,
					boxHeight: 30,
					wordWrap: true,
					overflow: "hidden",
				},
			}),
		);

		// colWidth=10, column height capacity=30 → 3 chars per column
		expect(result.lines.map((l) => l.chars.length)).toEqual([3, 3]);
		// Columns advance right-to-left (colAdvance = lineHeight 30)
		expect(result.lines[0].x).toBe(30);
		expect(result.lines[1].x).toBe(0);
		// Chars run top-to-bottom inside the column
		const ys = result.lines[0].chars.map((c) => c.y);
		expect(ys[0]).toBeGreaterThan(ys[1]);
		expect(result.hasOverflow).toBe(false);
	});

	it("should compose tate-chu-yoko runs horizontally in one upright cell", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const element = createTextElement("", {
			layout: {
				writingMode: "vertical-rl",
				boxWidth: 40,
				boxHeight: 30,
				wordWrap: true,
				overflow: "hidden",
			},
		});
		const style = element.content.paragraphs[0].runs[0].style;
		element.content.paragraphs[0].runs = [
			{ text: "a", style: { ...style } },
			{ text: "aa", style: { ...style, tateChuYoko: true } },
			{ text: "a", style: { ...style } },
		];

		const result = await engine.layout(element);

		// The 2-char cluster occupies one 10px cell: 10 + 10 + 10 = 30 fits
		// a single column (4 cells would overflow it)
		expect(result.lines.map((l) => l.chars.length)).toEqual([4]);
		const [before, tcy1, tcy2, after] = result.lines[0].chars;
		// Cluster chars sit side by side in the same cell, upright
		expect(tcy1.y).toBe(tcy2.y);
		expect(tcy2.x - tcy1.x).toBeCloseTo(10);
		expect(tcy1.rotation).toBe(0);
		expect(tcy2.rotation).toBe(0);
		// Centered on the 10px column axis (colLeft=30): 25 and 35
		expect(tcy1.x).toBeCloseTo(25);
		expect(tcy2.x).toBeCloseTo(35);
		// Flow resumes one cell below the cluster
		expect(before.y).toBeGreaterThan(tcy1.y);
		expect(after.y).toBeLessThan(tcy1.y);
	});

	it("should compose tate-chu-yoko in unconstrained vertical layout", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const element = createTextElement("", {
			layout: {
				writingMode: "vertical-rl",
				boxWidth: "auto",
				boxHeight: "auto",
				overflow: "visible",
				wordWrap: false,
			},
		});
		const style = element.content.paragraphs[0].runs[0].style;
		element.content.paragraphs[0].runs = [
			{ text: "a", style: { ...style } },
			{ text: "aa", style: { ...style, tateChuYoko: true } },
			{ text: "a", style: { ...style } },
		];

		const result = await engine.layout(element);

		const [before, tcy1, tcy2, after] = result.chars;
		expect(tcy1.y).toBe(tcy2.y);
		expect(tcy2.x - tcy1.x).toBeCloseTo(10);
		expect(tcy1.rotation).toBe(0);
		// The cluster consumes one cell: the following char sits exactly one
		// cell below the char before the cluster minus two advances
		expect(before.y - after.y).toBeCloseTo(20);
	});

	it("should report overflow when vertical columns exceed the box width", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const result = await engine.layout(
			createTextElement("aaaaaaaa", {
				layout: {
					writingMode: "vertical-rl",
					boxWidth: 40,
					boxHeight: 30,
					wordWrap: true,
					overflow: "hidden",
				},
			}),
		);

		expect(result.chars).toHaveLength(6);
		expect(result.hasOverflow).toBe(true);
		expect(result.overflowStartIndex).toBe(6);
	});

	it("should flow vertical area text inside a closed shape", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const result = await engine.layout(
			createTextElement("aaaaaaaaaaaa", {
				layout: {
					writingMode: "vertical-rl",
					boxWidth: "auto",
					boxHeight: "auto",
					overflow: "hidden",
					wordWrap: true,
				},
				axisBinding: { mode: "inShape", pathObjectId: "p" },
			}),
			{ kind: "inShape", segments: closedRectSegments(0, 0, 100, -100) },
		);

		// Column height 100 → 10 chars; first column at the shape's right edge
		expect(result.lines.map((l) => l.chars.length)).toEqual([10, 2]);
		expect(result.lines[0].x).toBeCloseTo(90);
		expect(result.hasOverflow).toBe(false);
	});

	it("should flow a chain from a horizontal head into a vertical region", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const head = createTextElement("aaaaaaaa", {
			id: "head",
			layout: {
				writingMode: "horizontal-tb",
				boxWidth: 40,
				boxHeight: 30,
				wordWrap: true,
				overflow: "hidden",
			},
		});
		const tail = createTextElement("", {
			id: "tail",
			layout: {
				writingMode: "vertical-rl",
				boxWidth: 40,
				boxHeight: 30,
				wordWrap: true,
				overflow: "hidden",
			},
		});

		const results = await engine.layoutFlow(head, [
			{ element: head },
			{ element: tail },
		]);

		const headResult = results.get("head")!;
		const tailResult = results.get("tail")!;
		expect(headResult.chars.map((c) => c.charIndex)).toEqual([0, 1, 2, 3]);
		expect(tailResult.chars.map((c) => c.charIndex)).toEqual([4, 5, 6, 7]);
		// Vertical continuation: two columns of 3 + 1
		expect(tailResult.lines.map((l) => l.chars.length)).toEqual([3, 1]);
		expect(tailResult.hasOverflow).toBe(false);
	});
});

describe("TextLayoutEngine per-line leading", () => {
	it("should advance each wrapped line by the max leading of its own chars", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const element = createTextElement("aaaa", {
			layout: {
				writingMode: "horizontal-tb",
				boxWidth: 20,
				boxHeight: 200,
				wordWrap: true,
				overflow: "hidden",
			},
		});
		const [para] = element.content.paragraphs;
		const baseStyle = para.runs[0].style;
		para.runs = [
			{ text: "aa", style: { ...baseStyle } },
			{ text: "aa", style: { ...baseStyle, lineHeight: 2 } },
		];

		const result = await engine.layout(element);

		// Line 2 advances by its own leading (10px font x 2 = 20px),
		// not the paragraph max (30px)
		expect(result.lines).toHaveLength(2);
		expect(result.lines[0].y - result.lines[1].y).toBeCloseTo(20);
	});

	it("should advance each vertical column by the max leading of its own chars", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const element = createTextElement("aaaa", {
			layout: {
				writingMode: "vertical-rl",
				boxWidth: 100,
				boxHeight: 20,
				wordWrap: true,
				overflow: "hidden",
			},
		});
		const [para] = element.content.paragraphs;
		const baseStyle = para.runs[0].style;
		para.runs = [
			{ text: "aa", style: { ...baseStyle } },
			{ text: "aa", style: { ...baseStyle, lineHeight: 2 } },
		];

		const result = await engine.layout(element);

		expect(result.lines).toHaveLength(2);
		expect(result.lines[0].x - result.lines[1].x).toBeCloseTo(20);
	});

	it("should advance unconstrained vertical columns by each column's own leading", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const element = createTextElement("a", {
			layout: {
				writingMode: "vertical-rl",
				boxWidth: "auto",
				boxHeight: "auto",
				wordWrap: false,
				overflow: "visible",
			},
		});
		const [para] = element.content.paragraphs;
		element.content.paragraphs.push({
			...para,
			runs: [{ text: "a", style: { ...para.runs[0].style, lineHeight: 2 } }],
		});

		const result = await engine.layout(element);

		// Column 2 advances by its own leading (20px), not the default (30px)
		expect(result.lines).toHaveLength(2);
		expect(result.lines[0].x - result.lines[1].x).toBeCloseTo(20);
	});
});

describe("TextLayoutEngine letter spacing", () => {
	it("should advance horizontal chars by the run's tracking", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const element = createTextElement("aa");
		element.content.paragraphs[0].runs[0].style.letterSpacing = 0.5;

		const result = await engine.layout(element);

		// 10px advance + 0.5em × 10px tracking = 15px between chars
		expect(result.chars[1].x - result.chars[0].x).toBeCloseTo(15);
	});

	it("should advance vertical chars by the run's tracking", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const element = createTextElement("aa", {
			layout: {
				writingMode: "vertical-rl",
				boxWidth: "auto",
				boxHeight: "auto",
				wordWrap: false,
				overflow: "visible",
			},
		});
		element.content.paragraphs[0].runs[0].style.letterSpacing = 0.5;

		const result = await engine.layout(element);

		expect(result.chars[0].y - result.chars[1].y).toBeCloseTo(15);
	});
});

describe("TextLayoutEngine char touch overrides", () => {
	it("should offset a char without moving its neighbours", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const element = createTextElement("aa");
		element.content.paragraphs[0].runs[0].charOverrides = [
			{ charIndex: 0, offsetX: 5, offsetY: 7 },
		];

		const result = await engine.layout(element);

		expect(result.chars[0].x).toBeCloseTo(5);
		expect(result.chars[0].y).toBeCloseTo(7);
		// The pen advance ignores the visual offset: neighbours stay put
		expect(result.chars[1].x).toBeCloseTo(10);
		expect(result.chars[1].y).toBeCloseTo(0);
	});

	it("should rotate a char's glyph around its advance midpoint", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const element = createTextElement("a");
		element.content.paragraphs[0].runs[0].charOverrides = [
			{ charIndex: 0, rotation: 180 },
		];

		const result = await engine.layout(element);

		expect(result.chars[0].rotation).toBeCloseTo(Math.PI);
		// char.x/y stays the unrotated pen position
		expect(result.chars[0].x).toBeCloseTo(0);
		// Mock glyph start (0,-1) placed at (0,-1) spins 180° about the pivot
		// (advance midpoint 5,0) → (10,1)
		const seg = result.chars[0].glyphPath[0];
		expect(seg.start?.x).toBeCloseTo(10);
		expect(seg.start?.y).toBeCloseTo(1);
	});

	it("should shear a char's glyph via skewX without moving neighbours", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const element = createTextElement("aa");
		element.content.paragraphs[0].runs[0].charOverrides = [
			{ charIndex: 0, skewX: 45 },
		];

		const result = await engine.layout(element);

		// Mock glyph start (0,-1) sheared by skewX=45° (kx=tan45=1):
		// x' = x + kx·y = 0 + 1·(-1) = -1, y unchanged → (-1,-1)
		const seg = result.chars[0].glyphPath[0];
		expect(seg.start?.x).toBeCloseTo(-1);
		expect(seg.start?.y).toBeCloseTo(-1);
		// Skew does not change the pen advance: neighbour stays put
		expect(result.chars[1].x).toBeCloseTo(10);
	});

	it("should apply baselineShift on the cross axis per writing mode", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());

		const horizontal = createTextElement("a");
		horizontal.content.paragraphs[0].runs[0].charOverrides = [
			{ charIndex: 0, baselineShift: 4 },
		];
		const hResult = await engine.layout(horizontal);
		expect(hResult.chars[0].y).toBeCloseTo(4);
		expect(hResult.chars[0].x).toBeCloseTo(0);

		const verticalLayout = {
			writingMode: "vertical-rl",
			boxWidth: "auto",
			boxHeight: "auto",
			wordWrap: false,
			overflow: "visible",
		} as const;
		const vPlain = createTextElement("a", { layout: verticalLayout });
		const vShifted = createTextElement("a", { layout: verticalLayout });
		vShifted.content.paragraphs[0].runs[0].charOverrides = [
			{ charIndex: 0, baselineShift: 4 },
		];
		const vBase = await engine.layout(vPlain);
		const vResult = await engine.layout(vShifted);
		expect(vResult.chars[0].x - vBase.chars[0].x).toBeCloseTo(4);
		expect(vResult.chars[0].y).toBeCloseTo(vBase.chars[0].y);
	});

	it("should include offset chars in the layout bounds", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const plain = createTextElement("a");
		const shifted = createTextElement("a");
		shifted.content.paragraphs[0].runs[0].charOverrides = [
			{ charIndex: 0, offsetY: 100 },
		];

		const base = await engine.layout(plain);
		const result = await engine.layout(shifted);

		expect(result.bounds.maxY - base.bounds.maxY).toBeCloseTo(100);
	});
});

describe("TextLayoutEngine rotated-glyph advance", () => {
	it("should widen both neighbour gaps by the rotated footprint", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const element = createTextElement("aaa");
		element.content.paragraphs[0].runs[0].charOverrides = [
			{ charIndex: 1, rotation: 45 },
		];

		const result = await engine.layout(element);

		// 10×10 em box at 45°: projection 10√2 ≈ 14.142, extra ≈ 4.142.
		// The rotated char centers in its widened cell; the next char shifts
		// by the full extra
		const extra = 10 * Math.SQRT2 - 10;
		expect(result.chars[0].x).toBeCloseTo(0);
		expect(result.chars[1].x).toBeCloseTo(10 + extra / 2);
		expect(result.chars[2].x).toBeCloseTo(20 + extra);
	});

	it("should not change advances for unrotated chars", async () => {
		const engine = new TextLayoutEngine(createMockFontManager());
		const element = createTextElement("aa");
		element.content.paragraphs[0].runs[0].charOverrides = [
			{ charIndex: 0, baselineShift: 5 },
		];

		const result = await engine.layout(element);

		expect(result.chars[1].x).toBeCloseTo(10);
	});
});
