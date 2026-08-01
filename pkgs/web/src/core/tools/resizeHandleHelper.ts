/**
 * Shared resize handle utilities for ArtboardTool and SelectTool.
 *
 * Both tools use the same 8-direction resize handle logic:
 * - Handle positions (nw/n/ne/e/se/s/sw/w)
 * - Hit testing against those handles
 * - Resized bounds calculation with optional aspect-ratio constraint
 * - Cursor mapping per handle direction
 */

import type { BoundingBox, Viewport } from "../schema";

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export interface HandlePosition {
	x: number;
	y: number;
	position: ResizeHandle;
}

export function createResizeHandles(bounds: BoundingBox): HandlePosition[] {
	const { minX, maxX, minY, maxY } = bounds;
	const midX = (minX + maxX) / 2;
	const midY = (minY + maxY) / 2;

	return [
		{ x: minX, y: maxY, position: "nw" },
		{ x: midX, y: maxY, position: "n" },
		{ x: maxX, y: maxY, position: "ne" },
		{ x: maxX, y: midY, position: "e" },
		{ x: maxX, y: minY, position: "se" },
		{ x: midX, y: minY, position: "s" },
		{ x: minX, y: minY, position: "sw" },
		{ x: minX, y: midY, position: "w" },
	];
}

/**
 * Hit-test a world-space point against resize handles of a bounding box.
 * Returns the handle position if hit, null otherwise.
 *
 * @param worldX   Point X in world coordinates
 * @param worldY   Point Y in world coordinates
 * @param bounds   Bounding box whose handles to test
 * @param viewport Current viewport (used to scale handle hit area)
 * @param handleScreenPx  Handle size in screen pixels (default 12)
 */
export function hitTestResizeHandle(
	worldX: number,
	worldY: number,
	bounds: BoundingBox,
	viewport: Viewport,
	handleScreenPx = 12,
): ResizeHandle | null {
	const halfHandle = handleScreenPx / viewport.zoom / 2;
	const handles = createResizeHandles(bounds);

	for (const handle of handles) {
		if (
			worldX >= handle.x - halfHandle &&
			worldX <= handle.x + halfHandle &&
			worldY >= handle.y - halfHandle &&
			worldY <= handle.y + halfHandle
		) {
			return handle.position;
		}
	}

	return null;
}

/**
 * Calculate resized bounds when dragging a resize handle.
 *
 * @param original        Original bounding box before drag started
 * @param handle          Which handle is being dragged
 * @param worldX          Current pointer X in world coordinates
 * @param worldY          Current pointer Y in world coordinates
 * @param dragStartX      World X where the drag began
 * @param dragStartY      World Y where the drag began
 * @param constrainAspect If true, maintain the original aspect ratio
 * @param anchorCenter    If true, resize from the center of the bounding box
 * @param minSize         Minimum width/height (default 10)
 */
