import type { BezierPoint, Viewport } from "../../schema";
import { processStroke } from "./strokeFitting";

const viewport: Viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

function linePoints(
	twistOf: (index: number) => number,
	count = 20,
): BezierPoint[] {
	return Array.from({ length: count }, (_, i) => ({
		x: i * 10,
		y: 0,
		pressure: 0.5,
		tiltX: 0,
		tiltY: 0,
		twist: twistOf(i),
		deltaTime: i * 10,
	}));
}

describe("processStroke twist propagation", () => {
	it("should carry twist endpoints into every fitted segment", () => {
		const segments = processStroke(
			linePoints((i) => 10 + i * 2),
			0.5,
			viewport,
			"smooth",
		);
		expect(segments.length).toBeGreaterThan(0);
		for (const segment of segments) {
			expect(segment.startTwist).toBeDefined();
			expect(segment.endTwist).toBeDefined();
			expect(segment.startTwist).toBeGreaterThanOrEqual(0);
			expect(segment.startTwist).toBeLessThan(360);
		}
		// Twist grows along the stroke, so the fitted endpoints must too.
		const first = segments[0];
		const last = segments[segments.length - 1];
		expect((last.endTwist ?? 0) > (first.startTwist ?? 0)).toBe(true);
	});

	it("should average twist across the 0/360 wrap without collapsing to 180", () => {
		// Alternating 350 and 10 degrees: the angular mean is 0 (or 360), and a
		// naive linear average would land at 180.
		const segments = processStroke(
			linePoints((i) => (i % 2 === 0 ? 350 : 10)),
			0.8,
			viewport,
			"smooth",
		);
		for (const segment of segments) {
			for (const twist of [segment.startTwist ?? 0, segment.endTwist ?? 0]) {
				const wrapped = ((twist % 360) + 360) % 360;
				const nearWrap = wrapped >= 330 || wrapped <= 30;
				expect(nearWrap).toBe(true);
			}
		}
	});
});
