import { describe, expect, it } from "vitest";
import { clampBarPosition } from "./clampBarPosition";

describe("clampBarPosition", () => {
	it("should keep the anchor as is when the bar fits where it points", () => {
		const { left, top } = clampBarPosition(baseInput());

		expect(left).toBe(400);
		expect(top).toBe(300);
	});

	it("should keep the bar inside the pane when the anchor is past its edge", () => {
		const { left, top } = clampBarPosition(
			baseInput({ anchor: { x: -50, y: 4 } }),
		);

		expect(left).toBe(8 + barSize.width / 2);
		expect(top).toBe(8 + barSize.height);
	});

	it("should push the bar off a panel docked on the right", () => {
		const { left } = clampBarPosition(
			baseInput({
				anchor: { x: 780, y: 300 },
				obstacles: [{ left: 592, top: 0, right: 800, bottom: 600 }],
			}),
		);

		expect(left).toBe(592 - 8 - barSize.width / 2);
	});

	it("should push the bar off a panel docked on the left", () => {
		const { left } = clampBarPosition(
			baseInput({
				anchor: { x: 20, y: 300 },
				obstacles: [{ left: 0, top: 0, right: 208, bottom: 600 }],
			}),
		);

		expect(left).toBe(208 + 8 + barSize.width / 2);
	});

	it("should push the bar below a menu bar spanning the pane width", () => {
		const { top } = clampBarPosition(
			baseInput({
				anchor: { x: 400, y: 20 },
				obstacles: [{ left: 0, top: 0, right: 800, bottom: 40 }],
			}),
		);

		expect(top).toBe(40 + 8 + barSize.height);
	});

	it("should clamp the position the user dragged the bar to", () => {
		const { left } = clampBarPosition(
			baseInput({
				offset: { x: 400, y: 0 },
				obstacles: [{ left: 592, top: 0, right: 800, bottom: 600 }],
			}),
		);

		expect(left).toBe(592 - 8 - barSize.width / 2);
	});

	it("should center the bar when the safe area is narrower than it", () => {
		const { left } = clampBarPosition(
			baseInput({
				anchor: { x: 100, y: 300 },
				obstacles: [
					{ left: 0, top: 0, right: 380, bottom: 600 },
					{ left: 420, top: 0, right: 800, bottom: 600 },
				],
			}),
		);

		expect(left).toBe(400);
	});

	it("should convert obstacles into the pane space of a split view pane", () => {
		const { left } = clampBarPosition(
			baseInput({
				anchor: { x: 380, y: 300 },
				paneRect: { left: 400, top: 0, right: 800, bottom: 600 },
				obstacles: [{ left: 700, top: 0, right: 800, bottom: 600 }],
			}),
		);

		expect(left).toBe(700 - 400 - 8 - barSize.width / 2);
	});
});

const barSize = { width: 200, height: 40 };

function baseInput(
	overrides: Partial<Parameters<typeof clampBarPosition>[0]> = {},
): Parameters<typeof clampBarPosition>[0] {
	return {
		anchor: { x: 400, y: 300 },
		offset: { x: 0, y: 0 },
		barSize,
		paneRect: { left: 0, top: 0, right: 800, bottom: 600 },
		obstacles: [],
		...overrides,
	};
}
