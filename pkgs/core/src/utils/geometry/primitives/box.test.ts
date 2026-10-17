import {
	describe,
	expect,
	it,
} from "../../../../../../node_modules/vitest/dist/index";
import type { BoundingBox } from "../../../schema";
import { expandBounds } from "./box";

describe("expandBounds", () => {
	it("should expand bounds by margin", () => {
		const bounds: BoundingBox = {
			minX: 10,
			minY: 20,
			maxX: 30,
			maxY: 40,
			width: 20,
			height: 20,
		};

		const expanded = expandBounds(bounds, 5);

		expect(expanded.minX).toBe(5);
		expect(expanded.minY).toBe(15);
		expect(expanded.maxX).toBe(35);
		expect(expanded.maxY).toBe(45);
		expect(expanded.width).toBe(30);
		expect(expanded.height).toBe(30);
	});

	it("should handle negative margin (shrink)", () => {
		const bounds: BoundingBox = {
			minX: 0,
			minY: 0,
			maxX: 100,
			maxY: 100,
			width: 100,
			height: 100,
		};

		const shrunk = expandBounds(bounds, -10);

		expect(shrunk.minX).toBe(10);
		expect(shrunk.minY).toBe(10);
		expect(shrunk.maxX).toBe(90);
		expect(shrunk.maxY).toBe(90);
		expect(shrunk.width).toBe(80);
		expect(shrunk.height).toBe(80);
	});
});
