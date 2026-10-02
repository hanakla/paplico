import type { PublicUIState } from "@paplico/core";
import { useSyncExternalStore } from "react";
import { subscribe } from "valtio";
import { useEventCallback } from "@/utils/hooks";

/**
 * Whether the element is selected. The caller re-renders only when this flag
 * flips, not when the selection array is rebuilt or other elements change.
 */
export function useIsElementSelected(
	store: PublicUIState,
	elementId: string,
): boolean {
	const subscribeStore = useEventCallback((onChange: () => void) =>
		subscribe(store, onChange),
	);

	return useSyncExternalStore(subscribeStore, () =>
		store.selectedElementIds.includes(elementId),
	);
}
