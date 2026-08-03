import { createIdentityTransform } from "../../document/factory";
import {
	type BezierPoint,
	type CubicBezierSegment,
	type ElementTransform,
	getTransform,
	isIdentityTransform,
	type MeshArtObject,
	type Path,
	type PathSegment,
} from "../../schema";
import {
	brandLocalBBox,
	calculateMeshCoordinateBounds,
	calculatePathBounds,
} from "./bounds";
import {
	applyTransformToPoint,
	composeTransforms,
	computeTransformOrigin,
	toWorld,
	type WorldBezierSegment,
} from "./geometry";
import { getRootBoundaryCurves } from "./meshGradient";
import { splitBezierAtT } from "./pathOps";

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
 * Translate path segments in local coordinates.
 * start/end are anchors and must be translated.
 * cp1/cp2 are relative offsets from anchors and must be preserved.
 */
export function translateSegments(
	segments: CubicBezierSegment[],
	deltaX: number,
	deltaY: number,
): CubicBezierSegment[] {
	return segments.map((segment) => ({
		...segment,
		start: segment.start
			? {
					...segment.start,
					x: segment.start.x + deltaX,
					y: segment.start.y + deltaY,
				}
			: undefined,
		cp1: { ...segment.cp1 },
		cp2: { ...segment.cp2 },
		end: {
			...segment.end,
			x: segment.end.x + deltaX,
			y: segment.end.y + deltaY,
		},
	}));
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

/** Placeholder origin for identity transforms (origin is unused in that path). */
const ORIGIN_ZERO = { x: 0, y: 0 } as const;

/**
 * Convert element segments to world-space coordinates.
 * Segment-level equivalent of calculateElementBounds().
 * Skips SRT computation when transform is identity.
 */
export function getWorldSegments(
	element: Path,
	ancestorTransform?: ElementTransform,
): WorldBezierSegment[] {
	const elementT = getTransform(element);
	const t = ancestorTransform
		? composeTransforms(ancestorTransform, elementT)
		: elementT;
	const origin = isIdentityTransform(t)
		? ORIGIN_ZERO
		: computeTransformOrigin(calculatePathBounds(element));
	return transformSegmentsToWorld(element.segments, t, origin);
}

/**
 * Resolve relative segments and project them to world space by applying
 * `transform` around `origin`. Shared by getWorldSegments (origin = the path's
 * own bbox center) and blend key-outline building, where world-baked sources are
 * transformed around the blend's bbox center to match renderBlend — not each
 * source's own center.
 */
export function transformSegmentsToWorld(
	segments: readonly PathSegment[],
	transform: ElementTransform,
	origin: { x: number; y: number },
): WorldBezierSegment[] {
	if (isIdentityTransform(transform)) {
		return segments.map((seg, i) => {
			const resolved = resolveSegment(
				seg,
				i > 0 ? segments[i - 1].end : undefined,
			);
			return {
				start: resolved.start
					? toWorld(resolved.start.x, resolved.start.y)
					: undefined,
				cp1: toWorld(resolved.cp1.x, resolved.cp1.y),
				cp2: toWorld(resolved.cp2.x, resolved.cp2.y),
				end: toWorld(resolved.end.x, resolved.end.y),
			};
		});
	}

	return segments.map((seg, i) => {
		const resolved = resolveSegment(
			seg,
			i > 0 ? segments[i - 1].end : undefined,
		);
		const tp = (p: { x: number; y: number }) => {
			const w = applyTransformToPoint(p.x, p.y, transform, origin.x, origin.y);
			return toWorld(w.x, w.y);
		};
		return {
			start: resolved.start ? tp(resolved.start) : undefined,
			cp1: tp(resolved.cp1),
			cp2: tp(resolved.cp2),
			end: tp(resolved.end),
		};
	});
}

/**
 * Convert a MeshArtObject's outer boundary into world-space cubic Bézier
 * segments — the mesh analogue of `getWorldSegments` for Path. Each boundary
 * edge emits one cubic with endpoints + per-side handles resolved via
 * `getEdgeCurve`, then transformed through the element's SRT (composed with
 * `ancestorTransform` when given).
 *
 * Returns an empty array when the boundary is degenerate (no faces / broken
 * topology), so callers can treat the result uniformly with Path outlines.
 */
export function getMeshWorldBoundarySegments(
	mesh: MeshArtObject,
	ancestorTransform?: ElementTransform,
): WorldBezierSegment[] {
	const curves = getRootBoundaryCurves(mesh.vertices, mesh.faces);
	if (!curves || curves.length < 1) return [];

	const elementT = getTransform(mesh);
	const t = ancestorTransform
		? composeTransforms(ancestorTransform, elementT)
		: elementT;
	const identity = isIdentityTransform(t);
	const localBounds = brandLocalBBox(
		calculateMeshCoordinateBounds(mesh.vertices),
	);
	const origin = computeTransformOrigin(localBounds);

	const tp = (p: { x: number; y: number }) => {
		if (identity) return toWorld(p.x, p.y);
		const w = applyTransformToPoint(p.x, p.y, t, origin.x, origin.y);
		return toWorld(w.x, w.y);
	};

	return curves.map((curve) => ({
		start: tp(curve[0]),
		cp1: tp(curve[1]),
		cp2: tp(curve[2]),
		end: tp(curve[3]),
	}));
}

/**
 * Convert a path to world-space geometry while preserving segment metadata.
 * Returned path always has identity transform.
 */
export function toWorldPath(
	path: Path,
	ancestorTransform?: ElementTransform,
): Path {
	const worldSegments = getWorldSegments(path, ancestorTransform);
	const segments = reconstructSegmentsFromWorld(worldSegments, path.segments);

	return {
		...path,
		segments,
		transform: createIdentityTransform(),
	};
}

/**
 * Rebuild PathSegment metadata (isMoved, isClosed, cornerRadius, pressure,
 * tilt, deltaTime) onto world-transformed points, using `originalSegments`
 * (index-aligned) as the metadata source. `transformSegmentsToWorld` only
 * returns bare geometry (start/cp1/cp2/end world points) — this is the
 * companion step `toWorldPath` uses internally, exposed for callers that
 * transform segments around a shared/external origin instead of the path's
 * own bbox center (e.g. a blend's own bbox center for all its keys/
 * intermediates, matching `blendKeyOutlines`).
 */
export function reconstructSegmentsFromWorld(
	worldSegments: readonly WorldBezierSegment[],
	originalSegments: readonly PathSegment[],
): PathSegment[] {
	return worldSegments.map((worldSegment, index) => {
		const originalSegment = originalSegments[index];
		const end = fromWorldPoint(worldSegment.end);
		const startAnchor =
			originalSegment?.start !== undefined
				? fromWorldPoint(worldSegment.start ?? worldSegment.end)
				: undefined;
		const resolvedStart =
			startAnchor ??
			(index > 0 ? fromWorldPoint(worldSegments[index - 1].end) : end);

		return {
			start: startAnchor,
			cp1: toRelativeCP1(fromWorldPoint(worldSegment.cp1), resolvedStart),
			cp2: toRelativeCP2(fromWorldPoint(worldSegment.cp2), end),
			end,
			startPressure: originalSegment?.startPressure,
			endPressure: originalSegment?.endPressure,
			startTiltX: originalSegment?.startTiltX ?? 0,
			startTiltY: originalSegment?.startTiltY ?? 0,
			endTiltX: originalSegment?.endTiltX ?? 0,
			endTiltY: originalSegment?.endTiltY ?? 0,
			startDeltaTime: originalSegment?.startDeltaTime ?? 0,
			endDeltaTime: originalSegment?.endDeltaTime ?? 0,
			isMoved: originalSegment?.isMoved ?? index === 0,
			isClosed: originalSegment?.isClosed,
			cornerRadius: (originalSegment as PathSegment)?.cornerRadius,
			cornerSuperellipseN: (originalSegment as PathSegment)
				?.cornerSuperellipseN,
		};
	});
}

function fromWorldPoint(point: { x: number; y: number }): BezierPoint {
	return { x: point.x, y: point.y };
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

// -- Hashing ----------------------------------------------------------------

const _hashF32 = new Float32Array(1);
const _hashU32 = new Uint32Array(_hashF32.buffer);
export function floatBits(v: number): number {
	_hashF32[0] = v;
	return _hashU32[0];
}

/**
 * Fast hash of segment control-point coordinates.
 * Used for cache validation (geometry change detection).
 */
/**
 * Compute the signed area of a closed subpath using the shoelace formula
 * on resolved endpoints. Positive = CCW, negative = CW (in Y-up space).
 */
export function computeSubPathSignedArea(
	segments: CubicBezierSegment[],
): number {
	let area = 0;
	for (let i = 0; i < segments.length; i++) {
		const prevEnd = i > 0 ? segments[i - 1].end : undefined;
		const resolved = resolveSegment(segments[i], prevEnd);
		area +=
			resolved.start.x * resolved.end.y - resolved.end.x * resolved.start.y;
	}
	return area * 0.5;
}

export function hashSegments(segments: CubicBezierSegment[]): number {
	let h = segments.length | 0;
	for (let i = 0; i < segments.length; i++) {
		const s = segments[i];
		h = (h * 31 + floatBits(s.start?.x ?? 0)) | 0;
		h = (h * 31 + floatBits(s.start?.y ?? 0)) | 0;
		h = (h * 31 + floatBits(s.cp1.x)) | 0;
		h = (h * 31 + floatBits(s.cp1.y)) | 0;
		h = (h * 31 + floatBits(s.cp2.x)) | 0;
		h = (h * 31 + floatBits(s.cp2.y)) | 0;
		h = (h * 31 + floatBits(s.end.x)) | 0;
		h = (h * 31 + floatBits(s.end.y)) | 0;
	}
	return h;
}

export function hashSegmentsWithMetadata(
	segments: CubicBezierSegment[],
): number {
	let h = hashSegments(segments);
	for (let i = 0; i < segments.length; i++) {
		const s = segments[i];
		h = (h * 31 + floatBits(s.startPressure ?? 0)) | 0;
		h = (h * 31 + floatBits(s.endPressure ?? 0)) | 0;
		h = (h * 31 + floatBits(s.startTiltX ?? 0)) | 0;
		h = (h * 31 + floatBits(s.startTiltY ?? 0)) | 0;
		h = (h * 31 + floatBits(s.endTiltX ?? 0)) | 0;
		h = (h * 31 + floatBits(s.endTiltY ?? 0)) | 0;
		h = (h * 31 + floatBits(s.startDeltaTime ?? 0)) | 0;
		h = (h * 31 + floatBits(s.endDeltaTime ?? 0)) | 0;
		h = (h * 31 + (s.isMoved ? 1 : 0)) | 0;
		h = (h * 31 + (s.isClosed ? 1 : 0)) | 0;
	}
	return h;
}
