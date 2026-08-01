import { useEffect, useState } from "react";
import { subscribe } from "valtio";
import type { PublicUIState } from "@/core/Paplico";
import type { AnyArtObject } from "@/core/schema";

/**
 * Returns the first selected element (or null) without tracking
 * `document.objects` via Valtio's proxy.
 */
export function useFirstSelectedElement(
	store: PublicUIState,
): AnyArtObject | null {
	const [element, setElement] = useState<AnyArtObject | null>(() =>
		resolve(store),
	);

	useEffect(() => {
		const unsub = subscribe(store, () => {
			const next = resolve(store);
			setElement((prev) => (prev === next ? prev : next));
		});
		return unsub;
	}, [store]);

	return element;
}

function resolve(store: PublicUIState): AnyArtObject | null {
	const id = store.selectedElementIds[0];
	if (!id || !store.currentLayerId) return null;
	return store.document.objects[id] ?? null;
}
