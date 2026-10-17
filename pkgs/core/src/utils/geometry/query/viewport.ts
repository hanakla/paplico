import type { Viewport } from "../../../schema";
import { getVisibleWorldBounds } from "../space/coordinates";

/**
 * 点がビューポート内に表示されているか判定
 */
export function isInViewport(
	worldX: number,
	worldY: number,
	viewport: Viewport,
	canvasWidth: number,
	canvasHeight: number,
	margin = 0, // マージン（ピクセル）
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
 * バウンディングボックスがビューポートと交差しているか
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
