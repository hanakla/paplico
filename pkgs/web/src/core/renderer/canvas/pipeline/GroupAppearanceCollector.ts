import {
	type AnyArtObject,
	type CompoundPath as CompoundPathType,
	type CubicBezierSegment,
	type ElementTransform,
	type Group,
	getTransform,
	isCompoundPath,
	isGroup,
	isIdentityTransform,
	isPath,
	type Path,
} from "../../../schema";
import { composeTransforms } from "../../../utils/geometry/geometry";
import {
	computeSubPathSignedArea,
	resolveSegment,
	toWorldPath,
} from "../../../utils/geometry/segmentOps";
import type { CompoundPathCache } from "../caches/CompoundPathCache";

/**
 * Recursively collect all path segments from a group's children
 * as a single multi-subpath path in world space.
 * All closed subpaths are normalized to CCW winding so that
 * overlapping subpaths add (rather than cancel) in the stencil buffer.
 * CompoundPaths are resolved via cache. ImageObject/TextElement are skipped.
 */
export function collectGroupSegments(
	group: Group,
	elementsMap: Map<string, AnyArtObject>,
	compoundPathCache: CompoundPathCache,
): CubicBezierSegment[] {
	const result: CubicBezierSegment[] = [];
	collectRecursive(group, elementsMap, compoundPathCache, result);
	return result;
}

function collectRecursive(
	group: Group,
	elementsMap: Map<string, AnyArtObject>,
	compoundPathCache: CompoundPathCache,
	result: CubicBezierSegment[],
	ancestorTransform?: ElementTransform,
): void {
	for (const childId of group.childIds) {
		if (childId === group.clipPathId) continue;

		const child = elementsMap.get(childId);
		if (!child) continue;

		if (isPath(child)) {
			const worldPath = toWorldPath(child, ancestorTransform);
			const segments = worldPath.segments;
			if (segments.length === 0) continue;

			appendNormalized(segments, result);
		} else if (isCompoundPath(child)) {
			const compoundPath = child as CompoundPathType;
			if (compoundPath.sources.length === 0) continue;

			const pathMap = new Map<string, Path>();
			for (const source of compoundPath.sources) {
				const el = elementsMap.get(source.id);
				if (!el || !isPath(el)) continue;
				pathMap.set(source.id, toWorldPath(el, ancestorTransform));
			}

			const segments = compoundPathCache.resolve(compoundPath, pathMap);
			if (segments.length === 0) continue;

			appendNormalized(segments, result);
		} else if (isGroup(child)) {
			const childTransform = getTransform(child);
			const composedTransform = ancestorTransform
				? composeTransforms(ancestorTransform, childTransform)
				: childTransform;
			const effectiveTransform = isIdentityTransform(composedTransform)
				? undefined
				: composedTransform;
			collectRecursive(
				child,
				elementsMap,
				compoundPathCache,
				result,
				effectiveTransform,
			);
		}
		// ImageObject, TextElement — skip
	}
}

/**
 * Append segments to result, normalizing closed subpaths to CCW winding.
 * Splits input into subpaths (by isMoved), checks winding of each closed
 * subpath, and reverses CW subpaths so all subpaths use CCW winding.
 * This prevents overlapping shapes from canceling in the stencil buffer.
 */
function appendNormalized(
	segments: CubicBezierSegment[],
	result: CubicBezierSegment[],
): void {
	// Split into subpaths
	const subPaths: CubicBezierSegment[][] = [];
	let current: CubicBezierSegment[] = [];

	for (const seg of segments) {
		if (seg.isMoved && current.length > 0) {
			subPaths.push(current);
			current = [];
		}
		current.push(seg);
	}
	if (current.length > 0) subPaths.push(current);

	for (const sub of subPaths) {
		const isClosed = sub.at(-1)?.isClosed === true;

		if (isClosed && sub.length >= 2) {
			const area = computeSubPathSignedArea(sub);
			if (area < 0) {
				// CW winding → reverse to CCW
				const reversed = reverseSubPath(sub);
				result.push({ ...reversed[0], isMoved: true });
				for (let i = 1; i < reversed.length; i++) {
					result.push(reversed[i]);
				}
				continue;
			}
		}

		result.push({ ...sub[0], isMoved: true });
		for (let i = 1; i < sub.length; i++) {
			result.push(sub[i]);
		}
	}
}

/**
 * Reverse a subpath's winding direction by reversing segment order
 * and swapping start/end + cp1/cp2 within each segment.
 */
function reverseSubPath(segments: CubicBezierSegment[]): CubicBezierSegment[] {
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
