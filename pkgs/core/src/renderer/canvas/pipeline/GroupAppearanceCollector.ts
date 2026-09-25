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
	reverseSubPath,
	toWorldPath,
} from "../../../utils/geometry/segmentOps";
import type { CompoundPathCache } from "../caches/CompoundPathCache";

/**
 * Recursively collect all path segments from a group's children
 * as a single multi-subpath path in world space.
 * All closed subpaths are normalized to CCW winding so that
 * overlapping subpaths add (rather than cancel) under nonzero winding.
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
 * This prevents overlapping shapes from canceling under nonzero winding.
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
