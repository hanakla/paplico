import type { BoundingBox } from "../../../schema";
import { applyTransformToPoint } from "../../../utils/geometry/space/coordinates";
import type { SelectionFrame } from "../../../utils/geometry/space/selectionFrame";

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
