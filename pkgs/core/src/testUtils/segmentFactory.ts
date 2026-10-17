import { createIdentityTransform } from "../document/factory";
import type {
	CubicBezierSegment,
	FillAppearance,
	Path,
	Point,
} from "../schema";

/** Straight-line cubic bezier segment (control points collapsed onto anchors) */
export const lineSeg = (
	end: Point,
	opts: Partial<CubicBezierSegment> = {},
): CubicBezierSegment => ({
	cp1: { x: 0, y: 0 },
	cp2: { x: 0, y: 0 },
	end,
	startTiltX: 0,
	startTiltY: 0,
	endTiltX: 0,
	endTiltY: 0,
	startDeltaTime: 0,
	endDeltaTime: 0,
	isMoved: false,
	...opts,
});

/** Closed axis-aligned rectangle: (x0,y0) → (x1,y0) → (x1,y1) → (x0,y1) → close */
export const closedRectSegments = (
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): CubicBezierSegment[] => [
	lineSeg({ x: x1, y: y0 }, { start: { x: x0, y: y0 } }),
	lineSeg({ x: x1, y: y1 }),
	lineSeg({ x: x0, y: y1 }),
	lineSeg({ x: x0, y: y0 }, { isClosed: true }),
];

export const KAPPA = 0.552284749831;

// ============================================================================
// Test helpers — after all test cases
// ============================================================================

/**
 * Closed rectangular path with straight-line segments (cp offsets = 0).
 * 4 segments: top → right → bottom → left, closed.
 */
export function createFilledRect(
	x: number,
	y: number,
	w: number,
	h: number,
): Path {
	return {
		type: "path",
		id: "test-filled-rect",
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		filters: [
			{
				processor: "fill",
				paramData: {
					version: "1",
					params: {
						fill: {
							type: "solid",
							color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
						},
					},
				},
			} as FillAppearance,
		],
		segments: [
			{
				start: { x, y },
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: x + w, y },
				isMoved: true,
				startPressure: 0.5,
				endPressure: 0.5,
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
			},
			{
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: x + w, y: y + h },
				isMoved: false,
				startPressure: 0.5,
				endPressure: 0.5,
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
			},
			{
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x, y: y + h },
				isMoved: false,
				startPressure: 0.5,
				endPressure: 0.5,
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
			},
			{
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x, y },
				isMoved: false,
				isClosed: true,
				startPressure: 0.5,
				endPressure: 0.5,
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
			},
		],
	} as unknown as Path;
}

/** Three-segment path: (0,0) → (100,0) → (200,0) → (300,0) */
export function threeSegmentPath(): Path {
	return {
		id: "p3",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		segments: [
			{
				start: { x: 0, y: 0 },
				cp1: { x: 33, y: 0 },
				cp2: { x: -33, y: 0 },
				end: { x: 100, y: 0 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: true,
			},
			{
				cp1: { x: 33, y: 0 },
				cp2: { x: -33, y: 0 },
				end: { x: 200, y: 0 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: false,
			},
			{
				cp1: { x: 33, y: 0 },
				cp2: { x: -33, y: 0 },
				end: { x: 300, y: 0 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: false,
			},
		],
	};
}
