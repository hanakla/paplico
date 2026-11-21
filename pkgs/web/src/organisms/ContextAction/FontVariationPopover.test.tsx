import {
	act,
	fireEvent,
	type RenderResult,
	render,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiState } from "@/stores/uiStore";
import { extractDocumentFromYDoc } from "../../../../core/src/collaboration/extractDocumentFromYDoc";
import { YjsProvider } from "../../../../core/src/collaboration/YjsProvider";
import type { TextElement } from "../../../../core/src/schema";
import { createMockToolContext } from "../../../../core/src/testUtils/mockToolContext";
import { createTestTextElement } from "../../../../core/src/testUtils/typographyFixtures";
import { TextTool } from "../../../../core/src/tools/TextTool";
import {
	defaultTextEditState,
	TextToolController,
} from "../../../../core/src/tools/TextToolController";
import { FontVariationPopover } from "./FontVariationPopover";

const axes = {
	wdth: { name: "Width", min: 70, max: 150, default: 100 },
};
let tool: TextTool;
let controller: TextToolController;
let provider: YjsProvider;
vi.mock("@/contexts/PaplicoContext", () => ({
	usePaplico: () => ({
		fonts: {
			getVariationAxes: () => axes,
			on: vi.fn(),
			queryAllFonts: async () => [],
		},
		textToolController: controller,
	}),
}));
vi.mock("@/locales", () => ({ useTranslation: () => (key: string) => key }));
vi.mock("@/organisms/TextControls/FontWeightControl", () => ({
	FontWeightControl: () => null,
}));

describe("FontVariationPopover", () => {
	beforeEach(() => {
		const element = createTestTextElement("AB");
		provider = new YjsProvider({
			callbacks: {
				onDocumentUpdate: vi.fn(),
				onLayersUpdate: vi.fn(),
				getCurrentLayerId: () => "layer",
				setCurrentLayerId: vi.fn(),
			},
		});
		provider.addLayer({
			id: "layer",
			name: "Layer",
			visible: true,
			locked: false,
			opacity: 1,
			elementIds: [],
		});
		provider.addElement("layer", element);
		controller = new TextToolController(uiState.textEditState);
		tool = new TextTool(
			createMockToolContext({
				getFontVariationAxes: () => axes,
				selectionStyleChange: (summary) =>
					controller.updateSelectionStyle(summary),
				persistTextEdit: (text) => {
					provider.updateElement("layer", text.id, text);
					return extractDocumentFromYDoc(provider.ydoc).objects[
						text.id
					] as TextElement;
				},
			}),
		);
		controller.registerTextTool(tool);
		tool.enterEditModeForElement(element);
		tool.selectAll();
	});
	afterEach(() => {
		provider.destroy();
		Object.assign(uiState.textEditState, defaultTextEditState);
	});

	it("updates the width slider and its numeric field together", async () => {
		const view = render(<FontVariationPopover />);
		const slider = await openWidthSlider(view);
		expect(slider.getAttribute("aria-valuenow")).toBe("100");
		fireEvent.keyDown(slider, { key: "ArrowRight" });
		await settle();
		expect(Number(slider.getAttribute("aria-valuenow"))).toBeGreaterThan(100);
		expect(selectedWidth(tool)).toBeGreaterThan(100);
	});

	it("updates the width slider from the numeric field", async () => {
		const view = render(<FontVariationPopover />);
		const slider = await openWidthSlider(view);
		fireEvent.doubleClick(view.getByText("100"));
		const input = view.getByRole("textbox");
		fireEvent.change(input, { target: { value: "125" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await settle();
		expect(slider.getAttribute("aria-valuenow")).toBe("125");
		expect(selectedWidth(tool)).toBe(125);
	});

	it("updates the width slider when the numeric field is scrubbed", async () => {
		const view = render(<FontVariationPopover />);
		const slider = await openWidthSlider(view);
		const field = view.getByText("100");
		fireEvent.pointerDown(field, { clientX: 0, pointerId: 1 });
		fireEvent.pointerMove(field, { clientX: 375, pointerId: 1 });
		fireEvent.pointerUp(field, { clientX: 375, pointerId: 1 });
		await settle();
		expect(slider.getAttribute("aria-valuenow")).toBe("110");
		expect(selectedWidth(tool)).toBe(110);
	});

	it("updates the width slider with a caret and no text selection", async () => {
		tool.moveToDocumentEnd(false);
		const view = render(<FontVariationPopover />);
		const slider = await openWidthSlider(view);
		fireEvent.keyDown(slider, { key: "ArrowRight" });
		await settle();
		expect(Number(slider.getAttribute("aria-valuenow"))).toBeGreaterThan(100);
		expect(selectedWidth(tool)).toBeGreaterThan(100);
	});

	it("updates the width while dragging the slider", async () => {
		const view = render(<FontVariationPopover />);
		const slider = await openWidthSlider(view);
		const control = slider.parentElement?.parentElement?.parentElement;
		if (!(control instanceof HTMLElement))
			throw new Error("Missing slider control");
		vi.spyOn(control, "getBoundingClientRect").mockReturnValue({
			left: 0,
			right: 200,
			top: 0,
			bottom: 16,
			width: 200,
			height: 16,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		});
		if (!slider.parentElement) throw new Error("Missing slider thumb");
		vi.spyOn(slider.parentElement, "getBoundingClientRect").mockReturnValue({
			left: 69,
			right: 81,
			top: 2,
			bottom: 14,
			width: 12,
			height: 12,
			x: 69,
			y: 2,
			toJSON: () => ({}),
		});
		control.setPointerCapture = vi.fn();
		fireEvent.pointerDown(slider.parentElement ?? slider, {
			button: 0,
			pointerId: 1,
			clientX: 75,
			buttons: 1,
		});
		fireEvent.pointerMove(document, { pointerId: 1, clientX: 125, buttons: 1 });
		await settle();
		const first = Number(slider.getAttribute("aria-valuenow"));
		fireEvent.pointerMove(document, { pointerId: 1, clientX: 150, buttons: 1 });
		await settle();
		expect(Number(slider.getAttribute("aria-valuenow"))).toBeGreaterThan(first);
		fireEvent.pointerUp(document, { pointerId: 1, clientX: 150, buttons: 0 });
		await settle();
		expect(Number(slider.getAttribute("aria-valuenow"))).toBeGreaterThan(100);
		expect(selectedWidth(tool)).toBeGreaterThan(100);
	});
});

async function openWidthSlider(view: RenderResult) {
	fireEvent.click(
		view.getByRole("button", { name: "contextActions.variableFont" }),
	);
	return view.findByRole("slider", { name: "Width" });
}

/** Let valtio deliver the text tool's selection update to React. */
async function settle() {
	await act(async () => {});
}

function selectedWidth(tool: TextTool) {
	const width = tool.getSelectionStyleSummary()?.fontVariations.wdth;
	return width && !width.mixed ? width.value : undefined;
}
