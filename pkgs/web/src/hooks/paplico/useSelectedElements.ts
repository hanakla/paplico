import { startTransition, useEffect, useRef, useState } from "react";
import { subscribe } from "valtio";
import type { PublicUIState } from "@/core/Paplico";
import type { AnyArtObject } from "@/core/schema";

/**
 * Resolves selectedElementIds → AnyArtObject[] outside of Valtio's
 * proxy-tracking scope.  Components using this hook do NOT track
 * `document.objects` via useSnapshot, so they will not re-render when
 * unrelated objects are added / removed / mutated.
 */
export function useSelectedElements(
	store: PublicUIState,
): readonly AnyArtObject[] {
	const [elements, setElements] = useState<readonly AnyArtObject[]>(() =>
		resolve(store),
	);
	const prevRef = useRef(elements);

	useEffect(() => {
		const unsub = subscribe(store, () => {
			const next = resolve(store);
			if (!shallowEqualById(prevRef.current, next)) {
				prevRef.current = next;
				// Transition keeps consumer re-renders interruptible and off
				// the discrete input event's synchronous flush.
				startTransition(() => setElements(next));
			}
		});
		return unsub;
	}, [store]);

	return elements;
}

function resolve(store: PublicUIState): readonly AnyArtObject[] {
	const { selectedElementIds, document: doc } = store;
	if (selectedElementIds.length === 0) return EMPTY;
	return selectedElementIds
		.map((id) => doc.objects[id])
		.filter((el): el is AnyArtObject => el != null);
}

function shallowEqualById(
	a: readonly AnyArtObject[],
	b: readonly AnyArtObject[],
): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

const EMPTY: readonly AnyArtObject[] = [];
