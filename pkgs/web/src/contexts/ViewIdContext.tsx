"use client";

import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import { createDefaultViewport } from "@/core/document/factory";
import type { Viewport } from "@/core/schema";
import { useCurrentCanvasTargetResolver } from "@/hooks/useCurrentCanvasTarget";
import { usePaplico } from "./PaplicoContext";

const ViewIdContext = createContext<string | null>(null);
const fallbackViewport = createDefaultViewport();
const fallbackSize = { width: 0, height: 0 };

export function ViewIdProvider({
	viewId,
	children,
}: {
	viewId: string | null;
	children: React.ReactNode;
}) {
	return (
		<ViewIdContext.Provider value={viewId}>{children}</ViewIdContext.Provider>
	);
}

/**
 * Get the viewport for the current view target.
 * Falls back to the primary target's viewport if no ViewIdContext is provided.
 */
export function useTargetViewport(): Viewport {
	const paplico = usePaplico();
	const viewId = useContext(ViewIdContext);
	const { getCurrentCanvasTarget } = useCurrentCanvasTargetResolver();
	const target = viewId
		? paplico.getCanvasTarget(viewId)
		: getCurrentCanvasTarget(paplico);

	return useSyncExternalStore(
		(onChange) => {
			if (!target) return () => {};
			return target.on("viewportChanged", () => onChange());
		},
		() => target?.getViewport() ?? fallbackViewport,
		() => fallbackViewport,
	);
}

/**
 * Size of the current view target's drawing surface, kept in step with it.
 *
 * Screen coordinates are measured outward from the canvas centre, so an
 * overlay working from a size captured once is wrong by half of every resize
 * that followed — and the error grows with zoom, because the distance from
 * that centre is what zoom scales.
 */
export function useTargetSize(): { width: number; height: number } {
	const paplico = usePaplico();
	const viewId = useContext(ViewIdContext);
	const { getCurrentCanvasTarget } = useCurrentCanvasTargetResolver();
	const target = viewId
		? paplico.getCanvasTarget(viewId)
		: getCurrentCanvasTarget(paplico);

	// Cached because useSyncExternalStore compares snapshots by identity, and a
	// fresh object every read would loop forever.
	const sizeRef = useRef(fallbackSize);

	return useSyncExternalStore(
		(onChange) => {
			if (!target) return () => {};
			return target.on("sizeChanged", () => onChange());
		},
		() => {
			if (!target) return fallbackSize;

			const { width, height } = sizeRef.current;
			if (width === target.width && height === target.height) {
				return sizeRef.current;
			}

			sizeRef.current = { width: target.width, height: target.height };
			return sizeRef.current;
		},
		() => fallbackSize,
	);
}
