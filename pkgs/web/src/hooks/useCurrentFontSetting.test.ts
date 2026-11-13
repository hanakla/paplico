import {
	createDefaultColor,
	createDefaultTransform,
} from "@paplico/core/document";
import type { TextElement } from "@paplico/core/schema";
import { defaultTextEditState } from "@paplico/core/tools";
import type { FontMetadata } from "@paplico/core/typography";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { proxy } from "valtio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiState } from "@/stores/uiStore";
import { useActiveFontSettings } from "./useCurrentFontSetting";

let paplico = makePaplico();

vi.mock("@/contexts/PaplicoContext", () => ({
	usePaplico: () => paplico,
}));

beforeEach(() => {
	paplico = makePaplico();
	uiState.textEditState = { ...defaultTextEditState };
});

afterEach(cleanup);

describe("useActiveFontSettings", () => {
	it("resolves a selected text's local face by its saved source", async () => {
		const { result } = renderHook(() => useActiveFontSettings());
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.currentFont?.fontId).toBe("HiraginoSans-W2");
		expect(result.current.isMixed).toBe(false);
	});

	it("resolves the same local face while editing its text", async () => {
		uiState.textEditState = {
			...defaultTextEditState,
			isEditing: true,
			elementId: "text-1",
			selectionStyle: paplico.uiState.document.objects["text-1"].defaultStyle,
		};
		const { result } = renderHook(() => useActiveFontSettings());
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		expect(result.current.currentFont?.fontId).toBe("HiraginoSans-W2");
		expect(result.current.isMixed).toBe(false);
	});

	it("updates the selected element's weight without replacing its other variations", async () => {
		const element = paplico.uiState.document.objects["text-1"];
		element.defaultStyle.fontVariationSettings = { wdth: 80 };
		element.content.paragraphs[0].runs[0].style.fontVariationSettings = {
			wdth: 90,
		};
		const { result } = renderHook(() => useActiveFontSettings());
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		act(() => result.current.handleFontWeightChange(650));

		expect(paplico.commands.updateElement).toHaveBeenCalledWith(
			"layer-1",
			"text-1",
			expect.objectContaining({
				defaultStyle: expect.objectContaining({
					fontWeight: 650,
					fontVariationSettings: { wdth: 80 },
				}),
				content: expect.objectContaining({
					paragraphs: [
						expect.objectContaining({
							runs: [
								expect.objectContaining({
									style: expect.objectContaining({
										fontWeight: 650,
										fontVariationSettings: { wdth: 90 },
									}),
								}),
							],
						}),
					],
				}),
			}),
		);
	});

	it("changes the static font source together with its weight", async () => {
		const { result } = renderHook(() => useActiveFontSettings());
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		const face = makeFont("W0");

		act(() => result.current.handleFontWeightChange(face.weight, face));

		expect(paplico.commands.updateElement).toHaveBeenCalledWith(
			"layer-1",
			"text-1",
			expect.objectContaining({
				defaultStyle: expect.objectContaining({
					fontWeight: 100,
					fontSource: { loaderId: "local", fontId: "HiraginoSans-W0" },
				}),
			}),
		);
	});

	it("applies weight changes to the text being edited", async () => {
		uiState.textEditState = {
			...defaultTextEditState,
			isEditing: true,
			elementId: "text-1",
			selectionStyle: paplico.uiState.document.objects["text-1"].defaultStyle,
		};
		const { result } = renderHook(() => useActiveFontSettings());
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		act(() => result.current.handleFontWeightChange(650));

		expect(
			paplico.textToolController.getTextTool().applyStyleToSelection,
		).toHaveBeenCalledWith({ fontWeight: 650 });
		expect(paplico.commands.updateElement).not.toHaveBeenCalled();
	});

	it("changes a selected element's font without changing its size", async () => {
		const { result } = renderHook(() => useActiveFontSettings());
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		const font = makeFont("W0");

		act(() => result.current.handleFontChange(font));

		expect(paplico.commands.updateElement).toHaveBeenCalledWith(
			"layer-1",
			"text-1",
			expect.objectContaining({
				defaultStyle: expect.objectContaining({
					fontSize: 24,
					fontFamily: font.family,
					fontSource: { loaderId: font.loaderId, fontId: font.fontId },
				}),
			}),
		);
	});

	it("rounds font sizes before applying them to edited text", async () => {
		uiState.textEditState = {
			...defaultTextEditState,
			isEditing: true,
			elementId: "text-1",
			selectionStyle: paplico.uiState.document.objects["text-1"].defaultStyle,
		};
		const { result } = renderHook(() => useActiveFontSettings());
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		act(() => result.current.handleFontSizeChange(24.12345));

		expect(
			paplico.textToolController.getTextTool().applyStyleToSelection,
		).toHaveBeenCalledWith({ fontSize: 24.123 });
	});
});

function makePaplico() {
	const element = makeTextElement();
	const textTool = { applyStyleToSelection: vi.fn() };
	return {
		uiState: proxy({
			selectedElementIds: [element.id],
			currentLayerId: "layer-1",
			document: { objects: { [element.id]: element } },
		}),
		tools: {
			state: proxy({
				textDefaultStyle: { ...element.defaultStyle },
				textDefaultAlignment: "left",
				textDefaultWritingMode: "horizontal-tb",
			}),
		},
		commands: { updateElement: vi.fn() },
		textToolController: { getTextTool: () => textTool },
		getTextStyleSource: (text: TextElement) => text,
		fonts: {
			on: vi.fn(),
			queryAllFonts: vi.fn(async () => [makeFont("W0"), makeFont("W2")]),
		},
	};
}

function makeFont(weight: string): FontMetadata {
	return {
		family: "Hiragino Sans",
		fullName: `Hiragino Sans ${weight}`,
		postScriptName: `HiraginoSans-${weight}`,
		style: weight,
		weight: weight === "W0" ? 100 : 200,
		loaderId: "local",
		fontId: `HiraginoSans-${weight}`,
	};
}

function makeTextElement(): TextElement {
	const defaultStyle: TextElement["defaultStyle"] = {
		fontFamily: "HiraginoSans-W2",
		fontSource: { loaderId: "local", fontId: "HiraginoSans-W2" },
		fontSize: 24,
		fontWeight: 200,
		fontStyle: "normal",
		fill: { type: "solid", color: createDefaultColor() },
		underline: false,
		strikethrough: false,
		letterSpacing: 0,
		baselineShift: 0,
	};
	return {
		id: "text-1",
		type: "text",
		x: 0,
		y: 0,
		opacity: 1,
		blendMode: "normal",
		transform: createDefaultTransform(),
		defaultStyle,
		content: {
			paragraphs: [
				{
					runs: [{ text: "Text", style: { ...defaultStyle } }],
					alignment: "left",
					lineHeight: 1.2,
					indent: 0,
					spacing: { before: 0, after: 0 },
				},
			],
		},
		layout: {
			writingMode: "horizontal-tb",
			boxWidth: "auto",
			boxHeight: "auto",
			overflow: "visible",
			wordWrap: false,
		},
	};
}
