import type { BoundingBox } from "../../schema";

export type AlignMode =
	| "left"
	| "centerH"
	| "right"
	| "top"
	| "centerV"
	| "bottom";

export type DistributeAxis = "horizontal" | "vertical";

export type AlignItem = { id: string; bounds: BoundingBox };

export type AlignDelta = { dx: number; dy: number };

/**
 * World-space translation each item needs so its bounds align to `reference`
 * according to `mode`. The item that already sits on the reference edge/center
 * (e.g. the key object) gets a zero delta. World Y is up-positive, so `top`
 * targets maxY and `bottom` targets minY.
 */
export function computeAlignDeltas(
	items: readonly AlignItem[],
	mode: AlignMode,
	reference: BoundingBox,
): Map<string, AlignDelta> {
	const deltas = new Map<string, AlignDelta>();
	for (const { id, bounds } of items) {
		let dx = 0;
		let dy = 0;
		switch (mode) {
			case "left":
				dx = reference.minX - bounds.minX;
				break;
			case "right":
				dx = reference.maxX - bounds.maxX;
				break;
			case "centerH":
				dx = centerX(reference) - centerX(bounds);
				break;
			case "top":
				dy = reference.maxY - bounds.maxY;
				break;
			case "bottom":
				dy = reference.minY - bounds.minY;
				break;
			case "centerV":
				dy = centerY(reference) - centerY(bounds);
				break;
		}
		deltas.set(id, { dx, dy });
	}
	return deltas;
}

/**
 * World-space translation each item needs so the items' centers are evenly
 * spaced along `axis`. The two extreme items stay fixed; only the in-between
 * items move. Returns empty (all no-op) for fewer than 3 items.
 */
export function computeDistributeDeltas(
	items: readonly AlignItem[],
	axis: DistributeAxis,
): Map<string, AlignDelta> {
	const deltas = new Map<string, AlignDelta>();
	if (items.length < 3) return deltas;

	const center = axis === "horizontal" ? centerX : centerY;
	const sorted = [...items].sort((a, b) => center(a.bounds) - center(b.bounds));
	const first = center(sorted[0].bounds);
	const last = center(sorted[sorted.length - 1].bounds);
	const step = (last - first) / (sorted.length - 1);

	for (let i = 0; i < sorted.length; i++) {
		const target = first + step * i;
		const offset = target - center(sorted[i].bounds);
		deltas.set(
			sorted[i].id,
			axis === "horizontal" ? { dx: offset, dy: 0 } : { dx: 0, dy: offset },
		);
	}
	return deltas;
}

/** Combined AABB of all item bounds; null for an empty list. */
export function unionBounds(items: readonly AlignItem[]): BoundingBox | null {
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

function centerX(b: BoundingBox): number {
	return (b.minX + b.maxX) / 2;
}

function centerY(b: BoundingBox): number {
	return (b.minY + b.maxY) / 2;
}
