import type { CompoundPathCache } from "../../../document/elementGeometry/CompoundPathCache";
import {
	type AnyArtObject,
	type CompoundPath as CompoundPathType,
	type CubicBezierSegment,
	type ElementTransform,
	type Group,
	isCompoundPath,
	isGroup,
	isIdentityTransform,
	isPath,
	type Path,
} from "../../../schema";
import { computeSubPathSignedArea } from "../../../utils/geometry/measure/area";
import { reverseSubPath } from "../../../utils/geometry/reshape/segment";
import { placeElement } from "../../../utils/geometry/space/coordinates";
import { toWorldPath } from "../../../utils/geometry/space/worldSegments";

/**
 * Recursively collect all path segments from a group's children
 * as a single multi-subpath path in world space.
 * Each child is turned so its outer contour winds CCW, so that overlapping
 * children add (rather than cancel) under nonzero winding.
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
	/** The chain the nested groups between the outer group and `group`'s
	 *  children place them under (see childrenMatrixOf). */
	matrix?: ElementTransform,
): void {
	for (const childId of group.childIds) {
		if (childId === group.clipPathId) continue;

		const child = elementsMap.get(childId);
		if (!child) continue;

		if (isPath(child)) {
			const worldPath = toWorldPath(child, matrix);
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
				pathMap.set(source.id, toWorldPath(el, matrix));
			}

			const segments = compoundPathCache.resolve(compoundPath, pathMap);
			if (segments.length === 0) continue;

			appendNormalized(segments, result);
		} else if (isGroup(child)) {
			const childrenMatrix = placeElement(matrix ?? null, child);
			collectRecursive(
				child,
				elementsMap,
				compoundPathCache,
				result,
				isIdentityTransform(childrenMatrix) ? undefined : childrenMatrix,
			);
		}
		// ImageObject, TextElement — skip
	}
}

/**
 * Append one child's segments to result, turned so its largest closed subpath
 * winds CCW. Every closed subpath of the child is reversed together, which
 * keeps the child's holes as holes while overlapping children add instead of
 * cancelling under nonzero winding.
 */
function appendNormalized(
	segments: CubicBezierSegment[],
	result: CubicBezierSegment[],
): void {
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

	const isClosed = (sub: CubicBezierSegment[]) =>
		sub.at(-1)?.isClosed === true && sub.length >= 2;
	let outerArea = 0;
	for (const sub of subPaths) {
		if (!isClosed(sub)) continue;
		const area = computeSubPathSignedArea(sub);
		if (Math.abs(area) > Math.abs(outerArea)) outerArea = area;
	}

	for (const sub of subPaths) {
		const oriented = outerArea < 0 && isClosed(sub) ? reverseSubPath(sub) : sub;
		result.push({ ...oriented[0], isMoved: true });
		for (let i = 1; i < oriented.length; i++) result.push(oriented[i]);
	}
}
