import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRobotoFlexFont, loadTestFont } from "../testUtils/fontSetup";
import { lineSeg } from "../testUtils/segmentFactory";
import { createTestTextElement } from "../testUtils/typographyFixtures";
import { createDefaultTextStyle } from "../tools/TextTool";
import { FontManager } from "./fonts/FontManager";
import { TextLayoutEngine } from "./TextLayoutEngine";
import { TextRenderer } from "./TextRenderer";

describe("variable font rendering", () => {
	let manager: FontManager;
	beforeEach(() => {
		manager = new FontManager();
	});

	it("renders distinct Noto weights and reuses the right face when interleaved", async () => {
		const base = loadTestFont(manager);
		const style = createDefaultTextStyle();
		const thin = manager.resolveFontForStyle(base, {
			...style,
			fontWeight: 100,
		});
		const bold = manager.resolveFontForStyle(base, {
			...style,
			fontWeight: 900,
		});
		const a = await manager.shapeText(thin, "あA", 24);
		const b = await manager.shapeText(bold, "あA", 24);
		expect(a[0].path).not.toEqual(b[0].path);
		expect(a[1].advanceWidth).not.toBe(b[1].advanceWidth);
		expect(await manager.shapeText(thin, "あA", 24)).toEqual(a);
		expect(
			manager.resolveFontForStyle(base, { ...style, fontWeight: 100 }),
		).toBe(thin);
		expect(base.fontkit).not.toBe(thin.fontkit);
	});

	it("applies width and custom axes from the bundled Roboto Flex face", async () => {
		const base = loadRobotoFlexFont(manager);
		const render = (settings: Record<string, number>) =>
			manager.shapeText(
				manager.resolveFontForStyle(base, {
					...createDefaultTextStyle(),
					fontVariationSettings: settings,
				}),
				"HAM",
				32,
			);
		const normal = await render({});
		const narrow = await render({ wdth: 25 });
		const parametric = await render({ XTRA: 600 });
		expect(narrow[0].advanceWidth).toBeLessThan(normal[0].advanceWidth);
		expect(parametric[0].path).not.toEqual(normal[0].path);
	});

	it("extracts the shaped ligature rather than its first character", async () => {
		const base = loadTestFont(manager);
		const face = manager.resolveFontForStyle(base, createDefaultTextStyle());
		const shaped = await manager.shapeText(face, "office", 24);
		const ligature = shaped.find((glyph) => glyph.charLength === 3);
		expect(ligature).toBeDefined();
		const single = await manager.shapeText(face, "f", 24);
		expect(ligature?.path).not.toEqual(single[0].path);
	});

	it("evicts old variable instances while live outlines remain usable", async () => {
		const base = loadTestFont(manager);
		const original = manager.resolveFontForStyle(base, {
			...createDefaultTextStyle(),
			fontWeight: 100,
		});
		const before = await manager.shapeText(original, "A", 24);
		for (let weight = 101; weight < 401; weight++)
			manager.resolveFontForStyle(base, {
				...createDefaultTextStyle(),
				fontWeight: weight,
			});
		expect(
			manager.resolveFontForStyle(base, {
				...createDefaultTextStyle(),
				fontWeight: 100,
			}),
		).not.toBe(original);
		expect(await manager.shapeText(original, "A", 24)).toEqual(before);
	});

	it("keeps vertical alternates isolated by weight", () => {
		const base = loadTestFont(manager);
		const thin = manager.resolveFontForStyle(base, {
			...createDefaultTextStyle(),
			fontWeight: 100,
		});
		const bold = manager.resolveFontForStyle(base, {
			...createDefaultTextStyle(),
			fontWeight: 900,
		});
		const a = manager.getVerticalGlyphPath(thin, "（");
		const b = manager.getVerticalGlyphPath(bold, "（");
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(a).not.toEqual(b);
		expect(manager.getVerticalGlyphPath(thin, "（")).toEqual(a);
	});

	it.each([
		"vertical",
		"ellipsis",
		"onPath",
	] as const)("uses the same variable face throughout %s layout", async (mode) => {
		const base = loadTestFont(manager);
		const engine = new TextLayoutEngine(manager);
		const element = createTestTextElement(
			mode === "vertical" ? "（。12）" : "HAM HAM HAM HAM HAM",
			{
				layout:
					mode === "vertical"
						? { writingMode: "vertical-rl" }
						: mode === "ellipsis"
							? {
									boxWidth: 40,
									boxHeight: 30,
									wordWrap: true,
									overflow: "ellipsis",
								}
							: {},
				axisBinding:
					mode === "onPath"
						? {
								mode: "onPath",
								pathObjectId: "path",
								startOffset: 0,
								alignment: "left",
								offsetDistance: 0,
								orientation: "rotate",
							}
						: undefined,
			},
		);
		const render = async (fontWeight: number) => {
			const style = {
				...element.defaultStyle,
				fontSource: {
					type: "local" as const,
					postScriptName: base.metadata.postScriptName,
				},
				fontWeight,
			};
			element.defaultStyle = style;
			element.content.paragraphs[0].runs =
				mode === "vertical"
					? [
							{ text: "（。", style },
							{ text: "12", style: { ...style, tateChuYoko: true } },
							{ text: "）", style },
						]
					: [{ text: "HAM HAM HAM HAM HAM", style }];
			const result = await engine.layout(
				element,
				mode === "onPath"
					? {
							kind: "onPath",
							segments: [lineSeg({ x: 400, y: 0 }, { start: { x: 0, y: 0 } })],
						}
					: undefined,
			);
			const face = manager.resolveFontForStyle(base, style);
			expect(result.chars.length).toBeGreaterThan(0);
			expect(result.chars.every((char) => char.font === face)).toBe(true);
			if (mode === "ellipsis") expect(result.chars.at(-1)?.char).toBe("…");
			if (mode === "vertical")
				expect(result.chars.filter((char) => char.tateChuYoko)).toHaveLength(2);
			return result.chars.map((char) => char.glyphPath);
		};
		expect(await render(100)).not.toEqual(await render(900));
	});

	it("evicts old outlines after 2,048 glyphs without changing live paths", async () => {
		const base = loadTestFont(manager);
		const original = manager.getVerticalGlyphPath(base, "（");
		const ids = new Set<number>();
		const characters: string[] = [];
		for (const codePoint of base.fontkit.characterSet) {
			if (codePoint < 0x4e00) continue;
			const glyph = base.fontkit.glyphForCodePoint(codePoint);
			if (!glyph.id || ids.has(glyph.id)) continue;
			ids.add(glyph.id);
			characters.push(String.fromCodePoint(codePoint));
			if (characters.length === 2_048) break;
		}
		expect(characters).toHaveLength(2_048);
		await manager.shapeText(base, characters.join(""), 12);
		const renewed = manager.getVerticalGlyphPath(base, "（");
		expect(renewed).not.toBe(original);
		expect(renewed).toEqual(original);
	});

	it("reflows text and updates caret positions after changing width", async () => {
		const base = loadRobotoFlexFont(manager);
		const element = createTestTextElement("HAM HAM HAM HAM");
		const style = {
			...element.defaultStyle,
			fontSize: 24,
			fontSource: {
				type: "local" as const,
				postScriptName: base.metadata.postScriptName,
			},
			fontVariationSettings: { wdth: 25 },
		};
		element.defaultStyle = style;
		element.content.paragraphs[0].runs[0].style = style;
		element.layout = {
			...element.layout,
			boxWidth: 230,
			wordWrap: true,
			overflow: "hidden",
		};
		const engine = new TextLayoutEngine(manager);
		const renderer = new TextRenderer(engine);
		const first = await engine.layout(element);
		const caret = await renderer.getCursorPosition(element, 3);
		const wideStyle = { ...style, fontVariationSettings: { wdth: 151 } };
		const wide = {
			...element,
			defaultStyle: wideStyle,
			content: {
				...element.content,
				paragraphs: [
					{
						...element.content.paragraphs[0],
						runs: [{ text: "HAM HAM HAM HAM", style: wideStyle }],
					},
				],
			},
		};
		const second = await engine.layout(wide);
		expect(second.lines.length).toBeGreaterThan(first.lines.length);
		expect(await renderer.getCursorPosition(wide, 3)).not.toEqual(caret);
	});

	it("updates a downstream region when the head's default coordinates change", async () => {
		const base = loadRobotoFlexFont(manager);
		const head = createTestTextElement("HAM HAM HAM HAM HAM HAM", {
			id: "head",
			flow: { nextTextElementId: "next" },
			layout: {
				boxWidth: 100,
				boxHeight: 40,
				wordWrap: true,
				overflow: "hidden",
			},
		});
		head.defaultStyle.fontSource = {
			type: "local",
			postScriptName: base.metadata.postScriptName,
		};
		head.defaultStyle.fontVariationSettings = { wdth: 25 };
		head.content.paragraphs[0].runs[0].style = { ...head.defaultStyle };
		delete head.content.paragraphs[0].runs[0].style.fontVariationSettings;
		const next = createTestTextElement("", {
			id: "next",
			layout: { ...head.layout },
		});
		const renderer = new TextRenderer(new TextLayoutEngine(manager));
		renderer.setDocumentResolver({
			getElementById: (id) => (id === head.id ? head : next),
			getWorldSegments: () => null,
			getGeometryRevision: () => 0,
			findFlowSource: (id) => (id === next.id ? head : null),
		});
		const narrow = await renderer.textElementToPaths(next);
		head.defaultStyle.fontVariationSettings = { wdth: 151 };
		const wide = await renderer.textElementToPaths(next);
		expect(narrow.paths.length).toBeGreaterThan(0);
		expect(wide).not.toEqual(narrow);
	});

	it("keeps static fonts unchanged without calling the variation API", () => {
		const base = loadTestFont(manager);
		vi.spyOn(base.fontkit, "variationAxes", "get").mockReturnValue({});
		const variation = vi.spyOn(base.fontkit, "getVariation");
		expect(manager.resolveFontForStyle(base, createDefaultTextStyle())).toBe(
			base,
		);
		expect(variation).not.toHaveBeenCalled();
	});

	it("does not let older async layout overwrite newer coordinates", async () => {
		loadTestFont(manager);
		const engine = new TextLayoutEngine(manager);
		const result = {
			chars: [],
			lines: [],
			bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
			hasOverflow: false,
		};
		const slow = Promise.withResolvers<typeof result>();
		const layout = vi
			.spyOn(engine, "layout")
			.mockReturnValueOnce(slow.promise)
			.mockResolvedValue(result);
		const renderer = new TextRenderer(engine);
		const element = createTestTextElement("A");
		const old = renderer.textElementToPaths(element);
		const current = {
			...element,
			defaultStyle: {
				...element.defaultStyle,
				fontVariationSettings: { wdth: 125 },
			},
		};
		await renderer.textElementToPaths(current);
		slow.resolve(result);
		await old;
		await renderer.textElementToPaths(current);
		expect(layout).toHaveBeenCalledTimes(2);
	});
});
