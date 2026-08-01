import type { CubicBezierSegment } from "@/core/schema";
import { deformPathSegments } from "./pointDeform";

describe("deformPathSegments", () => {
	it("should carry the opening point of every contour along", () => {
		const segments = [
			// One square...
			segment({ x: 0, y: 0 }, { x: 10, y: 0 }),
			segment(undefined, { x: 10, y: 10 }),
			// ...and a second one, opening with its own start.
			segment({ x: 50, y: 50 }, { x: 60, y: 50 }),
			segment(undefined, { x: 60, y: 60 }),
		];

		const moved = deformPathSegments(segments, (p) => ({
			x: p.x + 1000,
			y: p.y + 2000,
		}));

		expect(moved[0].start).toMatchObject({ x: 1000, y: 2000 });
		expect(moved[1].start).toBeUndefined();
		// Without this the second contour would still open at (50,50) and reach
		// back to where the shape used to be.
		expect(moved[2].start).toMatchObject({ x: 1050, y: 2050 });
		expect(moved[3].start).toBeUndefined();
		expect(moved.map((s) => [s.end.x, s.end.y])).toEqual([
			[1010, 2000],
			[1010, 2010],
			[1060, 2050],
			[1060, 2060],
		]);
	});

	it("should keep control points relative to their own anchors", () => {
		const segments = [
			segment({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 3, y: 0 }, { x: -3, y: 0 }),
		];

		const moved = deformPathSegments(segments, (p) => ({
			x: p.x * 2,
			y: p.y * 2,
		}));

		// Doubling the space doubles the offsets, and they stay offsets.
		expect(moved[0].cp1).toMatchObject({ x: 6, y: 0 });
		expect(moved[0].cp2).toMatchObject({ x: -6, y: 0 });
		expect(moved[0].end).toMatchObject({ x: 20, y: 0 });
	});
});

function segment(
	start: { x: number; y: number } | undefined,
	end: { x: number; y: number },
	cp1: { x: number; y: number } = { x: 0, y: 0 },
	cp2: { x: number; y: number } = { x: 0, y: 0 },
): CubicBezierSegment {
	return {
		start,
		cp1,
		cp2,
		end,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		startPressure: 1,
		endPressure: 1,
	} as CubicBezierSegment;
}
