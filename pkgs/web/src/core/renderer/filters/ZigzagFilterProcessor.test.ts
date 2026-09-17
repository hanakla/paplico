import type { CubicBezierSegment } from "../../schema";
import {
	type ZigzagFilter,
	ZigzagFilterHandler,
} from "./ZigzagFilterProcessor";

describe("ZigzagFilterHandler", () => {
	describe("preProcess with rounded corners", () => {
		it.each([
			0.5, 5, 20, 40,
		])("should keep the wave height at amplitude %s", (amplitude) => {
			const result = new ZigzagFilterHandler().preProcess(
				[straightLine(500)],
				zigzagFilter(amplitude, 0.5),
			);

			expect(maxAbsY(result)).toBeCloseTo(amplitude, 0);
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

function zigzagFilter(amplitude: number, roundCorners: number): ZigzagFilter {
	return {
		uid: "zigzag",
		processor: "zigzag",
		paramData: {
			version: "1",
			params: { frequency: 10, amplitude, roundCorners },
		},
	} as ZigzagFilter;
}

/** Peak height of the curve, sampled along each cubic */
function maxAbsY(segments: CubicBezierSegment[]): number {
	let max = 0;
	let prevY = segments[0].start?.y ?? 0;
	for (const seg of segments) {
		const p0 = seg.start?.y ?? prevY;
		const p3 = seg.end.y;
		const p1 = p0 + seg.cp1.y;
		const p2 = p3 + seg.cp2.y;
		for (let i = 0; i <= 16; i++) {
			const t = i / 16;
			const u = 1 - t;
			const y =
				u * u * u * p0 +
				3 * u * u * t * p1 +
				3 * u * t * t * p2 +
				t * t * t * p3;
			max = Math.max(max, Math.abs(y));
		}
		prevY = p3;
	}
	return max;
}
