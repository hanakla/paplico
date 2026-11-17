import {
	act,
	cleanup,
	fireEvent,
	render,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uiState } from "@/stores/uiStore";
import { TextEditOverlay } from "./TextEditOverlay";

const tool = vi.hoisted(() => ({
	startComposition: vi.fn(),
	updateComposition: vi.fn(),
	updateCompositionFormats: vi.fn(),
	endComposition: vi.fn(),
	insertText: vi.fn(),
	insertNewline: vi.fn(),
}));
const paplico = vi.hoisted(() => ({
	textToolController: { getTextTool: () => tool },
	ui: { focusCanvas: vi.fn() },
}));

vi.mock("@/contexts/PaplicoContext", () => ({
	usePaplico: () => paplico,
	usePaplicoMaybe: () => paplico,
}));
vi.mock("@/contexts/ViewIdContext", () => ({
	useTargetViewport: () => ({ x: 0, y: 0, zoom: 1 }),
}));

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	uiState.textEditState.isEditing = false;
});

describe("text input", () => {
	it("shows IME formatting and commits the composition through EditContext", async () => {
		vi.stubGlobal("EditContext", FakeEditContext);
		uiState.textEditState.isEditing = true;
		const view = render(
			<TextEditOverlay canvasWidth={800} canvasHeight={600} />,
		);
		await waitFor(() => expect(view.getByRole("textbox").tagName).toBe("DIV"));
		const context = (
			view.getByRole("textbox") as HTMLDivElement & {
				editContext: FakeEditContext;
			}
		).editContext;
		act(() => {
			context.dispatchEvent(new Event("compositionstart"));
			context.text = "愛してる";
			context.dispatchEvent(
				Object.assign(new Event("textupdate"), { text: context.text }),
			);
			context.dispatchEvent(
				Object.assign(new Event("textformatupdate"), {
					getTextFormats: () => [
						{
							rangeStart: 0,
							rangeEnd: 1,
							underlineStyle: "solid",
							underlineThickness: "thick",
						},
						{
							rangeStart: 1,
							rangeEnd: 4,
							underlineStyle: "solid",
							underlineThickness: "thin",
						},
					],
				}),
			);
			context.dispatchEvent(new Event("compositionend"));
		});
		expect(tool.updateComposition).toHaveBeenCalledWith("愛してる");
		expect(tool.updateCompositionFormats).toHaveBeenCalledWith([
			{ start: 0, end: 1, thick: true },
			{ start: 1, end: 4, thick: false },
		]);
		expect(tool.endComposition).toHaveBeenCalledWith("愛してる");
		expect(tool.insertText).not.toHaveBeenCalled();
	});

	it("keeps the textarea when EditContext is unavailable", () => {
		uiState.textEditState.isEditing = true;
		const view = render(
			<TextEditOverlay canvasWidth={800} canvasHeight={600} />,
		);
		expect(view.container.querySelector("textarea")).not.toBeNull();
	});

	it("does not insert a newline when Enter ends an IME composition", async () => {
		vi.stubGlobal("EditContext", FakeEditContext);
		uiState.textEditState.isEditing = true;
		const view = render(
			<TextEditOverlay canvasWidth={800} canvasHeight={600} />,
		);
		await waitFor(() => expect(view.getByRole("textbox").tagName).toBe("DIV"));
		const element = view.getByRole("textbox");
		const context = (
			element as HTMLDivElement & { editContext: FakeEditContext }
		).editContext;
		act(() => {
			context.dispatchEvent(new Event("compositionstart"));
			context.text = "愛";
			context.dispatchEvent(new Event("compositionend"));
			fireEvent.keyDown(element, { key: "Enter" });
		});
		expect(tool.endComposition).toHaveBeenCalledWith("愛");
		expect(tool.insertNewline).not.toHaveBeenCalled();
		await new Promise((resolve) => setTimeout(resolve, 0));
		fireEvent.keyDown(element, { key: "Enter" });
		expect(tool.insertNewline).toHaveBeenCalledOnce();
	});
});

class FakeEditContext extends EventTarget {
	public text = "";
	public updateText(): void {
		this.text = "";
	}
	public updateSelection(): void {}
	public updateControlBounds(): void {}
	public updateSelectionBounds(): void {}
}
