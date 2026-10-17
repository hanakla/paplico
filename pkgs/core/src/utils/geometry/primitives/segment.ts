import type { BezierPoint, CubicBezierSegment } from "../../../schema";

/**
 * セグメントの開始アンカーを解決する。
 * segment.startがあればそれを返し、なければprevEnd（前のセグメントのend）を返す。
 */
export function getStartAnchor(
	segment: CubicBezierSegment,
	prevEnd?: BezierPoint,
): BezierPoint {
	// biome-ignore lint/style/noNonNullAssertion: prevEndは最初のセグメントではsegment.startが存在し、それ以降では呼び出し元が必ず提供する
	return segment.start ?? prevEnd!;
}

/**
 * 相対cp1を絶対ワールド座標に復元する。
 * cp1は開始アンカーからの相対オフセット。
 */
export function resolveCP1(
	cp1: BezierPoint,
	startAnchor: BezierPoint,
): BezierPoint {
	return {
		...cp1,
		x: startAnchor.x + cp1.x,
		y: startAnchor.y + cp1.y,
	};
}

/**
 * 相対cp2を絶対ワールド座標に復元する。
 * cp2は終了アンカー(end)からの相対オフセット。
 */
export function resolveCP2(cp2: BezierPoint, end: BezierPoint): BezierPoint {
	return {
		...cp2,
		x: end.x + cp2.x,
		y: end.y + cp2.y,
	};
}

/**
 * セグメントの全座標を絶対ワールド座標に復元する。
 * ベジエ評価関数に渡す前に使用する。
 */
export function resolveSegment(
	segment: CubicBezierSegment,
	prevEnd?: BezierPoint,
): {
	start: BezierPoint;
	cp1: BezierPoint;
	cp2: BezierPoint;
	end: BezierPoint;
} {
	const start = getStartAnchor(segment, prevEnd);
	return {
		start,
		cp1: resolveCP1(segment.cp1, start),
		cp2: resolveCP2(segment.cp2, segment.end),
		end: segment.end,
	};
}

/**
 * 絶対cp1座標を開始アンカーからの相対オフセットに変換する。
 */
export function toRelativeCP1(
	absoluteCP1: BezierPoint,
	startAnchor: BezierPoint,
): BezierPoint {
	return {
		...absoluteCP1,
		x: absoluteCP1.x - startAnchor.x,
		y: absoluteCP1.y - startAnchor.y,
	};
}

/**
 * 絶対cp2座標を終了アンカー(end)からの相対オフセットに変換する。
 */
export function toRelativeCP2(
	absoluteCP2: BezierPoint,
	endAnchor: BezierPoint,
): BezierPoint {
	return {
		...absoluteCP2,
		x: absoluteCP2.x - endAnchor.x,
		y: absoluteCP2.y - endAnchor.y,
	};
}

/**
 * Split bezier segments into sub-paths at `isMoved` boundaries.
 */
export function splitIntoSubPaths(
	segments: CubicBezierSegment[],
): CubicBezierSegment[][] {
	if (segments.length === 0) return [];

	const subPaths: CubicBezierSegment[][] = [];
	let currentSubPath: CubicBezierSegment[] = [];

	for (const segment of segments) {
		// isMoved is a pen lift (SVG M): the segment opens the next sub-path.
		if (segment.isMoved && currentSubPath.length > 0) {
			subPaths.push(currentSubPath);
			currentSubPath = [];
		}
		currentSubPath.push(segment);
	}

	if (currentSubPath.length > 0) {
		subPaths.push(currentSubPath);
	}

	return subPaths;
}
