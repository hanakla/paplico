import { describe, expect, it } from "vitest";
import type { BoundingBox } from "../../schema";
import {
	type AlignItem,
	computeAlignDeltas,
	computeDistributeDeltas,
	unionBounds,
} from "./align";

describe("computeAlignDeltas", () => {
	// A: left=0,   B: left=100, C: left=40  (widths 20 / 60 / 20)
	const a: AlignItem = { id: "A", bounds: bbox(0, 100, 20, 140) };
	const b: AlignItem = { id: "B", bounds: bbox(100, 60, 160, 100) };
	const c: AlignItem = { id: "C", bounds: bbox(40, 20, 60, 40) };
	const items = [a, b, c];

	describe("with a key-object reference (B)", () => {
		const reference = b.bounds;

		it("should align left edges to the reference and leave the reference put", () => {
			const d = computeAlignDeltas(items, "left", reference);
			expect(d.get("B")).toEqual({ dx: 0, dy: 0 });
			expect(d.get("A")).toEqual({ dx: 100, dy: 0 });
			expect(d.get("C")).toEqual({ dx: 60, dy: 0 });
		});

		it("should align right edges to the reference", () => {
			const d = computeAlignDeltas(items, "right", reference);
			expect(d.get("B")).toEqual({ dx: 0, dy: 0 });
			// A right edge 20 -> 160
			expect(d.get("A")).toEqual({ dx: 140, dy: 0 });
			// C right edge 60 -> 160
			expect(d.get("C")).toEqual({ dx: 100, dy: 0 });
		});

		it("should align horizontal centers to the reference", () => {
			const d = computeAlignDeltas(items, "centerH", reference);
			// reference center x = 130; A center = 10 -> +120; C center = 50 -> +80
			expect(d.get("A")).toEqual({ dx: 120, dy: 0 });
			expect(d.get("C")).toEqual({ dx: 80, dy: 0 });
		});

		it("should align top edges (world Y up: maxY) to the reference", () => {
			const d = computeAlignDeltas(items, "top", reference);
			// reference maxY = 100; A maxY 140 -> -40; C maxY 40 -> +60
			expect(d.get("A")).toEqual({ dx: 0, dy: -40 });
			expect(d.get("C")).toEqual({ dx: 0, dy: 60 });
		});

		it("should align bottom edges (minY) to the reference", () => {
			const d = computeAlignDeltas(items, "bottom", reference);
			// reference minY = 60; A minY 100 -> -40; C minY 20 -> +40
			expect(d.get("A")).toEqual({ dx: 0, dy: -40 });
			expect(d.get("C")).toEqual({ dx: 0, dy: 40 });
		});
	});

	it("should align to the union bounds when there is no key object", () => {
		const reference = unionBounds(items)!;
		// union minX = 0
		const d = computeAlignDeltas(items, "left", reference);
		expect(d.get("A")).toEqual({ dx: 0, dy: 0 });
		expect(d.get("B")).toEqual({ dx: -100, dy: 0 });
		expect(d.get("C")).toEqual({ dx: -40, dy: 0 });
	});
});

describe("computeDistributeDeltas", () => {
	it("should keep the extremes fixed and evenly space centers horizontally", () => {
		// centers x: A=10, B=110, C=40 -> sorted A(10),C(40),B(110)
		// step = (110-10)/2 = 50; C target center = 60 -> +20
		const items = [
			{ id: "A", bounds: bbox(0, 0, 20, 20) },
			{ id: "B", bounds: bbox(100, 0, 120, 20) },
			{ id: "C", bounds: bbox(30, 0, 50, 20) },
		];
		const d = computeDistributeDeltas(items, "horizontal");
		expect(d.get("A")).toEqual({ dx: 0, dy: 0 });
		expect(d.get("B")).toEqual({ dx: 0, dy: 0 });
		expect(d.get("C")).toEqual({ dx: 20, dy: 0 });
	});

	it("should evenly space centers vertically", () => {
		// centers y: A=10, B=110, C=30 -> step 50; C -> 60 => +30
		const items = [
			{ id: "A", bounds: bbox(0, 0, 20, 20) },
			{ id: "B", bounds: bbox(0, 100, 20, 120) },
			{ id: "C", bounds: bbox(0, 20, 20, 40) },
		];
		const d = computeDistributeDeltas(items, "vertical");
		expect(d.get("A")).toEqual({ dx: 0, dy: 0 });
		expect(d.get("B")).toEqual({ dx: 0, dy: 0 });
		expect(d.get("C")).toEqual({ dx: 0, dy: 30 });
	});

	it("should return no deltas for fewer than 3 items", () => {
		const items = [
			{ id: "A", bounds: bbox(0, 0, 20, 20) },
			{ id: "B", bounds: bbox(100, 0, 120, 20) },
		];
		expect(computeDistributeDeltas(items, "horizontal").size).toBe(0);
	});
});

function bbox(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): BoundingBox {
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
