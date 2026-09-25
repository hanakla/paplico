import type { FilterStackCommands } from "@paplico/core/document";
import { createContext, useContext } from "react";

/**
 * The stack the panel's rows and controls edit: the selected element's
 * filters, or a preset's filters while one is being edited in place.
 */
const FilterStackContext = createContext<FilterStackCommands | null>(null);

export const FilterStackProvider = FilterStackContext.Provider;

export function useFilterStack(): FilterStackCommands {
	const stack = useContext(FilterStackContext);
	if (!stack) {
		throw new Error("useFilterStack must be used inside FilterPanel");
	}
	return stack;
}
