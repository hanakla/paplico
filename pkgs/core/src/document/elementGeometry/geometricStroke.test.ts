import { describe, expect, it } from "vitest";
import type { LineCap } from "../../schema";
import { closedRectSegments, lineSeg } from "../../testUtils/segmentFactory";
import { coversPoint } from "../../testUtils/triangleSoup";
import {
	type GeometricStrokeShape,
	tessellateGeometricStroke,
} from "./geometricStroke";

describe("tessellateGeometricStroke with zero-length dashes", () => {
	it("should draw a round dot at every pattern repeat along an open path", () => {
		const { triangles } = tessellateGeometricStroke(
			[lineSeg({ x: 10, y: 0 }, { start: { x: 0, y: 0 } })],
			dotted("round"),
			0,
			false,
		);

		for (const x of [0, 3, 6, 9]) {
			expect(coversPoint(triangles, x, 0)).toBe(true);
			expect(coversPoint(triangles, x + 1.5, 0)).toBe(false);
		}
	});

	it("should draw square dots that extend half the width along the path", () => {
		const { triangles } = tessellateGeometricStroke(
			[lineSeg({ x: 10, y: 0 }, { start: { x: 0, y: 0 } })],
			dotted("square"),
			0,
			false,
		);

		expect(coversPoint(triangles, 3.4, 0.4)).toBe(true);
		expect(coversPoint(triangles, 3.6, 0)).toBe(false);
	});

	it("should draw nothing with a butt cap", () => {
		const { triangles } = tessellateGeometricStroke(
			[lineSeg({ x: 10, y: 0 }, { start: { x: 0, y: 0 } })],
			dotted("butt"),
			0,
			false,
		);

		expect(triangles).toHaveLength(0);
	});

	it("should draw one dot per repeat around a closed path without doubling the seam", () => {
		// Perimeter 12 with a 3-unit repeat: one dot on each corner.
		const closed = tessellateGeometricStroke(
			closedRectSegments(0, 0, 3, 3),
			dotted("round"),
			0,
			false,
		).triangles;
		const single = tessellateGeometricStroke(
			[lineSeg({ x: 1, y: 0 }, { start: { x: 0, y: 0 } })],
			dotted("round"),
			0,
			false,
		).triangles;

		expect(closed).toHaveLength(single.length * 4);
		for (const [x, y] of [
			[0, 0],
			[3, 0],
			[3, 3],
			[0, 3],
		]) {
			expect(coversPoint(closed, x, y)).toBe(true);
		}
		expect(coversPoint(closed, 1.5, 0)).toBe(false);
	});

	it("should place each dot's gradient t at its position along the path", () => {
		const { triangles, params } = tessellateGeometricStroke(
			[lineSeg({ x: 10, y: 0 }, { start: { x: 0, y: 0 } })],
			dotted("round"),
			0,
			true,
		);

		expect(params).toHaveLength(triangles.length);
		const ts = new Set<number>();
		for (let i = 0; i < params.length; i += 2) {
			ts.add(Number(params[i].toFixed(6)));
		}
		expect([...ts]).toEqual([0, 0.3, 0.6, 0.9]);
	});
});

/** A 1-unit-wide stroke dashed as a dot every 3 units. */
function dotted(lineCap: LineCap): GeometricStrokeShape {
	return {
		width: 1,
		sizeByPressure: 0,
		lineCap,
		lineJoin: "round",
		miterLimit: 4,
		dashArray: [0, 3],
	};
}
