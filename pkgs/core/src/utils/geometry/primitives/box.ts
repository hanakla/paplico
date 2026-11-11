import type { BoundingBox } from "../../../schema";
import type { Brand } from "../../lang";

/** Combined AABB of all item bounds; null for an empty list. */
export function unionBounds(
	items: readonly { bounds: BoundingBox }[],
): BoundingBox | null {
	let acc: BoundingBox | null = null;
	for (const { bounds } of items) {
		if (!acc) {
			acc = { ...bounds };
			continue;
		}
		acc.minX = Math.min(acc.minX, bounds.minX);
		acc.minY = Math.min(acc.minY, bounds.minY);
		acc.maxX = Math.max(acc.maxX, bounds.maxX);
		acc.maxY = Math.max(acc.maxY, bounds.maxY);
	}
	if (acc) {
		acc.width = acc.maxX - acc.minX;
		acc.height = acc.maxY - acc.minY;
	}
	return acc;
}

declare const LocalBBoxBrand: unique symbol;
/** Bounding box in local (untransformed) space — element's own SRT not applied. */
export type LocalBBox = BoundingBox & Brand<typeof LocalBBoxBrand>;

declare const WorldBBoxBrand: unique symbol;
/** Bounding box in world space — element's own SRT transform applied. */
export type WorldBBox = BoundingBox & Brand<typeof WorldBBoxBrand>;
export function brandLocalBBox(bounds: BoundingBox): LocalBBox {
	return bounds as LocalBBox;
}

/** Brand boundary: mark a BoundingBox as world-space. Only call when the bounds are known to be in world space. */
export function brandWorldBBox(bounds: BoundingBox): WorldBBox {
	return bounds as WorldBBox;
}

/**
 * Expand a bounding box by a margin.
 * Preserves branded types (WorldBBox in → WorldBBox out).
 */
export function expandBounds(bounds: WorldBBox, margin: number): WorldBBox;
export function expandBounds(bounds: BoundingBox, margin: number): BoundingBox;
export function expandBounds(bounds: BoundingBox, margin: number): BoundingBox {
	return {
		minX: bounds.minX - margin,
		minY: bounds.minY - margin,
		maxX: bounds.maxX + margin,
		maxY: bounds.maxY + margin,
		width: bounds.width + margin * 2,
		height: bounds.height + margin * 2,
	};
}

/**
 * Translate a bounding box by a delta offset.
 * Preserves branded types (WorldBBox in -> WorldBBox out).
 */
export function translateBounds(
	bounds: WorldBBox,
	deltaX: number,
	deltaY: number,
): WorldBBox;
export function translateBounds(
	bounds: BoundingBox,
	deltaX: number,
	deltaY: number,
): BoundingBox;
export function translateBounds(
	bounds: BoundingBox,
	deltaX: number,
	deltaY: number,
): BoundingBox {
	return {
		minX: bounds.minX + deltaX,
		minY: bounds.minY + deltaY,
		maxX: bounds.maxX + deltaX,
		maxY: bounds.maxY + deltaY,
		width: bounds.width,
		height: bounds.height,
	};
}

/**
 * Calculate the intersection area of two bounding boxes.
 * Returns 0 if boxes do not overlap.
 */
export function boundsIntersectionArea(a: BoundingBox, b: BoundingBox): number {
	const overlapMinX = Math.max(a.minX, b.minX);
	const overlapMaxX = Math.min(a.maxX, b.maxX);
	const overlapMinY = Math.max(a.minY, b.minY);
	const overlapMaxY = Math.min(a.maxY, b.maxY);
	if (overlapMinX >= overlapMaxX || overlapMinY >= overlapMaxY) return 0;
	return (overlapMaxX - overlapMinX) * (overlapMaxY - overlapMinY);
}

/**
 * Calculate the area of a bounding box.
 */
export function boundsArea(b: BoundingBox): number {
	return b.width * b.height;
}

/**
 * Calculate the intersection bounding box of two bounding boxes.
 * Returns null if no intersection.
 */
export function boundsIntersectionBox(
	a: BoundingBox,
	b: BoundingBox,
): BoundingBox | null {
	const minX = Math.max(a.minX, b.minX);
	const maxX = Math.min(a.maxX, b.maxX);
	const minY = Math.max(a.minY, b.minY);
	const maxY = Math.min(a.maxY, b.maxY);
	if (minX >= maxX || minY >= maxY) return null;
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Expand `bounds` outward onto the world grid of `rasterScale` texels per
 * world px, so bakes and captures of one region land on the same texels.
 * An edge already on the grid stays put despite floating error.
 */
export function snapBoundsToRasterGrid(
	bounds: BoundingBox,
	rasterScale: number,
): BoundingBox {
	const eps = 1e-6;
	const minX = Math.floor(bounds.minX * rasterScale + eps) / rasterScale;
	const maxX = Math.ceil(bounds.maxX * rasterScale - eps) / rasterScale;
	const minY = Math.floor(bounds.minY * rasterScale + eps) / rasterScale;
	const maxY = Math.ceil(bounds.maxY * rasterScale - eps) / rasterScale;
	return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
