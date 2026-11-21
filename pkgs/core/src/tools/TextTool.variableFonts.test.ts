import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { extractDocumentFromYDoc } from "../collaboration/extractDocumentFromYDoc";
import { YjsProvider } from "../collaboration/YjsProvider";
import { openPapf } from "../io/papf/reader";
import { serializeDocument } from "../io/papf/writer";
import type { FontSource, TextElement } from "../schema";
import {
	createTestFontManager,
	loadRobotoFlexFont,
} from "../testUtils/fontSetup";
import { createMockToolContext } from "../testUtils/mockToolContext";
import { createTestTextElement } from "../testUtils/typographyFixtures";
import { TextTool } from "./TextTool";

describe("text variation editing", () => {
	const fonts = createTestFontManager();
	const getFontVariationAxes = (source: FontSource) =>
		fonts.getVariationAxes(source);
	let element: TextElement;
	let tool: TextTool;
	beforeEach(async () => {
		const font = await loadRobotoFlexFont(fonts);
		element = createTestTextElement("AB");
		element.defaultStyle = {
			...element.defaultStyle,
			fontSource: { loaderId: "local", fontId: font.metadata.postScriptName },
		};
		element.content.paragraphs[0].runs = [
			{
				text: "A",
				style: {
					...element.defaultStyle,
					fontVariationSettings: { wdth: 80, slnt: -5 },
				},
			},
			{
				text: "B",
				style: {
					...element.defaultStyle,
					fontVariationSettings: { wdth: 120, slnt: -10 },
				},
			},
		];
		tool = new TextTool(createMockToolContext({ getFontVariationAxes }));
		tool.enterEditModeForElement(element);
	});

	it("changes one coordinate without merging different run styles", () => {
		tool.selectAll();
		tool.changeSelectionFontVariation("wdth", 100);
		const runs = element.content.paragraphs[0].runs;
		expect(runs).toHaveLength(2);
		expect(runs.map((run) => run.style.fontVariationSettings)).toEqual([
			{ wdth: 100, slnt: -5 },
			{ wdth: 100, slnt: -10 },
		]);
		const summary = tool.getSelectionStyleSummary();
		expect(summary?.fontVariations).toMatchObject({
			wdth: { mixed: false, value: 100 },
			slnt: { mixed: true },
		});
		expect(summary?.fontVariations.wght).toBeUndefined();
		expect(summary?.style.fontWeight).toEqual({ mixed: false, value: 400 });
	});

	it("reports the selection's axis values again once its font has loaded", () => {
		let loaded = false;
		const selectionStyleChange = vi.fn();
		const loadingTool = new TextTool(
			createMockToolContext({
				getFontVariationAxes: (source) =>
					loaded ? getFontVariationAxes(source) : undefined,
				selectionStyleChange,
			}),
		);
		loadingTool.enterEditModeForElement(element);
		loadingTool.selectAll();
		expect(selectionStyleChange.mock.calls.at(-1)?.[0]?.fontVariations).toEqual(
			{},
		);

		loaded = true;
		loadingTool.refreshSelectionStyle();

		expect(
			selectionStyleChange.mock.calls.at(-1)?.[0]?.fontVariations,
		).toMatchObject({ wdth: { mixed: true } });
	});

	it("splits the selected text and leaves the rest at its original weight", () => {
		tool.moveToDocumentEnd(false);
		tool.moveCursor("left", true);
		tool.changeSelectionFontVariation("wght", 650);
		expect(
			element.content.paragraphs[0].runs.map((run) => run.style.fontWeight),
		).toEqual([400, 650]);
		expect(
			element.content.paragraphs[0].runs[1].style.fontVariationSettings,
		).toEqual({ wdth: 120, slnt: -10 });
	});

	it("retains inherited coordinates without inheriting axes into an explicit map", () => {
		element.defaultStyle.fontVariationSettings = { wdth: 70, slnt: -4 };
		delete element.content.paragraphs[0].runs[0].style.fontVariationSettings;
		tool.selectAll();
		expect(tool.getSelectionStyleSummary()?.fontVariations.wdth).toEqual({
			mixed: true,
		});
		tool.changeSelectionFontVariation("wght", 600);
		expect(
			element.content.paragraphs[0].runs.map(
				(run) => run.style.fontVariationSettings,
			),
		).toEqual([
			{ wdth: 70, slnt: -4 },
			{ wdth: 120, slnt: -10 },
		]);
	});

	it("stages caret coordinates for the next input without changing existing characters", () => {
		tool.moveToDocumentEnd(false);
		tool.changeSelectionFontVariation("wdth", 50);
		expect(
			element.content.paragraphs[0].runs[1].style.fontVariationSettings?.wdth,
		).toBe(120);
		tool.insertText("C");
		const last = element.content.paragraphs[0].runs.at(-1);
		expect(last?.text).toBe("C");
		expect(last?.style.fontVariationSettings).toEqual({ wdth: 50, slnt: -10 });
	});

	it("resets only one axis and retains the other mixed values", () => {
		tool.selectAll();
		tool.changeSelectionFontVariation("wdth", null);
		expect(
			element.content.paragraphs[0].runs.map(
				(run) => run.style.fontVariationSettings,
			),
		).toEqual([{ slnt: -5 }, { slnt: -10 }]);
		expect(tool.getSelectionStyleSummary()?.fontVariations.wdth).toEqual({
			mixed: false,
			value: 100,
		});
	});

	it("clears font-specific coordinates when changing font", () => {
		tool.selectAll();
		tool.changeSelectionFontFamily("Other", {
			loaderId: "local",
			fontId: "Other",
		});
		expect(element.content.paragraphs[0].runs).toHaveLength(1);
		expect(
			element.content.paragraphs[0].runs[0].style.fontVariationSettings,
		).toEqual({});
	});

	it("does not merge an inherited map with an explicit empty map", () => {
		element.defaultStyle.fontVariationSettings = { wdth: 70 };
		delete element.content.paragraphs[0].runs[0].style.fontVariationSettings;
		element.content.paragraphs[0].runs[1].style.fontVariationSettings = {};
		tool.selectAll();
		tool.applyStyleToSelection({ fontWeight: 700 });
		expect(element.content.paragraphs[0].runs).toHaveLength(2);
		expect(tool.getSelectionStyleSummary()?.fontVariations.wdth).toEqual({
			mixed: true,
		});
	});

	it("detects different faces even when the family names match", () => {
		element.content.paragraphs[0].runs[1].style.fontSource = {
			loaderId: "local",
			fontId: "Another face",
		};
		tool.selectAll();
		const summary = tool.getSelectionStyleSummary();
		expect(summary?.style.fontSource).toEqual({ mixed: true });
		expect(summary?.fontVariations).toEqual({});
	});

	it("reports a key no run has set as one shared undefined value", () => {
		tool.selectAll();
		expect(tool.getSelectionStyleSummary()?.style.textOrientation).toEqual({
			mixed: false,
			value: undefined,
		});
	});

	it("preserves coordinates through edit persistence, undo, peer sync and PAPF", async () => {
		const provider = new YjsProvider({
			callbacks: {
				onDocumentUpdate: vi.fn(),
				onLayersUpdate: vi.fn(),
				getCurrentLayerId: () => "layer",
				setCurrentLayerId: vi.fn(),
			},
		});
		const peer = new Y.Doc();
		try {
			provider.addLayer({
				id: "layer",
				name: "Layer",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: [],
			});
			provider.addElement("layer", element);
			provider.stopUndoCapture();
			const editor = new TextTool(
				createMockToolContext({
					getFontVariationAxes,
					persistTextEdit: (text) => {
						provider.updateElement("layer", text.id, {
							content: text.content,
							defaultStyle: text.defaultStyle,
						});
						return text;
					},
				}),
			);
			editor.enterEditModeForElement(element);
			editor.selectAll();
			editor.changeSelectionFontVariation("wdth", 100);
			const updated = extractDocumentFromYDoc(provider.ydoc);
			const text = updated.objects[element.id];
			expect(text.type).toBe("text");
			if (text.type !== "text") throw new Error("Expected text");
			expect(
				text.content.paragraphs[0].runs.map(
					(run) => run.style.fontVariationSettings?.wdth,
				),
			).toEqual([100, 100]);
			provider.undo();
			const undone = extractDocumentFromYDoc(provider.ydoc).objects[element.id];
			if (undone.type !== "text") throw new Error("Expected text");
			expect(
				undone.content.paragraphs[0].runs.map(
					(run) => run.style.fontVariationSettings?.wdth,
				),
			).toEqual([80, 120]);
			provider.redo();
			Y.applyUpdate(peer, Y.encodeStateAsUpdate(provider.ydoc));
			expect(extractDocumentFromYDoc(peer).objects[element.id]).toEqual(text);
			const file = await openPapf(
				await serializeDocument(extractDocumentFromYDoc(peer)),
			);
			const restored = (await file.toDocument()).objects[element.id];
			expect(restored).toMatchObject({
				content: text.content,
				defaultStyle: text.defaultStyle,
			});
		} finally {
			provider.destroy();
			peer.destroy();
		}
	});
});
