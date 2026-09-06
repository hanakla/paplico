import { createContext, useContext } from "react";
import type { FilterStackCommands } from "@/core/document/FilterStackCommands";

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
