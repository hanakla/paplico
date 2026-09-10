import { canBeSubFilter } from "../renderer/filters/filterCatalog";
import {
	type BrushSettings,
	type Filter,
	type FilterEntry,
	isAppearancePresetRef,
	type StrokeAppearance,
} from "../schema";

/**
 * Editing operations over one appearance stack. The stack is addressed
 * through `read` / `write` so the same operations serve the selected
 * element's `filters` and a document appearance preset's `filters`.
 * `read` returns null when the stack cannot be edited right now.
 */
export class FilterStackCommands {
	public constructor(
		private readonly read: () => FilterEntry[] | null,
		private readonly write: (filters: FilterEntry[]) => void,
	) {}

	/**
	 * Update the brush settings of the stroke appearance at `filterIndex` of
	 * this stack. Unlike PaplicoCommands.updateSelectedElementsBrushSettings
	 * (which always targets the first stroke), this addresses one specific
	 * stroke appearance.
	 */
	public updateStrokeBrushSettings(
		filterIndex: number,
		brushSettings: BrushSettings | undefined,
	): void {
		const filters = this.read();
		if (!filters) return;

		const filter = filters[filterIndex];
		if (
			!filter ||
			isAppearancePresetRef(filter) ||
			filter.processor !== "stroke"
		)
			return;

		const strokeApp = filter as StrokeAppearance;
		if (
			areBrushSettingsSemanticallyEqual(
				strokeApp.paramData.params.brushSettings,
				brushSettings,
			)
		) {
			return;
		}

		this.updateFilter(filterIndex, {
			params: { brushSettings },
		});
	}

	public addFilter(filter: Filter): void {
		const filters = this.read();
		if (!filters) return;

		const newFilters = [...filters, filter];
		this.write(newFilters);
	}

	public removeFilter(filterIndex: number): void {
		const filters = this.read();
		if (!filters) return;

		// The content appearance is structural (renders the element's own
		// content) and must not be deletable — it can only be toggled hidden.
		const target = filters[filterIndex];
		if (
			target &&
			!isAppearancePresetRef(target) &&
			target.processor === "content"
		)
			return;

		const newFilters = filters.filter((_, i) => i !== filterIndex);
		this.write(newFilters);
	}

	/**
	 * Update a filter at the given index.
	 * - Top-level Appearance properties (`enabled`, `opacity`, `blendMode`,
	 *   `applyToBackdrop`) are merged at the filter root.
	 * - Processor-specific parameters go through `updates.params`, merged into `paramData.params`.
	 */
	public updateFilter(
		filterIndex: number,
		updates: Partial<
			Pick<Filter, "enabled" | "opacity" | "blendMode" | "applyToBackdrop">
		> & {
			/** Processor-specific params, merged into paramData.params. */
			params?: Record<string, unknown>;
		},
	): void {
		const filters = this.read();
		if (!filters) return;

		if (filterIndex < 0 || filterIndex >= filters.length) return;

		const { params, ...topUpdates } = updates;

		const newFilters = filters.map((filter, i) => {
			if (i !== filterIndex) return filter;
			// A preset ref carries no params; only its enabled flag is editable.
			if (isAppearancePresetRef(filter)) {
				return topUpdates.enabled === undefined
					? filter
					: { ...filter, enabled: topUpdates.enabled };
			}
			if (!params) return { ...filter, ...topUpdates };

			const currentParams = filter.paramData.params;
			return {
				...filter,
				...topUpdates,
				paramData: {
					...filter.paramData,
					params: {
						...(typeof currentParams === "object" && currentParams !== null
							? currentParams
							: {}),
						...params,
					},
				},
			};
		});

		this.write(newFilters);
	}

	/** Add a sub-filter to an appearance (fill/stroke) at the given filter index */
	public addSubFilter(filterIndex: number, subFilter: Filter): void {
		const filters = this.read();
		if (!filters) return;
		if (filterIndex < 0 || filterIndex >= filters.length) return;

		const target = filters[filterIndex];
		if (isAppearancePresetRef(target)) return;
		if (target.processor !== "fill" && target.processor !== "stroke") return;
		if (!canBeSubFilter(subFilter.processor)) return;

		const newFilters = filters.map((filter, i) => {
			if (i !== filterIndex || isAppearancePresetRef(filter)) return filter;
			return {
				...filter,
				subFilters: [...(filter.subFilters ?? []), subFilter],
			} as Filter;
		});

		this.write(newFilters);
	}

	/** Remove a sub-filter from an appearance at the given filter/sub-filter indices */
	public removeSubFilter(filterIndex: number, subFilterIndex: number): void {
		const filters = this.read();
		if (!filters) return;
		if (filterIndex < 0 || filterIndex >= filters.length) return;

		const target = filters[filterIndex];
		if (isAppearancePresetRef(target) || !target.subFilters) return;

		const newFilters = filters.map((filter, i) => {
			if (i !== filterIndex || isAppearancePresetRef(filter)) return filter;
			return {
				...filter,
				subFilters: filter.subFilters?.filter((_, si) => si !== subFilterIndex),
			} as Filter;
		});

		this.write(newFilters);
	}

