import { defaultTextEditState, TextToolController } from "./TextToolController";

describe("IME composition overlay", () => {
	it("draws each composing line and clears it after composition", async () => {
		const controller = new TextToolController({ ...defaultTextEditState });
		const onChange = vi.fn();
		controller.setOnTextEditUIChange(onChange);
		controller.startTextEdit("text", 0, 0, 20);
		await controller.updateTextRange(
			Promise.resolve([
				{ x: 10, y: 20, width: 30, height: 10 },
				{ x: 10, y: 5, width: 15, height: 10 },
			]),
			true,
		);
		expect(onChange.mock.calls.at(-1)?.[0].compositionUnderlines).toEqual([
			{ x: 10, y: 20, length: 30, rotation: 0, thick: true },
			{ x: 10, y: 5, length: 15, rotation: 0, thick: true },
		]);
		await controller.updateTextRange(Promise.resolve([]), false);
		expect(onChange.mock.calls.at(-1)?.[0].compositionUnderlines).toEqual([]);
		controller.endTextEdit();
	});

	it("ignores composition geometry that arrives after commit", async () => {
		const controller = new TextToolController({ ...defaultTextEditState });
		const onChange = vi.fn();
		controller.setOnTextEditUIChange(onChange);
		controller.startTextEdit("text", 0, 0, 20);
		let resolveRects: (
			rects: { x: number; y: number; width: number; height: number }[],
		) => void = () => {};
		const pending = controller.updateTextRange(
			new Promise((resolve) => {
				resolveRects = resolve;
			}),
			true,
		);
		await controller.updateTextRange(Promise.resolve([]), false);
		resolveRects([{ x: 0, y: 0, width: 10, height: 10 }]);
		await pending;
		expect(onChange.mock.calls.at(-1)?.[0].compositionUnderlines).toEqual([]);
		controller.endTextEdit();
	});
});
