import { createIdentityTransform } from "../../../document/factory";
import {
	type BezierPoint,
	type CubicBezierSegment,
	type ElementTransform,
	getTransform,
	isIdentityTransform,
	type Path,
	type PathSegment,
} from "../../../schema";
import {
	resolveSegment,
	toRelativeCP1,
	toRelativeCP2,
} from "../primitives/segment";
import {
	applyTransformToPoint,
	composeTransforms,
	toWorld,
	type WorldBezierSegment,
} from "./coordinates";

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

/** Placeholder origin for identity transforms (origin is unused in that path). */

/**
 * Convert element segments to world-space coordinates.
 * Segment-level equivalent of calculateElementBounds().
 * Skips SRT computation when transform is identity.
 *
 * `geometry` stands in for the element's segments when the drawn outline is
 * a deformed one.
 */
export function getWorldSegments(
	element: Path,
	ancestorTransform?: ElementTransform,
	geometry: readonly PathSegment[] = element.segments,
): WorldBezierSegment[] {
	const elementT = getTransform(element);
	const t = ancestorTransform
		? composeTransforms(ancestorTransform, elementT)
		: elementT;
	return transformSegmentsToWorld(geometry, t);
}

/**
 * Resolve relative segments and project them to world space through
 * `transform`.
 */
export function transformSegmentsToWorld(
	segments: readonly PathSegment[],
	transform: ElementTransform,
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
			const w = applyTransformToPoint(p.x, p.y, transform);
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
 * Convert a path to world-space geometry while preserving segment metadata.
 * Returned path always has identity transform.
 */
export function toWorldPath(
	path: Path,
	ancestorTransform?: ElementTransform,
	geometry: readonly PathSegment[] = path.segments,
): Path {
	const worldSegments = getWorldSegments(path, ancestorTransform, geometry);
	const segments = reconstructSegmentsFromWorld(worldSegments, geometry);

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
