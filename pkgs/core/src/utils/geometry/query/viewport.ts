import type { Viewport } from "../../../schema";
import { getVisibleWorldBounds } from "../space/coordinates";

/**
 * Whether a point is visible in the viewport
 */
export function isInViewport(
	worldX: number,
	worldY: number,
	viewport: Viewport,
	canvasWidth: number,
	canvasHeight: number,
	margin = 0, // Margin in pixels
): boolean {
	const bounds = getVisibleWorldBounds(viewport, canvasWidth, canvasHeight);
	const worldMargin = margin / viewport.zoom;

	return (
		worldX >= bounds.left - worldMargin &&
		worldX <= bounds.right + worldMargin &&
		worldY >= bounds.bottom - worldMargin &&
		worldY <= bounds.top + worldMargin
	);
}

/**
 * Whether a bounding box intersects the viewport
 */
export function boundsIntersectViewport(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
	viewport: Viewport,
	canvasWidth: number,
	canvasHeight: number,
): boolean {
	const bounds = getVisibleWorldBounds(viewport, canvasWidth, canvasHeight);

	return !(
		maxX < bounds.left ||
		minX > bounds.right ||
		maxY < bounds.bottom ||
		minY > bounds.top
	);
}
