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

export type ResizedBounds = BoundingBox & {
	/** True when the dragged edge crossed its anchor, mirroring that axis. */
	flipX: boolean;
	/** True when the dragged edge crossed its anchor, mirroring that axis. */
	flipY: boolean;
};

type ResizeBoundsOptions = {
	/** Keep the original aspect ratio. */
	constrainAspect?: boolean;
	/** Grow from the original center instead of the opposite edge. */
	anchorCenter?: boolean;
	/** Let the dragged edge cross its anchor, mirroring that axis. */
	allowFlip?: boolean;
	/** Minimum width/height. Ignored once allowFlip lets the edge cross. */
	minSize?: number;
};

/**
 * Calculate resized bounds when dragging a resize handle.
 *
 * Each axis grows from an anchor toward the dragged edge, so the size is
 * tracked signed: it turns negative once the edge crosses the anchor, which
 * the returned flip flags report. The bounds themselves stay normalized.
 *
 * @param original   Original bounding box before drag started
 * @param handle     Which handle is being dragged
 * @param worldX     Current pointer X in world coordinates
 * @param worldY     Current pointer Y in world coordinates
 * @param dragStartX World X where the drag began
 * @param dragStartY World Y where the drag began
 */
export function calculateResizedBounds(
	original: BoundingBox,
	handle: ResizeHandle,
	worldX: number,
	worldY: number,
	dragStartX: number,
	dragStartY: number,
	{
		constrainAspect = false,
		anchorCenter = false,
		allowFlip = false,
		minSize = 10,
	}: ResizeBoundsOptions = {},
): ResizedBounds {
	const targets = getResizeSnapTargets(handle);
	const centerX = (original.minX + original.maxX) / 2;
	const centerY = (original.minY + original.maxY) / 2;

	// An axis the handle does not drag keeps its size around the original
	// center, which is also where anchorCenter pins every axis.
	const centeredX = anchorCenter || targets.x === "none";
	const centeredY = anchorCenter || targets.y === "none";
	const dirX = targets.x === "min" ? -1 : 1;
	const dirY = targets.y === "min" ? -1 : 1;
	const anchorX = targets.x === "min" ? original.maxX : original.minX;
	const anchorY = targets.y === "min" ? original.maxY : original.minY;

	// Pinning the anchor at the center doubles the pointer distance, since the
	// opposite edge moves the same amount the other way.
	let sizeX = axisSize(
		targets.x,
		worldX,
		centeredX ? centerX : anchorX,
		dirX,
		centeredX,
		original.width,
	);
	let sizeY = axisSize(
		targets.y,
		worldY,
		centeredY ? centerY : anchorY,
		dirY,
		centeredY,
		original.height,
	);

	if (targets.x !== "none") sizeX = clampSize(sizeX, minSize, allowFlip);
	if (targets.y !== "none") sizeY = clampSize(sizeY, minSize, allowFlip);

	// The dominant pointer axis drives the ratio; the other one only keeps the
	// direction it was dragged in. A degenerate original extent, such as a
	// straight horizontal path, holds no ratio to keep.
	const aspect = original.width / original.height;
	if (constrainAspect && Number.isFinite(aspect) && aspect > 0) {
		const drivenByX =
			targets.y === "none" ||
			(targets.x !== "none" &&
				Math.abs(worldX - dragStartX) > Math.abs(worldY - dragStartY));
		if (drivenByX) sizeY = signOf(sizeY) * (Math.abs(sizeX) / aspect);
		else sizeX = signOf(sizeX) * (Math.abs(sizeY) * aspect);
	}

	const [minX, maxX] = axisRange(centerX, anchorX, dirX, sizeX, centeredX);
	const [minY, maxY] = axisRange(centerY, anchorY, dirY, sizeY, centeredY);

	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
		flipX: sizeX < 0,
		flipY: sizeY < 0,
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

type ResizeSnapAxisTarget = "none" | "min" | "max";

export type ResizeSnapTargets = {
	x: ResizeSnapAxisTarget;
	y: ResizeSnapAxisTarget;
};

/**
 * Which world-space bounds edges a handle drags (and thus may snap).
 * World Y is up, so the "n" (screen-top) handles drag maxY. A mirrored axis
 * moves its dragged edge to the other side of the bounds.
 */
export function getResizeSnapTargets(
	handle: ResizeHandle,
	flipX = false,
	flipY = false,
): ResizeSnapTargets {
	const { x, y } = resizeSnapTargetsOf(handle);
	return { x: flipX ? oppositeEdge(x) : x, y: flipY ? oppositeEdge(y) : y };
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

/** Signed size of one axis, measured from its anchor toward the pointer. */
function axisSize(
	target: ResizeSnapAxisTarget,
	world: number,
	anchor: number,
	dir: number,
	centered: boolean,
	originalSize: number,
): number {
	if (target === "none") return originalSize;
	return (world - anchor) * dir * (centered ? 2 : 1);
}

/** Hold a size at the minimum, unless the edge is allowed to cross. */
function clampSize(size: number, minSize: number, allowFlip: boolean): number {
	return allowFlip ? size : Math.max(size, minSize);
}

function signOf(value: number): number {
	return value < 0 ? -1 : 1;
}

/** Normalized [min, max] edge pair for one axis. */
function axisRange(
	center: number,
	anchor: number,
	dir: number,
	size: number,
	centered: boolean,
): [number, number] {
	const [a, b] = centered
		? [center - size / 2, center + size / 2]
		: [anchor, anchor + dir * size];
	return [Math.min(a, b), Math.max(a, b)];
}

function oppositeEdge(target: ResizeSnapAxisTarget): ResizeSnapAxisTarget {
	if (target === "min") return "max";
	if (target === "max") return "min";
	return "none";
}

function resizeSnapTargetsOf(handle: ResizeHandle): ResizeSnapTargets {
	switch (handle) {
		case "nw":
			return { x: "min", y: "max" };
		case "n":
			return { x: "none", y: "max" };
		case "ne":
			return { x: "max", y: "max" };
		case "e":
			return { x: "max", y: "none" };
		case "se":
			return { x: "max", y: "min" };
		case "s":
			return { x: "none", y: "min" };
		case "sw":
			return { x: "min", y: "min" };
		case "w":
			return { x: "min", y: "none" };
	}
}