export function calculateResizedBounds(
	original: BoundingBox,
	handle: ResizeHandle,
	worldX: number,
	worldY: number,
	dragStartX: number,
	dragStartY: number,
	constrainAspect = false,
	anchorCenter = false,
	minSize = 10,
): BoundingBox {
	let { minX, minY, maxX, maxY } = original;
	const originalAspect = original.width / original.height;

	const deltaX = worldX - dragStartX;
	const deltaY = worldY - dragStartY;
	const isPrimaryHorizontal = Math.abs(deltaX) > Math.abs(deltaY);

	switch (handle) {
		case "nw":
			if (constrainAspect) {
				if (isPrimaryHorizontal) {
					minX = Math.min(worldX, maxX - minSize);
					const newWidth = maxX - minX;
					const newHeight = newWidth / originalAspect;
					maxY = minY + newHeight;
				} else {
					maxY = Math.max(worldY, minY + minSize);
					const newHeight = maxY - minY;
					const newWidth = newHeight * originalAspect;
					minX = maxX - newWidth;
				}
			} else {
				minX = Math.min(worldX, maxX - minSize);
				maxY = Math.max(worldY, minY + minSize);
			}
			break;
		case "n":
			maxY = Math.max(worldY, minY + minSize);
			if (constrainAspect) {
				const newHeight = maxY - minY;
				const newWidth = newHeight * originalAspect;
				const centerX = (minX + maxX) / 2;
				minX = centerX - newWidth / 2;
				maxX = centerX + newWidth / 2;
			}
			break;
		case "ne":
			if (constrainAspect) {
				if (isPrimaryHorizontal) {
					maxX = Math.max(worldX, minX + minSize);
					const newWidth = maxX - minX;
					const newHeight = newWidth / originalAspect;
					maxY = minY + newHeight;
				} else {
					maxY = Math.max(worldY, minY + minSize);
					const newHeight = maxY - minY;
					const newWidth = newHeight * originalAspect;
					maxX = minX + newWidth;
				}
			} else {
				maxX = Math.max(worldX, minX + minSize);
				maxY = Math.max(worldY, minY + minSize);
			}
			break;
		case "e":
			maxX = Math.max(worldX, minX + minSize);
			if (constrainAspect) {
				const newWidth = maxX - minX;
				const newHeight = newWidth / originalAspect;
				const centerY = (minY + maxY) / 2;
				minY = centerY - newHeight / 2;
				maxY = centerY + newHeight / 2;
			}
			break;
		case "se":
			if (constrainAspect) {
				if (isPrimaryHorizontal) {
					maxX = Math.max(worldX, minX + minSize);
					const newWidth = maxX - minX;
					const newHeight = newWidth / originalAspect;
					minY = maxY - newHeight;
				} else {
					minY = Math.min(worldY, maxY - minSize);
					const newHeight = maxY - minY;
					const newWidth = newHeight * originalAspect;
					maxX = minX + newWidth;
				}
			} else {
				maxX = Math.max(worldX, minX + minSize);
				minY = Math.min(worldY, maxY - minSize);
			}
			break;
		case "s":
			minY = Math.min(worldY, maxY - minSize);
			if (constrainAspect) {
				const newHeight = maxY - minY;
				const newWidth = newHeight * originalAspect;
				const centerX = (minX + maxX) / 2;
				minX = centerX - newWidth / 2;
				maxX = centerX + newWidth / 2;
			}
			break;
		case "sw":
			if (constrainAspect) {
				if (isPrimaryHorizontal) {
					minX = Math.min(worldX, maxX - minSize);
					const newWidth = maxX - minX;
					const newHeight = newWidth / originalAspect;
					minY = maxY - newHeight;
				} else {
					minY = Math.min(worldY, maxY - minSize);
					const newHeight = maxY - minY;
					const newWidth = newHeight * originalAspect;
					minX = maxX - newWidth;
				}
			} else {
				minX = Math.min(worldX, maxX - minSize);
				minY = Math.min(worldY, maxY - minSize);
			}
			break;
		case "w":
			minX = Math.min(worldX, maxX - minSize);
			if (constrainAspect) {
				const newWidth = maxX - minX;
				const newHeight = newWidth / originalAspect;
				const centerY = (minY + maxY) / 2;
				minY = centerY - newHeight / 2;
				maxY = centerY + newHeight / 2;
			}
			break;
	}

	if (anchorCenter) {
		const cx = (original.minX + original.maxX) / 2;
		const cy = (original.minY + original.maxY) / 2;

		// Mirror the edge deltas around the original center
		const dMinX = minX - original.minX;
		const dMaxX = maxX - original.maxX;
		const dMinY = minY - original.minY;
		const dMaxY = maxY - original.maxY;

		minX = original.minX + dMinX - dMaxX;
		maxX = original.maxX + dMaxX - dMinX;
		minY = original.minY + dMinY - dMaxY;
		maxY = original.maxY + dMaxY - dMinY;

		// Re-center to keep the original center
		const newCx = (minX + maxX) / 2;
		const newCy = (minY + maxY) / 2;
		const offsetX = cx - newCx;
		const offsetY = cy - newCy;
		minX += offsetX;
		maxX += offsetX;
		minY += offsetY;
		maxY += offsetY;

		// Enforce minimum size
		if (maxX - minX < minSize) {
			minX = cx - minSize / 2;
			maxX = cx + minSize / 2;
		}
		if (maxY - minY < minSize) {
			minY = cy - minSize / 2;
			maxY = cy + minSize / 2;
		}
	}

	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	};
}

/** Screen-pixel offset from the "n" handle to the rotation handle center */
const ROTATION_HANDLE_OFFSET_PX = 24;

export function createRotationHandle(
	bounds: BoundingBox,
	zoom: number,
): { x: number; y: number } {
	const midX = (bounds.minX + bounds.maxX) / 2;
	return { x: midX, y: bounds.maxY + ROTATION_HANDLE_OFFSET_PX / zoom };
}

export function hitTestRotationHandle(
	worldX: number,
	worldY: number,
	bounds: BoundingBox,
	viewport: Viewport,
): boolean {
	const handle = createRotationHandle(bounds, viewport.zoom);
	const hitRadius = 8 / viewport.zoom;
	const dx = worldX - handle.x;
	const dy = worldY - handle.y;
	return dx * dx + dy * dy <= hitRadius * hitRadius;
}

export function getResizeCursor(handle: ResizeHandle): string {
	switch (handle) {
		case "nw":
		case "se":
			return "nwse-resize";
		case "ne":
		case "sw":
			return "nesw-resize";
		case "n":
		case "s":
			return "ns-resize";
		case "e":
		case "w":
			return "ew-resize";
		default:
			return "default";
	}
}
