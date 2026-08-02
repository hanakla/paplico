import { FILTER_CATALOG } from "@/core/renderer/filters/filterCatalog";
import { type LocalizeKeys, translateAllLocales } from "@/locales";
import { toHalfWidth } from "@/utils/string";
import { FILTER_TEXT_KEYS } from "./constants";

export type FilterCatalogEntry = (typeof FILTER_CATALOG)[number];

/**
 * Narrows the catalog to what the current context can take, and to what the
 * query matches. `matchedEntries` is null while the query is empty, which the
 * callers read as "not searching" rather than "nothing matched".
 */
export function queryFilterCatalog(
	isSubFilter: boolean,
	query: string,
): {
	visibleEntries: FilterCatalogEntry[];
	matchedEntries: FilterCatalogEntry[] | null;
} {
	const visibleEntries = FILTER_CATALOG.filter((e) =>
		isSubFilter ? e.canBeSubFilter : true,
	);
	const normalizedQuery = toHalfWidth(query).trim().toLowerCase();

	return {
		visibleEntries,
		matchedEntries: normalizedQuery
			? visibleEntries.filter((entry) =>
					SEARCH_TEXTS.get(entry.processor)?.includes(normalizedQuery),
				)
			: null,
	};
}

/** Half-width lowercased filter + category names across every locale, so
 *  the query matches regardless of the UI language and character width
 *  (e.g. "blur" or "ｂｌｕｒ" finds ぼかし). */
function buildSearchText(processor: string, category: string): string {
	const nameKey = FILTER_TEXT_KEYS[processor as keyof typeof FILTER_TEXT_KEYS];
	return toHalfWidth(
		[
			...(nameKey ? translateAllLocales(nameKey) : []),
			...translateAllLocales(
				`filterPanel.category.${category}` as LocalizeKeys,
			),
		].join("\n"),
	).toLowerCase();
}

const SEARCH_TEXTS = new Map(
	FILTER_CATALOG.map((e) => [
		e.processor,
		buildSearchText(e.processor, e.category),
	]),
);
