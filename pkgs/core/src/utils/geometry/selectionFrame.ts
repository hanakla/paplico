import {
	type BoundingBox,
	type ElementTransform,
	IDENTITY_TRANSFORM,
	type Point,
} from "../../schema";
import { unionBounds } from "./align";
import {
	applyTransformToPoint,
	composeTransforms,
	transformBounds,
	transformLinearMatrix,
} from "./geometry";

/**
 * The frame a selection is handled through: a box in the frame's own space
 * and the matrix that places that space in the world. The handles sit on the
 * box, and a resize maps the box onto a new one in the same space.
 */
export interface SelectionFrame {
	bounds: BoundingBox;
	matrix: ElementTransform;
	/** The element whose own space the frame is, or null for a world-axis frame. */
	elementId: string | null;
}

/**
 * The frame a selection is handled through. A single element with rotation
 * or skew is handled in its own space, so its frame tilts with it; any other
 * selection gets a world-axis frame around its elements' world bounds.
 */
export function resolveSelectionFrame(
	elementIds: readonly string[],
	frameOf: (id: string) => SelectionFrame | null,
	worldBoundsOf: (id: string) => BoundingBox | null,
): SelectionFrame | null {
	if (elementIds.length === 1) {
		const frame = frameOf(elementIds[0]);
		if (frame && !isAxisAligned(frame.matrix)) return frame;
	}
	return worldSelectionFrame(elementIds, worldBoundsOf);
}

/** A world-axis frame around the elements' world bounds, whatever their tilt. */
export function worldSelectionFrame(
	elementIds: readonly string[],
	worldBoundsOf: (id: string) => BoundingBox | null,
): SelectionFrame | null {
	const union = unionBounds(
		elementIds.flatMap((id) => {
			const bounds = worldBoundsOf(id);
			return bounds ? [{ id, bounds }] : [];
		}),
	);
	return union ? worldFrame(union) : null;
}

/** A world-axis-aligned frame around `bounds`. */
export function worldFrame(bounds: BoundingBox): SelectionFrame {
	return { bounds, matrix: IDENTITY_TRANSFORM, elementId: null };
}

/** The frame's corners in the world: nw, ne, se, sw. */
export function frameCorners(
	frame: SelectionFrame,
): [Point, Point, Point, Point] {
	const { minX, minY, maxX, maxY } = frame.bounds;
	return [
		applyTransformToPoint(minX, maxY, frame.matrix),
		applyTransformToPoint(maxX, maxY, frame.matrix),
		applyTransformToPoint(maxX, minY, frame.matrix),
		applyTransformToPoint(minX, minY, frame.matrix),
	];
}

/** The centre of the frame's box, in the world. */
export function frameCenter(frame: SelectionFrame): Point {
	const { minX, minY, maxX, maxY } = frame.bounds;
	return applyTransformToPoint(
		(minX + maxX) / 2,
		(minY + maxY) / 2,
		frame.matrix,
	);
}

/** The world-axis-aligned box around the frame. */
export function frameWorldBounds(frame: SelectionFrame): BoundingBox {
	return transformBounds(frame.bounds, frame.matrix);
}

/** The frame carried through `affine`, a world-space map applied on top of it. */
export function transformFrame(
	frame: SelectionFrame,
	affine: ElementTransform,
): SelectionFrame {
	return { ...frame, matrix: composeTransforms(affine, frame.matrix) };
}

/** True when the transform keeps the axes parallel to the world's. */
function isAxisAligned(t: ElementTransform): boolean {
	const m = transformLinearMatrix(t);
	return Math.abs(m.m01) < 1e-9 && Math.abs(m.m10) < 1e-9;
}
