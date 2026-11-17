import { fireEvent, type RenderResult, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FakeInput } from "./FakeInput";

describe("FakeInput", () => {
	describe("when the field is numeric", () => {
		it("should adjust by ten steps with Shift in and out of the editor", () => {
			const onChange = vi.fn();
			const view = render(
				<FakeInput
					type="number"
					value="10"
					step={0.5}
					min={0}
					max={12}
					onChange={onChange}
				/>,
			);
			const field = view.getByRole("spinbutton");
			fireEvent.keyDown(field, { key: "ArrowUp", shiftKey: true });
			expect(onChange).toHaveBeenCalledWith("12");
			fireEvent.doubleClick(field);
			const input = view.getByRole("textbox") as HTMLInputElement;
			fireEvent.keyDown(input, { key: "ArrowDown", shiftKey: true });
			expect(input.value).toBe("5");
			fireEvent.keyDown(input, { key: "Enter" });
			expect(onChange).toHaveBeenLastCalledWith("5");
		});

		it("should adjust the edited value by step and clamp it to the bounds", () => {
			const onChange = vi.fn();
			const view = render(
				<FakeInput
					type="number"
					value="0.2"
					step={0.1}
					min={0}
					max={0.3}
					onChange={onChange}
				/>,
			);
			fireEvent.doubleClick(view.getByRole("spinbutton"));
			const input = view.getByRole("textbox") as HTMLInputElement;

			fireEvent.keyDown(input, { key: "ArrowUp" });
			fireEvent.keyDown(input, { key: "ArrowUp" });
			expect(input.value).toBe("0.3");
			fireEvent.keyDown(input, { key: "ArrowDown" });
			fireEvent.keyDown(input, { key: "ArrowDown" });
			fireEvent.keyDown(input, { key: "Enter" });
			expect(onChange).toHaveBeenCalledWith("0.1");
		});

		it("should adjust the focused field without opening the editor", () => {
			const onChange = vi.fn();
			const view = render(
				<FakeInput type="number" value="10" onChange={onChange} />,
			);
			fireEvent.keyDown(view.getByRole("spinbutton"), { key: "ArrowDown" });
			expect(onChange).toHaveBeenCalledWith("9");
			expect(view.queryByRole("textbox")).toBeNull();
		});
		it("should commit the result of a typed expression", () => {
			const onChange = vi.fn();
			const view = renderNumberField({ value: "10", onChange });

			typeAndCommit(view, "12*3");

			expect(onChange.mock.calls[0][0]).toBe("36");
		});

		it("should read full-width input as half-width", () => {
			const onChange = vi.fn();
			const view = renderNumberField({ value: "10", onChange });

			typeAndCommit(view, "１２＊３");

			expect(onChange.mock.calls[0][0]).toBe("36");
		});

		it("should restore the current value when the input is not a number", () => {
			const onChange = vi.fn();
			const view = renderNumberField({ value: "10", onChange });

			typeAndCommit(view, "12px");

			expect(onChange).not.toHaveBeenCalled();
			expect(view.getByText("10")).toBeTruthy();
		});

		it("should clear the value when the input is emptied", () => {
			const onChange = vi.fn();
			const view = renderNumberField({ value: "10", onChange });

			typeAndCommit(view, "");

			expect(onChange.mock.calls[0][0]).toBeUndefined();
		});
	});

	describe("when a numeric field has no value", () => {
		it("should scrub from the minimum", () => {
			const onChange = vi.fn();
			const view = render(
				<FakeInput
					type="number"
					step={1}
					min={70}
					max={150}
					value=""
					placeholder="Mixed"
					onChange={onChange}
				/>,
			);
			const field = view.getByText("Mixed");

			fireEvent.pointerDown(field, { clientX: 0, pointerId: 1 });
			fireEvent.pointerMove(field, { clientX: 30, pointerId: 1 });
			fireEvent.pointerUp(field, { clientX: 30, pointerId: 1 });

			expect(onChange.mock.calls.at(-1)?.[0]).toBe("80");
		});
	});

	describe("when a numeric field opens on click", () => {
		it("should scrub the value on a horizontal drag without opening the editor", () => {
			const onChange = vi.fn();
			const view = render(
				<FakeInput
					type="number"
					step={1}
					value="10"
					onChange={onChange}
					$behaviour="click"
				/>,
			);
			const field = view.getByText("10");

			fireEvent.pointerDown(field, { clientX: 0, pointerId: 1 });
			fireEvent.pointerMove(field, { clientX: 30, pointerId: 1 });
			fireEvent.pointerUp(field, { clientX: 30, pointerId: 1 });
			fireEvent.click(field);

			expect(onChange.mock.calls.at(-1)?.[0]).toBe("20");
			expect(view.queryByRole("textbox")).toBeNull();
		});

		it("should open the editor on a plain click", () => {
			const view = render(
				<FakeInput
					type="number"
					value="10"
					onChange={vi.fn()}
					$behaviour="click"
				/>,
			);
			const field = view.getByText("10");

			fireEvent.pointerDown(field, { clientX: 0, pointerId: 1 });
			fireEvent.pointerUp(field, { clientX: 0, pointerId: 1 });
			fireEvent.click(field);

			expect(view.getByRole("textbox")).toBeTruthy();
		});
	});

	describe("when the field is textual", () => {
		it("should commit the typed text as it is", () => {
			const onChange = vi.fn();
			const view = render(<FakeInput value="Layer 1" onChange={onChange} />);
			fireEvent.doubleClick(view.getByText("Layer 1"));

			typeAndCommit(view, "12*3");

			expect(onChange.mock.calls[0][0]).toBe("12*3");
		});
	});
});

function renderNumberField(props: Pick<FakeInput.Props, "value" | "onChange">) {
	const view = render(<FakeInput type="number" {...props} />);
	fireEvent.doubleClick(view.getByText(props.value as string));
	return view;
}

function typeAndCommit(view: RenderResult, text: string) {
	const input = view.getByRole("textbox");
	fireEvent.change(input, { target: { value: text } });
	fireEvent.keyDown(input, { key: "Enter" });
}
