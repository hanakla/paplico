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
