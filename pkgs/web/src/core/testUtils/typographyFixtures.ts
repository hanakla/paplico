import { createIdentityTransform } from "../document/factory";
import type { TextElement } from "../schema";
import type { LoadedFont } from "../typography/fonts/FontLoader";
import type { FontManager } from "../typography/fonts/FontManager";

function createMockFont(): LoadedFont {
	return {
		metadata: {
			family: "Mock Sans",
			fullName: "Mock Sans Regular",
			postScriptName: "MockSans-Regular",
			style: "Regular",
			weight: 400,
			source: "local",
		},
		fontkit: {
			ascent: 800,
			descent: -200,
			unitsPerEm: 1000,
		} as unknown as LoadedFont["fontkit"],
		cssFontFamily: "Mock Sans",
		data: new ArrayBuffer(0),
	};
}

/** FontManager mock: every glyph advances 10px and carries a tiny path */
export function createMockFontManager(): FontManager {
	const font = createMockFont();
	return {
		loadFont: async () => font,
		getLoadedFont: () => font,
		resolveFontForStyle: (loaded: LoadedFont) => loaded,
		shapeText: (_font: unknown, text: string) =>
			[...text].map((char, index) => ({
				char,
				charIndex: index,
				charLength: char.length,
				glyphId: index + 1,
				x: index * 10,
				y: 0,
				advanceWidth: 10,
				path: [
					{
						start: { x: 0, y: -1 },
						cp1: { x: 0, y: 0 },
						cp2: { x: 0, y: 0 },
						end: { x: 8, y: 7 },
						startTiltX: 0,
						startTiltY: 0,
						endTiltX: 0,
						endTiltY: 0,
						startDeltaTime: 0,
						endDeltaTime: 0,
						isMoved: true,
					},
				],
			})),
		getVerticalGlyphPath: () => null,
	} as unknown as FontManager;
}

/** TextElement fixture: 10px-advance mock font, lineHeight 3 (30px lines) */
export function createTestTextElement(
	text: string,
	opts: {
		id?: string;
		x?: number;
		y?: number;
		layout?: Partial<TextElement["layout"]>;
		axisBinding?: TextElement["axisBinding"];
		flow?: TextElement["flow"];
	} = {},
): TextElement {
	return {
		type: "text",
		id: opts.id ?? "text-1",
		x: opts.x ?? 0,
		y: opts.y ?? 0,
		content: {
			paragraphs: text.split("\n").map((paraText) => ({
				runs: [
					{
						text: paraText,
						style: {
							fontFamily: "Mock Sans",
							fontSource: {
								type: "local",
								postScriptName: "MockSans-Regular",
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
				alignment: "left" as const,
				lineHeight: 3,
				indent: 0,
				spacing: { before: 0, after: 0 },
			})),
		},
		defaultStyle: {
			fontFamily: "Mock Sans",
			fontSource: { type: "local", postScriptName: "MockSans-Regular" },
			fontSize: 10,
			fontWeight: 400,
			fontStyle: "normal",
			fill: null,
			underline: false,
			strikethrough: false,
			letterSpacing: 0,
			baselineShift: 0,
			lineHeight: 3,
		},
		layout: {
			writingMode: "horizontal-tb",
			boxWidth: "auto",
			boxHeight: "auto",
			overflow: "visible",
			wordWrap: false,
			...opts.layout,
		},
		axisBinding: opts.axisBinding,
		flow: opts.flow,
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}
