import type { CubicBezierSegment } from "../../schema";
import { type RoughFilter, RoughFilterHandler } from "./RoughFilterProcessor";

describe("RoughFilterHandler", () => {
	describe("preProcess", () => {
		it("should return the same shape for the same seed", () => {
			const handler = new RoughFilterHandler();

			expect(handler.preProcess([straightLine(500)], roughFilter(3))).toEqual(
				handler.preProcess([straightLine(500)], roughFilter(3)),
			);
		});

		it("should return a different shape for a different seed", () => {
			const handler = new RoughFilterHandler();

			expect(
				handler.preProcess([straightLine(500)], roughFilter(3)),
			).not.toEqual(handler.preProcess([straightLine(500)], roughFilter(4)));
		});

		it("should move every point across the path by at most size", () => {
			const size = 8;
			const detail = 20;
			const result = new RoughFilterHandler().preProcess(
				[straightLine(500)],
				roughFilter(1, size, detail),
			);

			expect(result).toHaveLength(detail + 1);
			for (const [index, seg] of result.entries()) {
				const onPathX = ((index + 1) / (detail + 1)) * 500;
				expect(seg.end.x).toBeCloseTo(onPathX, 6);
				expect(Math.abs(seg.end.y)).toBeLessThanOrEqual(size);
			}
		});

		it("should keep the anchors of an open path in place", () => {
			const result = new RoughFilterHandler().preProcess(
				[straightLine(500)],
				roughFilter(1),
			);

			expect(result[0].start).toMatchObject({ x: 0, y: 0 });
			expect(result.at(-1)?.end).toMatchObject({ x: 500, y: 0 });
		});
	});
});

function straightLine(length: number): CubicBezierSegment {
	return {
		start: { x: 0, y: 0 },
		cp1: { x: length / 3, y: 0 },
		cp2: { x: -length / 3, y: 0 },
		end: { x: length, y: 0 },
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: true,
	};
}

function roughFilter(seed: number, size = 5, detail = 10): RoughFilter {
	return {
		uid: "rough",
		processor: "rough",
		paramData: { version: "1", params: { size, detail, seed } },
	} as RoughFilter;
}
