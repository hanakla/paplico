import {
	describe,
	expect,
	it,
} from "../../../../../../node_modules/vitest/dist/index";
import type { CubicBezierSegment } from "../../../schema";
import { hashSegmentsWithMetadata } from "./segmentHash";

describe("hashSegmentsWithMetadata", () => {
	function metaSegment(
		overrides: Partial<CubicBezierSegment> = {},
	): CubicBezierSegment {
		return {
			start: { x: 0, y: 0 },
			cp1: { x: 1, y: 0 },
			cp2: { x: -1, y: 0 },
			end: { x: 10, y: 0 },
			startPressure: 0.5,
			endPressure: 0.5,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 10,
			isMoved: true,
			...overrides,
		};
	}

	it("should change when only the twist endpoints change", () => {
		const base = hashSegmentsWithMetadata([metaSegment()]);
		const twisted = hashSegmentsWithMetadata([
			metaSegment({ startTwist: 90, endTwist: 180 }),
		]);
		expect(twisted).not.toBe(base);
	});

	it("should stay stable for identical twist endpoints", () => {
		const a = hashSegmentsWithMetadata([
			metaSegment({ startTwist: 90, endTwist: 180 }),
		]);
		const b = hashSegmentsWithMetadata([
			metaSegment({ startTwist: 90, endTwist: 180 }),
		]);
		expect(a).toBe(b);
	});
});
