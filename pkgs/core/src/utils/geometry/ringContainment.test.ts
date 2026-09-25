import { describe, expect, it } from "vitest";
import {
	type ContainmentRing,
	groupRingsByContainment,
} from "./ringContainment";

describe("groupRingsByContainment", () => {
	it("should fold a counter into its outer", () => {
		const outer = rect(0, 0, 40, 40);
		const counter = reversed(rect(10, 10, 20, 20));

		expect(groupRingsByContainment([outer, counter])).toEqual([[0, 1]]);
	});

	it("should keep separate shapes as separate operands", () => {
		const a = rect(0, 0, 40, 40);
		const b = rect(60, 0, 40, 40);

		expect(groupRingsByContainment([a, b])).toEqual([[0], [1]]);
	});

	it("should fold a counter whose vertices touch the outer's edges", () => {
		// A CJK glyph's strokes meet its outer contour, so a counter's corners
		// sit exactly on the outer's edge — where a vertex-based point-in-polygon
		// test is a coin flip.
		const outer = rect(0, 0, 40, 40);
		const counter = reversed(rect(0, 10, 40, 20));

		expect(groupRingsByContainment([outer, counter])).toEqual([[0, 1]]);
	});

	it("should fold every counter of a multi-part glyph", () => {
		// Two parts side by side, each with two stacked counters, on a shared
		// grid — the arrangement that makes vertex coordinates coincide.
		const left = rect(0, 0, 40, 90);
		const leftTop = reversed(rect(0, 10, 40, 20));
		const leftBottom = reversed(rect(0, 50, 40, 20));
		const right = rect(60, 0, 40, 90);
		const rightTop = reversed(rect(60, 10, 40, 20));
		const rightBottom = reversed(rect(60, 50, 40, 20));

		const groups = groupRingsByContainment([
			left,
			leftTop,
			leftBottom,
			right,
			rightTop,
			rightBottom,
		]);

		expect(groups).toHaveLength(2);
		expect(groups.map((g) => [...g].sort((a, b) => a - b))).toEqual([
			[0, 1, 2],
			[3, 4, 5],
		]);
	});

	it("should start a new shape for a ring nested inside a counter", () => {
		const outer = rect(0, 0, 60, 60);
		const counter = reversed(rect(10, 10, 40, 40));
		const island = rect(20, 20, 20, 20);

		expect(groupRingsByContainment([outer, counter, island])).toEqual([
			[0, 1],
			[2],
		]);
	});
});

function rect(x: number, y: number, w: number, h: number): ContainmentRing {
	return [
		[x, y],
		[x + w, y],
		[x + w, y + h],
		[x, y + h],
	];
}

function reversed(ring: ContainmentRing): ContainmentRing {
	return [...ring].reverse();
}
