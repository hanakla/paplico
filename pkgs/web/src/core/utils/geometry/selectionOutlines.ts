import {
	type AnyArtObject,
	type ElementTransform,
	isBlend,
	isGroup,
	isMesh,
	isPath,
	isRepeat,
} from "../../schema";
import { blendKeyOutlines } from "./blendInterpolation";
import type { WorldBezierSegment } from "./geometry";
import { getMeshWorldBoundarySegments } from "./segmentOps";

/**
 * World-space outline polylines shown for a selected element, grouped per
 * path: paths use their own outline, meshes their boundary, clip groups their
 * clip path's outline, plain groups their children's outlines (recursing, so
 * a nested clip group contributes its clip path), and blends their key
 * objects' outlines.
 *
 * Every builder of selection UI data (initial selection, rotation preview,
 * document-change refresh) must go through this so the outline never depends
 * on which code path refreshed the overlay.
 */
/**
 * The selection bounding box renders dashed when every selected element is a
 * mesh warp container, marking that its content is a warped proxy rather than
 * directly editable geometry. Shared by every SelectionUIData builder.
 */
export function shouldDashSelectionBounds(
	elements: ReadonlyArray<AnyArtObject | undefined>,
): boolean {
	const present = elements.filter((el): el is AnyArtObject => el != null);
	return present.length > 0 && present.every(isMesh);
}

export function collectSelectionOutlines(
	element: AnyArtObject,
	getElement: (id: string) => AnyArtObject | undefined,
	getAncestorTransform: (id: string) => ElementTransform | null,
	getElementWorldSegments: (id: string) => WorldBezierSegment[] | null,
): WorldBezierSegment[][] {
	if (isPath(element)) {
		if (element.segments.length === 0) return [];
		const segs = getElementWorldSegments(element.id);
		return segs ? [segs] : [];
	}

	if (isMesh(element)) {
		const segs = getMeshWorldBoundarySegments(
			element,
			getAncestorTransform(element.id) ?? undefined,
		);
		return segs.length > 0 ? [segs] : [];
	}

	if (isBlend(element)) {
		return blendKeyOutlines(element, getElement, getAncestorTransform);
	}

	if (isGroup(element)) {
		if (element.clipPathId) {
			const clipPath = getElement(element.clipPathId);
			if (!clipPath || !isPath(clipPath) || clipPath.segments.length === 0) {
				return [];
			}
			const segs = getElementWorldSegments(clipPath.id);
			return segs ? [segs] : [];
		}

		const outlines: WorldBezierSegment[][] = [];
		for (const childId of element.childIds) {
			const child = getElement(childId);
			if (!child) continue;
			outlines.push(
				...collectSelectionOutlines(
					child,
					getElement,
					getAncestorTransform,
					getElementWorldSegments,
				),
			);
		}
		return outlines;
	}

	// Repeat has no dedicated outline in v1: fall back to the plain container
	// behavior and show its source elements' own outlines (the base tile), not
	// each generated instance.
	if (isRepeat(element)) {
		const outlines: WorldBezierSegment[][] = [];
		for (const sourceId of element.sourceIds) {
			const source = getElement(sourceId);
			if (!source) continue;
			outlines.push(
				...collectSelectionOutlines(
					source,
					getElement,
					getAncestorTransform,
					getElementWorldSegments,
				),
			);
		}
		return outlines;
	}

	return [];
}
