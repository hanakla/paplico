import type { LinearGradient, RadialGradient } from "@paplico/core/schema";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GradientPicker, GradientStopsEditor } from "./GradientPicker";

describe("GradientStopsEditor", () => {
	it("duplicates the selected stop between it and its neighbor", () => {
		const stops = [
			{
				offset: 0,
				color: { type: "rgb" as const, r: 1, g: 0, b: 0, a: 0.5 },
				midpoint: 0.3,
			},
			{
				offset: 1,
				color: { type: "rgb" as const, r: 0, g: 0, b: 1, a: 1 },
				midpoint: 0.5,
			},
		];
		const onStopsChange = vi.fn();
		const view = render(
			<GradientStopsEditor stops={stops} onStopsChange={onStopsChange} />,
		);

		fireEvent.click(view.getByRole("button", { name: "Duplicate Stop" }));

		expect(onStopsChange).toHaveBeenCalledWith([
			stops[0],
			{ ...stops[0], offset: 0.5 },
			stops[1],
		]);
	});

	it("disables duplication at the stop limit", () => {
		const stop = {
			offset: 0,
			color: { type: "rgb" as const, r: 0, g: 0, b: 0, a: 1 },
			midpoint: 0.5,
		};
		const view = render(
			<GradientStopsEditor
				stops={[stop]}
				maxStops={1}
				onStopsChange={vi.fn()}
			/>,
		);

		expect(
			view
				.getByRole("button", { name: "Duplicate Stop" })
				.hasAttribute("disabled"),
		).toBe(true);
	});
});

describe("GradientPicker angle", () => {
	it("rotates a linear gradient around its center without changing its length", () => {
		const fill: LinearGradient = {
			type: "linear",
			x1: 0.1,
			y1: 0.3,
			x2: 0.7,
			y2: 0.3,
			stops: [],
		};
		const onFillChange = vi.fn();
		const view = render(
			<GradientPicker fill={fill} onFillChange={onFillChange} />,
		);

		setAngle(view.getByRole("spinbutton", { name: "Rotation (deg)" }), 90);

		const result = onFillChange.mock.lastCall?.[0] as LinearGradient;
		expect(result.x1).toBeCloseTo(0.4);
		expect(result.y1).toBeCloseTo(0);
		expect(result.x2).toBeCloseTo(0.4);
		expect(result.y2).toBeCloseTo(0.6);
	});

	it("changes radial rotation without moving its center or focal point", () => {
		const fill: RadialGradient = {
			type: "radial",
			cx: 0.3,
			cy: 0.4,
			radiusX: 0.6,
			radiusY: 0.2,
			focalX: 0.2,
			focalY: 0.1,
			rotation: 0,
			stops: [],
		};
		const onFillChange = vi.fn();
		const view = render(
			<GradientPicker fill={fill} onFillChange={onFillChange} />,
		);

		setAngle(view.getByRole("spinbutton", { name: "Rotation (deg)" }), 90);

		expect(onFillChange).toHaveBeenLastCalledWith({
			...fill,
			rotation: Math.PI / 2,
		});
	});
});

function setAngle(field: HTMLElement, value: number) {
	fireEvent.doubleClick(field);
	const input = screen.getByRole("textbox");
	fireEvent.change(input, { target: { value: String(value) } });
	fireEvent.keyDown(input, { key: "Enter" });
}
