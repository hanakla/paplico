import { fireEvent, render, screen } from "@testing-library/react";
import type { BrushPropertyConfig } from "@/core/schema";
import { setLanguage } from "@/hooks/useAppConfig";
import { BrushPropertyRow } from "./BrushPropertyRow";

/**
 * Hanging an input on a property must be a reversible, non-destructive step:
 * a brush sounds the same the moment an input is added, and only changes once
 * its curve is shaped.
 */
describe("BrushPropertyRow", () => {
	beforeEach(() => {
		setLanguage("en");
	});

	it("should add a flat curve when an input is picked", () => {
		const onChange = vi.fn();
		render(
			<BrushPropertyRow
				propertyId="size"
				config={{ base: 24 }}
				onChange={onChange}
			/>,
		);

		fireEvent.click(screen.getByLabelText("Influences"));
		fireEvent.click(screen.getByRole("button", { name: "Pressure" }));

		const [propertyId, next] = onChange.mock.calls[0] as [
			string,
			BrushPropertyConfig,
		];
		expect(propertyId).toBe("size");
		expect(next.base).toBe(24);
		expect(next.curves).toEqual([
			{
				input: "pressure",
				points: [
					[0, 0],
					[1, 0],
				],
			},
		]);
	});

	it("should drop the curve when its input is picked again", () => {
		const onChange = vi.fn();
		render(
			<BrushPropertyRow
				propertyId="size"
				config={{
					base: 24,
					curves: [
						{
							input: "pressure",
							points: [
								[0, 0],
								[1, 1],
							],
						},
					],
				}}
				onChange={onChange}
			/>,
		);

		fireEvent.click(screen.getByLabelText("Influences"));
		fireEvent.click(screen.getByRole("button", { name: "Pressure" }));

		const [, next] = onChange.mock.calls[0] as [string, BrushPropertyConfig];
		expect(next.curves).toBeUndefined();
	});

	it("should keep the curves when the base value is dragged", () => {
		const onChange = vi.fn();
		const curves = [
			{
				input: "pressure" as const,
				points: [
					[0, 0],
					[1, 1],
				] as [number, number][],
			},
		];
		render(
			<BrushPropertyRow
				propertyId="flow"
				config={{ base: 1, curves }}
				onChange={onChange}
			/>,
		);

		const slider = screen.getByRole("slider");
		fireEvent.keyDown(slider, { key: "ArrowLeft" });

		const [, next] = onChange.mock.calls[0] as [string, BrushPropertyConfig];
		expect(next.base).toBeLessThan(1);
		expect(next.curves).toEqual(curves);
	});

	it("should show how many inputs a property already responds to", () => {
		render(
			<BrushPropertyRow
				propertyId="size"
				config={{
					base: 24,
					curves: [
						{
							input: "pressure",
							points: [
								[0, 0],
								[1, 1],
							],
						},
						{
							input: "speedFine",
							points: [
								[0, 0],
								[1, 1],
							],
						},
					],
				}}
				onChange={vi.fn()}
			/>,
		);

		expect(screen.getByLabelText("Influences").textContent).toContain("2");
	});
});
