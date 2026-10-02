import type { PublicUIState } from "@paplico/core";
import type { AnyArtObject } from "@paplico/core/schema";
import { useSyncExternalStore } from "react";
import { snapshot, subscribe } from "valtio";
import { useEventCallback } from "@/utils/hooks";

/**
 * Subscribes to a single element by id, so the caller re-renders only when
 * that element's snapshot changes rather than on every document change.
 */
export function useArtObject(
	store: PublicUIState,
	elementId: string,
): AnyArtObject | undefined {
	const subscribeStore = useEventCallback((onChange: () => void) =>
		subscribe(store, onChange),
	);

	return useSyncExternalStore(
		subscribeStore,
		() =>
			snapshot(store).document.objects[elementId] as AnyArtObject | undefined,
	);
}
