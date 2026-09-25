import type { CubicBezierSegment, Filter } from "../../../schema";
import { appendSubpath } from "../../../utils/geometry/segmentOps";
import type { FilterRenderer } from "../pipeline/FilterRenderer";
import { resolveElementGeometry } from "../pipeline/PreFilterRenderer";

/**
 * Concatenate a text's per-glyph outlines into one multi-subpath list and run
 * the element's geometry pre-filters over that whole list, once.
 *
 * The unit is the point of this function. Applied per glyph, path-union merges
 * each glyph's own counters but leaves overlapping neighbours as separate
 * contours — a script face then still extrudes an interior wall at every glyph
 * seam, which is the opposite of what the filter was added for. Every consumer
 * (flat render, 3D solid outline) resolves text geometry through here so they
 * cannot disagree on that unit.
 */
export function buildTextGeometry(
	glyphOutlines: readonly CubicBezierSegment[][],
	filters: Filter[] | undefined,
	filterRenderer: Pick<FilterRenderer, "getHandler">,
): CubicBezierSegment[] {
	const concatenated: CubicBezierSegment[] = [];
	for (const outline of glyphOutlines) appendSubpath(concatenated, outline);
	return resolveElementGeometry(concatenated, filters, filterRenderer);
}
