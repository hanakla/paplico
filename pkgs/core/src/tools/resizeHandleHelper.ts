/**
 * Shared resize handle utilities for ArtboardTool and SelectTool.
 *
 * Both tools use the same 8-direction resize handle logic:
 * - Handle positions (nw/n/ne/e/se/s/sw/w)
 * - Hit testing against those handles
 * - Resized bounds calculation with optional aspect-ratio constraint
 * - Cursor mapping per handle direction
 */

import type { SelectionUIData } from "../renderer/ui/types";
import {
	type BoundingBox,
	type ElementTransform,
	IDENTITY_TRANSFORM,
	type Point,
	type Viewport,
} from "../schema";
import {
	applyTransformToPoint,
	transformLinearMatrix,
} from "../utils/geometry/geometry";
import {
	frameCorners,
	frameWorldBounds,
	type SelectionFrame,
} from "../utils/geometry/selectionFrame";

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

/** The 8 handles of a frame's box, placed in the world. */
export function createFrameHandles(frame: SelectionFrame): HandlePosition[] {
	return createResizeHandles(frame.bounds).map((handle) => ({
		...handle,
		...applyTransformToPoint(handle.x, handle.y, frame.matrix),
	}));
}

/**
 * The selection overlay's data for `frame`. Every selection refresh builds
 * its data here, so the frame, its handles and its outlines never depend on
 * which code path refreshed the overlay.
 */
export function createSelectionUIData(
	frame: SelectionFrame,
	zoom: number,
	includeHandles: boolean,
	extras: Pick<
		SelectionUIData,
		"pathSegments" | "keyObjectSegments" | "boundsDashed"
	>,
): SelectionUIData {
	return {
		bounds: frameWorldBounds(frame),
		quad: frameCorners(frame),
		handles: includeHandles ? createFrameHandles(frame) : [],
		rotationHandle: includeHandles
			? createRotationHandle(frame, zoom)
			: undefined,
		...extras,
	};
}

/**
 * Hit-test a world-space point against resize handles. The handle squares
 * are screen-parallel whatever the frame's tilt. Returns the handle position
 * if hit, null otherwise.
 *
 * @param worldX   Point X in world coordinates
 * @param worldY   Point Y in world coordinates
 * @param handles  The handles to test, in the world
 * @param viewport Current viewport (used to scale handle hit area)
 * @param handleScreenPx  Handle size in screen pixels (default 12)
 */
export function hitTestResizeHandle(
	worldX: number,
	worldY: number,
	handles: readonly HandlePosition[],
	viewport: Viewport,
	handleScreenPx = 12,
): ResizeHandle | null {
	const halfHandle = handleScreenPx / viewport.zoom / 2;

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

/** The rotation handle: a step above the "n" handle along the frame's up axis. */
export function createRotationHandle(
	frame: SelectionFrame,
	zoom: number,
): Point {
	const { minX, maxX, maxY } = frame.bounds;
	const n = applyTransformToPoint((minX + maxX) / 2, maxY, frame.matrix);
	const up = frameUpAxis(frame);
	const offset = ROTATION_HANDLE_OFFSET_PX / zoom;
	return { x: n.x + up.x * offset, y: n.y + up.y * offset };
}

export function hitTestRotationHandle(
	worldX: number,
	worldY: number,
	frame: SelectionFrame,
	viewport: Viewport,
): boolean {
	const handle = createRotationHandle(frame, viewport.zoom);
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

/**
 * The cursor for a handle, chosen by the direction the handle's edge moves
 * in on screen: the frame's axis the handle sits on, turned by the view.
 */
export function getResizeCursor(
	handle: ResizeHandle,
	frameMatrix: ElementTransform = IDENTITY_TRANSFORM,
	viewRotation = 0,
): string {
	const nominal = HANDLE_DIRECTIONS[handle];
	const m = transformLinearMatrix(frameMatrix);
	const dx = m.m00 * nominal.x + m.m01 * nominal.y;
	const dy = m.m10 * nominal.x + m.m11 * nominal.y;
	// The view turns the world the other way round on screen.
	const cos = Math.cos(viewRotation);
	const sin = Math.sin(viewRotation);
	const angle =
		((Math.atan2(dy * cos - dx * sin, dx * cos + dy * sin) * 180) / Math.PI +
			360) %
		180;
	return RESIZE_CURSORS[Math.round(angle / 45) % 4];
}

/** Where each handle's edge moves, in the frame's space with y up. */
const HANDLE_DIRECTIONS: Record<ResizeHandle, Point> = {
	e: { x: 1, y: 0 },
	ne: { x: 1, y: 1 },
	n: { x: 0, y: 1 },
	nw: { x: -1, y: 1 },
	w: { x: -1, y: 0 },
	sw: { x: -1, y: -1 },
	s: { x: 0, y: -1 },
	se: { x: 1, y: -1 },
};

/** Cursors by the screen direction's angle from horizontal, in steps of 45°. */
const RESIZE_CURSORS = ["ew-resize", "nesw-resize", "ns-resize", "nwse-resize"];

/** Unit vector of the frame's +y axis in the world; (0, 1) for a flattened frame. */
function frameUpAxis(frame: SelectionFrame): Point {
	const m = transformLinearMatrix(frame.matrix);
	const length = Math.hypot(m.m01, m.m11);
	return length > 0 ? { x: m.m01 / length, y: m.m11 / length } : { x: 0, y: 1 };
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
