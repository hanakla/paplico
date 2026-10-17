import type { CubicBezierSegment } from "../../../schema";
import { splitBezierAtT } from "../primitives/bezier";
import {
	resolveSegment,
	toRelativeCP1,
	toRelativeCP2,
} from "../primitives/segment";

/**
 * Append `segments` to `result` as a new sub-path. The appended run's first
 * segment is re-marked `isMoved` so concatenating several outlines produces one
 * multi-subpath list instead of a single run joined end to end.
 */
export function appendSubpath(
	result: CubicBezierSegment[],
	segments: readonly CubicBezierSegment[],
): void {
	if (segments.length === 0) return;
	result.push({ ...segments[0], isMoved: true });
	for (let i = 1; i < segments.length; i++) result.push(segments[i]);
}

/** Split a segment at parameter t, returning a new segments array with the target replaced by two */
export function splitSegmentAtIndex(
	segments: CubicBezierSegment[],
	segmentIndex: number,
	t: number,
): CubicBezierSegment[] {
	const seg = segments[segmentIndex];
	const prevEnd = segmentIndex > 0 ? segments[segmentIndex - 1].end : undefined;
	const { start, cp1, cp2, end } = resolveSegment(seg, prevEnd);
	const [left, right] = splitBezierAtT(start, cp1, cp2, end, t);

	const midPoint = left.p3;
	const leftSeg: CubicBezierSegment = {
		start: segmentIndex === 0 ? seg.start : undefined,
		cp1: toRelativeCP1(left.p1, left.p0),
		cp2: toRelativeCP2(left.p2, midPoint),
		end: midPoint,
		isMoved: seg.isMoved,
		startTiltX: seg.startTiltX,
		startTiltY: seg.startTiltY,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: seg.startDeltaTime,
		endDeltaTime: 0,
	};
	const rightSeg: CubicBezierSegment = {
		cp1: toRelativeCP1(right.p1, midPoint),
		cp2: toRelativeCP2(right.p2, end),
		end: { ...end },
		isMoved: false,
		isClosed: seg.isClosed,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: seg.endTiltX,
		endTiltY: seg.endTiltY,
		startDeltaTime: 0,
		endDeltaTime: seg.endDeltaTime,
	};

	const result = [...segments];
	result.splice(segmentIndex, 1, leftSeg, rightSeg);
	return result;
}

/**
 * Reverse a subpath's winding direction by reversing segment order
 * and swapping start/end + cp1/cp2 within each segment.
 */
export function reverseSubPath(
	segments: CubicBezierSegment[],
): CubicBezierSegment[] {
	const reversed: CubicBezierSegment[] = [];

	for (let i = segments.length - 1; i >= 0; i--) {
		const seg = segments[i];
		const prevEnd = i > 0 ? segments[i - 1].end : undefined;
		const resolved = resolveSegment(seg, prevEnd);

		const newSeg: CubicBezierSegment = {
			// cp1 is relative to start: old cp2 (relative to old end) becomes new cp1
			cp1: {
				x: seg.cp2.x,
				y: seg.cp2.y,
				pressure: seg.endPressure,
			},
			// cp2 is relative to end: old cp1 (relative to old start) becomes new cp2
			cp2: {
				x: seg.cp1.x,
				y: seg.cp1.y,
				pressure: seg.startPressure,
			},
			end: {
				x: resolved.start.x,
				y: resolved.start.y,
				pressure: seg.startPressure,
			},
			startPressure: seg.endPressure,
			endPressure: seg.startPressure,
			startTiltX: seg.endTiltX ?? 0,
			startTiltY: seg.endTiltY ?? 0,
			endTiltX: seg.startTiltX ?? 0,
			endTiltY: seg.startTiltY ?? 0,
			startDeltaTime: seg.endDeltaTime ?? 0,
			endDeltaTime: seg.startDeltaTime ?? 0,
			isMoved: false,
		};

		if (i === segments.length - 1) {
			// First segment of reversed path gets explicit start
			newSeg.start = {
				x: resolved.end.x,
				y: resolved.end.y,
				pressure: seg.endPressure,
			};
		}

		reversed.push(newSeg);
	}

	// Carry isClosed from the original last segment to the new last segment
	if (segments.at(-1)?.isClosed && reversed.length > 0) {
		reversed.at(-1)!.isClosed = true;
	}

	return reversed;
}
