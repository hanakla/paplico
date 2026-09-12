import { fireEvent, type RenderResult, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FakeInput } from "./FakeInput";

describe("FakeInput", () => {
	describe("when the field is numeric", () => {
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