	/** Update top-level fields (e.g. enabled) of a sub-filter within an appearance */
	public updateSubFilter(
		filterIndex: number,
		subFilterIndex: number,
		updates: Partial<{ enabled: boolean }>,
	): void {
		const filters = this.read();
		if (!filters) return;
		if (filterIndex < 0 || filterIndex >= filters.length) return;

		const target = filters[filterIndex];
		if (isAppearancePresetRef(target) || !target.subFilters) return;

		const newFilters = filters.map((filter, i) => {
			if (i !== filterIndex || isAppearancePresetRef(filter)) return filter;
			return {
				...filter,
				subFilters: filter.subFilters?.map((sub, si) =>
					si === subFilterIndex ? { ...sub, ...updates } : sub,
				),
			} as Filter;
		});

		this.write(newFilters);
	}

	/** Update paramData.params of a sub-filter within an appearance */
	public updateSubFilterParams(
		filterIndex: number,
		subFilterIndex: number,
		paramUpdates: Record<string, unknown>,
	): void {
		const filters = this.read();
		if (!filters) return;
		if (filterIndex < 0 || filterIndex >= filters.length) return;

		const target = filters[filterIndex];
		if (isAppearancePresetRef(target) || !target.subFilters) return;

		const newFilters = filters.map((filter, i) => {
			if (i !== filterIndex || isAppearancePresetRef(filter)) return filter;
			return {
				...filter,
				subFilters: filter.subFilters?.map((sub, si) => {
					if (si !== subFilterIndex) return sub;
					const existing = sub as {
						paramData?: { version: string; params: Record<string, unknown> };
					};
					if (!existing.paramData) return sub;
					return {
						...sub,
						paramData: {
							...existing.paramData,
							params: { ...existing.paramData.params, ...paramUpdates },
						},
					};
				}),
			} as Filter;
		});

		this.write(newFilters);
	}

	/** Reorder a filter within the selected element's filters array */
	public reorderFilter(fromIndex: number, toIndex: number): void {
		const filters = this.read();
		if (!filters) return;
		if (fromIndex === toIndex) return;
		if (
			fromIndex < 0 ||
			fromIndex >= filters.length ||
			toIndex < 0 ||
			toIndex >= filters.length
		)
			return;

		const newFilters = [...filters];
		const [moved] = newFilters.splice(fromIndex, 1);
		newFilters.splice(toIndex, 0, moved);

		this.write(newFilters);
	}

	public reorderSubFilter(
		filterIndex: number,
		fromSubIndex: number,
		toSubIndex: number,
	): void {
		const filters = this.read();
		if (!filters) return;
		if (fromSubIndex === toSubIndex) return;
		if (filterIndex < 0 || filterIndex >= filters.length) return;

		const target = filters[filterIndex];
		if (isAppearancePresetRef(target) || !target.subFilters) return;
		if (
			fromSubIndex < 0 ||
			fromSubIndex >= target.subFilters.length ||
			toSubIndex < 0 ||
			toSubIndex >= target.subFilters.length
		)
			return;

		const newSubFilters = [...target.subFilters];
		const [moved] = newSubFilters.splice(fromSubIndex, 1);
		newSubFilters.splice(toSubIndex, 0, moved);

		const newFilters = filters.map((filter, i) => {
			if (i !== filterIndex || isAppearancePresetRef(filter)) return filter;
			return { ...filter, subFilters: newSubFilters } as Filter;
		});

		this.write(newFilters);
	}

	public moveSubFilter(
		fromFilterIndex: number,
		subFilterIndex: number,
		toFilterIndex: number,
	): void {
		const filters = this.read();
		if (!filters) return;
		if (fromFilterIndex === toFilterIndex) return;
		if (
			fromFilterIndex < 0 ||
			fromFilterIndex >= filters.length ||
			toFilterIndex < 0 ||
			toFilterIndex >= filters.length
		)
			return;

		const source = filters[fromFilterIndex];
		const target = filters[toFilterIndex];
		if (isAppearancePresetRef(source) || isAppearancePresetRef(target)) return;
		if (!source.subFilters) return;
		if (
			target.processor !== "fill" &&
			target.processor !== "stroke" &&
			target.processor !== "content"
		)
			return;
		if (subFilterIndex < 0 || subFilterIndex >= source.subFilters.length)
			return;

		const moved = source.subFilters[subFilterIndex];

		const newFilters = filters.map((filter, i) => {
			if (isAppearancePresetRef(filter)) return filter;
			if (i === fromFilterIndex) {
				return {
					...filter,
					subFilters: filter.subFilters?.filter(
						(_, si) => si !== subFilterIndex,
					),
				} as Filter;
			}
			if (i === toFilterIndex) {
				return {
					...filter,
					subFilters: [...(filter.subFilters ?? []), moved],
				} as Filter;
			}
			return filter;
		});

		this.write(newFilters);
	}
}

export function areBrushSettingsSemanticallyEqual(
	left: unknown,
	right: unknown,
): boolean {
	if (left == null || right == null) return left == null && right == null;
	return JSON.stringify(left) === JSON.stringify(right);
}
