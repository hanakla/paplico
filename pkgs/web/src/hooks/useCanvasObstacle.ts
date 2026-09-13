import { useLayoutEffect, useState } from "react";
import {
	type CanvasObstacleKey,
	clearCanvasObstacleRect,
	setCanvasObstacleRect,
} from "@/stores/uiStore";
import { useEventCallback } from "@/utils/hooks";

/**
 * Publishes the rect of a floating UI that overlaps the canvas, so the context
 * actions bar can keep clear of it. Returns the ref to put on the element whose
 * rect is the obstacle.
 */
export function useCanvasObstacle(
	key: CanvasObstacleKey,
): (el: HTMLElement | null) => void {
	const [el, setEl] = useState<HTMLElement | null>(null);

	const measure = useEventCallback(() => {
		if (!el) return;
		const rect = el.getBoundingClientRect();
		setCanvasObstacleRect(key, {
			left: rect.left,
			top: rect.top,
			right: rect.right,
			bottom: rect.bottom,
		});
	});

	useLayoutEffect(() => {
		if (!el) return;

		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
			clearCanvasObstacleRect(key);
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: measure is stable (useEventCallback)
	}, [el, key]);

	// A move that keeps the size (panels swapping sides, a docked panel opening)
	// emits no resize event, and the element re-renders when it happens.
	useLayoutEffect(() => {
		measure();
	});

	return setEl;
}
