import type { AnyArtObject, PathSegment } from "../../schema";
import { bakeCompoundPathSegments } from "../../utils/geometry/generate/compoundBake";
import { toWorldPath } from "../../utils/geometry/space/worldSegments";
import { buildImageQuadSegments, imageLocalBounds } from "./imageGeometry";

/**
 * The outlines a guide draws itself, in its local space, so the guide
 * overlay and hit testing agree on where a guide is: a path's segments, an
 * image's rectangle and a compound path's boolean result. Any other container
 * draws none; the elements inside it draw theirs. A text guide is outlined by
 * its glyphs, which only the text renderer lays out, so it gets none here
 * either.
 *
 * @param resolveElement looks up a compound path's sources.
 */
export function guideLocalOutlines(
	element: AnyArtObject,
	resolveElement: (id: string) => AnyArtObject | undefined,
): PathSegment[][] {
	switch (element.type) {
		case "path":
			return element.segments.length > 0 ? [element.segments] : [];
		case "image":
			return [
				buildImageQuadSegments(imageLocalBounds(element), element.corners),
			];
		case "compound-path": {
			const segments = bakeCompoundPathSegments(
				element,
				resolveElement,
				toWorldPath,
			);
			return segments.length > 0 ? [segments] : [];
		}
		default:
			return [];
	}
}

/**
 * The element that makes `element` a guide: itself when it is marked isGuide,
 * otherwise the nearest container around it that is. Undefined for artwork.
 *
 * @param parentIdOf gives the id of the container an element sits in.
 */
export function findGuideOwner(
	element: AnyArtObject,
	resolveElement: (id: string) => AnyArtObject | undefined,
	parentIdOf: (id: string) => string | undefined,
): AnyArtObject | undefined {
	if (element.isGuide) return element;
	for (let id = parentIdOf(element.id); id; id = parentIdOf(id)) {
		const container = resolveElement(id);
		if (container?.isGuide) return container;
	}
	return undefined;
}

/**
 * Whether the element can be marked as a guide. An image and a 3D reference
 * have no outline of their own to show in place of their paint.
 */
export function canBecomeGuide(element: AnyArtObject): boolean {
	return element.type !== "image" && element.type !== "reference3d";
}
