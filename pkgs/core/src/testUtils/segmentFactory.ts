import type { CubicBezierSegment, Point } from "../schema";

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
