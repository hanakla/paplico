import { describe, it } from "vitest";
import {
	createArtboard,
	createDefaultDocument,
	createDefaultLayer,
	createIdentityTransform,
} from "../../document/factory";
import type { Document, TextElement, TextRun, TextStyle } from "../../schema";
import { NOTO_SANS_JP_POST_SCRIPT_NAME } from "../../testUtils/fontSetup";
import {
	createTestRenderer,
	expectVisualMatch,
	renderArtboardForTest,
} from "../../testUtils/visualRegression";

const FONT_SIZE = 32;

/**
 * Pins how vertical writing sets each kind of character: the cell grid comes
 * from columns of kanji, so a character set on its side, turned, or pulled off
 * the column axis shows against them.
 */
describe("Vertical text", () => {
	it("should set kana, vertical forms, symbols and tate-chu-yoko upright on the column axis under mixed orientation", async () => {
		const { renderer } = await createTestRenderer();
		const doc = verticalTextDoc([
			// Latin on its side between upright kana and symbols
			[run("あa①※"), run("縦")],
			// Vertical forms keep their own vertical shape
			[run("欲︙︙")],
			// Tate-chu-yoko split across runs with tracking and kerning, as an
			// imported file writes it, shares one cell; its leading space stays
			// out of the centering on the column axis
			[
				run("とえ"),
				run(" ", { tateChuYoko: true, letterSpacing: -0.4 }, -0.24),
				run("！", { tateChuYoko: true, letterSpacing: -0.54 }, 0.65),
				run("？", { tateChuYoko: true, letterSpacing: -0.54 }),
			],
			// A plain ASCII tate-chu-yoko pair for comparison
			[run("と"), run("!?", { tateChuYoko: true }), run("縦")],
		]);

		const texture = await renderArtboardForTest(
			renderer,
			doc.artboards[0],
			doc,
			1,
		);

		await expectVisualMatch(
			renderer,
			texture,
			texture.width,
			texture.height,
			"vertical-text-mixed-orientation",
			{ threshold: 0.1, maxDiffPercentage: 0.1 },
		);
		texture.destroy();
	});
});

/**
 * One vertical text element per column group, placed side by side from the
 * right edge of a 320×240 artboard centered on the world origin.
 */
function verticalTextDoc(columns: TextRun[][]): Document {
	const doc = createDefaultDocument("vertical-text");
	const layer = createDefaultLayer("vertical-text-layer", "Text");
	for (const [i, runs] of columns.entries()) {
		const element = verticalTextElement(`vertical-text-${i}`, runs);
		element.x = 120 - i * 64;
		element.y = 100;
		layer.elementIds.push(element.id);
		doc.objects[element.id] = element;
	}
	doc.layers.push(layer);
	doc.artboards.push(
		createArtboard("vertical-text-ab", "Main", 0, 0, 320, 240),
	);
	return doc;
}

function verticalTextElement(id: string, runs: TextRun[]): TextElement {
	return {
		type: "text",
		id,
		x: 0,
		y: 0,
		transform: createIdentityTransform(),
		content: {
			paragraphs: [
				{
					runs,
					alignment: "left",
					lineHeight: 1.2,
					indent: 0,
					spacing: { before: 0, after: 0 },
				},
			],
		},
		defaultStyle: STYLE,
		layout: {
			writingMode: "vertical-rl",
			boxWidth: "auto",
			boxHeight: "auto",
			overflow: "visible",
			wordWrap: false,
		},
		opacity: 1,
		blendMode: "normal",
		filters: [
			{
				uid: `${id}-content`,
				processor: "content",
				opacity: 1,
				blendMode: "normal",
				paramData: { version: "1", params: {} },
			},
		],
	};
}

function run(
	text: string,
	style: Partial<TextStyle> = {},
	kerningAdjust?: number,
): TextRun {
	return {
		text,
		style: { ...STYLE, ...style },
		...(kerningAdjust !== undefined && {
			charOverrides: [{ charIndex: 0, kerningAdjust }],
		}),
	};
}

const STYLE: TextStyle = {
	fontFamily: "Noto Sans JP",
	fontSource: { loaderId: "local", fontId: NOTO_SANS_JP_POST_SCRIPT_NAME },
	fontSize: FONT_SIZE,
	fontWeight: 400,
	fill: { type: "solid", color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 } },
	underline: false,
	strikethrough: false,
	letterSpacing: 0,
	lineHeight: 1.2,
	baselineShift: 0,
	textOrientation: "mixed",
};
