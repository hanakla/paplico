import { describe, expect, it, vi } from "vitest";
import {
	createDefaultColor,
	createIdentityTransform,
} from "../document/factory";
import type { ElementTransform, FillAppearance, TextElement } from "../schema";
import { closedRectSegments, lineSeg } from "../testUtils/segmentFactory";
import {
	createMockFontManager,
	createTestTextElement,
} from "../testUtils/typographyFixtures";
import { calculateLocalElementBounds } from "../utils/geometry/bounds";
import {
	applyTransformToPoint,
	computeTransformOrigin,
	cursorLocalToWorld,
} from "../utils/geometry/geometry";
import {
	type LayoutedChar,
	type LayoutResult,
	TextLayoutEngine,
} from "./TextLayoutEngine";
import { TextRenderer } from "./TextRenderer";

function createTextElement(): TextElement {
	return {
		type: "text",
		id: "text-1",
		x: 100,
		y: 200,
		content: {
			paragraphs: [
				{
					runs: [
						{
							text: "A",
							style: {
								fontFamily: "Test",
								fontSource: {
									type: "google",
									family: "Inter",
									variants: ["400"],
								},
								fontSize: 10,
								fontWeight: 400,
								fontStyle: "normal",
								fill: null,
								underline: false,
								strikethrough: false,
								letterSpacing: 0,
								baselineShift: 0,
							},
						},
					],
					alignment: "left",
					lineHeight: 1.2,
					indent: 0,
					spacing: { before: 0, after: 0 },
				},
			],
		},
		defaultStyle: {
			fontFamily: "Test",
			fontSource: { type: "google", family: "Inter", variants: ["400"] },
			fontSize: 10,
			fontWeight: 400,
			fontStyle: "normal",
			fill: null,
			underline: false,
			strikethrough: false,
			letterSpacing: 0,
			baselineShift: 0,
		},
		layout: {
			writingMode: "horizontal-tb",
			boxWidth: "auto",
			boxHeight: "auto",
			overflow: "visible",
			wordWrap: false,
		},
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}

function createLayoutChar(
	charIndex: number,
	x: number,
	y: number,
	advanceWidth: number,
	options?: {
		glyphPath?: LayoutedChar["glyphPath"];
		fontSize?: number;
		tateChuYoko?: boolean;
	},
): LayoutedChar {
	return {
		char: "A",
		charIndex,
		runIndex: 0,
		paragraphIndex: 0,
		x,
		y,
		rotation: 0,
		fontSize: options?.fontSize ?? 10,
		font: {} as LayoutedChar["font"],
		glyphPath: options?.glyphPath ?? [],
		advanceWidth,
		kerningOffset: 0,
		sizeScale: 1,
		tateChuYoko: options?.tateChuYoko,
	};
}

function createRenderer(layout: LayoutResult): TextRenderer {
	const layoutEngine = {
		layout: vi.fn(async () => layout),
	} as unknown as TextLayoutEngine;
	return new TextRenderer(layoutEngine);
}

describe("TextRenderer.hitTestCharacter", () => {
	// Layout: 3 lines, each height=12, chars with advanceWidth=10, fontSize=10
	// Line 0: y=0,   chars [0,1] at x=0,10
	// Line 1: y=-12, chars [3,4] at x=0,10 (charIndex 3,4 accounting for newline)
	// Line 2: y=-24, chars [6,7] at x=0,10
	function createThreeLineLayout() {
		const c0 = createLayoutChar(0, 0, 0, 10);
		const c1 = createLayoutChar(1, 10, 0, 10);
		const c3 = createLayoutChar(3, 0, -12, 10);
		const c4 = createLayoutChar(4, 10, -12, 10);
		const c6 = createLayoutChar(6, 0, -24, 10);
		const c7 = createLayoutChar(7, 10, -24, 10);
		return {
			chars: [c0, c1, c3, c4, c6, c7],
			lines: [
				{
					chars: [c0, c1],
					width: 20,
					height: 12,
					baseline: 8,
					x: 0,
					y: 0,
					paragraphIndex: 0,
					softWrapped: false,
				},
				{
					chars: [c3, c4],
					width: 20,
					height: 12,
					baseline: 8,
					x: 0,
					y: -12,
					paragraphIndex: 0,
					softWrapped: false,
				},
				{
					chars: [c6, c7],
					width: 20,
					height: 12,
					baseline: 8,
					x: 0,
					y: -24,
					paragraphIndex: 0,
					softWrapped: false,
				},
			],
			bounds: { minX: 0, minY: -36, maxX: 20, maxY: 0, width: 20, height: 36 },
			hasOverflow: false,
		};
	}

	it("should select correct char on line 1 (click left half)", async () => {
		const layout = createThreeLineLayout();
		const renderer = createRenderer(layout);
		// Click at x=3 (left half of char0), y=2 (within line 0 hit area [8, -4])
		const index = await renderer.hitTestCharacter(createTextElement(), 3, 2);
		expect(index).toBe(0);
	});

	it("should select correct char on line 1 (click right half)", async () => {
		const layout = createThreeLineLayout();
		const renderer = createRenderer(layout);
		// Click at x=7 (right half of char0), y=2 (within line 0 hit area [8, -4])
		const index = await renderer.hitTestCharacter(createTextElement(), 7, 2);
		expect(index).toBe(1);
	});

	it("should select char on line 3 correctly", async () => {
		const layout = createThreeLineLayout();
		const renderer = createRenderer(layout);
		// Click at x=5 (left half of char6), y=-22 (within line 2 hit area [-16, -28])
		const index = await renderer.hitTestCharacter(createTextElement(), 5, -22);
		expect(index).toBe(7);
	});

	it("should return line-end index when clicking after last char in line", async () => {
		const layout = createThreeLineLayout();
		const renderer = createRenderer(layout);
		// Click at x=40 (after last char), y=2 (line 0 hit area [8, -4])
		const index = await renderer.hitTestCharacter(createTextElement(), 40, 2);
		expect(index).toBe(2);
	});

	it("should return line-start index when clicking before first char", async () => {
		const layout = createThreeLineLayout();
		const renderer = createRenderer(layout);
		// Click at x=-20 (before first char), y=2 (line 0 hit area [8, -4])
		const index = await renderer.hitTestCharacter(createTextElement(), -20, 2);
		expect(index).toBe(0);
	});

	it("should clamp to first line when clicking above text", async () => {
		const layout = createThreeLineLayout();
		const renderer = createRenderer(layout);
		// Click at y=50 (above line 0 which has y=0)
		const index = await renderer.hitTestCharacter(createTextElement(), 5, 50);
		expect(index).toBe(1);
	});

	it("should clamp to last line when clicking below text", async () => {
		const layout = createThreeLineLayout();
		const renderer = createRenderer(layout);
		// Click at y=-100 (below line 2 which ends at y=-36)
		const index = await renderer.hitTestCharacter(createTextElement(), 5, -100);
		expect(index).toBe(7);
	});

	it("should pick nearest line when clicking in gap between lines", async () => {
		// Lines with gap: line 0 at y=0 h=10 baseline=8, line 1 at y=-14 h=10 baseline=8
		// With baseline shift: line 0 hit area [8, -2], line 1 hit area [-6, -16]
		// Gap between y=-2 and y=-6
		const c0 = createLayoutChar(0, 0, 0, 10);
		const c1 = createLayoutChar(2, 0, -14, 10);
		const renderer = createRenderer({
			chars: [c0, c1],
			lines: [
				{
					chars: [c0],
					width: 10,
					height: 10,
					baseline: 8,
					x: 0,
					y: 0,
					paragraphIndex: 0,
					softWrapped: false,
				},
				{
					chars: [c1],
					width: 10,
					height: 10,
					baseline: 8,
					x: 0,
					y: -14,
					paragraphIndex: 0,
					softWrapped: false,
				},
			],
			bounds: { minX: 0, minY: -24, maxX: 10, maxY: 0, width: 10, height: 24 },
			hasOverflow: false,
		});
		// Click at y=-5 in the gap (-2 to -6)
		// Line 0: center=3, dist=8. Line 1: center=-11, dist=6. Line 1 is closer.
		// x=3 is in left half of char c1 (x=0, advanceWidth=10, mid=5) → charIndex=2
		const index = await renderer.hitTestCharacter(createTextElement(), 3, -5);
		expect(index).toBe(2);
	});

	it("should return empty-line insertion index when click is on an empty line", async () => {
		const c0 = createLayoutChar(0, 0, 0, 10);
		const renderer = createRenderer({
			chars: [c0],
			lines: [
				{
					chars: [c0],
					width: 10,
					height: 12,
					baseline: 8,
					x: 0,
					y: 0,
					paragraphIndex: 0,
					softWrapped: false,
				},
				{
					chars: [],
					width: 10,
					height: 12,
					baseline: 8,
					x: 0,
					y: -12,
					paragraphIndex: 1,
					softWrapped: false,
				},
			],
			bounds: { minX: 0, minY: -24, maxX: 10, maxY: 0, width: 10, height: 24 },
			hasOverflow: false,
		});
		// Click within empty line (y=-10, within line 1 hit area [-4, -16])
		const index = await renderer.hitTestCharacter(createTextElement(), 0, -10);
		expect(index).toBe(2);
	});

	it("should return 0 for empty text", async () => {
		const renderer = createRenderer({
			chars: [],
			lines: [],
			bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
			hasOverflow: false,
		});
		const index = await renderer.hitTestCharacter(createTextElement(), 5, -5);
		expect(index).toBe(0);
	});

	describe("vertical text", () => {
		// Vertical layout: column 0 at x=0 width=12, chars at y=0,-10 (top to bottom)
		// Column 1 at x=-18 width=12, chars at y=0,-10
		function createVerticalLayout() {
			const element = createTextElement();
			element.layout.writingMode = "vertical-rl";

			const c0 = createLayoutChar(0, 0, 0, 10);
			const c1 = createLayoutChar(1, 0, -10, 10);
			const c3 = createLayoutChar(3, -18, 0, 10);
			const c4 = createLayoutChar(4, -18, -10, 10);
			return {
				element,
				layout: {
					chars: [c0, c1, c3, c4],
					lines: [
						{
							chars: [c0, c1],
							width: 12,
							height: 20,
							baseline: 8,
							x: 0,
							y: 0,
							paragraphIndex: 0,
							softWrapped: false,
						},
						{
							chars: [c3, c4],
							width: 12,
							height: 20,
							baseline: 8,
							x: -18,
							y: 0,
							paragraphIndex: 0,
							softWrapped: false,
						},
					],
					bounds: {
						minX: -30,
						minY: -20,
						maxX: 12,
						maxY: 0,
						width: 42,
						height: 20,
					},
					hasOverflow: false,
				},
			};
		}

		it("should select char in correct column", async () => {
			const { element, layout } = createVerticalLayout();
			const renderer = createRenderer(layout);
			// Column 1: x=-18..=-6. char3: visualTop=0+10*0.8=8, visualBottom=-2, midY=3
			// Click at x=-10 (column 1), y=4 (above midY=3 → charIndex 3)
			const index = await renderer.hitTestCharacter(element, -10, 4);
			expect(index).toBe(3);
		});

		it("should return before char when clicking top half (vertical)", async () => {
			const { element, layout } = createVerticalLayout();
			const renderer = createRenderer(layout);
			// char0: visualTop=0+10*0.8=8, visualBottom=-2, midY=8-5=3
			// Click at x=5 (column 0), y=4 (above midY=3 → before char)
			const index = await renderer.hitTestCharacter(element, 5, 4);
			expect(index).toBe(0);
		});

		it("should return after char when clicking bottom half (vertical)", async () => {
			const { element, layout } = createVerticalLayout();
			const renderer = createRenderer(layout);
			// char0: visualTop=8, visualBottom=-2, midY=3
			// Click at x=5 (column 0), y=1 (below midY=3 → after char)
			const index = await renderer.hitTestCharacter(element, 5, 1);
			expect(index).toBe(1);
		});
	});
});

describe("TextRenderer tate-chu-yoko caret and hit testing", () => {
	// Vertical column at x=0 width=12.
	// char0 (normal): y=0, cell top=8, bottom=-2
	// tate-chu-yoko cluster char1+char2: shared baseline y=-10 (cell top=-2,
	// bottom=-12), composed horizontally: char1 x=0..5, char2 x=5..10
	function createTateChuYokoLayout() {
		const element = createTextElement();
		element.layout.writingMode = "vertical-rl";

		const c0 = createLayoutChar(0, 0, 0, 10);
		const c1 = createLayoutChar(1, 0, -10, 5, { tateChuYoko: true });
		const c2 = createLayoutChar(2, 5, -10, 5, { tateChuYoko: true });
		return {
			element,
			layout: {
				chars: [c0, c1, c2],
				lines: [
					{
						chars: [c0, c1, c2],
						width: 12,
						height: 30,
						baseline: 8,
						x: 0,
						y: 0,
						paragraphIndex: 0,
						softWrapped: false,
					},
				],
				bounds: {
					minX: 0,
					minY: -20,
					maxX: 12,
					maxY: 0,
					width: 12,
					height: 20,
				},
				hasOverflow: false,
			},
		};
	}

	it("should resolve hits inside the cell by X (left half → before char)", async () => {
		const { element, layout } = createTateChuYokoLayout();
		const renderer = createRenderer(layout);
		// Inside cell band (y=-5), char1 spans x=0..5, midX=2.5
		const index = await renderer.hitTestCharacter(element, 2, -5);
		expect(index).toBe(1);
	});

	it("should resolve hits inside the cell by X (right half → after char)", async () => {
		const { element, layout } = createTateChuYokoLayout();
		const renderer = createRenderer(layout);
		// char2 spans x=5..10, midX=7.5 → after char2
		const index = await renderer.hitTestCharacter(element, 8, -5);
		expect(index).toBe(3);
	});

	it("should clamp to cluster ends when clicking outside horizontally", async () => {
		const { element, layout } = createTateChuYokoLayout();
		const renderer = createRenderer(layout);
		expect(await renderer.hitTestCharacter(element, -3, -5)).toBe(1);
		expect(await renderer.hitTestCharacter(element, 11, -5)).toBe(3);
	});

	it("should return an upright caret inside the cell", async () => {
		const { element, layout } = createTateChuYokoLayout();
		const renderer = createRenderer(layout);
		// Before char1: bar bottom at y = -10 - 10*0.2 = -12, height = fontSize
		const pos = await renderer.getCursorPosition(element, 1);
		expect(pos.x).toBeCloseTo(0);
		expect(pos.y).toBeCloseTo(-12);
		expect(pos.height).toBeCloseTo(10);
		expect(pos.rotation).toBeCloseTo(Math.PI / 2);
	});

	it("should place the line-end caret after the last cluster glyph", async () => {
		const { element, layout } = createTateChuYokoLayout();
		const renderer = createRenderer(layout);
		const pos = await renderer.getCursorPosition(element, 3);
		expect(pos.x).toBeCloseTo(10);
		expect(pos.y).toBeCloseTo(-12);
		expect(pos.rotation).toBeCloseTo(Math.PI / 2);
	});

	it("should build per-glyph selection rects inside the cell", async () => {
		const { element, layout } = createTateChuYokoLayout();
		const renderer = createRenderer(layout);
		const rects = await renderer.getSelectionRects(element, 1, 3);
		expect(rects).toHaveLength(2);
		expect(rects[0]).toMatchObject({ x: 0, y: -12, width: 5, height: 10 });
		expect(rects[1]).toMatchObject({ x: 5, y: -12, width: 5, height: 10 });
	});

	it("should keep the column-wide span for normal vertical glyphs", async () => {
		const { element, layout } = createTateChuYokoLayout();
		const renderer = createRenderer(layout);
		const rects = await renderer.getSelectionRects(element, 0, 1);
		expect(rects).toHaveLength(1);
		expect(rects[0]).toMatchObject({ x: 0, width: 12 });
	});
});

describe("TextRenderer.getCursorPosition", () => {
	it("uses line height for horizontal cursor at a character", async () => {
		const char0 = createLayoutChar(0, 0, 0, 10, {
			glyphPath: [
				{
					start: { x: 2, y: -8 },
					cp1: { x: 0, y: 0 },
					cp2: { x: 0, y: 0 },
					end: { x: 9, y: 0 },
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
					isMoved: true,
				},
			],
		});
		const renderer = createRenderer({
			chars: [char0],
			lines: [
				{
					chars: [char0],
					width: 10,
					height: 12,
					baseline: 8,
					x: 0,
					y: 0,
					paragraphIndex: 0,
					softWrapped: false,
				},
			],
			bounds: { minX: 0, minY: -10, maxX: 10, maxY: 0, width: 10, height: 10 },
			hasOverflow: false,
		});

		const pos = await renderer.getCursorPosition(createTextElement(), 0);
		expect(pos.x).toBe(0);
		// y = line.y + line.baseline - line.height = 0 + 8 - 12 = -4
		expect(pos.y).toBe(-4);
		expect(pos.height).toBe(12);
	});

	it("uses line height for horizontal cursor at line end", async () => {
		const char0 = createLayoutChar(0, 0, 0, 10, {
			glyphPath: [
				{
					start: { x: 2, y: -8 },
					cp1: { x: 0, y: 0 },
					cp2: { x: 0, y: 0 },
					end: { x: 9, y: 0 },
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
					isMoved: true,
				},
			],
		});
		const renderer = createRenderer({
			chars: [char0],
			lines: [
				{
					chars: [char0],
					width: 10,
					height: 12,
					baseline: 8,
					x: 0,
					y: 0,
					paragraphIndex: 0,
					softWrapped: false,
				},
			],
			bounds: { minX: 0, minY: -10, maxX: 10, maxY: 0, width: 10, height: 10 },
			hasOverflow: false,
		});

		const pos = await renderer.getCursorPosition(createTextElement(), 1);
		expect(pos.x).toBe(10);
		// y = line.y + line.baseline - line.height = 0 + 8 - 12 = -4
		expect(pos.y).toBe(-4);
		expect(pos.height).toBe(12);
	});

	it("invalidates cached layout entries by element id prefix", async () => {
		const charA = createLayoutChar(0, 0, 0, 10, {
			glyphPath: [
				{
					start: { x: 0, y: -8 },
					cp1: { x: 0, y: 0 },
					cp2: { x: 0, y: 0 },
					end: { x: 8, y: 0 },
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
					isMoved: true,
				},
			],
		});
		const charB = createLayoutChar(0, 20, 0, 10, {
			glyphPath: [
				{
					start: { x: 20, y: -8 },
					cp1: { x: 0, y: 0 },
					cp2: { x: 0, y: 0 },
					end: { x: 28, y: 0 },
					startTiltX: 0,
					startTiltY: 0,
					endTiltX: 0,
					endTiltY: 0,
					startDeltaTime: 0,
					endDeltaTime: 0,
					isMoved: true,
				},
			],
		});

		let currentLayout: LayoutResult = {
			chars: [charA],
			lines: [
				{
					chars: [charA],
					width: 10,
					height: 12,
					baseline: 8,
					x: 0,
					y: 0,
					paragraphIndex: 0,
					softWrapped: false,
				},
			],
			bounds: { minX: 0, minY: -10, maxX: 10, maxY: 0, width: 10, height: 10 },
			hasOverflow: false,
		};
		const layoutEngine = {
			layout: vi.fn(async () => currentLayout),
		} as unknown as TextLayoutEngine;
		const renderer = new TextRenderer(layoutEngine);
		const element = createTextElement();

		const first = await renderer.getCursorPosition(element, 0);
		expect(first.x).toBe(0);
		expect(
			(layoutEngine.layout as unknown as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(1);

		currentLayout = {
			chars: [charB],
			lines: [
				{
					chars: [charB],
					width: 10,
					height: 12,
					baseline: 8,
					x: 20,
					y: 0,
					paragraphIndex: 0,
					softWrapped: false,
				},
			],
			bounds: { minX: 20, minY: -10, maxX: 30, maxY: 0, width: 10, height: 10 },
			hasOverflow: false,
		};
		renderer.invalidateLayout(element.id);

		const second = await renderer.getCursorPosition(element, 0);
		expect(second.x).toBe(20);
		expect(
			(layoutEngine.layout as unknown as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(2);
	});
});

describe("TextRenderer.getLineStartEnd", () => {
	// Layout: 2 lines
	// Line 0: chars [0,1,2] with advanceWidth=10
	// Line 1: chars [4,5]   (charIndex 4,5 — gap accounts for newline at index 3)
	function createTwoLineLayout(): LayoutResult {
		const c0 = createLayoutChar(0, 0, 0, 10);
		const c1 = createLayoutChar(1, 10, 0, 10);
		const c2 = createLayoutChar(2, 20, 0, 10);
		const c4 = createLayoutChar(4, 0, -12, 10);
		const c5 = createLayoutChar(5, 10, -12, 10);
		return {
			chars: [c0, c1, c2, c4, c5],
			lines: [
				{
					chars: [c0, c1, c2],
					width: 30,
					height: 12,
					baseline: 8,
					x: 0,
					y: 0,
					paragraphIndex: 0,
					softWrapped: false,
				},
				{
					chars: [c4, c5],
					width: 20,
					height: 12,
					baseline: 8,
					x: 0,
					y: -12,
					paragraphIndex: 0,
					softWrapped: false,
				},
			],
			bounds: { minX: 0, minY: -24, maxX: 30, maxY: 0, width: 30, height: 24 },
			hasOverflow: false,
		};
	}

	it("should return start of first line when charIndex is within first line", async () => {
		const layout = createTwoLineLayout();
		const renderer = createRenderer(layout);
		const result = await renderer.getLineStartEnd(
			createTextElement(),
			1,
			"start",
		);
		expect(result).toBe(0);
	});

	it("should return end of first line (lastChar.charIndex + 1)", async () => {
		const layout = createTwoLineLayout();
		const renderer = createRenderer(layout);
		const result = await renderer.getLineStartEnd(
			createTextElement(),
			1,
			"end",
		);
		expect(result).toBe(3);
	});

	it("should return start of second line when charIndex is within second line", async () => {
		const layout = createTwoLineLayout();
		const renderer = createRenderer(layout);
		const result = await renderer.getLineStartEnd(
			createTextElement(),
			4,
			"start",
		);
		expect(result).toBe(4);
	});

	it("should return end of second line (lastChar.charIndex + 1)", async () => {
		const layout = createTwoLineLayout();
		const renderer = createRenderer(layout);
		const result = await renderer.getLineStartEnd(
			createTextElement(),
			5,
			"end",
		);
		expect(result).toBe(6);
	});

	it("should resolve end-of-line boundary (lastChar+1) to the same line", async () => {
		const layout = createTwoLineLayout();
		const renderer = createRenderer(layout);
		// charIndex 3 = lastChar(2) + 1, which is within first line's range [0, 3]
		const startResult = await renderer.getLineStartEnd(
			createTextElement(),
			3,
			"start",
		);
		expect(startResult).toBe(0);
		const endResult = await renderer.getLineStartEnd(
			createTextElement(),
			3,
			"end",
		);
		expect(endResult).toBe(3);
	});

	it("should return inferred charIndex for an empty line", async () => {
		// Line 0: chars [0], Line 1: empty, Line 2: chars [3]
		// Empty line at index 1: prev line last char is 0, so emptyLineCharIndex = 0 + 1 + 1 = 2
		const c0 = createLayoutChar(0, 0, 0, 10);
		const c3 = createLayoutChar(3, 0, -24, 10);
		const layout: LayoutResult = {
			chars: [c0, c3],
			lines: [
				{
					chars: [c0],
					width: 10,
					height: 12,
					baseline: 8,
					x: 0,
					y: 0,
					paragraphIndex: 0,
					softWrapped: false,
				},
				{
					chars: [],
					width: 0,
					height: 12,
					baseline: 8,
					x: 0,
					y: -12,
					paragraphIndex: 1,
					softWrapped: false,
				},
				{
					chars: [c3],
					width: 10,
					height: 12,
					baseline: 8,
					x: 0,
					y: -24,
					paragraphIndex: 0,
					softWrapped: false,
				},
			],
			bounds: { minX: 0, minY: -36, maxX: 10, maxY: 0, width: 10, height: 36 },
			hasOverflow: false,
		};
		const renderer = createRenderer(layout);
		// charIndex 2 maps to the empty line; both "start" and "end" return the same inferred index
		const startResult = await renderer.getLineStartEnd(
			createTextElement(),
			2,
			"start",
		);
		expect(startResult).toBe(2);
		const endResult = await renderer.getLineStartEnd(
			createTextElement(),
			2,
			"end",
		);
		expect(endResult).toBe(2);
	});

	it("should return null when layout has no lines", async () => {
		const layout: LayoutResult = {
			chars: [],
			lines: [],
			bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
			hasOverflow: false,
		};
		const renderer = createRenderer(layout);
		const result = await renderer.getLineStartEnd(
			createTextElement(),
			0,
			"start",
		);
		expect(result).toBeNull();
	});
});

describe("TextRenderer cursor ↔ hitTest round-trip", () => {
	function createThreeLineLayout(): LayoutResult {
		const c0 = createLayoutChar(0, 0, 0, 10);
		const c1 = createLayoutChar(1, 10, 0, 10);
		const c3 = createLayoutChar(3, 0, -12, 10);
		const c4 = createLayoutChar(4, 10, -12, 10);
		const c6 = createLayoutChar(6, 0, -24, 10);
		const c7 = createLayoutChar(7, 10, -24, 10);
		return {
			chars: [c0, c1, c3, c4, c6, c7],
			lines: [
				{
					chars: [c0, c1],
					width: 20,
					height: 12,
					baseline: 8,
					x: 0,
					y: 0,
					paragraphIndex: 0,
					softWrapped: false,
				},
				{
					chars: [c3, c4],
					width: 20,
					height: 12,
					baseline: 8,
					x: 0,
					y: -12,
					paragraphIndex: 0,
					softWrapped: false,
				},
				{
					chars: [c6, c7],
					width: 20,
					height: 12,
					baseline: 8,
					x: 0,
					y: -24,
					paragraphIndex: 0,
					softWrapped: false,
				},
			],
			bounds: { minX: 0, minY: -36, maxX: 20, maxY: 0, width: 20, height: 36 },
			hasOverflow: false,
		};
	}

	it("hitTestCharacter at getCursorPosition returns the same charIndex", async () => {
		const layout = createThreeLineLayout();
		const renderer = createRenderer(layout);
		const element = createTextElement();

		for (const charIndex of [0, 1, 3, 4, 6, 7]) {
			const pos = await renderer.getCursorPosition(element, charIndex);
			const hitIndex = await renderer.hitTestCharacter(
				element,
				pos.x + 2,
				pos.y + 2,
			);
			expect(
				hitIndex,
				`charIndex=${charIndex}: cursor at (${pos.x}, ${pos.y}), hitTest returned ${hitIndex}`,
			).toBe(charIndex);
		}
	});
});

describe("cursorLocalToWorld with rotation", () => {
	function createThreeLineLayout(): LayoutResult {
		const c0 = createLayoutChar(0, 0, 0, 10);
		const c1 = createLayoutChar(1, 10, 0, 10);
		const c3 = createLayoutChar(3, 0, -12, 10);
		const c4 = createLayoutChar(4, 10, -12, 10);
		const c6 = createLayoutChar(6, 0, -24, 10);
		const c7 = createLayoutChar(7, 10, -24, 10);
		return {
			chars: [c0, c1, c3, c4, c6, c7],
			lines: [
				{
					chars: [c0, c1],
					width: 20,
					height: 12,
					baseline: 8,
					x: 0,
					y: 0,
					paragraphIndex: 0,
					softWrapped: false,
				},
				{
					chars: [c3, c4],
					width: 20,
					height: 12,
					baseline: 8,
					x: 0,
					y: -12,
					paragraphIndex: 0,
					softWrapped: false,
				},
				{
					chars: [c6, c7],
					width: 20,
					height: 12,
					baseline: 8,
					x: 0,
					y: -24,
					paragraphIndex: 0,
					softWrapped: false,
				},
			],
			bounds: { minX: 0, minY: -36, maxX: 20, maxY: 0, width: 20, height: 36 },
			hasOverflow: false,
		};
	}

	function makeRotatedTransform(
		rotDeg: number,
		tx = 0,
		ty = 0,
	): ElementTransform {
		return {
			x: tx,
			y: ty,
			rotation: (rotDeg * Math.PI) / 180,
			scaleX: 1,
			scaleY: 1,
		};
	}

	it("rotated cursor stays on the same line as its glyph", async () => {
		const layout = createThreeLineLayout();
		const renderer = createRenderer(layout);
		const element = createTextElement();
		// Simulate rotation with non-zero transform.x/y (as rotateElements produces)
		const t = makeRotatedTransform(30, 15, 130);
		const origin = computeTransformOrigin(calculateLocalElementBounds(element));

		for (const charIndex of [0, 3, 6]) {
			const char = layout.chars.find((c) => c.charIndex === charIndex)!;
			const cursorLocal = await renderer.getCursorPosition(element, charIndex);

			// Transform cursor and glyph through the same path
			const cursorWorld = cursorLocalToWorld(
				cursorLocal,
				element.x,
				element.y,
				t,
				origin,
				"horizontal-tb",
			);
			const glyphWorld = applyTransformToPoint(
				char.x + element.x,
				char.y + element.y,
				t,
				origin.x,
				origin.y,
			);

			// Cursor and glyph should be within one line height of each other
			const dist = Math.hypot(
				cursorWorld.x - glyphWorld.x,
				cursorWorld.y - glyphWorld.y,
			);
			expect(
				dist,
				`charIndex=${charIndex}: cursor-glyph distance ${dist.toFixed(1)}px exceeds line height`,
			).toBeLessThan(layout.lines[0].height);
		}
	});

	it("cursor for line 0 char should not land in line 1 region after rotation", async () => {
		const layout = createThreeLineLayout();
		const renderer = createRenderer(layout);
		const element = createTextElement();
		const t = makeRotatedTransform(25, 10, 100);
		const origin = computeTransformOrigin(calculateLocalElementBounds(element));

		// Get world positions for char 0 (line 0) and char 3 (line 1)
		const cursor0 = await renderer.getCursorPosition(element, 0);
		const cursor3 = await renderer.getCursorPosition(element, 3);

		const world0 = cursorLocalToWorld(
			cursor0,
			element.x,
			element.y,
			t,
			origin,
			"horizontal-tb",
		);
		const world3 = cursorLocalToWorld(
			cursor3,
			element.x,
			element.y,
			t,
			origin,
			"horizontal-tb",
		);

		// After rotation the Y values change, but line 0 cursor should be
		// further from origin than line 1 cursor along the rotated Y axis.
		// Use the cross product with the rotation direction to check ordering.
		const cos = Math.cos(t.rotation);
		const sin = Math.sin(t.rotation);
		// Project onto the rotated Y axis (perpendicular to text flow)
		const proj0 = -(world0.x - origin.x) * sin + (world0.y - origin.y) * cos;
		const proj3 = -(world3.x - origin.x) * sin + (world3.y - origin.y) * cos;

		// Line 0 is above line 1 in local space (y=0 vs y=-12).
		// After rotation, their projections onto the rotated perpendicular
		// axis should preserve this ordering.
		expect(
			proj0,
			`line 0 cursor projected=${proj0.toFixed(1)} should be > line 1 projected=${proj3.toFixed(1)}`,
		).toBeGreaterThan(proj3);
	});

	it("identity transform returns local+element offset directly", async () => {
		const layout = createThreeLineLayout();
		const renderer = createRenderer(layout);
		const element = createTextElement();

		const cursorLocal = await renderer.getCursorPosition(element, 0);
		const world = cursorLocalToWorld(
			cursorLocal,
			element.x,
			element.y,
			createIdentityTransform(),
			{ x: 0, y: 0 },
			"horizontal-tb",
		);

		expect(world.x).toBe(cursorLocal.x + element.x);
		expect(world.y).toBe(cursorLocal.y + element.y);
		expect(world.height).toBe(cursorLocal.height);
	});

	// Center-aligned: chars centered around x=0, so glyph x can be negative
	// relative to element.x. The estimated bounds (calculateLocalElementBounds)
	// assume left-align, so origin is wrong when using estimated bounds.
	function createCenterAlignedLayout(): LayoutResult {
		// Line width=20, centered → chars at x=-10, x=0
		const c0 = createLayoutChar(0, -10, 0, 10);
		const c1 = createLayoutChar(1, 0, 0, 10);
		const c3 = createLayoutChar(3, -10, -12, 10);
		const c4 = createLayoutChar(4, 0, -12, 10);
		return {
			chars: [c0, c1, c3, c4],
			lines: [
				{
					chars: [c0, c1],
					width: 20,
					height: 12,
					baseline: 8,
					x: -10,
					y: 0,
					paragraphIndex: 0,
					softWrapped: false,
				},
				{
					chars: [c3, c4],
					width: 20,
					height: 12,
					baseline: 8,
					x: -10,
					y: -12,
					paragraphIndex: 0,
					softWrapped: false,
				},
			],
			bounds: {
				minX: -10,
				minY: -24,
				maxX: 10,
				maxY: 0,
				width: 20,
				height: 24,
			},
			hasOverflow: false,
		};
	}

	// Right-aligned: chars end at x=0, so they extend leftward
	function createRightAlignedLayout(): LayoutResult {
		const c0 = createLayoutChar(0, -20, 0, 10);
		const c1 = createLayoutChar(1, -10, 0, 10);
		const c3 = createLayoutChar(3, -20, -12, 10);
		const c4 = createLayoutChar(4, -10, -12, 10);
		return {
			chars: [c0, c1, c3, c4],
			lines: [
				{
					chars: [c0, c1],
					width: 20,
					height: 12,
					baseline: 8,
					x: -20,
					y: 0,
					paragraphIndex: 0,
					softWrapped: false,
				},
				{
					chars: [c3, c4],
					width: 20,
					height: 12,
					baseline: 8,
					x: -20,
					y: -12,
					paragraphIndex: 0,
					softWrapped: false,
				},
			],
			bounds: {
				minX: -20,
				minY: -24,
				maxX: 0,
				maxY: 0,
				width: 20,
				height: 24,
			},
			hasOverflow: false,
		};
	}

	// Regression guard: for every alignment, the estimated bounds X-origin
	// (calculateLocalElementBounds) must stay within MAX_X_DRIFT of the precise
	// layout bounds X-origin. X drift is alignment-dependent and was the root
	// cause of the rotation axis bug. Y drift depends on font metrics estimation
	// and is harder to control, so we use a larger tolerance.
	const MAX_X_DRIFT = 3; // px — alignment must be correct
	const MAX_Y_DRIFT = 20; // px — font metrics estimation is inherently imprecise

	const alignmentCases: Array<{
		name: string;
		alignment: "left" | "center" | "right";
		layout: () => LayoutResult;
	}> = [
		{ name: "left", alignment: "left", layout: createThreeLineLayout },
		{ name: "center", alignment: "center", layout: createCenterAlignedLayout },
		{ name: "right", alignment: "right", layout: createRightAlignedLayout },
	];

	const rotationAngles = [15, 30, 45, 60, 90];

	// Create element whose content matches the test layouts (2 chars per line, 2 lines)
	function createAlignedElement(
		alignment: "left" | "center" | "right",
	): TextElement {
		const el = createTextElement();
		el.content.paragraphs[0].runs[0].text = "AB";
		el.content.paragraphs[0].alignment = alignment;
		return el;
	}

	for (const { name, alignment, layout: createLayout } of alignmentCases) {
		it(`${name}-aligned: estimated X origin stays within ${MAX_X_DRIFT}px of precise`, () => {
			const element = createAlignedElement(alignment);
			const layout = createLayout();

			const estimated = calculateLocalElementBounds(element);
			const estimatedOrigin = computeTransformOrigin(estimated);

			const preciseOrigin = {
				x: (layout.bounds.minX + layout.bounds.maxX) / 2 + element.x,
				y: (layout.bounds.minY + layout.bounds.maxY) / 2 + element.y,
			};

			const xDrift = Math.abs(estimatedOrigin.x - preciseOrigin.x);
			const yDrift = Math.abs(estimatedOrigin.y - preciseOrigin.y);
			expect(
				xDrift,
				`${name}-aligned: X drift ${xDrift.toFixed(1)}px (estimated=${estimatedOrigin.x.toFixed(1)}, precise=${preciseOrigin.x.toFixed(1)})`,
			).toBeLessThan(MAX_X_DRIFT);
			expect(
				yDrift,
				`${name}-aligned: Y drift ${yDrift.toFixed(1)}px (estimated=${estimatedOrigin.y.toFixed(1)}, precise=${preciseOrigin.y.toFixed(1)})`,
			).toBeLessThan(MAX_Y_DRIFT);
		});

		for (const deg of rotationAngles) {
			it(`${name}-aligned @ ${deg}deg: cursor stays on same line as glyph`, async () => {
				const layout = createLayout();
				const renderer = createRenderer(layout);
				const element = createAlignedElement(alignment);
				const t = makeRotatedTransform(deg, 15, 130);

				const origin = computeTransformOrigin(
					calculateLocalElementBounds(element),
				);

				for (const charIndex of [0, layout.chars.at(-1)!.charIndex]) {
					const char = layout.chars.find((c) => c.charIndex === charIndex)!;
					const cursorLocal = await renderer.getCursorPosition(
						element,
						charIndex,
					);
					const cursorWorld = cursorLocalToWorld(
						cursorLocal,
						element.x,
						element.y,
						t,
						origin,
						"horizontal-tb",
					);
					const glyphWorld = applyTransformToPoint(
						char.x + element.x,
						char.y + element.y,
						t,
						origin.x,
						origin.y,
					);

					const dist = Math.hypot(
						cursorWorld.x - glyphWorld.x,
						cursorWorld.y - glyphWorld.y,
					);
					expect(
						dist,
						`${name} @${deg}deg char=${charIndex}: ${dist.toFixed(1)}px`,
					).toBeLessThan(layout.lines[0].height);
				}
			});
		}
	}
});

describe("TextRenderer.getLineStartEnd", () => {
	// Layout: 2 lines
	// Line 0: chars [0,1,2] with advanceWidth=10
	// Line 1: chars [4,5]   (charIndex 4,5 — gap accounts for newline at index 3)
	function createTwoLineLayout(): LayoutResult {
		const c0 = createLayoutChar(0, 0, 0, 10);
		const c1 = createLayoutChar(1, 10, 0, 10);
		const c2 = createLayoutChar(2, 20, 0, 10);
		const c4 = createLayoutChar(4, 0, -12, 10);
		const c5 = createLayoutChar(5, 10, -12, 10);
		return {
			chars: [c0, c1, c2, c4, c5],
			lines: [
				{
					chars: [c0, c1, c2],
					width: 30,
					height: 12,
					baseline: 8,
					x: 0,
					y: 0,
					paragraphIndex: 0,
					softWrapped: false,
				},
				{
					chars: [c4, c5],
					width: 20,
					height: 12,
					baseline: 8,
					x: 0,
					y: -12,
					paragraphIndex: 0,
					softWrapped: false,
				},
			],
			bounds: { minX: 0, minY: -24, maxX: 30, maxY: 0, width: 30, height: 24 },
			hasOverflow: false,
		};
	}

	it("should return start of first line when charIndex is within first line", async () => {
		const layout = createTwoLineLayout();
		const renderer = createRenderer(layout);
		const result = await renderer.getLineStartEnd(
			createTextElement(),
			1,
			"start",
		);
		expect(result).toBe(0);
	});

	it("should return end of first line (lastChar.charIndex + 1)", async () => {
		const layout = createTwoLineLayout();
		const renderer = createRenderer(layout);
		const result = await renderer.getLineStartEnd(
			createTextElement(),
			1,
			"end",
		);
		expect(result).toBe(3);
	});

	it("should return start of second line when charIndex is within second line", async () => {
		const layout = createTwoLineLayout();
		const renderer = createRenderer(layout);
		const result = await renderer.getLineStartEnd(
			createTextElement(),
			4,
			"start",
		);
		expect(result).toBe(4);
	});

	it("should return end of second line (lastChar.charIndex + 1)", async () => {
		const layout = createTwoLineLayout();
		const renderer = createRenderer(layout);
		const result = await renderer.getLineStartEnd(
			createTextElement(),
			5,
			"end",
		);
		expect(result).toBe(6);
	});

	it("should resolve end-of-line boundary (lastChar+1) to the same line", async () => {
		const layout = createTwoLineLayout();
		const renderer = createRenderer(layout);
		// charIndex 3 = lastChar(2) + 1, which is within first line's range [0, 3]
		const startResult = await renderer.getLineStartEnd(
			createTextElement(),
			3,
			"start",
		);
		expect(startResult).toBe(0);
		const endResult = await renderer.getLineStartEnd(
			createTextElement(),
			3,
			"end",
		);
		expect(endResult).toBe(3);
	});

	it("should return inferred charIndex for an empty line", async () => {
		// Line 0: chars [0], Line 1: empty, Line 2: chars [3]
		// Empty line at index 1: prev line last char is 0, so emptyLineCharIndex = 0 + 1 + 1 = 2
		const c0 = createLayoutChar(0, 0, 0, 10);
		const c3 = createLayoutChar(3, 0, -24, 10);
		const layout: LayoutResult = {
			chars: [c0, c3],
			lines: [
				{
					chars: [c0],
					width: 10,
					height: 12,
					baseline: 8,
					x: 0,
					y: 0,
					paragraphIndex: 0,
					softWrapped: false,
				},
				{
					chars: [],
					width: 0,
					height: 12,
					baseline: 8,
					x: 0,
					y: -12,
					paragraphIndex: 1,
					softWrapped: false,
				},
				{
					chars: [c3],
					width: 10,
					height: 12,
					baseline: 8,
					x: 0,
					y: -24,
					paragraphIndex: 0,
					softWrapped: false,
				},
			],
			bounds: { minX: 0, minY: -36, maxX: 10, maxY: 0, width: 10, height: 36 },
			hasOverflow: false,
		};
		const renderer = createRenderer(layout);
		// charIndex 2 maps to the empty line; both "start" and "end" return the same inferred index
		const startResult = await renderer.getLineStartEnd(
			createTextElement(),
			2,
			"start",
		);
		expect(startResult).toBe(2);
		const endResult = await renderer.getLineStartEnd(
			createTextElement(),
			2,
			"end",
		);
		expect(endResult).toBe(2);
	});

	it("should return null when layout has no lines", async () => {
		const layout: LayoutResult = {
			chars: [],
			lines: [],
			bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
			hasOverflow: false,
		};
		const renderer = createRenderer(layout);
		const result = await renderer.getLineStartEnd(
			createTextElement(),
			0,
			"start",
		);
		expect(result).toBeNull();
	});
});

describe("TextRenderer with real layout engine (wrapped documents)", () => {
	function createRealRenderer(): TextRenderer {
		return new TextRenderer(new TextLayoutEngine(createMockFontManager()));
	}

	it("should round-trip getCursorPosition → hitTestCharacter on a soft-wrapped document", async () => {
		const renderer = createRealRenderer();
		// "aaaa aaaa" wraps at boxWidth 50 into "aaaa " / "aaaa"
		const element = createTestTextElement("aaaa aaaa", {
			layout: { boxWidth: 50, wordWrap: true, overflow: "hidden" },
		});

		for (let charIndex = 0; charIndex <= 9; charIndex++) {
			const pos = await renderer.getCursorPosition(element, charIndex);
			const hit = await renderer.hitTestCharacter(
				element,
				pos.x + 0.1,
				pos.y + pos.height / 2,
			);
			expect(hit).toBe(charIndex);
		}
	});
});

describe("TextRenderer flow chains", () => {
	const regionLayout = {
		boxWidth: 40,
		boxHeight: 30,
		wordWrap: true,
		overflow: "hidden",
	} as const;

	function createChain() {
		const head = createTestTextElement("aaaaaaaa", {
			id: "head",
			layout: regionLayout,
			flow: { nextTextElementId: "tail" },
		});
		const tail = createTestTextElement("", {
			id: "tail",
			y: -100,
			layout: regionLayout,
		});
		const byId = new Map([
			["head", head],
			["tail", tail],
		]);
		const renderer = new TextRenderer(
			new TextLayoutEngine(createMockFontManager()),
		);
		renderer.setDocumentResolver({
			getElementById: (id) => byId.get(id) ?? null,
			getWorldSegments: () => null,
			getGeometryRevision: () => 0,
			findFlowSource: (textId) => (textId === "tail" ? head : null),
		});
		return { head, tail, renderer };
	}

	it("should lay out downstream regions from the head content", async () => {
		const { tail, renderer } = createChain();
		// tail region should carry chars 4..7 even though its own content is empty
		const pos = await renderer.getCursorPosition(tail, 5);
		expect(pos.x).toBeCloseTo(10);
		const hit = await renderer.hitTestCharacter(tail, 11, -24);
		expect(hit).toBe(5);
	});

	it("should resolve the region owning a charIndex across the chain", async () => {
		const { head, renderer } = createChain();
		expect(await renderer.findRegionForCharIndex(head, 1)).toBe("head");
		expect(await renderer.findRegionForCharIndex(head, 5)).toBe("tail");
	});

	it("should report overflow on upstream regions and none on the last", async () => {
		const { head, tail, renderer } = createChain();
		expect((await renderer.getOverflowState(head)).hasOverflow).toBe(true);
		expect((await renderer.getOverflowState(tail)).hasOverflow).toBe(false);
	});

	it("should navigate down across the region boundary with goal column", async () => {
		const { head, renderer } = createChain();
		// Caret after char 1 (x=10) in head's single line → down lands near x=10
		// in tail's first line (both regions share x=0 world origin)
		const target = await renderer.getLineNavigationTarget(head, 1, "down");
		expect(target).toBe(5);
	});

	it("should expose the flowed range start and ordered chain members", async () => {
		const { head, tail, renderer } = createChain();

		expect(await renderer.getFlowedRangeStart(tail)).toBe(4);
		expect(await renderer.getFlowedRangeStart(head)).toBeNull();
		expect(renderer.getFlowChainMembers(tail)?.map((m) => m.id)).toEqual([
			"head",
			"tail",
		]);
	});

	it("should paint flow-target glyphs with the head's run fill", async () => {
		const { head, tail, renderer } = createChain();
		head.content.paragraphs[0].runs[0].style.fill = {
			type: "solid",
			color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
		};

		const { paths } = await renderer.textElementToPaths(tail);

		expect(paths.length).toBeGreaterThan(0);
		for (const path of paths) {
			const fill = path.filters?.find(
				(f): f is FillAppearance => f.processor === "fill",
			);
			expect(fill?.paramData.params.fill).toEqual(
				head.content.paragraphs[0].runs[0].style.fill,
			);
		}
	});

	it("should resolve the flow head for chain members and self otherwise", () => {
		const { head, tail, renderer } = createChain();
		expect(renderer.getFlowHead(tail)).toBe(head);
		expect(renderer.getFlowHead(head)).toBe(head);

		const solo = createTestTextElement("x");
		expect(renderer.getFlowHead(solo)).toBe(solo);
	});

	it("should not loop forever on cyclic flow links", async () => {
		const a = createTestTextElement("aaaa", {
			id: "a",
			layout: regionLayout,
			flow: { nextTextElementId: "b" },
		});
		const b = createTestTextElement("", {
			id: "b",
			layout: regionLayout,
			flow: { nextTextElementId: "a" },
		});
		const byId = new Map([
			["a", a],
			["b", b],
		]);
		const renderer = new TextRenderer(
			new TextLayoutEngine(createMockFontManager()),
		);
		renderer.setDocumentResolver({
			getElementById: (id) => byId.get(id) ?? null,
			getWorldSegments: () => null,
			getGeometryRevision: () => 0,
			findFlowSource: (textId) =>
				textId === "b" ? a : textId === "a" ? b : null,
		});

		// Must terminate and produce a layout despite the a↔b cycle
		const pos = await renderer.getCursorPosition(a, 0);
		expect(Number.isFinite(pos.x)).toBe(true);
	});
});

describe("TextRenderer on-path caret and hit testing", () => {
	function createOnPathSetup() {
		const element = createTestTextElement("aaaa", {
			axisBinding: {
				mode: "onPath",
				pathObjectId: "axis",
				startOffset: 0,
				alignment: "left",
				offsetDistance: 0,
				orientation: "rotate",
			},
		});
		const renderer = new TextRenderer(
			new TextLayoutEngine(createMockFontManager()),
		);
		renderer.setDocumentResolver({
			getElementById: () => null,
			// Uniformly parameterized straight segment (see TextLayoutEngine.test)
			getWorldSegments: () => [
				lineSeg(
					{ x: 100, y: 0 },
					{
						start: { x: 0, y: 0 },
						cp1: { x: 100 / 3, y: 0 },
						cp2: { x: -100 / 3, y: 0 },
					},
				),
			],
			getGeometryRevision: () => 0,
			findFlowSource: () => null,
		});
		return { element, renderer };
	}

	it("should place the caret before the glyph along the tangent", async () => {
		const { element, renderer } = createOnPathSetup();
		const pos = await renderer.getCursorPosition(element, 0);
		expect(pos.x).toBeCloseTo(0);
		expect(pos.y).toBeCloseTo(0);
		expect(pos.rotation).toBeCloseTo(0);
	});

	it("should hit-test the nearest glyph split along the tangent", async () => {
		const { element, renderer } = createOnPathSetup();
		// Glyph centers at x=5,15,25,35. Click at x=12 → nearest is char 1
		// (center 15), before its center → index 1
		expect(await renderer.hitTestCharacter(element, 12, 0)).toBe(1);
		// Click at x=18 → past char1's center → index 2
		expect(await renderer.hitTestCharacter(element, 18, 0)).toBe(2);
	});
});

describe("TextRenderer per-run fill", () => {
	it("should attach the run's fill as a per-glyph appearance", async () => {
		const renderer = new TextRenderer(
			new TextLayoutEngine(createMockFontManager()),
		);
		const element = createTestTextElement("ab");
		const runFill = {
			type: "solid" as const,
			color: createDefaultColor(),
		};
		element.content.paragraphs[0].runs[0].style.fill = runFill;

		const { paths } = await renderer.textElementToPaths(element);
		expect(paths.length).toBeGreaterThan(0);
		for (const path of paths) {
			const fill = path.filters?.find((f) => f.processor === "fill");
			expect(fill).toBeDefined();
		}
	});
});

describe("TextRenderer transformed bound text", () => {
	const mkResolver = (
		segsById: Record<string, unknown>,
		textTransform?: {
			t: ElementTransform;
			origin: { x: number; y: number };
			isIdentity: boolean;
		},
	) =>
		({
			getElementById: () => null,
			getWorldSegments: (id: string) => segsById[id] ?? null,
			getGeometryRevision: () => 0,
			findFlowSource: () => null,
			...(textTransform ? { getTextTransform: () => textTransform } : {}),
		}) as never;

	const onPathBinding = {
		mode: "onPath",
		pathObjectId: "P",
		startOffset: 0,
		alignment: "left",
		offsetDistance: 0,
		orientation: "rotate",
	} as const;

	it("should pull world geometry back through the render transform", async () => {
		// Render affine A = translate(+30, +10); drawn glyph = A(x/y + local).
		// For glyphs to land on the world path, layout must produce
		// local = A^-1(world) - x/y, i.e. the identity-case local shifted by
		// exactly (-30, -10).
		const makeElement = () =>
			createTestTextElement("ab", {
				x: 5,
				y: 7,
				axisBinding: { ...onPathBinding },
			});
		const segs = { P: [lineSeg({ x: 30, y: 0 }, { start: { x: 0, y: 0 } })] };

		const identityRenderer = new TextRenderer(
			new TextLayoutEngine(createMockFontManager()),
		);
		identityRenderer.setDocumentResolver(mkResolver(segs));
		const [identityQuad] = await identityRenderer.getGlyphQuads(
			makeElement(),
			[0],
		);

		const t: ElementTransform = {
			x: 30,
			y: 10,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
		};
		const transformedRenderer = new TextRenderer(
			new TextLayoutEngine(createMockFontManager()),
		);
		transformedRenderer.setDocumentResolver(
			mkResolver(segs, { t, origin: { x: 0, y: 0 }, isIdentity: false }),
		);
		const [transformedQuad] = await transformedRenderer.getGlyphQuads(
			makeElement(),
			[0],
		);

		expect(transformedQuad.pivot.x).toBeCloseTo(identityQuad.pivot.x - 30);
		expect(transformedQuad.pivot.y).toBeCloseTo(identityQuad.pivot.y - 10);
	});

	it("should key bound layouts on x/y but keep plain layouts position-free", () => {
		const renderer = new TextRenderer(
			new TextLayoutEngine(createMockFontManager()),
		);
		renderer.setDocumentResolver(mkResolver({}));

		const bound = createTestTextElement("ab", {
			x: 0,
			y: 0,
			axisBinding: { ...onPathBinding },
		});
		const boundMoved = { ...bound, x: 50 };
		expect(renderer.computeTextCacheKey(bound)).not.toBe(
			renderer.computeTextCacheKey(boundMoved),
		);

		const plain = createTestTextElement("ab");
		const plainMoved = { ...plain, x: 50 };
		expect(renderer.computeTextCacheKey(plain)).toBe(
			renderer.computeTextCacheKey(plainMoved),
		);
	});
});

describe("TextRenderer bound-text sync hit test", () => {
	const mkResolver = (segsById: Record<string, unknown>) =>
		({
			getElementById: () => null,
			getWorldSegments: (id: string) => segsById[id] ?? null,
			getGeometryRevision: () => 0,
			findFlowSource: () => null,
		}) as never;

	it("should hit near the spine and miss away from it for on-path text", () => {
		const renderer = new TextRenderer(
			new TextLayoutEngine(createMockFontManager()),
		);
		renderer.setDocumentResolver(
			mkResolver({ P: [lineSeg({ x: 30, y: 0 }, { start: { x: 0, y: 0 } })] }),
		);
		const element = createTestTextElement("ab", {
			x: 5,
			y: 7,
			axisBinding: {
				mode: "onPath",
				pathObjectId: "P",
				startOffset: 0,
				alignment: "left",
				offsetDistance: 0,
				orientation: "rotate",
			},
		});

		// In the offset-inclusive local space the spine stays at its world
		// coordinates (0,0)→(30,0): layout subtracts x/y and rendering adds
		// them back, so ink lands on the world path
		expect(renderer.hitTestBoundTextSync(element, 20, 2, 5)).toBe(true);
		expect(renderer.hitTestBoundTextSync(element, 20, 40, 5)).toBe(false);
	});

	it("should hit inside the region and miss outside for area text", () => {
		const renderer = new TextRenderer(
			new TextLayoutEngine(createMockFontManager()),
		);
		renderer.setDocumentResolver(
			mkResolver({ R: closedRectSegments(0, 0, 100, 60) }),
		);
		const element = createTestTextElement("ab", {
			x: 0,
			y: 0,
			axisBinding: { mode: "inShape", pathObjectId: "R" },
		});

		expect(renderer.hitTestBoundTextSync(element, 50, 30, 5)).toBe(true);
		expect(renderer.hitTestBoundTextSync(element, 200, 30, 5)).toBe(false);
	});

	it("should hit glyph ink once the layout is cached", async () => {
		const renderer = new TextRenderer(
			new TextLayoutEngine(createMockFontManager()),
		);
		renderer.setDocumentResolver(
			mkResolver({ P: [lineSeg({ x: 30, y: 0 }, { start: { x: 0, y: 0 } })] }),
		);
		const element = createTestTextElement("ab", {
			axisBinding: {
				mode: "onPath",
				pathObjectId: "P",
				startOffset: 0,
				alignment: "left",
				offsetDistance: 0,
				orientation: "rotate",
			},
		});

		// Populate the layout cache, then probe a point above the spine that
		// only the glyph box (fontSize-tall) covers, beyond the spine tolerance
		const [quad] = await renderer.getGlyphQuads(element, [0]);
		const probeY = quad.pivot.y + 4;
		expect(
			renderer.hitTestBoundTextSync(element, quad.pivot.x, probeY, 1),
		).toBe(true);
	});

	it("should return null for unbound texts and dangling bindings", () => {
		const renderer = new TextRenderer(
			new TextLayoutEngine(createMockFontManager()),
		);
		renderer.setDocumentResolver(mkResolver({}));

		expect(
			renderer.hitTestBoundTextSync(createTestTextElement("ab"), 0, 0, 5),
		).toBeNull();
		const dangling = createTestTextElement("ab", {
			axisBinding: { mode: "inShape", pathObjectId: "missing" },
		});
		expect(renderer.hitTestBoundTextSync(dangling, 0, 0, 5)).toBeNull();
	});
});

describe("TextRenderer overflow badge anchor", () => {
	it("should anchor on-path overflow at the last placed glyph", async () => {
		const renderer = new TextRenderer(
			new TextLayoutEngine(createMockFontManager()),
		);
		// 30px path fits 3 of 6 chars (10px advance): overflow with chars placed
		const element = createTestTextElement("aaaaaa", {
			axisBinding: {
				mode: "onPath",
				pathObjectId: "axis",
				startOffset: 0,
				alignment: "left",
				offsetDistance: 0,
				orientation: "rotate",
			},
		});
		renderer.setDocumentResolver({
			getElementById: () => null,
			getWorldSegments: (id) =>
				id === "axis"
					? [lineSeg({ x: 30, y: 0 }, { start: { x: 0, y: 0 } })]
					: null,
			getGeometryRevision: () => 0,
			findFlowSource: () => null,
		});

		const state = await renderer.getOverflowState(element);

		expect(state.hasOverflow).toBe(true);
		// Anchor = trailing edge of the last placed glyph (center + advance/2)
		const [lastQuad] = await renderer.getGlyphQuads(element, [2]);
		expect(state.anchorLocal.x).toBeCloseTo(lastQuad.pivot.x + 5);
		expect(state.anchorLocal.y).toBeCloseTo(lastQuad.pivot.y);
	});
});

describe("TextRenderer glyph quads (touch type)", () => {
	const makeRenderer = () =>
		new TextRenderer(new TextLayoutEngine(createMockFontManager()));

	it("should hit the glyph whose rotated quad contains the point", async () => {
		const renderer = makeRenderer();
		const element = createTestTextElement("ab");

		// Char 'b' spans x 10..20 around baseline 0 (fixture: 10px advance)
		expect(await renderer.hitTestGlyph(element, 15, 3)).toBe(1);
		expect(await renderer.hitTestGlyph(element, 200, 200)).toBe(null);
	});

	it("should fall back to the nearest glyph within tolerance", async () => {
		const renderer = makeRenderer();
		const element = createTestTextElement("ab");

		expect(await renderer.hitTestGlyph(element, 22, 0, 5)).toBe(1);
		expect(await renderer.hitTestGlyph(element, 40, 0, 5)).toBe(null);
	});

	it("should return pivot-centered quads for requested chars", async () => {
		const renderer = makeRenderer();
		const element = createTestTextElement("ab");

		const quads = await renderer.getGlyphQuads(element, [1]);

		expect(quads).toHaveLength(1);
		expect(quads[0].charIndex).toBe(1);
		expect(quads[0].pivot.x).toBeCloseTo(15);
		expect(quads[0].pivot.y).toBeCloseTo(0);
	});

	it("should emit a rotated rect for touch-adjusted chars in selection rects", async () => {
		const renderer = makeRenderer();
		const element = createTestTextElement("ab");
		element.content.paragraphs[0].runs[0].charOverrides = [
			{ charIndex: 0, rotation: 90 },
		];

		const rects = await renderer.getSelectionRects(element, 0, 2);

		const rotated = rects.find((r) => (r.rotation ?? 0) !== 0);
		expect(rotated?.rotation).toBeCloseTo(Math.PI / 2);
		// The untouched char keeps an axis-aligned span rect
		expect(rects.some((r) => (r.rotation ?? 0) === 0)).toBe(true);
	});
});
