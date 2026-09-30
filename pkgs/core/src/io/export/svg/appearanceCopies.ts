import { localAppearances } from "../../../document/appearancePresets";
import {
	type AnyArtObject,
	type CompoundPath,
	type Filter,
	isFilterEnabled,
	type Path,
} from "../../../schema";
import { isSvgNativeFilter } from "./svgFilterPrimitives";

/**
 * The element as one copy per enabled fill/stroke, stacked bottom to top,
 * when one of them carries its own blend mode or sub-filters. The renderer
 * draws such an element one appearance at a time; SVG gets the same stack
 * from copies that each keep the element's geometry filters plus a single
 * appearance, with that appearance's sub-filters lifted to element level and
 * its blend mode on the copy. The owner's opacity, blend, mask and `svg:*`
 * chain stay with the caller, which wraps the copies. Returns null when the
 * element paints all appearances together.
 */
export function splitAppearanceCopies(
	element: AnyArtObject,
): Array<Path | CompoundPath> | null {
	if (element.type !== "path" && element.type !== "compound-path") return null;

	const filters = localAppearances(element.filters);
	const appearances = filters.filter(
		(f) => isFilterEnabled(f) && isPaintAppearance(f),
	);
	if (!appearances.some(drawsOnItsOwn)) return null;

	const shared = filters.filter(
		(f) => !isPaintAppearance(f) && !isSvgNativeFilter(f.processor),
	);
	return appearances.map((appearance) => ({
		...element,
		mask: undefined,
		blendMode: appearance.blendMode,
		filters: [
			...shared,
			{ ...appearance, blendMode: "normal", subFilters: undefined },
			...(appearance.subFilters ?? []),
		],
	}));
}

export function isPaintAppearance(filter: Filter): boolean {
	return filter.processor === "fill" || filter.processor === "stroke";
}

function drawsOnItsOwn(appearance: Filter): boolean {
	// ?? guards documents that predate the blendMode backfill.
	return (
		(appearance.blendMode ?? "normal") !== "normal" ||
		(appearance.subFilters?.some(isFilterEnabled) ?? false)
	);
}
