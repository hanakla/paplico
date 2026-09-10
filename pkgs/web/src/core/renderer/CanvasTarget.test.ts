import { describe, expect, it, vi } from "vitest";
import { createDefaultViewport } from "../document/factory";
import { degToRad } from "../utils/math";
import { CanvasTarget } from "./CanvasTarget";

function createCanvas(): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	Object.defineProperty(canvas, "getBoundingClientRect", {
		configurable: true,
		value: () =>
			({
				width: 200,
				height: 100,
				top: 0,
				left: 0,
				right: 200,
				bottom: 100,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			}) as DOMRect,
	});
	return canvas;
}

describe("CanvasTarget", () => {
	it("emits viewportChanged once when setViewport changes values", () => {
		const target = new CanvasTarget(createCanvas(), {
			viewport: createDefaultViewport(),
		});
		const handler = vi.fn();
		target.on("viewportChanged", handler);

		target.setViewport({ x: 40 });

		expect(handler).toHaveBeenCalledTimes(1);
		const payload = handler.mock.calls[0][0];
		expect(payload.previous).toEqual({ x: 0, y: 0, zoom: 1, rotation: 0 });
		expect(payload.current).toEqual({ x: 40, y: 0, zoom: 1, rotation: 0 });
		expect(target.getViewport()).toEqual(payload.current);
	});

	it("emits viewportChanged when setViewport receives a full viewport", () => {
		const target = new CanvasTarget(createCanvas(), {
			viewport: createDefaultViewport(),
		});
		const handler = vi.fn();
		target.on("viewportChanged", handler);

		target.setViewport({
			x: 10,
			y: -20,
			zoom: 2,
			rotation: degToRad(15),
		});

		expect(handler).toHaveBeenCalledTimes(1);
		const payload = handler.mock.calls[0][0];
		expect(payload.previous).toEqual({ x: 0, y: 0, zoom: 1, rotation: 0 });
		expect(payload.current).toEqual({
			x: 10,
			y: -20,
			zoom: 2,
			rotation: degToRad(15),
		});
		expect(target.getViewport()).toEqual(payload.current);
	});

	it("does not emit viewportChanged when values are unchanged", () => {
		const target = new CanvasTarget(createCanvas(), {
			viewport: createDefaultViewport(),
		});
		const handler = vi.fn();
		target.on("viewportChanged", handler);

		target.setViewport({ x: 0 });
		target.setViewport({ x: 0, y: 0, zoom: 1, rotation: 0 });

		expect(handler).not.toHaveBeenCalled();
	});
});
