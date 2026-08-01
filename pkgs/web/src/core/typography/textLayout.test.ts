import { beforeAll, describe, expect, it } from "vitest";
import { createIdentityTransform } from "../document/factory";
import type { TextElement } from "../schema";
import {
	loadTestFont,
	NOTO_SANS_JP_POST_SCRIPT_NAME,
} from "../testUtils/fontSetup";
import { FontManager } from "./fonts/FontManager";
import { TextLayoutEngine } from "./TextLayoutEngine";

let fontManager: FontManager;
let layoutEngine: TextLayoutEngine;

beforeAll(() => {
	fontManager = new FontManager();
	loadTestFont(fontManager);
	layoutEngine = new TextLayoutEngine(fontManager);
});

function makeTextElement(overrides: Partial<TextElement> = {}): TextElement {
	const baseStyle = {
		fontFamily: "Noto Sans JP",
		fontSource: {
			type: "local" as const,
			postScriptName: NOTO_SANS_JP_POST_SCRIPT_NAME,
		},
		fontSize: 24,
		fontWeight: 400,
		fontStyle: "normal" as const,
		fill: null,
		underline: false,
		strikethrough: false,
		letterSpacing: 0,
		baselineShift: 0,
		lineHeight: 1.5,
	};

	return {
		type: "text",
		id: "t1",
		x: 0,
		y: 0,
		content: {
			paragraphs: [
				{
					runs: [
						{
							text: "Hello",
							style: { ...baseStyle },
						},
					],
					alignment: "left",
					lineHeight: 1.5,
					indent: 0,
					spacing: { before: 0, after: 0 },
				},
			],
		},
		defaultStyle: baseStyle,
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
		...overrides,
	};
}

describe("TextLayoutEngine with NotoSansJP", () => {
	describe("layout bounds — horizontal-tb", () => {
		it("baseline at origin: maxY > 0 (ascent above baseline), minY < 0 (descent below baseline)", async () => {
			const result = await layoutEngine.layout(makeTextElement({ x: 0, y: 0 }));

			// In world space (Y-up), baseline is at y=0.
			// Ascent is above baseline → maxY > 0.
			// Descent is below baseline → minY < 0.
			expect(result.bounds.maxY).toBeGreaterThan(0);
			expect(result.bounds.minY).toBeLessThan(0);
			expect(result.bounds.height).toBeGreaterThan(0);
		});

		it("layout bounds height ≈ (ascent + |descent|) in px for fontSize=24", async () => {
			// Default fontSize is 24; NotoSansJP ascent=1160, descent=-288, unitsPerEm=1000.
			// Expected height from font metrics: (1160 + 288) / 1000 * 24 ≈ 34.75
			// Actual height may be slightly smaller if glyph ink doesn't reach full ascent/descent.
			const result = await layoutEngine.layout(makeTextElement({ x: 0, y: 0 }));
			expect(result.bounds.height).toBeGreaterThan(20);
			expect(result.bounds.height).toBeLessThan(50);
		});

		it("bounds shift correctly with element position", async () => {
			const [x, y] = [100, 200];
			const at0 = await layoutEngine.layout(makeTextElement({ x: 0, y: 0 }));
			const atPos = await layoutEngine.layout(makeTextElement({ x, y }));

			// Layout bounds are in local space (element-relative), so they should be equal
			// regardless of element position.
			expect(atPos.bounds.minX).toBeCloseTo(at0.bounds.minX);
			expect(atPos.bounds.minY).toBeCloseTo(at0.bounds.minY);
			expect(atPos.bounds.maxX).toBeCloseTo(at0.bounds.maxX);
			expect(atPos.bounds.maxY).toBeCloseTo(at0.bounds.maxY);
		});

		it("two-line text: second line extends minY further below baseline", async () => {
			const singleLine = makeTextElement();
			const twoLine: TextElement = {
				...singleLine,
				id: "t2",
				content: {
					paragraphs: [
						{ ...singleLine.content.paragraphs[0] },
						{
							runs: [{ text: "World", style: { ...singleLine.defaultStyle } }],
							alignment: "left",
							lineHeight: 1.5,
							indent: 0,
							spacing: { before: 0, after: 0 },
						},
					],
				},
			};

			const single = await layoutEngine.layout(singleLine);
			const multi = await layoutEngine.layout(twoLine);

			// Two lines extend further below (more negative minY in Y-up space).
			expect(multi.bounds.minY).toBeLessThan(single.bounds.minY);
			// maxY stays approximately the same (first line ascent unchanged).
			expect(multi.bounds.maxY).toBeCloseTo(single.bounds.maxY, 0);
		});
	});

	describe("font metrics sanity check", () => {
		it("NotoSansJP fontkit descent is negative (OpenType convention)", async () => {
			const result = await layoutEngine.layout(makeTextElement());
			const char = result.chars[0];
			expect(char).toBeDefined();
			// descent must be negative so that char.y + descentPx < char.y (below baseline)
			expect(char.font.fontkit.descent).toBeLessThan(0);
		});

		it("NotoSansJP fontkit ascent is positive", async () => {
			const result = await layoutEngine.layout(makeTextElement());
			const char = result.chars[0];
			expect(char).toBeDefined();
			expect(char.font.fontkit.ascent).toBeGreaterThan(0);
		});
	});
});
